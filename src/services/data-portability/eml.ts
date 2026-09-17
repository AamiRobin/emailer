import { open as openFileDialog } from "@tauri-apps/plugin-dialog"
import { writeFile as fsWriteFile } from "@tauri-apps/plugin-fs"
import { join } from "@tauri-apps/api/path"

import { createPluginCacheFs, type CacheFs } from "../attachments/cache"
import type { SqlExecutor } from "../db/executor"
import type { AttachmentRow, ContactRef } from "../db/messages"
import { getMessage, listMessagesByThread, parseContacts } from "../db/messages"
import {
  bytesToBase64,
  encodeHeaderValue,
  formatAddressList,
  formatDate,
} from "../email/mime-builder"

/**
 * EML export (task 19.1, data-portability spec "Export to EML") — rebuild
 * RFC 822 messages from the parsed fields the database stores and write
 * one `.eml` file per message to a user-chosen directory.
 *
 * FIDELITY NOTE (deviation from design D14): D14 says "both providers
 * already persist raw RFC 822" — they do NOT. The messages table stores
 * parsed fields only (body_html/body_text, the headers JSON pair D13
 * captures, parts_json metadata, an attachments table with cached
 * bytes); raw MIME exists only transiently at fetch. So an exported EML
 * is a FAITHFUL RECONSTRUCTION, not a byte-identical original: message
 * content, participants, subject, date, threading headers and attachment
 * bytes are intact, but headers that were not captured at ingestion
 * (Received, DKIM signatures, the rest of the original header block) are
 * absent, and transfer encodings/boundaries differ from the original.
 *
 * The assembly mirrors email/mime-builder.ts (the outgoing path) part
 * for part — CRLF lines, base64 UTF-8 bodies, multipart/alternative
 * wrapped in multipart/mixed when attachments are present, RFC 2047
 * encoded-words for non-ASCII header values — so the same reader
 * (mime-builder's decomposeMimeMessage, the Rust mailparse stack,
 * Thunderbird) parses both. All Tauri plugins sit behind injectable
 * deps (the file-actions.ts pattern) so tests substitute fakes.
 */

const CRLF = "\r\n"
const BASE64_LINE_LENGTH = 76
/** Subject portion cap for exported filenames (keeps paths manageable). */
const FILENAME_SUBJECT_MAX = 64

export interface EmlDeps {
  /**
   * Attachment-cache disk seam (reads `attachments.local_path` under
   * AppData). Default: @tauri-apps/plugin-fs (createPluginCacheFs).
   */
  fs?: CacheFs
}

/** One rebuilt EML plus what could not be fully reconstructed. */
export interface RebuiltEml {
  /** The complete RFC 822 message (CRLF line endings). */
  eml: string
  /**
   * Filenames of attachments whose cached bytes were unavailable —
   * cache-miss attachments are exported as empty parts (the MIME
   * structure stays intact) rather than dropped; export is read-only and
   * local-first, so it never fetches from the server to fill them in.
   */
  unavailableAttachments: string[]
}

/** Padded base64 of UTF-8 text, wrapped at 76 chars (mime-builder's
 * base64OfText + wrapBase64Lines; local copies — that module stays the
 * outgoing path's, untouched). */
function base64WrappedText(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  const base64 = btoa(binary)
  const lines: string[] = []
  for (let offset = 0; offset < base64.length; offset += BASE64_LINE_LENGTH) {
    lines.push(base64.slice(offset, offset + BASE64_LINE_LENGTH))
  }
  return lines.join(CRLF)
}

/** One MIME part with a base64 UTF-8 body (builder's mimePart). */
function mimePart(contentType: string, body: string): string {
  return [
    `Content-Type: ${contentType}`,
    "Content-Transfer-Encoding: base64",
    "",
    base64WrappedText(body),
  ].join(CRLF)
}

/** Header-safe quoted filename parameter (builder's formatFilenameParam:
 * escaped quotes, unfolded newlines, RFC 2047 for non-ASCII). */
function formatFilenameParam(filename: string): string {
  const escaped = filename.replace(/[\\"]/g, "\\$&")
  return `"${encodeHeaderValue(escaped)}"`
}

/** One attachment part (builder's attachmentPart): base64 bytes,
 * Content-Disposition, Content-ID for inline `cid:` parts so HTML
 * references stay resolvable. Empty bytes stand in for a cache miss. */
function attachmentPart(attachment: AttachmentRow, base64: string): string {
  const mimeType = attachment.mime_type?.trim() || "application/octet-stream"
  const filename = formatFilenameParam(attachment.filename ?? "attachment")
  const lines = [
    `Content-Type: ${mimeType}; name=${filename}`,
    `Content-Disposition: ${attachment.is_inline ? "inline" : "attachment"}; filename=${filename}`,
    "Content-Transfer-Encoding: base64",
  ]
  if (attachment.content_id) {
    lines.push(`Content-ID: <${encodeHeaderValue(attachment.content_id)}>`)
  }
  return [...lines, "", base64].join(CRLF)
}

/** Cached bytes for one attachment, or null on a miss (never a fetch —
 * export stays local-only, see RebuiltEml.unavailableAttachments). */
async function readCachedBytes(
  attachment: AttachmentRow,
  fs: CacheFs
): Promise<string | null> {
  if (!attachment.local_path) return null
  try {
    const bytes = await fs.readFile(attachment.local_path)
    return bytesToBase64(bytes)
  } catch {
    return null
  }
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

/**
 * Rebuild the RFC 822 message for one stored message row (null when the
 * id is unknown). Header block: the standard identity headers from the
 * parsed columns (From/To/Cc/Subject/Date/Message-ID/In-Reply-To/
 * References), then the stored headers JSON (the lowercase-name map D13
 * persists — list-unsubscribe today) minus anything already emitted.
 * Body: multipart/alternative when both text and HTML survived, the one
 * part alone otherwise; with attachments the body block is wrapped in
 * multipart/mixed (the builder's task 8.5 shape). A message with neither
 * body nor attachments exports as headers only (valid RFC 822).
 */
export async function rebuildEml(
  executor: SqlExecutor,
  messageId: string,
  deps: EmlDeps = {}
): Promise<RebuiltEml | null> {
  const message = await getMessage(executor, messageId)
  if (!message) return null
  const fs = deps.fs ?? createPluginCacheFs()

  const unavailable: string[] = []
  const attachmentParts: string[] = []
  for (const attachment of message.attachments) {
    const base64 = (await readCachedBytes(attachment, fs)) ?? ""
    if (!base64) unavailable.push(attachment.filename ?? "attachment")
    attachmentParts.push(attachmentPart(attachment, base64))
  }

  const from = formatAddressList(fromRefs(message))
  const to = formatAddressList(parseContacts(message.to_json))
  const cc = formatAddressList(parseContacts(message.cc_json))
  const bcc = formatAddressList(parseContacts(message.bcc_json))

  const headers: string[] = []
  if (from) headers.push(`From: ${from}`)
  if (to) headers.push(`To: ${to}`)
  if (cc) headers.push(`Cc: ${cc}`)
  if (bcc) headers.push(`Bcc: ${bcc}`)
  if (message.subject) {
    headers.push(`Subject: ${encodeHeaderValue(message.subject)}`)
  }
  if (message.in_reply_to) {
    headers.push(`In-Reply-To: ${encodeHeaderValue(message.in_reply_to)}`)
  }
  if (message.references_header) {
    headers.push(`References: ${encodeHeaderValue(message.references_header)}`)
  }
  headers.push(`Date: ${formatDate(new Date(message.date * 1000))}`)
  // Import dedupe (task 19.3) keys on Message-ID, so absent originals get
  // a stable placeholder instead of none (module header: reconstruction).
  headers.push(
    `Message-ID: ${message.message_id_header ?? `<export-${message.id}@emailer.local>`}`
  )
  headers.push("MIME-Version: 1.0")

  const textPart =
    message.body_text !== null
      ? mimePart("text/plain; charset=UTF-8", message.body_text)
      : null
  const htmlPart =
    message.body_html !== null
      ? mimePart("text/html; charset=UTF-8", message.body_html)
      : null

  const boundary = `emailer_${randomHex(16)}`
  let body: string
  let contentType = ""
  let transferEncoding = ""
  if (attachmentParts.length > 0) {
    contentType = `multipart/mixed; boundary="${boundary}"`
    const bodyLead = bodyBlock(textPart, htmlPart)
    const mixedParts = attachmentParts.map(
      (part) => `--${boundary}${CRLF}${part}`
    )
    if (bodyLead) mixedParts.unshift(`--${boundary}${CRLF}${bodyLead}`)
    body = mixedParts.join(CRLF) + CRLF + `--${boundary}--`
  } else if (textPart && htmlPart) {
    contentType = `multipart/alternative; boundary="${boundary}"`
    body = bodyBlock(textPart, htmlPart)
  } else if (textPart || htmlPart) {
    // Single body part sits directly at the top level.
    contentType = textPart
      ? "text/plain; charset=UTF-8"
      : "text/html; charset=UTF-8"
    transferEncoding = "base64"
    body = base64WrappedText(
      (textPart ? message.body_text : message.body_html) ?? ""
    )
  } else {
    // Neither body nor attachments survived — headers only (valid RFC 822).
    body = ""
  }
  if (contentType) headers.push(`Content-Type: ${contentType}`)
  if (transferEncoding) {
    headers.push(`Content-Transfer-Encoding: ${transferEncoding}`)
  }

  // Stored extras (lowercase names, D13), skipping every header above so
  // no name can appear twice.
  const emitted = new Set(
    headers.map((header) => header.slice(0, header.indexOf(":")).toLowerCase())
  )
  for (const [name, value] of Object.entries(storedHeaders(message.headers))) {
    if (!emitted.has(name.toLowerCase())) {
      headers.push(`${name}: ${encodeHeaderValue(value)}`)
    }
  }

  return {
    eml: headers.join(CRLF) + CRLF + CRLF + body + (body ? CRLF : ""),
    unavailableAttachments: unavailable,
  }
}

/** The alternative block (or the lone part as-is) that leads
 * multipart/mixed when a body exists at all. */
function bodyBlock(textPart: string | null, htmlPart: string | null): string {
  if (textPart && htmlPart) {
    const boundary = `emailer_${randomHex(16)}`
    return [
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      "",
      [textPart, htmlPart]
        .map((part) => `--${boundary}${CRLF}${part}`)
        .join(CRLF) +
        CRLF +
        `--${boundary}--`,
    ].join(CRLF)
  }
  return textPart ?? htmlPart ?? ""
}

/** From refs from the parsed columns (mirrors the stored ContactRef). */
function fromRefs(message: {
  from_name: string | null
  from_address: string | null
}): ContactRef[] {
  if (!message.from_address && !message.from_name) return []
  return [
    {
      email: message.from_address ?? "",
      ...(message.from_name ? { name: message.from_name } : {}),
    },
  ]
}

/** Tolerant parse of the stored headers JSON (D13: lowercase name → value). */
function storedHeaders(json: string | null): Record<string, string> {
  if (!json) return {}
  try {
    const parsed: unknown = JSON.parse(json)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {}
    }
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(parsed)) {
      if (typeof value === "string") headers[name] = value
    }
    return headers
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// Filesystem export (thread → directory of .eml files)
// ---------------------------------------------------------------------------

/** The thread's messages as `.eml` files, through the injectable seams. */
export interface EmlExportDeps extends EmlDeps {
  /**
   * Directory picker; resolves the chosen absolute folder, or null when
   * the user cancels. Default: plugin-dialog open({ directory: true }).
   */
  pickDirectory?: () => Promise<string | null>
  /** Write bytes to an absolute path. Default: plugin-fs writeFile. */
  writeFile?: (absolutePath: string, data: Uint8Array) => Promise<void>
  /** Join the picked directory and a filename. Default: @tauri-apps/api
   * path join (separator-correct on every platform). */
  joinPath?: (directory: string, filename: string) => Promise<string>
}

export interface EmlExportResult {
  directory: string
  /** Absolute paths written, in thread-chronological order. */
  files: string[]
  /** Aggregated cache-miss attachments across the thread's messages. */
  unavailableAttachments: string[]
}

/** Filesystem-hostile characters and control codes, for exported names.
 * The control-character range is the point (filenames must not carry
 * them), so the no-control-regex rule is off by one line. */
// eslint-disable-next-line no-control-regex
const FILENAME_UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g

/** Sanitize any stored text (subject, label name) into a filename stem:
 * unsafe characters become hyphens, whitespace collapses, the stem is
 * capped (multibyte-safe) and never empty. */
export function sanitizeFileStem(raw: string | null | undefined): string {
  const stem =
    (raw ?? "")
      .replace(FILENAME_UNSAFE, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/, "") || "export"
  return Array.from(stem).slice(0, FILENAME_SUBJECT_MAX).join("")
}

/**
 * Sanitize a subject into a filename: `<subject>-<YYYY-MM-DD>.eml`.
 */
export function emlFilename(
  subject: string | null | undefined,
  dateSeconds: number
): string {
  const day = new Date(dateSeconds * 1000).toISOString().slice(0, 10)
  return `${sanitizeFileStem(subject)}-${day}.eml`
}

/**
 * "Export as EML" (task 19.1): pick a destination folder, write one
 * `<subject>-<date>.eml` per message of the thread, oldest first (the
 * conversation-view order). Name collisions get `-2`, `-3`, … suffixes
 * (compared case-insensitively for case-preserving filesystems).
 * Resolves null when the user cancels the dialog or the thread has no
 * messages. Read-only over the database — export never modifies rows.
 */
export async function exportThreadAsEml(
  executor: SqlExecutor,
  threadId: string,
  deps: EmlExportDeps = {}
): Promise<EmlExportResult | null> {
  const messages = await listMessagesByThread(executor, threadId)
  if (messages.length === 0) return null

  const pickDirectory = deps.pickDirectory ?? defaultPickDirectory
  const directory = await pickDirectory()
  if (!directory) return null

  const writeFile = deps.writeFile ?? defaultWriteFile
  const joinPath = deps.joinPath ?? join
  const usedNames = new Set<string>()
  const files: string[] = []
  const unavailableAttachments: string[] = []
  const encoder = new TextEncoder()

  for (const message of messages) {
    const rebuilt = await rebuildEml(executor, message.id, deps)
    if (!rebuilt) continue
    unavailableAttachments.push(...rebuilt.unavailableAttachments)
    const stem = emlFilename(message.subject, message.date).slice(0, -4)
    let name = `${stem}.eml`
    for (let counter = 2; usedNames.has(name.toLowerCase()); counter += 1) {
      name = `${stem}-${counter}.eml`
    }
    usedNames.add(name.toLowerCase())
    const path = await joinPath(directory, name)
    await writeFile(path, encoder.encode(rebuilt.eml))
    files.push(path)
  }

  return { directory, files, unavailableAttachments }
}

async function defaultPickDirectory(): Promise<string | null> {
  return openFileDialog({
    directory: true,
    multiple: false,
    title: "Choose export folder",
  })
}

async function defaultWriteFile(
  absolutePath: string,
  data: Uint8Array
): Promise<void> {
  // Absolute target: no baseDir. The dialog plugin has already widened
  // the fs runtime scope to include the picked directory.
  await fsWriteFile(absolutePath, data)
}
