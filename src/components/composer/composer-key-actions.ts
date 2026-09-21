/**
 * Composer-scoped key actions (composer batch C1, fix 2; minimized-state
 * semantics batch C2): the bridge between the global shortcut hook
 * (src/hooks/use-keyboard-shortcuts.ts) and the composer view's own flows.
 *
 * The hook owns ONE window keydown listener with the binding table
 * (constants/shortcuts.ts); while ui-store.composerOpen is true it fires:
 * - "send-message" (Cmd/Ctrl+Enter) → `send` — exactly the Send click
 *   (guards, PGP prompts, undo window apply identically);
 * - Esc ("dismiss"/"close-composer") → `minimize` — batch C2 redefined
 *   Esc from C1's save-and-close to MINIMIZE: the draft stays open behind
 *   the shell's tray chip (autosave keeps running). The close (X) button
 *   keeps the save-and-close flow (`keepDraftAndClose`) but is pointer-only;
 * - "compose" (`c`) → `restore` while minimized — brings the surface back
 *   (and refocuses) instead of stacking a new compose over the minimized
 *   one. Outside the minimized state the binding is swallowed (the composer
 *   owns its keys) exactly as before.
 *
 * The shell's tray chip (composer-tray-chip.tsx) also consults this
 * registry: its body runs `restore`, its small × runs `keepDraftAndClose`.
 *
 * The view installs its handlers here on every render and clears them on
 * unmount, the same module-level, React-free callback pattern the snippet
 * insertion uses (snippet-insert.ts setSnippetShortcuts). The hook only
 * consults this registry while ui-store.composerOpen is true, and the view
 * is only mounted while it is open, so a stale entry can never fire.
 */

export interface ComposerKeyActions {
  /** The guarded Send entry point — identical to clicking Send. */
  send: () => void
  /** Minimize to the tray chip, keeping the draft (the Esc binding,
   * batch C2). */
  minimize: () => void
  /** Leave the minimized state and refocus the composer (chip click and
   * the `c` binding while minimized). */
  restore: () => void
  /** saveNow + close, identical to the close (X) button — the tray
   * chip's × uses it while the overlay itself is hidden. */
  keepDraftAndClose: () => void
}

let actions: ComposerKeyActions | null = null

/** Install (or, with null, remove) the mounted composer's key actions. */
export function setComposerKeyActions(next: ComposerKeyActions | null): void {
  actions = next
}

/** The mounted composer's key actions, or null while it is closed. */
export function getComposerKeyActions(): ComposerKeyActions | null {
  return actions
}
