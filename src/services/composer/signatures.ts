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
  const signatureBlock = `<div class="emailer-signature">${signature}</div>`
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
