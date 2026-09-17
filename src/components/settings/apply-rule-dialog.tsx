import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

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
import {
  applyRuleNow,
  countMatchingThreads,
  type ApplyRuleNowResult,
} from "@/services/rules/apply-now"
import type { RuleRow } from "@/services/rules/db"

/**
 * "Apply now" for one mail rule (task 11.4, design D5) — the confirmation
 * gate as a self-contained control: an "Apply now" button that opens a
 * dialog which counts the rule's matching STORED threads through
 * countMatchingThreads (the same compiled matcher the search runs,
 * thread-level), shows that number, and only then enables the confirm
 * button that calls applyRuleNow({ confirmed: true }) and toasts the
 * result summary ("Applied to N threads").
 *
 * Deliberately UNMOUNTED: the rules section (task 11.3) can render one per
 * rule row — <ApplyRuleDialog rule={rule} onDone={...} /> — and owns when.
 * The gate semantics live in the service (applyRuleNow refuses without the
 * literal confirmed flag); this component's discipline on top: the confirm
 * button stays disabled until the count resolves (never confirm an unknown
 * count) and at count 0 (nothing to apply).
 */

export interface ApplyRuleDialogProps {
  rule: RuleRow
  /** Called after a confirmed apply landed, with the service's counts —
   * never on cancel, refusal, or failure. */
  onDone?: (result: ApplyRuleNowResult) => void
}

function threadsLabel(count: number): string {
  return `${count.toLocaleString()} ${count === 1 ? "thread" : "threads"}`
}

export function ApplyRuleDialog({ rule, onDone }: ApplyRuleDialogProps) {
  const [open, setOpen] = useState(false)
  const [matched, setMatched] = useState<number | null>(null)
  const [applying, setApplying] = useState(false)

  // Count on every open; the count reset happens in the open event (a
  // user event, not this effect) so the dialog never shows a stale count.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    countMatchingThreads(getExecutor(), rule.account_id, rule.criteria_json)
      .then((count) => {
        if (!cancelled) setMatched(count)
      })
      .catch((error) => {
        console.error("[rules] apply-now: count failed", error)
        if (!cancelled) {
          toast.error("Could not count the matching threads.")
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, rule.account_id, rule.criteria_json])

  const handleConfirm = useCallback(async () => {
    if (applying) return
    setApplying(true)
    try {
      const result = await applyRuleNow(getExecutor(), rule.account_id, rule, {
        confirmed: true,
      })
      toast.success(`Applied to ${threadsLabel(result.applied)}`)
      setOpen(false)
      onDone?.(result)
    } catch (error) {
      console.error("[rules] apply-now failed", error)
      toast.error("Could not apply the rule.")
    } finally {
      setApplying(false)
    }
  }, [applying, onDone, rule])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant="outline"
        size="sm"
        data-testid="apply-rule-button"
        onClick={() => {
          setMatched(null)
          setOpen(true)
        }}
      >
        Apply now
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Apply “{rule.name}” now?</DialogTitle>
          <DialogDescription>
            {matched === null
              ? "Counting matching threads…"
              : matched === 0
                ? "This rule doesn’t match any threads."
                : `This rule matches ${threadsLabel(matched)}. Its actions will apply to every matched thread, as if the rule had run when the mail arrived. This cannot be undone in one step.`}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            disabled={applying}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            data-testid="apply-rule-confirm"
            disabled={matched === null || matched === 0 || applying}
            onClick={() => void handleConfirm()}
          >
            {applying
              ? "Applying…"
              : matched === null || matched === 0
                ? "Apply"
                : `Apply to ${threadsLabel(matched)}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
