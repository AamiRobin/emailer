import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  clearDoneOperations,
  countPendingOperationsByAccount,
  enqueuePendingOperation,
  getPendingOperation,
  incrementOperationAttempts,
  listOperationsByStatus,
  listPendingOperations,
  markOperationDone,
  markOperationFailed,
  markOperationProcessing,
  requeueOperationForRetry,
  requeueStaleProcessingOperations,
  type PendingOperationRow,
} from "../pending-operations"
import { createAccount, uid } from "./fixtures"
import { createTestExecutor, type TestExecutor } from "./test-executor"

describe("pending_operations queries", () => {
  let executor: TestExecutor
  let accountId: string
  let otherAccountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
    otherAccountId = await createAccount(executor, "imap")
  })

  afterEach(() => {
    executor.close()
  })

  async function enqueue(
    opType: string,
    payload: unknown,
    accountIdOverride?: string
  ): Promise<string> {
    return enqueuePendingOperation(executor, {
      accountId: accountIdOverride ?? accountId,
      opType,
      payload,
    })
  }

  it("enqueues as pending with a JSON payload and generated id", async () => {
    const id = await enqueue("archive", { refs: [{ folder: "INBOX", uid: 7 }] })

    const row = await getPendingOperation(executor, id)
    expect(row).not.toBeNull()
    expect(row?.status).toBe("pending")
    expect(row?.attempts).toBe(0)
    expect(row?.op_type).toBe("archive")
    expect(row?.account_id).toBe(accountId)
    expect(JSON.parse(row?.payload_json ?? "")).toEqual({
      refs: [{ folder: "INBOX", uid: 7 }],
    })
    expect(row?.last_error).toBeNull()
    expect(row?.created_at).toBeGreaterThan(0)
  })

  it("lists pending operations in FIFO seq order, filtered and capped", async () => {
    await enqueue("archive", { order: 1 })
    await enqueue("trash", { order: 2 })
    await enqueue("star", { order: 3 })
    // A different account's op must not leak into the first account's queue.
    const foreignId = await enqueue("move", { order: 4 }, otherAccountId)
    // Done rows leave the queue.
    const doneId = await enqueue("unstar", { order: 5 })
    await markOperationDone(executor, doneId)

    const all = await listPendingOperations(executor)
    // No account filter → every account's queue, FIFO across the board.
    expect(all.map((row) => JSON.parse(row.payload_json).order)).toEqual([
      1, 2, 3, 4,
    ])

    const onlyTwo = await listPendingOperations(executor, accountId, 2)
    expect(onlyTwo.map((row) => JSON.parse(row.payload_json).order)).toEqual([
      1, 2,
    ])

    const foreign = await listPendingOperations(executor, otherAccountId)
    expect(foreign.map((row) => row.id)).toEqual([foreignId])
  })

  it("walks the pending → processing → done lifecycle", async () => {
    const id = await enqueue("mark_read", { refs: [] })

    await markOperationProcessing(executor, id)
    expect((await getPendingOperation(executor, id))?.status).toBe("processing")
    // A claimed op is invisible to the pending listing (single consumer).
    expect(await listPendingOperations(executor)).toHaveLength(0)

    await markOperationDone(executor, id)
    const done = await getPendingOperation(executor, id)
    expect(done?.status).toBe("done")
  })

  it("increments attempts across retries", async () => {
    const id = await enqueue("send", { input: {} })
    expect(await incrementOperationAttempts(executor, id)).toBe(1)
    expect(await incrementOperationAttempts(executor, id)).toBe(2)
    expect((await getPendingOperation(executor, id))?.attempts).toBe(2)
  })

  it("requeues with the last error recorded", async () => {
    const id = await enqueue("archive", {})
    await markOperationProcessing(executor, id)
    await requeueOperationForRetry(executor, id, "smtp timeout")

    const row = await getPendingOperation(executor, id)
    expect(row?.status).toBe("pending")
    expect(row?.last_error).toBe("smtp timeout")
  })

  it("marks terminal failures and lists by status", async () => {
    const retried = await enqueue("send", {})
    const dead = await enqueue("send", {})
    await markOperationFailed(executor, retried, "gone")
    await markOperationFailed(executor, dead, "gone")

    const failed = await listOperationsByStatus(executor, "failed")
    expect(failed).toHaveLength(2)
    expect(failed.every((row) => row.status === "failed")).toBe(true)
    expect(failed.every((row) => row.last_error === "gone")).toBe(true)

    const failedForAccount = await listOperationsByStatus(
      executor,
      "failed",
      accountId,
      1
    )
    expect(failedForAccount).toHaveLength(1)
  })

  it("counts operations per account and status for indicators", async () => {
    await enqueue("archive", {})
    await enqueue("trash", {})
    const doneId = await enqueue("star", {})
    await markOperationDone(executor, doneId)
    await enqueue("move", {}, otherAccountId)

    const counts = await countPendingOperationsByAccount(executor)
    // Ordered by account, then status (done < pending alphabetically).
    expect(counts).toEqual([
      { account_id: accountId, status: "done", count: 1 },
      { account_id: accountId, status: "pending", count: 2 },
      { account_id: otherAccountId, status: "pending", count: 1 },
    ])

    const mine = await countPendingOperationsByAccount(executor, otherAccountId)
    expect(mine).toEqual([
      { account_id: otherAccountId, status: "pending", count: 1 },
    ])
  })

  it("clears done rows, optionally only older than a cutoff", async () => {
    const old = await enqueue("archive", {})
    await markOperationDone(executor, old)
    const fresh = await enqueue("trash", {})
    await markOperationDone(executor, fresh)
    await enqueue("star", {}) // pending — must survive

    // Age only the first done row past the cutoff.
    await executor.execute(
      "UPDATE pending_operations SET updated_at = $1 WHERE id = $2",
      [1_000, old]
    )

    expect(await clearDoneOperations(executor, 2_000)).toBe(1)
    const remaining: PendingOperationRow[] = await executor.select(
      "SELECT * FROM pending_operations ORDER BY seq ASC"
    )
    expect(remaining.map((row) => row.id)).toEqual([fresh, expect.any(String)])

    expect(await clearDoneOperations(executor)).toBe(1)
    expect(await listPendingOperations(executor)).toHaveLength(1)
  })

  it("recovers stale processing rows from a crashed session", async () => {
    const stale = await enqueue("archive", {})
    await markOperationProcessing(executor, stale)
    await executor.execute(
      "UPDATE pending_operations SET updated_at = $1 WHERE id = $2",
      [1_000, stale]
    )
    const fresh = await enqueue("trash", {})
    await markOperationProcessing(executor, fresh) // updated_at = now

    // The default window only resets rows older than the window.
    expect(await requeueStaleProcessingOperations(executor, 300)).toBe(1)
    expect((await getPendingOperation(executor, stale))?.status).toBe("pending")
    expect((await getPendingOperation(executor, fresh))?.status).toBe(
      "processing"
    )

    // Startup recovery (maxAge 0) resets everything still 'processing' —
    // safe because queue operations replay idempotently.
    expect(await requeueStaleProcessingOperations(executor, 0)).toBe(1)
    expect((await getPendingOperation(executor, fresh))?.status).toBe("pending")
  })

  it("cascades away when the account is removed", async () => {
    const id = await enqueue("archive", {})
    await executor.execute("DELETE FROM accounts WHERE id = $1", [accountId])
    expect(await getPendingOperation(executor, id)).toBeNull()
  })

  it("rejects rows for unknown accounts (FK)", async () => {
    await expect(
      enqueuePendingOperation(executor, {
        accountId: uid("missing"),
        opType: "archive",
        payload: {},
      })
    ).rejects.toThrow()
  })
})
