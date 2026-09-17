import { useState } from "react"
import { SquareSplitHorizontal } from "lucide-react"

import { createSplitWithToast } from "@/components/layout/use-splits"
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
 * "Save as Split" affordance in the results view (task 9.3, mailbox-ui
 * spec "Create a split from a search"): mounted by the search field next
 * to "Save search", visible exactly while a search view with a non-empty
 * query is active. The dialog prefills the query from the current search
 * (still editable); saving creates the split across the accounts and
 * ENTERS it right away — the tab appears above the list already active.
 * Duplicate names keep the dialog open with a form error (the
 * snippets-section pattern).
 */
export function SaveAsSplitButton({ query }: { query: string }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Save as Split"
        title="Save as Split"
        data-testid="save-as-split-button"
        onClick={() => setOpen(true)}
      >
        <SquareSplitHorizontal />
      </Button>
      {open && <SaveAsSplitDialog query={query} onOpenChange={setOpen} />}
    </>
  )
}

function SaveAsSplitDialog({
  query,
  onOpenChange,
}: {
  query: string
  onOpenChange: (open: boolean) => void
}) {
  const [name, setName] = useState("")
  const [queryInput, setQueryInput] = useState(query)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(): Promise<void> {
    if (!name.trim() || saving) return
    setSaving(true)
    setError(null)
    const outcome = await createSplitWithToast({
      name,
      query: queryInput,
      enter: true,
    })
    if (outcome.ok) {
      onOpenChange(false)
      return
    }
    setSaving(false)
    setError(
      outcome.error === "name-taken"
        ? `A split named “${name.trim()}” already exists.`
        : "Could not create the split."
    )
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Save as Split</DialogTitle>
          <DialogDescription>
            The query becomes a named tab above the inbox; saving enters it
            right away. Splits are stored locally.
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
            <Label htmlFor="split-from-search-name">Name</Label>
            <Input
              id="split-from-search-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Boss mail"
              autoFocus
              disabled={saving}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="split-from-search-query">Query</Label>
            <Input
              id="split-from-search-query"
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
              disabled={saving}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
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
              Create split
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
