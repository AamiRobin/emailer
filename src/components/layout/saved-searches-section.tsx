import { useState } from "react"
import { Pencil, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import type { SavedSearchRow } from "@/services/db/saved-searches"
import { useUiStore } from "@/stores/ui-store"
import {
  deleteSavedSearchById,
  renameSavedSearch,
  runSavedSearch,
  useSavedSearches,
} from "./use-saved-searches"

/**
 * The Saved Searches sidebar section (task 7.1): the user's stored query
 * bookmarks, each row re-running its query through the normal search
 * pipeline (a row click navigates into the search view exactly like
 * submitting the search field). Rows carry rename (pencil) and delete
 * (X) actions — local-only operations, per the mail-search spec.
 *
 * Entries are created from the results view's "Save search" affordance
 * (task 7.2), so — like the Snoozed section — this renders only when it
 * has content, and yields to the icon rail (mounted expanded-only by the
 * sidebar). Data flows through useSavedSearches (./use-saved-searches,
 * the use-snoozed-threads.ts pattern).
 */

function RenameSavedSearchDialog({
  search,
  onOpenChange,
}: {
  search: SavedSearchRow
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState(search.name)
  const [saving, setSaving] = useState(false)

  async function handleSubmit(): Promise<void> {
    const trimmed = name.trim()
    if (!trimmed || trimmed === search.name) {
      onOpenChange(false)
      return
    }
    setSaving(true)
    if (await renameSavedSearch(search.id, trimmed)) {
      onOpenChange(false)
    } else {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename saved search</DialogTitle>
          <DialogDescription>
            The stored query stays unchanged — only the sidebar entry name is
            updated.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void handleSubmit()
          }}
        >
          <Input
            aria-label="Saved search name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={search.name}
            autoFocus
            disabled={saving}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function SavedSearchesSection() {
  const searches = useSavedSearches()
  const view = useUiStore((state) => state.view)
  const [renaming, setRenaming] = useState<SavedSearchRow | null>(null)
  if (searches.length === 0) return null
  return (
    <>
      <Separator />
      <nav
        aria-label="Saved searches"
        data-testid="saved-searches-section"
        className="grid items-start gap-0.5 p-2"
      >
        <p className="px-2 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Saved searches
        </p>
        {searches.map((search) => {
          const isActive = view.kind === "search" && view.query === search.query
          return (
            <div
              key={search.id}
              data-testid="saved-search-row"
              className="group/saved flex w-full items-center gap-0.5 rounded-md pr-0.5 hover:bg-accent/50"
            >
              <button
                type="button"
                title={search.query}
                aria-current={isActive ? "true" : undefined}
                className="flex min-w-0 flex-1 flex-col px-2 py-1 text-start"
                onClick={() => {
                  void runSavedSearch(search)
                }}
              >
                <span className="truncate text-sm">{search.name}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {search.query}
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Rename saved search ${search.name}`}
                onClick={() => setRenaming(search)}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Delete saved search ${search.name}`}
                onClick={() => {
                  void deleteSavedSearchById(search.id)
                }}
              >
                <X />
              </Button>
            </div>
          )
        })}
      </nav>
      {renaming && (
        <RenameSavedSearchDialog
          key={renaming.id}
          search={renaming}
          onOpenChange={(open) => {
            if (!open) setRenaming(null)
          }}
        />
      )}
    </>
  )
}
