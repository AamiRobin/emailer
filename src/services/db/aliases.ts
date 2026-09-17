import type { SqlExecutor } from "./executor"

/**
 * Send-as identities (design D10, task 16): CRUD over the `aliases` table
 * (migration v3). Two sources share the table:
 * - gmail rows are written ONLY by the SendAs sync
 *   (src/services/aliases/sync.ts) — the API is the source of truth;
 * - imap rows are manual (the user adds them; there is no server list).
 *
 * Single default per account: `is_default` is enforced by setDefaultAlias /
 * upsertManualAlias(..., isDefault) through one atomic CASE UPDATE (the
 * executor ships no transaction API; a single statement is the honest
 * equivalent). The Gmail SendAs sync writes is_default per row (it cannot
 * clear siblings), so its pass ends with the same clear-others sweep over
 * the surviving default (src/services/aliases/sync.ts) — at most one row
 * per account carries is_default = 1 after every write path.
 *
 * Emails are normalized to lowercase before they touch the UNIQUE
 * (account_id, email) index — SQLite's UNIQUE is case-sensitive, and the
 * alias matching everywhere else (reply preselection, sync reconcile) is
 * case-insensitive, so the index must not admit case twins.
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor.
 */

/** Mirrors the `aliases` table (migrations.ts v3). */
export interface AliasRow {
  id: string
  account_id: string
  email: string
  display_name: string | null
  is_default: number
  source: "gmail" | "imap"
  created_at: number
}

export type AliasSource = AliasRow["source"]

/**
 * The light sendable-address shape manual aliases must satisfy (same
 * pragmatism as the composer's validation: one @, no whitespace, a
 * dotted domain). Full RFC 5322 parsing is deliberately not attempted.
 */
const ALIAS_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Thrown by upsertManualAlias for a malformed address. */
export class AliasValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AliasValidationError"
  }
}

/** Lowercased, trimmed alias email (see the module docstring). */
export function normalizeAliasEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** All aliases of one account, insertion order (stable for the settings
 * surface); `source` narrows to one half of the table when given. */
export async function listAliases(
  executor: SqlExecutor,
  accountId: string,
  source?: AliasSource
): Promise<AliasRow[]> {
  if (source !== undefined) {
    return executor.select<AliasRow>(
      "SELECT * FROM aliases WHERE account_id = $1 AND source = $2 ORDER BY created_at ASC, id ASC",
      [accountId, source]
    )
  }
  return executor.select<AliasRow>(
    "SELECT * FROM aliases WHERE account_id = $1 ORDER BY created_at ASC, id ASC",
    [accountId]
  )
}

/**
 * The composer-facing ordering: the default identity first, then
 * alphabetical (case-insensitive). The From picker renders this directly
 * and treats the first is_default row as the preselected alias.
 */
export async function getSendAsAliases(
  executor: SqlExecutor,
  accountId: string
): Promise<AliasRow[]> {
  return executor.select<AliasRow>(
    `SELECT * FROM aliases WHERE account_id = $1
     ORDER BY is_default DESC, email COLLATE NOCASE ASC, id ASC`,
    [accountId]
  )
}

/**
 * The one atomic statement behind "make this the default": every sibling
 * row of the account is cleared in the same write that sets the target,
 * so the single-default invariant cannot be observed violated.
 */
async function writeDefault(
  executor: SqlExecutor,
  accountId: string,
  aliasId: string
): Promise<void> {
  // Placeholder numbers ascend by occurrence in the SQL text (see
  // executor.ts — both drivers bind positionally, not by token number).
  await executor.execute(
    `UPDATE aliases
     SET is_default = CASE WHEN id = $1 THEN 1 ELSE 0 END
     WHERE account_id = $2`,
    [aliasId, accountId]
  )
}

/**
 * Point the account's default at `aliasId` (clearing the previous
 * default). No-op when the alias does not exist (the UPDATE simply
 * matches nothing) — every row of the account ends up non-default.
 */
export async function setDefaultAlias(
  executor: SqlExecutor,
  accountId: string,
  aliasId: string
): Promise<void> {
  await writeDefault(executor, accountId, aliasId)
}

/**
 * Add (or update) a MANUAL alias for the account — the IMAP flow; Gmail
 * rows must go through the SendAs sync so the API stays authoritative.
 * An existing row with the same email is updated in place (display name),
 * keeping its original id and source; `isDefault` runs the same
 * clear-others write as setDefaultAlias.
 *
 * Throws AliasValidationError when the email is not a plausible address.
 * Returns the row id.
 */
export async function upsertManualAlias(
  executor: SqlExecutor,
  accountId: string,
  input: { email: string; displayName?: string; isDefault?: boolean }
): Promise<string> {
  const email = normalizeAliasEmail(input.email)
  if (!ALIAS_EMAIL_PATTERN.test(email)) {
    throw new AliasValidationError(`"${input.email}" is not a valid address`)
  }
  const displayName = input.displayName?.trim() ?? null

  // One statement per concern (no transactions in the executor surface):
  // upsert first, then the default sweep — a crash between them leaves a
  // correct row with a stale default, never a half-written alias.
  const existing = await executor.select<{ id: string; source: AliasSource }>(
    "SELECT id, source FROM aliases WHERE account_id = $1 AND email = $2",
    [accountId, email]
  )
  let id: string
  if (existing[0]) {
    id = existing[0].id
    await executor.execute(
      "UPDATE aliases SET display_name = $1 WHERE id = $2",
      [displayName, id]
    )
  } else {
    id = crypto.randomUUID()
    await executor.execute(
      `INSERT INTO aliases (id, account_id, email, display_name, is_default, source)
       VALUES ($1, $2, $3, $4, 0, 'imap')`,
      [id, accountId, email, displayName]
    )
  }
  if (input.isDefault) {
    await writeDefault(executor, accountId, id)
  }
  return id
}

/**
 * Insert/update a row on behalf of the Gmail SendAs sync (source
 * 'gmail'). Manual (imap) rows with the same email are never modified:
 * the UPDATE is gated on source = 'gmail', and a colliding manual row
 * makes the insert a no-op. Returns the row id when a gmail row exists
 * or was created, null when a manual row holds the address.
 */
export async function upsertSyncedAlias(
  executor: SqlExecutor,
  accountId: string,
  input: {
    email: string
    displayName?: string | null
    isDefault?: boolean
  }
): Promise<string | null> {
  const email = normalizeAliasEmail(input.email)
  const displayName = input.displayName?.trim() || null
  const isDefault = input.isDefault ? 1 : 0

  const updated = await executor.execute(
    `UPDATE aliases
     SET display_name = $1, is_default = $2
     WHERE account_id = $3 AND email = $4 AND source = 'gmail'`,
    [displayName, isDefault, accountId, email]
  )
  if (updated.rowsAffected > 0) {
    const rows = await executor.select<{ id: string }>(
      "SELECT id FROM aliases WHERE account_id = $1 AND email = $2",
      [accountId, email]
    )
    return rows[0]?.id ?? null
  }
  // No gmail row yet; a manual row with the same address wins (null).
  const collision = await executor.select<{ id: string }>(
    "SELECT id FROM aliases WHERE account_id = $1 AND email = $2",
    [accountId, email]
  )
  if (collision[0]) return null
  const id = crypto.randomUUID()
  await executor.execute(
    `INSERT INTO aliases (id, account_id, email, display_name, is_default, source)
     VALUES ($1, $2, $3, $4, $5, 'gmail')`,
    [id, accountId, email, displayName, isDefault]
  )
  return id
}

/** Update a manual alias's mutable fields; omitted keys are unchanged.
 * `isDefault` true applies the clear-others sweep; explicitly false just
 * clears this one row (a new default is then the composer's fallback). */
export async function updateAlias(
  executor: SqlExecutor,
  aliasId: string,
  patch: { displayName?: string | null; isDefault?: boolean }
): Promise<void> {
  if (patch.displayName !== undefined) {
    await executor.execute(
      "UPDATE aliases SET display_name = $1 WHERE id = $2",
      [patch.displayName?.trim() || null, aliasId]
    )
  }
  if (patch.isDefault !== undefined) {
    if (patch.isDefault) {
      const rows = await executor.select<{ account_id: string }>(
        "SELECT account_id FROM aliases WHERE id = $1",
        [aliasId]
      )
      const accountId = rows[0]?.account_id
      if (accountId) await writeDefault(executor, accountId, aliasId)
    } else {
      await executor.execute(
        "UPDATE aliases SET is_default = 0 WHERE id = $1",
        [aliasId]
      )
    }
  }
}

/** Delete an alias (no-op when the id is unknown). */
export async function deleteAlias(
  executor: SqlExecutor,
  aliasId: string
): Promise<void> {
  await executor.execute("DELETE FROM aliases WHERE id = $1", [aliasId])
}
