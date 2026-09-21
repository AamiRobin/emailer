import { useEffect } from "react"

import { useShortcutBindingsStore } from "@/hooks/shortcut-bindings"
import { listQuickSteps } from "@/services/settings/quick-steps"
import {
  currentQuickStepTargets,
  runQuickStepWithConfirm,
} from "@/services/quick-steps/run-with-confirm"
import { getThreadListExecutor } from "@/stores/thread-list-store"
import { usePaletteStore } from "@/stores/palette-store"
import { useUiStore } from "@/stores/ui-store"

/**
 * Per-step quick-step keyboard shortcuts (task 3.2, design D13): each
 * step may carry ONE plain digit 1–9 (stored on the step itself — NOT
 * the fixed src/constants/shortcuts.ts registry, whose editor/conflict
 * system exists for fixed bindings). Pressing the digit runs the step
 * against the current selection (or the active thread), the exact
 * targeting of the context-menu entry.
 *
 * Mounted once by the mail shell, beside the global shortcuts hook
 * (6.6). Gating mirrors that hook's contract, in order: step aside while
 * the settings key-capture editor holds the keyboard, while any modal
 * dialog is rendered (the confirm-once dialog included — and the
 * shortcuts-help overlay), while the composer or the palette is open,
 * while typing into a field, and when a focused interactive widget owns
 * the key; then require a thread-list context (folder/label/search view)
 * — quick steps act on threads, never on settings view state. No
 * modifiers and no auto-repeat: a held digit must not machine-gun a
 * chain of destructive actions.
 *
 * Freshness ("changes apply to subsequent runs everywhere"): the steps
 * are RE-READ on every matching keydown (one indexed settings-JSON row —
 * cheap at this scale) rather than cached, so an edit in Settings
 * applies to the very next keypress with no invalidation plumbing.
 */
export function useQuickStepShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Plain digits only — never with modifiers (Cmd+1 et al. stay with
      // the browser), never auto-repeat.
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (event.repeat) return
      if (event.key.length !== 1 || event.key < "1" || event.key > "9") return

      // A settings-editor key capture owns the keyboard (the 6.6 hook's
      // same gate — this listener also predates the capture).
      if (useShortcutBindingsStore.getState().captureActive) return

      // Modal surfaces own their keys: any rendered dialog (including the
      // quick-step confirm dialog and the shortcuts help overlay), the
      // composer, the palette.
      if (document.querySelector('[role="dialog"], [role="alertdialog"]'))
        return
      if (useUiStore.getState().composerOpen) return
      if (usePaletteStore.getState().open) return

      // Never hijack typing — or a focused interactive widget's key.
      const target = event.target
      if (target instanceof HTMLElement) {
        if (target.isContentEditable) return
        const tagName = target.tagName
        if (
          tagName === "INPUT" ||
          tagName === "TEXTAREA" ||
          tagName === "SELECT"
        ) {
          return
        }
      }
      if (
        target instanceof Element &&
        target.closest('button, a, [role="button"], summary') !== null
      ) {
        return
      }

      // Thread-list context only (the 6.6 hook's rule): quick steps act
      // on the list's selection/open thread.
      const view = useUiStore.getState().view
      if (
        view.kind !== "folder" &&
        view.kind !== "label" &&
        view.kind !== "search"
      ) {
        return
      }

      event.preventDefault()
      void (async () => {
        // Fresh read per keydown (see the module comment).
        const steps = await listQuickSteps(getThreadListExecutor())
        const step = steps.find((candidate) => candidate.shortcut === event.key)
        if (!step) return
        const targetIds = currentQuickStepTargets()
        if (targetIds.length === 0) return
        await runQuickStepWithConfirm(step, targetIds)
      })()
    }

    // Capture: see keys before focused widgets, so the gating (not the
    // DOM) decides what fires — same as the global shortcuts hook.
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [])
}
