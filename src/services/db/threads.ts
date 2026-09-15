import type { SqlExecutor } from "./executor"
import { placeholders } from "./executor"
import type { LabelRow, SpecialUse } from "./labels"
import { findLabelsBySpecialUse } from "./labels"
import type { ContactRef, MessageRow } from "./messages"
import { parseContacts } from "./messages"

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
 * Presets:
 * - "inbox": canonical membership in the account's inbox-role label(s),
 *   excluding trash and spam. For gmail this equals the is_archived = 0
 *   cache; going through membership also keeps imap threads filed in
 *   custom folders (which leave is_archived = 0) out of the inbox.
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

export async function listThreadsByFolder(
  executor: SqlExecutor,
  options: ListThreadsOptions
): Promise<ThreadRow[]> {
  const { accountId, folder } = options
  const params: unknown[] = [accountId]
  let predicate: string

  if (folder.kind === "labelId") {
    // bound twice below via membershipPredicate (distinct placeholders)
    predicate = membershipPredicate(params, [folder.labelId])
  } else if (folder.kind === "specialUse") {
    const labels = await findLabelsBySpecialUse(
      executor,
      accountId,
      folder.specialUse
    )
    if (!labels.length) return []
    predicate = membershipPredicate(
      params,
      labels.map((label: LabelRow) => label.id)
    )
  } else if (folder.preset === "inbox") {
    const inboxLabels = await findLabelsBySpecialUse(
      executor,
      accountId,
      "inbox"
    )
    if (!inboxLabels.length) return []
    predicate = `${membershipPredicate(
      params,
      inboxLabels.map((label: LabelRow) => label.id)
    )} AND threads.is_trashed = 0 AND threads.is_spam = 0`
  } else {
    predicate = PRESET_PREDICATES[folder.preset]
  }

  const limitClause = options.limit ? ` LIMIT $${params.length + 1}` : ""
  if (options.limit) params.push(options.limit)

  return executor.select<ThreadRow>(
    `SELECT threads.* FROM threads
     WHERE threads.account_id = $1 AND ${predicate}
     ORDER BY threads.last_message_at DESC${limitClause}`,
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
