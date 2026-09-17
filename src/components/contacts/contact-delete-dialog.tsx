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
import type { ContactRow } from "@/services/db/contacts"
import { deleteContactById } from "./use-contacts"

/**
 * Delete-contact confirmation (task 20.2, contacts spec "Contact
 * lifecycle"): names the contact, states what the delete removes — the
 * address-book entry ONLY — and only deletes on the destructive confirm.
 * Messages are never touched (the schema has no reference from messages
 * to contacts), and the contact reappears automatically if the user
 * corresponds with them again. Runs the local-first deleteContactById
 * flow (./use-contacts), which notifies the browser's hook afterwards.
 * The host remounts this component per open so error/in-flight state
 * starts fresh.
 */
export function ContactDeleteDialog({
  contact,
  onOpenChange,
  onDeleted,
}: {
  contact: ContactRow | null
  onOpenChange: (open: boolean) => void
  /** Called after a confirmed delete so the host can drop the selection. */
  onDeleted: () => void
}) {
  const [deleting, setDeleting] = useState(false)

  async function handleConfirm(): Promise<void> {
    if (!contact) return
    setDeleting(true)
    try {
      await deleteContactById(contact.id)
      onDeleted()
      onOpenChange(false)
    } finally {
      setDeleting(false)
    }
  }

  const displayName = contact?.name ?? contact?.email ?? ""

  return (
    <Dialog
      open={contact !== null}
      onOpenChange={(next) => {
        if (!deleting) onOpenChange(next)
      }}
    >
      {contact && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete contact</DialogTitle>
            <DialogDescription>
              Delete <span className="font-medium">{displayName}</span>? Only
              the address-book entry is removed — the messages are not affected,
              and the contact reappears automatically if you correspond with
              them again.
            </DialogDescription>
          </DialogHeader>
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
              aria-label={`Confirm deleting ${displayName}`}
              onClick={() => {
                void handleConfirm()
              }}
              disabled={deleting}
            >
              {deleting && (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}
