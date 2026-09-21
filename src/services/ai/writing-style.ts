import type { SqlExecutor } from "../db/executor"

/**
 * Writing-style profile store (task 4.3, design D2) over the
 * `writing_style_profiles` table (migration v10). Exactly one row per
 * account — account_id is the primary key, so saving upserts. The profile
 * payload is opaque JSON here: this module only stores, fetches and
 * deletes the envelope; the profile schema and the sent-message analysis
 * that builds it are owned by the style-analysis caller (task 4.5).
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor.
 */

/** The decoded profile envelope for one account. */
export interface WritingStyleProfile<T = unknown> {
  /** The stored profile, JSON-decoded. Schema owned by task 4.5. */
  profile: T
  /** Unix seconds of the build that produced this profile. */
  builtAt: number
  /** How many sent messages the build analyzed. */
  sampleSize: number
}

/**
 * The stored profile for an account, or null when none exists or the
 * stored payload is not valid JSON — a corrupt row is treated as absent
 * so the smart-reply surface degrades to "no profile" (the user rebuilds
 * it) instead of crashing.
 */
export async function getWritingStyleProfile<T = unknown>(
  executor: SqlExecutor,
  accountId: string
): Promise<WritingStyleProfile<T> | null> {
  const rows = await executor.select<{
    profile_json: string
    built_at: number
    sample_size: number
  }>(
    "SELECT profile_json, built_at, sample_size FROM writing_style_profiles WHERE account_id = $1",
    [accountId]
  )
  const row = rows[0]
  if (!row) return null
  try {
    return {
      profile: JSON.parse(row.profile_json) as T,
      builtAt: row.built_at,
      sampleSize: row.sample_size,
    }
  } catch {
    return null
  }
}

/**
 * Persist the profile for an account, replacing any previous one
 * (upsert on the account_id primary key). profileJson is the JSON-encoded
 * profile string — serialization is the caller's job (task 4.5).
 */
export async function saveWritingStyleProfile(
  executor: SqlExecutor,
  accountId: string,
  profileJson: string,
  sampleSize: number,
  /** Unix-seconds clock (injectable for tests). Default: wall clock. */
  now: () => number = () => Math.floor(Date.now() / 1000)
): Promise<void> {
  await executor.execute(
    `INSERT INTO writing_style_profiles (
       account_id, profile_json, built_at, sample_size
     )
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(account_id) DO UPDATE SET
       profile_json = excluded.profile_json,
       built_at = excluded.built_at,
       sample_size = excluded.sample_size`,
    [accountId, profileJson, now(), sampleSize]
  )
}

/** Delete an account's profile (account removal purge; "refresh" flows
 * simply save over it). No-op when none is stored. */
export async function deleteWritingStyleProfile(
  executor: SqlExecutor,
  accountId: string
): Promise<void> {
  await executor.execute(
    "DELETE FROM writing_style_profiles WHERE account_id = $1",
    [accountId]
  )
}
