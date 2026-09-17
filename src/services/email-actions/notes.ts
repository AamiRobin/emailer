import type { SqlExecutor } from "../db/executor"
import type { ThreadRow } from "../db/threads"
// Reused (not redefined) so the UI's single not-found catch keeps working;
// notes.ts must not shadow thread-actions' exports (index.ts star-exports
// the module group).
import { ThreadNotFoundError } from "./thread-actions"

/**
 * Thread notes (mail-organization spec "Thread notes", task 15.1): one
 * free-form private note per thread, stored in threads.note (migration
 * v3). Local-only by design — the note never leaves the device: no queue
 * operation is enqueued, no provider is contacted, and nothing syncs the
 * column, so it survives restarts exactly like the other local states
 * (mute/pin/done/snooze) and works identically for gmail and imap
 * accounts.
 *
 * Write model: a single nullable TEXT column, so "set" and "remove" are
 * the same UPDATE. Whitespace-only input normalizes to NULL — an emptied
 * textarea removes the note (and with it the thread row's note indicator)
 * instead of persisting an empty string. The reading pane's notes editor
 * is the only writer (auto-save on a short debounce / blur / close).
 */
export async function setThreadNote(
  executor: SqlExecutor,
  threadId: string,
  note: string | null
): Promise<void> {
  const rows = await executor.select<Pick<ThreadRow, "id">>(
    "SELECT id FROM threads WHERE id = $1",
    [threadId]
  )
  if (!rows.length) {
    throw new ThreadNotFoundError(threadId)
  }
  // "" and whitespace-only are treated as "note removed" — same as null.
  const normalized = note === null ? null : note.trim()
  await executor.execute("UPDATE threads SET note = $1 WHERE id = $2", [
    normalized === "" ? null : normalized,
    threadId,
  ])
}
