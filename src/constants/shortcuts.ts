/**
 * The default keyboard-binding table (design D15, task 20.1): data plus
 * the pure parsing/matching helpers every consumer shares. `id` doubles
 * as the handler-map key inside useKeyboardShortcuts
 * (src/hooks/use-keyboard-shortcuts.ts); the help overlay (`?`,
 * src/components/layout/shortcuts-overlay.tsx) and the shortcuts settings
 * editor (task 20.1) render the EFFECTIVE table — these defaults merged
 * with the persisted overrides (src/hooks/shortcut-bindings.ts) — so
 * adding a binding here plus a handler in the hook is the whole change.
 *
 * Overrides (D15, superseding the fixed-table stance of D13): the
 * settings editor persists display strings in this exact format under one
 * settings key (mail.shortcutOverrides — see preferences.ts) and they are
 * merged at read time. Display format contract: aliases separated by
 * " / " (a bare "/" is the slash key itself), modifiers as "Shift+"/
 * "Cmd/Ctrl+" prefixes, special keys spelled as on the caps ("Esc",
 * "Enter", "↓", "↑"). Conflict detection at edit time canonicalizes these
 * strings, so both the defaults and every saved override must keep the
 * same shape.
 */

/** Areas the help overlay / settings editor group bindings by. */
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
  | "snooze"
  | "reply"
  | "compose"
  | "send-message"
  | "close-composer"
  | "refresh"
  | "print-thread"
  | "focus-search"
  | "find-in-message"
  | "palette"
  | "help"
  | "dismiss"
  | "toggle-sidebar"

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

/** Groups the settings editor (task 20.1) lets the user rebind: the
 * app-level mail actions — navigation, triage, compose, search. The
 * "general" bindings (refresh / help / dismiss) stay fixed: they gate the
 * shell's own chrome (the `?` reference, the overlay's Esc dismiss), and
 * the spec scopes rebinding to the mail-facing groups. */
export const REBINDABLE_GROUPS: ReadonlySet<ShortcutGroup> = new Set([
  "navigation",
  "actions",
  "compose",
  "search",
])

/** The default binding table (design D15). Keys follow the mailbox-ui
 * spec: navigate, open, archive, trash, read/unread, star, reply, compose,
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
    id: "snooze",
    keys: "b",
    description: "Snooze the selected thread until tomorrow",
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
    id: "send-message",
    keys: "Cmd/Ctrl+Enter",
    description: "Send the message being composed",
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
    id: "find-in-message",
    keys: "Cmd/Ctrl+F",
    description: "Find in the open message",
    group: "search",
  },
  {
    id: "palette",
    keys: "Cmd/Ctrl+K",
    description: "Toggle the command palette",
    group: "search",
  },
  {
    id: "print-thread",
    keys: "Cmd/Ctrl+P",
    description: "Print the open thread",
    group: "actions",
  },
  {
    id: "help",
    keys: "?",
    description: "Show this shortcuts reference",
    group: "general",
  },
  {
    id: "toggle-sidebar",
    keys: "Cmd/Ctrl+\\",
    description: "Collapse or expand the sidebar",
    group: "general",
  },
  {
    id: "dismiss",
    keys: "Esc",
    description: "Dismiss the shortcuts reference",
    group: "general",
  },
  {
    // Shares Esc with "dismiss" and deliberately sits AFTER it in the
    // table: matchShortcutEvent returns the first match, so outside the
    // composer Esc keeps meaning "dismiss" (help overlay, find bar). With
    // the composer open the hook interprets either id as the composer's
    // MINIMIZE (batch C2 — the draft stays behind the shell's tray chip;
    // the close button is the save-and-close path) — and if the user
    // rebinds "dismiss" away from Esc, Esc falls through to this binding
    // and still minimizes the composer. That context-scoped overlap is
    // why the default table carries one duplicate key here. The id keeps
    // its C1 name so persisted overrides stay addressable.
    id: "close-composer",
    keys: "Esc",
    description: "Minimize the composer (the draft keeps autosaving)",
    group: "compose",
  },
]

// ---------------------------------------------------------------------------
// Display-string parsing, matching and conflict detection (design D15)
// ---------------------------------------------------------------------------

/** One matchable alias parsed from a binding's display string. */
export interface ShortcutKeyAlias {
  /** The event.key value to match ("e", "?", "Escape", "ArrowDown"). */
  key: string
  /** Cmd or Ctrl must be held (either satisfies — the palette combo). */
  cmdCtrl: boolean
  /** Shift must be held (an explicit "Shift+X" alias). */
  shift: boolean
}

/** Display spellings that differ from their event.key values. */
const KEY_NAMES: Record<string, string> = {
  Esc: "Escape",
  "↓": "ArrowDown",
  "↑": "ArrowUp",
}

/** Bare modifier keydowns carry no bindable key. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set([
  "Shift",
  "Control",
  "Meta",
  "Alt",
])

function parseKeyToken(token: string): ShortcutKeyAlias {
  // A captured "+" would otherwise split into empty parts.
  if (token === "+" || token === "Cmd/Ctrl++") {
    return { key: "+", cmdCtrl: token.startsWith("Cmd"), shift: false }
  }
  const parts = token.split("+")
  const rawKey = parts[parts.length - 1] ?? token
  let cmdCtrl = false
  let shift = false
  for (const part of parts.slice(0, -1)) {
    for (const name of part.split("/")) {
      const id = name.trim().toLowerCase()
      if (id === "cmd" || id === "ctrl") cmdCtrl = true
      else if (id === "shift") shift = true
    }
  }
  return { key: KEY_NAMES[rawKey] ?? rawKey, cmdCtrl, shift }
}

/**
 * Parse a binding's display string into its matchable aliases ("j / ↓"
 * → the j key and ArrowDown; a bare "/" is the slash key itself, while
 * "Cmd/Ctrl+K" is one alias requiring Cmd or Ctrl). Unknown spellings
 * pass through as literal event.key values.
 */
export function parseShortcutKeys(keys: string): ShortcutKeyAlias[] {
  return keys
    .split(" / ")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map(parseKeyToken)
}

/**
 * Canonical alias strings for conflict comparison: modifier prefixes
 * (Cmd folds Ctrl) plus the key, letters case-folded. Two bindings
 * conflict when their canonical sets intersect, which is what makes
 * multi-alias strings ("j / ↓") compare correctly.
 */
function canonicalShortcutAliases(keys: string): string[] {
  return parseShortcutKeys(keys).map((alias) => {
    const parts: string[] = []
    if (alias.cmdCtrl) parts.push("cmd")
    if (alias.shift) parts.push("shift")
    parts.push(/^[a-z]$/i.test(alias.key) ? alias.key.toLowerCase() : alias.key)
    return parts.join("+")
  })
}

/**
 * The bindings other than `excludeId` whose keys collide with `keys`
 * (edit-time conflict check, D15). The caller passes the effective table
 * so saved overrides are included in the comparison.
 */
export function findConflictingBindings(
  keys: string,
  excludeId: ShortcutId,
  bindings: ReadonlyArray<ShortcutBinding>
): ShortcutBinding[] {
  const candidate = new Set(canonicalShortcutAliases(keys))
  return bindings.filter(
    (binding) =>
      binding.id !== excludeId &&
      canonicalShortcutAliases(binding.keys).some((alias) =>
        candidate.has(alias)
      )
  )
}

function aliasMatchesEvent(
  alias: ShortcutKeyAlias,
  event: KeyboardEvent
): boolean {
  if (alias.cmdCtrl) {
    // The palette-combo shape: Cmd or Ctrl, never Alt or Shift.
    return (
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === alias.key.toLowerCase()
    )
  }
  // Plain aliases refuse every menu modifier, so browser/app combos pass
  // through untouched.
  if (event.metaKey || event.ctrlKey || event.altKey) return false
  if (alias.shift) return event.shiftKey && event.key === alias.key
  // Exact event.key compare: shift+letter produces the uppercase key
  // ("R"), so it never fires a plain "r" binding, while shifted
  // punctuation self-encodes ("?" matches with the physical shift held
  // or not).
  return event.key === alias.key
}

/**
 * Map a keydown to a binding id, or null when nothing matches. Bindings
 * are tried in table order; the caller passes the effective table
 * (defaults + overrides) so overridden keys take over from the defaults.
 */
export function matchShortcutEvent(
  event: KeyboardEvent,
  bindings: ReadonlyArray<ShortcutBinding>
): ShortcutId | null {
  for (const binding of bindings) {
    for (const alias of parseShortcutKeys(binding.keys)) {
      if (aliasMatchesEvent(alias, event)) return binding.id
    }
  }
  return null
}

/**
 * Inverse of the display format for the capture editor: turn a captured
 * keydown into the display string to persist, or null when the event
 * carries no bindable key (bare modifier presses; menu chords beyond the
 * Cmd/Ctrl+letter shape are refused rather than half-captured).
 */
export function shortcutKeysFromEvent(event: KeyboardEvent): string | null {
  const key = event.key
  if (MODIFIER_KEYS.has(key)) return null
  if (event.metaKey || event.ctrlKey) {
    if (event.altKey || event.shiftKey) return null
    if (/^[a-z]$/i.test(key)) return `Cmd/Ctrl+${key.toUpperCase()}`
    return null
  }
  if (event.altKey) return null
  if (event.shiftKey && /^[a-z]$/i.test(key)) {
    return `Shift+${key.toUpperCase()}`
  }
  return key
}

/**
 * The default display string of one binding ("Esc", "Cmd/Ctrl+Enter") for
 * inline UI hints — tooltips and titles next to the affordance the
 * binding drives. Reads the DEFAULT table; a persisted override changes
 * the effective binding (the reference UIs render those) but not this
 * hint, which is accepted drift for a static tooltip.
 */
export function defaultShortcutKeys(id: ShortcutId): string | null {
  return SHORTCUTS.find((binding) => binding.id === id)?.keys ?? null
}
