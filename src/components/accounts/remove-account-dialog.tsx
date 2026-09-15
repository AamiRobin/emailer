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
import type { AccountInfo } from "@/stores/account-store"
import { removeAccount } from "@/services/account-flows"

/**
 * Remove-account confirmation (task 5.5, accounts spec "Remove with
 * confirmation"). Names the account, states plainly that ALL locally
 * stored mail for it is deleted, and only removes on the destructive
 * confirm — a plain "Cancel" and the close button both back out. On
 * success the dialog closes; the account store reload inside
 * removeAccount activates another account (or the empty state) and the
 * switcher updates.
 *
 * The host keys this component by target account (and remounts it on
 * every open), so its in-flight/error state always starts fresh without
 * reset effects.
 */

interface RemoveAccountDialogProps {
  account: AccountInfo | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function RemoveAccountDialog({
  account,
  open,
  onOpenChange,
}: RemoveAccountDialogProps) {
  const [removing, setRemoving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  async function handleConfirm(): Promise<void> {
    if (!account) return
    setRemoving(true)
    setErrorMessage(null)
    try {
      await removeAccount(account.id)
      onOpenChange(false)
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : "Could not remove the account."
      )
    } finally {
      setRemoving(false)
    }
  }

  return (
    <Dialog
      open={open && account !== null}
      onOpenChange={(next) => {
        if (!removing) {
          onOpenChange(next)
        }
      }}
    >
      {account && (
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove account</DialogTitle>
            <DialogDescription>
              Remove <span className="font-medium">{account.email}</span> from
              this device? Every locally stored message, thread and label of
              this account will be deleted. The account itself is not deleted at
              the provider — adding it again syncs fresh from the server.
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
              disabled={removing}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                void handleConfirm()
              }}
              disabled={removing}
            >
              {removing && (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              )}
              Remove account
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  )
}
