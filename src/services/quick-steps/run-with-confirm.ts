import { toast } from "sonner"

import {
  shouldConfirmDestructive,
  stepIncludesTrash,
} from "@/services/settings/quick-steps"
import { runQuickStep } from "./executor"
import type { QuickStepRunResult } from "./executor"
import type { QuickStep } from "@/services/settings/quick-steps"
import {
  getThreadListExecutor,
  refreshThreadList,
  useThreadListStore,
} from "@/stores/thread-list-store"
import { useFolderCountsStore } from "@/stores/folder-counts-store"
import { useUiStore } from "@/stores/ui-store"

/**
 * The quick-step RUN flow for the UI affordances (task 3.2, design D13):
 * context menu, command palette and the per-step digit shortcuts all call
 * `runQuickStepWithConfirm(step, targetIds)` so the destructive
 * first-run confirmation lives in exactly ONE place.
 *
 * Confirm-once contract (mail-organization spec "Quick steps"): a step
 * containing trash asks for confirmation the FIRST time (until the flag
 * row says otherwise), then runs confirmation-free forever after. The
 * executor itself is dialog-free by design (task 3.1) — this layer
 * consults stepIncludesTrash + shouldConfirmDestructive BEFORE running,
 * and only shows the dialog when both say so.
 *
 * The dialog itself is rendered by `QuickStepConfirmHost`
 * (src/components/email/quick-step-confirm-dialog.tsx), mounted once by
 * the mail shell. Because the three run affordances are imperative call
 * sites (not React trees that own dialog state), the request travels
 * through a tiny module-level bridge: requestConfirm stores the pending
 * request and resolves the returned promise when the host settles it
 * (Run / Cancel / Esc). The host is the ONLY renderer; with no host
 * mounted (should never happen in the shell) the promise stays pending —
 * deliberately fail-closed rather than trashing mail unasked.
 *
 * Freshness ("changes apply to subsequent runs everywhere"): the step
 * definitions are read at call time by the affordances that address
 * steps by id (the shortcut hook re-reads on each keydown, the context
 * menu handler re-resolves on click); this runner takes the resolved
 * QuickStep verbatim. The confirm flag is always read live per run.
 *
 * Executor: the thread-list store's executor seam — the same executor
 * the list reads through (and the one tests inject via
 * setThreadListStoreExecutor), so runs and the post-run refresh see one
 * database.
 */

// ---- Pending destructive-confirmation bridge (dialog host ⇄ callers) ----

/** A trash-confirm request awaiting the host's answer. */
export interface PendingQuickStepConfirm {
  step: QuickStep
  /** Thread count, for the dialog copy ("5 threads"). */
  threadCount: number
  resolve: (approved: boolean) => void
}

type ConfirmListener = (pending: PendingQuickStepConfirm | null) => void

let pendingConfirm: PendingQuickStepConfirm | null = null
const confirmListeners = new Set<ConfirmListener>()

/** The host subscribes at mount; the listener receives every state change
 * (request in, settled/cleared). Returns the unsubscribe function. */
export function subscribeQuickStepConfirms(
  listener: ConfirmListener
): () => void {
  confirmListeners.add(listener)
  listener(pendingConfirm)
  return () => {
    confirmListeners.delete(listener)
  }
}

/** Host-side settle: answer the pending request and clear the dialog. */
export function settleQuickStepConfirm(approved: boolean): void {
  const pending = pendingConfirm
  if (!pending) return
  pendingConfirm = null
  for (const listener of confirmListeners) listener(null)
  pending.resolve(approved)
}

function requestQuickStepConfirm(
  step: QuickStep,
  threadCount: number
): Promise<boolean> {
  return new Promise((resolve) => {
    // One dialog at a time: a second request while one is pending (rapid
    // double-activation) rejects the newcomer — fail-closed like the
    // missing-host case above.
    if (pendingConfirm) {
      resolve(false)
      return
    }
    pendingConfirm = { step, threadCount, resolve }
    for (const listener of confirmListeners) listener(pendingConfirm)
  })
}

// ---- Run targets shared by the palette and the digit shortcuts ----

/**
 * The threads a palette/keyboard run hits when it has no explicit row:
 * the multi-selection in visible-list order (the same ordering rule the
 * list's bulk buttons use), else the active thread, else nothing.
 */
export function currentQuickStepTargets(): string[] {
  const { threads, selectedIds } = useThreadListStore.getState()
  const ordered = threads
    .filter((thread) => selectedIds.has(thread.id))
    .map((thread) => thread.id)
  if (ordered.length > 0) return ordered
  const active = useUiStore.getState().activeThread
  return active ? [active] : []
}

// ---- The shared runner ----

/** Per-thread roll-up of one run (drives the summary toast). */
interface RunSummary {
  applied: number
  /** Threads where at least one action landed but not the whole chain. */
  partial: number
  /** Threads where nothing landed (all skipped, or a failure first). */
  notApplied: number
}

function summarize(result: QuickStepRunResult, total: number): RunSummary {
  let applied = 0
  let partial = 0
  let notApplied = 0
  for (const thread of result.results) {
    const appliedCount = thread.outcomes.filter(
      (outcome) => outcome.status === "applied"
    ).length
    if (appliedCount === thread.outcomes.length) applied += 1
    else if (appliedCount > 0) partial += 1
    else notApplied += 1
  }
  // Threads that vanished mid-run (executor returns an entry per input).
  notApplied += total - result.results.length
  return { applied, partial, notApplied }
}

/** Toast the outcome ("Cleanup applied to 5 threads" / "3 applied, 2
 * skipped"), mirroring the executor's per-thread summary contract. */
function toastSummary(
  step: QuickStep,
  summary: RunSummary,
  total: number
): void {
  const name = step.name
  if (summary.applied === total) {
    toast.success(
      `"${name}" applied to ${total} thread${total === 1 ? "" : "s"}`
    )
    return
  }
  if (summary.applied === 0) {
    toast.error(
      `"${name}" could not be applied to ${
        total === 1 ? "this thread" : `any of the ${total} threads`
      }`
    )
    return
  }
  const skipped = summary.partial + summary.notApplied
  toast.warning(`"${name}": ${summary.applied} applied, ${skipped} skipped`)
}

/**
 * Run a quick step against `targetIds` with the confirm-once gate:
 * destructive (trash) steps confirm on the FIRST run (until
 * markDestructiveConfirmed), then run confirmation-free; every run
 * toasts the outcome summary and refreshes the list + folder badges
 * (the explicit refresh mirrors the list's own runThreadAction, so a run
 * always leaves the view fresh even if a service-level broadcast is
 * missed). Resolves true when the run went through, false when it was
 * cancelled, empty, or fully skipped the gate.
 */
export async function runQuickStepWithConfirm(
  step: QuickStep,
  targetIds: readonly string[]
): Promise<boolean> {
  if (targetIds.length === 0) return false
  const executor = getThreadListExecutor()
  if (stepIncludesTrash(step) && (await shouldConfirmDestructive(executor))) {
    const approved = await requestQuickStepConfirm(step, targetIds.length)
    if (!approved) return false
  }
  const result = await runQuickStep(executor, step, targetIds)
  toastSummary(step, summarize(result, targetIds.length), targetIds.length)
  // Post-run freshness: the explicit refresh mirrors the list's own
  // runThreadAction, so a run always leaves the list + badges current
  // even if a service-level broadcast was missed. Best-effort — a failed
  // refresh must not fail a run whose actions already landed.
  try {
    await refreshThreadList()
    void useFolderCountsStore.getState().refreshFolderCounts()
  } catch (error) {
    console.warn("[quick-steps] post-run refresh failed", error)
  }
  return true
}
