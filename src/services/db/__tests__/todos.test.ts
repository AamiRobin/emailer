import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount, createThread } from "./fixtures"
import { createTestExecutor, type TestExecutor } from "./test-executor"
import { getThread } from "../threads"
import {
  addTodo,
  completeTodo,
  isThreadPendingTodo,
  listPendingTodos,
  moveTodo,
  removeTodo,
} from "../todos"

/**
 * Todos CRUD (task 15.2) against the seeded node:sqlite schema —
 * including the cross-account listing (the sidebar section aggregates
 * pending todos from EVERY account) and the UNIQUE(thread_id) re-add
 * semantics (re-adding moves the row to the bottom instead of erroring).
 */

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
})

afterEach(() => {
  executor.close()
})

describe("addTodo / listPendingTodos", () => {
  it("adds a thread with the next position and lists it joined with its thread", async () => {
    const accountId = await createAccount(executor)
    const threadId = await createThread(executor, accountId, {
      subject: "Reply to Ada",
    })
    // The fixture's createThread seeds no snippet — set it directly so the
    // JOIN's thread fields are all under test.
    await executor.execute("UPDATE threads SET snippet = $1 WHERE id = $2", [
      "about the contract",
      threadId,
    ])

    const id = await addTodo(executor, accountId, threadId)

    expect(id).toBeTruthy()
    const rows = await listPendingTodos(executor)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id,
      account_id: accountId,
      thread_id: threadId,
      position: 1,
      subject: "Reply to Ada",
      snippet: "about the contract",
    })
  })

  it("appends successive adds at the end across accounts (one list)", async () => {
    const accountA = await createAccount(executor)
    const accountB = await createAccount(executor)
    const threadA = await createThread(executor, accountA, { subject: "A" })
    const threadB = await createThread(executor, accountB, { subject: "B" })
    const threadB2 = await createThread(executor, accountB, { subject: "B2" })

    await addTodo(executor, accountA, threadA)
    await addTodo(executor, accountB, threadB)
    await addTodo(executor, accountB, threadB2)

    const rows = await listPendingTodos(executor)
    // One cross-account list, insertion order kept.
    expect(rows.map((row) => row.subject)).toEqual(["A", "B", "B2"])
    expect(rows.map((row) => row.account_id)).toEqual([
      accountA,
      accountB,
      accountB,
    ])
    expect(rows.map((row) => row.position)).toEqual([1, 2, 3])
  })

  it("re-adding a listed thread moves it to the bottom instead of erroring", async () => {
    const accountId = await createAccount(executor)
    const first = await createThread(executor, accountId, { subject: "First" })
    const second = await createThread(executor, accountId, {
      subject: "Second",
    })
    await addTodo(executor, accountId, first)
    await addTodo(executor, accountId, second)

    await addTodo(executor, accountId, first)

    const rows = await listPendingTodos(executor)
    expect(rows.map((row) => row.subject)).toEqual(["Second", "First"])
  })

  it("re-adding a completed thread re-activates it at the bottom", async () => {
    const accountId = await createAccount(executor)
    const threadId = await createThread(executor, accountId, {
      subject: "Back",
    })
    const todoId = await addTodo(executor, accountId, threadId)
    await completeTodo(executor, todoId)
    expect(await listPendingTodos(executor)).toHaveLength(0)

    await addTodo(executor, accountId, threadId)

    const rows = await listPendingTodos(executor)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ thread_id: threadId, position: 2 })
  })

  it("isThreadPendingTodo tracks the pending state", async () => {
    const accountId = await createAccount(executor)
    const threadId = await createThread(executor, accountId)
    expect(await isThreadPendingTodo(executor, threadId)).toBe(false)

    const todoId = await addTodo(executor, accountId, threadId)
    expect(await isThreadPendingTodo(executor, threadId)).toBe(true)

    await completeTodo(executor, todoId)
    expect(await isThreadPendingTodo(executor, threadId)).toBe(false)
  })
})

describe("removeTodo", () => {
  it("deletes the row and leaves the thread itself untouched", async () => {
    const accountId = await createAccount(executor)
    const threadId = await createThread(executor, accountId, {
      subject: "Gone",
    })
    const todoId = await addTodo(executor, accountId, threadId)
    const keeper = await createThread(executor, accountId, { subject: "Stays" })
    await addTodo(executor, accountId, keeper)

    await removeTodo(executor, todoId)

    const rows = await listPendingTodos(executor)
    expect(rows.map((row) => row.subject)).toEqual(["Stays"])
    expect(await getThread(executor, threadId)).not.toBeNull()
    // Removing an unknown id is a no-op, not an error.
    await removeTodo(executor, "missing-id")
    expect(await listPendingTodos(executor)).toHaveLength(1)
  })
})

describe("completeTodo", () => {
  it("stamps completed_at and hides the row from the pending list (row kept)", async () => {
    const accountId = await createAccount(executor)
    const threadId = await createThread(executor, accountId)
    const todoId = await addTodo(executor, accountId, threadId)

    await completeTodo(executor, todoId)

    const rows = await executor.select<{ completed_at: number | null }>(
      "SELECT completed_at FROM todos WHERE id = $1",
      [todoId]
    )
    expect(rows[0]?.completed_at).toBeGreaterThan(0)
    expect(await listPendingTodos(executor)).toHaveLength(0)
  })

  it("with alsoMarkDone it stamps the thread's done_at too; without, it does not", async () => {
    const accountId = await createAccount(executor)
    const plain = await createThread(executor, accountId, { subject: "Plain" })
    const done = await createThread(executor, accountId, { subject: "Done" })
    const plainTodo = await addTodo(executor, accountId, plain)
    const doneTodo = await addTodo(executor, accountId, done)

    await completeTodo(executor, plainTodo)
    await completeTodo(executor, doneTodo, { alsoMarkDone: true })

    expect((await getThread(executor, plain))?.done_at).toBeNull()
    expect((await getThread(executor, done))?.done_at).toBeGreaterThan(0)
  })

  it("completing an unknown id is a no-op", async () => {
    await expect(completeTodo(executor, "missing-id")).resolves.toBeUndefined()
  })
})

describe("moveTodo", () => {
  it("swaps with the neighbor within the pending list", async () => {
    const accountId = await createAccount(executor)
    const todoIds: string[] = []
    for (const subject of ["A", "B", "C"]) {
      const threadId = await createThread(executor, accountId, { subject })
      todoIds.push(await addTodo(executor, accountId, threadId))
    }

    // Move the first down.
    await moveTodo(executor, todoIds[0], 1)
    expect(
      (await listPendingTodos(executor)).map((row) => row.subject)
    ).toEqual(["B", "A", "C"])

    // Move the last up.
    await moveTodo(executor, todoIds[2], -1)
    expect(
      (await listPendingTodos(executor)).map((row) => row.subject)
    ).toEqual(["B", "C", "A"])
  })

  it("moving at the ends of the list is a no-op", async () => {
    const accountId = await createAccount(executor)
    const threadId = await createThread(executor, accountId, { subject: "A" })
    const todoId = await addTodo(executor, accountId, threadId)

    await moveTodo(executor, todoId, -1)
    await moveTodo(executor, "missing-id", 1)
    expect(
      (await listPendingTodos(executor)).map((row) => row.subject)
    ).toEqual(["A"])
  })

  it("completed rows do not participate in swaps", async () => {
    const accountId = await createAccount(executor)
    const first = await createThread(executor, accountId, { subject: "A" })
    const second = await createThread(executor, accountId, { subject: "B" })
    const firstTodo = await addTodo(executor, accountId, first)
    await addTodo(executor, accountId, second)

    // Completing the first leaves a single pending row; moving it must
    // find no neighbor (the completed row is invisible to the ordering).
    await completeTodo(executor, firstTodo)
    await moveTodo(executor, second, -1)
    expect(
      (await listPendingTodos(executor)).map((row) => row.subject)
    ).toEqual(["B"])
  })
})
