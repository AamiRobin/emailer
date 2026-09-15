/**
 * Public surface of the operator-aware thread search (OpenSpec task 9.1):
 * - parseSearchQuery — tokenize a Gmail-style query string (parser.ts)
 * - buildThreadSearchSql — render the parsed predicates as SQL + params
 *   (query-builder.ts)
 * - searchThreadsQuery — parse + build + run against a SqlExecutor,
 *   returning ThreadRow[] compatible with listThreadsByFolder results.
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
  const parsed = parseSearchQuery(input)
  if (isEmptyQuery(parsed)) return []
  const { sql, params } = buildThreadSearchSql(accountId, parsed, options)
  return executor.select<ThreadRow>(sql, params)
}
