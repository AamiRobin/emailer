/**
 * Public surface of the operator-aware thread search (OpenSpec task 9.1):
 * - parseSearchQuery — tokenize a Gmail-style query string (parser.ts)
 * - buildThreadSearchSql — render the parsed predicates as SQL + params
 *   (query-builder.ts), over one account or an account set
 * - searchThreadsQuery — parse + build + run for ONE account against a
 *   SqlExecutor, returning ThreadRow[] compatible with listThreadsByFolder
 * - searchThreadsAcrossAccounts — the same pipeline over an account-id
 *   set (design D4: the unified/split/saved-search scopes run the same
 *   search minus the single-account filter; rows keep their account_id)
 * - searchThreadsWithRelaxedFallback — the search-box entry (task 1.3,
 *   design D7): strict first, and on zero results an operator-free query
 *   is re-run in OR mode, returned with `relaxed: true` for the UI badge
 * - countThreadsForQuery — the same pipeline's total-match COUNT (task
 *   9.3: the split tab bar's per-tab counts)
 * - foldText — the accent fold (NFD diacritic-strip) the query side uses
 * - resolveDateTokens — the `__TODAY±ND__` dynamic date tokens (task 3.8,
 *   design D13), resolved inside the run entry points below at QUERY
 *   time: every stored query (split, saved search, the search box) is
 *   expanded before parsing, so saved tabs stay current without editing
 *   and the split's tab count always agrees with its thread list. The
 *   parser itself stays clock-free — rules criteria re-derive through
 *   parseSearchQuery and keep their existing (token-unaware) semantics.
 */

import type { SqlExecutor } from "../db/executor"
import type { ThreadRow } from "../db/threads"
import { resolveDateTokens } from "./date-tokens"
import {
  buildThreadSearchSql,
  type SearchThreadsOptions,
} from "./query-builder"
import { isEmptyQuery, parseSearchQuery, usesOperators } from "./parser"

export { parseSearchQuery, isEmptyQuery, usesOperators, type ParsedQuery } from "./parser"
export {
  buildThreadSearchSql,
  type BuiltThreadSearchSql,
  type SearchThreadsOptions,
} from "./query-builder"
export { foldText, toFtsMatch } from "./fts"
export { resolveDateTokens } from "./date-tokens"

/**
 * Parse + build + run: the operator-aware thread search over an ACCOUNT
 * SET (task 9.1). An input with no usable terms (empty, whitespace, or
 * only bare `key:` tokens) returns [] — the caller shows an empty result
 * instead of the whole mailbox — and so does an empty account set (the
 * builder would render a no-match predicate anyway; skipping the query
 * keeps the "nothing active" store path cheap). Sorting and `limit` apply
 * across the whole set in the one SQL statement, so a limit is applied
 * AFTER the merge, never per account.
 *
 * Dynamic date tokens (`__TODAY±ND__`, task 3.8 / design D13) are
 * resolved here — the single run seam shared by the split scopes, saved
 * searches and the search box — so a stored `after:__TODAY-7D__` is
 * re-expanded against the current clock on EVERY evaluation (refresh,
 * tab switch), never baked in at save time. Resolving in the shared
 * entry points (rather than in the split caller) keeps the split's tab
 * count (countThreadsForQuery) on the identical expanded query; the
 * parser stays clock-free so rules criteria keep their semantics.
 */
export async function searchThreadsAcrossAccounts(
  executor: SqlExecutor,
  accountIds: string[],
  input: string,
  options?: SearchThreadsOptions
): Promise<ThreadRow[]> {
  const parsed = parseSearchQuery(resolveDateTokens(input))
  if (isEmptyQuery(parsed) || accountIds.length === 0) return []
  const { sql, params } = buildThreadSearchSql(accountIds, parsed, options)
  return executor.select<ThreadRow>(sql, params)
}

/**
 * Parse + build + run: the account-scoped operator-aware thread search.
 * An input with no usable terms (empty, whitespace, or only bare `key:`
 * tokens) returns [] — the caller shows an empty result instead of the
 * whole mailbox.
 */
export async function searchThreadsQuery(
  executor: SqlExecutor,
  accountId: string,
  input: string,
  options?: SearchThreadsOptions
): Promise<ThreadRow[]> {
  return searchThreadsAcrossAccounts(executor, [accountId], input, options)
}

/**
 * Total matching-thread count for a query over an account set (task 9.3:
 * the split tab bar's per-tab counts). Runs the EXACT search pipeline —
 * parse → buildThreadSearchSql — with the built SELECT wrapped in a
 * COUNT(*) subquery, so a split's count sees the same WHERE clause (the
 * account set, the trash/spam exclusions, the operators, the FTS match)
 * its thread list does. The ORDER BY rides along harmlessly (ignored for
 * aggregate counting) and no limit is applied — the count is the total,
 * not a page size. Same empty-input and empty-account-set rules as the
 * search: both count 0. Date tokens resolve here too (task 3.8, D13), so
 * a rolling split's count tracks the same expanded query as its list.
 */
export async function countThreadsForQuery(
  executor: SqlExecutor,
  accountIds: string[],
  input: string
): Promise<number> {
  const parsed = parseSearchQuery(resolveDateTokens(input))
  if (isEmptyQuery(parsed) || accountIds.length === 0) return 0
  const { sql, params } = buildThreadSearchSql(accountIds, parsed)
  const rows = await executor.select<{ count: number }>(
    `SELECT COUNT(*) AS count FROM (${sql})`,
    params
  )
  return rows[0]?.count ?? 0
}

/** Result of the search-box entry point: the rows plus whether they came
 * from the relaxed any-term retry — the UI renders its "relaxed search"
 * badge from the flag (task 1.3, mail-search spec "Relaxed fallback"). */
export interface RelaxedSearchResult {
  threads: ThreadRow[]
  relaxed: boolean
}

/**
 * The search box's run seam (task 1.3, design D7): the strict all-terms
 * query first; only when it returns ZERO rows and the query carries NO
 * operators (usesOperators — an operator query is never rewritten, so
 * from:/is:/-term scopes can never silently widen into mail the user
 * filtered out) is the same query re-run in OR mode (freeTextMatch
 * "any") and flagged `relaxed: true` when that retry finds rows. The
 * original query string is never touched — only its free-text terms
 * recombine; a second retry makes no sense, so a single-term query
 * (whose OR form IS the strict form) and a query with no positive terms
 * (negation-only) skip the retry. Splits, saved searches and the split
 * tab counts deliberately run the plain strict pipeline — their stored
 * queries keep exact semantics and stay in sync with their counts.
 */
export async function searchThreadsWithRelaxedFallback(
  executor: SqlExecutor,
  accountIds: string[],
  input: string,
  options?: SearchThreadsOptions
): Promise<RelaxedSearchResult> {
  const strict = await searchThreadsAcrossAccounts(
    executor,
    accountIds,
    input,
    options
  )
  if (strict.length > 0) return { threads: strict, relaxed: false }
  const parsed = parseSearchQuery(resolveDateTokens(input))
  if (
    isEmptyQuery(parsed) ||
    usesOperators(parsed) ||
    parsed.freeText.length < 2
  ) {
    return { threads: [], relaxed: false }
  }
  const relaxed = await searchThreadsAcrossAccounts(
    executor,
    accountIds,
    input,
    { ...options, freeTextMatch: "any" }
  )
  return { threads: relaxed, relaxed: relaxed.length > 0 }
}
