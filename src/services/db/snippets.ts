import type { SqlExecutor } from "./executor"

/**
 * Composer text templates (task 6.1): CRUD over the `snippets` table.
 * Snippets are deliberately global (no account_id column) — a snippet is
 * available from every account's composer; the settings section manages
 * the table, the composer insertion (later task) only reads it.
 *
 * No uniqueness is enforced: the table has no UNIQUE constraint and the
 * service deliberately adds none — duplicate names are harmless (rows are
 * identified by id) and the composer picker disambiguates via the body
 * preview. Keep it simple unless a consumer actually needs names unique.
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor.
 */

export interface SnippetRow {
  id: string
  name: string
  body: string
  shortcut: string | null
  created_at: number
}

/** All snippets, alphabetical (case-insensitive), id breaks ties. */
export async function listSnippets(
  executor: SqlExecutor
): Promise<SnippetRow[]> {
  return executor.select<SnippetRow>(
    "SELECT * FROM snippets ORDER BY name COLLATE NOCASE ASC, id ASC"
  )
}

/** Insert a snippet with a fresh UUID; returns the generated id. */
export async function createSnippet(
  executor: SqlExecutor,
  input: { name: string; body: string; shortcut?: string }
): Promise<string> {
  const id = crypto.randomUUID()
  await executor.execute(
    "INSERT INTO snippets (id, name, body, shortcut) VALUES ($1, $2, $3, $4)",
    [id, input.name, input.body, input.shortcut ?? null]
  )
  return id
}

/** Update mutable snippet fields; omitted keys are left unchanged. */
export async function updateSnippet(
  executor: SqlExecutor,
  snippetId: string,
  patch: { name?: string; body?: string; shortcut?: string | null }
): Promise<void> {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.name !== undefined) {
    params.push(patch.name)
    sets.push(`name = $${params.length}`)
  }
  if (patch.body !== undefined) {
    params.push(patch.body)
    sets.push(`body = $${params.length}`)
  }
  if (patch.shortcut !== undefined) {
    params.push(patch.shortcut)
    sets.push(`shortcut = $${params.length}`)
  }
  if (!sets.length) return
  // placeholder numbers ascend by occurrence in the SQL text (see executor.ts)
  params.push(snippetId)
  await executor.execute(
    `UPDATE snippets SET ${sets.join(", ")} WHERE id = $${params.length}`,
    params
  )
}

/** Delete a snippet (no-op when the id is unknown). */
export async function deleteSnippet(
  executor: SqlExecutor,
  snippetId: string
): Promise<void> {
  await executor.execute("DELETE FROM snippets WHERE id = $1", [snippetId])
}
