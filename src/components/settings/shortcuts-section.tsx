import { useMemo, useState } from "react"

import { Input } from "@/components/ui/input"
import {
  SHORTCUTS,
  SHORTCUT_GROUPS,
  type ShortcutBinding,
} from "@/constants/shortcuts"

/**
 * Settings "Shortcuts" section (task 11.3): the filterable reference over
 * the fixed binding table (src/constants/shortcuts.ts). The filter box
 * matches case-insensitively against the description and the key display;
 * an empty filter shows everything, grouped in SHORTCUT_GROUPS order.
 * Same table the `?` overlay renders — the table plus a handler in
 * useKeyboardShortcuts is the whole change when a binding is added.
 */

function matchesFilter(binding: ShortcutBinding, filter: string): boolean {
  const query = filter.trim().toLowerCase()
  if (query === "") return true
  return (
    binding.description.toLowerCase().includes(query) ||
    binding.keys.toLowerCase().includes(query)
  )
}

function ShortcutRow({ binding }: { binding: ShortcutBinding }) {
  return (
    <div
      data-testid={`shortcut-${binding.id}`}
      className="flex items-center justify-between gap-6 py-1.5"
    >
      <span className="text-sm text-muted-foreground">
        {binding.description}
      </span>
      <kbd className="inline-flex min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs font-medium text-foreground">
        {binding.keys}
      </kbd>
    </div>
  )
}

export function ShortcutsSection() {
  const [filter, setFilter] = useState("")

  const filtered = useMemo(
    () => SHORTCUTS.filter((binding) => matchesFilter(binding, filter)),
    [filter]
  )

  return (
    <section aria-label="Shortcuts" className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">Shortcuts</h2>
        <p className="text-sm text-muted-foreground">
          Every keyboard binding. Press ? anytime for the quick reference.
        </p>
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
            const bindings = filtered.filter(
              (binding) => binding.group === group.id
            )
            if (bindings.length === 0) return null
            return (
              <section
                key={group.id}
                data-testid={`shortcuts-group-${group.id}`}
              >
                <h3 className="mb-2 text-xs font-semibold tracking-wide text-foreground uppercase">
                  {group.label}
                </h3>
                <div className="flex flex-col">
                  {bindings.map((binding) => (
                    <ShortcutRow key={binding.id} binding={binding} />
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
