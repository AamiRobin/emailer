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
 */

import type { SqlExecutor } from "../db/executor"
import type { ThreadRow } from "../db/threads"
import {
  buildThreadSearchSql,
  type SearchThreadsOptions,
} from "./query-builder"
import { isEmptyQuery, parseSearchQuery } from "./parser"

export { parseSearchQuery, isEmptyQuery, type ParsedQuery } from "./parser"
export {
  buildThreadSearchSql,
  type BuiltThreadSearchSql,
  type SearchThreadsOptions,
} from "./query-builder"

/**
 * Parse + build + run: the operator-aware thread search over an ACCOUNT
 * SET (task 9.1). An input with no usable terms (empty, whitespace, or
 * only bare `key:` tokens) returns [] — the caller shows an empty result
 * instead of the whole mailbox — and so does an empty account set (the
 * builder would render a no-match predicate anyway; skipping the query
 * keeps the "nothing active" store path cheap). Sorting and `limit` apply
 * across the whole set in the one SQL statement, so a limit is applied
 * AFTER the merge, never per account.
 */
export async function searchThreadsAcrossAccounts(
  executor: SqlExecutor,
  accountIds: string[],
  input: string,
  options?: SearchThreadsOptions
): Promise<ThreadRow[]> {
  const parsed = parseSearchQuery(input)
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
 * search: both count 0.
 */
export async function countThreadsForQuery(
  executor: SqlExecutor,
  accountIds: string[],
  input: string
): Promise<number> {
  const parsed = parseSearchQuery(input)
  if (isEmptyQuery(parsed) || accountIds.length === 0) return 0
  const { sql, params } = buildThreadSearchSql(accountIds, parsed)
  const rows = await executor.select<{ count: number }>(
    `SELECT COUNT(*) AS count FROM (${sql})`,
    params
  )
  return rows[0]?.count ?? 0
}
