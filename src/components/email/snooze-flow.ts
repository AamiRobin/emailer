import { toast } from "sonner"

import {
  notifySnoozedThreadsChanged,
  refreshAfterSnoozeChange,
} from "@/components/layout/use-snoozed-threads"
import { snoozeThread } from "@/services/email-actions/snooze"
import type { SqlExecutor } from "@/services/db/executor"

/**
 * The shared snooze flow (task 2.3): every entry point — row hover
 * menu, context menu, reading-pane toolbar and the keyboard binding —
 * funnels through here, so the service write, the toast and the
 * post-snooze refreshes happen exactly once and identically.
 *
 * Snooze is local-only (the service never touches the queue/provider),
 * so the UI owns the refreshes thread-actions does internally: the
 * visible list, the folder badges and the account unread badges, plus
 * the Snoozed section's notify seam.
 */

/** Menu label of the custom date/time entry. */
export const SNOOZE_CUSTOM_LABEL = "Pick date & time…"

/**
 * Snooze every `threadIds` thread until `until` (unix seconds) and run
 * the post-snooze refresh sequence. Returns false when the service
 * refused (e.g. ThreadNotFoundError) — callers treat it as "nothing
 * happened" (no toast, no selection advance).
 */
export async function snoozeThreadsWithRefresh(
  executor: SqlExecutor,
  threadIds: string[],
  until: number,
  label: string
): Promise<boolean> {
  try {
    for (const threadId of threadIds) {
      await snoozeThread(executor, threadId, until)
    }
  } catch (error) {
    console.warn("[snooze] failed", error)
    return false
  }
  toast.success(`Snoozed until ${label}`)
  notifySnoozedThreadsChanged()
  await refreshAfterSnoozeChange()
  return true
}
