import { toast } from "sonner"

import { refreshThreadList } from "@/stores/thread-list-store"
import { useAccountStore } from "@/stores/account-store"
import { useFolderCountsStore } from "@/stores/folder-counts-store"
import { broadcastThreadChange } from "@/services/desktop/popout"
import {
  markThreadDone,
  muteThread,
  pinThread,
  unmarkThreadDone,
  unmuteThread,
  unpinThread,
} from "@/services/email-actions/thread-states"
import type { SqlExecutor } from "@/services/db/executor"

/**
 * The shared thread-state flow (task 3.3): every entry point — the
 * context menu, the selection bulk bar and the reading-pane toolbar —
 * funnels through here, so the per-thread service writes, the toast and
 * the post-change refreshes happen exactly once and identically.
 *
 * Mute/pin/done are local-only states (plain threads-column writes —
 * the service never touches the queue/provider, same shape as snooze),
 * so the UI owns the refreshes thread-actions does internally. The
 * sequence is trimmed per action: mute/unmute move threads in/out of
 * every unread-derived badge (folder badges AND per-account counts),
 * done/undone move them in/out of the inbox (folder badges), and
 * pin/unpin is ordering-only. The visible list always refreshes — after
 * an un-mute/un-done the row re-enters the current inbox view through
 * that same refresh.
 */

/** One local-only state change, in the direction of the service call. */
export type ThreadStateKind =
  "mute" | "unmute" | "pin" | "unpin" | "done" | "undone"

interface StateAction {
  apply: (executor: SqlExecutor, threadId: string) => Promise<void>
  /** Toast copy shown once for the whole run. */
  toastLabel: string
  /** The change moves threads in/out of unread-derived badges. */
  refreshUnread: boolean
  /** The change moves threads in/out of folder-derived badges. */
  refreshFolders: boolean
}

const STATE_ACTIONS: Record<ThreadStateKind, StateAction> = {
  mute: {
    apply: muteThread,
    toastLabel: "Muted",
    refreshUnread: true,
    refreshFolders: true,
  },
  unmute: {
    apply: unmuteThread,
    toastLabel: "Unmuted",
    refreshUnread: true,
    refreshFolders: true,
  },
  pin: {
    apply: pinThread,
    toastLabel: "Pinned",
    refreshUnread: false,
    refreshFolders: false,
  },
  unpin: {
    apply: unpinThread,
    toastLabel: "Unpinned",
    refreshUnread: false,
    refreshFolders: false,
  },
  done: {
    apply: markThreadDone,
    toastLabel: "Marked done",
    refreshUnread: false,
    refreshFolders: true,
  },
  undone: {
    apply: unmarkThreadDone,
    toastLabel: "Marked not done",
    refreshUnread: false,
    refreshFolders: true,
  },
}

/**
 * Apply `kind` to every `threadIds` thread (the service is per-thread
 * local SQL — there is no bulk op) and run the post-change refresh
 * sequence. Returns false when the service refused (e.g.
 * ThreadNotFoundError) — callers treat it as "nothing happened" (no
 * toast, no selection clear).
 */
export async function applyThreadStatesWithRefresh(
  executor: SqlExecutor,
  threadIds: string[],
  kind: ThreadStateKind
): Promise<boolean> {
  const action = STATE_ACTIONS[kind]
  try {
    for (const threadId of threadIds) {
      await action.apply(executor, threadId)
    }
  } catch (error) {
    console.warn("[thread-state] failed", error)
    return false
  }
  toast.success(action.toastLabel)
  const refreshes: Promise<unknown>[] = [refreshThreadList()]
  if (action.refreshFolders) {
    refreshes.push(useFolderCountsStore.getState().refreshFolderCounts())
  }
  if (action.refreshUnread) {
    refreshes.push(useAccountStore.getState().refreshUnreadCounts())
  }
  await Promise.all(refreshes)
  // Cross-window bridge (task 1.9): local-only states still move threads
  // between views, so pop-outs and the main window converge on the change.
  void broadcastThreadChange({
    action: "thread_state",
    accountId: null,
    threadIds,
  })
  return true
}
