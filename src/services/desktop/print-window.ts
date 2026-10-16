import { currentWindowLabel, isTauriRuntime } from "@/services/desktop/popout"

/**
 * The print window plumbing (parity-round-3 D7, tasks 4.1–4.2): the JS half
 * of the dedicated print window — window identification and the open
 * command, reusing the composer pop-out's creation route (JS-side
 * `WebviewWindow` over `index.html`; the window's Tauri label is the
 * route, no query params). The window is created hidden
 * (`visible: false`) and the print-only surface shows it once the print
 * document is ready, immediately before `window.print()`.
 *
 * The label carries the print scope (the label IS the route, exactly like
 * thread/composer pop-outs): `popout-print-t-<hex(threadId)>` prints the
 * whole conversation, `popout-print-m-<hex(threadId)>_<hex(messageId)>`
 * prints one message (the reading pane's default). Ids travel HEX-ENCODED:
 * Gmail row ids are `gt-<uuid>-<gmailThreadId>` with base64url Gmail ids
 * (whose alphabet includes `_`), and the `_` separator plus
 * sanitizeLabelPart's fold would truncate or corrupt such ids — the parse
 * then misses and the window shows "Nothing to print". Hex keeps the
 * payload in [0-9a-f], separator-free and sanitize-stable; anything
 * malformed parses to null (no window).
 *
 * The `popout-print-*` label keeps every `popout-*` behavior for free:
 * the capability's window pattern, the Rust close guard (which holds
 * CloseRequested and emits popout-close-requested — the print surface
 * answers it with forceClosePopout, it has no draft state to guard) and
 * the force_close_popout label check.
 */

export const PRINT_POPOUT_LABEL_PREFIX = "popout-print-"

/** What a print run covers: the open message only (the default) or the
 * whole conversation (the reading-pane dialog's secondary choice). */
export type PrintScope =
  | { kind: "thread" }
  | { kind: "message"; messageId: string }

/** The print run a `popout-print-*` window was opened for. */
export interface PrintWindowContext {
  threadId: string
  scope: PrintScope
}

/** The label for a print window covering `threadId` per `scope`. Exported
 * for the label round-trip test — hex-encoded ids are inherently
 * label-safe (the Rust sanitize_label_part mirror would find nothing to
 * fold). */
export function printWindowLabel(threadId: string, scope: PrintScope): string {
  const safeThread = hexEncode(threadId)
  if (scope.kind === "thread") {
    return `${PRINT_POPOUT_LABEL_PREFIX}t-${safeThread}`
  }
  return `${PRINT_POPOUT_LABEL_PREFIX}m-${safeThread}_${hexEncode(
    scope.messageId
  )}`
}

/** Id → lowercase hex (UTF-8). The label IS the window route, so the
 * payload must be separator-free regardless of the id's alphabet. */
function hexEncode(value: string): string {
  return Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

/** Inverse of hexEncode; null for anything not strict lowercase hex. */
function hexDecode(value: string): string | null {
  if (value.length === 0 || value.length % 2 !== 0) return null
  if (/[^0-9a-f]/.test(value)) return null
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return new TextDecoder().decode(bytes)
}

/**
 * The print run this window shows, parsed from its label. Accepts an
 * explicit label (tests); defaults to this window's Tauri label. Returns
 * null outside Tauri, outside a print window, or for a malformed label.
 */
export function printWindowContext(label?: string): PrintWindowContext | null {
  const own = label ?? currentWindowLabel()
  if (own === null || !own.startsWith(PRINT_POPOUT_LABEL_PREFIX)) return null
  const rest = own.slice(PRINT_POPOUT_LABEL_PREFIX.length)
  if (rest.startsWith("t-")) {
    const threadId = hexDecode(rest.slice(2))
    return threadId ? { threadId, scope: { kind: "thread" } } : null
  }
  if (rest.startsWith("m-")) {
    const payload = rest.slice(2)
    const separator = payload.indexOf("_")
    if (separator <= 0 || separator === payload.length - 1) return null
    const threadId = hexDecode(payload.slice(0, separator))
    const messageId = hexDecode(payload.slice(separator + 1))
    if (threadId === null || messageId === null) return null
    return {
      threadId,
      scope: { kind: "message", messageId },
    }
  }
  return null
}

/** Is THIS window a print window? Decides the boot surface (main.tsx). */
export function isPrintWindow(): boolean {
  return printWindowContext() !== null
}

/**
 * Open (or focus) the hidden print window for `threadId` per `scope`.
 * No-op outside the Tauri runtime (the caller falls back to the
 * hidden-iframe print document there). The surface running inside the
 * window does the rest: it loads the print payload, shows the window and
 * calls window.print() — see print-app.tsx.
 */
export async function openPrintWindow(
  threadId: string,
  scope: PrintScope
): Promise<void> {
  if (!isTauriRuntime()) return
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow")
  const label = printWindowLabel(threadId, scope)
  try {
    const existing = await WebviewWindow.getByLabel(label)
    if (existing) {
      // Same reuse contract as the composer pop-out: never stack a second
      // window for the same print run.
      await existing.show()
      await existing.unminimize().catch(() => {})
      await existing.setFocus()
      return
    }
    const window = new WebviewWindow(label, {
      url: "index.html",
      title: "Print",
      width: 760,
      height: 840,
      center: true,
      // Hidden until the print document is ready (D7) — the surface shows
      // it right before window.print(), so the user never sees a boot
      // flash or a half-rendered document.
      visible: false,
    })
    void window.once("tauri://error", (event) => {
      console.warn("[print-window] failed to open", event)
    })
  } catch (error) {
    console.warn("[print-window] failed to open print window", error)
  }
}

/**
 * Hand focus back to the reading pane (the main window) after the print
 * window goes away (D7: "closing returns focus to the reading pane").
 * Best-effort — a missing main window (app shutting down) is fine.
 */
export async function refocusMainWindow(): Promise<void> {
  if (!isTauriRuntime()) return
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow")
    const main = await WebviewWindow.getByLabel("main")
    if (main === null) return
    await main.show().catch(() => {})
    await main.unminimize().catch(() => {})
    await main.setFocus()
  } catch (error) {
    console.warn("[print-window] failed to refocus the main window", error)
  }
}
