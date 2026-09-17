import { useMemo } from "react"
import { create } from "zustand"

import {
  SHORTCUTS,
  type ShortcutBinding,
  type ShortcutId,
} from "@/constants/shortcuts"
import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import {
  getShortcutOverrides,
  setShortcutOverrides,
} from "@/services/settings/preferences"

/**
 * Effective shortcut bindings (task 20.1, design D15): the ONE
 * defaults-plus-overrides accessor shared by the keyboard hook, the `?`
 * overlay and the settings editor.
 *
 * Overrides live in the settings table (mail.shortcutOverrides — one JSON
 * map, see preferences.ts) as display strings in the default table's
 * format; this module merges them with src/constants/shortcuts.ts at read
 * time and owns the in-memory store the consumers read:
 *
 * - getEffectiveShortcuts() — synchronous merge for event-time reads
 *   (useKeyboardShortcuts matches keydowns against it via getState()).
 * - useEffectiveShortcuts() — the same merge, reactive, for rendering
 *   (the overlay and the settings editor).
 * - loadShortcutOverrides() / ensureShortcutOverridesLoaded() — pull the
 *   persisted map into the store (boot / first use).
 * - saveShortcutOverride() / resetAllShortcutOverrides() — persist one
 *   binding change (or the global reset) and update the store.
 *
 * Conflict detection itself is pure (findConflictingBindings in
 * constants/shortcuts.ts); the settings editor calls it BEFORE saving, so
 * a conflicting binding never reaches this store or the settings table.
 */

interface ShortcutBindingsState {
  /** Persisted display-string overrides; an absent id uses the default. */
  overrides: Partial<Record<ShortcutId, string>>
  /** While the settings editor captures a key, the global hook must not
   * also fire it (the capture listener cannot outrun the hook's earlier
   * window listener). */
  captureActive: boolean
  setOverrides: (overrides: Partial<Record<ShortcutId, string>>) => void
}

export const useShortcutBindingsStore = create<ShortcutBindingsState>(
  (set) => ({
    overrides: {},
    captureActive: false,
    setOverrides: (overrides) => set({ overrides }),
  })
)

/** Merge a stored map over the default table (an absent/invalid entry
 * keeps the default binding). */
function mergeShortcuts(
  overrides: Partial<Record<ShortcutId, string>>
): ShortcutBinding[] {
  return SHORTCUTS.map((binding) => {
    const keys = overrides[binding.id]
    return keys ? { ...binding, keys } : binding
  })
}

/**
 * The effective binding table (defaults + persisted overrides), for
 * event-time reads — call per event, like the other getState() readers in
 * the keyboard hook, so no stale closures and no re-subscription.
 */
export function getEffectiveShortcuts(): ShortcutBinding[] {
  return mergeShortcuts(useShortcutBindingsStore.getState().overrides)
}

/** The effective binding table, reactive — for rendering consumers. */
export function useEffectiveShortcuts(): ShortcutBinding[] {
  const overrides = useShortcutBindingsStore((state) => state.overrides)
  return useMemo(() => mergeShortcuts(overrides), [overrides])
}

/**
 * Read the persisted overrides into the store. Merges rather than
 * replaces: a load that races a save (or a test seeding the store) must
 * never clobber a newer in-memory binding with the stale row.
 */
export async function loadShortcutOverrides(
  executor: SqlExecutor
): Promise<void> {
  const stored = await getShortcutOverrides(executor)
  const current = useShortcutBindingsStore.getState().overrides
  useShortcutBindingsStore.getState().setOverrides({ ...stored, ...current })
}

let overridesLoadStarted = false

/**
 * Best-effort one-shot load of the persisted overrides. Safe to call
 * before bootstrap() finishes — getExecutor() throws then, and the flag
 * is released so a later call (the hook retries on keydown, the settings
 * editor on mount) loads once the database exists.
 */
export function ensureShortcutOverridesLoaded(): void {
  if (overridesLoadStarted) return
  try {
    overridesLoadStarted = true
    void loadShortcutOverrides(getExecutor()).catch((error) => {
      console.warn("[shortcut-bindings] override load failed", error)
    })
  } catch (error) {
    overridesLoadStarted = false
    console.warn("[shortcut-bindings] override load deferred", error)
  }
}

/**
 * Persist one binding change and apply it to the store: `keys` replaces
 * the binding's display string, `null` removes the override (the
 * per-binding reset — the default binding takes over again). The whole
 * map is written, threadSorts-style; a failed write leaves the store (and
 * therefore the effective bindings) untouched.
 */
export async function saveShortcutOverride(
  executor: SqlExecutor,
  id: ShortcutId,
  keys: string | null
): Promise<void> {
  const merged: Partial<Record<ShortcutId, string>> = {
    ...useShortcutBindingsStore.getState().overrides,
  }
  if (keys === null) delete merged[id]
  else merged[id] = keys
  await setShortcutOverrides(executor, merged)
  useShortcutBindingsStore.getState().setOverrides(merged)
}

/** Global reset-to-defaults: clear the persisted map and the store. */
export async function resetAllShortcutOverrides(
  executor: SqlExecutor
): Promise<void> {
  await setShortcutOverrides(executor, {})
  useShortcutBindingsStore.getState().setOverrides({})
}
