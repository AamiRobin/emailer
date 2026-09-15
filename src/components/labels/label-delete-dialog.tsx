import { useState } from "react"
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getExecutor } from "@/services/db/executor"
import type { LabelRow } from "@/services/db/labels"
import type { AccountType } from "@/services/email/types"
import { deleteUserLabel } from "@/services/labels/label-admin"
import { notifyUserLabelsChanged } from "@/components/layout/use-sidebar-data"

/**
 * Delete-label confirmation (task 10.4): names the label, states what the
 * delete removes, and only deletes on the destructive confirm. Runs the
 * local-first deleteUserLabel flow (row removed + server delete queued)
 * and notifies the sidebar's label hook afterwards. The host remounts
 * this component per open so error/in-flight state starts fresh.
 */
export function LabelDeleteDialog({
  label,
  account,
  onOpenChange,
}: {
  label: LabelRow | null
  account: { id: string; type: AccountType } | null
  onOpenChange: (open: boolean) => void
}) {
  const [deleting, setDeleting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleConfirm(): Promise<void> {
    if (!label || !account) return
    setDeleting(true)
    setErrorMessage(null)
    try {
      await deleteUserLabel({
        executor: getExecutor(),
        account,
        labelId: label.id,
      })
      notifyUserLabelsChanged()
      onOpenChange(false)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not delete the label."
      )
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog
      open={label !== null}
      onOpenChange={(next) => {
        if (!deleting) onOpenChange(next)
      }}
    >
      {label && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete label</DialogTitle>
            <DialogDescription>
              Delete <span className="font-medium">{label.name}</span>? The
              label is removed from every local thread and the deletion is
              queued for the server. The messages themselves are kept
              {label.imap_folder_name
                ? " unless the server deletes the folder's contents"
                : ""}
              .
            </DialogDescription>
          </DialogHeader>
          {errorMessage && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={deleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                void handleConfirm()
              }}
              disabled={deleting}
            >
              {deleting && (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              )}
              Delete label
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}
