import { useState } from "react"
import { BookmarkPlus } from "lucide-react"

import { saveSearchWithToast } from "@/components/layout/use-saved-searches"
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
import { Label } from "@/components/ui/label"

/**
 * "Save search" affordance in the results view (task 7.2, mail-search
 * spec): mounted by the search field next to the query chip, so it is
 * visible exactly while a search view with a non-empty query is active.
 * Clicking opens a small name prompt (the settings-sections dialog
 * pattern); saving writes a saved_searches row with the query as typed
 * and notifies the sidebar's Saved Searches section via its notify seam.
 */
export function SaveSearchButton({ query }: { query: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Save search"
        title="Save search"
        data-testid="save-search-button"
        onClick={() => setOpen(true)}
      >
        <BookmarkPlus />
      </Button>
      {open && <SaveSearchDialog query={query} onOpenChange={setOpen} />}
    </>
  )
}

function SaveSearchDialog({
  query,
  onOpenChange,
}: {
  query: string
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState("")
  const [saving, setSaving] = useState(false)

  async function handleSubmit(): Promise<void> {
    if (!name.trim() || saving) return
    setSaving(true)
    if (await saveSearchWithToast(name, query)) {
      onOpenChange(false)
    } else {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save search</DialogTitle>
          <DialogDescription>
            The query <span className="font-medium">{query}</span> is stored
            locally and re-runs from the sidebar's Saved searches section.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void handleSubmit()
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="saved-search-name">Name</Label>
            <Input
              id="saved-search-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Unread from client"
              autoFocus
              disabled={saving}
            />
          </div>
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
