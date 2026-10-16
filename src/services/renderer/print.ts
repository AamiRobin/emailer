import { format } from "date-fns"

import { sanitizeEmailHtml } from "@/services/renderer/sanitize"
import { isSenderAllowed } from "@/services/db/image-allowlist"
import {
  getThreadWithMessages,
  type ThreadWithMessages,
} from "@/services/db/threads"
import type { MessageRow } from "@/services/db/messages"
import { getExecutor, type SqlExecutor } from "@/services/db/executor"
import { isTauriRuntime } from "@/services/desktop/popout"
import {
  openPrintWindow,
  type PrintScope,
} from "@/services/desktop/print-window"

/**
 * Print support (parity-round-3 D7, tasks 4.1–4.3; originally task 1.10).
 *
 * Desktop: a print action opens the dedicated hidden-until-ready print
 * window (services/desktop/print-window.ts, same plumbing as the composer
 * pop-out) whose print-only route renders the print document — headers +
 * sanitized bodies in conversation order, print-media CSS — and calls
 * `window.print()` on load (print-app.tsx). Closing the window hands
 * focus back to the reading pane.
 *
 * Plain-browser mock/dev (no window system): the same document renders in
 * a hidden sandboxed iframe and the OS print dialog opens on that frame's
 * document instead — the pre-window path, kept as the fallback.
 *
 * Both paths share buildPrintPayload: each body goes through the SAME
 * `sanitizeEmailHtml` policy the reading pane displays with (the sender's
 * image-allowlist decision decides `blockRemoteImages`) — so a blocked
 * sender's remote images are placeholders at print time exactly as on
 * screen, no script survives into the print document, and nothing new is
 * fetched at print time (image srcs are inline or placeholder data URIs).
 */

/** One message prepared for the print document. */
export interface PrintMessage {
  fromName: string | null
  fromAddress: string | null
  to: string[]
  cc: string[]
  /** Unix seconds. */
  date: number
  /** Already-sanitized body HTML (neither print path re-trusts it). */
  bodyHtml: string
}

/** Everything the print document (window or iframe) renders. */
export interface PrintPayload {
  subject: string | null
  messages: PrintMessage[]
}

/** Escape untrusted TEXT for interpolation into the print document. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export function formatPrintAddress(
  name: string | null,
  address: string | null
): string {
  const trimmedName = name?.trim() ?? ""
  const trimmedAddress = address?.trim() ?? ""
  if (trimmedName !== "" && trimmedAddress !== "") {
    return `${trimmedName} <${trimmedAddress}>`
  }
  return trimmedName !== "" ? trimmedName : trimmedAddress
}

/**
 * The print document's CSS, shared verbatim by both print paths (the
 * print window injects it; the iframe path embeds it in <head>): @page
 * margins, paper-readable typography, header table, and page-break
 * handling — a message's header block never strands at a page bottom and
 * short messages avoid splitting altogether.
 */
export const PRINT_DOCUMENT_STYLES = [
  "@page { margin: 18mm 16mm; }",
  "body { font: 13px/1.5 ui-sans-serif, system-ui, sans-serif; color: #111; margin: 0; background: #fff; }",
  "h1 { font-size: 17px; margin: 0 0 16px; break-after: avoid; }",
  ".message { margin: 0 0 20px; }",
  ".headers { border-collapse: collapse; margin: 0 0 10px; border: 1px solid #ddd; break-inside: avoid; break-after: avoid; }",
  ".headers th, .headers td { text-align: left; vertical-align: top; padding: 3px 8px; font-size: 12px; border-bottom: 1px solid #eee; }",
  ".headers th { color: #666; font-weight: 600; white-space: nowrap; }",
  ".body { overflow-wrap: break-word; }",
  ".body img { max-width: 100%; }",
  ".separator { border: none; border-top: 1px solid #ccc; margin: 20px 0; }",
  "@media print { .message { break-inside: avoid-page; } }",
].join("\n")

/**
 * The print document's <body> content: the subject heading plus one
 * section per message (header table + sanitized body), separated with
 * rules. Shared verbatim by both print paths so the window and the
 * fallback iframe render the exact same markup.
 */
export function renderPrintBody(
  subject: string | null,
  messages: PrintMessage[]
): string {
  const sections = messages
    .map((message) => {
      const rows: string[] = []
      const from = formatPrintAddress(message.fromName, message.fromAddress)
      if (from !== "") {
        rows.push(`<tr><th>From</th><td>${escapeHtml(from)}</td></tr>`)
      }
      if (message.to.length > 0) {
        rows.push(
          `<tr><th>To</th><td>${escapeHtml(message.to.join(", "))}</td></tr>`
        )
      }
      if (message.cc.length > 0) {
        rows.push(
          `<tr><th>Cc</th><td>${escapeHtml(message.cc.join(", "))}</td></tr>`
        )
      }
      rows.push(
        `<tr><th>Date</th><td>${escapeHtml(
          format(new Date(message.date * 1000), "PPpp")
        )}</td></tr>`
      )
      return [
        '<section class="message">',
        '<table class="headers">',
        rows.join(""),
        "</table>",
        '<div class="body">',
        message.bodyHtml,
        "</div>",
        "</section>",
      ].join("")
    })
    .join('<hr class="separator" />')

  const heading =
    subject !== null && subject.trim() !== ""
      ? `<h1>${escapeHtml(subject)}</h1>`
      : ""
  return heading + sections
}

/**
 * The standalone print document (iframe fallback path): conversation
 * order, per-message headers, print-friendly styling, zero app chrome.
 */
export function buildPrintHtml(
  subject: string | null,
  messages: PrintMessage[]
): string {
  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8" />',
    "<title>",
    escapeHtml(subject ?? "Emailer print"),
    "</title>",
    "<style>",
    PRINT_DOCUMENT_STYLES,
    "</style>",
    "</head>",
    "<body>",
    renderPrintBody(subject, messages),
    "</body>",
    "</html>",
  ].join("")
}

/**
 * Render the print document in a hidden iframe and open the OS print
 * dialog on it (the plain-browser fallback — the desktop path is the
 * print window). The iframe is removed after the dialog closes (the
 * afterprint event, with a timeout fallback for engines that skip it).
 * The frame is sandboxed with `allow-same-origin allow-modals` — see the
 * attribute below for why scripts are never allowed.
 */
export function printHtml(html: string): void {
  const iframe = document.createElement("iframe")
  iframe.setAttribute("aria-hidden", "true")
  // A srcdoc iframe without a sandbox attribute inherits the app's
  // origin, so any script surviving into the print document would run
  // with full access to the host DOM/storage. `allow-same-origin` keeps
  // the frame same-origin so contentWindow.print() and the afterprint
  // listener stay callable (an opaque-origin sandbox would make the frame
  // cross-origin and block both); `allow-modals` is required on top —
  // Chromium ignores print() inside a sandboxed frame without it. Scripts
  // stay forbidden (allow-scripts is deliberately absent — it must NEVER
  // be combined with allow-same-origin): printing needs no scripts, and
  // with scripts out of the frame allow-modals exposes nothing — the only
  // print() call is the host's own, made through contentWindow below.
  iframe.setAttribute("sandbox", "allow-same-origin allow-modals")
  iframe.style.position = "fixed"
  iframe.style.right = "0"
  iframe.style.bottom = "0"
  iframe.style.width = "0"
  iframe.style.height = "0"
  iframe.style.border = "0"
  iframe.style.visibility = "hidden"

  let cleaned = false
  const cleanup = (): void => {
    if (cleaned) return
    cleaned = true
    iframe.remove()
  }

  iframe.addEventListener("load", () => {
    try {
      const printWindow = iframe.contentWindow
      if (printWindow === null) {
        cleanup()
        return
      }
      printWindow.addEventListener("afterprint", cleanup)
      printWindow.focus()
      printWindow.print()
      // Fallback cleanup: afterprint does not fire everywhere (and never
      // fires if the dialog is dismissed without printing on some hosts).
      window.setTimeout(cleanup, 60_000)
    } catch (error) {
      console.warn("[print] failed to open the print dialog", error)
      cleanup()
    }
  })

  iframe.srcdoc = html
  document.body.appendChild(iframe)
}

/** Parse the contacts JSON columns (`to_json` / `cc_json`). */
function parseContactList(json: string | null): string[] {
  if (json === null || json === "") return []
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed
      .map((entry) => {
        if (typeof entry === "string") return entry
        if (
          typeof entry === "object" &&
          entry !== null &&
          "email" in entry &&
          typeof (entry as { email: unknown }).email === "string"
        ) {
          return (entry as { email: string }).email
        }
        return ""
      })
      .filter((value) => value.trim() !== "")
  } catch {
    return []
  }
}

/** Plain-text bodies print as pre-wrapped text blocks. */
function plainTextBody(text: string): string {
  return `<pre style="font: inherit; white-space: pre-wrap; margin: 0;">${escapeHtml(
    text
  )}</pre>`
}

/**
 * The print payload for an already-loaded thread (the sanitizer handoff,
 * task 4.3): each selected body runs through the reading pane's
 * `sanitizeEmailHtml` with the sender's image-allowlist decision —
 * blocked remote images become placeholders (original kept in
 * `data-original-src`, exactly as displayed), scripts/styles/event
 * handlers are stripped by the allowlist, and html-less messages fall
 * back to their pre-wrapped plain text. Returns null when the scope
 * selects no message (unknown id).
 */
export async function buildPrintPayload(
  executor: SqlExecutor,
  thread: ThreadWithMessages,
  scope: PrintScope
): Promise<PrintPayload | null> {
  const messages: MessageRow[] =
    scope.kind === "thread"
      ? thread.messages
      : thread.messages.filter((message) => message.id === scope.messageId)
  if (messages.length === 0) return null

  const printMessages: PrintMessage[] = []
  for (const message of messages) {
    const allowed =
      message.from_address !== null
        ? await isSenderAllowed(
            executor,
            message.account_id,
            message.from_address
          )
        : false
    const bodyHtml =
      message.body_html !== null && message.body_html !== ""
        ? sanitizeEmailHtml(message.body_html, {
            blockRemoteImages: !allowed,
          })
        : plainTextBody(message.body_text ?? "")
    printMessages.push({
      fromName: message.from_name,
      fromAddress: message.from_address,
      to: parseContactList(message.to_json),
      cc: parseContactList(message.cc_json),
      date: message.date,
      bodyHtml,
    })
  }
  return { subject: thread.thread.subject, messages: printMessages }
}

/** Load a thread and build its print payload (the print window's boot
 * step). Returns null when the thread is gone or the scope selects
 * nothing. */
export async function loadPrintPayload(
  threadId: string,
  scope: PrintScope
): Promise<PrintPayload | null> {
  const executor = getExecutor()
  const loaded = await getThreadWithMessages(executor, threadId)
  if (!loaded) return null
  return buildPrintPayload(executor, loaded, scope)
}

/**
 * Print a thread: either the whole conversation or a single message.
 * Desktop (D7): opens the dedicated print window — the reading-pane
 * print menu's two entries and the Cmd/Ctrl+P binding land here. Outside
 * Tauri: the hidden-iframe fallback renders the same payload.
 */
export async function printThread(
  threadId: string,
  scope: PrintScope
): Promise<void> {
  if (isTauriRuntime()) {
    await openPrintWindow(threadId, scope)
    return
  }
  const payload = await loadPrintPayload(threadId, scope)
  if (payload === null) return
  printHtml(buildPrintHtml(payload.subject, payload.messages))
}
