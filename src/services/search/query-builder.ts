import {
  accentGlob,
  escapeLikePattern,
  foldText,
  toFtsMatch,
} from "./fts"
import type { ParsedQuery } from "./parser"
import type { ThreadSortOption } from "../db/thread-sort"
import { DEFAULT_THREAD_SORT, threadSortOrderClause } from "../db/thread-sort"

/**
 * Builds the SQL for a Gmail-style thread search from a ParsedQuery, over
 * ONE account or a SET of accounts (task 9.1, design D4: the unified /
 * split / saved-search scopes run the same search minus the account
 * filter — the account restriction is `threads.account_id = $1` for a
 * single id and `threads.account_id IN ($1…$n)` for a set; an empty set
 * renders a no-match predicate). Pure string/array construction — no I/O,
 * and user input is always bound through `$N` parameters, never
 * interpolated.
 *
 * Shape: one SELECT over `threads`, restricted to
 * - the account set (`threads.account_id = ?` / `IN (?…)`), and
 * - the mailbox (`is_trashed = 0 AND is_spam = 0`): like Gmail, search
 *   covers mail the user can act on; trashed/spammed threads are surfaced
 *   by their own folders (threads.ts presets), not search results.
 *
 * Predicates, all AND-ed, appended in this fixed order (which fixes the
 * ascending `$N` parameter order — see executor.ts). Every positive
 * operator is followed by its negated counterpart in the same shape — the
 * De Morgan mirror: "some message in the thread matches" becomes "NO
 * message in the thread matches" (and a negated flag compares the cache
 * column to 0):
 * 1. `from:` → EXISTS over the thread's messages matching from_address OR
 *    from_name (COLLATE NOCASE LIKE). Operators accept "any message in the
 *    thread" as evidence; free text (below) keeps the stricter
 *    single-message semantics of the original search.ts. `-from:` → NOT
 *    EXISTS over the same shape.
 * 2. `to:` → EXISTS matching to_json / cc_json / bcc_json — addresses are
 *    stored as JSON arrays of `{name?, email}`, so a plain substring LIKE
 *    over the serialized arrays covers both names and addresses. `-to:` →
 *    NOT EXISTS.
 * 3. `subject:` → EXISTS matching messages.subject; `-subject:` → NOT
 *    EXISTS. All operator values use LIKE (case-insensitive for ASCII in
 *    SQLite, made explicit with COLLATE NOCASE on the left operand) —
 *    predictable substring semantics; only free text uses the FTS index,
 *    whose trigram tokenizer needs ≥3-char terms anyway.
 * 4. `has:attachment` → `threads.has_attachments = 1`; `-has:attachment`
 *    → `= 0`.
 * 5. `is:unread` → `threads.unread_count > 0`; `-is:unread` → `= 0`.
 * 6. `is:starred` → `threads.is_starred = 1`; `-is:starred` → `= 0`.
 * 7. `label:<name>` → EXISTS through thread_labels JOIN labels, scoped to
 *    the account via thread_labels.account_id. A label matches when its
 *    full name equals the value case-insensitively OR ends with
 *    "/<value>" (case-insensitive): `label:receipts` matches a label named
 *    "receipts" (the spec scenario) and addresses the leaf of
 *    "Finance/receipts" without the full path. `-label:` → NOT EXISTS.
 * 8. `larger:<N>` / `smaller:<N>` → EXISTS over messages whose
 *    size_estimate compares against the parsed byte threshold (NULL never
 *    compares, so unsized messages satisfy neither operator).
 *    `-larger:` / `-smaller:` → NOT EXISTS over the same comparison — an
 *    unsized message can never appear inside, so it passes a negated size
 *    bound.
 * 9. `before:<date>` / `after:<date>` → EXISTS over messages dated
 *    against the UTC-midnight boundary (before: exclusive `<`, after:
 *    inclusive `>=`) — the pair tiles time without gaps. `-before:` /
 *    `-after:` → NOT EXISTS over the same boundary comparison.
 * 10. Free text → a single EXISTS over messages: positive terms are
 *    accent-FOLDED (fts.ts foldText — NFD diacritic-strip, task 1.3) and
 *    then split by length; folded terms of ≥3 chars go through the
 *    external-content messages_fts trigram index (combined into one quoted
 *    MATCH string, so ONE message must match ALL terms — same semantics as
 *    the original search.ts — or ANY term with `freeTextMatch: "any"`, the
 *    relaxed fallback's OR mode), terms shorter than 3 chars can never
 *    produce a trigram token, so each falls back to a LIKE scan over the
 *    same columns the FTS index covers (subject, from_name, from_address,
 *    to_json, body_text, snippet), bridged across accents by accentGlob.
 *    The index itself folds too — migration
 *    v13 rebuilds messages_fts with the `remove_diacritics 1` trigram
 *    tokenizer — so unaccented queries match accented text ("be don dep"
 *    finds "Bé Dọn Dẹp") and vice versa. Each NEGATED term gets its own
 *    NOT EXISTS (FTS or LIKE by the same length split) — negated terms
 *    never enter the positive MATCH string, so mixed polarity keeps clean
 *    semantics: some message carries every positive term, and no message
 *    carries any negated one.
 *
 * A query of only negations yields a query matching every in-scope thread
 * except the excluded set — callers' empty-query short-circuits key off
 * isEmptyQuery, which counts negations as predicates.
 *
 * Ordering: `(pinned_at IS NOT NULL) DESC` leads every sort, then the
 * requested ThreadSortOption's fixed fragment (task 4.1 — search results
 * are a list scope too), then `threads.id ASC` as the tiebreaker.
 * threadSortOrderClause in db/thread-sort.ts owns the fragments — search
 * uses the non-inbox (plain last_message_at) date term. Muted/Done threads
 * are NOT filtered here: mute/done hide a thread from the inbox and badges
 * only, never from search.
 */

export interface SearchThreadsOptions {
  limit?: number
  /** Trailing sort after the pinned-first lead. Default: date_desc. */
  sort?: ThreadSortOption
  /**
   * Swap the select list for `COUNT(*)` and drop ORDER BY/LIMIT — the
   * total-match count for the EXACT same WHERE clause (rules "apply now",
   * task 11.4, runs its confirmation-gate count through this so the count
   * the user confirms is the count the apply would act on). Ignored
   * predicates stay put; only the projection and the tail change, so the
   * parameter list is identical to the plain build.
   */
  countOnly?: boolean
  /**
   * How the POSITIVE free-text terms combine (task 1.3, design D7):
   * "all" (default) requires ONE message to carry every term; "any" — the
   * relaxed fallback's OR mode — puts a thread in the results when ONE
   * message carries ANY single term. Only the positive terms are loosened:
   * each negated term keeps its own NOT EXISTS under either mode, so a
   * mixed-polarity relaxed query still excludes what it excluded strictly.
   */
  freeTextMatch?: "all" | "any"
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
  accountId: string | string[],
  parsed: ParsedQuery,
  options?: SearchThreadsOptions
): BuiltThreadSearchSql {
  // Account scope: a single id keeps the historical `= $1` shape; a set
  // renders the IN list with the ids bound first (ascending placeholder
  // order — see executor.ts). [] means "match nothing": callers that mean
  // "every account" pass the full id list, never [].
  const accountScope = Array.isArray(accountId)
    ? accountId.length > 0
      ? {
          sql: `threads.account_id IN (${accountId
            .map((_, index) => `$${index + 1}`)
            .join(", ")})`,
          params: accountId,
        }
      : { sql: "1 = 0", params: [] as string[] }
    : { sql: "threads.account_id = $1", params: [accountId] }
  const params: unknown[] = [...accountScope.params]
  const conditions: string[] = [
    accountScope.sql,
    "threads.is_trashed = 0",
    "threads.is_spam = 0",
  ]

  // 1. from: — address OR display name of some message in the thread
  //    (positive: some message matches; negated: no message matches).
  const fromCondition = (value: string, negate: boolean): string => {
    params.push(`%${escapeLikePattern(value)}%`)
    const addressParam = `$${params.length}`
    params.push(`%${escapeLikePattern(value)}%`)
    const nameParam = `$${params.length}`
    const exists = `EXISTS (
      SELECT 1 FROM messages m
      WHERE m.thread_id = threads.id
        AND (m.from_address COLLATE NOCASE LIKE ${addressParam} ESCAPE '\\'
          OR m.from_name COLLATE NOCASE LIKE ${nameParam} ESCAPE '\\')
    )`
    return negate ? `NOT ${exists}` : exists
  }
  for (const value of parsed.from) conditions.push(fromCondition(value, false))
  for (const value of parsed.negatedFrom) {
    conditions.push(fromCondition(value, true))
  }

  // 2. to: — substring over the serialized recipient arrays.
  const toCondition = (value: string, negate: boolean): string => {
    const likes = ["m.to_json", "m.cc_json", "m.bcc_json"].map((column) => {
      params.push(`%${escapeLikePattern(value)}%`)
      return `${column} COLLATE NOCASE LIKE $${params.length} ESCAPE '\\'`
    })
    const exists = `EXISTS (
      SELECT 1 FROM messages m
      WHERE m.thread_id = threads.id AND (${likes.join(" OR ")})
    )`
    return negate ? `NOT ${exists}` : exists
  }
  for (const value of parsed.to) conditions.push(toCondition(value, false))
  for (const value of parsed.negatedTo)
    conditions.push(toCondition(value, true))

  // 3. subject:
  const subjectCondition = (value: string, negate: boolean): string => {
    params.push(`%${escapeLikePattern(value)}%`)
    const exists = `EXISTS (
      SELECT 1 FROM messages m
      WHERE m.thread_id = threads.id
        AND m.subject COLLATE NOCASE LIKE $${params.length} ESCAPE '\\'
    )`
    return negate ? `NOT ${exists}` : exists
  }
  for (const value of parsed.subject) {
    conditions.push(subjectCondition(value, false))
  }
  for (const value of parsed.negatedSubject) {
    conditions.push(subjectCondition(value, true))
  }

  // 4–6. Flag operators over the thread cache columns (negated: the column
  // at 0 — "no message in the thread carries the flag").
  if (parsed.hasAttachment) conditions.push("threads.has_attachments = 1")
  if (parsed.negatedFlags.hasAttachment) {
    conditions.push("threads.has_attachments = 0")
  }
  if (parsed.isUnread) conditions.push("threads.unread_count > 0")
  if (parsed.negatedFlags.isUnread) conditions.push("threads.unread_count = 0")
  if (parsed.isStarred) conditions.push("threads.is_starred = 1")
  if (parsed.negatedFlags.isStarred) conditions.push("threads.is_starred = 0")

  // 7. label: — exact name or trailing "/segment", account-scoped.
  const labelCondition = (name: string, negate: boolean): string => {
    params.push(name)
    const exactParam = `$${params.length}`
    params.push(`%/${escapeLikePattern(name)}`)
    const suffixParam = `$${params.length}`
    const exists = `EXISTS (
      SELECT 1 FROM thread_labels tl
      JOIN labels l ON l.id = tl.label_id
      WHERE tl.thread_id = threads.id
        AND tl.account_id = threads.account_id
        AND (l.name = ${exactParam} COLLATE NOCASE
          OR l.name COLLATE NOCASE LIKE ${suffixParam} ESCAPE '\\')
    )`
    return negate ? `NOT ${exists}` : exists
  }
  for (const name of parsed.labels) conditions.push(labelCondition(name, false))
  for (const name of parsed.negatedLabels) {
    conditions.push(labelCondition(name, true))
  }

  // 8. larger:/smaller: — some message sized past the threshold; NULL
  // size_estimate never compares, so unsized messages satisfy neither.
  for (const bytes of parsed.larger) {
    params.push(bytes)
    conditions.push(
      `EXISTS (
        SELECT 1 FROM messages m
        WHERE m.thread_id = threads.id AND m.size_estimate > $${params.length}
      )`
    )
  }
  for (const bytes of parsed.smaller) {
    params.push(bytes)
    conditions.push(
      `EXISTS (
        SELECT 1 FROM messages m
        WHERE m.thread_id = threads.id AND m.size_estimate < $${params.length}
      )`
    )
  }
  // Negated mirrors: NOT EXISTS over the same comparisons — an unsized
  // message never appears inside, so it passes a negated size bound (there
  // is no size to exclude it on).
  for (const bytes of parsed.negatedLarger) {
    params.push(bytes)
    conditions.push(
      `NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m.thread_id = threads.id AND m.size_estimate > $${params.length}
      )`
    )
  }
  for (const bytes of parsed.negatedSmaller) {
    params.push(bytes)
    conditions.push(
      `NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m.thread_id = threads.id AND m.size_estimate < $${params.length}
      )`
    )
  }

  // 9. before:/after: — some message dated against the UTC-midnight
  // boundary; before: is exclusive, after: inclusive.
  for (const seconds of parsed.before) {
    params.push(seconds)
    conditions.push(
      `EXISTS (
        SELECT 1 FROM messages m
        WHERE m.thread_id = threads.id AND m.date < $${params.length}
      )`
    )
  }
  for (const seconds of parsed.after) {
    params.push(seconds)
    conditions.push(
      `EXISTS (
        SELECT 1 FROM messages m
        WHERE m.thread_id = threads.id AND m.date >= $${params.length}
      )`
    )
  }
  for (const seconds of parsed.negatedBefore) {
    params.push(seconds)
    conditions.push(
      `NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m.thread_id = threads.id AND m.date < $${params.length}
      )`
    )
  }
  for (const seconds of parsed.negatedAfter) {
    params.push(seconds)
    conditions.push(
      `NOT EXISTS (
        SELECT 1 FROM messages m
        WHERE m.thread_id = threads.id AND m.date >= $${params.length}
      )`
    )
  }

  // 10. Free text — positive terms in ONE EXISTS (a single message must
  // match every term, or any single term in the relaxed "any" mode); each
  // negated term gets its own NOT EXISTS so a mixed-polarity query never
  // forces one message to carry both. Terms are FOLDED first (task 1.3,
  // design D7) — the FTS index is written by the v13 tokenizer
  // (`remove_diacritics 1`), which strips the same diacritics from the
  // indexed text, so folded queries match accented content. Folding runs
  // BEFORE the length split: a term that only sheds its marks ("dé" →
  // "de") must fall to the LIKE scan a 2-char term belongs to, never into
  // a trigram MATCH it can never satisfy. Sub-trigram terms run a GLOB
  // over the RAW stored columns through accentGlob — one bracket class per
  // character carrying every precomposed spelling that folds back to it —
  // because SQLite has no way to fold a stored column in SQL; exact text
  // always matches. The operator comparisons
  // (from:/to:/subject:) deliberately keep exact-text LIKE semantics —
  // they are filters on identifiers, not scored text, and label: MUST
  // stay exact.
  const anyMode = options?.freeTextMatch === "any"
  const foldedFreeText = parsed.freeText.map(foldText)
  const longTerms = foldedFreeText.filter((term) => term.length >= 3)
  const shortTerms = foldedFreeText.filter((term) => term.length < 3)
  if (longTerms.length || shortTerms.length) {
    const termConditions: string[] = []
    if (longTerms.length) {
      params.push(toFtsMatch(longTerms, anyMode ? "or" : "and"))
      termConditions.push(
        `m.rowid IN (
          SELECT rowid FROM messages_fts WHERE messages_fts MATCH $${params.length}
        )`
      )
    }
    for (const term of shortTerms) {
      // Sub-trigram scan, accent-bridged (see accentGlob): one GLOB per
      // column whose bracket classes carry every precomposed spelling that
      // folds back to the term, so the folded query still meets raw stored
      // text ("be" finds "Bé"). GLOB has no ESCAPE — terms with GLOB
      // metacharacters fall back to the plain escaped LIKE. Either way,
      // one bound parameter per occurrence — repeated $N tokens would need
      // multiple binds under positional drivers (see executor.ts)
      const glob = accentGlob(term)
      if (glob !== null) {
        const globs = SHORT_TERM_LIKE_COLUMNS.map((column) => {
          params.push(glob)
          return `${column} GLOB $${params.length}`
        })
        termConditions.push(`(${globs.join(" OR ")})`)
      } else {
        const likes = SHORT_TERM_LIKE_COLUMNS.map((column) => {
          params.push(`%${escapeLikePattern(term)}%`)
          return `${column} LIKE $${params.length} ESCAPE '\\'`
        })
        termConditions.push(`(${likes.join(" OR ")})`)
      }
    }
    conditions.push(
      `EXISTS (
        SELECT 1 FROM messages m
        JOIN messages_fts ON messages_fts.rowid = m.rowid
        WHERE m.thread_id = threads.id AND ${termConditions.join(anyMode ? " OR " : " AND ")}
      )`
    )
  }
  for (const rawTerm of parsed.negatedFreeText) {
    // Negated terms fold too — the same index the positive side matches.
    const term = foldText(rawTerm)
    if (term.length >= 3) {
      params.push(toFtsMatch([term]))
      conditions.push(
        `NOT EXISTS (
          SELECT 1 FROM messages m
          WHERE m.thread_id = threads.id AND m.rowid IN (
            SELECT rowid FROM messages_fts WHERE messages_fts MATCH $${params.length}
          )
        )`
      )
    } else {
      const glob = accentGlob(term)
      if (glob !== null) {
        const globs = SHORT_TERM_LIKE_COLUMNS.map((column) => {
          params.push(glob)
          return `${column} GLOB $${params.length}`
        })
        conditions.push(
          `NOT EXISTS (
            SELECT 1 FROM messages m
            WHERE m.thread_id = threads.id AND (${globs.join(" OR ")})
          )`
        )
      } else {
        const likes = SHORT_TERM_LIKE_COLUMNS.map((column) => {
          params.push(`%${escapeLikePattern(term)}%`)
          return `${column} LIKE $${params.length} ESCAPE '\\'`
        })
        conditions.push(
          `NOT EXISTS (
            SELECT 1 FROM messages m
            WHERE m.thread_id = threads.id AND (${likes.join(" OR ")})
          )`
        )
      }
    }
  }

  const counting = options?.countOnly === true
  const limitClause =
    !counting && options?.limit ? ` LIMIT $${params.length + 1}` : ""
  if (!counting && options?.limit) params.push(options.limit)

  return {
    sql: [
      counting
        ? // The count variant: same WHERE, aggregate projection, no tail —
          // the count is the total, not a page.
          "SELECT COUNT(*) AS count FROM threads"
        : "SELECT threads.* FROM threads",
      `WHERE ${conditions.join(" AND ")}`,
      // Pinned-first leads every sort (mail-organization spec: pinned
      // threads stay on top — search results are a list too); the trailing
      // fragment comes from the closed sort set (task 4.1). Muted/Done
      // mail deliberately stays searchable; only the ordering gains a term.
      // (Dropped for countOnly — ordering cannot change a COUNT.)
      ...(counting
        ? []
        : [
            "ORDER BY " +
              threadSortOrderClause(options?.sort ?? DEFAULT_THREAD_SORT) +
              limitClause,
          ]),
    ].join(" "),
    params,
  }
}
