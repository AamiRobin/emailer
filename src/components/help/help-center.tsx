import { useMemo, useState } from "react"

import { BookOpen, ChevronDown, Search, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  SHORTCUT_GROUPS,
  type ShortcutBinding,
} from "@/constants/shortcuts"
import { useEffectiveShortcuts } from "@/hooks/shortcut-bindings"
import {
  HELP_CARDS,
  SHORTCUTS_CARD_ID,
  type HelpCard,
} from "@/services/help/content"
import { searchHelpGrouped } from "@/services/help/search"
import { useUiStore } from "@/stores/ui-store"

/**
 * The in-app help center (task 2.9, mailbox-ui spec "In-app help center",
 * design D14): a searchable, categorized card grid over the bundled
 * catalog (src/services/help/content.ts). Everything renders from local
 * constants — no fetches, no storage — so the center works fully offline.
 *
 * The component mounts in two places:
 * - inline, as the Settings → Help section (HelpSection below);
 * - inside HelpCenterDialog, opened from the command palette
 *   ("Open help center") via ui-store.helpCenterOpen.
 *
 * The app has no OS menu bar, so the mailbox-ui spec's "help menu entry"
 * maps to that palette command plus the settings section — both reachable
 * from anywhere in the app without leaving it.
 *
 * The keyboard-shortcuts card (content.ts SHORTCUTS_CARD_ID) renders the
 * LIVE binding table — useEffectiveShortcuts (defaults + persisted
 * overrides, design D15) grouped by SHORTCUT_GROUPS — never a copy, so
 * the reference cannot drift from src/constants/shortcuts.ts and shows
 * custom bindings immediately.
 */

/** Shared kbd-cap styling for the shortcuts reference rows. */
const KBD_CLASS =
  "inline-flex min-w-6 items-center justify-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-xs font-medium text-foreground"

/**
 * The live keyboard-shortcut reference: one column per used group, in
 * the fixed SHORTCUT_GROUPS order, rows from the effective table.
 */
function ShortcutsReference() {
  const bindings = useEffectiveShortcuts()
  return (
    <div
      data-testid="help-shortcuts-reference"
      className="grid gap-x-6 gap-y-4 sm:grid-cols-2"
    >
      {SHORTCUT_GROUPS.map((group) => {
        const groupBindings = bindings.filter(
          (binding: ShortcutBinding) => binding.group === group.id
        )
        if (groupBindings.length === 0) return null
        return (
          <div key={group.id} data-testid={`help-shortcuts-group-${group.id}`}>
            <h4 className="mb-1.5 text-xs font-semibold tracking-wide text-foreground uppercase">
              {group.label}
            </h4>
            <dl className="flex flex-col gap-1.5">
              {groupBindings.map((binding) => (
                <div
                  key={binding.id}
                  data-testid={`help-shortcut-${binding.id}`}
                  className="flex items-center justify-between gap-4"
                >
                  <dt className="text-xs text-muted-foreground">
                    {binding.description}
                  </dt>
                  <dd>
                    <kbd className={KBD_CLASS}>{binding.keys}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )
      })}
    </div>
  )
}

/**
 * One expanding help card: the title row toggles the article open; a
 * search that surfaced the card (forceOpen) keeps it expanded so the
 * answer is visible without a second click.
 */
function HelpCardView({
  card,
  forceOpen,
}: {
  card: HelpCard
  forceOpen: boolean
}) {
  const [open, setOpen] = useState(false)
  const expanded = forceOpen || open
  const isShortcutsCard = card.id === SHORTCUTS_CARD_ID
  return (
    <Card size="sm" className="gap-0 py-0">
      <CardHeader className="p-0">
        <button
          type="button"
          aria-expanded={expanded}
          data-testid={`help-card-toggle-${card.id}`}
          className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-3 text-left"
          onClick={() => setOpen((value) => !value)}
        >
          <CardTitle className="text-sm">{card.title}</CardTitle>
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-180"
            )}
          />
        </button>
      </CardHeader>
      {expanded && (
        <CardContent
          data-testid={`help-card-body-${card.id}`}
          className="flex flex-col gap-2 border-t px-3 pb-3 pt-3"
        >
          {card.body.map((paragraph, index) => (
            <p key={index} className="text-sm text-muted-foreground">
              {paragraph}
            </p>
          ))}
          {isShortcutsCard && <ShortcutsReference />}
        </CardContent>
      )}
    </Card>
  )
}

/**
 * The help center itself: search on top, categorized card grid below.
 * An empty query browses the whole catalog grouped by category; a query
 * shows the ranked matches (kept expanded) under their categories.
 */
export function HelpCenter({ className }: { className?: string }) {
  const [query, setQuery] = useState("")
  const searching = query.trim().length > 0
  const groups = useMemo(() => searchHelpGrouped(query), [query])
  const matchCount = groups.reduce((sum, group) => sum + group.cards.length, 0)

  return (
    <div
      data-testid="help-center"
      className={cn("flex min-h-0 flex-col gap-4", className)}
    >
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          type="text"
          aria-label="Search help"
          placeholder="Search help — try “snooze”…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="pl-8"
        />
      </div>
      <p
        data-testid="help-result-count"
        className="text-xs text-muted-foreground"
        aria-live="polite"
      >
        {searching
          ? `${matchCount} of ${HELP_CARDS.length} articles match “${query.trim()}”`
          : `${HELP_CARDS.length} articles — everything is stored in the app, no network needed`}
      </p>
      {matchCount === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <BookOpen className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium text-foreground">
            No matching help articles
          </p>
          <p className="max-w-xs text-sm text-muted-foreground">
            Try a shorter keyword, or clear the search to browse every
            article by category.
          </p>
          <Button variant="outline" size="sm" onClick={() => setQuery("")}>
            <X />
            Clear search
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <section key={group.category} aria-label={group.category}>
              <h3 className="mb-2 text-xs font-semibold tracking-wide text-foreground uppercase">
                {group.category}
              </h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {group.cards.map((card) => (
                  <HelpCardView
                    key={`${card.id}-${searching}`}
                    card={card}
                    forceOpen={searching}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * The Settings → Help section: the standard settings-section chrome
 * (heading + description, task 11.1 pattern) around the shared center.
 */
export function HelpSection() {
  return (
    <section aria-label="Help" className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">Help</h2>
        <p className="text-sm text-muted-foreground">
          Search the built-in help center — bundled with the app, so it
          works offline.
        </p>
      </div>
      <HelpCenter />
    </section>
  )
}

/**
 * The dialog mount: driven by ui-store.helpCenterOpen, which the command
 * palette's "Open help center" entry sets (the app's help menu entry —
 * see the module docstring). Scrolled so long categories fit the window.
 */
export function HelpCenterDialog() {
  const open = useUiStore((state) => state.helpCenterOpen)
  const setHelpCenterOpen = useUiStore((state) => state.setHelpCenterOpen)
  return (
    <Dialog open={open} onOpenChange={setHelpCenterOpen}>
      <DialogContent
        data-testid="help-center-dialog"
        className="sm:max-w-2xl"
      >
        <DialogHeader>
          <DialogTitle>Help center</DialogTitle>
          <DialogDescription>
            Everything Emailer can do, answered locally — nothing here
            needs the network.
          </DialogDescription>
        </DialogHeader>
        <ScrollArea className="-mx-1 max-h-[60vh] px-1">
          <HelpCenter />
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
