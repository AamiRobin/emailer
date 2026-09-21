import type { SqlExecutor } from "./executor"

/**
 * Account profiles (parity-round-2 tasks 4.4/4.5, design D10): CRUD over
 * the `account_profiles` table plus the per-account assignment/override
 * columns the v18 migration added to `accounts`.
 *
 * Profiles are a LOCAL grouping only — named groups ("Work", "Personal")
 * that carry a color used by the thread-list markers (mailbox-ui spec
 * "Profile color markers"). They map to no provider object, so every
 * function here is a plain local SQLite write and nothing here ever
 * touches a server (accounts spec: "adding, renaming, deleting, or
 * reassigning SHALL NOT change anything on the mail servers").
 *
 * Effective-color chain (accounts spec): the account's `color_override`
 * when set, else its profile's color, else the account's individual or
 * generated color. The chain is resolved in the account store
 * (effectiveColor) which rebuilds its map from listAccountColorSources();
 * this module owns the rows and the joined read.
 *
 * Deleting a profile KEEPS its accounts: deleteProfile clears every
 * referencing accounts.profile_id first (explicitly, so the guarantee
 * holds regardless of FK enforcement) and only then removes the row —
 * ON DELETE SET NULL is the schema-level backstop for the same scenario.
 * A per-account `color_override` is deliberately NOT cleared: it is the
 * account's individual color, which the spec says survives a profile
 * deletion.
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor.
 */

export interface AccountProfileRow {
  id: string
  name: string
  /** CSS color string as entered from the editor palette ("#8b5cf6"). */
  color: string
  created_at: number
}

/** All profiles, alphabetical (case-insensitive), id breaks ties. */
export async function listProfiles(
  executor: SqlExecutor
): Promise<AccountProfileRow[]> {
  return executor.select<AccountProfileRow>(
    "SELECT id, name, color, created_at FROM account_profiles " +
      "ORDER BY name COLLATE NOCASE ASC, id ASC"
  )
}

/** Insert a profile with a fresh UUID and return the stored row. */
export async function createProfile(
  executor: SqlExecutor,
  input: { name: string; color: string }
): Promise<AccountProfileRow> {
  const id = crypto.randomUUID()
  const rows = await executor.select<AccountProfileRow>(
    `INSERT INTO account_profiles (id, name, color)
     VALUES ($1, $2, $3)
     RETURNING id, name, color, created_at`,
    [id, input.name, input.color]
  )
  return rows[0]
}

/** Mutable profile fields; omitted keys are left unchanged. */
export async function updateProfile(
  executor: SqlExecutor,
  profileId: string,
  patch: { name?: string; color?: string }
): Promise<void> {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.name !== undefined) {
    params.push(patch.name)
    sets.push(`name = $${params.length}`)
  }
  if (patch.color !== undefined) {
    params.push(patch.color)
    sets.push(`color = $${params.length}`)
  }
  if (!sets.length) return
  // placeholder numbers ascend by occurrence in the SQL text (see executor.ts)
  params.push(profileId)
  await executor.execute(
    `UPDATE account_profiles SET ${sets.join(", ")} WHERE id = $${params.length}`,
    params
  )
}

/**
 * Delete a profile and detach its accounts (the spec's delete-keeps-
 * accounts scenario): every accounts.profile_id referencing the profile
 * is nulled first — explicitly, so the accounts keep working with their
 * individual or generated colors no matter the FK enforcement — then the
 * row itself is removed. Mail data and server state are untouched.
 */
export async function deleteProfile(
  executor: SqlExecutor,
  profileId: string
): Promise<void> {
  await executor.execute(
    "UPDATE accounts SET profile_id = NULL WHERE profile_id = $1",
    [profileId]
  )
  await executor.execute("DELETE FROM account_profiles WHERE id = $1", [
    profileId,
  ])
}

/** One account's profile-assignment and color-override state. */
export interface AccountProfileAssignment {
  account_id: string
  profile_id: string | null
  color_override: string | null
}

/**
 * Every account's assignment/override pair (joined with the profile's
 * color when assigned) — the read the account store's effectiveColor map
 * and the profiles editor are built from.
 */
export interface AccountColorSource extends AccountProfileAssignment {
  profile_color: string | null
}

export async function listAccountColorSources(
  executor: SqlExecutor
): Promise<AccountColorSource[]> {
  return executor.select<AccountColorSource>(
    `SELECT a.id AS account_id, a.profile_id, a.color_override,
            p.color AS profile_color
     FROM accounts a
     LEFT JOIN account_profiles p ON p.id = a.profile_id
     ORDER BY a.created_at ASC, a.id ASC`
  )
}

/**
 * Assign an account to a profile (or unassign with null). Moving an
 * account between profiles is the same write. Local only — no provider
 * state exists for profiles.
 */
export async function assignAccountToProfile(
  executor: SqlExecutor,
  accountId: string,
  profileId: string | null
): Promise<void> {
  await executor.execute(
    "UPDATE accounts SET profile_id = $1 WHERE id = $2",
    [profileId, accountId]
  )
}

/**
 * Set (or clear with null) the account's per-account color override —
 * the color that wins over the profile color in the effective-color
 * chain. Deliberately profile-independent: it survives a profile
 * deletion as the account's individual color.
 */
export async function setAccountColorOverride(
  executor: SqlExecutor,
  accountId: string,
  color: string | null
): Promise<void> {
  await executor.execute(
    "UPDATE accounts SET color_override = $1 WHERE id = $2",
    [color, accountId]
  )
}
