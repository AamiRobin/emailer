import type { SqlExecutor } from "./executor"

/**
 * Per-folder unread counts for the sidebar (task 6.3): the sum of
 * threads.unread_count (the denormalized cache kept by
 * recomputeThreadCaches) over each folder's membership predicate.
 *
 * The predicates mirror listThreadsByFolder (threads.ts) exactly so a
 * badge always matches the thread list its folder navigates to:
 * - inbox   → membership in the account's inbox-role label(s) via
 *             thread_labels OR threads.folder_label_id, excluding
 *             trashed/spam threads (the "inbox" preset)
 * - sent    → membership in sent-role label(s) (pure membership, like the
 *             "specialUse" selector — no trash/spam exclusion)
 * - drafts  → membership in drafts-role label(s) (same)
 * - starred → is_starred = 1 AND is_trashed = 0 AND is_spam = 0
 * - archive → is_archived = 1 AND is_trashed = 0 AND is_spam = 0
 * - spam    → is_spam = 1
 * - trash   → is_trashed = 1
 *
 * "starred"/"archive"/"spam"/"trash" are the flag-cache presets from
 * threads.ts rather than RFC 6154 roles; they are kept under one result
 * shape because the sidebar renders them as one folder list. The role
 * names interpolated into the SQL below come from the fixed literal set
 * in ROLE_KEYS (never user input), so interpolation is injection-safe.
 *
 * One conditional-aggregate query computes all seven counts in a single
 * pass over the account's threads. Like the rest of the query layer, this
 * runs against the injectable SqlExecutor (node:sqlite under vitest).
 */

export interface FolderUnreadCounts {
  inbox: number
  starred: number
  sent: number
  drafts: number
  archive: number
  spam: number
  trash: number
}

/** The seven sidebar folders, in display order. */
export const FOLDER_COUNT_KEYS = [
  "inbox",
  "starred",
  "sent",
  "drafts",
  "archive",
  "spam",
  "trash",
] as const

export type FolderCountKey = (typeof FOLDER_COUNT_KEYS)[number]

export const EMPTY_FOLDER_COUNTS: FolderUnreadCounts = {
  inbox: 0,
  starred: 0,
  sent: 0,
  drafts: 0,
  archive: 0,
  spam: 0,
  trash: 0,
}

/**
 * Membership predicate for a special-use role, matching either account
 * model: gmail threads via thread_labels rows, imap threads via the
 * threads.folder_label_id cache. The role label must belong to the
 * thread's account (the FK does not enforce that; threads.ts resolves
 * role labels per account the same way).
 */
function roleMembershipPredicate(role: string): string {
  return `(
    EXISTS (
      SELECT 1 FROM thread_labels tl
      JOIN labels rl ON rl.id = tl.label_id
      WHERE tl.thread_id = threads.id
        AND rl.account_id = threads.account_id
        AND rl.special_use = '${role}'
    )
    OR EXISTS (
      SELECT 1 FROM labels fl
      WHERE fl.id = threads.folder_label_id
        AND fl.account_id = threads.account_id
        AND fl.special_use = '${role}'
    )
  )`
}

/** Flag-cache predicates, copied verbatim from threads.ts PRESET_PREDICATES. */
const FLAG_PREDICATES: Record<
  "starred" | "archive" | "spam" | "trash",
  string
> = {
  starred:
    "threads.is_starred = 1 AND threads.is_trashed = 0 AND threads.is_spam = 0",
  archive:
    "threads.is_archived = 1 AND threads.is_trashed = 0 AND threads.is_spam = 0",
  spam: "threads.is_spam = 1",
  trash: "threads.is_trashed = 1",
}

const COUNTED_PREDICATES: Record<FolderCountKey, string> = {
  inbox: `threads.is_trashed = 0 AND threads.is_spam = 0 AND ${roleMembershipPredicate("inbox")}`,
  starred: FLAG_PREDICATES.starred,
  sent: roleMembershipPredicate("sent"),
  drafts: roleMembershipPredicate("drafts"),
  archive: FLAG_PREDICATES.archive,
  spam: FLAG_PREDICATES.spam,
  trash: FLAG_PREDICATES.trash,
}

/**
 * Unread counts for all sidebar folders of one account, in a single GROUP
 * BY-free pass (aggregates over the account's threads with CASE columns).
 * Returns zeros when the account has no threads.
 */
export async function unreadCountBySpecialUse(
  executor: SqlExecutor,
  accountId: string
): Promise<FolderUnreadCounts> {
  const columns = FOLDER_COUNT_KEYS.map(
    (key) =>
      `COALESCE(SUM(CASE WHEN ${COUNTED_PREDICATES[key]} THEN threads.unread_count ELSE 0 END), 0) AS ${key}`
  )
  const rows = await executor.select<FolderUnreadCounts>(
    `SELECT ${columns.join(", ")} FROM threads WHERE threads.account_id = $1`,
    [accountId]
  )
  return { ...EMPTY_FOLDER_COUNTS, ...rows[0] }
}

/**
 * Unread count for a single label (sidebar label badges, task 6.4+).
 * Same dual membership model as listThreadsByFolder's "labelId" selector.
 */
export async function unreadCountByLabel(
  executor: SqlExecutor,
  accountId: string,
  labelId: string
): Promise<number> {
  const rows = await executor.select<{ unread: number }>(
    `SELECT COALESCE(SUM(threads.unread_count), 0) AS unread FROM threads
     WHERE threads.account_id = $1
       AND (threads.folder_label_id = $2 OR EXISTS (
         SELECT 1 FROM thread_labels tl
         WHERE tl.thread_id = threads.id AND tl.label_id = $3
       ))`,
    [accountId, labelId, labelId]
  )
  return rows[0]?.unread ?? 0
}
