import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { isAiConfigured } from "../../ai/settings"
import {
  createAccount,
  createMessage,
  createThread,
} from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { getMessage } from "../../db/messages"
import { createTaskFromSuggestion } from "../create"
import type { RecurrenceRule } from "../recurrence"
import {
  completeTask,
  createTask,
  getTask,
  listOpenTasks,
  updateTask,
  type Task,
} from "../service"

/**
 * AI-proposed-task parity tests (task 5.8, tasks spec "AI-proposed
 * tasks"): an accepted suggestion — created through the SAME service
 * path as manual creation (`createTask` via the
 * `createTaskFromSuggestion` seam) — must produce a behaviorally
 * identical task, with the source-message/thread links resolving to real
 * rows, recurrence + completion expanding identically, and `origin` as
 * the only distinguishing field. Also proves the spec's no-AI-dependency
 * leg: manual and email-conversion creation succeed with the AI settings
 * entirely absent.
 */

const DAY = 86400

/** Tuesday, June 9 2026, 09:00 local — DST-free +7d window (EU and US). */
const JUN_9_2026_0900 = Math.floor(
  new Date(2026, 5, 9, 9, 0, 0, 0).getTime() / 1000
)

const WEEKLY: RecurrenceRule = { kind: "weekly", weekdays: [2] } // Tuesdays

/** The behavior-bearing projection of a task: everything but ids,
 * timestamps-of-arrival, origin and provenance. */
function behaviorOf(task: Task) {
  return {
    title: task.title,
    notes: task.notes,
    dueAt: task.dueAt,
    recurrence: task.recurrence,
    completedAt: task.completedAt,
    completedHistory: task.completedHistory,
    seriesId: task.seriesId,
    isOverdue: task.isOverdue,
  }
}

describe("AI-proposed vs manual task parity (task 5.8)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  async function seedSource(): Promise<{
    accountId: string
    threadId: string
    messageId: string
  }> {
    const accountId = await createAccount(executor)
    const threadId = await createThread(executor, accountId, {
      subject: "Contract renewal",
    })
    const messageId = await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_000_000,
      subject: "Re: Contract renewal",
      fromName: "Alice",
      fromAddress: "alice@example.com",
    })
    return { accountId, threadId, messageId }
  }

  it("an accepted suggestion yields the same row shape as manual createTask", async () => {
    const input = {
      title: "Send the contract",
      notes: "To legal first",
      dueAt: JUN_9_2026_0900,
    }
    const aiResult = await createTaskFromSuggestion(executor, {
      ...input,
      sourceMessageId: "msg-1",
      sourceThreadId: "thread-1",
      origin: "ai",
    })
    if (!aiResult.ok) throw new Error("expected the seam to succeed")
    const manual = await createTask(executor, input)

    const ai = await getTask(executor, aiResult.taskId)
    expect(ai).not.toBeNull()
    if (ai === null) throw new Error("unreachable")

    // Identical column population: every behavior-bearing field matches
    // exactly; the row shapes (key sets) are the same.
    expect(behaviorOf(ai)).toEqual(behaviorOf(manual))
    expect(Object.keys(ai).sort()).toEqual(Object.keys(manual).sort())

    // `origin` is the ONLY distinguishing field (plus provenance, which
    // manual creation leaves null).
    expect(ai.origin).toBe("ai")
    expect(manual.origin).toBe("manual")
    expect(manual.sourceMessageId).toBeNull()
    expect(manual.sourceThreadId).toBeNull()

    // Both list identically through the read API, origin attached.
    // (Order-independent: identical due dates fall to the uuid tiebreak.)
    const open = await listOpenTasks(executor)
    expect(open).toHaveLength(2)
    const originById = new Map(open.map((task) => [task.id, task.origin]))
    expect(originById.get(ai.id)).toBe("ai")
    expect(originById.get(manual.id)).toBe("manual")
  })

  it("the AI task's source links resolve to the seeded thread and message", async () => {
    const { accountId, threadId, messageId } = await seedSource()
    const result = await createTaskFromSuggestion(executor, {
      title: "Book the renewal call",
      sourceMessageId: messageId,
      sourceThreadId: threadId,
      origin: "ai",
    })
    if (!result.ok) throw new Error("expected the seam to succeed")
    const task = await getTask(executor, result.taskId)
    if (task === null) throw new Error("unreachable")

    // source_message_id → the message exists (the reading-pane jump).
    const message = await getMessage(executor, task.sourceMessageId ?? "")
    expect(message?.id).toBe(messageId)
    expect(message?.thread_id).toBe(threadId)
    // source_thread_id → the thread exists (the deep-link).
    const threads = await executor.select<{ id: string }>(
      "SELECT id FROM threads WHERE id = $1",
      [task.sourceThreadId ?? ""]
    )
    expect(threads.map((row) => row.id)).toEqual([threadId])
    // Best-effort account provenance resolved from the thread.
    expect(task.sourceAccountId).toBe(accountId)
  })

  it("completing an ai-origin recurring task expands exactly like a manual one", async () => {
    const { threadId, messageId } = await seedSource()
    // The AI task gets its rule the same way a manual task edited later
    // would — the seam's frozen contract carries no recurrence — via the
    // shared updateTask edit path.
    const aiResult = await createTaskFromSuggestion(executor, {
      title: "Chase the renewal",
      dueAt: JUN_9_2026_0900,
      sourceMessageId: messageId,
      sourceThreadId: threadId,
      origin: "ai",
    })
    if (!aiResult.ok) throw new Error("expected the seam to succeed")
    await updateTask(executor, aiResult.taskId, { recurrence: WEEKLY })
    const manual = await createTask(executor, {
      title: "Chase the renewal",
      dueAt: JUN_9_2026_0900,
      recurrence: WEEKLY,
    })

    const aiNextId = (await completeTask(executor, aiResult.taskId)).nextTaskId
    const manualNextId = (await completeTask(executor, manual.id)).nextTaskId
    expect(aiNextId).not.toBeNull()
    expect(manualNextId).not.toBeNull()

    const aiNext = await getTask(executor, aiNextId as string)
    const manualNext = await getTask(executor, manualNextId as string)
    if (aiNext === null || manualNext === null) throw new Error("unreachable")

    // Identical expansion: one week after the DUE date, same open shape.
    expect(aiNext.dueAt).toBe(manualNext.dueAt)
    expect(aiNext.dueAt).toBeGreaterThan(JUN_9_2026_0900 + 6 * DAY)
    expect(aiNext.completedAt).toBeNull()
    // Provenance is copied into the next occurrence, so an expanded AI
    // series stays linkable to its source message.
    expect(aiNext.origin).toBe("ai")
    expect(aiNext.sourceMessageId).toBe(messageId)
    expect(aiNext.sourceThreadId).toBe(threadId)
    expect(manualNext.origin).toBe("manual")

    // The completed instances keep the series trail; both series
    // materialize a series id linking instance to next occurrence.
    const aiDone = await getTask(executor, aiResult.taskId)
    expect(aiDone?.completedAt).not.toBeNull()
    expect(aiDone?.completedHistory).toHaveLength(1)
    expect(aiDone?.completedHistory[0]?.dueAt).toBe(JUN_9_2026_0900)
    expect(aiDone?.seriesId).not.toBeNull()
    expect(aiNext.seriesId).toBe(aiDone?.seriesId)
    expect(manualNext.seriesId).toBe(manual.seriesId)
  })

  it("origin distinguishes all three creation paths", async () => {
    const { accountId, threadId, messageId } = await seedSource()
    const aiResult = await createTaskFromSuggestion(executor, {
      title: "AI task",
      sourceMessageId: messageId,
      sourceThreadId: threadId,
      origin: "ai",
    })
    if (!aiResult.ok) throw new Error("expected the seam to succeed")
    const email = await createTask(executor, {
      title: "Email task",
      origin: "email",
      sourceAccountId: accountId,
      sourceMessageId: messageId,
      sourceThreadId: threadId,
    })
    expect(email.origin).toBe("email")
    await createTask(executor, { title: "Manual task" })

    const open = await listOpenTasks(executor)
    expect(Object.fromEntries(open.map((task) => [task.origin, task.title])))
      .toEqual({
        ai: "AI task",
        email: "Email task",
        manual: "Manual task",
      })
  })

  it("manual and email creation work with AI entirely absent (no-AI dependency)", async () => {
    // Fresh executor: no ai_providers/ai_settings rows have ever been
    // written — the "AI assistance is disabled" state of the spec. This
    // runtime proof is sufficient (with a static-graph comment): the
    // tasks module imports only db + recurrence modules, never
    // services/ai — grep of src/services/tasks shows no ai import — so
    // no AI code can even load on this path.
    expect(await isAiConfigured(executor)).toBe(false)

    const { accountId, threadId, messageId } = await seedSource()
    const manual = await createTask(executor, {
      title: "Plain manual task",
      dueAt: JUN_9_2026_0900,
    })
    expect(manual.origin).toBe("manual")
    const email = await createTask(executor, {
      title: "Converted from email",
      origin: "email",
      sourceAccountId: accountId,
      sourceMessageId: messageId,
      sourceThreadId: threadId,
    })
    expect(email.origin).toBe("email")
    expect(await listOpenTasks(executor)).toHaveLength(2)
    // The AI seam itself only ADDS an ai-origin row through createTask —
    // it is not on the manual/email path at all.
    expect(await isAiConfigured(executor)).toBe(false)
  })
})
