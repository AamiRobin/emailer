import { useEffect } from "react"

import type { ShortcutId } from "@/constants/shortcuts"
import {
  archiveThread,
  setThreadRead,
  setThreadStarred,
  trashThread,
} from "@/services/email-actions/thread-actions"
import { getExecutor } from "@/services/db/executor"
import type { SqlExecutor } from "@/services/db/executor"
import type { ThreadRow } from "@/services/db/threads"
import { triggerRefresh } from "@/services/sync/scheduler"
import { useAccountStore } from "@/stores/account-store"
import { useComposerStore } from "@/stores/composer-store"
import { useFolderCountsStore } from "@/stores/folder-counts-store"
import { usePaletteStore } from "@/stores/palette-store"
import {
  moveThreadSelection,
  refreshThreadList,
  selectNeighboringThread,
  selectRangeTo,
  useThreadListStore,
} from "@/stores/thread-list-store"
import { useUiStore } from "@/stores/ui-store"
import { openReplyForThread } from "@/components/email/reply-opener"

/**
 * Global keyboard shortcuts (design D13, task 6.6): ONE hook with ONE
 * window keydown listener (capture) and a fixed binding table (src/
 * constants/shortcuts.ts) mapped to handlers. Mounted once by App, next
 * to the shortcuts help overlay it toggles.
 *
 * Context gating (D13 — contexts decide which bindings fire), in order:
 * 1. Cmd/Ctrl+K always toggles the palette (app-global; also works while
 *    a dialog or an input has focus — the palette owns no keybinding of
 *    its own, per palette-store's contract).
 * 2. While the help overlay is open, only Esc ("dismiss") passes.
 * 3. While the composer is open or the palette is open, everything else
 *    is ignored — those surfaces own their own keys (the composer keeps
 *    its Esc handling; nothing is duplicated here).
 * 4. While focus is inside an input / textarea / select / contenteditable,
 *    typing is never hijacked (the matcher also refuses plain keys when
 *    a menu modifier is held, and ignores auto-repeat except j/k).
 * 5. List bindings (navigate / open / archive / trash / read / star /
 *    reply) additionally require a thread-list context (view is
 *    folder/label/search — not settings) and a selected thread; thread
 *    actions no-op without an active account. Compose, refresh, help and
 *    search focus work in any (non-modal) context.
 *
 * Search-input contract (mailbox-ui): the `/` binding focuses the shell's
 * search field, identified by `data-testid="search-input"`. The field is
 * rendered by the shell (parallel task) — until it exists, or on views
 * without it, `/` no-ops gracefully (querySelector → null → nothing).
 * The shell's current field renders `data-testid="mail-search"`, so both
 * testids are matched (see the focus-search handler).
 *
 * Every handler reads fresh state via store getState() at event time, so
 * no stale closures and no re-subscription on state changes.
 */

export interface UseKeyboardShortcutsOptions {
  /** Whether the shortcuts help overlay (rendered by the caller) is open. */
  helpOpen: boolean
  /** Open/close the help overlay (`?` opens, Esc dismisses). */
  setHelpOpen: (open: boolean) => void
}

/** Bindings that deliberately follow auto-repeat (held j/k scrolling). */
const REPEATABLE_IDS: ReadonlySet<ShortcutId> = new Set([
  "next-thread",
  "previous-thread",
])

/**
 * Map a keydown to a binding id, or null when no binding matches.
 * Plain keys never match while Cmd/Ctrl/Alt is held (only the explicit
 * Cmd/Ctrl+K combo does), so e.g. Cmd+C still reaches the browser.
 */
function matchShortcut(event: KeyboardEvent): ShortcutId | null {
  const key = event.key
  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
    if (key.toLowerCase() === "k") return "palette"
    return null
  }
  if (event.metaKey || event.ctrlKey || event.altKey) return null
  switch (key) {
    case "j":
    case "ArrowDown":
      return "next-thread"
    case "k":
    case "ArrowUp":
      return "previous-thread"
    case "Enter":
    case "o":
      return "open-thread"
    case "e":
      return "archive"
    case "#":
      return "trash"
    case "m":
      return "toggle-read"
    case "s":
      return "toggle-star"
    case "r":
      return "reply"
    case "R":
      return "refresh"
    case "c":
      return "compose"
    case "/":
      return "focus-search"
    case "?":
      return "help"
    case "Escape":
      return "dismiss"
    default:
      return null
  }
}

/** Never fire bindings while the user is typing into a field. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tagName = target.tagName
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT"
}

/** A thread-list context: any view backed by the center-pane list. */
function isThreadListContext(): boolean {
  const view = useUiStore.getState().view
  return (
    view.kind === "folder" || view.kind === "label" || view.kind === "search"
  )
}

/** The currently selected row of the visible list, or null. */
function selectedThread(): ThreadRow | null {
  const { threads } = useThreadListStore.getState()
  const activeId = useUiStore.getState().activeThread
  if (!activeId) return null
  return threads.find((thread) => thread.id === activeId) ?? null
}

/**
 * The row `delta` positions from the cursor (clamped), without moving it —
 * used by shift+j/k / shift+arrow range extension. Null when there is no
 * neighbor in that direction.
 */
function neighborThread(delta: number): ThreadRow | null {
  const { threads } = useThreadListStore.getState()
  const current = selectedThread()
  if (!current) return null
  const currentIndex = threads.findIndex((thread) => thread.id === current.id)
  const nextIndex = currentIndex + delta
  if (nextIndex < 0 || nextIndex >= threads.length) return null
  return threads[nextIndex] ?? null
}

/**
 * Post-action cache refresh (task 10.1 wiring): re-read the visible list
 * and the sidebar folder badges. Best-effort — the refreshes catch their
 * own query failures.
 */
function afterActionRefresh(): void {
  void refreshThreadList()
  void useFolderCountsStore.getState().refreshFolderCounts()
}

/**
 * Run a thread action against the selected thread (D10 executor-first:
 * pass getExecutor()). No-ops without an active account or a selection;
 * action errors (typed ThreadNotFoundError & co.) are logged, never
 * thrown into the keydown handler. On success, refreshes the caches and
 * — for removal-style actions — advances the selection to the neighbor
 * (mailbox-ui keyboard scenario).
 */
function applyToSelectedThread(
  apply: (
    executor: SqlExecutor,
    accountId: string,
    thread: ThreadRow
  ) => Promise<void>,
  options: { advanceSelection?: boolean } = {}
): void {
  const accountId = useAccountStore.getState().activeAccountId
  const thread = selectedThread()
  if (!accountId || !thread) return
  void (async () => {
    try {
      await apply(getExecutor(), accountId, thread)
    } catch (error) {
      console.warn("[use-keyboard-shortcuts] thread action failed", error)
      return
    }
    if (options.advanceSelection) selectNeighboringThread(thread.id)
    afterActionRefresh()
  })()
}

/** Open the composer from the keyboard (the `c` compose binding). Reply
 * takes the shared prefill path instead — see the "reply" handler. */
function openComposer(): void {
  useComposerStore
    .getState()
    .openNew(useAccountStore.getState().activeAccountId)
  useUiStore.getState().setComposerOpen(true)
}

/**
 * Mount the global shortcuts. Pass the help-overlay open state owned by
 * the mounting component (App) — the hook opens it on `?` and dismisses
 * on Esc; the overlay's own Esc path funnels through the same setter.
 */
export function useKeyboardShortcuts({
  helpOpen,
  setHelpOpen,
}: UseKeyboardShortcutsOptions): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const id = matchShortcut(event)
      if (!id) return

      // 1. Palette toggle: app-global (input- and modal-agnostic).
      if (id === "palette") {
        event.preventDefault()
        const palette = usePaletteStore.getState()
        palette.setOpen(!palette.open)
        return
      }

      // 2. Help overlay open: only Esc passes through.
      if (helpOpen) {
        if (id === "dismiss") {
          event.preventDefault()
          setHelpOpen(false)
        }
        return
      }

      // 3. Other modal surfaces own their keys entirely.
      if (useUiStore.getState().composerOpen) return
      if (usePaletteStore.getState().open) return

      // 4. Never hijack typing.
      if (isEditableTarget(event.target)) return

      // Auto-repeat only for list navigation.
      if (event.repeat && !REPEATABLE_IDS.has(id)) return

      switch (id) {
        case "next-thread":
        case "previous-thread": {
          if (!isThreadListContext()) return
          event.preventDefault()
          // Shift+j/k / shift+arrow extends the multi-select range from the
          // anchor instead of moving the cursor (spec: shift-arrow ranges).
          if (event.shiftKey) {
            const target = neighborThread(id === "next-thread" ? 1 : -1)
            if (target) selectRangeTo(target.id)
            return
          }
          moveThreadSelection(id === "next-thread" ? 1 : -1)
          return
        }
        case "open-thread": {
          if (!isThreadListContext()) return
          event.preventDefault()
          const thread = selectedThread()
          if (!thread) {
            // Nothing selected yet: Enter/o enters the list at the top.
            const first = useThreadListStore.getState().threads[0]
            if (first) useUiStore.getState().setActiveThread(first.id)
            return
          }
          useUiStore.getState().setActiveThread(thread.id)
          return
        }
        case "archive": {
          if (!isThreadListContext()) return
          event.preventDefault()
          applyToSelectedThread(
            (executor, accountId, thread) =>
              archiveThread(executor, accountId, thread.id),
            { advanceSelection: true }
          )
          return
        }
        case "trash": {
          if (!isThreadListContext()) return
          event.preventDefault()
          applyToSelectedThread(
            (executor, accountId, thread) =>
              trashThread(executor, accountId, thread.id),
            { advanceSelection: true }
          )
          return
        }
        case "toggle-read": {
          if (!isThreadListContext()) return
          event.preventDefault()
          applyToSelectedThread((executor, accountId, thread) =>
            setThreadRead(
              executor,
              accountId,
              thread.id,
              // Unread messages present → mark read; otherwise unread.
              thread.unread_count > 0
            )
          )
          return
        }
        case "toggle-star": {
          if (!isThreadListContext()) return
          event.preventDefault()
          applyToSelectedThread((executor, accountId, thread) =>
            setThreadStarred(
              executor,
              accountId,
              thread.id,
              thread.is_starred !== 1
            )
          )
          return
        }
        case "reply": {
          if (!isThreadListContext()) return
          event.preventDefault()
          // Same shared prefill path as the reading pane's Reply button
          // and the list's context menu (mail-organization: the surfaces
          // mirror each other). Fire-and-forget; the opener logs its own
          // failures and leaves the composer closed when the thread has
          // no messages or the db is unavailable.
          const thread = selectedThread()
          if (!thread) return
          void openReplyForThread({ threadId: thread.id, replyAll: false })
          return
        }
        case "compose": {
          event.preventDefault()
          openComposer()
          return
        }
        case "refresh": {
          event.preventDefault()
          void triggerRefresh().catch((error) => {
            console.warn("[use-keyboard-shortcuts] refresh failed", error)
          })
          return
        }
        case "focus-search": {
          event.preventDefault()
          // Shell contract: the header search field carries
          // data-testid="search-input". The shell's current search-field
          // implementation (task 6.2 worker) renders
          // data-testid="mail-search", so both are accepted here until the
          // contract converges; absent field → graceful no-op.
          const input = document.querySelector<HTMLInputElement>(
            '[data-testid="search-input"], [data-testid="mail-search"]'
          )
          input?.focus()
          return
        }
        case "help": {
          event.preventDefault()
          setHelpOpen(true)
          return
        }
        case "dismiss":
          // Nothing modal is open (handled above); Esc stays untouched
          // for whatever has focus.
          return
      }
    }

    // Capture: see keys before focused widgets, so gating (not the DOM)
    // decides what fires.
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [helpOpen, setHelpOpen])
}
