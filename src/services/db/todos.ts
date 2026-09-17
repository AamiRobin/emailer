import type { SqlExecutor } from "./executor"

/**
 * Todos (mail-organization spec "Email todos", task 15.2): CRUD over the
 * `todos` table — a cross-account list of threads. Each row is scoped to
 * the thread's owning account (account_id FK, like every feature table),
 * but the list itself is deliberately queried across ALL accounts: the
 * sidebar section aggregates every pending todo with its thread's
 * subject/snippet via the JOIN below, so the todo list is one sequence
 * spanning accounts while the rows still cascade away with their account
 * (account removal) or thread (thread deletion).
 *
 * Ordering: `position` is the manual ordering (append at the end via
 * MAX+1, reorder by two-row swaps, exactly the saved_searches scheme).
 * There is no UNIQUE constraint on position, so swaps are safe.
 *
 * Completion: completed_at is stamped and the ROW IS KEPT (audit trail,
 * mirroring how other local states keep their markers); the list query
 * simply filters to completed_at IS NULL, so completed todos leave the
 * sidebar without being deleted. Re-adding a completed thread re-activates
 * it (completed_at cleared) at the bottom.
 *
 * UNIQUE(thread_id): a thread is at most once on the list. Adding an
 * already-listed thread is NOT an error — it moves the row to the bottom
 * of the ordering instead (and re-activates it), so "Add to Todos" can be
 * an always-available, idempotent-feeling action in the UI.
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor.
 */

export interface TodoRow {
  id: string
  account_id: string
  thread_id: string
  position: number
  completed_at: number | null
  created_at: number
}

/** One pending todo joined with its thread for the sidebar section. */
export interface PendingTodoItem {
  id: string
  account_id: string
  thread_id: string
  position: number
  subject: string | null
  snippet: string | null
}

/**
 * Every pending todo across ALL accounts, in list order (manual position,
 * then creation time, then id as the deterministic tiebreak). Completed
 * rows are excluded (kept in the table for audit, hidden from the list).
 */
export async function listPendingTodos(
  executor: SqlExecutor
): Promise<PendingTodoItem[]> {
  return executor.select<PendingTodoItem>(
    `
    SELECT t.id, t.account_id, t.thread_id, t.position,
           th.subject, th.snippet
    FROM todos t
    JOIN threads th ON th.id = t.thread_id
    WHERE t.completed_at IS NULL
    ORDER BY t.position ASC, t.created_at ASC, t.id ASC
    `
  )
}

/** True when the thread currently sits on the list uncompleted. */
export async function isThreadPendingTodo(
  executor: SqlExecutor,
  threadId: string
): Promise<boolean> {
  const rows = await executor.select<Pick<TodoRow, "id">>(
    "SELECT id FROM todos WHERE thread_id = $1 AND completed_at IS NULL",
    [threadId]
  )
  return rows.length > 0
}

/**
 * Add a thread to the end of the todo list; returns the row id. UNIQUE
 * (thread_id) semantics: an already-listed thread is not inserted twice —
 * its row moves to the bottom and a completed row re-activates
 * (completed_at cleared), so re-adding is a harmless "move to bottom".
 */
export async function addTodo(
  executor: SqlExecutor,
  accountId: string,
  threadId: string
): Promise<string> {
  const existing = await executor.select<Pick<TodoRow, "id">>(
    "SELECT id FROM todos WHERE thread_id = $1",
    [threadId]
  )
  const row = existing[0]
  if (row) {
    await executor.execute(
      `UPDATE todos
       SET position = COALESCE((SELECT MAX(position) FROM todos), 0) + 1,
           completed_at = NULL
       WHERE id = $1`,
      [row.id]
    )
    return row.id
  }
  const id = crypto.randomUUID()
  await executor.execute(
    `
    INSERT INTO todos (id, account_id, thread_id, position)
    VALUES ($1, $2, $3, COALESCE((SELECT MAX(position) FROM todos), 0) + 1)
    `,
    [id, accountId, threadId]
  )
  return id
}

/** Remove a todo (no-op when the id is unknown). The thread is untouched. */
export async function removeTodo(
  executor: SqlExecutor,
  todoId: string
): Promise<void> {
  await executor.execute("DELETE FROM todos WHERE id = $1", [todoId])
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Complete a todo: stamps completed_at (the row stays in the table for
 * audit; the list query hides it). With `alsoMarkDone` the thread's own
 * local Done state is stamped too — the same threads.done_at write the
 * thread-states markThreadDone performs (inbox exclusion lives at the
 * query level; see email-actions/thread-states.ts). A missing todo id is
 * a no-op.
 */
export async function completeTodo(
  executor: SqlExecutor,
  todoId: string,
  options?: { alsoMarkDone?: boolean }
): Promise<void> {
  const rows = await executor.select<Pick<TodoRow, "thread_id">>(
    "SELECT thread_id FROM todos WHERE id = $1",
    [todoId]
  )
  const row = rows[0]
  if (!row) return
  await executor.execute("UPDATE todos SET completed_at = $1 WHERE id = $2", [
    nowSeconds(),
    todoId,
  ])
  if (options?.alsoMarkDone) {
    await executor.execute(
      "UPDATE threads SET done_at = $1 WHERE id = $2 AND done_at IS NULL",
      [nowSeconds(), row.thread_id]
    )
  }
}

/**
 * Move a todo one slot up (-1) or down (+1) within the pending list by
 * swapping positions with the adjacent pending row. A no-op at either end
 * of the list or for an unknown id. (Completed rows are inert: they are
 * invisible in the list and never participate in a swap.)
 */
export async function moveTodo(
  executor: SqlExecutor,
  todoId: string,
  direction: -1 | 1
): Promise<void> {
  const rows = await listPendingTodos(executor)
  const index = rows.findIndex((row) => row.id === todoId)
  const neighbor = rows[index + direction]
  if (index === -1 || !neighbor) return
  await executor.execute("UPDATE todos SET position = $1 WHERE id = $2", [
    neighbor.position,
    todoId,
  ])
  await executor.execute("UPDATE todos SET position = $1 WHERE id = $2", [
    rows[index].position,
    neighbor.id,
  ])
}
