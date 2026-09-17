import type { SqlExecutor } from "./executor"
import type { ThreadSortOption } from "./thread-sort"
import { threadSortOrderClause } from "./thread-sort"
import type { ThreadRow } from "./threads"

/**
 * Nudges (task 14.1, design D8): "nudges are a QUERY — no stored state".
 * One SQL selection over threads + their newest message finds every
 * conversation the user may have forgotten to answer; the Nudges view and
 * the sidebar marker both read it, so there is nothing to maintain, and
 * the detection rewinds itself the moment a reply lands.
 *
 * Detection semantics (mail-organization spec "Nudges" — "the latest
 * message requires a reply from the user (message addressed to or
 * mentioning the user, no subsequent reply from the user, older than a
 * configurable threshold)"):
 *
 * 1. LATEST MESSAGE IS NOT THE USER'S — the newest message (same newest
 *    tiebreak as recomputeThreadCaches: date DESC, rowid DESC) is not from
 *    the thread's account address. A thread whose newest message is the
 *    user's own is already answered (the "no subsequent reply from the
 *    user" clause) — a follow-up THERE is the followup_reminders feature
 *    (task 14.2), not a nudge.
 * 2. ADDRESSED TO OR MENTIONING THE USER — the newest message's To/Cc
 *    contact JSON contains the account address (serialized by
 *    serializeContacts as `"email":"…"`, so a delimited LIKE match is
 *    exact), or its snippet/body text mentions the address as a substring
 *    (the pragmatic "mentioning" reading — a quoted or inline address
 *    counts; case-insensitive, wildcards escaped).
 * 3. OLDER THAN THE THRESHOLD — `threads.last_message_at < now -
 *    thresholdDays * 86400`, strictly older ("older than a configurable
 *    threshold"); the threshold comes from `mail.nudgeDays`
 *    (settings/preferences.ts, default 3, clamped 1–30).
 * 4. NOT IN A DELIBERATE STATE — snoozed/muted/Done/held threads are
 *    excluded (the user or a feature made an explicit placement decision;
 *    nudges must not fight it — the same conservative set auto-archive
 *    skips), and so are trashed/spam. ARCHIVED threads still nudge: an
 *    awaiting-reply conversation is not answered by having been archived,
 *    and the spec puts no folder restriction on detection. Pinned threads
 *    are included too (a pin is ordering, not dispatch) and sort first.
 *
 * The "direct question" signal (the spec's forgotten-question scenario) is
 * a ranking, not a filter: a "?" in the newest message's snippet/body
 * flags the row (`has_question`) and question threads sort above the rest
 * — everything that matches 1–4 IS a nudge, with or without a question.
 *
 * Resurfacing semantics mirror the inbox: nudges are listed (and counted)
 * with the shared delivered_at COALESCE ordering, so a thread resurfaced
 * by a follow-up reminder or a snooze wake keeps its place.
 *
 * "Own address" is the thread's ACCOUNT email for now — aliases (task 16,
 * design D10) will widen it, exactly as rules/ingestion.ts documents for
 * sender stats.
 */

/** A nudge row: the thread plus the detection extras the view/count use. */
export interface NudgeRow extends ThreadRow {
  /** The thread's account address — the row's "own address" (display +
   * tests; the matching itself happened in SQL against it). */
  account_email: string
  /** 1 when the newest message's snippet/body contains a "?" (the spec's
   * forgotten-question signal — ranked first), else 0. */
  has_question: number
}

export interface NudgeQueryOptions {
  /** Restrict to these accounts; null/empty = every account (the callers
   * pass the ACTIVE account ids, guarding the empty set themselves). */
  accountIds?: string[] | null
  /** "Now" in unix epoch seconds; defaults to the current clock. Tests
   * pin it. */
  now?: number
  /** The age threshold in days (the `mail.nudgeDays` preference value).
   * Required — callers read the preference; the service never guesses. */
  thresholdDays: number
  /** Trailing sort after the has-question lead (default date_desc, same
   * closed set as the other lists — the view's sort picker feeds this). */
  sort?: ThreadSortOption
}

/**
 * lower(a.email) with the LIKE wildcards escaped, for `%…%` patterns that
 * use `ESCAPE '\'` — computed in SQL against the joined accounts row so
 * one statement serves every account (each thread matches its OWN
 * account's address, even in the across-accounts query).
 */
const ESCAPED_ACCOUNT_EMAIL =
  "replace(replace(replace(lower(a.email), '\\', '\\\\'), '%', '\\%'), '_', '\\_')"

/** "To or Cc names the account address" OR "the snippet/body mentions
 * it" — spec clause 2. The contact-JSON patterns key on the exact
 * `"email":"<address>"` spelling serializeContacts writes. */
const ADDRESSED_OR_MENTIONED =
  `(lower(COALESCE(m.to_json, '')) LIKE '%"email":"' || ${ESCAPED_ACCOUNT_EMAIL} || '"%' ESCAPE '\\'` +
  ` OR lower(COALESCE(m.cc_json, '')) LIKE '%"email":"' || ${ESCAPED_ACCOUNT_EMAIL} || '"%' ESCAPE '\\'` +
  ` OR lower(COALESCE(m.snippet, '')) LIKE '%' || ${ESCAPED_ACCOUNT_EMAIL} || '%' ESCAPE '\\'` +
  ` OR lower(COALESCE(m.body_text, '')) LIKE '%' || ${ESCAPED_ACCOUNT_EMAIL} || '%' ESCAPE '\\')`

/** The "direct question" flag expression (spec clause ranking): a "?" in
 * the newest message's snippet or body text. */
const HAS_QUESTION =
  "(CASE WHEN COALESCE(m.snippet, '') LIKE '%?%'" +
  " OR COALESCE(m.body_text, '') LIKE '%?%' THEN 1 ELSE 0 END)"

/**
 * The shared selection: threads joined to their newest message, filtered
 * by the four detection clauses. Params ascend by occurrence: $1 = the
 * age cutoff, then the optional account ids.
 */
function buildNudgeQuery(
  params: unknown[],
  accountIds: string[] | null
): string {
  const where: string[] = [
    "threads.is_trashed = 0",
    "threads.is_spam = 0",
    "threads.snoozed_until IS NULL",
    "threads.muted_at IS NULL",
    "threads.done_at IS NULL",
    "threads.held_until IS NULL",
    "threads.last_message_at IS NOT NULL",
    // Clause 3: strictly older than the threshold (cutoff = now - days).
    "threads.last_message_at < $1",
    // Clause 1: the newest message is not the user's own ("already
    // replied"); NULL senders cannot be the user's, so they stay eligible.
    "(m.from_address IS NULL OR lower(m.from_address) <> lower(a.email))",
    // Clause 2: addressed to or mentioning the user.
    ADDRESSED_OR_MENTIONED,
  ]
  if (accountIds !== null && accountIds.length > 0) {
    where.push(
      `threads.account_id IN (${Array.from(
        { length: accountIds.length },
        (_, index) => `$${index + 2}`
      ).join(", ")})`
    )
    params.push(...accountIds)
  }
  return `FROM threads
     JOIN accounts a ON a.id = threads.account_id
     JOIN messages m ON m.id = (
       SELECT latest.id FROM messages latest
       WHERE latest.thread_id = threads.id
       ORDER BY latest.date DESC, latest.rowid DESC
       LIMIT 1
     )
     WHERE ${where.join(" AND ")}`
}

/**
 * The Nudges view's rows: every detected thread, question-mark threads
 * first, then the caller's sort (pinned-first lead included, like every
 * list). Rows carry `threads.*` plus `account_email`/`has_question`.
 */
export async function listNudges(
  executor: SqlExecutor,
  options: NudgeQueryOptions
): Promise<NudgeRow[]> {
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const cutoff = now - options.thresholdDays * 24 * 60 * 60
  const params: unknown[] = [cutoff]
  const fromWhere = buildNudgeQuery(params, options.accountIds ?? null)
  return executor.select<NudgeRow>(
    `SELECT threads.*, a.email AS account_email, ${HAS_QUESTION} AS has_question
     ${fromWhere}
     ORDER BY has_question DESC, ${threadSortOrderClause(options.sort ?? "date_desc", { inboxDateTerm: true })}`,
    params
  )
}

/**
 * The sidebar marker's count: the same detection as listNudges, counted.
 * Refreshed by the sidebar on mount, account switches and thread-list
 * reloads (the same liveness trick the split-tab counts use).
 */
export async function countNudges(
  executor: SqlExecutor,
  options: NudgeQueryOptions
): Promise<number> {
  const now = options.now ?? Math.floor(Date.now() / 1000)
  const cutoff = now - options.thresholdDays * 24 * 60 * 60
  const params: unknown[] = [cutoff]
  const fromWhere = buildNudgeQuery(params, options.accountIds ?? null)
  const rows = await executor.select<{ count: number }>(
    `SELECT COUNT(*) AS count ${fromWhere}`,
    params
  )
  return rows[0]?.count ?? 0
}
