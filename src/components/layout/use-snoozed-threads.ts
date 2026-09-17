import { useEffect, useState } from "react"
import { format, fromUnixTime, isToday, isTomorrow } from "date-fns"

import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import type { ThreadRow } from "@/services/db/threads"
import {
  listSnoozedThreads,
  unsnoozeThread,
} from "@/services/email-actions/snooze"
import { useAccountStore } from "@/stores/account-store"
import { useFolderCountsStore } from "@/stores/folder-counts-store"
import { refreshThreadList } from "@/stores/thread-list-store"

/**
 * Snoozed-section data plumbing (task 2.4) — the use-sidebar-data.ts
 * pattern: an injectable SqlExecutor for tests plus a module-level
 * notify seam. The component lives in snoozed-section.tsx.
 *
 * Snooze/unsnooze flows call notifySnoozedThreadsChanged() after their
 * local mutations so the section re-queries SQLite; the shared post-
 * change refresh (refreshAfterSnoozeChange) is defined here too so the
 * snooze menu and the section's cancel button run the identical
 * sequence. Rows are filtered to the active account client-side
 * (listSnoozedThreads is account-agnostic by design).
 */

let sectionExecutorOverride: SqlExecutor | null = null

function resolveExecutor(): SqlExecutor {
  return sectionExecutorOverride ?? getExecutor()
}

/** Test hook: run the section's queries against `executor` (node:sqlite
 * under vitest); pass null to restore the production getExecutor()
 * binding. */
export function setSnoozedSectionExecutor(executor: SqlExecutor | null): void {
  sectionExecutorOverride = executor
}

// ---- Refresh seam: snooze/unsnooze flows notify subscribers after a
// local mutation so the section reloads from SQLite. ----

const snoozedChangedListeners = new Set<() => void>()

/** Tell useSnoozedThreads subscribers to re-query the snoozed rows. */
export function notifySnoozedThreadsChanged(): void {
  for (const listener of snoozedChangedListeners) listener()
}

/** Wake-up time display: "Today 6:00 PM", "Tomorrow 8:00 AM", or a short
 * date-time for anything further out. */
export function formatSnoozedUntil(until: number): string {
  const date = fromUnixTime(until)
  if (isToday(date)) return format(date, "'Today' h:mm a")
  if (isTomorrow(date)) return format(date, "'Tomorrow' h:mm a")
  return format(date, "EEE, MMM d, h:mm a")
}

/**
 * The post-snooze cache refresh (snooze is local-only — the service
 * never touches the queue, so unlike thread-actions nothing refreshes
 * on its behalf): the visible list, the sidebar folder badges and the
 * account unread badges. Best-effort — the refreshes catch their own
 * query failures.
 */
export function refreshAfterSnoozeChange(): Promise<void> {
  return Promise.all([
    refreshThreadList(),
    useFolderCountsStore.getState().refreshFolderCounts(),
    useAccountStore.getState().refreshUnreadCounts(),
  ]).then(() => undefined)
}

/**
 * Cancel a snooze (the Snoozed section row's X button): the shared
 * unsnoozeThread service, then the same refresh sequence a snooze runs —
 * the thread returns to wherever it lives and every cached badge catches
 * up.
 */
export async function cancelSnooze(threadId: string): Promise<void> {
  try {
    await unsnoozeThread(resolveExecutor(), threadId)
  } catch (error) {
    console.warn("[snoozed-section] unsnooze failed", error)
    return
  }
  notifySnoozedThreadsChanged()
  await refreshAfterSnoozeChange()
}

/**
 * Snoozed threads of the active account, earliest wake-up first; DB
 * failures render an empty list. The loaded account travels with the
 * rows so a switch renders [] for the new account without a synchronous
 * setState inside the effect. Reloads on account switches and on
 * notifySnoozedThreadsChanged() (the snooze/unsnooze flows).
 */
export function useSnoozedThreads(activeAccountId: string | null): ThreadRow[] {
  const [loaded, setLoaded] = useState<{
    accountId: string | null
    threads: ThreadRow[]
  }>({ accountId: null, threads: [] })
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const invalidate = (): void => setRevision((value) => value + 1)
    snoozedChangedListeners.add(invalidate)
    return () => {
      snoozedChangedListeners.delete(invalidate)
    }
  }, [])
  useEffect(() => {
    if (!activeAccountId) return
    let cancelled = false
    // The promise hop keeps the load (and the no-DB fallback —
    // resolveExecutor() throws outside Tauri) out of the effect body.
    Promise.resolve()
      .then(() => listSnoozedThreads(resolveExecutor()))
      .then((rows) => {
        if (!cancelled) {
          setLoaded({
            accountId: activeAccountId,
            threads: rows.filter((row) => row.account_id === activeAccountId),
          })
        }
      })
      .catch((error) => {
        console.warn("[snoozed-section] failed to load snoozed threads", error)
        if (!cancelled) {
          setLoaded({ accountId: activeAccountId, threads: [] })
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeAccountId, revision])
  return loaded.accountId === activeAccountId ? loaded.threads : []
}
