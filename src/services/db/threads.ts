import type { SqlExecutor } from "./executor"
import { placeholders } from "./executor"
import type { Category } from "../categorization/classify"
import { parseCategory } from "../categorization/classify"
import type { SpecialUse } from "./labels"
import type { ContactRef, MessageRow } from "./messages"
import { parseContacts } from "./messages"
import type { ThreadSortOption } from "./thread-sort"
import { threadSortOrderClause } from "./thread-sort"

export interface ThreadInput {
  id: string
  accountId: string
  subject?: string
  snippet?: string
  /** gmail account: server thread id, unique per account (partial unique index) */
  gmailThreadId?: string
  /** imap account: labels.id of the folder this thread currently lives in */
  folderLabelId?: string
  firstMessageAt?: number
  lastMessageAt?: number
}

export interface ThreadRow {
  id: string
  account_id: string
  subject: string | null
  snippet: string | null
  first_message_at: number | null
  last_message_at: number | null
  message_count: number
  unread_count: number
  has_attachments: number
  is_starred: number
  /**
   * JSON array of `{name?, email}` participants of the newest message
   * (its from, plus up to two to-recipients) — the thread-list display
   * cache added in migration v2, maintained by recomputeThreadCaches.
   */
  participants: string | null
  /**
   * Thread-state columns added by migration v3 (D1/D6): snooze wake-up
   * time, mute/pin/done markers, the local-only note, and the delivery
   * hold/release pair. NULL means the state is inactive. Optional in the
   * type because hand-built rows (tests) may predate the columns; rows
   * read from the database always carry them.
   */
  snoozed_until?: number | null
  muted_at?: number | null
  pinned_at?: number | null
  done_at?: number | null
  note?: string | null
  /** Delivery-schedule hold (D6): inbox queries hide the thread until this passes. */
  held_until?: number | null
  /** Set when a hold releases / a snooze wakes, topping the inbox ordering. */
  delivered_at?: number | null
  /**
   * Inbox category (migration v9, task 3.3, design D4): 'primary' |
   * 'updates' | 'promotions' | 'social' | 'newsletters'. NULL means "not
   * yet categorized" — rows that predate the column until the task 3.4
   * backfill runs. New threads INSERT as NULL and are written by the
   * ingestion categorization pass (categorization/ingestion.ts) before
   * notifications; unmatched mail is stored as 'primary', never NULL.
   * The pass never overwrites a non-NULL value, so a per-thread user
   * override (task 3.4) is stable across later arrivals. The tab UI
   * (task 3.5) renders NULL and 'primary' identically in the Primary tab.
   */
  category?: string | null
  gmail_thread_id: string | null
  folder_label_id: string | null
  is_archived: number
  is_trashed: number
  is_spam: number
  created_at: number
}

export async function insertThread(
  executor: SqlExecutor,
  input: ThreadInput
): Promise<void> {
  await executor.execute(
    `INSERT INTO threads (
      id, account_id, subject, snippet, first_message_at, last_message_at,
      gmail_thread_id, folder_label_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.id,
      input.accountId,
      input.subject ?? null,
      input.snippet ?? null,
      input.firstMessageAt ?? null,
      input.lastMessageAt ?? null,
      input.gmailThreadId ?? null,
      input.folderLabelId ?? null,
    ]
  )
}

/**
 * Sync-path insert-or-update for gmail threads, keyed by the
 * (account_id, gmail_thread_id) unique index. Existing threads keep their
 * id and caches; only the subject line is refreshed (the server may have
 * changed it when messages were added). imap threads have no server id —
 * callers always insertThread for those.
 */
export async function upsertThreadByGmailId(
  executor: SqlExecutor,
  input: ThreadInput & { gmailThreadId: string }
): Promise<{ id: string; created: boolean }> {
  const rows = await executor.select<Pick<ThreadRow, "id">>(
    "SELECT id FROM threads WHERE account_id = $1 AND gmail_thread_id = $2",
    [input.accountId, input.gmailThreadId]
  )
  const existing = rows[0]
  if (existing) {
    if (input.subject !== undefined) {
      await executor.execute("UPDATE threads SET subject = $1 WHERE id = $2", [
        input.subject,
        existing.id,
      ])
    }
    return { id: existing.id, created: false }
  }
  await insertThread(executor, input)
  return { id: input.id, created: true }
}

export async function getThread(
  executor: SqlExecutor,
  threadId: string
): Promise<ThreadRow | null> {
  const rows = await executor.select<ThreadRow>(
    "SELECT * FROM threads WHERE id = $1",
    [threadId]
  )
  return rows[0] ?? null
}

/**
 * True when the thread is muted (muted_at set). The sync engines call
 * this as their new-mail notification gate (mail-organization spec: mail
 * landing in a muted thread must not reach the OS notification): a newly
 * inserted message in a muted thread is stored normally but not counted
 * in the engine summary's newMessages, which is what the scheduler
 * forwards to notifyNewMail. The ingestion hook (services/rules/ingestion.ts)
 * consults this as one input to its notification suppression.
 */
export async function isThreadMuted(
  executor: SqlExecutor,
  threadId: string
): Promise<boolean> {
  const rows = await executor.select<Pick<ThreadRow, "id">>(
    "SELECT id FROM threads WHERE id = $1 AND muted_at IS NOT NULL",
    [threadId]
  )
  return rows.length > 0
}

/**
 * Rebuild the denormalized thread caches from the canonical messages rows:
 * message/unread counts, attachment flag, first/last dates, the snippet of
 * the newest message (date DESC, rowid DESC tiebreak), and its participants
 * cache (from + up to two to-recipients, serialized as JSON for the thread
 * list — migration v2). Must run after any message insert/update/delete that
 * affects a thread — the sync layer calls it, message helpers do not.
 */
export async function recomputeThreadCaches(
  executor: SqlExecutor,
  threadId: string
): Promise<void> {
  const aggregates = await executor.select<{
    message_count: number
    unread_count: number
    has_attachments: number
    first_message_at: number | null
    last_message_at: number | null
  }>(
    `SELECT
      COUNT(*) AS message_count,
      COALESCE(SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END), 0) AS unread_count,
      COALESCE(MAX(has_attachments), 0) AS has_attachments,
      MIN(date) AS first_message_at,
      MAX(date) AS last_message_at
    FROM messages
    WHERE thread_id = $1`,
    [threadId]
  )
  const newest = await executor.select<{
    snippet: string | null
    from_name: string | null
    from_address: string | null
    to_json: string | null
  }>(
    "SELECT snippet, from_name, from_address, to_json FROM messages WHERE thread_id = $1 ORDER BY date DESC, rowid DESC LIMIT 1",
    [threadId]
  )
  const agg = aggregates[0]
  const latest = newest[0]
  // placeholder numbers ascend by occurrence in the SQL text (see executor.ts)
  await executor.execute(
    `UPDATE threads SET
      message_count = $1,
      unread_count = $2,
      has_attachments = $3,
      first_message_at = $4,
      last_message_at = $5,
      snippet = $6,
      participants = $7
    WHERE id = $8`,
    [
      agg?.message_count ?? 0,
      agg?.unread_count ?? 0,
      agg?.has_attachments ?? 0,
      agg?.first_message_at ?? null,
      agg?.last_message_at ?? null,
      latest?.snippet ?? null,
      buildParticipantsCache(latest),
      threadId,
    ]
  )
}

/** Max cached to-recipients besides the sender (keeps the JSON small). */
const PARTICIPANT_TO_LIMIT = 2

/**
 * Serialize the newest message's participants for the list: the from
 * contact first, then up to two unique to-recipients. Empty/anonymous
 * addresses are dropped; a message with no usable contacts caches NULL.
 */
export function buildParticipantsCache(
  message:
    | {
        from_name: string | null
        from_address: string | null
        to_json: string | null
      }
    | null
    | undefined
): string | null {
  if (!message) return null
  const participants: ContactRef[] = []
  if (message.from_address || message.from_name) {
    participants.push({
      email: message.from_address ?? "",
      ...(message.from_name ? { name: message.from_name } : {}),
    })
  }
  for (const to of parseContacts(message.to_json)) {
    if (participants.length >= 1 + PARTICIPANT_TO_LIMIT) break
    if (!to.email) continue
    if (participants.some((p) => p.email === to.email)) continue
    participants.push(to)
  }
  if (!participants.length) return null
  return JSON.stringify(participants)
}

/**
 * Replace the gmail label membership of a thread and rebuild the folder
 * caches from the labels' special-use roles:
 * - is_trashed: any label with role "trash"
 * - is_spam: any label with role "spam"
 * - is_archived: gmail model — absent INBOX role means archived, except
 *   when the thread is trashed or spammed (those flags win so the folder
 *   filters stay disjoint).
 *
 * Intended for gmail accounts where thread_labels is canonical. IMAP
 * accounts should use setThreadFolder instead. Labels must belong to the
 * thread's account (the FK does not enforce that).
 */
export async function setThreadLabels(
  executor: SqlExecutor,
  threadId: string,
  labelIds: string[]
): Promise<void> {
  const threads = await executor.select<Pick<ThreadRow, "account_id">>(
    "SELECT account_id FROM threads WHERE id = $1",
    [threadId]
  )
  const thread = threads[0]
  if (!thread) {
    throw new Error(`setThreadLabels: thread ${threadId} not found`)
  }
  await executor.execute("DELETE FROM thread_labels WHERE thread_id = $1", [
    threadId,
  ])
  for (const labelId of labelIds) {
    await executor.execute(
      "INSERT INTO thread_labels (thread_id, label_id, account_id) VALUES ($1, $2, $3)",
      [threadId, labelId, thread.account_id]
    )
  }
  const specialUses: string[] = []
  if (labelIds.length) {
    const rows = await executor.select<{ special_use: string | null }>(
      `SELECT special_use FROM labels WHERE id IN (${placeholders(
        labelIds.length
      )})`,
      labelIds
    )
    for (const row of rows) {
      if (row.special_use) specialUses.push(row.special_use)
    }
  }
  const isTrashed = specialUses.includes("trash")
  const isSpam = specialUses.includes("spam")
  const isArchived = !specialUses.includes("inbox") && !isTrashed && !isSpam
  await executor.execute(
    "UPDATE threads SET is_archived = $1, is_trashed = $2, is_spam = $3 WHERE id = $4",
    [isArchived ? 1 : 0, isTrashed ? 1 : 0, isSpam ? 1 : 0, threadId]
  )
}

/**
 * IMAP folder moves: point the thread at its new folder label and rebuild
 * the folder caches from that label's special-use role — trash/spam set
 * their flag, the archive role sets is_archived, and everything else
 * (inbox, sent, drafts, plain folders) clears all three: a message filed
 * in a custom folder is not considered archived.
 */
export async function setThreadFolder(
  executor: SqlExecutor,
  threadId: string,
  folderLabelId: string | null
): Promise<void> {
  await executor.execute(
    "UPDATE threads SET folder_label_id = $1 WHERE id = $2",
    [folderLabelId, threadId]
  )
  let isArchived = 0
  let isTrashed = 0
  let isSpam = 0
  if (folderLabelId) {
    const rows = await executor.select<{ special_use: string | null }>(
      "SELECT special_use FROM labels WHERE id = $1",
      [folderLabelId]
    )
    const role = rows[0]?.special_use ?? null
    if (role === "trash") isTrashed = 1
    else if (role === "spam") isSpam = 1
    else if (role === "archive") isArchived = 1
  }
  await executor.execute(
    "UPDATE threads SET is_archived = $1, is_trashed = $2, is_spam = $3 WHERE id = $4",
    [isArchived, isTrashed, isSpam, threadId]
  )
}

export async function setThreadStarred(
  executor: SqlExecutor,
  threadId: string,
  isStarred = true
): Promise<void> {
  await executor.execute("UPDATE threads SET is_starred = $1 WHERE id = $2", [
    isStarred ? 1 : 0,
    threadId,
  ])
}

/**
 * Mailbox folder selectors. "labelId" / "specialUse" resolve through both
 * membership models — gmail threads via thread_labels, imap threads via
 * threads.folder_label_id — so one predicate serves both account types.
 * The specialUse "inbox" composes the SAME exclusions the preset applies
 * (trash/spam plus the inbox-only states below), so the sidebar role list
 * and the preset inbox never disagree; other specialUse roles stay raw
 * folder membership. Presets:
 * - "inbox": canonical membership in the account's inbox-role label(s),
 *   excluding trash and spam. For gmail this equals the is_archived = 0
 *   cache; going through membership also keeps imap threads filed in
 *   custom folders (which leave is_archived = 0) out of the inbox.
 *   Snoozed threads (snoozed_until set) are excluded here and from the
 *   inbox badge, and the inbox orders by COALESCE(delivered_at,
 *   last_message_at) so woken threads return at the top (see
 *   email-actions/snooze.ts). Muted (muted_at), Done (done_at) and
 *   delivery-HELD (held_until — task 12.1, released by the due pass in
 *   email-actions/holds.ts) threads join the same inbox-only exclusions
 *   (see email-actions/thread-states.ts), and every selection orders
 *   pinned-first (pinned_at).
 * - "archive": the is_archived cache (gmail absent-inbox or imap
 *   archive-role folder), excluding trash and spam.
 * - "trash" / "spam": the respective cache flag.
 * - "starred": starred, excluding trash and spam.
 * - "all": everything except trash and spam (Gmail "All Mail" semantics).
 */
export type FolderPreset =
  "inbox" | "archive" | "trash" | "spam" | "starred" | "all"

export type FolderSelection =
  | { kind: "labelId"; labelId: string }
  | { kind: "specialUse"; specialUse: SpecialUse }
  | { kind: "preset"; preset: FolderPreset }

export interface ListThreadsOptions {
  accountId: string
  folder: FolderSelection
  limit?: number
  /** Trailing sort after the pinned-first lead (task 4.1). Default: the
   * historical date-desc order. */
  sort?: ThreadSortOption
}

const PRESET_PREDICATES: Record<Exclude<FolderPreset, "inbox">, string> = {
  archive:
    "threads.is_archived = 1 AND threads.is_trashed = 0 AND threads.is_spam = 0",
  trash: "threads.is_trashed = 1",
  spam: "threads.is_spam = 1",
  starred:
    "threads.is_starred = 1 AND threads.is_trashed = 0 AND threads.is_spam = 0",
  all: "threads.is_trashed = 0 AND threads.is_spam = 0",
}

/** Membership predicate matching threads that carry any of `labelIds`,
 * through either the folder cache column or thread_labels rows. */
function membershipPredicate(params: unknown[], labelIds: string[]): string {
  const first = params.length + 1
  params.push(...labelIds)
  const second = params.length + 1
  params.push(...labelIds)
  const folderList = placeholders(labelIds.length, first)
  const membershipList = placeholders(labelIds.length, second)
  return `(threads.folder_label_id IN (${folderList}) OR EXISTS (
    SELECT 1 FROM thread_labels tl
    WHERE tl.thread_id = threads.id AND tl.label_id IN (${membershipList})
  ))`
}

/**
 * Label ids carrying `specialUse`, restricted to `accountIds` (null/empty
 * = every account). Replaces the per-account findLabelsBySpecialUse lookup
 * so the across-accounts list (task 9.1) resolves one account's inbox-role
 * labels — or the whole set's — in a single query.
 */
async function findSpecialUseLabelIds(
  executor: SqlExecutor,
  specialUse: SpecialUse,
  accountIds: string[] | null
): Promise<string[]> {
  const scoped = accountIds !== null && accountIds.length > 0
  const rows = await executor.select<{ id: string }>(
    scoped
      ? `SELECT id FROM labels WHERE special_use = $1 AND account_id IN (${placeholders(
          accountIds.length,
          2
        )})`
      : "SELECT id FROM labels WHERE special_use = $1",
    scoped ? [specialUse, ...accountIds] : [specialUse]
  )
  return rows.map((row) => row.id)
}

/**
 * The folder-list query builder behind listThreadsByFolder (one account)
 * and listThreadsAcrossAccounts (an account set, or every account) — one
 * predicate implementation so the unified inbox (design D4) is literally
 * the same query minus the account filter.
 *
 * `accountIds`: the account restriction rendered as
 * `threads.account_id IN ($1…$n)`; null or [] = no account filter at all.
 * Returns null when the selection cannot match anything (a specialUse
 * role with no labels in scope) — callers surface that as [].
 */
async function buildFolderListQuery(
  executor: SqlExecutor,
  accountIds: string[] | null,
  folder: FolderSelection,
  sort: ThreadSortOption | undefined,
  limit: number | undefined,
  category?: Category
): Promise<{ sql: string; params: unknown[] } | null> {
  const params: unknown[] = []
  const where: string[] = []
  if (accountIds !== null && accountIds.length > 0) {
    where.push(`threads.account_id IN (${placeholders(accountIds.length)})`)
    params.push(...accountIds)
  }

  // The inbox — via either selector — hides snoozed threads. This
  // predicate is how a wake "restores the prior unread state" without any
  // read-state mutation: snooze never touches unread_count, the snoozed
  // rows are simply filtered out here (and from the inbox badge / total
  // unread counts), so clearing snoozed_until brings the thread back
  // exactly as unread/read as it was. Snooze deliberately does NOT affect
  // the label/specialUse/all selectors or search — snoozed mail stays
  // visible in its labels, All Mail and search results.
  //
  // Mute and Done (email-actions/thread-states.ts) join the same
  // inbox-only pattern: muted and Done threads leave the inbox list (Done
  // like archive, but without setting is_archived) while staying visible
  // in their labels, All Mail and search. Unmute/un-done therefore just
  // clears the column and the thread re-enters the inbox unchanged. Both
  // exclusions are inbox-only, like the snooze one.
  //
  // Delivery holds (threads.held_until, task 12.1, design D6) complete the
  // set: a delivery schedule holds matching mail OUT of the inbox until
  // its recurring window opens. The predicate is the STRICT
  // `held_until IS NULL` (not `<= now`): only the due pass
  // (email-actions/holds.ts releaseDueHolds) releases a hold, clearing the
  // column and stamping delivered_at in the same UPDATE so the whole
  // window's batch re-enters at the TOP of the inbox (the COALESCE
  // ordering below). Held threads stay visible in their labels, All Mail
  // and search — inbox-only, like snooze/mute/Done.
  const isInbox =
    (folder.kind === "preset" && folder.preset === "inbox") ||
    (folder.kind === "specialUse" && folder.specialUse === "inbox")
  // Both inbox selectors share the trash/spam exclusion: gmail local trash
  // (applyTrash → addSpecialLabel) keeps the thread's INBOX membership, so
  // without it a locally trashed/spammed thread would stay in the
  // specialUse inbox list while the preset (and the badge) exclude it.
  const inboxExclusions = isInbox
    ? " AND threads.is_trashed = 0 AND threads.is_spam = 0" +
      " AND threads.snoozed_until IS NULL AND threads.muted_at IS NULL" +
      " AND threads.done_at IS NULL AND threads.held_until IS NULL"
    : ""

  let predicate: string
  if (folder.kind === "labelId") {
    // bound twice below via membershipPredicate (distinct placeholders)
    predicate = membershipPredicate(params, [folder.labelId])
  } else if (folder.kind === "specialUse") {
    const labelIds = await findSpecialUseLabelIds(
      executor,
      folder.specialUse,
      accountIds
    )
    if (!labelIds.length) return null
    predicate = membershipPredicate(params, labelIds) + inboxExclusions
  } else if (folder.preset === "inbox") {
    const inboxLabelIds = await findSpecialUseLabelIds(
      executor,
      "inbox",
      accountIds
    )
    if (!inboxLabelIds.length) return null
    predicate = membershipPredicate(params, inboxLabelIds) + inboxExclusions
  } else {
    predicate = PRESET_PREDICATES[folder.preset]
  }

  // Category narrowing (task 3.5, design D4): appended AFTER the folder
  // predicate, so a category scope is "the same list, one category". The
  // Primary tab includes NULL — the migration v9 contract renders "not yet
  // categorized" as Primary (the backfill's EXISTS guard keeps that set
  // meaningful; a thread without messages can never leave NULL).
  if (category) {
    const categoryParam = params.length + 1
    predicate +=
      category === "primary"
        ? ` AND (threads.category = $${categoryParam} OR threads.category IS NULL)`
        : ` AND threads.category = $${categoryParam}`
    params.push(category)
  }

  where.push(predicate)

  const limitClause = limit ? ` LIMIT $${params.length + 1}` : ""
  if (limit) params.push(limit)

  // Pinned-first on EVERY folder selection and EVERY sort option
  // (mail-organization spec: a pinned thread stays at the top of its view
  // regardless of sort). The pinned term only leads the ordering — the
  // trailing sort comes from the closed set in thread-sort.ts. The inbox
  // keeps its delivered_at COALESCE as the date term (delivered_at stamped
  // when a snooze wakes or a delivery hold releases, so woken threads
  // reappear first within their pinned group — even under date_asc, which
  // flips that same COALESCE to ASC); other folders use last_message_at.
  const orderClause = threadSortOrderClause(sort ?? "date_desc", {
    inboxDateTerm: isInbox,
  })

  return {
    sql: `SELECT threads.* FROM threads
     WHERE ${where.join(" AND ")}
     ORDER BY ${orderClause}${limitClause}`,
    params,
  }
}

export async function listThreadsByFolder(
  executor: SqlExecutor,
  options: ListThreadsOptions
): Promise<ThreadRow[]> {
  const query = await buildFolderListQuery(
    executor,
    [options.accountId],
    options.folder,
    options.sort,
    options.limit
  )
  if (!query) return []
  return executor.select<ThreadRow>(query.sql, query.params)
}

/**
 * Across-accounts folder list (task 9.1, design D4): the SAME predicates,
 * exclusions and ordering as listThreadsByFolder, but the account filter
 * becomes an explicit id set — or disappears entirely when `accountIds` is
 * omitted/empty, which means "every account" (the caller decides what set
 * that is; the thread-list store passes its active accounts). Rows keep
 * `threads.*`, so each carries its `account_id` — the per-row account
 * identity the unified view's UI consumes (task 9.2). Drafts stay
 * per-account: nothing here lists composer drafts.
 */
export interface ListThreadsAcrossAccountsOptions {
  /** Restrict to these accounts; omitted/empty = no account filter. */
  accountIds?: string[]
  folder: FolderSelection
  limit?: number
  sort?: ThreadSortOption
}

export async function listThreadsAcrossAccounts(
  executor: SqlExecutor,
  options: ListThreadsAcrossAccountsOptions
): Promise<ThreadRow[]> {
  const query = await buildFolderListQuery(
    executor,
    options.accountIds ?? null,
    options.folder,
    options.sort,
    options.limit
  )
  if (!query) return []
  return executor.select<ThreadRow>(query.sql, query.params)
}

/**
 * Category-scoped inbox list (task 3.5, design D4, mailbox-ui spec
 * "Category tab presentation"): the UNIFIED inbox's exact query — the
 * inbox membership predicate plus the trash/spam/snooze/mute/done/hold
 * exclusions, across the active account set — narrowed to one category.
 * `primary` also matches `category IS NULL` (the migration v9 "not yet
 * categorized" contract renders NULL ≡ Primary; the tab UI and this query
 * agree). Rows keep `threads.*` with their `account_id`, so the category
 * tabs are a cross-account scope like unified.
 */
export interface ListThreadsByCategoryOptions {
  /** Restrict to these accounts; omitted/empty = no account filter. */
  accountIds?: string[]
  category: Category
  sort?: ThreadSortOption
  limit?: number
}

export async function listThreadsByCategoryAcrossAccounts(
  executor: SqlExecutor,
  options: ListThreadsByCategoryOptions
): Promise<ThreadRow[]> {
  const query = await buildFolderListQuery(
    executor,
    options.accountIds ?? null,
    { kind: "preset", preset: "inbox" },
    options.sort,
    options.limit,
    options.category
  )
  if (!query) return []
  return executor.select<ThreadRow>(query.sql, query.params)
}

/** Per-category thread counts the tab badges render (task 3.5). `total`
 * is the tab's thread count and `unread` the unread badge number — both
 * over the same inbox scope the category tab lists. */
export interface CategoryThreadCounts {
  total: number
  unread: number
}

/**
 * Grouped per-category counts over the unified-inbox scope (task 3.5):
 * ONE aggregate query — the inbox membership predicate (special-use
 * labels, so gmail INBOX membership resolves exactly like the list) plus
 * the inbox exclusions, `COUNT(*)` + `SUM(unread_count)` grouped by
 * category with NULL folded into `primary`. Every category is present in
 * the result (zero defaults), so consumers index freely; a stored value
 * outside the closed set is dropped rather than shown under a wrong tab.
 * An empty account set (no active accounts) counts nothing.
 */
export async function countThreadsByCategoryAcrossAccounts(
  executor: SqlExecutor,
  accountIds: string[]
): Promise<Record<Category, CategoryThreadCounts>> {
  const empty: Record<Category, CategoryThreadCounts> = {
    primary: { total: 0, unread: 0 },
    updates: { total: 0, unread: 0 },
    promotions: { total: 0, unread: 0 },
    social: { total: 0, unread: 0 },
    newsletters: { total: 0, unread: 0 },
  }
  if (!accountIds.length) return empty
  const inboxLabelIds = await findSpecialUseLabelIds(executor, "inbox", [
    ...accountIds,
  ])
  if (!inboxLabelIds.length) return empty
  const params: unknown[] = [...accountIds]
  const accountFilter = `threads.account_id IN (${placeholders(
    accountIds.length
  )})`
  // membershipPredicate appends its own (doubled) placeholders after the
  // account filter — the same predicate buildFolderListQuery uses.
  const membership = membershipPredicate(params, inboxLabelIds)
  const rows = await executor.select<{
    category: string | null
    total: number
    unread: number
  }>(
    `SELECT threads.category AS category,
            COUNT(*) AS total,
            COALESCE(SUM(threads.unread_count), 0) AS unread
     FROM threads
     WHERE ${accountFilter} AND ${membership}
       AND threads.is_trashed = 0 AND threads.is_spam = 0
       AND threads.snoozed_until IS NULL AND threads.muted_at IS NULL
       AND threads.done_at IS NULL AND threads.held_until IS NULL
     GROUP BY threads.category`,
    params
  )
  const result = { ...empty }
  for (const row of rows) {
    // NULL (not yet categorized) counts as Primary — the tab UI's
    // documented rendering; unknown values are skipped. The NULL group and
    // an explicit 'primary' group BOTH fold into primary, so the counts
    // merge rather than overwrite.
    const category = parseCategory(row.category ?? "primary")
    if (!category) continue
    const existing = result[category]
    result[category] = {
      total: existing.total + row.total,
      unread: existing.unread + row.unread,
    }
  }
  return result
}

/**
 * Threads still awaiting the category backfill (task 3.5's "Categorizing…
 * N of M" estimate): the count of the EXACT candidate set the backfill
 * selects — `category IS NULL` and at least one message, global like the
 * job itself (the backfill has no account scope). Decrements as the job's
 * keep-first writes land, so scanned + remaining is a live total estimate.
 */
export async function countCategoryBackfillRemaining(
  executor: SqlExecutor
): Promise<number> {
  const rows = await executor.select<{ count: number }>(
    `SELECT COUNT(*) AS count FROM threads
     WHERE category IS NULL
       AND EXISTS (SELECT 1 FROM messages WHERE messages.thread_id = threads.id)`
  )
  return rows[0]?.count ?? 0
}

/** Options for listRecentThreadsByParticipant (task 2.7). */
export interface RecentThreadsByParticipantOptions {
  /** Maximum rows returned; default 5. */
  limit?: number
  /** The open thread — excluded so the sidebar never lists it. */
  excludeThreadId?: string | null
}

/**
 * Recent threads involving `email` (task 2.7, contacts spec "Contact
 * sidebar", design D14 — no new storage): the reading-pane sidebar's
 * "threads exchanged with this contact" list. Deliberately NOT
 * account-scoped — a contact is an address, and the same person writing
 * to two accounts surfaces once (rows carry account_id; opening a foreign
 * thread resolves its owning account, the task 9.2 semantics).
 *
 * Matching runs against the threads.participants display cache (migration
 * v2) with a quoted-address LIKE — `"email":"<address>"` — so only exact
 * serialized addresses match (the closing quote blocks suffix bleed such
 * as ada@… inside canada@…; SQLite LIKE is case-insensitive for ASCII, so
 * header casing variants still match). Trashed/spam threads are excluded,
 * mirroring listContactThreads: deliberate placements are not
 * correspondence worth surfacing.
 *
 * Known limitation (accepted for v1, like the nudges detection): the
 * predicate is a substring JSON match, so an address that also appears
 * inside another participant's cached NAME value can false-positive; and
 * the cache only covers the NEWEST message's from + up to two
 * to-recipients, so a thread where the contact only participated earlier
 * may be missed. Ordering is last_message_at DESC (id ASC tiebreak), and
 * the result is capped at `limit`.
 */
export async function listRecentThreadsByParticipant(
  executor: SqlExecutor,
  email: string,
  options: RecentThreadsByParticipantOptions = {}
): Promise<ThreadRow[]> {
  const normalized = email.trim().toLowerCase()
  if (!normalized) return []
  // Same escape rule as contacts.ts: `%`/`_` in the address match
  // literally, paired with the ESCAPE clause below.
  const escaped = normalized.replace(/[\\%_]/g, (char) => `\\${char}`)
  const params: unknown[] = []
  const where = ["threads.is_trashed = 0", "threads.is_spam = 0"]
  if (options.excludeThreadId) {
    params.push(options.excludeThreadId)
    where.push(`threads.id != $${params.length}`)
  }
  params.push(`%"email":"${escaped}"%`)
  where.push(`threads.participants LIKE $${params.length} ESCAPE '\\'`)
  params.push(options.limit ?? 5)
  // placeholder numbers ascend by occurrence in the SQL text (see executor.ts)
  return executor.select<ThreadRow>(
    `SELECT threads.* FROM threads
     WHERE ${where.join("\n       AND ")}
     ORDER BY threads.last_message_at DESC, threads.id ASC
     LIMIT $${params.length}`,
    params
  )
}

export interface ThreadWithMessages {
  thread: ThreadRow
  /** chronological, matching listMessagesByThread */
  messages: MessageRow[]
  /** gmail label membership; empty for imap threads */
  labelIds: string[]
}

export async function getThreadWithMessages(
  executor: SqlExecutor,
  threadId: string
): Promise<ThreadWithMessages | null> {
  const thread = await getThread(executor, threadId)
  if (!thread) return null
  const messages = await executor.select<MessageRow>(
    "SELECT * FROM messages WHERE thread_id = $1 ORDER BY date ASC, created_at ASC",
    [threadId]
  )
  const labelRows = await executor.select<{ label_id: string }>(
    "SELECT label_id FROM thread_labels WHERE thread_id = $1",
    [threadId]
  )
  return { thread, messages, labelIds: labelRows.map((row) => row.label_id) }
}

/** Label fields a thread-list chip needs (no timestamps/provider ids). */
export interface ThreadLabelLite {
  id: string
  name: string
  color: string | null
}

/**
 * Batched label lookup for a page of threads (task 6.4): one query returns
 * every gmail USER label membership for the given thread ids, grouped as
 * threadId → chips. System labels (INBOX, TRASH, …) are folders, not
 * chips, so they are excluded; imap threads have no thread_labels rows and
 * map to no chips either.
 */
export async function getLabelsForThreads(
  executor: SqlExecutor,
  accountId: string,
  threadIds: string[]
): Promise<Map<string, ThreadLabelLite[]>> {
  const result = new Map<string, ThreadLabelLite[]>()
  if (!threadIds.length) return result
  const rows = await executor.select<ThreadLabelLite & { thread_id: string }>(
    `SELECT tl.thread_id, l.id, l.name, l.color
     FROM thread_labels tl
     JOIN labels l ON l.id = tl.label_id
     WHERE tl.account_id = $1 AND l.type = 'user'
       AND tl.thread_id IN (${placeholders(threadIds.length, 2)})
     ORDER BY l.name ASC`,
    [accountId, ...threadIds]
  )
  for (const row of rows) {
    const { thread_id: threadId, ...label } = row
    const existing = result.get(threadId)
    if (existing) {
      existing.push(label)
    } else {
      result.set(threadId, [label])
    }
  }
  return result
}
