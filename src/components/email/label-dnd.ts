import type { DragEndEvent } from "@dnd-kit/core"

import type { SqlExecutor } from "@/services/db/executor"
import { applyLabelsToThread } from "@/services/email-actions/thread-actions"
import {
  getThreadListExecutor,
  refreshThreadList,
} from "@/stores/thread-list-store"
import { useAccountStore } from "@/stores/account-store"

/**
 * Drag-and-drop labeling (task 10.5, mail-organization spec "Drag a
 * thread onto a label"): the pure logic behind the DndContext that
 * mail-shell mounts over the sidebar + list panes.
 *
 * Thread rows (src/components/email/thread-list.tsx) are drag SOURCES
 * carrying a LabelDragPayload; sidebar user label rows
 * (src/components/layout/sidebar.tsx) are drop TARGETS keyed by the
 * label id. This module keeps everything that is testable without a
 * real drag (jsdom has none): payload construction and the onDragEnd
 * dispatch — per-thread applyLabelsToThread, ONE refresh after the
 * batch so the label chips re-read once.
 */

/** Payload carried by every thread-row drag source. */
export interface LabelDragPayload {
  /**
   * The threads the drop applies to: the dragged row alone, or the WHOLE
   * active multi-selection when the dragged row belongs to it (Gmail
   * semantics, mirrors the context menu's `targets`).
   */
  threadIds: string[]
}

/**
 * Drag payload for a row: the whole `selectionIds` when the dragged row
 * is part of it, else just the row itself. Pure so the Gmail semantics
 * stay unit-testable (jsdom cannot drive dnd-kit pointer sensors).
 */
export function dragPayloadFor(
  threadId: string,
  selectionIds: string[]
): LabelDragPayload {
  return {
    threadIds: selectionIds.includes(threadId) ? [...selectionIds] : [threadId],
  }
}

/** Services the drop handler runs through; injectable for tests. */
export interface LabelDropDeps {
  /** Active account id (null = no account, the drop is ignored). */
  getAccountId: () => string | null
  /** Executor for the applyLabels calls (the thread list's executor). */
  getExecutor: () => SqlExecutor
  /** The per-thread label mutation (thread-actions.applyLabelsToThread). */
  applyLabels: (
    executor: SqlExecutor,
    accountId: string,
    threadId: string,
    labelIds: string[],
    add: boolean
  ) => Promise<void>
  /** Post-batch list reload — called ONCE so chips update in one pass. */
  refresh: () => Promise<void>
  /** Per-thread failure hook (apply errors never abort the batch). */
  onError?: (error: unknown) => void
}

/** Production deps: the same seams the thread list itself uses. */
export function labelDropDeps(): LabelDropDeps {
  return {
    getAccountId: () => useAccountStore.getState().activeAccountId,
    getExecutor: getThreadListExecutor,
    applyLabels: applyLabelsToThread,
    refresh: refreshThreadList,
    onError: (error) => {
      console.warn("[label-dnd] label drop failed", error)
    },
  }
}

/** The draggable's LabelDragPayload, defensively validated. */
function threadIdsFrom(event: DragEndEvent): string[] {
  const data: unknown = event.active.data.current
  if (data === null || typeof data !== "object") return []
  const threadIds = (data as LabelDragPayload).threadIds
  if (!Array.isArray(threadIds)) return []
  return threadIds.filter((id): id is string => typeof id === "string")
}

/**
 * The DndContext onDragEnd handler (task 10.5): a drop on a sidebar
 * label row (over.id = the label id) applies that label to every
 * carried thread — one applyLabelsToThread per thread, errors isolated
 * per thread — then refreshes the list ONCE. Like the selection bar's
 * label dropdown, the refresh is the store-update mechanism (the store
 * does not subscribe to onThreadListChanged itself): each apply mutates
 * SQLite + emits the event, and the single post-batch refresh re-reads
 * labelsByThreadId so the chips appear in one pass. Dropped anywhere
 * else, or without a usable payload/account, this is a no-op.
 */
export async function applyDroppedLabels(
  event: DragEndEvent,
  deps: LabelDropDeps
): Promise<void> {
  const labelId = event.over?.id
  if (typeof labelId !== "string" || labelId.length === 0) return
  const threadIds = threadIdsFrom(event)
  if (threadIds.length === 0) return
  const accountId = deps.getAccountId()
  if (!accountId) return
  const executor = deps.getExecutor()
  for (const threadId of threadIds) {
    try {
      await deps.applyLabels(executor, accountId, threadId, [labelId], true)
    } catch (error) {
      deps.onError?.(error)
    }
  }
  await deps.refresh()
}
