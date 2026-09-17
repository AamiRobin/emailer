/**
 * Thread-list sort options (competitor-parity task 4.1): the closed set of
 * list orderings shared by listThreadsByFolder (db/threads.ts) and the
 * search query builder (services/search). Lives in its own import-free
 * module so the pure SQL builders can use it without pulling the executor
 * layer in, and so the store and the settings accessor can share the type.
 *
 * The option is a closed union mapped to FIXED SQL fragments — user input
 * never reaches these strings (see threadSortOrderClause).
 */

export type ThreadSortOption =
  "date_desc" | "date_asc" | "sender" | "subject" | "unread_first"

export const DEFAULT_THREAD_SORT: ThreadSortOption = "date_desc"

export const THREAD_SORT_OPTIONS: readonly ThreadSortOption[] = [
  "date_desc",
  "date_asc",
  "sender",
  "subject",
  "unread_first",
]

/** Runtime guard for values read back from the settings table. */
export function isThreadSortOption(value: unknown): value is ThreadSortOption {
  return (
    typeof value === "string" &&
    (THREAD_SORT_OPTIONS as readonly string[]).includes(value)
  )
}

/**
 * Sender sort key: the newest message's cached sender name (threads.
 * participants[0].name — the list display cache), falling back to the
 * address when the name is missing/empty, and to "last" when the thread
 * has no cached sender at all. NOCASE keeps it A→Z case-insensitively.
 *
 * The extracts are guarded by json_valid: `json_extract` raises
 * "malformed JSON" on a corrupt cache row, which would fail the ENTIRE
 * inbox/search query over one bad thread. The CASE short-circuits to NULL
 * (→ NULLS LAST, the same group as sender-less threads) instead; the
 * COALESCE/NULLIF semantics are unchanged for valid rows.
 */
const SENDER_TERM =
  "CASE WHEN threads.participants IS NOT NULL AND json_valid(threads.participants) THEN " +
  "COALESCE(NULLIF(json_extract(threads.participants, '$[0].name'), ''), " +
  "json_extract(threads.participants, '$[0].email')) END " +
  "COLLATE NOCASE ASC NULLS LAST"

/**
 * The full ORDER BY for a thread-list query: the pinned-first term ALWAYS
 * leads (mail-organization spec — a pinned thread tops its view under
 * every sort), then the option's own term, then the date term as the
 * stability fallback for the non-date sorts, and `threads.id ASC` last so
 * every option ends with a total, deterministic order.
 *
 * `inboxDateTerm`: the inbox orders its date term by
 * COALESCE(delivered_at, last_message_at) — delivered_at is stamped when a
 * snooze wakes or a delivery hold releases, so woken threads reappear
 * first within their pinned group (email-actions/snooze.ts). Every other
 * list — search included — uses plain last_message_at.
 */
export function threadSortOrderClause(
  sort: ThreadSortOption,
  options: { inboxDateTerm?: boolean } = {}
): string {
  const dateTerm = options.inboxDateTerm
    ? "COALESCE(threads.delivered_at, threads.last_message_at)"
    : "threads.last_message_at"
  let terms: string
  switch (sort) {
    case "date_asc":
      terms = `${dateTerm} ASC`
      break
    case "sender":
      terms = `${SENDER_TERM}, ${dateTerm} DESC`
      break
    case "subject":
      terms = `threads.subject COLLATE NOCASE ASC NULLS LAST, ${dateTerm} DESC`
      break
    case "unread_first":
      terms = `(threads.unread_count > 0) DESC, ${dateTerm} DESC`
      break
    case "date_desc":
      terms = `${dateTerm} DESC`
      break
  }
  return `(threads.pinned_at IS NOT NULL) DESC, ${terms}, threads.id ASC`
}
