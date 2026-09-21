import type { SqlExecutor } from "../db/executor"
import { getSetting, setSetting } from "../db/settings"

/**
 * Per-account signatures (task 8.4, spec "Signatures"): the accounts table
 * has no signature column, so signatures live in the generic `settings`
 * table under `signature:<accountId>` as a JSON `{ html }` payload — the
 * rich-text blob the 11.x settings UI will edit. Default: empty signature.
 *
 * Placement rule (spec "Signature on reply"): the signature sits BELOW the
 * new body and ABOVE the quoted history, so a composed body reads
 *
 *   [new body] [signature] [quoted history]
 *
 * The reply/forward builders in reply.ts are pure and take the signature
 * as a plain string; the composer integration fetches it per account with
 * `getSignature(getExecutor(), accountId)` right before building the
 * prefill.
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor.
 */

/** One blank line between body, signature and quoted history. Semantic
 * markup only (`<p>` + `<br>`), so it survives the email sanitizer. */
export const COMPOSER_BLOCK_SEPARATOR = "<p><br></p>"

/** The class marking the managed signature block in a composed body. */
export const SIGNATURE_BLOCK_CLASS = "emailer-signature"

/** Settings key holding an account's signature payload. */
export function signatureSettingKey(accountId: string): string {
  return `signature:${accountId}`
}

/**
 * The account's signature HTML ("" when unset or when the stored payload
 * is corrupt — getSetting's tolerant parse covers unparsable rows, the
 * typeof check covers wrong-shaped JSON).
 */
export async function getSignature(
  executor: SqlExecutor,
  accountId: string
): Promise<string> {
  const value = await getSetting<{ html?: unknown }>(
    executor,
    signatureSettingKey(accountId),
    {}
  )
  return typeof value.html === "string" ? value.html : ""
}

/** Persist the account's signature (plain or rich HTML). */
export async function setSignature(
  executor: SqlExecutor,
  accountId: string,
  html: string
): Promise<void> {
  await setSetting(executor, signatureSettingKey(accountId), { html })
}

/**
 * Where a quoted-history block starts in a composed body. Our builders
 * emit semantic `<blockquote>` wrappers, so its first occurrence marks
 * the quote; a body without one simply has no quote yet.
 */
function indexOfQuoteBlock(html: string): number {
  return html.toLowerCase().indexOf("<blockquote")
}

/**
 * Place a signature into a composer body per the composition order
 * [new body] [signature] [quoted history]:
 *
 * - empty signature → body unchanged;
 * - the body already contains a quoted history (draft resume, or the
 *   caller composed the quote first) → the signature is inserted between
 *   body and quote;
 * - otherwise → appended after the body; the reply/forward builders add
 *   the quote afterwards, which lands it below the signature.
 *
 * Sections are joined with one blank line; an empty body never grows a
 * leading separator. Pure string work — no db, no sanitizer dependency.
 */
export function appendSignature(
  bodyHtml: string,
  signatureHtml: string
): string {
  const signature = signatureHtml.trim()
  if (!signature) return bodyHtml
  const signatureBlock = `<div class="${SIGNATURE_BLOCK_CLASS}">${signature}</div>`
  const body = bodyHtml.trim()
  if (!body) return signatureBlock

  const quoteIndex = indexOfQuoteBlock(body)
  if (quoteIndex === -1) {
    return `${body}${separatorAfter(body)}${signatureBlock}`
  }
  const beforeQuote = body.slice(0, quoteIndex).trimEnd()
  const quote = body.slice(quoteIndex)
  return beforeQuote
    ? `${beforeQuote}${separatorAfter(beforeQuote)}${signatureBlock}${quote}`
    : `${signatureBlock}${quote}`
}

/** One blank line before the signature — unless the body already ends
 * with one, so the gap never doubles up. */
function separatorAfter(html: string): string {
  return html.endsWith(COMPOSER_BLOCK_SEPARATOR) ? "" : COMPOSER_BLOCK_SEPARATOR
}

// ---------------------------------------------------------------------------
// Managed-block replacement (composer batch C1, fix 3)
// ---------------------------------------------------------------------------

/** The managed block's opening tag, as appendSignature emits it. */
const SIGNATURE_BLOCK_OPEN = new RegExp(
  `<div\\s+class=(?:"${SIGNATURE_BLOCK_CLASS}"|'${SIGNATURE_BLOCK_CLASS}')`,
  "i"
)

/** One `<div …>` open or `</div>` close token, for the balance scan. */
const DIV_TOKEN = /<\/?div\b[^>]*>/gi

/**
 * Locate the managed signature block in a body: the first
 * `div.emailer-signature` open tag plus its MATCHING close — the
 * signature HTML may itself contain nested divs, so a naive regex for
 * `</div>` would cut the block short. Returns the [start, end) range
 * covering the whole `<div …>…</div>`, or null when the body has no
 * managed block (or an unbalanced one, which is treated the same —
 * corrupt markup is never edited by these helpers).
 */
function findSignatureBlockRange(html: string): {
  start: number
  end: number
} | null {
  const open = SIGNATURE_BLOCK_OPEN.exec(html)
  if (!open) return null
  const tokens = DIV_TOKEN
  tokens.lastIndex = open.index + open[0].length
  let depth = 1
  let match: RegExpExecArray | null
  while ((match = tokens.exec(html)) !== null) {
    depth += match[0].startsWith("</") ? -1 : 1
    if (depth === 0) {
      return { start: open.index, end: match.index + match[0].length }
    }
  }
  return null
}

/**
 * Remove the managed signature block from a body (and ONE adjacent
 * separator, so no double blank line is left behind). A body without a
 * managed block is returned unchanged; user text above/below the block
 * is preserved byte-for-byte. Pure string work.
 */
export function removeSignatureBlock(bodyHtml: string): string {
  const range = findSignatureBlockRange(bodyHtml)
  if (!range) return bodyHtml
  let before = bodyHtml.slice(0, range.start)
  let after = bodyHtml.slice(range.end)
  if (before.endsWith(COMPOSER_BLOCK_SEPARATOR)) {
    before = before.slice(0, -COMPOSER_BLOCK_SEPARATOR.length)
  } else if (after.startsWith(COMPOSER_BLOCK_SEPARATOR)) {
    after = after.slice(COMPOSER_BLOCK_SEPARATOR.length)
  }
  return `${before}${after}`
}

/**
 * Replace whatever managed signature block the body holds with
 * `signatureHtml`, placed by the same composition rule appendSignature
 * uses — end of body for new mail, [body][signature][quote] when a
 * quoted history is present. An empty `signatureHtml` ("No signature")
 * just removes the existing block, keeping the user's text. This is the
 * per-message selector's whole write path: re-selecting an account swaps
 * the block without touching anything above it.
 */
export function insertSignatureBlock(
  bodyHtml: string,
  signatureHtml: string
): string {
  const withoutOld = removeSignatureBlock(bodyHtml)
  const signature = signatureHtml.trim()
  if (!signature) return withoutOld
  return appendSignature(withoutOld, signature)
}
