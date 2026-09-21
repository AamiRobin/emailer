import type { SqlExecutor } from "../db/executor"
import { createTask } from "./service"

/**
 * Task-creation seam (task 4.8, wired for real in task 5.6) — the ONE
 * function the Phase 4 AI task-extraction review UI
 * (task-extraction-dialog.tsx) calls to turn an ACCEPTED suggestion into
 * a task. The input/result types below are the frozen UI contract and did
 * not change shape when the stub became the real creation:
 *
 * - Input: a {@link TaskSuggestionSeed} — the accepted suggestion plus its
 *   source linkage. `sourceThreadId` deep-links into the thread
 *   (design D6 `source_thread_id`) and `sourceMessageId` is stored as
 *   `source_message_id` (the finer "link back to the source message" the
 *   tasks spec requires; migration v12 carries the column D6's sketch
 *   omitted). The owning mail account is resolved from the thread for
 *   `source_account_id` provenance — best effort, tasks are
 *   account-independent rows.
 * - `origin: "ai"` is fixed by this module's only caller; the task is
 *   created through the SAME service path (tasks/service.ts createTask)
 *   manual tasks use — the spec's AI-proposed-task parity.
 * - Result: `{ ok: true; taskId }` once the row lands. Creation failures
 *   THROW instead of returning `{ ok: false; reason: "unavailable" }`:
 *   since task 5.6 the module always exists, and the frozen dialog treats
 *   a seam throw as a retryable per-item error while "unavailable" would
 *   toast the stale "arrives in a later update" message and silently
 *   dismiss the suggestion. The failure branch stays in the union for the
 *   frozen consumers; the function simply never returns it.
 */

/** The accepted-suggestion payload the frozen UI contract hands over. */
export interface TaskSuggestionSeed {
  /** Short imperative task title (from the AI suggestion). */
  title: string
  /** Optional extra context for the task body. */
  notes?: string
  /** Optional due date, unix seconds (UTC midnight of the model's date). */
  dueAt?: number
  /** The message the suggestion was extracted from — the back-link. */
  sourceMessageId: string
  /** The thread containing `sourceMessageId` (for the thread deep-link). */
  sourceThreadId: string
  /** Provenance; "ai" for everything coming through this seam. */
  origin: "ai"
}

/**
 * Per-suggestion creation outcome. `reason: "unavailable"` was the Phase 4
 * stub's constant answer; since task 5.6 the success branch is live and
 * failures throw (see the module doc). The union shape is frozen.
 */
export type CreateTaskResult =
  | { ok: true; taskId: string }
  | { ok: false; reason: "unavailable" }

/**
 * Create one task from an accepted AI suggestion via the tasks service
 * (task 5.8 verifies the parity with manual tasks). Executor-first like
 * every query service: production callers pass getExecutor(); tests pass
 * the node:sqlite test executor.
 */
export async function createTaskFromSuggestion(
  executor: SqlExecutor,
  suggestion: TaskSuggestionSeed
): Promise<CreateTaskResult> {
  // Provenance only: resolve the thread's owning account, tolerating an
  // unresolvable thread (tasks render across accounts either way).
  let sourceAccountId: string | undefined
  try {
    const rows = await executor.select<{ account_id: string }>(
      "SELECT account_id FROM threads WHERE id = $1",
      [suggestion.sourceThreadId]
    )
    sourceAccountId = rows[0]?.account_id
  } catch {
    // Best-effort attribution — never block creation on it.
  }

  // Same creation path as manual tasks; throws on failure (module doc).
  const task = await createTask(executor, {
    title: suggestion.title,
    ...(suggestion.notes !== undefined ? { notes: suggestion.notes } : {}),
    ...(suggestion.dueAt !== undefined ? { dueAt: suggestion.dueAt } : {}),
    origin: "ai",
    sourceAccountId,
    sourceMessageId: suggestion.sourceMessageId,
    sourceThreadId: suggestion.sourceThreadId,
  })
  return { ok: true, taskId: task.id }
}
