import { invoke } from "@tauri-apps/api/core"

/**
 * Thin typed wrapper over the Rust IMAP/SMTP Tauri commands (design D4).
 * Every wire type here mirrors src-tauri/src/{imap,smtp}/types.rs
 * (serde camelCase); the provider and the unit tests are the only
 * consumers, so a Rust-side shape change surfaces as a type error here.
 * Tests mock "@tauri-apps/api/core" — nothing in this module may do
 * anything but forward to invoke.
 */

export type WireSecurity = "tls" | "starttls" | "none"

/** Mirrors imap::types::ImapParams. */
export interface ImapParams {
  host: string
  port: number
  security: WireSecurity
  username: string
  password: string
  /** Accept invalid/self-signed certificates. Dev only. */
  acceptInvalidCerts: boolean
}

/** Mirrors smtp::types::SmtpParams. */
export interface SmtpParams {
  host: string
  port: number
  security: WireSecurity
  username: string
  password: string
  acceptInvalidCerts: boolean
}

/** Mirrors imap::types::FolderRole (RFC 6154 role resolved Rust-side). */
export type FolderRole =
  "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "all" | "flagged"

/** Mirrors imap::types::ImapFolder. */
export interface ImapFolder {
  /** Full mailbox path exactly as the server reports it. */
  name: string
  /** Hierarchy delimiter ("/", "." or "" when flat). */
  delimiter: string
  /** False when the server marks the mailbox \NoSelect (container). */
  selectable: boolean
  role: FolderRole | null
}

/** Mirrors imap::types::ImapAddress (Rust Option → null/absent). */
export interface ImapAddress {
  name?: string | null
  email?: string | null
}

/** Mirrors imap::types::ImapAttachment. */
export interface ImapAttachment {
  partId: string
  filename: string
  mimeType: string
  size: number
  contentId?: string | null
  isInline: boolean
}

/** Mirrors imap::types::ImapMessage. */
export interface ImapMessage {
  uid: number
  flags: string[]
  messageId?: string | null
  inReplyTo?: string | null
  references?: string | null
  subject?: string | null
  from: ImapAddress[]
  to: ImapAddress[]
  cc: ImapAddress[]
  bcc: ImapAddress[]
  /** Date header as unix seconds (fallback INTERNALDATE, else 0). */
  date: number
  textBody?: string | null
  htmlBody?: string | null
  size: number
  attachments: ImapAttachment[]
}

/** Mirrors imap::types::FolderStatus. */
export interface ImapFolderStatus {
  uidValidity: number
  uidNext: number
  exists: number
  unseen: number
  /**
   * CONDSTORE (RFC 7162) mailbox mod-sequence — the Rust side always
   * serializes the field, null when the folder was selected without
   * (CONDSTORE) or the server lacks the extension. flag-sync.ts keeps
   * its own richer FolderStatus view for now, but could consume this
   * wire field directly later.
   */
  highestModseq?: number | null
}

/** Mirrors imap::types::FetchResult. */
export interface ImapFetchResult {
  messages: ImapMessage[]
  folderStatus: ImapFolderStatus
}

/** Mirrors imap::types::UidFlags. */
export interface ImapUidFlags {
  uid: number
  flags: string[]
}

/** Mirrors imap::types::TestResult. */
export interface ImapTestResult {
  host: string
  port: number
  security: string
  capabilities: string[]
  folderCount: number
}

/** Mirrors smtp::types::EmailAddress (email required on the wire). */
export interface WireEmailAddress {
  name?: string | null
  email: string
}

/** Mirrors smtp::types::SmtpAttachment (content base64 across the bridge). */
export interface WireAttachment {
  filename: string
  mimeType?: string | null
  contentBase64: string
}

/** Mirrors smtp::types::OutgoingEmail. */
export interface OutgoingEmail {
  from: WireEmailAddress
  to: WireEmailAddress[]
  cc: WireEmailAddress[]
  bcc: WireEmailAddress[]
  subject: string
  htmlBody?: string | null
  textBody?: string | null
  inReplyTo?: string | null
  references?: string | null
  messageId?: string | null
  /** Rust side defaults to empty (#[serde(default)]); present → the SMTP
   * message becomes multipart/mixed with one part per attachment. */
  attachments?: WireAttachment[] | null
}

/** Mirrors smtp::types::SendResult. */
export interface SmtpSendResult {
  messageId: string
}

/** Mirrors smtp::types::SmtpTestResult. */
export interface SmtpTestResult {
  host: string
  port: number
  security: string
  /** True when credentials were supplied and AUTH succeeded. */
  authenticated: boolean
  server: string
  capabilities: string[]
}

// ---- IMAP commands ----

export function imapTestConnection(
  params: ImapParams
): Promise<ImapTestResult> {
  return invoke("imap_test_connection", { params })
}

export function imapListFolders(params: ImapParams): Promise<ImapFolder[]> {
  return invoke("imap_list_folders", { params })
}

/**
 * `uidSet` and `last` mirror the Rust command: an explicit set
 * ("1,5,9", "104:*") or `last = n` for the n most recent messages. The
 * Rust side resolves an empty uidSet against `last`.
 */
export function imapFetchMessages(
  params: ImapParams,
  folder: string,
  uidSet: string,
  last?: number
): Promise<ImapFetchResult> {
  return invoke("imap_fetch_messages", { params, folder, uidSet, last })
}

export function imapFetchFlags(
  params: ImapParams,
  folder: string,
  uidSet: string,
  last?: number
): Promise<ImapUidFlags[]> {
  return invoke("imap_fetch_flags", { params, folder, uidSet, last })
}

/** `flags` are system flags or keywords, e.g. ["\\Seen"]; add=false removes. */
export function imapStoreFlags(
  params: ImapParams,
  folder: string,
  uidSet: string,
  flags: string[],
  add: boolean
): Promise<void> {
  return invoke("imap_store_flags", { params, folder, uidSet, flags, add })
}

export function imapMoveMessage(
  params: ImapParams,
  folder: string,
  uidSet: string,
  destination: string
): Promise<void> {
  return invoke("imap_move_message", { params, folder, uidSet, destination })
}

export function imapDeleteMessage(
  params: ImapParams,
  folder: string,
  uidSet: string
): Promise<void> {
  return invoke("imap_delete_message", { params, folder, uidSet })
}

/** Append raw MIME bytes to a folder, e.g. sent filing with ["\\Seen"]. */
export function imapAppend(
  params: ImapParams,
  folder: string,
  message: number[],
  flags?: string[]
): Promise<void> {
  return invoke("imap_append", { params, folder, message, flags })
}

// ---- SMTP commands ----

export function smtpSendEmail(
  params: SmtpParams,
  email: OutgoingEmail
): Promise<SmtpSendResult> {
  return invoke("smtp_send_email", { params, email })
}

export function smtpTestConnection(
  params: SmtpParams
): Promise<SmtpTestResult> {
  return invoke("smtp_test_connection", { params })
}
