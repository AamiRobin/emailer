import { useEffect, useState } from "react"

import { AlertTriangle } from "lucide-react"

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
import { markDestructiveConfirmed } from "@/services/settings/quick-steps"
import { getThreadListExecutor } from "@/stores/thread-list-store"
import {
  settleQuickStepConfirm,
  subscribeQuickStepConfirms,
  type PendingQuickStepConfirm,
} from "@/services/quick-steps/run-with-confirm"

/**
 * The one-time destructive quick-step confirm dialog (task 3.2, spec
 * mail-organization "Quick steps": a trash-running step "SHALL require
 * confirmation the first time, then never again"). Mounted ONCE by the
 * mail shell next to the other global overlays; the run affordances
 * (context menu, palette, digit shortcuts) never render dialogs
 * themselves — they await runQuickStepWithConfirm, which raises a
 * request through the module bridge this host subscribes to (see
 * run-with-confirm.ts for why the bridge, not props).
 *
 * "Don't ask again" is the confirm-once memory: checked → the host
 * commits markDestructiveConfirmed BEFORE approving, so the very next
 * destructive run (any step — the flag is global by design, task 3.1) is
 * confirmation-free. A plain Cancel or Esc/overlay dismissal resolves
 * "not approved" and ignores the checkbox, like the send-guard dialogs.
 */
export function QuickStepConfirmHost() {
  const [pending, setPending] = useState<PendingQuickStepConfirm | null>(null)
  const [dontAskAgain, setDontAskAgain] = useState(false)

  useEffect(() => subscribeQuickStepConfirms(setPending), [])

  const settle = (approved: boolean): void => {
    if (approved && dontAskAgain) {
      // Committed on approve only — a cancelled dialog must not silence
      // the next ask. Same executor seam as the runner (the thread-list
      // store's), so tests inject one database for both.
      try {
        void markDestructiveConfirmed(getThreadListExecutor())
      } catch (error) {
        console.warn(
          "[quick-steps] failed to persist the destructive confirmation",
          error
        )
      }
    }
    setDontAskAgain(false)
    settleQuickStepConfirm(approved)
  }

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) settle(false)
      }}
    >
      <DialogContent data-testid="quick-step-confirm-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-destructive" aria-hidden />
            Run &ldquo;{pending?.step.name}&rdquo;?
          </DialogTitle>
          <DialogDescription>
            This quick step moves threads to Trash.{" "}
            {pending
              ? `${pending.threadCount} thread${
                  pending.threadCount === 1 ? "" : "s"
                } will be affected.`
              : null}
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <Checkbox
            id="quick-step-dont-ask"
            checked={dontAskAgain}
            onCheckedChange={(checked) => {
              setDontAskAgain(checked === true)
            }}
          />
          <Label htmlFor="quick-step-dont-ask" className="font-normal">
            Don&apos;t ask again
          </Label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => settle(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => settle(true)}>
            Run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
