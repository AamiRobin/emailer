import { create } from "zustand"

import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import type { FolderUnreadCounts } from "@/services/db/folder-counts"
import {
  EMPTY_FOLDER_COUNTS,
  unreadCountBySpecialUse,
} from "@/services/db/folder-counts"
import { useAccountStore } from "@/stores/account-store"

/**
 * Sidebar folder unread counts (task 6.3): the seven system-folder badges
 * for the ACTIVE account, loaded from SQLite by refreshFolderCounts().
 *
 * Deliberately a cache, not a subscription — sync completion, mark-read
 * and label changes re-run refreshFolderCounts() (task 6.4+ wires those
 * callers); the sidebar additionally refreshes on mount and whenever the
 * account store's activeAccountId changes, so switching accounts is a
 * local re-read of already-synced data, never a network wait.
 *
 * Queries go through an injectable SqlExecutor that defaults to
 * getExecutor(); tests pass a node:sqlite executor via
 * setFolderCountsStoreExecutor() (same pattern as account-store).
 */

interface FolderCountsState {
  /** Account the current counts belong to (null = no active account). */
  accountId: string | null
  counts: FolderUnreadCounts
  /** Re-run the unread aggregate for the active account. */
  refreshFolderCounts(): Promise<void>
}

let executorOverride: SqlExecutor | null = null

function resolveExecutor(): SqlExecutor {
  return executorOverride ?? getExecutor()
}

/** Test hook: run the count queries against `executor` (node:sqlite under
 * vitest); pass null to restore the production getExecutor() binding. */
export function setFolderCountsStoreExecutor(
  executor: SqlExecutor | null
): void {
  executorOverride = executor
}

export const useFolderCountsStore = create<FolderCountsState>((set) => ({
  accountId: null,
  counts: EMPTY_FOLDER_COUNTS,

  refreshFolderCounts: async () => {
    const accountId = useAccountStore.getState().activeAccountId
    if (!accountId) {
      set({ accountId: null, counts: EMPTY_FOLDER_COUNTS })
      return
    }
    try {
      const counts = await unreadCountBySpecialUse(resolveExecutor(), accountId)
      // Drop the response if the user switched accounts while it ran.
      if (useAccountStore.getState().activeAccountId !== accountId) return
      set({ accountId, counts })
    } catch (error) {
      // No DB outside Tauri (plain vite) — keep the zeroed badges.
      console.warn("[folder-counts-store] refresh failed", error)
    }
  },
}))
