import { useState } from "react"

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

/**
 * PGP unlock prompt for the receive path (task 18.6). Minimal, controlled
 * dialog: opens when a message needs the account's private key, resolves
 * the typed passphrase through onSubmit, and shows a per-attempt error
 * (a wrong passphrase keeps the dialog open for a retry).
 *
 * The passphrase is render-local: it lives in this component's state only
 * until the attempt resolves, then it is cleared — never stored, cached
 * or logged (the pgp-keys discipline). The composer (task 18.5) has its
 * own send-time prompt; this one is the reading pane's.
 */
export function PgpPassphraseDialog({
  open,
  submitting = false,
  error = null,
  onSubmit,
  onCancel,
}: {
  open: boolean
  /** True while the decrypt attempt runs (submit disabled). */
  submitting?: boolean
  /** Per-attempt error text shown above the input (e.g. wrong passphrase). */
  error?: string | null
  onSubmit: (passphrase: string) => void
  onCancel: () => void
}) {
  const [passphrase, setPassphrase] = useState("")

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setPassphrase("")
          onCancel()
        }
      }}
    >
      <DialogContent data-testid="pgp-passphrase-dialog">
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (passphrase !== "" && !submitting) {
              onSubmit(passphrase)
              // Drop the value immediately: the attempt consumes it, and a
              // retry (wrong passphrase) starts from an empty field.
              setPassphrase("")
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>Unlock your private key</DialogTitle>
            <DialogDescription>
              Enter the passphrase of your private key to decrypt this message.
              The passphrase is used once and never stored.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p
              role="alert"
              className="text-xs text-destructive"
              data-testid="pgp-passphrase-error"
            >
              {error}
            </p>
          )}
          <Input
            type="password"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            aria-label="PGP passphrase"
            autoComplete="off"
            autoFocus
            data-testid="pgp-passphrase-input"
          />
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={onCancel}
              data-testid="pgp-passphrase-cancel"
            >
              Cancel
            </Button>
            <Button type="submit" disabled={passphrase === "" || submitting}>
              {submitting ? "Decrypting…" : "Decrypt"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
