import { format } from "date-fns"

import { sanitizeEmailHtml } from "@/services/renderer/sanitize"
import { isSenderAllowed } from "@/services/db/image-allowlist"
import { getThreadWithMessages } from "@/services/db/threads"
import type { MessageRow } from "@/services/db/messages"
import { getExecutor } from "@/services/db/executor"

/**
 * Print support (task 1.10, spec mail-reading "Print message or thread").
 *
 * The design (D9) bypasses printing the app window: email bodies render
 * in sandboxed iframes and the app is full of chrome, so a print run
 * builds a standalone print document (headers + sanitized bodies, in
 * conversation order), writes it into a hidden iframe via `srcdoc`, and
 * invokes the OS print dialog on that iframe's document. The bodies go
 * through the same `sanitizeEmailHtml` policy as the reading pane — so a
 * blocked sender's remote images are placeholders at print time exactly
 * as on screen, and nothing new is fetched (the print document makes no
 * network requests; image srcs are inline or placeholder data URIs).
 */

/** One message prepared for the print document. */
export interface PrintMessage {
  fromName: string | null
  fromAddress: string | null
  to: string[]
  cc: string[]
  /** Unix seconds. */
  date: number
  /** Already-sanitized body HTML (print-document.ts does not re-trust). */
  bodyHtml: string
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
 * The standalone print document: conversation order, per-message headers,
 * print-friendly styling, zero app chrome.
 */
export function buildPrintHtml(
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

  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    '<meta charset="utf-8" />',
    "<title>",
    escapeHtml(subject ?? "Emailer print"),
    "</title>",
    "<style>",
    "@page { margin: 18mm 16mm; }",
    "body { font: 13px/1.5 ui-sans-serif, system-ui, sans-serif; color: #111; margin: 0; }",
    "h1 { font-size: 17px; margin: 0 0 16px; }",
    ".message { margin: 0 0 20px; }",
    ".headers { border-collapse: collapse; margin: 0 0 10px; border: 1px solid #ddd; }",
    ".headers th, .headers td { text-align: left; vertical-align: top; padding: 3px 8px; font-size: 12px; border-bottom: 1px solid #eee; }",
    ".headers th { color: #666; font-weight: 600; white-space: nowrap; }",
    ".body { overflow-wrap: break-word; }",
    ".body img { max-width: 100%; }",
    ".separator { border: none; border-top: 1px solid #ccc; margin: 20px 0; }",
    "@media print { .message { break-inside: avoid-page; } }",
    "</style>",
    "</head>",
    "<body>",
    heading,
    sections,
    "</body>",
    "</html>",
  ].join("")
}

/**
 * Render the print document in a hidden iframe and open the OS print
 * dialog on it. The iframe is removed after the dialog closes (the
 * afterprint event, with a timeout fallback for engines that skip it).
 * The frame is sandboxed with `allow-same-origin` only — see the
 * attribute below for why scripts are never allowed.
 */
export function printHtml(html: string): void {
  const iframe = document.createElement("iframe")
  iframe.setAttribute("aria-hidden", "true")
  // A srcdoc iframe without a sandbox attribute inherits the app's
  // origin, so any script surviving into the print document would run
  // with full access to the host DOM/storage. `allow-same-origin` ONLY:
  // it keeps the frame same-origin so contentWindow.print() and the
  // afterprint listener stay callable (an opaque-origin sandbox would
  // make the frame cross-origin and block both), while allow-scripts is
  // deliberately absent — printing never needs scripts, and it must
  // NEVER be added: allow-same-origin + allow-scripts together would
  // hand untrusted markup script access to the app document.
  iframe.setAttribute("sandbox", "allow-same-origin")
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
 * Print a thread: either the whole conversation or a single message.
 * Each body is sanitized with the sender's image-allowlist decision —
 * the exact policy the reading pane displays with (blocked images stay
 * placeholders; nothing is fetched at print time).
 */
export async function printThread(
  threadId: string,
  scope: { kind: "thread" } | { kind: "message"; messageId: string }
): Promise<void> {
  const executor = getExecutor()
  const loaded = await getThreadWithMessages(executor, threadId)
  if (!loaded) return

  const messages: MessageRow[] =
    scope.kind === "thread"
      ? loaded.messages
      : loaded.messages.filter((message) => message.id === scope.messageId)
  if (messages.length === 0) return

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

  printHtml(buildPrintHtml(loaded.thread.subject, printMessages))
}
