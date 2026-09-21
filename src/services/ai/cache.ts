import type { SqlExecutor } from "../db/executor"

import { deleteWritingStyleProfile } from "./writing-style"

/**
 * AI result cache (task 4.3, design D2) over the `ai_cache` table
 * (migration v10). The cache is deliberately dumb storage: callers build
 * prompts, invoke the provider command, and persist the output under a
 * content-derived key — `cacheKey` hashes (provider, model, kind, input),
 * so an identical input on the same model/provider always hits the same
 * row and reuses the stored output instead of re-calling the provider
 * (ai-assistance spec, "AI caching and failure handling"). Typical keys:
 * summaries hash the thread's message-id set, categorization hashes the
 * sender address (making per-sender reuse free).
 *
 * Rows carry account_id as PROVENANCE — the account whose mail produced
 * the input — never as part of the key. That attribution is what account
 * removal purges (`purgeAiCacheForAccount`, hooked into removeAccount;
 * spec scenario "Account removal clears cache"). Individual entries and
 * bulk clears back the Settings → AI cache management UI (task 4.2).
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor.
 */

/**
 * sha-256 of `key`, lowercase hex (WebCrypto — the same primitive the
 * attachment disk cache uses). Available in the webview and under vitest;
 * inject a stub hasher instead when tests need forced collisions or
 * byte-level determinism guarantees.
 */
export async function sha256Hex(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key)
  )
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/** The hash function `cacheKey` applies to the serialized identity. */
export type CacheKeyHasher = (key: string) => Promise<string>

/**
 * The identity fields of one cached result. kind is the AI surface
 * ("summary", "reply", "transform", "ask", "tasks", "categorization" —
 * open text, the column has no CHECK so surfaces add kinds freely).
 */
export interface AiCacheKeyParts {
  provider: string
  model: string
  kind: string
  input: string
}

/**
 * JSON-stringify each identity field, then join with the ASCII unit
 * separator. JSON escapes control characters inside strings, so \x1f can
 * never occur within a serialized part — the join is collision-free no
 * matter what the inputs contain (e.g. provider "a" / model "b\x1fc" and
 * provider "a\x1fb" / model "c" serialize differently).
 */
const KEY_SEPARATOR = "\x1f"

/**
 * Deterministic cache key for one cached result: the hasher's hex digest
 * of the serialized identity (design D2: sha256(provider|model|kind|input)).
 * The hasher is injectable so tests can pin digests; production uses
 * sha-256.
 */
export async function cacheKey(
  parts: AiCacheKeyParts,
  hasher: CacheKeyHasher = sha256Hex
): Promise<string> {
  const serialized = [parts.provider, parts.model, parts.kind, parts.input]
    .map((part) => JSON.stringify(part))
    .join(KEY_SEPARATOR)
  return hasher(serialized)
}

/**
 * The cached output for an identical identity, or null on a miss. Note
 * the lookup is intentionally account-independent: the key is pure
 * content, so two accounts feeding the same input share one entry.
 */
export async function getAiCache(
  executor: SqlExecutor,
  lookup: AiCacheKeyParts,
  hasher: CacheKeyHasher = sha256Hex
): Promise<string | null> {
  const inputHash = await cacheKey(lookup, hasher)
  const rows = await executor.select<{ output: string }>(
    "SELECT output FROM ai_cache WHERE provider = $1 AND model = $2 AND input_hash = $3",
    [lookup.provider, lookup.model, inputHash]
  )
  return rows[0]?.output ?? null
}

export interface AiCachePutInput extends AiCacheKeyParts {
  output: string
  /**
   * Account whose mail produced the input — the scope account removal
   * purges. Summaries carry the summarized thread's account,
   * categorization entries the account being categorized; null/omitted
   * for inputs not derived from one account.
   */
  accountId?: string | null
  /** Unix-seconds clock (injectable for tests). Default: wall clock. */
  now?: () => number
}

/**
 * Store (or overwrite) the output for one identity. Idempotent replace on
 * the (provider, model, input_hash) unique key: an explicit regeneration
 * replaces the stored row wholesale, refreshing created_at.
 */
export async function putAiCache(
  executor: SqlExecutor,
  input: AiCachePutInput,
  hasher: CacheKeyHasher = sha256Hex
): Promise<void> {
  const inputHash = await cacheKey(input, hasher)
  const now = input.now ?? (() => Math.floor(Date.now() / 1000))
  await executor.execute(
    `INSERT OR REPLACE INTO ai_cache (
       provider, model, input_hash, kind, output, account_id, created_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.provider,
      input.model,
      inputHash,
      input.kind,
      input.output,
      input.accountId ?? null,
      now(),
    ]
  )
}

/** Identifies one stored row — the settings UI removes entries by hash. */
export interface AiCacheEntryRef {
  provider: string
  model: string
  inputHash: string
}

/** Remove a single cached entry (spec: entries removable individually). */
export async function removeAiCacheEntry(
  executor: SqlExecutor,
  ref: AiCacheEntryRef
): Promise<void> {
  await executor.execute(
    "DELETE FROM ai_cache WHERE provider = $1 AND model = $2 AND input_hash = $3",
    [ref.provider, ref.model, ref.inputHash]
  )
}

/**
 * Clear cache rows: one account's when accountId is given (its provenance
 * attribution), everything when omitted. Rows without an account survive
 * account-scoped clears — they derive from no account's mail.
 */
export async function clearAiCache(
  executor: SqlExecutor,
  accountId?: string
): Promise<void> {
  if (accountId === undefined) {
    await executor.execute("DELETE FROM ai_cache")
  } else {
    await executor.execute("DELETE FROM ai_cache WHERE account_id = $1", [
      accountId,
    ])
  }
}

/** Bulk clear of every cached entry (spec: removable in bulk). */
export async function clearAiCacheAll(executor: SqlExecutor): Promise<void> {
  await executor.execute("DELETE FROM ai_cache")
}

/** Per-kind row counts and created_at range for the settings UI (4.2). */
export interface AiCacheKindStats {
  kind: string
  count: number
  oldest_at: number | null
  newest_at: number | null
}

export interface AiCacheStats {
  total: number
  byKind: AiCacheKindStats[]
}

/** Cache size overview: total count plus per-kind counts and age range. */
export async function aiCacheStats(
  executor: SqlExecutor
): Promise<AiCacheStats> {
  const rows = await executor.select<AiCacheKindStats>(
    `SELECT kind, COUNT(*) AS count,
            MIN(created_at) AS oldest_at, MAX(created_at) AS newest_at
     FROM ai_cache
     GROUP BY kind
     ORDER BY count DESC, kind ASC`
  )
  return {
    total: rows.reduce((sum, row) => sum + row.count, 0),
    byKind: rows,
  }
}

/**
 * Delete everything the AI layer derived from one account: its cache rows
 * plus its writing-style profile (design D2: "account removal deletes by
 * account_id"). Called from removeAccount — the spec's "Account removal
 * clears cache" scenario.
 */
export async function purgeAiCacheForAccount(
  executor: SqlExecutor,
  accountId: string
): Promise<void> {
  await executor.execute("DELETE FROM ai_cache WHERE account_id = $1", [
    accountId,
  ])
  await deleteWritingStyleProfile(executor, accountId)
}
