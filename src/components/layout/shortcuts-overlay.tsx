import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  SHORTCUTS,
  SHORTCUT_GROUPS,
  type ShortcutBinding,
} from "@/constants/shortcuts"

/**
 * Shortcuts help overlay (task 6.6): the `?` reference required by the
 * mailbox-ui spec. Purely presentational — open state is owned by the
 * mount point (App) and shared with useKeyboardShortcuts, which opens it
 * on `?` and dismisses on Esc; the dialog's native Esc path funnels into
 * the same onOpenChange. Rows render straight from the fixed binding
 * table (src/constants/shortcuts.ts), grouped by area in table order —
 * the same table the shortcuts settings section (11.3) will present.
 */

/** Single binding row: description on the left, key cap(s) on the right. */
function ShortcutRow({ binding }: { binding: ShortcutBinding }) {
  return (
    <div
      data-testid={`shortcut-${binding.id}`}
      className="flex items-center justify-between gap-6"
    >
      <dt className="text-sm text-muted-foreground">{binding.description}</dt>
      <dd>
        <kbd className="inline-flex min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs font-medium text-foreground">
          {binding.keys}
        </kbd>
      </dd>
    </div>
  )
}

interface ShortcutsOverlayProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ShortcutsOverlay({
  open,
  onOpenChange,
}: ShortcutsOverlayProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="shortcuts-overlay" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Press ? anytime to reopen this reference; Esc dismisses it.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-x-8 gap-y-5 sm:grid-cols-2">
          {SHORTCUT_GROUPS.map((group) => {
            const bindings = SHORTCUTS.filter(
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
                <dl className="flex flex-col gap-2">
                  {bindings.map((binding) => (
                    <ShortcutRow key={binding.id} binding={binding} />
                  ))}
                </dl>
              </section>
            )
          })}
        </div>
      </DialogContent>
    </Dialog>
  )
}
