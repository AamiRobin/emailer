import { useState, type PropsWithChildren } from "react"

import { toast } from "sonner"

import { SnoozeCustomPicker } from "./snooze-menu"
import { SNOOZE_CUSTOM_LABEL } from "./snooze-flow"
import type { ThreadStateKind } from "./thread-state-flow"
import { BlockSenderDialog } from "./block-sender-dialog"
import { CreateTaskDialog } from "./create-task-dialog"
import { buildTaskPrefill } from "@/components/layout/use-tasks"
import { formatSnoozedUntil } from "@/components/layout/use-snoozed-threads"
import { CATEGORY_LABELS } from "@/components/layout/use-categories"
import {
  CATEGORIES,
  parseCategory,
  type Category,
} from "@/services/categorization/classify"
import { getSnoozePresets } from "@/services/email-actions/snooze"
import { getExecutor } from "@/services/db/executor"
import { exportThreadAsEml } from "@/services/data-portability"
import type { BlockedSenderAction } from "@/services/db/blocked-senders"
import type { ThreadLabelLite, ThreadRow } from "@/services/db/threads"
import type { ThreadActionKind } from "@/services/email-actions/thread-actions"
import type { QuickStep } from "@/services/settings/quick-steps"
import { parseThreadParticipants } from "@/stores/thread-list-store"
import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
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
 * the thread state), Star/unstar (same), the local-only states Mute/
 * Unmute, Pin/Unpin and Mark done/not done (same, task 3.3), Snooze
 * (task 2.3 — a submenu of
 * the shared presets plus a custom date/time picker anchored at the row),
 * Delete forever (rendered only for threads in Trash — the service
 * re-guards with NotInTrashError), a Labels submenu of the account's
 * user labels as checkboxes reflecting the thread's current membership
 * (toggling applies/removes and keeps the menu open, like Gmail), and
 * Block sender (task 18.2 — rendered when the thread has a usable cached
 * newest-sender; opens the block dialog and executes through the list's
 * onBlockSender).
 *
 * Export as EML (task 19.1) runs in place rather than through a list
 * handler: like the block dialog's count fetch it reaches the shared
 * executor directly (getExecutor — the BlockSenderDialog precedent) and
 * the export service owns the whole flow (directory dialog, one .eml per
 * message, toast). Read-only over the database, so no refresh follows.
 *
 * Create task (task 5.7, tasks spec "Task from email") converts THIS
 * thread into a task — a per-thread item acting on the clicked row
 * alone. Like Export as EML it executes without a list handler: the item
 * opens the shared CreateTaskDialog (mounted outside the popup, the
 * block-dialog pattern) whose confirm runs the createTaskFromEmail flow
 * — a tasks-table row with origin "email" + the source back-links, the
 * "Task created" toast with a jump action, and the thread's inbox state
 * deliberately untouched.
 *
 * Multi-select interplay (task 10.3): the caller passes `targetIds` —
 * the whole selection when the right-clicked row is part of it, else
 * just this thread — so any state-changing item applies to the entire
 * selection. Open/Reply always act on the clicked thread alone.
 *
 * Quick steps (task 3.2): a "Quick step" submenu of the user's chains,
 * rendered only when the list loaded steps AND provided onRunQuickStep;
 * a click runs the whole chain over targetIds through the shared
 * confirm-once runner (one confirmation-free action over the entire
 * selection, save the spec's first-run trash gate).
 *
 * Category overrides (task 3.5, design D4): while categorization is
 * enabled, a "Move to category" submenu (the five categories, the
 * thread's current one checked/disabled) emitting onMoveToCategory and an
 * "Always categorize <sender> as" submenu (the newest-message sender,
 * resolved like Block sender) emitting onAlwaysFromSender — the two user
 * overrides that categorization/overrides.ts executes (the move is
 * per-thread, the always-from-sender feeds back as the rule for that
 * sender).
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
  /** Open the thread in its own window (task 1.9). Present only inside
   * the Tauri runtime — the menu item renders when this handler is set. */
  onOpenInNewWindow?: (threadId: string) => void
  /** Reply to the thread (shared reply-opener prefill by default). */
  onReply: (threadId: string) => void
  /** Run a thread action against `targetIds` (single or bulk). */
  onAction: (action: ThreadActionKind, targetIds: string[]) => void
  /** Apply/remove a user label on `targetIds`. */
  onToggleLabel: (labelId: string, add: boolean, targetIds: string[]) => void
  /** Snooze `targetIds` until `until` (unix seconds; `label` feeds the
   * shared toast). Executed by the list's snooze flow (task 2.3). */
  onSnooze: (targetIds: string[], until: number, label: string) => void
  /** Apply a local-only state (mute/pin/done — or its inverse) to
   * `targetIds`. Executed by the list's shared state flow (task 3.3). */
  onThreadState: (kind: ThreadStateKind, targetIds: string[]) => void
  /** Block the clicked thread's newest-message sender (task 18.2): the
   * dialog supplies the action and the existing-mail choice; the list
   * executes the blocklist write (+ optional cleanup) and toasts. Like
   * Open/Reply, blocking acts on the clicked thread alone. */
  onBlockSender: (
    accountId: string,
    sender: string,
    action: BlockedSenderAction,
    applyToExisting: boolean
  ) => void
  /** Run a quick step (task 3.2) against `targetIds` — the same
   * selection-or-row semantics as onAction. The list resolves the step
   * fresh at run time (definitions may have changed since the menu
   * rendered) and routes through the shared confirm-once runner. Present
   * only when the list loaded the steps, so the submenu below renders
   * only when there is something to run. */
  onRunQuickStep?: (stepId: string, targetIds: string[]) => void
  /** Move the clicked thread to a category (task 3.5, design D4): the
   * per-thread user override (categorization/overrides.ts) — the menu
   * item is per-thread by design (an override of THIS thread's stored
   * category), so unlike the state items it never fans out to
   * targetIds. Present only while categorization is enabled. */
  onMoveToCategory?: (threadId: string, category: Category) => void
  /** "Always from this sender" (task 3.5, design D4): the per-sender
   * override that feeds back as the rule for that sender
   * (categorization/overrides.ts alwaysFromSender — the sender is the
   * clicked thread's newest-message sender, resolved like Block
   * sender's). Also per-thread for the same reason. */
  onAlwaysFromSender?: (threadId: string, category: Category) => void
}

interface ThreadContextMenuProps {
  thread: ThreadRow
  /** Row ids the state-changing items hit (selection or just this row). */
  targetIds: string[]
  /** The account's user labels (submenu entries). */
  userLabels: ThreadLabelLite[]
  /** Quick steps (task 3.2) — the "Quick step" submenu entries. Loaded
   * once per list mount by the thread list (the settings page unmounts
   * the list, so a settings edit re-reads on return); rendered only when
   * non-empty AND onRunQuickStep is set. */
  quickSteps?: QuickStep[]
  /** Whether the category feature is on (task 3.5): gates the "Move to
   * category" / "Always from this sender" submenus. Absent/false renders
   * the pre-3.5 menu unchanged. */
  categoriesEnabled?: boolean
  /** Label ids the right-clicked thread currently carries. */
  memberLabelIds: string[]
  /** The row element — anchor for the custom date/time popover. */
  anchorElement?: HTMLElement | null
  handlers: ThreadMenuHandlers
}

export function ThreadContextMenu({
  thread,
  targetIds,
  userLabels,
  quickSteps,
  categoriesEnabled,
  memberLabelIds,
  anchorElement,
  handlers,
  children,
}: PropsWithChildren<ThreadContextMenuProps>) {
  const unread = thread.unread_count > 0
  const starred = thread.is_starred === 1
  // Local-only states (task 3.3): the item labels flip on the state, like
  // Mark read/unread and Star/unstar above.
  const muted = thread.muted_at != null
  const pinned = thread.pinned_at != null
  const done = thread.done_at != null
  const [customOpen, setCustomOpen] = useState(false)
  // Task-from-email conversion (task 5.7): the prefill/confirm dialog's
  // open state — mounted fresh per open (the block dialog's pattern).
  const [createTaskOpen, setCreateTaskOpen] = useState(false)
  // Block sender (task 18.2): the newest-message sender from the SAME
  // participants cache the sender sort and the bundles use — threads
  // without a usable cached sender get no block item.
  const blockSender = parseThreadParticipants(thread.participants)[0]?.email
  const [blockOpen, setBlockOpen] = useState(false)
  // Category overrides (task 3.5): the thread's CURRENT category — NULL
  // ("not yet categorized") reads as Primary, the same rendering the tab
  // row uses — drives the checked/disabled entry in the move submenu.
  const currentCategory = parseCategory(thread.category) ?? "primary"
  // Task 5.7 conversion prefill: the thread subject as the title, the
  // newest-message snippet (the row's display cache) as the notes, both
  // computed by buildTaskPrefill.
  const taskPrefill = buildTaskPrefill(thread.subject, thread.snippet)

  /** Export as EML (task 19.1): the service opens the directory dialog
   * and writes one .eml per message; a toast reports the outcome —
   * including cache-miss attachments, which export (read-only,
   * local-first) leaves as empty parts rather than fetching. */
  const exportEmlFromMenu = () => {
    void exportThreadAsEml(getExecutor(), thread.id)
      .then((result) => {
        if (!result) return
        const missed = result.unavailableAttachments.length
        toast.success(
          `Exported ${result.files.length} message${
            result.files.length === 1 ? "" : "s"
          } as .eml` +
            (missed > 0
              ? ` — ${missed} attachment file${
                  missed === 1 ? "" : "s"
                } not cached, exported empty`
              : "")
        )
      })
      .catch((error) => {
        console.warn("[data-portability] eml export failed", error)
        toast.error("Export failed — the messages could not be written")
      })
  }
  return (
    <ContextMenu>
      {children}
      <ContextMenuContent data-testid="thread-context-menu">
        <ContextMenuItem onClick={() => handlers.onOpen(thread.id)}>
          Open
        </ContextMenuItem>
        {handlers.onOpenInNewWindow && (
          <ContextMenuItem
            onClick={() => handlers.onOpenInNewWindow?.(thread.id)}
          >
            Open in new window
          </ContextMenuItem>
        )}
        <ContextMenuItem onClick={() => handlers.onReply(thread.id)}>
          Reply
        </ContextMenuItem>
        <ContextMenuItem onClick={exportEmlFromMenu}>
          Export as EML
        </ContextMenuItem>
        {/* Task 5.7 (tasks spec "Task from email"): convert THIS thread
            into a task — a per-thread action like Open/Reply (never a
            selection bulk op). Opens the shared prefill/confirm dialog
            mounted outside the popup below; the dialog's flow writes the
            tasks row with the source back-links and leaves the thread's
            inbox state untouched. */}
        <ContextMenuItem
          data-testid="menu-create-task"
          onClick={() => setCreateTaskOpen(true)}
        >
          Create task
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
        <ContextMenuItem
          onClick={() =>
            handlers.onThreadState(muted ? "unmute" : "mute", targetIds)
          }
        >
          {muted ? "Unmute" : "Mute"}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() =>
            handlers.onThreadState(pinned ? "unpin" : "pin", targetIds)
          }
        >
          {pinned ? "Unpin" : "Pin"}
        </ContextMenuItem>
        <ContextMenuItem
          onClick={() =>
            handlers.onThreadState(done ? "undone" : "done", targetIds)
          }
        >
          {done ? "Mark not done" : "Mark done"}
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>Snooze</ContextMenuSubTrigger>
          <ContextMenuSubContent data-testid="snooze-submenu">
            {getSnoozePresets().presets.map((preset) => (
              <ContextMenuItem
                key={preset.id}
                onClick={() => {
                  setCustomOpen(false)
                  handlers.onSnooze(targetIds, preset.until, preset.label)
                }}
              >
                {preset.label}
              </ContextMenuItem>
            ))}
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => setCustomOpen(true)}>
              {SNOOZE_CUSTOM_LABEL}
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        {thread.is_trashed === 1 && (
          <ContextMenuItem
            variant="destructive"
            onClick={() => handlers.onAction("delete_forever", targetIds)}
          >
            Delete forever
          </ContextMenuItem>
        )}
        {blockSender && (
          <ContextMenuItem onClick={() => setBlockOpen(true)}>
            Block sender
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
        {/* Category overrides (task 3.5, design D4, mail-organization spec
            "Automatic categorization"): "Move to category" — the per-thread
            override with the thread's current category checked/disabled —
            and "Always categorize <sender> as", which feeds back as the
            rule for that sender. Both act on the CLICKED thread alone (a
            category override is per-thread storage, not a selection bulk
            op) and render only while categorization is enabled. */}
        {categoriesEnabled && handlers.onMoveToCategory && (
          <>
            <ContextMenuSeparator />
            <ContextMenuSub>
              <ContextMenuSubTrigger>Move to category</ContextMenuSubTrigger>
              <ContextMenuSubContent data-testid="move-to-category-submenu">
                {CATEGORIES.map((category) => {
                  const current = currentCategory === category
                  return (
                    <ContextMenuCheckboxItem
                      key={category}
                      data-testid={`move-to-category-${category}`}
                      checked={current}
                      disabled={current}
                      onClick={() => {
                        if (!current) {
                          handlers.onMoveToCategory?.(thread.id, category)
                        }
                      }}
                    >
                      {CATEGORY_LABELS[category]}
                    </ContextMenuCheckboxItem>
                  )
                })}
              </ContextMenuSubContent>
            </ContextMenuSub>
          </>
        )}
        {categoriesEnabled && handlers.onAlwaysFromSender && blockSender && (
          <ContextMenuSub>
            <ContextMenuSubTrigger>
              Always categorize {blockSender} as
            </ContextMenuSubTrigger>
            <ContextMenuSubContent data-testid="always-from-sender-submenu">
              {CATEGORIES.map((category) => (
                <ContextMenuItem
                  key={category}
                  data-testid={`always-from-sender-${category}`}
                  onClick={() =>
                    handlers.onAlwaysFromSender?.(thread.id, category)
                  }
                >
                  {CATEGORY_LABELS[category]}
                </ContextMenuItem>
              ))}
            </ContextMenuSubContent>
          </ContextMenuSub>
        )}
        {/* Quick steps (task 3.2): one submenu entry per step, in manage
            order, each carrying its digit shortcut as a right-side hint.
            A run is ONE action on ALL targetIds (the selection or the
            right-clicked row) — the multi-thread confirmation-free bulk
            the spec requires — and funnels through the list's shared
            confirm-once runner. */}
        {quickSteps && quickSteps.length > 0 && handlers.onRunQuickStep && (
          <>
            <ContextMenuSeparator />
            <ContextMenuSub>
              <ContextMenuSubTrigger>Quick step</ContextMenuSubTrigger>
              <ContextMenuSubContent data-testid="quick-step-submenu">
                {quickSteps.map((step) => (
                  <ContextMenuItem
                    key={step.id}
                    data-testid={`quick-step-menu-item-${step.id}`}
                    onClick={() =>
                      handlers.onRunQuickStep?.(step.id, targetIds)
                    }
                  >
                    {step.name}
                    {step.shortcut && (
                      <ContextMenuShortcut>{step.shortcut}</ContextMenuShortcut>
                    )}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          </>
        )}
      </ContextMenuContent>
      {/* The custom date/time picker lives outside the menu popup (a menu
          item click closes it) and anchors at the row. */}
      <SnoozeCustomPicker
        open={customOpen}
        onOpenChange={setCustomOpen}
        anchor={anchorElement ?? null}
        onConfirm={(until) => {
          setCustomOpen(false)
          handlers.onSnooze(targetIds, until, formatSnoozedUntil(until))
        }}
      />
      {/* The block dialog likewise lives outside the popup and closes it
          (task 18.2): mounted fresh per open (defaults restored) and
          unmounted on close — the choice made here persists at block
          time. */}
      {blockOpen && blockSender && (
        <BlockSenderDialog
          sender={blockSender}
          accountId={thread.account_id}
          open
          onOpenChange={setBlockOpen}
          onConfirm={(action, applyToExisting) => {
            setBlockOpen(false)
            handlers.onBlockSender(
              thread.account_id,
              blockSender,
              action,
              applyToExisting
            )
          }}
        />
      )}
      {/* The task-from-email conversion dialog (task 5.7) lives outside
          the popup too, mounted fresh per open so the prefill (thread
          subject / newest-message snippet, computed by
          buildTaskPrefill) always starts clean. The dialog runs the
          shared createTaskFromEmail flow itself — the same direct
          execution the Export as EML item uses — so no list handler is
          involved; the thread row is display-only prefill here. */}
      {createTaskOpen && (
        <CreateTaskDialog
          threadId={thread.id}
          accountId={thread.account_id}
          defaultTitle={taskPrefill.title}
          defaultNotes={taskPrefill.notes}
          open
          onOpenChange={setCreateTaskOpen}
        />
      )}
    </ContextMenu>
  )
}
