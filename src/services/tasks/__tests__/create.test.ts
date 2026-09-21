import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createAccount,
  createThread,
} from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { createTaskFromSuggestion } from "../create"
import { getTask } from "../service"

/**
 * AI task-extraction seam tests (task 5.6; seam landed in 4.8 as a stub).
 * The real seam creates the task through the SAME service path manual
 * tasks use (the ai-assistance spec's parity requirement): origin "ai",
 * both source back-links stored (thread for the deep-link, message for
 * the reading-pane jump), the owning account resolved from the thread as
 * best-effort provenance, and notes/dueAt carried over. Failures throw —
 * the frozen dialog treats a seam throw as a retryable error (see
 * create.ts module doc); the Phase 4 dialog suite mocks this module and
 * is unaffected by the body swap.
 */

describe("createTaskFromSuggestion (real seam)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("creates an ai-origin task through the manual creation path", async () => {
    const accountId = await createAccount(executor)
    const threadId = await createThread(executor, accountId, {
      subject: "Contract renewal",
    })

    const result = await createTaskFromSuggestion(executor, {
      title: "Send the contract",
      notes: "To legal first",
      dueAt: 1_800_000_000,
      sourceMessageId: "msg-1",
      sourceThreadId: threadId,
      origin: "ai",
    })
    if (!result.ok) throw new Error("expected the seam to succeed")
    expect(result.taskId).toEqual(expect.any(String))

    // Identical in behavior to a manual task: same table, same shape —
    // only the origin and provenance differ (ai-assistance parity spec).
    const task = await getTask(executor, result.taskId)
    expect(task).toMatchObject({
      title: "Send the contract",
      notes: "To legal first",
      dueAt: 1_800_000_000,
      origin: "ai",
      sourceMessageId: "msg-1",
      sourceThreadId: threadId,
      sourceAccountId: accountId,
      completedAt: null,
    })
    expect(task?.recurrence).toBeNull()
  })

  it("still creates the task when the source thread is unresolvable", async () => {
    const result = await createTaskFromSuggestion(executor, {
      title: "Orphan suggestion",
      sourceMessageId: "msg-2",
      sourceThreadId: "thread-missing",
      origin: "ai",
    })
    if (!result.ok) throw new Error("expected the seam to succeed")
    const task = await getTask(executor, result.taskId)
    expect(task?.sourceAccountId).toBeNull()
    expect(task?.sourceThreadId).toBe("thread-missing")
  })

  it("throws on an invalid suggestion (the dialog offers Retry)", async () => {
    await expect(
      createTaskFromSuggestion(executor, {
        title: "   ",
        sourceMessageId: "msg-3",
        sourceThreadId: "thread-3",
        origin: "ai",
      })
    ).rejects.toThrow()
  })
})
