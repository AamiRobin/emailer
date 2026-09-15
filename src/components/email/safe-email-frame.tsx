import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import { cn } from "@/lib/utils"
import { sanitizeEmailHtml } from "@/services/renderer/sanitize"

/**
 * Sandboxed email body frame (task 7.2, design D7).
 *
 * Security model — why this exact sandbox attribute:
 * - `allow-scripts` is required because auto-resize needs a tiny script
 *   running INSIDE the frame (ResizeObserver → postMessage). Cross-origin
 *   alternatives (parent-side ResizeObserver, polling scrollHeight) are
 *   impossible without same-origin access, which is exactly what we refuse
 *   to grant.
 * - `allow-same-origin` is deliberately ABSENT: the frame runs in an opaque
 *   origin. Content scripts can postMessage outward (the only channel we
 *   listen to, validated against `event.source === contentWindow`) but
 *   cannot touch host DOM, storage, cookies, or the parent window.
 * - `allow-popups allow-popups-to-escape-sandbox` lets sanitized
 *   target="_blank" links open as real top-level windows; the opener plugin
 *   (src-tauri lib.rs) routes http(s) to the OS browser — task 7.4.
 * Email content styles inside the frame are the ui-guide's documented
 * style-isolation exception (c). Token *values* are read from the host
 * document whenever the frame document is built — on content changes AND
 * on light/dark flips (the frame observes the host theme) — so the frame
 * tracks the active theme without sharing a CSS scope.
 */

/** postMessage contract: { type: EMAILER_RESIZE_MESSAGE_TYPE, height: px }. */
export const EMAILER_RESIZE_MESSAGE_TYPE = "emailer-resize"

/** Height floor so empty/loading bodies never collapse to zero. */
export const MIN_EMAIL_FRAME_HEIGHT = 120

const SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox"

/**
 * Injected at the end of <body>. Reports the frame document's height to the
 * parent whenever it changes (ResizeObserver on <html>/<body>, plus load
 * events as a fallback), deduplicated so idle content stays quiet.
 * postMessage target must be "*" — the frame's origin is opaque, so no
 * specific targetOrigin can be matched; the parent instead validates
 * event.source, and the payload is a single non-sensitive number.
 */
const RESIZE_SCRIPT = `
(function () {
  var last = -1
  function send() {
    var height = Math.max(
      document.documentElement.scrollHeight || 0,
      document.body ? document.body.scrollHeight : 0
    )
    if (height !== last && window.parent !== window) {
      last = height
      window.parent.postMessage(
        { type: ${JSON.stringify(EMAILER_RESIZE_MESSAGE_TYPE)}, height: height },
        "*"
      )
    }
  }
  if (typeof ResizeObserver !== "undefined") {
    var observer = new ResizeObserver(send)
    observer.observe(document.documentElement)
    if (document.body) observer.observe(document.body)
  }
  window.addEventListener("load", send)
  document.addEventListener("DOMContentLoaded", send)
  send()
})()
`

function readHostToken(name: string): string {
  if (typeof window === "undefined") return ""
  return window
    .getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim()
}

/**
 * Observe the host theme (the `dark` class on <html>) so theme flips can
 * rebuild the frame document. useSyncExternalStore keeps this to one
 * subscription per mounted frame with no setState-in-render: the store is
 * the documentElement class attribute, watched via a MutationObserver that
 * is disconnected on unmount.
 */
function useIsDarkTheme(): boolean {
  const subscribe = useCallback((onStoreChange: () => void) => {
    const observer = new MutationObserver(onStoreChange)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    })
    return () => observer.disconnect()
  }, [])
  return useSyncExternalStore(
    subscribe,
    () => document.documentElement.classList.contains("dark"),
    () => false
  )
}

/**
 * Compose the frame document: sanitized content + theme values read from
 * the host tokens at build time + base typography + the resize reporter.
 * Fallback colors only apply where tokens are unreadable (tests/SSR); in
 * the app the host document always defines them.
 */
function buildFrameDocument(html: string, isDark: boolean): string {
  const background = readHostToken("--background") || "#ffffff"
  const foreground = readHostToken("--foreground") || "#1f2328"
  const fontFamily =
    readHostToken("--font-sans") || "'Inter Variable', sans-serif"
  const colorScheme = isDark ? "dark" : "light"
  return [
    '<!doctype html><html><head><meta charset="utf-8"><style>',
    ":root { color-scheme: ",
    colorScheme,
    "; --background: ",
    background,
    "; --foreground: ",
    foreground,
    "; }",
    "html, body { margin: 0; padding: 0; background: transparent; }",
    "body { color: var(--foreground); font-family: ",
    fontFamily,
    "; font-size: 14px; line-height: 1.6; overflow-wrap: break-word; }",
    "img { max-width: 100%; height: auto; }",
    // Marker emitted by renderPlainTextAsHtml (services/renderer/plain-text).
    "[data-emailer-plaintext] { white-space: pre-wrap; }",
    "</style></head><body>",
    html,
    "<script>",
    RESIZE_SCRIPT,
    "</script></body></html>",
  ].join("")
}

function isResizeMessage(data: unknown): data is { height: number } {
  if (typeof data !== "object" || data === null) return false
  const message = data as { type?: unknown; height?: unknown }
  return (
    message.type === EMAILER_RESIZE_MESSAGE_TYPE &&
    typeof message.height === "number" &&
    Number.isFinite(message.height)
  )
}

export interface SafeEmailFrameProps {
  /**
   * Email body HTML — already sanitized (e.g. `sanitizeEmailHtml(...)` from
   * services/renderer, with whatever image policy task 7.3 applied) or the
   * output of `renderPlainTextAsHtml(...)`. Re-sanitized here idempotently
   * as defense in depth, with `blockRemoteImages: false` so an image
   * decision already made upstream is never silently reversed.
   */
  html: string
  /** Extra classes for the iframe element (layout/spacing only). */
  className?: string
}

export function SafeEmailFrame({ html, className }: SafeEmailFrameProps) {
  // Key the content component by html: a body change remounts the frame, so
  // height restarts at the floor and the freshly loaded document reports its
  // real height through the injected reporter — no stale sizing, no
  // setState-in-effect cascades.
  return <FrameContent key={html} html={html} className={className} />
}

function FrameContent({ html, className }: SafeEmailFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(MIN_EMAIL_FRAME_HEIGHT)
  // The host theme is a memo input: a light/dark flip rebuilds srcDoc so
  // the injected token values (text/background colors) never go stale.
  const isDark = useIsDarkTheme()

  const srcDoc = useMemo(
    () =>
      buildFrameDocument(
        sanitizeEmailHtml(html, { blockRemoteImages: false }),
        isDark
      ),
    [html, isDark]
  )

  // Single listener for the frame's lifetime: the iframe element (and thus
  // contentWindow) survives html-prop changes, only its document reloads.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Only accept messages authored by THIS frame — a hostile page
      // elsewhere in the app (or another frame spoofing the payload) is
      // filtered by identity, not by content.
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      if (!isResizeMessage(event.data)) return
      setHeight(Math.max(Math.ceil(event.data.height), MIN_EMAIL_FRAME_HEIGHT))
    }
    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])

  return (
    <iframe
      ref={frameRef}
      title="Email content"
      sandbox={SANDBOX}
      srcDoc={srcDoc}
      style={{ height }}
      className={cn("block w-full border-0 bg-transparent", className)}
    />
  )
}
