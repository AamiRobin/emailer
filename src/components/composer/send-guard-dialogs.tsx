import { useState } from "react"

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
import type { SendGuardKind } from "./send-guards"

/**
 * The send-guard prompts (task 5.3, spec mail-composition "Send guards"):
 * one modal per guard kind, shown by the composer while the send flow is
 * paused BEFORE the undo-send window can start — answering a guard is not
 * a send. Each dialog offers the fix ("Attach a file" / "Add a subject",
 * which aborts the attempt and hands control back to the composer) and
 * "Send anyway" (which satisfies the guard for this attempt), plus the
 * per-account "Don't ask again" flag (preferences.ts): the checkbox is
 * committed by either button; a plain Esc/overlay dismissal ignores it.
 * Only one dialog is ever open — the composer queues guards head-first.
 */

interface SendGuardDialogsProps {
  /** The guard currently prompting; null closes everything. */
  guard: SendGuardKind | null
  /** "Send anyway": the guard counts as satisfied for this attempt. */
  onConfirm: (guard: SendGuardKind, suppress: boolean) => void
  /** The fix affordance: aborts the attempt and hands control back to
   * the composer (which opens the picker / focuses the subject). */
  onGoBack: (guard: SendGuardKind, suppress: boolean) => void
  /** Plain dismissal (Esc/overlay): aborts the attempt; every guard may
   * fire again on the next Send click, and the checkbox is ignored. */
  onDismiss: () => void
}

export function SendGuardDialogs({
  guard,
  onConfirm,
  onGoBack,
  onDismiss,
}: SendGuardDialogsProps) {
  // Per-prompt checkbox state; reset when its dialog closes so a reopened
  // prompt never inherits a stale opt-in.
  const [suppressAttachment, setSuppressAttachment] = useState(false)
  const [suppressEmptySubject, setSuppressEmptySubject] = useState(false)

  return (
    <>
      <Dialog
        open={guard === "attachment"}
        onOpenChange={(open) => {
          if (!open) {
            setSuppressAttachment(false)
            onDismiss()
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Missing attachment?</DialogTitle>
            <DialogDescription>
              Your message mentions an attachment, but no file is attached.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Checkbox
              id="guard-suppress-attachment"
              checked={suppressAttachment}
              onCheckedChange={(checked) => {
                setSuppressAttachment(checked === true)
              }}
            />
            <Label htmlFor="guard-suppress-attachment" className="font-normal">
              Don&apos;t ask again for this account
            </Label>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onGoBack("attachment", suppressAttachment)}
            >
              Attach a file
            </Button>
            <Button onClick={() => onConfirm("attachment", suppressAttachment)}>
              Send anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={guard === "emptySubject"}
        onOpenChange={(open) => {
          if (!open) {
            setSuppressEmptySubject(false)
            onDismiss()
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send without a subject?</DialogTitle>
            <DialogDescription>
              The subject line is empty. You can still send the message.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Checkbox
              id="guard-suppress-empty-subject"
              checked={suppressEmptySubject}
              onCheckedChange={(checked) => {
                setSuppressEmptySubject(checked === true)
              }}
            />
            <Label
              htmlFor="guard-suppress-empty-subject"
              className="font-normal"
            >
              Don&apos;t ask again for this account
            </Label>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onGoBack("emptySubject", suppressEmptySubject)}
            >
              Add a subject
            </Button>
            <Button
              onClick={() => onConfirm("emptySubject", suppressEmptySubject)}
            >
              Send anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
