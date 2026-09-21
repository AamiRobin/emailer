import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

import { cn } from "@/lib/utils"
import { sanitizeEmailHtml } from "@/services/renderer/sanitize"

import {
  EMAILER_FIND_ACTIVE_ATTR,
  EMAILER_FIND_OPEN_TYPE,
  EMAILER_FIND_MARK_ATTR,
  FindSessionContext,
  isFindFrameRequest,
  isFindFrameState,
} from "./find-session"
import {
  emailFindController,
  findControllerParams,
} from "./find-frame-controller"

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
 *
 * Find-in-message (task 1.1, design D5): the frame also runs the search —
 * the shell cannot mirror this document (opaque origin), so the injected
 * controller highlights matches, reports counts and navigates on command
 * over the same postMessage channel. Search is purely local DOM work: no
 * fetch, no image unblocking, no network of any kind. The controller is
 * serialized into the document (see its doc comment) and is exercised
 * directly by the tests — jsdom does not run srcdoc scripts.
 */

/** postMessage contract: { type: EMAILER_RESIZE_MESSAGE_TYPE, height: px }. */
export const EMAILER_RESIZE_MESSAGE_TYPE = "emailer-resize"

/** Height floor so empty/loading bodies never collapse to zero. */
export const MIN_EMAIL_FRAME_HEIGHT = 120

/**
 * Upper clamp for the frame's reported height: the value comes from the
 * (sanitized, sandboxed) mail document, but a hostile message can still
 * declare a huge layout. Beyond this the frame itself scrolls, so the
 * reading pane can never be pushed off-screen.
 */
export const MAX_EMAIL_FRAME_HEIGHT = 20_000

const SANDBOX = "allow-scripts allow-popups allow-popups-to-escape-sandbox"

/** Highlight styling for find marks: neutral yellow for matches, orange
 * for the active one (works on light and dark backgrounds alike). */
const FIND_MARK_CSS =
  `mark[${EMAILER_FIND_MARK_ATTR}] { background-color: rgba(250, 204, 21, 0.5); color: inherit; }` +
  `mark[${EMAILER_FIND_MARK_ATTR}][${EMAILER_FIND_ACTIVE_ATTR}] { background-color: #fb923c; color: #ffffff; }`

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

/** Serialized controller invocation — the frame's find machinery. */
const FIND_SCRIPT = `(${emailFindController.toString()})(${JSON.stringify(
  findControllerParams()
)});`

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
 * the host tokens at build time + base typography + the resize reporter
 * (+ the find controller for message frames). Fallback colors only apply
 * where tokens are unreadable (tests/SSR); in the app the host document
 * always defines them.
 */
function buildFrameDocument(
  html: string,
  isDark: boolean,
  monospace: boolean
): string {
  const background = readHostToken("--background") || "#ffffff"
  const foreground = readHostToken("--foreground") || "#1f2328"
  const fontFamily = monospace
    ? readHostToken("--font-mono") || "ui-monospace, SFMono-Regular, monospace"
    : readHostToken("--font-sans") || "'Inter Variable', sans-serif"
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
    FIND_MARK_CSS,
    "</style></head><body>",
    html,
    "<script>",
    RESIZE_SCRIPT,
    "</script>",
    monospace ? "" : `<script>${FIND_SCRIPT}</script>`,
    "</body></html>",
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
  /**
   * "message" (default) renders email content and joins the find-in-
   * message session (task 1.1) when one is provided above. "source"
   * (task 1.2) renders already-escaped raw text inert — monospace, no
   * HTML execution, no remote loads, and deliberately NO find controller
   * (the source dialog is not part of the reading pane's session).
   */
  variant?: "message" | "source"
}

export function SafeEmailFrame({
  html,
  className,
  variant = "message",
}: SafeEmailFrameProps) {
  // Key the content component by html: a body change remounts the frame, so
  // height restarts at the floor and the freshly loaded document reports its
  // real height through the injected reporter — no stale sizing, no
  // setState-in-effect cascades.
  return (
    <FrameContent
      key={html}
      html={html}
      className={className}
      variant={variant}
    />
  )
}

function FrameContent({
  html,
  className,
  variant,
}: SafeEmailFrameProps & { variant: "message" | "source" }) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(MIN_EMAIL_FRAME_HEIGHT)
  // The host theme is a memo input: a light/dark flip rebuilds srcDoc so
  // the injected token values (text/background colors) never go stale.
  const isDark = useIsDarkTheme()
  // The thread's find session, when the frame is part of the reading pane
  // (context is null in popouts and the source dialog → no find support).
  const session = useContext(FindSessionContext)
  const monospace = variant === "source"
  const findEnabled = variant === "message" && session !== null
  const findSessionRef = useRef(session)
  const frameIdRef = useRef<string | null>(null)

  const srcDoc = useMemo(
    () =>
      buildFrameDocument(
        sanitizeEmailHtml(html, { blockRemoteImages: false }),
        isDark,
        monospace
      ),
    [html, isDark, monospace]
  )

  // Join the find session for the frame's lifetime: the handle posts
  // commands into THIS frame's contentWindow; the id correlates the
  // frame's reports back to its count slot (insertion order = document
  // order, which is the global match order). srcDoc is a dependency on
  // purpose: a theme flip rebuilds the frame document, the reload wipes
  // the frame controller's marks and seq state, and re-running the effect
  // re-registers — registerFrame posts the live round's term to a frame
  // joining an open round, so the fresh document re-joins mid-search.
  // The cleanup unregisters exactly the previous id once per cycle, so
  // the session never double-counts the frame.
  useEffect(() => {
    if (!findEnabled || !session) return
    const frame = frameRef.current
    if (!frame) return
    const id = session.registerFrame({
      post: (command) => {
        frame.contentWindow?.postMessage(command, "*")
      },
    })
    frameIdRef.current = id
    return () => {
      frameIdRef.current = null
      session.unregisterFrame(id)
    }
  }, [findEnabled, session, srcDoc])

  // Single listener for the frame's lifetime: the iframe element (and thus
  // contentWindow) survives html-prop changes, only its document reloads.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Only accept messages authored by THIS frame — a hostile page
      // elsewhere in the app (or another frame spoofing the payload) is
      // filtered by identity, not by content.
      const frame = frameRef.current
      if (!frame || event.source !== frame.contentWindow) return
      if (isResizeMessage(event.data)) {
        setHeight(
          Math.min(
            Math.max(Math.ceil(event.data.height), MIN_EMAIL_FRAME_HEIGHT),
            MAX_EMAIL_FRAME_HEIGHT
          )
        )
        return
      }
      // Find traffic (task 1.1): reports aggregate into the session, key
      // requests reach the reading pane's open/escape hooks.
      if (!findSessionRef.current) return
      if (isFindFrameState(event.data)) {
        const id = frameIdRef.current
        if (id !== null) findSessionRef.current.handleFrameState(id, event.data)
        return
      }
      if (isFindFrameRequest(event.data)) {
        if (event.data.type === EMAILER_FIND_OPEN_TYPE) {
          findSessionRef.current.openRequest()
        } else {
          findSessionRef.current.escapeRequest()
        }
      }
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
