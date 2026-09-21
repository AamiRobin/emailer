import { onRemoteThreadChange } from "@/services/desktop/popout"
import { refreshThreadList } from "@/stores/thread-list-store"
import { useAccountStore } from "@/stores/account-store"
import { useFolderCountsStore } from "@/stores/folder-counts-store"
import { useUiStore } from "@/stores/ui-store"

/**
 * Cross-window thread sync (task 1.9, design D8): installed once per
 * window (main shell + each pop-out, after boot). Remote
 * `thread-data-changed` events — broadcast by the other windows' action
 * tails — re-read the touched state from the shared SQLite database:
 *
 * - the thread list re-queries (the same path a local action uses);
 * - unread + folder badges refresh;
 * - the open reading pane remounts when its thread was touched
 *   (activeThreadRevision — ThreadView keys on it), so read state,
 *   labels and archive state converge in place.
 *
 * Returns the unsubscribe function (for tests / unmount hygiene).
 */
export function installThreadSyncBridge(): () => void {
  let unlisten: (() => void) | undefined
  let disposed = false
  void onRemoteThreadChange((event) => {
    void refreshThreadList().catch((error) => {
      console.warn("[thread-sync] list refresh failed", error)
    })
    void useAccountStore
      .getState()
      .refreshUnreadCounts()
      .catch(() => {})
    void useFolderCountsStore
      .getState()
      .refreshFolderCounts()
      .catch(() => {})

    const openThread = useUiStore.getState().activeThread
    if (openThread !== null && event.threadIds.includes(openThread)) {
      useUiStore.getState().bumpActiveThreadRevision()
    }
  }).then((off) => {
    if (disposed) off()
    else unlisten = off
  })
  return () => {
    disposed = true
    unlisten?.()
  }
}
