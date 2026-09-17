import { useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import type { BlockedSenderAction } from "@/services/db/blocked-senders"
import { countBlockedExisting } from "@/services/db/blocked-senders"
import { getExecutor } from "@/services/db/executor"

/**
 * The "Block sender" dialog (task 18.2, mail-security spec "Block
 * sender"): the confirmation step behind the thread context menu's Block
 * sender item. The choice made here is the durable one — future mail from
 * the sender is auto-trashed or auto-archived per the picked action — so
 * the action is a native radio pair defaulting to Trash. The menu mounts
 * this dialog fresh for every open, so the form always starts at its
 * defaults (same pattern as the rules' RuleDialog).
 *
 * The cleanup offer (the spec's optional retroactive step) is a checkbox
 * labeled with the sender's CURRENT inbox-resident conversation count,
 * fetched once at mount — before the blocklist row exists, so the count
 * never includes mail the block itself will file. Confirming only
 * reports the intent: the list's onBlockSender handler owns the
 * blocklist write, the optional cleanup and the toast.
 */

interface BlockSenderDialogProps {
  /** The address being blocked (already the participants-cache email). */
  sender: string
  /** The thread's owning account — blocking is per account. */
  accountId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (action: BlockedSenderAction, applyToExisting: boolean) => void
}

export function BlockSenderDialog({
  sender,
  accountId,
  open,
  onOpenChange,
  onConfirm,
}: BlockSenderDialogProps) {
  const [action, setAction] = useState<BlockedSenderAction>("trash")
  const [applyToExisting, setApplyToExisting] = useState(false)
  /** Existing-conversation count for the cleanup offer; null until the
   * fetch lands (or when it fails — the checkbox stays usable, just
   * unnumbered). */
  const [existingCount, setExistingCount] = useState<number | null>(null)

  useEffect(() => {
    if (!open) return
    try {
      void countBlockedExisting(getExecutor(), accountId, sender)
        .then((count) => setExistingCount(count))
        .catch(() => setExistingCount(null))
    } catch {
      // No executor (early startup) — the offer just shows unnumbered.
    }
  }, [open, accountId, sender])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="block-sender-dialog">
        <DialogHeader>
          <DialogTitle>Block {sender}</DialogTitle>
          <DialogDescription>
            Future mail from this address will be marked as read and moved out
            of the inbox automatically, without notifications.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3" role="radiogroup" aria-label="Action">
          <Label className="text-sm font-medium">Then future mail is</Label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="blocked-sender-action"
              value="trash"
              checked={action === "trash"}
              onChange={() => setAction("trash")}
            />
            Moved to Trash
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="blocked-sender-action"
              value="archive"
              checked={action === "archive"}
              onChange={() => setAction("archive")}
            />
            Archived
          </label>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox
            id="block-apply-existing"
            checked={applyToExisting}
            onCheckedChange={(checked) => {
              setApplyToExisting(checked === true)
            }}
          />
          <Label htmlFor="block-apply-existing" className="font-normal">
            {existingCount === null
              ? "Also move existing conversations from this sender"
              : `Also move ${existingCount} existing conversation${
                  existingCount === 1 ? "" : "s"
                } from this sender`}
          </Label>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            aria-label="Cancel block"
          >
            Cancel
          </Button>
          <Button
            onClick={() => {
              onOpenChange(false)
              onConfirm(action, applyToExisting)
            }}
            aria-label={`Confirm block ${sender}`}
          >
            Block
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
