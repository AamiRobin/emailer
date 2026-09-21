import type * as OpenPGP from "openpgp"

import {
  encryptMime,
  signAndEncryptMime,
  signMime,
  type PgpMode,
} from "../crypto/pgp-transform"
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
 *
 * Task 18.5 (design D11): the PGP send path composes this builder with
 * the RFC 3156 transforms (buildMimeMessagePgp below) — the sign/encrypt
 * crypto itself lives in crypto/pgp-transform.ts, which loads openpgp.js
 * lazily; this module only routes to it, so the non-PGP path stays
 * byte-identical and the openpgp chunk stays out of the static graph.
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

// ---- Inline body images (batch C2) ----

/**
 * One inline image extracted from the composer's body HTML at MIME build
 * time. The composer keeps `data:image/...;base64,` srcs everywhere
 * (editor, drafts, undo snapshots); only this builder rewrites them to
 * `cid:` references and emits the matching multipart/related parts.
 */
export interface InlineImagePart {
  /** Content-ID header value WITH angle brackets ("<img-...@emailer>"). */
  contentIdHeader: string
  /** The cid: reference the HTML src was rewritten to (no brackets). */
  contentId: string
  mimeType: string
  contentBase64: string
  filename: string
}

/** Subtype → file extension for the inline part's name parameter. */
function extensionForImageType(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.split(".")[0] ?? "bin"
  return subtype === "jpeg" ? "jpg" : subtype
}

const INLINE_IMAGE_ID_DOMAIN = "emailer"

/**
 * Extract every double-quoted `data:image/...;base64,` src from the body
 * HTML, rewrite each to `src="cid:<generated id>"` and report the parts
 * the builder must emit. Pure and order-stable: the parts come back in
 * first-appearance order. Everything else in the HTML passes through
 * byte-identical, so a body without data: images round-trips unchanged.
 */
export function extractInlineImages(html: string): {
  html: string
  images: InlineImagePart[]
} {
  const images: InlineImagePart[] = []
  const rewritten = html.replace(
    /src="data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)"/gi,
    (_match, mimeType: string, base64: string) => {
      const id = `img-${randomHex(8)}@${INLINE_IMAGE_ID_DOMAIN}`
      images.push({
        contentIdHeader: `<${id}>`,
        contentId: id,
        mimeType: mimeType.toLowerCase(),
        contentBase64: base64,
        filename: `image-${images.length + 1}.${extensionForImageType(mimeType.toLowerCase())}`,
      })
      return `src="cid:${id}"`
    }
  )
  return { html: rewritten, images }
}

/** Cheap existence check (the imap provider routes such sends through the
 * TS-built MIME instead of the Rust builder, which emits no related
 * parts). */
export function hasInlineImages(html: string | undefined | null): boolean {
  return !!html && /src="data:image\/[^;]+;base64,/i.test(html)
}

/** One inline image part: base64 body, Content-ID for the cid: refs,
 * Content-Disposition inline (NOT attachment — the decomposer and every
 * receiving client key on the disposition). */
function inlineImagePart(image: InlineImagePart): string {
  const filename = formatFilenameParam(image.filename)
  return [
    `Content-Type: ${image.mimeType}; name=${filename}`,
    `Content-Transfer-Encoding: base64`,
    `Content-ID: ${image.contentIdHeader}`,
    `Content-Disposition: inline; filename=${filename}`,
    "",
    wrapBase64Lines(image.contentBase64),
  ].join(CRLF)
}

/**
 * The multipart/related wrapper (batch C2): the alternative block (whose
 * HTML carries the cid: refs) as part #1, one inline image part per
 * extracted image after it. The caller owns the boundary so it can emit
 * the matching top-level Content-Type.
 */
function relatedPart(
  alternative: string,
  images: InlineImagePart[],
  boundary: string
): string {
  return [
    `Content-Type: multipart/related; boundary="${boundary}"`,
    "",
    [
      `--${boundary}${CRLF}${alternative}`,
      ...images.map(
        (image) => `--${boundary}${CRLF}${inlineImagePart(image)}`
      ),
    ].join(CRLF) +
      CRLF +
      `--${boundary}--`,
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
 * with one base64 part per attachment. With inline images (batch C2) the
 * data-URL srcs in the HTML are extracted into Content-ID'd parts: the
 * alternative block then nests inside multipart/related (top level when
 * there are no attachments, inside the mixed wrapper otherwise — the
 * standard mixed{related{alternative}} shape). Bcc is kept in the MIME
 * headers (Gmail's messages.send delivers to MIME Bcc recipients).
 *
 * Design D10 (task 16.2): when the input carries `fromAlias`, the From
 * HEADER is built from the alias (address + display name) — send-as —
 * while `input.from` remains the envelope identity that stays out of the
 * MIME entirely (the Gmail API user / SMTP MAIL FROM is supplied by the
 * transport, not by this header).
 */
export function buildMimeMessage(input: SendEmailInput): BuiltMime {
  const messageId = input.messageId ?? generateMessageId(input.from.email)

  // Inline images (batch C2): rewrite the body once, up front. When no
  // data:image src is present the html string comes back identical, so
  // the no-inline output stays byte-compatible with earlier versions.
  const extracted = input.htmlBody
    ? extractInlineImages(input.htmlBody)
    : { html: input.htmlBody, images: [] as InlineImagePart[] }
  const effective: SendEmailInput =
    extracted.images.length > 0 ? { ...input, htmlBody: extracted.html } : input
  const inlineImages = extracted.images

  const headers: string[] = []
  headers.push(`From: ${formatAddress(input.fromAlias ?? input.from)}`)
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

  const attachments = effective.attachments ?? []
  let body: string
  if (attachments.length === 0 && inlineImages.length === 0) {
    const boundary = `emailer_${randomHex(16)}`
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`)
    body = alternativePart(effective, boundary)
  } else if (attachments.length === 0) {
    // Inline images only: related at the top level.
    const relatedBoundary = `emailer_${randomHex(16)}`
    headers.push(
      `Content-Type: multipart/related; boundary="${relatedBoundary}"`
    )
    body = relatedPart(
      alternativePart(effective, `emailer_${randomHex(16)}`),
      inlineImages,
      relatedBoundary
    )
  } else if (inlineImages.length === 0) {
    const boundary = `emailer_${randomHex(16)}`
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)
    body =
      [
        `--${boundary}${CRLF}${alternativePart(effective, `emailer_${randomHex(16)}`)}`,
        ...attachments.map(
          (attachment) => `--${boundary}${CRLF}${attachmentPart(attachment)}`
        ),
      ].join(CRLF) +
      CRLF +
      `--${boundary}--`
  } else {
    // Attachments AND inline images: mixed{related{alternative}, images},
    // then the file attachments.
    const boundary = `emailer_${randomHex(16)}`
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)
    body =
      [
        `--${boundary}${CRLF}${relatedPart(
          alternativePart(effective, `emailer_${randomHex(16)}`),
          inlineImages,
          `emailer_${randomHex(16)}`
        )}`,
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

// ---- PGP/MIME send (task 18.5, design D11) ----

/**
 * The PGP options buildMimeMessagePgp applies after the plain build.
 * `signingKey` is the UNLOCKED account private key (getDecryptedPrivateKey)
 * required for the sign modes; `encryptionArmors` are the recipients'
 * public keys — plus the sender's own for encrypt-to-self — required for
 * the encrypt modes. All openpgp work happens inside crypto/
 * pgp-transform.ts (lazily); these are pass-through values.
 */
export interface PgpMimeOptions {
  mode: PgpMode
  signingKey?: OpenPGP.PrivateKey
  encryptionArmors?: string[]
}

/**
 * Build the outgoing message and, when `pgp` is given, transform it into
 * RFC 3156 PGP/MIME (async — the transforms load openpgp.js on demand).
 * Without `pgp` the result is exactly buildMimeMessage's: the non-PGP
 * path stays byte-identical. The returned Message-ID is the input's —
 * the wrapper keeps every top-level header, so queue deduplication and
 * the provisional Sent row's reconciliation are unaffected.
 */
export async function buildMimeMessagePgp(
  input: SendEmailInput,
  pgp: PgpMimeOptions
): Promise<BuiltMime> {
  const built = buildMimeMessage(input)
  if (pgp.mode === "sign") {
    if (!pgp.signingKey) {
      throw new Error("signing requires the account's decrypted private key")
    }
    return signMime({ built, signingKey: pgp.signingKey })
  }
  const encryptionArmors = pgp.encryptionArmors
  if (!encryptionArmors || encryptionArmors.length === 0) {
    throw new Error("encryption requires at least one recipient public key")
  }
  if (pgp.mode === "encrypt") {
    return encryptMime({ built, encryptionArmors })
  }
  if (!pgp.signingKey) {
    throw new Error("signing requires the account's decrypted private key")
  }
  return signAndEncryptMime({
    built,
    signingKey: pgp.signingKey,
    encryptionArmors,
  })
}

// ---- Round-trip extraction (task 10.3) ----
//
// Pure inverses of the builder above, used ONLY on messages this app
// built (scheduled_sends.mime_payload). Received-mail parsing stays in the
// Rust mailparse stack — these helpers deliberately handle just the shape
// buildMimeMessage emits: CRLF lines, base64-encoded part bodies, RFC 2047
// encoded-words, multipart/mixed around multipart/alternative.

/** Standard padded base64 → raw bytes (the bytesToBase64 inverse). */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/** base64 part body → UTF-8 text (same decode the test helpers use). */
function decodeBase64Utf8(base64: string): string {
  return new TextDecoder().decode(base64ToBytes(base64))
}

/** Decode RFC 2047 encoded-words back to plain text. RFC 2047 §6.2:
 * linear whitespace BETWEEN two adjacent encoded-words is a folding
 * artifact (the builder joins chunks with CRLF + space) and is ignored —
 * strip it before decoding so a chunked header round-trips byte-exact. */
function decodeEncodedWords(value: string): string {
  return value
    .replace(/(\?=)[ \t]+(=\?[^?]+\?[bBqB]\?)/g, "$1$2")
    .replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]+)\?=/gi, (_, base64: string) =>
      decodeBase64Utf8(base64)
    )
}

/** One header of a message/part: lowercased name → unfolded value. */
function parseHeaderMap(headerLines: string[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const line of headerLines) {
    const colon = line.indexOf(":")
    if (colon === -1) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    // Unfolding (continuation lines joined by the caller) already happened;
    // strip the folding whitespace here.
    const value = line
      .slice(colon + 1)
      .replace(/^[ \t]+/, "")
      .trim()
    if (!(name in headers)) headers[name] = value
  }
  return headers
}

/**
 * Split an address list on commas that are outside double quotes. Runs
 * BEFORE encoded-word decoding on purpose: base64 encoded-words never
 * contain commas, while a decoded display name may ("Doe, John").
 */
function splitAddressList(value: string): string[] {
  const entries: string[] = []
  let current = ""
  let inQuotes = false
  for (const char of value) {
    if (char === '"') inQuotes = !inQuotes
    if (char === "," && !inQuotes) {
      entries.push(current)
      current = ""
      continue
    }
    current += char
  }
  entries.push(current)
  return entries
}

/** One `name <email>` / `email` entry → an EmailAddress (null when empty). */
function parseAddressEntry(entry: string): EmailAddress | null {
  // Decode before parsing so an encoded display name becomes plain text;
  // the builder only emits encoded-words OUTSIDE quotes.
  const decoded = decodeEncodedWords(entry).trim()
  if (!decoded) return null
  const lt = decoded.lastIndexOf("<")
  const gt = decoded.lastIndexOf(">")
  if (lt !== -1 && gt !== -1 && gt > lt) {
    let name = decoded.slice(0, lt).trim()
    if (name.startsWith('"') && name.endsWith('"')) {
      name = name.slice(1, -1).replace(/\\"/g, '"')
    }
    return {
      email: decoded.slice(lt + 1, gt).trim(),
      ...(name ? { name } : {}),
    }
  }
  return { email: decoded }
}

function parseAddressHeader(value: string | undefined): EmailAddress[] {
  if (!value) return []
  return splitAddressList(value)
    .map(parseAddressEntry)
    .filter((address): address is EmailAddress => address !== null)
}

/** The decomposed fields the edit round-trip needs from a stored payload. */
export interface DecomposedMimeMessage {
  /**
   * The parsed From header, or null when it is missing/unparseable. Used
   * by the scheduled-send edit flow to preselect the composer's From
   * picker (task 16.2: a scheduled-from-alias message must re-send from
   * the alias). The display name is DECODED here — unlike processor.ts's
   * storedFrom, which keeps encoded-words for the verbatim-replay path,
   * this name re-enters buildMimeMessage via the composer, which encodes
   * exactly once.
   */
  from: EmailAddress | null
  to: EmailAddress[]
  cc: EmailAddress[]
  bcc: EmailAddress[]
  subject: string | null
  /**
   * The decoded text/plain part body, or null when the message had no
   * plain-text part. Shared contract with processor.ts's SMTP-fallback
   * rebuild (same charsets/transfer-encodings as the html branch).
   */
  textBody: string | null
  /** The text/html part body, or null when the message had no HTML part. */
  htmlBody: string | null
  /** Attachment parts (filename, type, base64 content) in message order. */
  attachments: OutgoingAttachment[]
}

/**
 * Decompose a MIME message built by buildMimeMessage back into its
 * composer-shaped fields (task 10.3's edit round-trip). Walks the raw
 * lines and splits parts at every known multipart boundary (both the
 * mixed and the nested alternative boundary appear in Content-Type
 * headers, so the flat walk reaches nested parts). Base64 bodies never
 * start with "--" (the standard alphabet has no hyphen), so boundary
 * detection cannot swallow part content. Unparseable pieces come back
 * empty/null rather than throwing — a corrupt stored payload degrades to
 * an edit with whatever survived.
 */
export function decomposeMimeMessage(mime: string): DecomposedMimeMessage {
  const lines = mime.split(/\r\n/)

  // Boundaries are only ever announced in Content-Type headers.
  const boundaries = new Set<string>()
  for (const line of lines) {
    const match = line.match(/boundary="([^"]+)"/)
    if (match) boundaries.add(match[1])
  }

  const result: DecomposedMimeMessage = {
    from: null,
    to: [],
    cc: [],
    bcc: [],
    subject: null,
    textBody: null,
    htmlBody: null,
    attachments: [],
  }

  // Walk top-level headers until the first blank line, then parts.
  const headerLines: string[] = []
  let index = 0
  for (; index < lines.length && lines[index] !== ""; index += 1) {
    headerLines.push(lines[index])
  }
  // Fold continuation lines (value continues with leading whitespace).
  const unfolded: string[] = []
  for (const line of headerLines) {
    if (/^[ \t]/.test(line) && unfolded.length > 0) {
      unfolded[unfolded.length - 1] += ` ${line.trim()}`
    } else {
      unfolded.push(line)
    }
  }
  const topHeaders = parseHeaderMap(unfolded)
  result.from = parseAddressHeader(topHeaders.from)[0] ?? null
  result.to = parseAddressHeader(topHeaders.to)
  result.cc = parseAddressHeader(topHeaders.cc)
  result.bcc = parseAddressHeader(topHeaders.bcc)
  if (topHeaders.subject) {
    const subject = decodeEncodedWords(topHeaders.subject).trim()
    result.subject = subject === "" ? null : subject
  }

  // Each part: header block, blank line, body lines until the next
  // boundary (or end). Boundaries close the part in progress.
  let partHeaders: string[] = []
  let partBody: string[] = []
  let inPartHeaders = false
  /** Inline image parts (batch C2), collected for the cid: → data:
   * restoration below (htmlBody may appear before its image parts). */
  const inlineImages: {
    contentId: string
    mimeType: string
    contentBase64: string
  }[] = []
  const flushPart = (): void => {
    if (partHeaders.length === 0 && partBody.length === 0) return
    const headers = parseHeaderMap(partHeaders)
    const contentType = headers["content-type"] ?? ""
    const disposition = headers["content-disposition"] ?? ""
    const base64 = partBody.join("").trim()
    // Disposition FIRST: a part carrying Content-Disposition: attachment
    // is an attachment whatever its Content-Type says (a notes.html file
    // is text/html) — testing the type first used to clobber htmlBody
    // with the attachment's content and drop the file.
    if (/attachment/i.test(disposition) && base64) {
      const mimeType = contentType.split(";")[0]?.trim() || undefined
      const filenameMatch = disposition.match(/filename="((?:[^"\\]|\\.)*)"/)
      const filename = filenameMatch
        ? decodeEncodedWords(
            filenameMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\")
          )
        : "attachment"
      result.attachments.push({
        filename,
        ...(mimeType !== undefined ? { mimeType } : {}),
        contentBase64: base64,
      })
    } else if (/text\/html/i.test(contentType) && base64) {
      result.htmlBody = decodeBase64Utf8(base64)
    } else if (/text\/plain/i.test(contentType) && base64) {
      // Same decode as the html branch (base64 + UTF-8, the only shape
      // this app's builder emits) — shared with processor.ts.
      result.textBody = decodeBase64Utf8(base64)
    } else if (/^image\//i.test(contentType.split(";")[0]?.trim() ?? "")) {
      // Inline body images (batch C2): disposition inline, Content-ID
      // addressed. Collected here, substituted into htmlBody after the
      // walk (the alternative block precedes the image parts).
      const mimeType = contentType.split(";")[0]?.trim() ?? ""
      const contentId = (headers["content-id"] ?? "")
        .trim()
        .replace(/^<+/, "")
        .replace(/>+$/, "")
      if (contentId !== "") {
        inlineImages.push({ contentId, mimeType, contentBase64: base64 })
      }
    }
    partHeaders = []
    partBody = []
    inPartHeaders = false
  }

  for (; index < lines.length; index += 1) {
    const line = lines[index]
    const boundaryMatch = line.match(/^--(.*)$/)
    if (boundaryMatch && boundaries.has(boundaryMatch[1])) {
      flushPart()
      inPartHeaders = true
      continue
    }
    if (
      boundaryMatch &&
      boundaryMatch[1].endsWith("--") &&
      boundaries.has(boundaryMatch[1].slice(0, -2))
    ) {
      flushPart()
      continue
    }
    if (inPartHeaders) {
      if (line === "") {
        inPartHeaders = false
      } else {
        if (/^[ \t]/.test(line) && partHeaders.length > 0) {
          partHeaders[partHeaders.length - 1] += ` ${line.trim()}`
        } else {
          partHeaders.push(line)
        }
      }
      continue
    }
    partBody.push(line)
  }
  flushPart()

  // Inline images (batch C2): map every cid: ref back to its data URL so
  // the edit round-trip keeps the pictures — the composer body carries
  // data: srcs and never cid: ones.
  if (result.htmlBody && inlineImages.length > 0) {
    for (const image of inlineImages) {
      const escaped = image.contentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      result.htmlBody = result.htmlBody.replace(
        new RegExp(`cid:${escaped}`, "g"),
        `data:${image.mimeType};base64,${image.contentBase64}`
      )
    }
  }

  return result
}
