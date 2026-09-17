import type { SqlExecutor } from "../db/executor"
import type { RuleAction } from "./actions"

/**
 * CRUD over the `rules` table (migration v3, design D5, task 11). Rules
 * are per account; `position` is the deterministic evaluation order at
 * ingestion and only enabled rows run in the hook (rules/ingestion.ts).
 *
 * Storage formats (both columns are named *_json but carry small JSON
 * WRAPPERS around plain strings so the schema's json typing stays honest
 * while the search parser remains the single source of truth for the
 * criteria language):
 * - criteria_json = `{"query": "<raw search-operator query>"}` — the same
 *   language the search box takes (`from:`, `to:`, `subject:`, `label:`,
 *   `has:attachment`, `is:unread`, `is:starred`, free text). The AST is
 *   re-derived by parseSearchQuery at evaluation time (rules/criteria.ts);
 *   storing the serialized AST instead would fork the grammar's versioning
 *   for no read gain.
 * - actions_json = a JSON array of RuleAction objects, e.g.
 *   `[{"type":"add_labels","labels":["Newsletters"]},{"type":"archive"}]` —
 *   compiled onto the EXISTING queue op kinds at application time
 *   (rules/actions.ts), so server sync and offline replay come free.
 */

export interface RuleRow {
  id: string
  account_id: string
  name: string
  criteria_json: string
  actions_json: string
  enabled: number
  position: number
  created_at: number
}

/** The account's rules in evaluation order: position ASC, then creation
 * order (id breaks ties so the order is total and stable). */
export async function listRules(
  executor: SqlExecutor,
  accountId: string
): Promise<RuleRow[]> {
  return executor.select<RuleRow>(
    `SELECT * FROM rules
     WHERE account_id = $1
     ORDER BY position ASC, created_at ASC, id ASC`,
    [accountId]
  )
}

/** The enabled subset of listRules — what the ingestion hook runs. */
export async function listEnabledRules(
  executor: SqlExecutor,
  accountId: string
): Promise<RuleRow[]> {
  return executor.select<RuleRow>(
    `SELECT * FROM rules
     WHERE account_id = $1 AND enabled = 1
     ORDER BY position ASC, created_at ASC, id ASC`,
    [accountId]
  )
}

export async function getRule(
  executor: SqlExecutor,
  ruleId: string
): Promise<RuleRow | null> {
  const rows = await executor.select<RuleRow>(
    "SELECT * FROM rules WHERE id = $1",
    [ruleId]
  )
  return rows[0] ?? null
}

/**
 * Insert a rule; returns the generated id. `criteriaQuery` is the raw
 * search-operator query string (see the module comment for the stored
 * wrapper); `actions` is serialized as given. New rules append after the
 * account's existing ones unless an explicit position is passed.
 */
export async function createRule(
  executor: SqlExecutor,
  input: {
    accountId: string
    name: string
    criteriaQuery: string
    actions: RuleAction[]
    enabled?: boolean
    position?: number
  }
): Promise<string> {
  const id = crypto.randomUUID()
  const position =
    input.position ??
    (await executor
      .select<{ max_position: number | null }>(
        "SELECT MAX(position) AS max_position FROM rules WHERE account_id = $1",
        [input.accountId]
      )
      .then((rows) => (rows[0]?.max_position ?? -1) + 1))
  await executor.execute(
    `INSERT INTO rules (
      id, account_id, name, criteria_json, actions_json, enabled, position
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      input.accountId,
      input.name,
      JSON.stringify({ query: input.criteriaQuery }),
      JSON.stringify(input.actions),
      input.enabled === false ? 0 : 1,
      position,
    ]
  )
  return id
}

/** Update mutable fields; omitted keys are left unchanged. Passing
 * `criteriaQuery`/`actions` re-wraps/reserializes the stored JSON. */
export async function updateRule(
  executor: SqlExecutor,
  ruleId: string,
  patch: {
    name?: string
    criteriaQuery?: string
    actions?: RuleAction[]
    enabled?: boolean
    position?: number
  }
): Promise<void> {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.name !== undefined) {
    params.push(patch.name)
    sets.push(`name = $${params.length}`)
  }
  if (patch.criteriaQuery !== undefined) {
    params.push(JSON.stringify({ query: patch.criteriaQuery }))
    sets.push(`criteria_json = $${params.length}`)
  }
  if (patch.actions !== undefined) {
    params.push(JSON.stringify(patch.actions))
    sets.push(`actions_json = $${params.length}`)
  }
  if (patch.enabled !== undefined) {
    params.push(patch.enabled ? 1 : 0)
    sets.push(`enabled = $${params.length}`)
  }
  if (patch.position !== undefined) {
    params.push(patch.position)
    sets.push(`position = $${params.length}`)
  }
  if (!sets.length) return
  // placeholder numbers ascend by occurrence in the SQL text (see executor.ts)
  params.push(ruleId)
  await executor.execute(
    `UPDATE rules SET ${sets.join(", ")} WHERE id = $${params.length}`,
    params
  )
}

/** Delete a rule (no-op when the id is unknown; account deletion cascades). */
export async function deleteRule(
  executor: SqlExecutor,
  ruleId: string
): Promise<void> {
  await executor.execute("DELETE FROM rules WHERE id = $1", [ruleId])
}
