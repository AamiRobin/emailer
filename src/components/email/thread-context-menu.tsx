import type { PropsWithChildren } from "react"

import type { ThreadLabelLite, ThreadRow } from "@/services/db/threads"
import type { ThreadActionKind } from "@/services/email-actions/thread-actions"
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu"

/**
 * The thread row context menu (task 10.2, email-client spec "Context
 * menu"): right-click actions mirroring the toolbar and the keyboard
 * shortcuts EXACTLY — every item funnels into the same service-layer
 * thread-actions functions those surfaces use (the handlers live in the
 * thread list; this composite is display + intents only).
 *
 * Items: Open, Reply, Archive, Trash, Mark read/unread (label reflects
 * the thread state), Star/unstar (same), Delete forever (rendered only
 * for threads in Trash — the service re-guards with NotInTrashError),
 * and a Labels submenu of the account's user labels as checkboxes
 * reflecting the thread's current membership (toggling applies/removes
 * and keeps the menu open, like Gmail).
 *
 * Multi-select interplay (task 10.3): the caller passes `targetIds` —
 * the whole selection when the right-clicked row is part of it, else
 * just this thread — so any state-changing item applies to the entire
 * selection. Open/Reply always act on the clicked thread alone.
 *
 * Reply: the item emits onReply and the thread list executes it — by
 * default through the shared reply-opener prefill (the exact composer
 * state the reading pane's Reply button and the keyboard `r` produce);
 * the prop remains overridable for tests.
 */

/** Intents emitted by the menu; the thread list executes them. */
export interface ThreadMenuHandlers {
  /** Open the thread in the reading pane. */
  onOpen: (threadId: string) => void
  /** Reply to the thread (shared reply-opener prefill by default). */
  onReply: (threadId: string) => void
  /** Run a thread action against `targetIds` (single or bulk). */
  onAction: (action: ThreadActionKind, targetIds: string[]) => void
  /** Apply/remove a user label on `targetIds`. */
  onToggleLabel: (labelId: string, add: boolean, targetIds: string[]) => void
}

interface ThreadContextMenuProps {
  thread: ThreadRow
  /** Row ids the state-changing items hit (selection or just this row). */
  targetIds: string[]
  /** The account's user labels (submenu entries). */
  userLabels: ThreadLabelLite[]
  /** Label ids the right-clicked thread currently carries. */
  memberLabelIds: string[]
  handlers: ThreadMenuHandlers
}

export function ThreadContextMenu({
  thread,
  targetIds,
  userLabels,
  memberLabelIds,
  handlers,
  children,
}: PropsWithChildren<ThreadContextMenuProps>) {
  const unread = thread.unread_count > 0
  const starred = thread.is_starred === 1
  return (
    <ContextMenu>
      {children}
      <ContextMenuContent data-testid="thread-context-menu">
        <ContextMenuItem onClick={() => handlers.onOpen(thread.id)}>
          Open
        </ContextMenuItem>
        <ContextMenuItem onClick={() => handlers.onReply(thread.id)}>
          Reply
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onClick={() => handlers.onAction("archive", targetIds)}
        >
          Archive
        </ContextMenuItem>
        <ContextMenuItem onClick={() => handlers.onAction("trash", targetIds)}>
          Trash
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() =>
            handlers.onAction(unread ? "read" : "unread", targetIds)
          }
        >
          {unread ? "Mark read" : "Mark unread"}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() =>
            handlers.onAction(starred ? "unstar" : "star", targetIds)
          }
        >
          {starred ? "Unstar" : "Star"}
        </ContextMenuItem>
        {thread.is_trashed === 1 && (
          <ContextMenuItem
            variant="destructive"
            onClick={() => handlers.onAction("delete_forever", targetIds)}
          >
            Delete forever
          </ContextMenuItem>
        )}
        {userLabels.length > 0 && (
          <>
            <ContextMenuSeparator />
            <ContextMenuSub>
              <ContextMenuSubTrigger>Labels</ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {userLabels.map((label) => {
                  const member = memberLabelIds.includes(label.id)
                  return (
                    <ContextMenuCheckboxItem
                      key={label.id}
                      checked={member}
                      onClick={() =>
                        handlers.onToggleLabel(label.id, !member, targetIds)
                      }
                    >
                      {label.name}
                    </ContextMenuCheckboxItem>
                  )
                })}
              </ContextMenuSubContent>
            </ContextMenuSub>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}
