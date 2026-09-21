import type { SqlExecutor } from "./executor"
import { placeholders } from "./executor"

/** `{ name?, email }` participant, serialized into the *_json columns. */
export interface ContactRef {
  name?: string
  email: string
}

export interface AttachmentInput {
  id: string
  filename?: string
  mimeType?: string
  size?: number
  /** cid: referenced from HTML body for inline images */
  contentId?: string
  isInline?: boolean
  /** gmail attachment id or imap MIME section path */
  providerPartId?: string
}

export interface MessageInput {
  id: string
  threadId: string
  accountId: string
  /** gmail account: server message id. Drives upsert-by-provider-id. */
  gmailMessageId?: string
  /** imap account: UID + folder path drive upsert-by-provider-id. */
  imapUid?: number
  imapFolder?: string
  messageIdHeader?: string
  inReplyTo?: string
  referencesHeader?: string
  subject?: string
  fromName?: string
  fromAddress?: string
  to?: ContactRef[]
  cc?: ContactRef[]
  bcc?: ContactRef[]
  /** unix epoch seconds */
  date: number
  snippet?: string
  bodyHtml?: string
  bodyText?: string
  /** raw headers, JSON-encoded */
  headers?: string
  /**
   * Compact SPF/DKIM/DMARC verdicts (task 2.1, design D10) —
   * "spf=pass;dkim=fail;dmarc=none", parsed at ingestion; absent = the
   * message carried no Authentication-Results (no badge).
   */
  authResults?: string
  sizeEstimate?: number
  isRead?: boolean
  isFlagged?: boolean
  hasAttachments?: boolean
  /** parsed MIME part metadata, JSON-encoded */
  partsJson?: string
  /** attachment descriptors to project into the attachments table */
  attachments?: AttachmentInput[]
}

export interface MessageRow {
  id: string
  thread_id: string
  account_id: string
  gmail_message_id: string | null
  imap_uid: number | null
  imap_folder: string | null
  message_id_header: string | null
  in_reply_to: string | null
  references_header: string | null
  subject: string | null
  from_name: string | null
  from_address: string | null
  to_json: string | null
  cc_json: string | null
  bcc_json: string | null
  date: number
  snippet: string | null
  body_html: string | null
  body_text: string | null
  headers: string | null
  size_estimate: number | null
  is_read: number
  is_flagged: number
  has_attachments: number
  parts_json: string | null
  created_at: number
  /** Compact auth verdicts (task 2.1, D10); NULL = no Authentication-Results. */
  auth_results: string | null
}

export interface AttachmentRow {
  id: string
  message_id: string
  account_id: string
  filename: string | null
  mime_type: string | null
  size: number | null
  content_id: string | null
  is_inline: number
  provider_part_id: string | null
  local_path: string | null
  cached_at: number | null
  cache_size: number | null
}

export interface MessageWithAttachments extends MessageRow {
  to: ContactRef[]
  cc: ContactRef[]
  bcc: ContactRef[]
  attachments: AttachmentRow[]
}

function boolToInt(value: boolean | undefined): number {
  return value === undefined ? 0 : value ? 1 : 0
}

/** Empty/undefined recipient lists persist as NULL, not "[]". */
export function serializeContacts(
  contacts: ContactRef[] | null | undefined
): string | null {
  return contacts && contacts.length > 0 ? JSON.stringify(contacts) : null
}

/** Tolerant parse of a *_json column; corrupt or NULL values yield []. */
export function parseContacts(json: string | null | undefined): ContactRef[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as ContactRef[]) : []
  } catch {
    return []
  }
}

/**
 * Insert a message row (and optionally its attachment descriptors). FTS5
 * indexing happens via the messages_fts_ai trigger — never written to
 * directly. No upsert semantics here: use upsertMessageByProviderId for
 * sync flows, or check existence first for user-driven inserts.
 */
export async function insertMessage(
  executor: SqlExecutor,
  input: MessageInput
): Promise<void> {
  await executor.execute(
    `INSERT INTO messages (
      id, thread_id, account_id, gmail_message_id, imap_uid, imap_folder,
      message_id_header, in_reply_to, references_header, subject, from_name,
      from_address, to_json, cc_json, bcc_json, date, snippet, body_html,
      body_text, headers, auth_results, size_estimate, is_read, is_flagged,
      has_attachments, parts_json
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
      $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26
    )`,
    [
      input.id,
      input.threadId,
      input.accountId,
      input.gmailMessageId ?? null,
      input.imapUid ?? null,
      input.imapFolder ?? null,
      input.messageIdHeader ?? null,
      input.inReplyTo ?? null,
      input.referencesHeader ?? null,
      input.subject ?? null,
      input.fromName ?? null,
      input.fromAddress ?? null,
      serializeContacts(input.to),
      serializeContacts(input.cc),
      serializeContacts(input.bcc),
      input.date,
      input.snippet ?? null,
      input.bodyHtml ?? null,
      input.bodyText ?? null,
      input.headers ?? null,
      input.authResults ?? null,
      input.sizeEstimate ?? null,
      boolToInt(input.isRead),
      boolToInt(input.isFlagged),
      boolToInt(input.hasAttachments),
      input.partsJson ?? null,
    ]
  )
  if (input.attachments?.length) {
    await insertAttachments(
      executor,
      input.accountId,
      input.id,
      input.attachments
    )
  }
}

async function insertAttachments(
  executor: SqlExecutor,
  accountId: string,
  messageId: string,
  attachments: AttachmentInput[]
): Promise<void> {
  for (const attachment of attachments) {
    await executor.execute(
      `INSERT INTO attachments (
        id, message_id, account_id, filename, mime_type, size, content_id,
        is_inline, provider_part_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        attachment.id,
        messageId,
        accountId,
        attachment.filename ?? null,
        attachment.mimeType ?? null,
        attachment.size ?? null,
        attachment.contentId ?? null,
        attachment.isInline === true ? 1 : 0,
        attachment.providerPartId ?? null,
      ]
    )
  }
}

export interface MessagePatch {
  /** undefined = leave unchanged; explicit null = clear the column */
  subject?: string | null
  fromName?: string | null
  fromAddress?: string | null
  snippet?: string | null
  bodyHtml?: string | null
  bodyText?: string | null
  headers?: string | null
  authResults?: string | null
  to?: ContactRef[] | null
  cc?: ContactRef[] | null
  bcc?: ContactRef[] | null
  date?: number
  sizeEstimate?: number | null
  imapFolder?: string | null
  isRead?: boolean
  isFlagged?: boolean
  hasAttachments?: boolean
}

const PATCH_COLUMNS: Record<keyof MessagePatch, string> = {
  subject: "subject",
  fromName: "from_name",
  fromAddress: "from_address",
  snippet: "snippet",
  bodyHtml: "body_html",
  bodyText: "body_text",
  headers: "headers",
  authResults: "auth_results",
  to: "to_json",
  cc: "cc_json",
  bcc: "bcc_json",
  date: "date",
  sizeEstimate: "size_estimate",
  imapFolder: "imap_folder",
  isRead: "is_read",
  isFlagged: "is_flagged",
  hasAttachments: "has_attachments",
}

function encodePatch(key: keyof MessagePatch, patch: MessagePatch): unknown {
  switch (key) {
    case "subject":
    case "fromName":
    case "fromAddress":
    case "snippet":
    case "bodyHtml":
    case "bodyText":
    case "headers":
    case "authResults":
    case "sizeEstimate":
    case "imapFolder":
    case "date":
      return patch[key] ?? null
    case "to":
      return serializeContacts(patch.to)
    case "cc":
      return serializeContacts(patch.cc)
    case "bcc":
      return serializeContacts(patch.bcc)
    case "isRead":
      return patch.isRead ? 1 : 0
    case "isFlagged":
      return patch.isFlagged ? 1 : 0
    case "hasAttachments":
      return patch.hasAttachments ? 1 : 0
  }
}

/**
 * Partial update. Every UPDATE rewrites the FTS row via the
 * messages_fts_au trigger, so body/subject edits stay searchable.
 */
export async function updateMessage(
  executor: SqlExecutor,
  messageId: string,
  patch: MessagePatch
): Promise<void> {
  const keys = (Object.keys(patch) as (keyof MessagePatch)[]).filter(
    (key) => patch[key] !== undefined
  )
  if (!keys.length) return
  // placeholder numbers ascend by occurrence in the SQL text (see executor.ts)
  const sets = keys.map((key, index) => `${PATCH_COLUMNS[key]} = $${index + 1}`)
  await executor.execute(
    `UPDATE messages SET ${sets.join(", ")} WHERE id = $${keys.length + 1}`,
    [keys.map((key) => encodePatch(key, patch)), messageId].flat()
  )
}

export async function deleteMessage(
  executor: SqlExecutor,
  messageId: string
): Promise<void> {
  await executor.execute("DELETE FROM messages WHERE id = $1", [messageId])
}

export async function getMessage(
  executor: SqlExecutor,
  messageId: string
): Promise<MessageWithAttachments | null> {
  const rows = await executor.select<MessageRow>(
    "SELECT * FROM messages WHERE id = $1",
    [messageId]
  )
  const row = rows[0]
  if (!row) return null
  const attachments = await executor.select<AttachmentRow>(
    "SELECT * FROM attachments WHERE message_id = $1 ORDER BY rowid ASC",
    [messageId]
  )
  return {
    ...row,
    to: parseContacts(row.to_json),
    cc: parseContacts(row.cc_json),
    bcc: parseContacts(row.bcc_json),
    attachments,
  }
}

/** Chronological message list for the conversation view. */
export async function listMessagesByThread(
  executor: SqlExecutor,
  threadId: string
): Promise<MessageRow[]> {
  return executor.select<MessageRow>(
    "SELECT * FROM messages WHERE thread_id = $1 ORDER BY date ASC, created_at ASC",
    [threadId]
  )
}

/** Bulk read-state change; returns rows actually updated. */
export async function markMessagesRead(
  executor: SqlExecutor,
  messageIds: string[],
  isRead = true
): Promise<{ rowsAffected: number }> {
  if (!messageIds.length) return { rowsAffected: 0 }
  return executor.execute(
    `UPDATE messages SET is_read = $1 WHERE id IN (${placeholders(
      messageIds.length,
      2
    )})`,
    [isRead ? 1 : 0, ...messageIds]
  )
}

/** Bulk flag (star) change; returns rows actually updated. */
export async function markMessagesFlagged(
  executor: SqlExecutor,
  messageIds: string[],
  isFlagged = true
): Promise<{ rowsAffected: number }> {
  if (!messageIds.length) return { rowsAffected: 0 }
  return executor.execute(
    `UPDATE messages SET is_flagged = $1 WHERE id IN (${placeholders(
      messageIds.length,
      2
    )})`,
    [isFlagged ? 1 : 0, ...messageIds]
  )
}

async function findMessageIdByProviderKey(
  executor: SqlExecutor,
  input: MessageInput
): Promise<string | null> {
  if (input.gmailMessageId) {
    const rows = await executor.select<Pick<MessageRow, "id">>(
      "SELECT id FROM messages WHERE account_id = $1 AND gmail_message_id = $2 LIMIT 1",
      [input.accountId, input.gmailMessageId]
    )
    return rows[0]?.id ?? null
  }
  if (input.imapFolder != null && input.imapUid != null) {
    const rows = await executor.select<Pick<MessageRow, "id">>(
      "SELECT id FROM messages WHERE account_id = $1 AND imap_folder = $2 AND imap_uid = $3 LIMIT 1",
      [input.accountId, input.imapFolder, input.imapUid]
    )
    return rows[0]?.id ?? null
  }
  return null
}

/**
 * Sync-path insert-or-update keyed by provider identity: gmail by
 * (account_id, gmail_message_id), imap by (account_id, imap_folder,
 * imap_uid) — the same keys the schema's partial unique indexes enforce.
 * When the message exists, server-known fields are overwritten
 * (server-wins: read/flagged state is reconciled by flag sync and pushed
 * upstream via pending_operations, so local divergence is not preserved
 * here) while id, thread_id and created_at stay untouched. Messages
 * without a provider key always insert. Callers own thread grouping and
 * must run recomputeThreadCaches afterwards.
 */
export async function upsertMessageByProviderId(
  executor: SqlExecutor,
  input: MessageInput
): Promise<{ id: string; created: boolean }> {
  const existingId = await findMessageIdByProviderKey(executor, input)
  if (!existingId) {
    await insertMessage(executor, input)
    return { id: input.id, created: true }
  }
  await updateMessage(executor, existingId, {
    subject: input.subject ?? null,
    fromName: input.fromName ?? null,
    fromAddress: input.fromAddress ?? null,
    date: input.date,
    snippet: input.snippet ?? null,
    bodyHtml: input.bodyHtml ?? null,
    bodyText: input.bodyText ?? null,
    headers: input.headers ?? null,
    authResults: input.authResults ?? null,
    sizeEstimate: input.sizeEstimate ?? null,
    to: input.to ?? null,
    cc: input.cc ?? null,
    bcc: input.bcc ?? null,
    isRead: input.isRead ?? false,
    isFlagged: input.isFlagged ?? false,
    hasAttachments: input.hasAttachments ?? false,
    imapFolder: input.imapFolder ?? null,
  })
  return { id: existingId, created: false }
}
