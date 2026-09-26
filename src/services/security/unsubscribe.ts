import { invoke } from "@tauri-apps/api/core"

import type { SqlExecutor } from "../db/executor"
import { createRule, listRules } from "../rules/db"
import { enqueueUnsubscribePost } from "../queue/operation"
import { isOnline } from "../online"

/**
 * List-unsubscribe (task 18.3, design D13). The `List-Unsubscribe` /
 * `List-Unsubscribe-Post` header pair is parsed per stored message (the
 * sync engines capture it verbatim into the messages.headers JSON at
 * insert — see buildStoredHeaders in the sync engines) and acted on
 * on demand from the mail view's Unsubscribe affordance.
 *
 * Two flows per the mail-security spec:
 * - ONE-CLICK (RFC 8058): available only when BOTH headers advertise it —
 *   a `List-Unsubscribe-Post` header is present (its value is typically
 *   `List-Unsubscribe=One-Click`) AND the List-Unsubscribe header carries
 *   an https URL. Clicking POSTs form-encoded `List-Unsubscribe=One-Click`
 *   to the URL — the exact request body RFC 8058 mandates. The POST goes
 *   through the `unsubscribe_one_click_post` Rust command
 *   (src-tauri/src/unsubscribe.rs), which validates the target (https,
 *   no userinfo/fragment/control characters, no redirects, no
 *   credentials) and issues it Rust-side — unsubscribe endpoints are
 *   unbounded (every list owner runs their own), so the webview must
 *   never fetch them directly. Offline, the POST is enqueued as an
 *   `unsubscribe_post` op and the queue processor replays it (spec:
 *   unsubscribing queues for replay).
 * - MAILTO fallback: no one-click target but a `mailto:` entry — the
 *   composer opens pre-addressed (the UI does this with the same seam
 *   compose-to-contact uses; this module only parses).
 *
 * `List-Unsubscribe` grammar (RFC 2369): comma-separated angle-bracket
 * URLs, e.g. `<https://a/u>, <mailto:b@c>`. The parser is pure and
 * fixture-tested; it tolerates the sloppy real-world shapes (missing
 * brackets, stray whitespace, folded values already unfolded by the
 * transport).
 */

/** One parsed `mailto:` entry of a List-Unsubscribe header. */
export interface MailtoTarget {
  address: string
  /** The mailto URI's ?subject= when present (pre-fills the composer). */
  subject?: string
}

/** Everything one message's headers offer for unsubscribing. */
export interface UnsubscribeTargets {
  /**
   * RFC 8058 one-click targets, https only, in header order. Empty unless
   * the List-Unsubscribe-Post header is present (the one-click
   * advertisement) — a bare https URL without it is NOT one-clickable.
   */
  oneClickUrls: string[]
  /** mailto: entries, in header order. */
  mailtos: MailtoTarget[]
}

/** The header names as stored in the messages.headers JSON. */
export const LIST_UNSUBSCRIBE_HEADER = "list-unsubscribe"
export const LIST_UNSUBSCRIBE_POST_HEADER = "list-unsubscribe-post"

/** The exact form body RFC 8058 §4 mandates for the one-click POST. */
export const ONE_CLICK_BODY = "List-Unsubscribe=One-Click"

/** The lowercased header-name map shape stored on a message row. */
export type StoredMessageHeaders = Record<string, string>

/**
 * Tolerant parse of a stored headers JSON value (the messages.headers
 * column). Corrupt JSON, non-object shapes and non-string values yield
 * missing entries — a broken row must never break the message view.
 */
export function parseStoredHeaders(
  headersJson: string | null | undefined
): StoredMessageHeaders {
  if (!headersJson) return {}
  try {
    const parsed: unknown = JSON.parse(headersJson)
    if (typeof parsed !== "object" || parsed === null) return {}
    const headers: StoredMessageHeaders = {}
    for (const [name, value] of Object.entries(
      parsed as Record<string, unknown>
    )) {
      if (typeof value === "string") headers[name.toLowerCase()] = value
    }
    return headers
  } catch {
    return {}
  }
}

/**
 * Parse one `List-Unsubscribe` header value into its targets. Angle-bracket
 * entries split on commas (RFC 2369); an unbracketed value is treated as a
 * single entry (the common real-world sloppiness). https/http URLs and
 * mailto URIs are kept in order; everything else (ftp:, https with no host,
 * garbage) is dropped. The one-click filter — whether `oneClickUrls` is
 * populated at all — is decided by `postHeaderValue`.
 */
export function parseListUnsubscribe(
  headerValue: string | null | undefined,
  postHeaderValue?: string | null
): UnsubscribeTargets {
  const oneClickEnabled = isOneClickPostHeader(postHeaderValue)
  const urls: string[] = []
  const mailtos: MailtoTarget[] = []
  for (const entry of splitEntries(headerValue)) {
    if (/^mailto:/i.test(entry)) {
      const target = parseMailtoTarget(entry)
      if (target) mailtos.push(target)
      continue
    }
    if (/^https?:\/\//i.test(entry) && isParseableUrl(entry)) {
      urls.push(entry)
    }
  }
  return {
    // RFC 8058 one-click is https-only, and only when the -Post header
    // advertised it: without both, the POST would be an unrequested
    // side effect against a plain RFC 2369 unsubscribe URL.
    oneClickUrls: oneClickEnabled
      ? urls.filter((url) => /^https:/i.test(url))
      : [],
    mailtos,
  }
}

/** Whether a message offers any actionable unsubscribe flow. */
export function canUnsubscribe(targets: UnsubscribeTargets): boolean {
  return targets.oneClickUrls.length > 0 || targets.mailtos.length > 0
}

/** Parse a stored row into actionable targets (the UI's entry point). */
export function unsubscribeTargetsFromHeaders(
  headersJson: string | null | undefined
): UnsubscribeTargets {
  const headers = parseStoredHeaders(headersJson)
  return parseListUnsubscribe(
    headers[LIST_UNSUBSCRIBE_HEADER],
    headers[LIST_UNSUBSCRIBE_POST_HEADER]
  )
}

/** The RFC 8058 advertisement: any List-Unsubscribe-Post value naming the
 * one-click feature (typically exactly "List-Unsubscribe=One-Click"). */
function isOneClickPostHeader(value: string | null | undefined): boolean {
  return (
    typeof value === "string" && /list-unsubscribe\s*=\s*one-click/i.test(value)
  )
}

/** Comma-split that respects angle brackets (a mailto/url body never
 * contains one, but this keeps folded bracketed entries honest). Values
 * without brackets split on commas too — the common real-world sloppiness. */
function splitEntries(value: string | null | undefined): string[] {
  if (!value) return []
  const bracketed = [...value.matchAll(/<([^<>]*)>/g)].map((m) => m[1] ?? "")
  if (bracketed.length > 0) return bracketed.map(trimClean).filter(Boolean)
  return value.split(",").map(trimClean).filter(Boolean)
}

/** Trim, drop surrounding quotes, and strip one trailing comma cruft. */
function trimClean(entry: string): string {
  return entry
    .trim()
    .replace(/^["']|["',]+$/g, "")
    .trim()
}

/** mailto:entry → address + ?subject= (a list's own unsubscribe subject). */
function parseMailtoTarget(entry: string): MailtoTarget | null {
  const rest = entry.slice("mailto:".length)
  const question = rest.indexOf("?")
  const address = (question === -1 ? rest : rest.slice(0, question)).trim()
  if (address === "" || !address.includes("@")) return null
  const query = question === -1 ? "" : rest.slice(question + 1)
  const subject = new URLSearchParams(query).get("subject") ?? undefined
  return { address, ...(subject ? { subject } : {}) }
}

/** Parseability gate for header URLs (a malformed target is dropped, not
 * a crash) — the try/catch form so no newer-than-lib DOM API is needed. */
function isParseableUrl(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// The one-click POST (RFC 8058)
// ---------------------------------------------------------------------------

/** Injectable transport seam (tests); production routes through the
 * `unsubscribe_one_click_post` Rust command. */
export type UnsubscribePostFn = (
  url: string,
  init: { method: "POST"; headers: { "content-type": string }; body: string }
) => Promise<Pick<Response, "ok" | "status">>

/** Thrown for a non-2xx one-click POST (the UI toasts the failure). */
export class UnsubscribeError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "UnsubscribeError"
    this.status = status
  }
}

/**
 * The RFC 8058 one-click request: POST (form-encoded
 * `List-Unsubscribe=One-Click`) to the https target. Any 2xx counts as
 * unsubscribed; anything else throws UnsubscribeError with the status.
 * Called live from the mail view and on replay of a queued
 * `unsubscribe_post` op — one implementation, both paths.
 */
export async function postOneClickUnsubscribe(
  url: string,
  post: UnsubscribePostFn = defaultPost
): Promise<void> {
  const response = await post(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: ONE_CLICK_BODY,
  })
  if (!response.ok) {
    throw new UnsubscribeError(
      response.status,
      `the unsubscribe request failed with status ${response.status}`
    )
  }
}

/** Production transport: the `unsubscribe_one_click_post` Rust command
 * (src-tauri/src/unsubscribe.rs). The RFC 8058 target is sender-controlled
 * header data on an unbounded host set, so the request is issued and
 * validated Rust-side — https only, no userinfo/fragment, no redirects, no
 * credentials, small capped response — and the webview needs no
 * arbitrary-host fetch capability for it (the `https://*` entry was
 * removed from the http:default capability allow list for exactly this
 * reason). Transport/validation failures reject; any HTTP status resolves
 * so postOneClickUnsubscribe can classify it. */
const defaultPost: UnsubscribePostFn = async (url) => {
  const status = await invoke<number>("unsubscribe_one_click_post", { url })
  return { ok: status >= 200 && status < 300, status }
}

// Orchestration (what the mail view's Unsubscribe click runs)
// ---------------------------------------------------------------------------

/** What one Unsubscribe click did — the UI toasts from this. */
export type UnsubscribeOutcome = { kind: "posted" } | { kind: "queued" }

/** Injectable seams of performUnsubscribe (tests; production defaults). */
export interface UnsubscribeDeps {
  /** The one-click transport. Default: the Rust command transport. */
  post?: UnsubscribePostFn
  /** Connectivity. Default: the online store (isOnline). */
  isOnline?: () => boolean
}

/**
 * Run the one-click flow for one target: live POST when online, queue the
 * `unsubscribe_post` op when offline (spec: unsubscribing queues for
 * replay — the queue processor replays it with the same
 * postOneClickUnsubscribe). Throws through for a failed live POST; the
 * queue's own retry/backoff owns a failed replay.
 */
export async function performUnsubscribe(
  executor: SqlExecutor,
  accountId: string,
  url: string,
  deps: UnsubscribeDeps = {}
): Promise<UnsubscribeOutcome> {
  const online = deps.isOnline ?? isOnline
  if (!online()) {
    await enqueueUnsubscribePost(executor, { accountId, url })
    return { kind: "queued" }
  }
  await postOneClickUnsubscribe(url, deps.post)
  return { kind: "posted" }
}

// ---------------------------------------------------------------------------
// The auto-archive offer (spec: "MAY offer to auto-archive future mail")
// ---------------------------------------------------------------------------

/**
 * "Auto-archive future mail from this sender" — implemented as an ordinary
 * rule via the EXISTING rules service (createRule): from:<sender> →
 * archive. It rides the standard ingestion hook (rules/ingestion.ts) and
 * the standard thread-actions archive (local effect + queue op), shows up
 * in the rules settings UI, and is deletable there like any rule — no
 * parallel auto-archive mechanism. Recreating on repeat offers is accepted
 * (idempotent effect; the rules list stays user-editable).
 */
export async function createAutoArchiveRule(
  executor: SqlExecutor,
  accountId: string,
  senderAddress: string
): Promise<string> {
  const sender = senderAddress.trim().toLowerCase()
  return createRule(executor, {
    accountId,
    name: `Auto-archive mail from ${sender}`,
    criteriaQuery: `from:${sender}`,
    actions: [{ type: "archive" }],
  })
}

/**
 * Whether the sender already has the auto-archive rule (the UI collapses
 * a repeat offer into a no-op). Matches on the exact criteria the offer
 * creates — close-but-different rules stay untouched.
 */
export async function hasAutoArchiveRule(
  executor: SqlExecutor,
  accountId: string,
  senderAddress: string
): Promise<boolean> {
  const sender = senderAddress.trim().toLowerCase()
  const rules = await listRules(executor, accountId)
  return rules.some(
    (rule) =>
      rule.criteria_json === JSON.stringify({ query: `from:${sender}` }) &&
      rule.actions_json.includes('"archive"')
  )
}
