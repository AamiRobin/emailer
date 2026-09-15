/**
 * The single fixed keyboard-binding table (design D13, task 6.6): data
 * only — no behavior. `id` doubles as the handler-map key inside
 * useKeyboardShortcuts (src/hooks/use-keyboard-shortcuts.ts); the help
 * overlay (`?`, src/components/layout/shortcuts-overlay.tsx) and the
 * shortcuts settings reference (task 11.3) render this table directly, so
 * adding a binding here plus a handler in the hook is the whole change.
 *
 * Binding state is NOT user-configurable in this change (design D13);
 * this is also why the table is a const array, not a store.
 */

/** Areas the help overlay / settings reference group bindings by. */
export type ShortcutGroup =
  "navigation" | "actions" | "compose" | "search" | "general"

/** Stable handler ids — keep in sync with the hook's handler map. */
export type ShortcutId =
  | "next-thread"
  | "previous-thread"
  | "open-thread"
  | "archive"
  | "trash"
  | "toggle-read"
  | "toggle-star"
  | "reply"
  | "compose"
  | "refresh"
  | "focus-search"
  | "palette"
  | "help"
  | "dismiss"

export interface ShortcutBinding {
  /** Stable id — also the handler-map key in useKeyboardShortcuts. */
  id: ShortcutId
  /** Display string for the reference UI (may list aliases, e.g. "j / ↓"). */
  keys: string
  /** One-line human description shown next to the keys. */
  description: string
  group: ShortcutGroup
}

/** Fixed group order for the reference UIs; groups render only when the
 * table contains at least one binding for them. */
export const SHORTCUT_GROUPS: ReadonlyArray<{
  id: ShortcutGroup
  label: string
}> = [
  { id: "navigation", label: "Navigation" },
  { id: "actions", label: "Actions" },
  { id: "compose", label: "Compose" },
  { id: "search", label: "Search" },
  { id: "general", label: "General" },
]

/** The fixed binding table (design D13). Keys follow the mailbox-ui spec:
 * navigate, open, archive, trash, read/unread, star, reply, compose,
 * search focus, palette, help, dismiss — plus Shift+R for the manual
 * refresh (task 6.6 binds triggerRefresh; deliberately no g-chords and no
 * 1..7 folder quick-jumps, which are not in the spec). */
export const SHORTCUTS: ReadonlyArray<ShortcutBinding> = [
  {
    id: "next-thread",
    keys: "j / ↓",
    description: "Select next thread",
    group: "navigation",
  },
  {
    id: "previous-thread",
    keys: "k / ↑",
    description: "Select previous thread",
    group: "navigation",
  },
  {
    id: "open-thread",
    keys: "Enter / o",
    description: "Open the selected thread",
    group: "navigation",
  },
  {
    id: "archive",
    keys: "e",
    description: "Archive the selected thread",
    group: "actions",
  },
  {
    id: "trash",
    keys: "#",
    description: "Move the selected thread to Trash",
    group: "actions",
  },
  {
    id: "toggle-read",
    keys: "m",
    description: "Toggle read / unread",
    group: "actions",
  },
  {
    id: "toggle-star",
    keys: "s",
    description: "Toggle star",
    group: "actions",
  },
  {
    id: "reply",
    keys: "r",
    description: "Reply to the selected thread",
    group: "compose",
  },
  {
    id: "compose",
    keys: "c",
    description: "Compose a new message",
    group: "compose",
  },
  {
    id: "refresh",
    keys: "Shift+R",
    description: "Sync all accounts now",
    group: "general",
  },
  {
    id: "focus-search",
    keys: "/",
    description: "Focus the search input",
    group: "search",
  },
  {
    id: "palette",
    keys: "Cmd/Ctrl+K",
    description: "Toggle the command palette",
    group: "search",
  },
  {
    id: "help",
    keys: "?",
    description: "Show this shortcuts reference",
    group: "general",
  },
  {
    id: "dismiss",
    keys: "Esc",
    description: "Dismiss the shortcuts reference",
    group: "general",
  },
]
