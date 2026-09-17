import { useEffect, useState } from "react"
import { toast } from "sonner"

import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import {
  createSavedSearch,
  deleteSavedSearch,
  listSavedSearches,
  updateSavedSearch,
  type SavedSearchRow,
} from "@/services/db/saved-searches"
import { refreshThreadList } from "@/stores/thread-list-store"
import { useUiStore } from "@/stores/ui-store"

/**
 * Saved-searches-section data plumbing (task 7.1) — the use-snoozed-
 * threads.ts pattern: an injectable SqlExecutor for tests plus a
 * module-level notify seam. The component lives in
 * saved-searches-section.tsx.
 *
 * Every mutation flow funnels through here (like the snooze flows) so the
 * DB write, the notify and any follow-up refresh stay in lockstep:
 * - saveSearch (the "Save search" affordance in the results view, 7.2)
 * - runSavedSearch (a row click): sets the ui-store view to the search
 *   view with the stored query — the exact flow submitting the search
 *   field runs — plus an explicit refreshThreadList so the list is
 *   current even when no ThreadList instance is mounted to react to the
 *   view change.
 * - renameSavedSearch / deleteSavedSearchById (the section's row actions)
 *
 * Saved searches are global rows (no account scope), so the hook needs no
 * account id — it reloads on mount and on notifySavedSearchesChanged().
 */

let sectionExecutorOverride: SqlExecutor | null = null

function resolveExecutor(): SqlExecutor {
  return sectionExecutorOverride ?? getExecutor()
}

/** Test hook: run the section's queries against `executor` (node:sqlite
 * under vitest); pass null to restore the production getExecutor()
 * binding. */
export function setSavedSearchesSectionExecutor(
  executor: SqlExecutor | null
): void {
  sectionExecutorOverride = executor
}

// ---- Refresh seam: the save/rename/delete flows notify subscribers
// after their mutation so the section re-queries SQLite. ----

const savedSearchesChangedListeners = new Set<() => void>()

/** Tell useSavedSearches subscribers to re-query the saved searches. */
export function notifySavedSearchesChanged(): void {
  for (const listener of savedSearchesChangedListeners) listener()
}

/**
 * Run a saved search (the section row's click): navigate into the search
 * view with the stored query text and refresh the thread list — the same
 * sequence as submitting the search field. The query then flows through
 * the regular pipeline (parse → query-builder → SQL) via the list store.
 */
export async function runSavedSearch(search: SavedSearchRow): Promise<void> {
  useUiStore.getState().setView({ kind: "search", query: search.query })
  await refreshThreadList()
}

/**
 * Save the current search under `name` (the results-view affordance,
 * task 7.2): inserts a row appended at the end of the ordering and
 * notifies the section. Resolves to false when the write failed (the
 * caller keeps the dialog open instead of toasting success).
 */
export async function saveSearch(
  name: string,
  query: string
): Promise<boolean> {
  try {
    await createSavedSearch(resolveExecutor(), {
      name: name.trim(),
      query,
    })
  } catch (error) {
    console.warn("[saved-searches] save failed", error)
    return false
  }
  notifySavedSearchesChanged()
  return true
}

/**
 * Rename a saved search (the section row's pencil button) and notify the
 * section. Best-effort: failures are logged, the dialog just stays open.
 */
export async function renameSavedSearch(
  savedSearchId: string,
  name: string
): Promise<boolean> {
  try {
    await updateSavedSearch(resolveExecutor(), savedSearchId, {
      name: name.trim(),
    })
  } catch (error) {
    console.warn("[saved-searches] rename failed", error)
    return false
  }
  notifySavedSearchesChanged()
  return true
}

/**
 * Delete a saved search (the section row's X button) and notify the
 * section. Local-only: no messages are affected (mail-search spec
 * "Delete a saved search").
 */
export async function deleteSavedSearchById(
  savedSearchId: string
): Promise<void> {
  try {
    await deleteSavedSearch(resolveExecutor(), savedSearchId)
  } catch (error) {
    console.warn("[saved-searches] delete failed", error)
    return
  }
  notifySavedSearchesChanged()
}

/** Convenience wrapper for the results-view affordance: save + toast on
 * success, warn-toast on failure (one call site, task 7.2). Resolves to
 * false when the write failed so the caller can keep the dialog open. */
export async function saveSearchWithToast(
  name: string,
  query: string
): Promise<boolean> {
  if (await saveSearch(name, query)) {
    toast.success(`Saved search “${name.trim()}”`)
    return true
  }
  toast.error("Could not save the search.")
  return false
}

/**
 * All saved searches in sidebar order; DB failures render an empty list.
 * Reloads on mount and on notifySavedSearchesChanged() (the save/rename/
 * delete flows).
 */
export function useSavedSearches(): SavedSearchRow[] {
  const [searches, setSearches] = useState<SavedSearchRow[]>([])
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const invalidate = (): void => setRevision((value) => value + 1)
    savedSearchesChangedListeners.add(invalidate)
    return () => {
      savedSearchesChangedListeners.delete(invalidate)
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    // The promise hop keeps the load (and the no-DB fallback —
    // resolveExecutor() throws outside Tauri) out of the effect body.
    Promise.resolve()
      .then(() => listSavedSearches(resolveExecutor()))
      .then((rows) => {
        if (!cancelled) setSearches(rows)
      })
      .catch((error) => {
        console.warn("[saved-searches] failed to load saved searches", error)
        if (!cancelled) setSearches([])
      })
    return () => {
      cancelled = true
    }
  }, [revision])
  return searches
}
