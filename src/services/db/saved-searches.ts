import type { SqlExecutor } from "./executor"

/**
 * Saved searches (task 7.1): CRUD over the `saved_searches` table. A row
 * stores a name plus the raw query string; "running" one navigates the app
 * into the normal search view (the section in components/layout), so the
 * stored text goes through the existing parse → query-builder pipeline and
 * this module stays a plain table wrapper.
 *
 * Deliberately global (no account_id column, like snippets): a saved
 * search is a user bookmark, available from every account.
 *
 * Ordering: `position` keeps the sidebar sequence stable across renames;
 * new rows append at the end via MAX(position)+1. There is no UNIQUE
 * constraint on position (rowid-order swaps are safe), so reordering is a
 * plain two-row position swap (moveSavedSearch).
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor.
 */

export interface SavedSearchRow {
  id: string
  name: string
  query: string
  position: number
  created_at: number
}

/** All saved searches in sidebar order: manual position first, then
 * creation time, then id as the deterministic tiebreak. */
export async function listSavedSearches(
  executor: SqlExecutor
): Promise<SavedSearchRow[]> {
  return executor.select<SavedSearchRow>(
    `
    SELECT * FROM saved_searches
    ORDER BY position ASC, created_at ASC, id ASC
    `
  )
}

/**
 * Insert a saved search appended at the end of the ordering; returns the
 * generated id.
 */
export async function createSavedSearch(
  executor: SqlExecutor,
  input: { name: string; query: string }
): Promise<string> {
  const id = crypto.randomUUID()
  await executor.execute(
    `
    INSERT INTO saved_searches (id, name, query, position)
    VALUES ($1, $2, $3, COALESCE((SELECT MAX(position) FROM saved_searches), 0) + 1)
    `,
    [id, input.name, input.query]
  )
  return id
}

/** Update mutable saved-search fields; omitted keys are left unchanged. */
export async function updateSavedSearch(
  executor: SqlExecutor,
  savedSearchId: string,
  patch: { name?: string; query?: string }
): Promise<void> {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.name !== undefined) {
    params.push(patch.name)
    sets.push(`name = $${params.length}`)
  }
  if (patch.query !== undefined) {
    params.push(patch.query)
    sets.push(`query = $${params.length}`)
  }
  if (!sets.length) return
  // placeholder numbers ascend by occurrence in the SQL text (see executor.ts)
  params.push(savedSearchId)
  await executor.execute(
    `UPDATE saved_searches SET ${sets.join(", ")} WHERE id = $${params.length}`,
    params
  )
}

/** Delete a saved search (no-op when the id is unknown). */
export async function deleteSavedSearch(
  executor: SqlExecutor,
  savedSearchId: string
): Promise<void> {
  await executor.execute("DELETE FROM saved_searches WHERE id = $1", [
    savedSearchId,
  ])
}

/**
 * Move a saved search one slot up (-1) or down (+1) in the sidebar order
 * by swapping positions with the adjacent row. A no-op at either end of
 * the list or for an unknown id.
 */
export async function moveSavedSearch(
  executor: SqlExecutor,
  savedSearchId: string,
  direction: -1 | 1
): Promise<void> {
  const rows = await listSavedSearches(executor)
  const index = rows.findIndex((row) => row.id === savedSearchId)
  const neighbor = rows[index + direction]
  if (index === -1 || !neighbor) return
  await executor.execute(
    "UPDATE saved_searches SET position = $1 WHERE id = $2",
    [neighbor.position, savedSearchId]
  )
  await executor.execute(
    "UPDATE saved_searches SET position = $1 WHERE id = $2",
    [rows[index]!.position, neighbor.id]
  )
}
