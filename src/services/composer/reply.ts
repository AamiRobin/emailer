import type { ComposerMode, Recipient } from "@/stores/composer-store"

import type { ContactRef, MessageRow } from "../db/messages"
import { parseContacts } from "../db/messages"
import { sanitizeEmailHtml } from "../renderer"
import { parseReferences } from "../sync/threading"
import { appendSignature, COMPOSER_BLOCK_SEPARATOR } from "./signatures"

/**
 * Reply / reply-all / forward builders (task 8.4): pure functions that turn
 * (message, thread, account) into a composer prefill — the `ComposerMode`
 * payload plus recipients, subject and body HTML. No db, no clock, no
 * store access: everything is derived from the arguments, so the addressing
 * and quoting rules unit-test in isolation. The signature is passed in as
 * a string; the integration fetches it via signatures.getSignature.
 *
 * ── Integration recipe for the composer (8.4 UI half) ────────────────
 * The user hits Reply / Reply-all / Forward on a message. Thread-level
 * actions use the thread's latest message as the reply target:
 *
 *   import { buildReply, buildForward } from "@/services/composer/reply"
 *   import { getSignature } from "@/services/composer/signatures"
 *   import { getExecutor } from "@/services/db/executor"
 *   import { getThreadWithMessages } from "@/services/db/threads"
 *   import { getAccount } from "@/services/db/accounts"
 *   import { useComposerStore } from "@/stores/composer-store"
 *
 *   const executor = getExecutor()
 *   const withMessages = await getThreadWithMessages(executor, threadId)
 *   const message = withMessages.messages[withMessages.messages.length - 1]
 *   const account = await getAccount(executor, accountId)   // needs id + email
 *   const signatureHtml = await getSignature(executor, accountId)
 *
 *   const prefill = buildReply({
 *     message, thread: withMessages.thread, account,
 *     replyAll: true | false, signatureHtml,
 *   })
 *   // …or, for forward:
 *   const prefill = buildForward({ message, thread: withMessages.thread, account, signatureHtml })
 *
 *   const composer = useComposerStore.getState()
 *   composer.openWith(prefill.mode, accountId)
 *   composer.setTo(prefill.to)
 *   composer.setCc(prefill.cc)
 *   composer.setSubject(prefill.subject)
 *   composer.setHtml(prefill.html)
 *
 * `prefill.mode` is exactly the store's reply/forward branch (source ids,
 * In-Reply-To, References and the quoted-history HTML for task 8.6's
 * draft resume), and `prefill.html` already embeds the quote below the
 * signature, so the setters above are the whole prefill. The tip of the
 * References chain is `message.message_id_header` — i.e. the message the
 * user is answering — so the outgoing In-Reply-To/References headers wire
 * the reply back into the same server thread (task 8.7 forwards them from
 * the mode into SendEmailInput).
 *
 * Quoting decisions:
 * - Gmail-style quote header "On <date>, <sender> wrote:" over a semantic
 *   `<blockquote>` wrapping the original body (HTML sanitized with
 *   remote images blocked — see quotedOriginal; plain-text bodies as
 *   escaped text in a `data-emailer-plaintext` div, which the
 *   reading-pane base stylesheet already renders pre-wrap). Dates render
 *   in UTC so the pure builders stay deterministic across machines.
 * - Markup is semantic only (p/div/blockquote/br) with no style
 *   attributes — the email sanitizer strips styles. The safe iframe's
 *   base stylesheet (src/components/email/safe-email-frame.tsx) currently
 *   injects no blockquote rule, so quotes fall back to the browser's
 *   default indent; any visual polish (left border, muted color) belongs
 *   to that renderer-owned stylesheet, deliberately not touched here.
 *
 * Addressing decisions (spec "Reply all addressing"):
 * - Reply → sender only; if the message is from the user's own account,
 *   the reply goes to the original To list instead (reply-to-self).
 * - Reply-all → sender plus original To, then original Cc, excluding the
 *   account's own address, deduplicated case-insensitively (a later
 *   duplicate fills in a display name the earlier entry lacked, so name
 *   variants collapse onto one chip).
 * - Forward → no recipients; the user picks them.
 */

/** Minimal account shape the builders need (AccountRow satisfies it). */
export interface ComposerAccount {
  id: string
  email: string
}

/** Minimal thread shape (ThreadRow satisfies it). */
export interface ComposerThread {
  id: string
}

export interface BuildReplyInput {
  /** The message being answered — a row from getThreadWithMessages. */
  message: MessageRow
  /** Thread the message lives in (the reply lands back in this thread). */
  thread: ComposerThread
  /** Account the reply is composed from (its identity + self filter). */
  account: ComposerAccount
  /** Reply-all expands to sender + original To/Cc minus self. */
  replyAll: boolean
  /** Account signature (signatures.getSignature); placed above the quote. */
  signatureHtml?: string
}

export interface BuildForwardInput {
  message: MessageRow
  thread: ComposerThread
  account: ComposerAccount
  signatureHtml?: string
}

/** What the composer integration feeds straight into the store setters. */
export interface ComposerPrefill {
  mode: ComposerMode
  to: Recipient[]
  cc: Recipient[]
  subject: string
  html: string
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
]

/**
 * Quote/forward-header date: "Nov 14, 2023, 10:13 PM". UTC on purpose —
 * the builders are pure and must not render differently per machine TZ.
 */
export function formatQuoteDate(epochSeconds: number): string {
  const date = new Date(epochSeconds * 1000)
  if (Number.isNaN(date.getTime())) return ""
  const hours = date.getUTCHours()
  const hour12 = hours % 12 === 0 ? 12 : hours % 12
  const minutes = String(date.getUTCMinutes()).padStart(2, "0")
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}, ${hour12}:${minutes} ${hours >= 12 ? "PM" : "AM"}`
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/** "Name <email>" (or bare email) for quote/forward headers. */
function contactLabel(name: string | null, email: string | null): string {
  const address = (email ?? "").trim()
  if (!address) return (name ?? "").trim()
  const display = (name ?? "").trim()
  return display ? `${display} <${address}>` : address
}

/** Comma-joined "Name <email>" list; empty contacts render as "". */
function contactListLabel(contacts: ContactRef[]): string {
  return contacts
    .map((contact) => contactLabel(contact.name ?? null, contact.email))
    .filter(Boolean)
    .join(", ")
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

function toRecipient(contact: ContactRef): Recipient | null {
  const email = contact.email?.trim()
  if (!email) return null
  const name = contact.name?.trim()
  return name ? { name, email } : { email }
}

/**
 * Flatten candidate groups (in To→Cc priority order) into one deduplicated
 * recipient list. Emails compare case-insensitively; the first occurrence
 * wins its position and a later duplicate only fills in a missing name.
 */
function collectRecipients(groups: ContactRef[][]): Recipient[] {
  const byEmail = new Map<string, Recipient>()
  for (const group of groups) {
    for (const contact of group) {
      const recipient = toRecipient(contact)
      if (!recipient) continue
      const key = normalizeEmail(recipient.email)
      const existing = byEmail.get(key)
      if (!existing) {
        byEmail.set(key, recipient)
      } else if (!existing.name && recipient.name) {
        byEmail.set(key, { ...existing, name: recipient.name })
      }
    }
  }
  return [...byEmail.values()]
}

/** Drop the account's own address (case-insensitive) from a list. */
function excludeSelf(recipients: Recipient[], selfEmail: string): Recipient[] {
  const self = normalizeEmail(selfEmail)
  if (!self) return recipients
  return recipients.filter(
    (recipient) => normalizeEmail(recipient.email) !== self
  )
}

/**
 * Subject with exactly one leading prefix ("Re: " / "Fwd: "): any run of
 * the same prefix ("Re: Re: x", "RE: re:  x", "Fw:/Fwd:" for forwards) is
 * collapsed, other subjects get the prefix prepended. "Reply:" and friends
 * are not prefixes and stay untouched.
 */
export function ensureSubjectPrefix(
  subject: string,
  prefix: "Re:" | "Fwd:"
): string {
  const pattern = prefix === "Re:" ? /^(?:re\s*:\s*)+/i : /^(?:fwd?\s*:\s*)+/i
  const stripped = subject.trim().replace(pattern, "")
  return `${prefix} ${stripped}`.trimEnd()
}

/**
 * Outgoing References value: the original chain (oldest first, as
 * imap-sync/gmail-sync stored it in references_header) plus the original
 * message-id as the newest entry, space separated. The two headers are
 * parsed separately (the sync layer's parseReferences only falls back to
 * whitespace tokens when its input has no bracketed ids at all) and the
 * result is deduped and re-bracketed, so the header stays a clean RFC 5322
 * id-list even if the source headers were bare or malformed.
 */
export function buildReferencesChain(message: MessageRow): string | undefined {
  const ids = [
    ...parseReferences(message.references_header),
    ...parseReferences(message.message_id_header),
  ]
  const unique = [...new Set(ids)]
  if (!unique.length) return undefined
  return unique.map((id) => `<${id}>`).join(" ")
}

/**
 * The original body as quoted content: HTML sanitized with remote images
 * blocked (each http(s) src swapped for the 1x1 transparent placeholder,
 * the original URL parked in `data-original-src`), else the plain text
 * escaped inside the same `data-emailer-plaintext` div the renderer's
 * plain-text path uses (its base stylesheet gives it pre-wrap; the
 * attribute survives the sanitizer's ALLOW_DATA_ATTR). Nothing at all
 * quotes as an empty paragraph so the blockquote still renders.
 *
 * The sanitize pass matches the reading-pane policy on purpose: the
 * composer parses this quote with TipTap in the HOST document, where the
 * sandboxed frame's image policy cannot apply — without it, a tracking
 * pixel in the quoted HTML would auto-load the moment the user hits
 * Reply or Forward. This is the single choke point: both the reply
 * history (buildQuotedHistory) and the forward quote (buildForwardQuote)
 * embed their body through it, and the same markup is what the draft
 * resume replays via mode.quotedHtml.
 */
function quotedOriginal(message: MessageRow): string {
  const html = message.body_html?.trim()
  if (html) return sanitizeEmailHtml(html, { blockRemoteImages: true })
  const text = message.body_text?.trim()
  if (text) {
    return `<div data-emailer-plaintext>${escapeHtml(message.body_text ?? "")}</div>`
  }
  return "<p></p>"
}

/** Gmail-style quoted history: "On <date>, <sender> wrote:" + blockquote. */
export function buildQuotedHistory(message: MessageRow): string {
  const writer = escapeHtml(
    contactLabel(message.from_name, message.from_address)
  )
  const header = `<p>On ${escapeHtml(formatQuoteDate(message.date))}, ${writer} wrote:</p>`
  return `${header}<blockquote>${quotedOriginal(message)}</blockquote>`
}

/** Classic forwarded-message header block + the quoted body. */
export function buildForwardQuote(message: MessageRow): string {
  const lines = [
    `From: ${contactLabel(message.from_name, message.from_address)}`,
    `Date: ${formatQuoteDate(message.date)}`,
    ...(message.subject ? [`Subject: ${message.subject}`] : []),
  ]
  const to = contactListLabel(parseContacts(message.to_json))
  if (to) lines.push(`To: ${to}`)
  const cc = contactListLabel(parseContacts(message.cc_json))
  if (cc) lines.push(`Cc: ${cc}`)
  const header = `<p>${lines.map((line) => escapeHtml(line)).join("<br>")}</p>`
  return `<p>---------- Forwarded message ----------</p>${header}<blockquote>${quotedOriginal(message)}</blockquote>`
}

/** Join non-empty sections with one blank line (no leading/trailing sep). */
function joinSections(sections: string[]): string {
  return sections
    .map((section) => section.trim())
    .filter(Boolean)
    .join(COMPOSER_BLOCK_SEPARATOR)
}

/**
 * The empty paragraph every reply/forward body starts with — the caret
 * line. It sits above the signature block so the composer can drop the
 * selection here on open (batch C2 follow-up: "cursor above the
 * signature"), and typing before sending never merges into the signature
 * or the quote below.
 */
const REPLY_CARET_LINE = "<p></p>"

/**
 * Build a reply prefill. Recipients per the spec (see module docstring);
 * subject "Re: <original>"; body = caret line, signature, quoted history —
 * the leading empty paragraph is where the caret lands on open (above the
 * signature, so the user's first keystroke never lands inside the
 * signature block); the new-message body starts empty.
 */
export function buildReply(input: BuildReplyInput): ComposerPrefill {
  const { message, thread, account, replyAll, signatureHtml } = input

  const sender: ContactRef[] = message.from_address
    ? [
        {
          email: message.from_address,
          ...(message.from_name ? { name: message.from_name } : {}),
        },
      ]
    : []
  const originalTo = parseContacts(message.to_json)
  const originalCc = parseContacts(message.cc_json)

  let to: Recipient[]
  let cc: Recipient[]
  if (replyAll) {
    to = excludeSelf(collectRecipients([sender, originalTo]), account.email)
    const toEmails = new Set(
      to.map((recipient) => normalizeEmail(recipient.email))
    )
    cc = excludeSelf(collectRecipients([originalCc]), account.email).filter(
      (recipient) => !toEmails.has(normalizeEmail(recipient.email))
    )
  } else {
    // Reply goes to the sender; answering one of your own messages
    // targets the original To list instead (standard reply-to-self).
    const senderOnly = excludeSelf(collectRecipients([sender]), account.email)
    to =
      senderOnly.length > 0
        ? senderOnly
        : excludeSelf(collectRecipients([originalTo]), account.email)
    cc = []
  }

  const quotedHtml = buildQuotedHistory(message)
  const mode: ComposerMode = {
    kind: "reply",
    replyAll,
    inReplyTo: message.message_id_header ?? undefined,
    references: buildReferencesChain(message),
    sourceMessageId: message.id,
    sourceThreadId: thread.id,
    quotedHtml,
  }
  return {
    mode,
    to,
    cc,
    subject: ensureSubjectPrefix(message.subject ?? "", "Re:"),
    html: joinSections([
      REPLY_CARET_LINE,
      appendSignature("", signatureHtml ?? ""),
      quotedHtml,
    ]),
  }
}

/**
 * Build a forward prefill: no recipients (the user picks them), subject
 * "Fwd: <original>", body = signature above the forwarded header block and
 * quoted body.
 */
export function buildForward(input: BuildForwardInput): ComposerPrefill {
  // `account` stays part of the input for call-site symmetry with
  // buildReply; forwarding derives nothing from it.
  const { message, thread, signatureHtml } = input
  const quotedHtml = buildForwardQuote(message)
  const mode: ComposerMode = {
    kind: "forward",
    sourceMessageId: message.id,
    sourceThreadId: thread.id,
    quotedHtml,
  }
  return {
    mode,
    to: [],
    cc: [],
    subject: ensureSubjectPrefix(message.subject ?? "", "Fwd:"),
    html: joinSections([
      REPLY_CARET_LINE,
      appendSignature("", signatureHtml ?? ""),
      quotedHtml,
    ]),
  }
}
