import type { LabelType, SpecialUse } from "../db/labels"

/**
 * Provider-agnostic mail surface (design D2). Sync, composer and
 * organization features consume these types only — never Tauri commands —
 * so Gmail (task 4.2) and IMAP/SMTP stay interchangeable behind one
 * interface. The IMAP wire contract (Tauri command shapes) lives in
 * invoke.ts; this file stays transport-free.
 */

export type AccountType = "gmail" | "imap"

export type AccountStatus = "active" | "auth-error"

/** Transport security, mirroring the Rust `Security` enum. */
export type SecurityKind = "tls" | "starttls" | "none"

/**
 * Mirrors the `accounts` table (see migrations.ts v1). `credentialsJson`
 * is the AES-GCM envelope placeholder — decryption lands in task 5.1 and
 * stays opaque here; live credentials are passed separately (see
 * ProviderCredentials) and never round-trip through this DTO.
 */
export interface EmailAccount {
  id: string
  type: AccountType
  email: string
  displayName?: string
  /** IMAP/SMTP connection config; unused for gmail accounts. */
  imapHost?: string
  imapPort?: number
  imapSecurity?: SecurityKind
  smtpHost?: string
  smtpPort?: number
  smtpSecurity?: SecurityKind
  /** Encrypted credentials envelope as persisted; opaque until task 5.1. */
  credentialsJson?: string
  oauthScope?: string
  oauthClientId?: string
  /** Delta-sync cursors: gmail history id plus a labels-sync marker. */
  gmailHistoryId?: string
  labelsSyncedAt?: number
  status: AccountStatus
  /** unix epoch seconds */
  lastSyncAt?: number
  lastFullSyncAt?: number
  isActive: boolean
  isPinned: boolean
  /** unix epoch seconds */
  createdAt?: number
}

/**
 * Plaintext credentials for one provider call. The caller decrypts
 * (task 5.1); providers receive them per getProvider/create* call and
 * must never persist them.
 */
export interface ProviderCredentials {
  /** imap: the account password. gmail: unused (OAuth token manager, 4.2). */
  password: string
  /** Accept invalid/self-signed certificates (local mail bridges). Dev only. */
  acceptInvalidCerts?: boolean
}

/**
 * A synced folder in the label model. `specialUse` is normalized to the
 * labels-table vocabulary (RFC 6154 role "junk" → "spam"); system label
 * ids are deterministic so folder→label sync stays idempotent.
 */
export interface EmailFolder {
  /** Deterministic label id: "INBOX"/"SENT"/… for system, "folder-<path>" for user. */
  id: string
  /** Display name: canonical ("Inbox") for system folders, leaf name for user folders. */
  name: string
  /** Full folder path exactly as the server reports it. */
  path: string
  type: LabelType
  specialUse: SpecialUse | null
  /** Hierarchy delimiter ("/", "." or "" when flat). */
  delimiter: string
}

/**
 * Provider-agnostic label descriptor mirroring the labels table
 * (db/labels.ts LabelInput). Folders already carry the IMAP side; gmail
 * label sync (4.2) produces these directly.
 */
export interface EmailLabel {
  id: string
  accountId: string
  /** Full name, including "/" hierarchy segments. */
  name: string
  gmailLabelId?: string
  imapFolderName?: string
  specialUse?: SpecialUse
  color?: string
  type: LabelType
}

/** `{ name?, email }` participant, same shape as db ContactRef. */
export interface EmailAddress {
  name?: string
  email?: string
}

/** Attachment part metadata (content bytes are fetched on demand, D15). */
export interface NormalizedAttachment {
  /** imap MIME section path ("1.2") / gmail attachment id. */
  partId: string
  filename: string
  mimeType: string
  size: number
  /** cid: for inline references from the HTML body. */
  contentId?: string
  isInline: boolean
}

/**
 * Mirrors the IMAP wire message but provider-agnostic. The IMAP provider
 * fills the base fields; gmail-shaped slots are optional and documented
 * for 4.2 so it can share this DTO without breaking the shape.
 */
export interface NormalizedMessage {
  /** imap: folder-local UID. */
  uid: number
  /** imap system flags/keywords ("\Seen", "\Flagged", …). */
  flags: string[]
  /** RFC 5322 Message-ID header. */
  messageId?: string
  inReplyTo?: string
  /** Space-separated References chain, newest last. */
  references?: string
  subject?: string
  from: EmailAddress[]
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  /** Date header as unix seconds (fallback INTERNALDATE, else 0). */
  date: number
  textBody?: string
  htmlBody?: string
  /** Raw RFC 822 size in octets. */
  size: number
  attachments: NormalizedAttachment[]
  /** imap: full folder path the message was fetched from. */
  folder?: string
  // Gmail-shaped slots (4.2): the imap provider leaves these unset.
  /** Gmail unique message id. */
  gmailId?: string
  /** Gmail thread id. */
  gmailThreadId?: string
  /** Gmail label ids applied server-side. */
  labelIds?: string[]
  /** Gmail history id at fetch time. */
  historyId?: string
}

/**
 * One outgoing attachment (task 8.5): raw file bytes, base64-encoded so
 * the field survives every JSON hop unchanged (the queue's
 * payload_json, the Tauri invoke bridge, Gmail's REST payload). Standard
 * padded base64 — the Rust side decodes with base64::STANDARD.
 */
export interface OutgoingAttachment {
  filename: string
  /** Unknown/absent falls back to application/octet-stream. */
  mimeType?: string
  contentBase64: string
}

export interface SendEmailInput {
  from: { name?: string; email: string }
  to: EmailAddress[]
  cc?: EmailAddress[]
  bcc?: EmailAddress[]
  subject: string
  htmlBody?: string
  textBody?: string
  /** Message-ID being replied to, e.g. "<msg-0@example.com>". */
  inReplyTo?: string
  /** Space-separated References chain, oldest first. */
  references?: string
  /** Send with a specific Message-ID; when absent the server generates one. */
  messageId?: string
  /** Files to attach; both providers transmit them as multipart/mixed
   * parts around the alternative body. */
  attachments?: OutgoingAttachment[]
}

export interface SendEmailResult {
  /** The Message-ID that was transmitted. */
  messageId: string
}

/** Message selector: either an explicit uid set or "n most recent". */
export interface FetchQuery {
  /** imap UID set, e.g. "104:*", "1:100", "1,5,9". */
  uidSet?: string
  /** Fetch the n most recent messages instead of an explicit set. */
  last?: number
}

/** Snapshot of a folder's state (from SELECT), used as sync cursor input. */
export interface FolderStatus {
  uidValidity: number
  uidNext: number
  exists: number
  unseen: number
}

export interface FetchMessagesResult {
  messages: NormalizedMessage[]
  folderStatus: FolderStatus
}

export interface MessageFlags {
  uid: number
  flags: string[]
}

/** Provider-agnostic message handle: imap addresses by (folder, uid); the
 * gmail provider prefers providerMessageId (the exact opaque string id)
 * and falls back to uid when only a numeric id is available. */
export interface MessageRef {
  /** Full folder path (imap). */
  folder: string
  /** imap UID / gmail numeric message id (0 when the id is non-numeric
   * and providerMessageId carries the identity instead). */
  uid: number
  /** Exact provider message id (gmail). Real Gmail message ids are
   * opaque hex-ish strings that do not survive Number() coercion, so the
   * gmail provider sends this string to the API verbatim when present;
   * uid stays the imap addressing key (and a legacy fallback). */
  providerMessageId?: string
}

/**
 * Delta-sync result (D2). The cursor is an opaque provider-private string:
 * gmail stores its history id (4.2), imap a snapshot of per-folder
 * folder_sync_state rows (4.3). `needsFullSync` tells the caller the
 * cursor was stale/invalid and a full sync must run first.
 */
export interface DeltaSyncResult {
  messages: NormalizedMessage[]
  nextCursor: string
  needsFullSync: boolean
}

export interface ConnectionTestResult {
  success: boolean
  message: string
  /** True when the failure was an authentication failure. */
  authError?: boolean
}

/**
 * Thrown by provider methods when the server rejects the credentials.
 * The account auth-error task (5.6) catches this to mark the account and
 * pause only that account's sync. Both providers throw the same class.
 */
export class ProviderAuthError extends Error {
  readonly accountType: AccountType
  readonly accountId: string

  constructor(accountId: string, accountType: AccountType, message: string) {
    super(message)
    this.name = "ProviderAuthError"
    this.accountId = accountId
    this.accountType = accountType
  }
}

/**
 * The seam every sync/compose/organization feature codes against (D2).
 * Threading semantics: callers pass refs/uids; providers resolve system
 * folders themselves. One instance per account; stateless enough to be
 * rebuilt cheaply by the factory.
 */
export interface EmailProvider {
  readonly accountId: string
  readonly type: AccountType

  // ---- Folders/labels ----

  /**
   * List folders mapped to the label model. Container (\NoSelect) folders
   * are filtered out; system roles are resolved server-side (RFC 6154
   * attributes with well-known-name fallback) and trusted here.
   */
  listFolders(): Promise<EmailFolder[]>

  // ---- Sync ----

  /**
   * Delta sync against a persisted cursor. NOT implemented in 4.1 —
   * the imap provider throws; 4.2 (gmail history) and 4.3 (imap
   * UIDVALIDITY + last UID) fill it in behind this signature.
   */
  deltaSync(cursor: string | null): Promise<DeltaSyncResult>

  /**
   * Fetch full messages (bodies + attachment metadata) from a folder.
   * imap: uidSet/last selectors; the gmail provider reinterprets them
   * (or bypasses this in favor of deltaSync) without breaking the shape.
   */
  fetchMessages(folder: string, query: FetchQuery): Promise<FetchMessagesResult>

  /**
   * Flags-only fetch (no bodies) for read/star reconciliation (D14).
   */
  fetchFlags(folder: string, query: FetchQuery): Promise<MessageFlags[]>

  // ---- Flags/labels (organization actions, task 10.x) ----

  /** Add/remove raw flags or keywords, e.g. ["\\Seen"], ["$Label1"]. */
  storeFlags(
    folder: string,
    uidSet: string,
    flags: string[],
    add: boolean
  ): Promise<void>

  /** Read/unread via \Seen. */
  markRead(refs: MessageRef[], read: boolean): Promise<void>

  /** Star/unstar via \Flagged (gmail: STARRED label). */
  markStarred(refs: MessageRef[], starred: boolean): Promise<void>

  /** Server-side labels (gmail). imap has none — a documented no-op. */
  addLabels(refs: MessageRef[], labelIds: string[]): Promise<void>

  /** Server-side labels (gmail). imap has none — a documented no-op. */
  removeLabels(refs: MessageRef[], labelIds: string[]): Promise<void>

  /** Archive = move to the \Archive folder (gmail: drop INBOX label). */
  archive(refs: MessageRef[]): Promise<void>

  /** Trash = move to the \Trash folder (gmail: add TRASH label). */
  trash(refs: MessageRef[]): Promise<void>

  /** Move messages between folders (imap) / labels (gmail). */
  moveToFolder(refs: MessageRef[], destinationFolder: string): Promise<void>

  /** Hard delete: imap EXPUNGE / gmail delete-forever. */
  deleteForever(refs: MessageRef[]): Promise<void>

  // ---- Send ----

  sendMessage(input: SendEmailInput): Promise<SendEmailResult>

  /**
   * Upload a raw MIME message into a folder (imap APPEND) — sent-mail
   * filing and (later) server drafts. gmail inserts into the Sent label.
   */
  appendMessage(
    folder: string,
    raw: Uint8Array,
    flags?: string[]
  ): Promise<void>

  // ---- Connection ----

  testConnection(): Promise<ConnectionTestResult>
}
