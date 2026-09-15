import { escapeLikePattern, toFtsMatch } from "./fts"
import type { ParsedQuery } from "./parser"

/**
 * Builds the SQL for an account-scoped Gmail-style thread search from a
 * ParsedQuery. Pure string/array construction — no I/O, and user input is
 * always bound through `$N` parameters, never interpolated.
 *
 * Shape: one SELECT over `threads`, restricted to
 * - the account (`threads.account_id = ?`), and
 * - the mailbox (`is_trashed = 0 AND is_spam = 0`): like Gmail, search
 *   covers mail the user can act on; trashed/spammed threads are surfaced
 *   by their own folders (threads.ts presets), not search results.
 *
 * Predicates, all AND-ed, appended in this fixed order (which fixes the
 * ascending `$N` parameter order — see executor.ts):
 * 1. `from:` → EXISTS over the thread's messages matching from_address OR
 *    from_name (COLLATE NOCASE LIKE). Operators accept "any message in the
 *    thread" as evidence; free text (below) keeps the stricter
 *    single-message semantics of the original search.ts.
 * 2. `to:` → EXISTS matching to_json / cc_json / bcc_json — addresses are
 *    stored as JSON arrays of `{name?, email}`, so a plain substring LIKE
 *    over the serialized arrays covers both names and addresses.
 * 3. `subject:` → EXISTS matching messages.subject.
 *    All operator values use LIKE (case-insensitive for ASCII in SQLite,
 *    made explicit with COLLATE NOCASE on the left operand) — predictable
 *    substring semantics; only free text uses the FTS index, whose trigram
 *    tokenizer needs ≥3-char terms anyway.
 * 4. `has:attachment` → `threads.has_attachments = 1`, the cache column
 *    recomputeThreadCaches() keeps at MAX(messages.has_attachments) on
 *    every sync, so it is true exactly when some message has attachments.
 * 5. `is:unread` → `threads.unread_count > 0`.
 * 6. `is:starred` → `threads.is_starred = 1`.
 * 7. `label:<name>` → EXISTS through thread_labels JOIN labels, scoped to
 *    the account via thread_labels.account_id. A label matches when its
 *    full name equals the value case-insensitively OR ends with
 *    "/<value>" (case-insensitive): `label:receipts` matches a label named
 *    "receipts" (the spec scenario) and addresses the leaf of
 *    "Finance/receipts" without the full path.
 * 8. Free text → a single EXISTS over messages: terms of ≥3 chars go
 *    through the external-content messages_fts trigram index (combined
 *    into one quoted MATCH string, so ONE message must match ALL terms —
 *    same semantics as the original search.ts); terms shorter than 3 chars
 *    can never produce a trigram token, so each falls back to a LIKE scan
 *    over the same columns the FTS index covers (subject, from_name,
 *    from_address, to_json, body_text, snippet).
 *
 * An empty ParsedQuery yields the bare mailbox query (all non-trash,
 * non-spam threads of the account); searchThreadsQuery (index.ts)
 * short-circuits that case to an empty result instead.
 */

export interface SearchThreadsOptions {
  limit?: number
}

export interface BuiltThreadSearchSql {
  sql: string
  params: unknown[]
}

/** LIKE columns for short free-text terms — mirrors the messages_fts columns. */
const SHORT_TERM_LIKE_COLUMNS = [
  "m.subject",
  "m.from_name",
  "m.from_address",
  "m.to_json",
  "m.body_text",
  "m.snippet",
]

export function buildThreadSearchSql(
  accountId: string,
  parsed: ParsedQuery,
  options?: SearchThreadsOptions
): BuiltThreadSearchSql {
  const params: unknown[] = [accountId]
  const conditions: string[] = ["threads.is_trashed = 0", "threads.is_spam = 0"]

  // 1. from: — address OR display name of some message in the thread.
  for (const value of parsed.from) {
    params.push(`%${escapeLikePattern(value)}%`)
    const addressParam = `$${params.length}`
    params.push(`%${escapeLikePattern(value)}%`)
    const nameParam = `$${params.length}`
    conditions.push(
      `EXISTS (
        SELECT 1 FROM messages m
        WHERE m.thread_id = threads.id
          AND (m.from_address COLLATE NOCASE LIKE ${addressParam} ESCAPE '\\'
            OR m.from_name COLLATE NOCASE LIKE ${nameParam} ESCAPE '\\')
      )`
    )
  }

  // 2. to: — substring over the serialized recipient arrays.
  for (const value of parsed.to) {
    const likes = ["m.to_json", "m.cc_json", "m.bcc_json"].map((column) => {
      params.push(`%${escapeLikePattern(value)}%`)
      return `${column} COLLATE NOCASE LIKE $${params.length} ESCAPE '\\'`
    })
    conditions.push(
      `EXISTS (
        SELECT 1 FROM messages m
        WHERE m.thread_id = threads.id AND (${likes.join(" OR ")})
      )`
    )
  }

  // 3. subject:
  for (const value of parsed.subject) {
    params.push(`%${escapeLikePattern(value)}%`)
    conditions.push(
      `EXISTS (
        SELECT 1 FROM messages m
        WHERE m.thread_id = threads.id
          AND m.subject COLLATE NOCASE LIKE $${params.length} ESCAPE '\\'
      )`
    )
  }

  // 4–6. Flag operators over the thread cache columns.
  if (parsed.hasAttachment) conditions.push("threads.has_attachments = 1")
  if (parsed.isUnread) conditions.push("threads.unread_count > 0")
  if (parsed.isStarred) conditions.push("threads.is_starred = 1")

  // 7. label: — exact name or trailing "/segment", account-scoped.
  for (const name of parsed.labels) {
    params.push(name)
    const exactParam = `$${params.length}`
    params.push(`%/${escapeLikePattern(name)}`)
    const suffixParam = `$${params.length}`
    conditions.push(
      `EXISTS (
        SELECT 1 FROM thread_labels tl
        JOIN labels l ON l.id = tl.label_id
        WHERE tl.thread_id = threads.id
          AND tl.account_id = threads.account_id
          AND (l.name = ${exactParam} COLLATE NOCASE
            OR l.name COLLATE NOCASE LIKE ${suffixParam} ESCAPE '\\')
      )`
    )
  }

  // 8. Free text — one EXISTS; a single message must match every term.
  const longTerms = parsed.freeText.filter((term) => term.length >= 3)
  const shortTerms = parsed.freeText.filter((term) => term.length < 3)
  if (longTerms.length || shortTerms.length) {
    const termConditions: string[] = []
    if (longTerms.length) {
      params.push(toFtsMatch(longTerms))
      termConditions.push(
        `m.rowid IN (
          SELECT rowid FROM messages_fts WHERE messages_fts MATCH $${params.length}
        )`
      )
    }
    for (const term of shortTerms) {
      // one bound parameter per occurrence — repeated $N tokens would need
      // multiple binds under positional drivers (see executor.ts)
      const likes = SHORT_TERM_LIKE_COLUMNS.map((column) => {
        params.push(`%${escapeLikePattern(term)}%`)
        return `${column} LIKE $${params.length} ESCAPE '\\'`
      })
      termConditions.push(`(${likes.join(" OR ")})`)
    }
    conditions.push(
      `EXISTS (
        SELECT 1 FROM messages m
        JOIN messages_fts ON messages_fts.rowid = m.rowid
        WHERE m.thread_id = threads.id AND ${termConditions.join(" AND ")}
      )`
    )
  }

  const limitClause = options?.limit ? ` LIMIT $${params.length + 1}` : ""
  if (options?.limit) params.push(options.limit)

  return {
    sql: [
      "SELECT threads.* FROM threads",
      `WHERE threads.account_id = $1 AND ${conditions.join(" AND ")}`,
      "ORDER BY threads.last_message_at DESC" + limitClause,
    ].join(" "),
    params,
  }
}
