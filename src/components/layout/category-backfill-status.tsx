import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { countCategoryBackfillRemaining } from "@/services/db/threads"
import {
  cancelExistingMailBackfill,
  isBackfillActive,
  refreshCategoryList,
  resolveCategoriesExecutor,
  useCategoryBackfillProgress,
} from "./use-categories"

/**
 * The category backfill progress surface (task 3.5, design D4,
 * mail-organization spec "Automatic categorization": existing mail is
 * back-categorizable on demand "with a progress summary"). A compact
 * status row rendered UNDER the mailbox tab bar while a job is in flight
 * (and inline in the settings Categories section, which launches the same
 * job) — deliberately not a toast: the job yields between scheduler ticks,
 * so the summary must persist. Shows "Categorizing… N of M" (N = threads
 * scanned so far, M = scanned + the threads still NULL-category — the
 * backfill's own candidate predicate, queried live) plus a Cancel button
 * (the job stops at its next batch boundary). On completion the summary
 * lands once as a toast ("Categorized N messages") and the thread
 * list/counts are refreshed so the tabs catch up to the final state.
 */
export function CategoryBackfillStatus() {
  const progress = useCategoryBackfillProgress()
  const active = isBackfillActive(progress)
  // Previous-snapshot tracking for the one-shot done toast: only the
  // transition into done (from a job that categorized something) speaks.
  const previousProgress = useRef(progress)
  useEffect(() => {
    const previous = previousProgress.current
    previousProgress.current = progress
    if (!previous.done && progress.done && progress.categorized > 0) {
      toast.success(
        `Categorized ${progress.categorized} message${
          progress.categorized === 1 ? "" : "s"
        }`
      )
    }
    // The final batches changed threads.category behind the list store's
    // back: one refresh brings the tabs, counts and any category-scoped
    // list current (also after a cancel — its last batches still applied).
    // Through the registered seam (see use-categories' lazy-load note).
    if (
      (!previous.done && progress.done) ||
      (!previous.cancelled && progress.cancelled)
    ) {
      void refreshCategoryList()
    }
  }, [progress])
  // The "M" of "N of M": the remaining backfill candidates, re-read as the
  // job's numbers move. A failed count (e.g. no DB in plain vite) just
  // drops the estimate via the catch below.
  const [remaining, setRemaining] = useState<number | null>(null)
  useEffect(() => {
    if (!active) return
    let cancelled = false
    Promise.resolve()
      .then(() => countCategoryBackfillRemaining(resolveCategoriesExecutor()))
      .then((count) => {
        if (!cancelled) setRemaining(count)
      })
      .catch(() => {
        if (!cancelled) setRemaining(null)
      })
    return () => {
      cancelled = true
    }
  }, [active, progress.scanned, progress.categorized])
  if (!active) return null
  const total = remaining === null ? null : remaining + progress.scanned
  return (
    <div
      role="status"
      data-testid="category-backfill-status"
      className="flex shrink-0 items-center gap-2 border-b px-3 py-1 text-xs text-muted-foreground"
    >
      <span data-testid="category-backfill-progress" className="tabular-nums">
        {total === null
          ? `Categorizing… ${progress.scanned} ${
              progress.scanned === 1 ? "thread" : "threads"
            }`
          : `Categorizing… ${progress.scanned} of ${total}`}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        data-testid="category-backfill-cancel"
        onClick={cancelExistingMailBackfill}
      >
        Cancel
      </Button>
    </div>
  )
}
