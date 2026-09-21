import { invoke } from "@tauri-apps/api/core"
import { emit, listen } from "@tauri-apps/api/event"
import { getCurrentWindow } from "@tauri-apps/api/window"

import type { ThreadListChangeEvent } from "@/services/email-actions/thread-actions"

/**
 * Pop-out thread windows (task 1.9, spec "Pop-out thread windows"): the
 * JS half of the multiwindow surface — window identification, the
 * open/close commands, and the cross-window change bridge.
 *
 * Convergence model (design D8): every window keeps its local stores;
 * thread-affecting actions broadcast a `thread-data-changed` event (with
 * the acting window's label as `origin`) and remote windows re-read the
 * affected state from the shared SQLite database. Nothing ships state in
 * the events — the DB is the single source of truth, so convergence is
 * just "refresh what the event touches".
 *
 * The main window is created with label "main"; pop-outs are
 * `popout-<threadId>` (Rust sanitizes non-label-safe characters, thread
 * ids are uuid-shaped so in practice the label round-trips exactly).
 */

export const POPOUT_LABEL_PREFIX = "popout-"
/** Composer pop-out windows (batch C2): `popout-composer-<draftKey>`. The
 * prefix keeps the Rust close guard (it holds CloseRequested for every
 * `popout-*` label) and the capability's `popout-*` window pattern — the
 * route is the label, exactly like thread pop-outs. */
export const COMPOSER_POPOUT_LABEL_PREFIX = "popout-composer-"
const THREAD_DATA_CHANGED_EVENT = "thread-data-changed"

export interface PopoutThreadChangeEvent extends ThreadListChangeEvent {
  /** Label of the window the change originated in. */
  origin: string
}

/** This window's Tauri label, or null outside the Tauri runtime. */
export function currentWindowLabel(): string | null {
  if (!isTauriRuntime()) return null
  return getCurrentWindow().label
}

/** Inside the Tauri runtime? (The plain-vite mock has no window system.) */
export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
      undefined
  )
}

/** Is THIS window a pop-out thread window? Decides the boot surface. */
export function isPopoutWindow(): boolean {
  const label = currentWindowLabel()
  return label !== null && label.startsWith(POPOUT_LABEL_PREFIX)
}

/** The thread id this pop-out window shows, or null in any other window. */
export function popoutThreadId(): string | null {
  const label = currentWindowLabel()
  if (label === null || !label.startsWith(POPOUT_LABEL_PREFIX)) return null
  return label.slice(POPOUT_LABEL_PREFIX.length)
}

// ---- Composer pop-out windows (batch C2) ----

/** Label-safe folding, mirroring the Rust sanitize_label_part: Tauri
 * labels allow alphanumerics plus a small punctuation set. Draft keys are
 * uuid-shaped, so in practice this is the identity. */
function sanitizeLabelPart(part: string): string {
  return part
    .split("")
    .map((char) =>
      /[A-Za-z0-9\-_. ]/.test(char) ? char : "_"
    )
    .join("")
}

/** Is THIS window a composer pop-out? Decides the boot surface (the
 * check runs before the thread-popout one — the label carries both
 * prefixes). */
export function isComposerPopoutWindow(): boolean {
  const label = currentWindowLabel()
  return (
    label !== null && label.startsWith(COMPOSER_POPOUT_LABEL_PREFIX)
  )
}

/** The draftKey this composer pop-out resumed, or null in any other
 * window. The label IS the route — no query params involved. */
export function composerPopoutDraftKey(): string | null {
  const label = currentWindowLabel()
  if (label === null || !label.startsWith(COMPOSER_POPOUT_LABEL_PREFIX)) {
    return null
  }
  return label.slice(COMPOSER_POPOUT_LABEL_PREFIX.length)
}

/**
 * Open (or focus) a pop-out window editing the draft `draftKey`. The
 * caller persists the current snapshot FIRST (saveNow) so the popout can
 * resume the full draft — including the C1-persisted attachment bytes —
 * from the shared local_drafts row; nothing but the key travels. No-op
 * outside the Tauri runtime (the composer hides the button there).
 *
 * Created from the JS API (unlike thread pop-outs, which go through the
 * open_thread_popout command): the window needs no Rust-side setup beyond
 * the capability entries the button already rides on. The close guard for
 * `popout-*` labels applies Rust-side, so a window close is held until
 * the webview's own guard (composer-popout.tsx) resolves it.
 */
export async function openComposerPopout(draftKey: string): Promise<void> {
  if (!isTauriRuntime()) return
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow")
  const label =
    COMPOSER_POPOUT_LABEL_PREFIX + sanitizeLabelPart(draftKey)
  try {
    const existing = await WebviewWindow.getByLabel(label)
    if (existing) {
      await existing.show()
      await existing.unminimize().catch(() => {})
      await existing.setFocus()
      return
    }
    const window = new WebviewWindow(label, {
      url: "index.html",
      title: "Composer",
      width: 700,
      height: 650,
      minWidth: 480,
      minHeight: 420,
      center: true,
    })
    void window.once("tauri://error", (event) => {
      console.warn("[popout] composer window failed to open", event)
    })
  } catch (error) {
    console.warn("[popout] failed to open composer window", error)
  }
}

/**
 * Open (or focus) a pop-out window for the thread. Main-window surface:
 * the thread context menu and the reading-pane toolbar.
 */
export async function openThreadInPopout(threadId: string): Promise<void> {
  try {
    await invoke("open_thread_popout", { threadId })
  } catch (error) {
    console.warn("[popout] failed to open thread window", error)
  }
}

/**
 * Broadcast a local thread change to the other windows. Best-effort:
 * outside Tauri (mock mode, tests) there is nothing to broadcast and the
 * action continues unaffected.
 */
export async function broadcastThreadChange(
  event: ThreadListChangeEvent
): Promise<void> {
  if (!isTauriRuntime()) return
  try {
    await emit(THREAD_DATA_CHANGED_EVENT, {
      ...event,
      origin: currentWindowLabel() ?? "main",
    } satisfies PopoutThreadChangeEvent)
  } catch (error) {
    console.warn("[popout] failed to broadcast thread change", error)
  }
}

/**
 * Subscribe to thread changes that originated in OTHER windows. Resolves
 * to an unsubscribe function (no-op one outside Tauri).
 */
export async function onRemoteThreadChange(
  handler: (event: PopoutThreadChangeEvent) => void
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {}
  try {
    const own = currentWindowLabel() ?? "main"
    const unlisten = await listen<PopoutThreadChangeEvent>(
      THREAD_DATA_CHANGED_EVENT,
      (event) => {
        if (event.payload.origin !== own) handler(event.payload)
      }
    )
    return unlisten
  } catch {
    return () => {}
  }
}

/** Emitted by Rust when this pop-out window's close was requested. */
const POPOUT_CLOSE_REQUESTED_EVENT = "popout-close-requested"

/** Subscribe to this pop-out's close-request guard event. */
export async function onPopoutCloseRequested(
  handler: () => void
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {}
  try {
    const unlisten = await listen(POPOUT_CLOSE_REQUESTED_EVENT, handler)
    return unlisten
  } catch {
    return () => {}
  }
}

/**
 * Close this pop-out after the draft guard resolved. Rust-side guarded
 * to pop-out labels — it can never close the main window.
 */
export async function forceClosePopout(): Promise<void> {
  const label = currentWindowLabel()
  if (label === null) return
  await invoke("force_close_popout", { label })
}
