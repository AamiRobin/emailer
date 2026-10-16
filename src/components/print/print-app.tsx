import { useEffect, useRef, useState } from "react"

import { getCurrentWindow } from "@tauri-apps/api/window"

import { bootstrapPopout } from "@/services/bootstrap"
import {
  forceClosePopout,
  onPopoutCloseRequested,
} from "@/services/desktop/popout"
import {
  printWindowContext,
  refocusMainWindow,
  type PrintWindowContext,
} from "@/services/desktop/print-window"
import {
  loadPrintPayload,
  PRINT_DOCUMENT_STYLES,
  renderPrintBody,
  type PrintPayload,
} from "@/services/renderer/print"

/**
 * Print-only window surface (parity-round-3 D7, tasks 4.1–4.3): the
 * route inside the dedicated print window. The window's Tauri label
 * (`popout-print-…`) IS the route — it carries the thread id and the
 * print scope (open message vs whole conversation); no print content
 * ever travels through the label.
 *
 * Boot: the database only (bootstrapPopout — the sync scheduler, offline
 * queue and notifications stay main-window-owned), then the print payload
 * through buildPrintPayload — the SAME sanitizer + image-allowlist
 * pipeline the reading pane displays with, so blocked remote images are
 * placeholders here too and no message script can exist in this window's
 * document (the body markup injected below is sanitizer output; the only
 * scripts in the bundle are the app's own).
 *
 * Print flow (D7): the window is created hidden; once the payload has
 * rendered, the surface shows the window, stamps the document title (the
 * print job name) and calls window.print(). afterprint — or a fallback
 * timer for engines that skip it — closes the window and hands focus
 * back to the reading pane (refocusMainWindow). If the system dialog
 * misbehaves (WKWebView quirk risk, design risk note), the printable
 * view stays up for a manual print.
 *
 * Close discipline: the Rust close guard holds CloseRequested for
 * `popout-*` labels; a print window has no draft state to guard, so the
 * surface answers popout-close-requested by force-closing (focus returns
 * to the reading pane with it).
 */

/**
 * Once per window lifecycle, module scope on purpose: StrictMode's dev
 * mount/unmount/mount must neither open the system print dialog twice
 * nor lose it (a ref guard resets across the remount; this doesn't).
 */
let printDialogInvoked = false

export function PrintApp() {
  const [context] = useState<PrintWindowContext | null>(() =>
    printWindowContext()
  )
  const [payload, setPayload] = useState<PrintPayload | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)
  // afterprint resolves through a ref so the one-time listener below
  // always reaches the current closer, whatever StrictMode remounts.
  const closeAfterPrintRef = useRef<() => void>(() => {})

  // Boot: the database, then the print payload (sanitizer handoff — see
  // the module comment). A vanished thread/message reports inline; the
  // window stays open for a manual close.
  useEffect(() => {
    if (context === null) return
    let cancelled = false
    void (async () => {
      try {
        await bootstrapPopout()
        const loaded = await loadPrintPayload(context.threadId, context.scope)
        if (cancelled) return
        if (loaded === null || loaded.messages.length === 0) {
          setBootError("Nothing to print — this message no longer exists.")
          return
        }
        setPayload(loaded)
      } catch (error) {
        console.error("[print-window] boot failed", error)
        if (!cancelled) setBootError(String(error))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [context])

  // Close and hand focus back to the reading pane. Idempotent: afterprint
  // and the fallback timer race benignly.
  useEffect(() => {
    const closeAndRefocus = (): void => {
      void forceClosePopout()
        .then(() => refocusMainWindow())
        .catch(() => {})
    }
    closeAfterPrintRef.current = closeAndRefocus
  }, [])

  // Rust close guard (the window's X, taskbar close): the guard holds the
  // request and emits popout-close-requested; a print window has no draft
  // state to protect, so the answer is always "close" (refocus included).
  useEffect(() => {
    if (context === null) return
    let unlisten: (() => void) | undefined
    let disposed = false
    void onPopoutCloseRequested(() => closeAfterPrintRef.current()).then(
      (off) => {
        if (disposed) off()
        else unlisten = off
      }
    )
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [context])

  useEffect(() => {
    const onAfterPrint = (): void => closeAfterPrintRef.current()
    window.addEventListener("afterprint", onAfterPrint)
    return () => window.removeEventListener("afterprint", onAfterPrint)
  }, [])

  // The document is ready: show the hidden window and open the system
  // print dialog. once-per-lifecycle guard above; the fallback timer
  // covers engines where afterprint never fires.
  useEffect(() => {
    if (payload === null || printDialogInvoked) return
    printDialogInvoked = true
    const fallback = window.setTimeout(
      () => closeAfterPrintRef.current(),
      60_000
    )
    void (async () => {
      try {
        await getCurrentWindow().show()
        window.print()
      } catch (error) {
        console.warn("[print-window] failed to open the print dialog", error)
        window.clearTimeout(fallback)
        // Keep the printable view up (design risk note): the document
        // renders on screen and only the close guard applies.
      }
    })()
    return () => {
      window.clearTimeout(fallback)
    }
  }, [payload])

  // The print job name = the subject (what the OS dialog and spooler show).
  useEffect(() => {
    if (payload !== null) {
      document.title = payload.subject ?? "Emailer print"
    }
  }, [payload])

  if (context === null) {
    // Only reachable outside a print window (dev curiosity).
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        No print window context.
      </div>
    )
  }

  if (bootError !== null) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        {bootError}
      </div>
    )
  }

  if (payload === null) {
    // Hidden behind the invisible window in practice (D7: shown only when
    // ready) — this is the boot frame.
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }

  return (
    <div data-testid="print-document">
      {/* The document's own print CSS (page margins, typography, page
          breaks) — the same sheet the iframe fallback embeds. The body
          markup below is sanitizer output (see module comment); the style
          sheet is app-authored. */}
      <style>{PRINT_DOCUMENT_STYLES}</style>
      <div
        className="print-document"
        dangerouslySetInnerHTML={{
          __html: renderPrintBody(payload.subject, payload.messages),
        }}
      />
    </div>
  )
}
