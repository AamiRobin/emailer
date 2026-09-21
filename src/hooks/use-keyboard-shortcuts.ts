import { useEffect } from "react"

import type { ShortcutId } from "@/constants/shortcuts"
import { matchShortcutEvent } from "@/constants/shortcuts"
import {
  ensureShortcutOverridesLoaded,
  getEffectiveShortcuts,
  useShortcutBindingsStore,
} from "@/hooks/shortcut-bindings"
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
import { printThread } from "@/services/renderer/print"
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
import { getComposerKeyActions } from "@/components/composer/composer-key-actions"
import { getSnoozePresets } from "@/services/email-actions/snooze"
import { snoozeThreadsWithRefresh } from "@/components/email/snooze-flow"

/**
 * Global keyboard shortcuts (design D13, task 6.6; overrides per D15,
 * task 20.1): ONE hook with ONE window keydown listener (capture) and the
 * binding table (src/constants/shortcuts.ts) mapped to handlers — matched
 * through the effective bindings (defaults + persisted overrides, merged
 * by src/hooks/shortcut-bindings.ts), so a settings rebind takes effect
 * on the next keydown with no re-subscription. Mounted once by App, next
 * to the shortcuts help overlay it toggles.
 *
 * Context gating (D13 — contexts decide which bindings fire), in order:
 * 1. Cmd/Ctrl+K always toggles the palette (app-global; also works while
 *    a dialog or an input has focus — the palette owns no keybinding of
 *    its own, per palette-store's contract; a palette rebound to a plain
 *    key keeps inputs safe and does not fire while typing).
 * 2. While the settings editor is capturing a new key, nothing fires —
 *    the capture cannot outrun this earlier window listener, so the hook
 *    steps aside (shortcut-bindings store's captureActive).
 * 3. While the help overlay is open, only Esc ("dismiss") passes.
 * 4. While the composer is open or the palette is open, everything else
 *    is ignored — those surfaces own their keys. The composer registers
 *    its scoped bindings with the hook (fix 2): Cmd/Ctrl+Enter sends via
 *    the same guarded entry point as the Send button, Esc minimizes to
 *    the tray chip keeping the draft (batch C2; the X button is the
 *    save-and-close path), and `c` restores a minimized composer instead
 *    of stacking a new compose; nested popovers and dialogs inside the
 *    composer close themselves first (gates 3/3.25).
 * 5. While a rendered dialog (block-sender, split, apply-now, scheduled
 *    sends, … — anything carrying role="dialog"/"alertdialog") is open,
 *    everything but the palette toggle above stands down: list actions
 *    would fire on the thread BEHIND the modal, and preventDefault would
 *    eat the focused dialog button's Enter. Checked at keydown time — a
 *    querySelector per keystroke is cheap and always current, the same
 *    trade-off as the composerOpen/palette state gates beside it.
 * 6. Find in message (task 1.1) sits with the palette: a menu-combo that
 *    fires even when focus is in an input (it cannot collide with typing),
 *    but only with a thread open — it drives the reading-pane find bar
 *    (ui-store.readingPaneFindOpen; Esc closes it when focus is elsewhere).
 * 7. While focus is inside an input / textarea / select / contenteditable,
 *    typing is never hijacked (the matcher also refuses plain keys when
 *    a menu modifier is held, and ignores auto-repeat except j/k); a key
 *    pressed on a focused interactive widget (button / link / summary /
 *    role="button") is never stolen either — that widget's Enter is its
 *    activation key.
 * 8. List bindings (navigate / open / archive / trash / read / star /
 *    snooze / reply) additionally require a thread-list context (view is
 *    folder/label/search — not settings) and a selected thread; thread
 *    actions no-op without an active account. Account-scoped actions run
 *    as the selected ROW's owning account (task 9.2 — in the unified
 *    inbox the selection may belong to any active account). Compose,
 *    refresh, help and search focus work in any (non-modal) context.
 *
 * Search-input contract (mailbox-ui): the `/` binding focuses the shell's
 * search field, identified by `data-testid="search-input"`. The field is
 * rendered by the shell (parallel task) — until it exists, or on views
 * without it, `/` no-ops gracefully (querySelector → null → nothing).
 * The shell's current field renders `data-testid="mail-search"`, so both
 * testids are matched (see the focus-search handler).
 *
 * Every handler reads fresh state via store getState() at event time, so
 * no stale closures and no re-subscription on state changes. The same
 * applies to the effective bindings — and the persisted overrides are
 * loaded best-effort: the hook mounts before bootstrap() finishes, so the
 * load retries lazily on the first keydown (ensureShortcutOverridesLoaded).
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
 * Map a keydown to a binding id, or null when no binding matches. The
 * match runs against the EFFECTIVE bindings (defaults + overrides, read
 * fresh at event time); plain keys never match while Cmd/Ctrl/Alt is held
 * (only the explicit Cmd/Ctrl combo does), so e.g. Cmd+C still reaches
 * the browser.
 */
function matchShortcut(event: KeyboardEvent): ShortcutId | null {
  return matchShortcutEvent(event, getEffectiveShortcuts())
}

/** Never fire bindings while the user is typing into a field. */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tagName = target.tagName
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT"
}

/**
 * Never steal keys from a focused interactive widget either: the target
 * is (or sits inside) a button, link, summary or role="button" element —
 * e.g. a focused toolbar or selection-bar button whose Enter is its
 * activation key. Typing targets are covered by isEditableTarget above;
 * focus on body (the list-context contract) matches none of these.
 */
const INTERACTIVE_TARGET_SELECTOR = 'button, a, [role="button"], summary'

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(INTERACTIVE_TARGET_SELECTOR) !== null
  )
}

/**
 * A rendered modal dialog owns the keyboard (Base UI's dialog popup
 * renders role="dialog"; the alert variant role="alertdialog" is the
 * same family). Queried at keydown time so the check is always current
 * — no open-state bookkeeping to drift from what is on screen.
 */
function isModalDialogOpen(): boolean {
  return (
    document.querySelector('[role="dialog"], [role="alertdialog"]') !== null
  )
}

/**
 * The composer's one nested surface that is NOT a Base UI popup: the To/
 * Cc/Bcc contact-suggestion listbox is a plain role="listbox" div under
 * the field, and its own Esc (and Enter) handling must run before the
 * composer's — the user closing a suggestion list is not asking to save
 * the draft and quit. Queried at keydown time like isModalDialogOpen;
 * the composer's other popovers (snippet picker, schedule menu, link
 * editor) render role="dialog" popups and are covered by that gate.
 */
function isComposerListboxOpen(): boolean {
  return document.querySelector('[role="listbox"]') !== null
}

/**
 * Whether the event's target sits inside the composer surface (the
 * section carries data-testid="composer-surface"; the shell's overlay
 * wraps it). The centered card is non-modal — the pointer reaches the
 * mailbox behind the overlay — so "a composer is open" no longer implies
 * "the composer owns the keys": with focus in the list behind, the list
 * keeps its shortcuts (gate 3.25 routes by focus). Composer popovers
 * (snippet picker, schedule menu, link editor) portal OUTSIDE the
 * surface but render role="dialog" and are caught by the modal gate
 * above; the bare suggestion listbox is caught by isComposerListboxOpen.
 */
function isFocusInsideComposer(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[data-testid="composer-surface"]') !== null
  )
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
 *
 * The action runs as the selected ROW's owning account (task 9.2, the
 * same resolution as the thread list's accountForTarget): every list row
 * carries its account_id, and in the unified inbox the selection may
 * belong to any active account — the account-scoped thread-actions refuse
 * a foreign accountId (resolveContext → ThreadNotFoundError), so the
 * active account would break exactly the rows unified view adds. In the
 * per-account views the row's account_id IS the active account
 * (behavior-preserving). "Not found in the list" cannot reach the
 * resolution — a missing row no-ops above, the pre-9.2 semantics.
 */
function applyToSelectedThread(
  apply: (
    executor: SqlExecutor,
    accountId: string,
    thread: ThreadRow
  ) => Promise<void>,
  options: { advanceSelection?: boolean } = {}
): void {
  const activeAccountId = useAccountStore.getState().activeAccountId
  const thread = selectedThread()
  if (!activeAccountId || !thread) return
  void (async () => {
    try {
      await apply(getExecutor(), thread.account_id, thread)
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
    // Persisted overrides (D15): load once, best-effort — the hook mounts
    // before bootstrap() finishes, so the load also retries lazily below
    // on the first keydown.
    ensureShortcutOverridesLoaded()

    const onKeyDown = (event: KeyboardEvent): void => {
      ensureShortcutOverridesLoaded()

      // A settings-editor key capture owns the keyboard: this listener
      // predates (and therefore outruns) the capture listener, so it must
      // step aside itself or the captured key would fire its old action.
      if (useShortcutBindingsStore.getState().captureActive) return

      const id = matchShortcut(event)
      if (!id) return

      // 1. Palette toggle: app-global (input- and modal-agnostic).
      if (id === "palette") {
        // A palette rebound to a PLAIN key must not fire while typing
        // (the app-global exemption above exists for the combo shape).
        if (!(event.metaKey || event.ctrlKey) && isEditableTarget(event.target))
          return
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

      // 3. Other modal surfaces own their keys entirely: a rendered
      // dialog first (its buttons' Enter must activate, and actions must
      // not reach the thread behind it), then the palette.
      if (isModalDialogOpen()) return
      if (usePaletteStore.getState().open) return

      // 3.25 Composer-local bindings (fix 2, minimized semantics batch C2;
      // focus-routing for the non-modal card): Cmd/Ctrl+Enter sends —
      // exactly the Send click, so its disabled/invalid state is honored by
      // the registered handler itself — and Esc MINIMIZES the composer: the
      // draft stays open behind the shell's tray chip (autosave keeps
      // running); only the close (X) button still saves-and-closes. `c`
      // while minimized RESTORES the surface (and refocuses it) instead of
      // stacking a new compose over the hidden draft. The modal gate above
      // already stood down while a Base UI popover/dialog is open (their
      // popups render role="dialog", and their own Esc closes THEM first);
      // the bare suggestion listbox gets the same courtesy explicitly.
      // With the centered card (the default) focus can sit in the mail
      // BEHIND the overlay — the pointer passes straight through it now —
      // and then the list keeps its keys: everything falls through to the
      // gates below, except `c`, which is swallowed (restoring a minimized
      // draft, otherwise a no-op) because stacking a second openNew over
      // the single draft would clobber it. Esc and Cmd/Ctrl+Enter behind
      // the card do nothing: neither minimizes nor sends "from the list".
      if (useUiStore.getState().composerOpen) {
        if (isComposerListboxOpen()) return
        const composerOwnsKeys =
          useUiStore.getState().composerMode === "full" ||
          isFocusInsideComposer(event.target)
        if (composerOwnsKeys) {
          if (id === "send-message") {
            event.preventDefault()
            event.stopPropagation()
            getComposerKeyActions()?.send()
            return
          }
          if (id === "dismiss" || id === "close-composer") {
            event.preventDefault()
            event.stopPropagation()
            getComposerKeyActions()?.minimize()
            return
          }
          if (id === "compose") {
            event.preventDefault()
            if (useComposerStore.getState().minimized) {
              getComposerKeyActions()?.restore()
            }
            return
          }
          return
        }
        // Focus is in the mail behind the non-modal card: only `c` is
        // special (see above); everything else falls through — gate 4
        // still guards typing/focused widgets, and the list bindings keep
        // their thread-list context.
        if (id === "compose") {
          event.preventDefault()
          if (useComposerStore.getState().minimized) {
            getComposerKeyActions()?.restore()
          }
          return
        }
      }

      // 3.5 Find in message (task 1.1): opens the reading-pane find bar
      // for the open thread. Like the palette above, a menu-combo binding
      // that also fires while focus sits in an input (a plain "f" can
      // never match it). No thread open → no-op.
      if (id === "find-in-message") {
        if (useUiStore.getState().activeThread === null) return
        event.preventDefault()
        useUiStore.getState().setReadingPaneFindOpen(true)
        return
      }

      // 4. Never hijack typing — or a focused interactive widget.
      if (isEditableTarget(event.target)) return
      if (isInteractiveTarget(event.target)) return

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
        case "snooze": {
          if (!isThreadListContext()) return
          event.preventDefault()
          // The keyboard takes the default "Tomorrow 8:00" preset directly
          // (the immediate-run pattern of the other actions); the picker
          // menu lives on the pointer surfaces (row, context menu, toolbar).
          const thread = selectedThread()
          const tomorrow = getSnoozePresets().presets.find(
            (preset) => preset.id === "tomorrow"
          )
          if (!thread || !tomorrow) return
          void snoozeThreadsWithRefresh(
            getExecutor(),
            [thread.id],
            tomorrow.until,
            tomorrow.label
          ).then((snoozed) => {
            // Removal-style action: keep the cursor on the next row.
            if (snoozed) selectNeighboringThread(thread.id)
          })
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
          // Own the row's account too (task 9.2): the opener re-loads the
          // thread and refuses an account mismatch, so a unified-inbox row
          // from another account must reply as its owning account.
          void openReplyForThread({
            threadId: thread.id,
            replyAll: false,
            accountId: thread.account_id,
          })
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
        case "print-thread": {
          // Print the whole open thread (task 1.10); per-message printing
          // lives in the reading pane's print menu. No thread open → no-op.
          const openThread = useUiStore.getState().activeThread
          if (openThread === null) return
          event.preventDefault()
          void printThread(openThread, { kind: "thread" }).catch((error) => {
            console.warn("[use-keyboard-shortcuts] print failed", error)
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
          // With the find bar open, Esc is ITS close key (the input's own
          // handler covers focus inside the bar — this is the anywhere-
          // else case). Otherwise nothing modal is open and Esc stays
          // untouched for whatever has focus.
          if (useUiStore.getState().readingPaneFindOpen) {
            event.preventDefault()
            useUiStore.getState().setReadingPaneFindOpen(false)
          }
          return
      }
    }

    // Capture: see keys before focused widgets, so gating (not the DOM)
    // decides what fires.
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [helpOpen, setHelpOpen])
}
