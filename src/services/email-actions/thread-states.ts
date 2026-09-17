import type { SqlExecutor } from "../db/executor"
import type { ThreadRow } from "../db/threads"
// Reused (not redefined) so the UI's single not-found catch keeps working;
// thread-states.ts must not shadow thread-actions' exports (index.ts
// star-exports both modules).
import { ThreadNotFoundError } from "./thread-actions"

/**
 * Local-only thread states (mail-organization spec): mute, pin and Done.
 * Like snooze.ts, these are pure local flags — no queue operation is
 * enqueued and no provider is ever contacted; each lives in its own
 * threads column (migration v3) and works identically for gmail and imap
 * accounts, online or offline.
 *
 * What each state does — all at the QUERY level, never by mutating
 * placement/read state (see the `muted_at IS NULL` / `done_at IS NULL`
 * predicates and the `(pinned_at IS NOT NULL) DESC` ordering terms in
 * db/threads.ts, db/folder-counts.ts, db/accounts.ts and
 * search/query-builder.ts):
 * - mute: out of the inbox list, out of every unread count (inbox badge,
 *   total OS badge, per-account switcher counts) and out of new-mail
 *   notifications (the sync engines do not count newly inserted messages
 *   in muted threads). Still reachable via search, its labels and All
 *   Mail; a new incoming message does NOT unmute it — only unmuteThread
 *   clears the flag.
 * - done: out of the inbox list and the inbox badge, like archive — but
 *   is_archived is deliberately NOT set (a distinct local state; the
 *   inbox predicates exclude done_at directly). Stays in its labels,
 *   All Mail, search and every other folder badge.
 * - pin: no filtering anywhere — only ordering. Every thread-list sort
 *   leads with `(pinned_at IS NOT NULL) DESC`, so a pinned thread stays
 *   at the top of its view regardless of sort.
 *
 * All timestamps are unix epoch SECONDS, like the rest of the schema.
 */

/** Unix epoch seconds for the set() writes below. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Flip one local state column. `set` stamps `column = now` (re-stamping
 * is harmless — the flag is a marker, not a deadline); `clear` nulls it.
 * The setter throws the shared ThreadNotFoundError when the thread does
 * not exist (a bad caller arg is a programming error, mirroring
 * snoozeThread); the clearer is a plain idempotent UPDATE — clearing an
 * already-cleared (or missing) thread changes nothing.
 */
async function setThreadState(
  executor: SqlExecutor,
  threadId: string,
  column: "muted_at" | "pinned_at" | "done_at"
): Promise<void> {
  const rows = await executor.select<Pick<ThreadRow, "id">>(
    "SELECT id FROM threads WHERE id = $1",
    [threadId]
  )
  if (!rows.length) {
    throw new ThreadNotFoundError(threadId)
  }
  // The column name is a fixed literal from the callers below, never user
  // input; the one bound parameter ascends first (see executor.ts).
  await executor.execute(`UPDATE threads SET ${column} = $1 WHERE id = $2`, [
    nowSeconds(),
    threadId,
  ])
}

async function clearThreadState(
  executor: SqlExecutor,
  threadId: string,
  column: "muted_at" | "pinned_at" | "done_at"
): Promise<void> {
  await executor.execute(`UPDATE threads SET ${column} = NULL WHERE id = $1`, [
    threadId,
  ])
}

// ---- Mute ----

/**
 * Mute a thread: it leaves the inbox, stops counting toward every unread
 * badge, and new mail landing in it no longer produces OS notifications
 * (filtered by the sync engines before the count reaches the scheduler).
 * Search, labels and All Mail still list it. Throws the shared
 * ThreadNotFoundError when the thread does not exist.
 */
export function muteThread(
  executor: SqlExecutor,
  threadId: string
): Promise<void> {
  return setThreadState(executor, threadId, "muted_at")
}

/**
 * Unmute: clears muted_at only. Read state and placement were never
 * touched by muting, so the thread simply re-enters the inbox list and
 * the unread counts exactly as it was.
 */
export function unmuteThread(
  executor: SqlExecutor,
  threadId: string
): Promise<void> {
  return clearThreadState(executor, threadId, "muted_at")
}

// ---- Pin ----

/**
 * Pin a thread to the top of its view: a pure ordering change — every
 * thread-list sort (folder lists and search alike) leads with the
 * pinned-first term, so the row stays above newer unpinned threads.
 * Throws the shared ThreadNotFoundError when the thread does not exist.
 */
export function pinThread(
  executor: SqlExecutor,
  threadId: string
): Promise<void> {
  return setThreadState(executor, threadId, "pinned_at")
}

/** Unpin: clears pinned_at; the thread falls back to its natural sort position. */
export function unpinThread(
  executor: SqlExecutor,
  threadId: string
): Promise<void> {
  return clearThreadState(executor, threadId, "pinned_at")
}

// ---- Done ----

/**
 * Mark a thread Done: it leaves the inbox like an archive — but without
 * touching is_archived (Done is a distinct local state; the inbox
 * predicates exclude done_at directly). The thread stays listed under its
 * labels, All Mail and search, and other folder badges keep counting it.
 * Throws the shared ThreadNotFoundError when the thread does not exist.
 */
export function markThreadDone(
  executor: SqlExecutor,
  threadId: string
): Promise<void> {
  return setThreadState(executor, threadId, "done_at")
}

/** Undo Done: clears done_at; the thread re-enters the inbox unchanged. */
export function unmarkThreadDone(
  executor: SqlExecutor,
  threadId: string
): Promise<void> {
  return clearThreadState(executor, threadId, "done_at")
}
