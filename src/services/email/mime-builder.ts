import type { EmailAddress, OutgoingAttachment, SendEmailInput } from "./types"

/**
 * Pure RFC 5322 / RFC 2047 MIME construction for outgoing messages
 * (design D8: "Sent messages are MIME multipart/alternative (HTML plus a
 * generated plain-text part)"). No fetch, no provider — gmail-provider.ts
 * base64url-encodes the built message and hands it to messages.send; the
 * same builder is unit-testable without any I/O.
 *
 * Non-ASCII header values (subjects, display names) are encoded as RFC
 * 2047 base64 encoded-words, chunked to stay under the 75-character
 * encoded-word limit. Bodies use base64 Content-Transfer-Encoding with
 * UTF-8 so arbitrary text survives any relay.
 *
 * Task 8.5: when the input carries attachments, the alternative block is
 * wrapped in a multipart/mixed part with one base64 attachment part per
 * file (Content-Disposition: attachment) — the standard MIME shape both
 * providers transmit (SMTP via lettre's equivalent structure, Gmail via
 * this very string).
 */

const CRLF = "\r\n"
const BASE64_LINE_LENGTH = 76
const ENCODED_WORD_MAX_BYTES = 30

export interface BuiltMime {
  /** The complete RFC 822 message (CRLF line endings). */
  mime: string
  /** The Message-ID header value, e.g. "<1700000000.abc@sender.example>". */
  messageId: string
}

/** True when every character is within ASCII (no RFC 2047 encoding needed). */
export function isAscii(text: string): boolean {
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) > 127) return false
  }
  return true
}

/** Standard padded base64 of UTF-8 text (chunked so large bodies stay
 * stack-safe). */
function base64OfText(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

/** Standard padded base64 of raw bytes (attachment content on the wire,
 * task 8.5 — mirrors what the Rust side decodes with base64::STANDARD). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

/** Gmail wire encoding: base64url (RFC 4648 §5, unpadded) of UTF-8 text. */
export function stringToBase64Url(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text))
}

/** Gmail wire encoding: base64url (unpadded) of raw bytes. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * Encode a header value: header-injection newlines are unfolded to
 * spaces, and non-ASCII values become RFC 2047 base64 encoded-words
 * (chunked on code-point boundaries so multibyte characters survive).
 */
export function encodeHeaderValue(value: string): string {
  const sanitized = value.replace(/\r?\n[\t ]*/g, " ")
  if (isAscii(sanitized)) return sanitized
  const encoder = new TextEncoder()
  const chunks: string[] = []
  let current = ""
  let currentBytes = 0
  for (const char of sanitized) {
    const size = encoder.encode(char).length
    if (current && currentBytes + size > ENCODED_WORD_MAX_BYTES) {
      chunks.push(current)
      current = ""
      currentBytes = 0
    }
    current += char
    currentBytes += size
  }
  if (current) chunks.push(current)
  return chunks
    .map((chunk) => `=?UTF-8?B?${base64OfText(chunk)}?=`)
    .join(CRLF + " ")
}

function needsQuoting(name: string): boolean {
  return /["(),.:;<>@[\]\\]/.test(name)
}

/** RFC 5322 address: `Name <local@domain>` with quoting / RFC 2047 as needed.
 * Header-injection hardening: CR/LF in the email is stripped outright, and
 * names carrying newlines go through encodeHeaderValue (unfolded to spaces). */
export function formatAddress(address: EmailAddress): string {
  const email = (address.email ?? "").replace(/[\r\n]+/g, "")
  if (!address.name) return email
  if (!isAscii(address.name) || /[\r\n]/.test(address.name)) {
    return `${encodeHeaderValue(address.name)} <${email}>`
  }
  if (needsQuoting(address.name)) {
    return `"${address.name.replace(/"/g, '\\"')}" <${email}>`
  }
  return `${address.name} <${email}>`
}

/** Comma-joined address list; entries without an email are skipped. */
export function formatAddressList(addresses: EmailAddress[]): string {
  return addresses
    .filter((address) => address.email)
    .map(formatAddress)
    .join(", ")
}

/** RFC 5322 date: "Sat, 14 Sep 2026 10:00:00 +0000". */
export function formatDate(date: Date): string {
  return date.toUTCString().replace(/GMT$/, "+0000")
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

/** Fresh Message-ID anchored at the sender's domain. */
export function generateMessageId(fromEmail: string): string {
  const domain = fromEmail.includes("@")
    ? (fromEmail.split("@").pop() ?? "emailer.local")
    : "emailer.local"
  return `<${Date.now()}.${randomHex(8)}@${domain}>`
}

/**
 * Crude HTML → plain-text fallback (design D8's "generated plain-text
 * part"): drop script/style blocks, break on block-level tags, strip the
 * remaining tags and decode the entities the composer produces.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Line-wrap an already-base64 string at 76 chars (RFC 2045). Safe to cut
 * anywhere — base64 carries no per-line alignment. */
function wrapBase64Lines(base64: string): string {
  const lines: string[] = []
  for (let offset = 0; offset < base64.length; offset += BASE64_LINE_LENGTH) {
    lines.push(base64.slice(offset, offset + BASE64_LINE_LENGTH))
  }
  return lines.join(CRLF)
}

function base64Wrapped(text: string): string {
  return wrapBase64Lines(base64OfText(text))
}

function mimePart(contentType: string, body: string): string {
  return [
    `Content-Type: ${contentType}`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Wrapped(body),
  ].join(CRLF)
}

/**
 * Header-safe quoted parameter value for attachment filenames: quotes and
 * backslashes are escaped, newlines are unfolded (header injection), and
 * non-ASCII names become RFC 2047 encoded-words inside the quoted string
 * (the pragmatic form major clients accept).
 */
function formatFilenameParam(filename: string): string {
  const escaped = filename.replace(/[\\"]/g, "\\$&")
  return `"${encodeHeaderValue(escaped)}"`
}

/** One attachment part (task 8.5): base64 body, Content-Disposition
 * attachment. The content arrives already base64 from SendEmailInput, so
 * it only needs line-wrapping. Unknown MIME types fall back to
 * application/octet-stream. */
function attachmentPart(attachment: OutgoingAttachment): string {
  const mimeType = attachment.mimeType?.trim() || "application/octet-stream"
  const filename = formatFilenameParam(attachment.filename)
  return [
    `Content-Type: ${mimeType}; name=${filename}`,
    `Content-Disposition: attachment; filename=${filename}`,
    "Content-Transfer-Encoding: base64",
    "",
    wrapBase64Lines(attachment.contentBase64),
  ].join(CRLF)
}

/**
 * The multipart/alternative body (generated plain text + HTML) as one
 * nested MIME part: the whole message when there are no attachments, and
 * part #1 of the multipart/mixed wrapper otherwise (task 8.5). The caller
 * owns the boundary so it can emit the matching top-level Content-Type.
 */
function alternativePart(input: SendEmailInput, boundary: string): string {
  const text = input.textBody ?? htmlToText(input.htmlBody ?? "")
  const parts = [mimePart("text/plain; charset=UTF-8", text)]
  if (input.htmlBody !== undefined) {
    parts.push(mimePart("text/html; charset=UTF-8", input.htmlBody))
  }
  return [
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    parts.map((part) => `--${boundary}${CRLF}${part}`).join(CRLF) +
      CRLF +
      `--${boundary}--`,
  ].join(CRLF)
}

/**
 * Build the full RFC 822 message for a send. The base is always
 * multipart/alternative: the plain-text part is the explicit textBody or
 * one generated from the HTML; the HTML part is included when provided.
 * With attachments (task 8.5) that block is wrapped in multipart/mixed
 * with one base64 part per attachment. Bcc is kept in the MIME headers
 * (Gmail's messages.send delivers to MIME Bcc recipients).
 */
export function buildMimeMessage(input: SendEmailInput): BuiltMime {
  const messageId = input.messageId ?? generateMessageId(input.from.email)

  const headers: string[] = []
  headers.push(`From: ${formatAddress(input.from)}`)
  const to = formatAddressList(input.to)
  if (to) headers.push(`To: ${to}`)
  const cc = formatAddressList(input.cc ?? [])
  if (cc) headers.push(`Cc: ${cc}`)
  const bcc = formatAddressList(input.bcc ?? [])
  if (bcc) headers.push(`Bcc: ${bcc}`)
  headers.push(`Subject: ${encodeHeaderValue(input.subject)}`)
  // In-Reply-To/References echo hostile received headers — run them
  // through the same unfold/strip as every other header value so a
  // CR/LF inside can never start a new header line.
  if (input.inReplyTo) {
    headers.push(`In-Reply-To: ${encodeHeaderValue(input.inReplyTo)}`)
  }
  if (input.references) {
    headers.push(`References: ${encodeHeaderValue(input.references)}`)
  }
  headers.push(`Date: ${formatDate(new Date())}`)
  headers.push(`Message-ID: ${messageId}`)
  headers.push("MIME-Version: 1.0")

  const attachments = input.attachments ?? []
  let body: string
  if (attachments.length === 0) {
    const boundary = `emailer_${randomHex(16)}`
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    body = alternativePart(input, boundary)
  } else {
    const boundary = `emailer_${randomHex(16)}`
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)
    body =
      [
        `--${boundary}${CRLF}${alternativePart(input, `emailer_${randomHex(16)}`)}`,
        ...attachments.map(
          (attachment) => `--${boundary}${CRLF}${attachmentPart(attachment)}`
        ),
      ].join(CRLF) +
      CRLF +
      `--${boundary}--`
  }

  const mime = headers.join(CRLF) + CRLF + CRLF + body + CRLF
  return { mime, messageId }
}
