import type { SqlExecutor } from "./executor"

/**
 * Token counts for the local adaptive junk filter (task 18.10, design
 * D19) over the `junk_tokens` table (migration v6): one row per
 * (account, token) with the spam/ham training counters. Probabilities are
 * NEVER stored — the classifier computes them from the counts at
 * classification time (see security/junk-filter.ts), so training only
 * ever upserts counters and un-training is just more counters in the
 * other direction.
 *
 * The table is populated EXCLUSIVELY by explicit user actions
 * (mark-spam / not-spam) on IMAP accounts with the per-account junk
 * filter enabled — gmail accounts never write rows (D19), and neither do
 * rules, auto-moves or any other heuristic. Account deletion cascades the
 * whole store.
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor.
 */

/** Mirrors the `junk_tokens` table (migrations.ts v6). */
export interface JunkTokenRow {
  account_id: string
  token: string
  spam_count: number
  ham_count: number
  updated_at: number
}

/**
 * The full token store of one account — the classifier's working set.
 * Classification is per-account by construction (the PK is
 * (account_id, token)), so one query loads everything a pass needs and
 * the sync engines can preload it once per pass instead of per message
 * (the same pattern the rules/schedules/blocklist config follows).
 */
export async function listJunkTokens(
  executor: SqlExecutor,
  accountId: string
): Promise<JunkTokenRow[]> {
  return executor.select<JunkTokenRow>(
    "SELECT * FROM junk_tokens WHERE account_id = $1",
    [accountId]
  )
}

/**
 * Increment one token's counters for an account (presence-based: a
 * training document bumps each of its distinct tokens by exactly 1 in
 * exactly one column). The upsert creates the row on first sight and
 * refreshes updated_at on every bump — the table's only write path.
 */
export async function bumpJunkToken(
  executor: SqlExecutor,
  accountId: string,
  token: string,
  spam: boolean
): Promise<void> {
  await executor.execute(
    `INSERT INTO junk_tokens (account_id, token, spam_count, ham_count, updated_at)
     VALUES ($1, $2, $3, $4, unixepoch())
     ON CONFLICT(account_id, token) DO UPDATE SET
       spam_count = spam_count + excluded.spam_count,
       ham_count = ham_count + excluded.ham_count,
       updated_at = excluded.updated_at`,
    [accountId, token, spam ? 1 : 0, spam ? 0 : 1]
  )
}

/** Total token rows of an account (a cheap existence probe for tests). */
export async function countJunkTokens(
  executor: SqlExecutor,
  accountId: string
): Promise<number> {
  const rows = await executor.select<{ n: number }>(
    "SELECT COUNT(*) AS n FROM junk_tokens WHERE account_id = $1",
    [accountId]
  )
  return rows[0]?.n ?? 0
}
