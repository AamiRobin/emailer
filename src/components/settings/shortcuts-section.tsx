import { useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  findConflictingBindings,
  REBINDABLE_GROUPS,
  SHORTCUT_GROUPS,
  shortcutKeysFromEvent,
  type ShortcutBinding,
  type ShortcutId,
} from "@/constants/shortcuts"
import {
  ensureShortcutOverridesLoaded,
  resetAllShortcutOverrides,
  saveShortcutOverride,
  useEffectiveShortcuts,
  useShortcutBindingsStore,
} from "@/hooks/shortcut-bindings"
import { getExecutor } from "@/services/db/executor"

/**
 * Settings "Shortcuts" section (tasks 11.3 + 20.1, design D15): the
 * filterable reference over the EFFECTIVE binding table (defaults merged
 * with the persisted overrides — the same accessor the `?` overlay and
 * the keyboard hook read), plus the rebind editor for the app-level
 * groups (navigation, actions/triage, compose, search — REBINDABLE_GROUPS).
 *
 * Editing model: clicking Change starts a key capture; the captured key
 * is canonicalized and conflict-checked (findConflictingBindings) BEFORE
 * anything is saved — on a conflict the row names the other action(s) and
 * stays capturing (the spec's "shows both actions, does not save until
 * resolved"); a clean key persists immediately (saveShortcutOverride) and
 * the hook + overlay pick it up from the shared store on the next render.
 * Esc cancels a capture; per-binding Reset and the global Reset-all
 * restore the defaults by removing overrides. While capturing, the store's
 * captureActive flag makes the global hook step aside, so the captured
 * key cannot fire the very action being rebound.
 */

function matchesFilter(binding: ShortcutBinding, filter: string): boolean {
  const query = filter.trim().toLowerCase()
  if (query === "") return true
  return (
    binding.description.toLowerCase().includes(query) ||
    binding.keys.toLowerCase().includes(query)
  )
}

const KBD_CLASS =
  "inline-flex min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs font-medium text-foreground"

interface ShortcutRowProps {
  binding: ShortcutBinding
  overridden: boolean
  capturing: boolean
  /** Descriptions of the bindings the current capture collides with. */
  conflictWith: string[]
  onChange: () => void
  onReset: () => void
  onCancel: () => void
}

function ShortcutRow({
  binding,
  overridden,
  capturing,
  conflictWith,
  onChange,
  onReset,
  onCancel,
}: ShortcutRowProps) {
  const rebindable = REBINDABLE_GROUPS.has(binding.group)
  return (
    <div
      data-testid={`shortcut-${binding.id}`}
      className="flex items-center justify-between gap-6 py-1.5"
    >
      <span className="text-sm text-muted-foreground">
        {binding.description}
      </span>
      {capturing ? (
        <div className="flex flex-col items-end gap-1">
          <kbd data-testid="shortcut-capture-hint" className={KBD_CLASS}>
            Press a key…
          </kbd>
          {conflictWith.length > 0 && (
            <p
              data-testid={`shortcut-conflict-${binding.id}`}
              className="text-right text-xs text-destructive"
            >
              {binding.description} would collide with{" "}
              {conflictWith.join(" and ")} — press another key or cancel.
            </p>
          )}
          <Button
            variant="ghost"
            size="xs"
            data-testid="cancel-rebind"
            onClick={onCancel}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <kbd
            data-testid={`shortcut-keys-${binding.id}`}
            className={KBD_CLASS}
          >
            {binding.keys}
          </kbd>
          {rebindable && (
            <Button
              variant="ghost"
              size="xs"
              data-testid={`rebind-${binding.id}`}
              aria-label={`Change shortcut for: ${binding.description}`}
              onClick={onChange}
            >
              Change
            </Button>
          )}
          {rebindable && overridden && (
            <Button
              variant="ghost"
              size="xs"
              data-testid={`reset-shortcut-${binding.id}`}
              aria-label={`Reset to default: ${binding.description}`}
              onClick={onReset}
            >
              Reset
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

export function ShortcutsSection() {
  const [filter, setFilter] = useState("")
  const [capturingId, setCapturingId] = useState<ShortcutId | null>(null)
  const [conflictWith, setConflictWith] = useState<string[]>([])
  const bindings = useEffectiveShortcuts()
  const overrides = useShortcutBindingsStore((state) => state.overrides)
  const hasOverrides = Object.keys(overrides).length > 0

  // The keyboard hook loads the persisted overrides at boot; this page
  // mounts later (post-bootstrap), so ensure() is a cheap no-op once the
  // load has run — and a fallback when the hook's first attempt was
  // deferred (pre-bootstrap) and no keydown happened yet.
  useEffect(() => {
    ensureShortcutOverridesLoaded()
  }, [])

  // Key capture: one window listener (capture phase) while a row is being
  // rebound; every keydown is consumed so neither the browser nor the
  // global shortcuts react to the captured key.
  useEffect(() => {
    if (!capturingId) return
    useShortcutBindingsStore.setState({ captureActive: true })
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === "Escape") {
        setCapturingId(null)
        setConflictWith([])
        return
      }
      const keys = shortcutKeysFromEvent(event)
      if (keys === null) return // bare modifier — keep listening
      const current = bindings.find((binding) => binding.id === capturingId)
      if (current && keys === current.keys) {
        // Re-captured the binding's own key: nothing to change.
        setCapturingId(null)
        setConflictWith([])
        return
      }
      // Edit-time conflict check (D15): the save happens only when the
      // candidate key is free; otherwise both actions are named and the
      // capture stays open for a different key.
      const conflicts = findConflictingBindings(keys, capturingId, bindings)
      if (conflicts.length > 0) {
        setConflictWith(conflicts.map((binding) => binding.description))
        return
      }
      setConflictWith([])
      try {
        void saveShortcutOverride(getExecutor(), capturingId, keys)
          .then(() => setCapturingId(null))
          .catch((error) => {
            console.warn("[shortcuts] failed to persist binding", error)
          })
      } catch (error) {
        console.warn("[shortcuts] failed to persist binding", error)
      }
    }
    window.addEventListener("keydown", onKeyDown, true)
    return () => {
      window.removeEventListener("keydown", onKeyDown, true)
      useShortcutBindingsStore.setState({ captureActive: false })
    }
  }, [capturingId, bindings])

  function startCapture(id: ShortcutId): void {
    setConflictWith([])
    setCapturingId(id)
  }

  function cancelCapture(): void {
    setCapturingId(null)
    setConflictWith([])
  }

  function resetBinding(id: ShortcutId): void {
    try {
      void saveShortcutOverride(getExecutor(), id, null).catch((error) => {
        console.warn("[shortcuts] failed to reset binding", error)
      })
    } catch (error) {
      console.warn("[shortcuts] failed to reset binding", error)
    }
  }

  function resetAllBindings(): void {
    try {
      void resetAllShortcutOverrides(getExecutor()).catch((error) => {
        console.warn("[shortcuts] failed to reset bindings", error)
      })
    } catch (error) {
      console.warn("[shortcuts] failed to reset bindings", error)
    }
  }

  const filtered = useMemo(
    () => bindings.filter((binding) => matchesFilter(binding, filter)),
    [bindings, filter]
  )

  return (
    <section aria-label="Shortcuts" className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-foreground">Shortcuts</h2>
          <p className="text-sm text-muted-foreground">
            Every keyboard binding. Press ? anytime for the quick reference.
          </p>
        </div>
        {hasOverrides && (
          <Button
            variant="outline"
            size="sm"
            data-testid="reset-all-shortcuts"
            onClick={resetAllBindings}
          >
            Reset all to defaults
          </Button>
        )}
      </div>
      <Input
        type="text"
        placeholder="Filter shortcuts…"
        aria-label="Filter shortcuts"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        className="max-w-sm"
      />
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No matching shortcuts</p>
      ) : (
        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {SHORTCUT_GROUPS.map((group) => {
            const groupBindings = filtered.filter(
              (binding) => binding.group === group.id
            )
            if (groupBindings.length === 0) return null
            return (
              <section
                key={group.id}
                data-testid={`shortcuts-group-${group.id}`}
              >
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-foreground uppercase">
                  {group.label}
                </h3>
                <div className="flex flex-col">
                  {groupBindings.map((binding) => (
                    <ShortcutRow
                      key={binding.id}
                      binding={binding}
                      overridden={overrides[binding.id] !== undefined}
                      capturing={capturingId === binding.id}
                      conflictWith={
                        capturingId === binding.id ? conflictWith : []
                      }
                      onChange={() => startCapture(binding.id)}
                      onReset={() => resetBinding(binding.id)}
                      onCancel={cancelCapture}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}
    </section>
  )
}
