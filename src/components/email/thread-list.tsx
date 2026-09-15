import { useCallback, useMemo, useRef, useState } from "react"
import { useDraggable } from "@dnd-kit/core"
import { useVirtualizer } from "@tanstack/react-virtual"
import { formatDistanceToNow } from "date-fns"
import {
  ChevronDownIcon,
  FileText,
  InboxIcon,
  Paperclip,
  SearchXIcon,
  Star,
  TagIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import type { ContactRef } from "@/services/db/messages"
import type {
  ThreadLabelLite,
  ThreadRow as ThreadRowData,
} from "@/services/db/threads"
import type { DraftRecord } from "@/services/composer/drafts"
import {
  applyLabelsToThread,
  archiveThread,
  bulkApply,
  deleteForeverThread,
  markNotSpam,
  markSpam,
  setThreadRead,
  setThreadStarred,
  trashThread,
} from "@/services/email-actions/thread-actions"
import type { ThreadActionKind } from "@/services/email-actions/thread-actions"
import type { SqlExecutor } from "@/services/db/executor"
import {
  getThreadListExecutor,
  refreshThreadList,
  useThreadList,
  useThreadListStore,
  dateGroupLabel,
  formatThreadParticipants,
  parseThreadParticipants,
  type DateGroup,
} from "@/stores/thread-list-store"
import { useAccountStore } from "@/stores/account-store"
import { useFolderCountsStore } from "@/stores/folder-counts-store"
import type { ViewSelection } from "@/stores/ui-store"
import { useUiStore, viewDisplayName } from "@/stores/ui-store"
import { Checkbox } from "@/components/ui/checkbox"
import { ContextMenuTrigger } from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { EmptyState } from "./empty-state"
import { ThreadContextMenu } from "./thread-context-menu"
import type { ThreadMenuHandlers } from "./thread-context-menu"
import { openReplyForThread, resumeDraft } from "./reply-opener"
import { dragPayloadFor } from "./label-dnd"

/**
 * The real SQLite-backed thread list (task 6.4, mailbox-ui spec "Thread
 * list presentation"): participants/subject/snippet/timestamp per row,
 * unread emphasis, star + attachment indicators, gmail label chips, and
 * sticky date-group headers (Today / Yesterday / This week / Earlier).
 *
 * Rendering is virtualized with @tanstack/react-virtual over a flattened
 * [header, …rows] model, so only the visible window mounts — smooth with
 * 10k+ threads (see thread-list.test.tsx for the bounded-render proof).
 * Group headers are ordinary virtual rows; stickiness comes from a
 * zero-height CSS `position: sticky` overlay at the top of the scroll
 * container that shows the group of the first visible row once that
 * group's own header has scrolled past the top edge (a sticky child
 * cannot escape an absolutely-positioned virtual row, so the overlay is
 * the pragmatic sticky pattern here).
 *
 * Density is token-driven: row spacing derives from `--density-row` (see
 * src/index.css); the settings task (11.2) scales the token, this list
 * only consumes it.
 *
 * Selecting a row sets uiStore.activeThread (the reading pane follows);
 * marking read happens server-side via task 10.1's actions, so selection
 * alone does not mutate the rows yet. The star button toggles through the
 * SAME thread-actions service the toolbar/keyboard use (mail-organization
 * spec "Star from the list"); the onStarToggle prop overrides that
 * default (tests).
 *
 * Multi-select + context menu (tasks 10.2/10.3): every row carries a
 * checkbox (hover / selection-active) and opens the context menu on
 * right-click. Multi-selection lives in thread-list-store.selectedIds
 * (the keyboard's single-thread cursor stays uiStore.activeThread);
 * shift-click extends from the last plain-clicked row (the anchor).
 * A selection bar offers select-all/clear plus bulk Archive / Trash /
 * Mark read / Labels; bulk actions run thread-actions bulkApply and
 * CLEAR the selection afterwards (the rows leave the view anyway).
 * Every action — menu or bar, single or bulk — funnels into the same
 * thread-actions service functions the keyboard shortcuts use, and the
 * menu's Reply runs the shared reply-opener prefill (same composer state
 * as the reading pane's Reply button and the keyboard `r`).
 *
 * Drafts view (task 8.6's UI half): in the Drafts folder the local
 * composer snapshots (thread-list-store `drafts`) render as distinct
 * rows ABOVE the thread rows; clicking one never opens a thread — it
 * resumes the draft into the composer (see reply-opener.openDraftForResume).
 */

interface FlatRow {
  key: string
  label?: DateGroup
  threadIndex?: number
  draftIndex?: number
}

interface ThreadListModel {
  rows: FlatRow[]
  /**
   * For each row index, the row index of its group header (-1 for the
   * draft rows, which belong to no date group).
   */
  headerIndexAt: number[]
}

function buildThreadListModel(
  drafts: { id: string }[],
  threads: { id: string; last_message_at: number | null }[],
  now: Date
): ThreadListModel {
  const rows: FlatRow[] = []
  const headerIndexAt: number[] = []
  // Local drafts (task 8.6) sit ABOVE the thread rows, outside the date
  // groups — they are composer snapshots, not received mail.
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index]
    rows.push({ key: `draft:${draft.id}`, draftIndex: index })
    headerIndexAt.push(-1)
  }
  let currentGroup: DateGroup | null = null
  for (let index = 0; index < threads.length; index += 1) {
    const thread = threads[index]
    const group = dateGroupLabel(thread.last_message_at, now)
    if (group !== currentGroup) {
      currentGroup = group
      rows.push({ key: `header:${group}`, label: group })
    }
    const headerIndex = rows.length - 1
    headerIndexAt.push(headerIndex)
    rows.push({ key: `thread:${thread.id}`, threadIndex: index })
    headerIndexAt.push(headerIndex)
  }
  return { rows, headerIndexAt }
}

/** Label chips visible per row before collapsing the rest into "+N". */
const MAX_CHIPS = 3

/** Card row (p-3 + up to four content lines) — a first-paint estimate;
 * the virtualizer measures real heights as rows mount. */
const ESTIMATED_ROW_HEIGHT = 104

/**
 * Per-view empty-state copy (task 6.9, mailbox-ui spec "First-run and
 * empty states"): an informative message identifying the folder or the
 * searched query instead of a blank pane. Rendered through the shared
 * EmptyState composite; the welcome (no-accounts) state is handled by the
 * shell, so only folder/label/search/settings views land here.
 */
function emptyStateForView(view: ViewSelection): {
  icon: LucideIcon
  title: string
  hint: string
} {
  switch (view.kind) {
    case "search":
      return {
        icon: SearchXIcon,
        title: `No results for "${view.query}"`,
        hint: "Try different keywords, or operators like from:someone@example.com, subject:meeting or is:unread.",
      }
    case "label":
      return {
        icon: TagIcon,
        title: `Nothing in ${view.name}`,
        hint: "Threads carrying this label will appear here once they sync.",
      }
    case "folder":
      return {
        icon: InboxIcon,
        title: `Nothing in ${viewDisplayName(view)}`,
        hint:
          view.folder.kind === "starred"
            ? "Star a thread and it will show up here."
            : view.folder.kind === "specialUse" &&
                view.folder.specialUse === "drafts"
              ? "Messages you start writing are saved here automatically."
              : "Messages synced into this folder will appear here.",
      }
    case "settings":
      return {
        icon: InboxIcon,
        title: "Nothing to list",
        hint: "Settings replaces the mailbox panes.",
      }
  }
}

interface ThreadListProps {
  /**
   * Star toggle override. When absent (production), a star click stars
   * the row's thread through thread-actions setThreadStarred + list/
   * folder-badge refreshes (mail-organization "Star from the list").
   * The second argument carries the NEXT state; tests can pass a spy
   * that ignores it.
   */
  onStarToggle?: (threadId: string, nextStarred: boolean) => void
  /**
   * Reply intent override (task 10.2). When absent (production), Reply
   * opens the shared reply-opener prefill for the thread — the exact
   * composer state the reading pane's Reply button and the keyboard `r`
   * produce.
   */
  onReply?: (threadId: string) => void
}

/**
 * The single-thread action a menu item maps to, executed with the SAME
 * thread-actions functions the toolbar/keyboard shortcuts call (exact
 * behavioral parity, spec 10.2). bulkApply runs the same branches for
 * multi-target selections.
 */
function runSingleThreadAction(
  action: ThreadActionKind,
  executor: SqlExecutor,
  accountId: string,
  threadId: string
): Promise<void> {
  switch (action) {
    case "archive":
      return archiveThread(executor, accountId, threadId)
    case "trash":
      return trashThread(executor, accountId, threadId)
    case "spam":
      return markSpam(executor, accountId, threadId)
    case "not_spam":
      return markNotSpam(executor, accountId, threadId)
    case "delete_forever":
      return deleteForeverThread(executor, accountId, threadId)
    case "read":
      return setThreadRead(executor, accountId, threadId, true)
    case "unread":
      return setThreadRead(executor, accountId, threadId, false)
    case "star":
      return setThreadStarred(executor, accountId, threadId, true)
    case "unstar":
      return setThreadStarred(executor, accountId, threadId, false)
  }
}

export function ThreadList({ onStarToggle, onReply }: ThreadListProps) {
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  const view = useUiStore((state) => state.view)
  const activeThread = useUiStore((state) => state.activeThread)
  const setActiveThread = useUiStore((state) => state.setActiveThread)
  const { threads, drafts, labelsByThreadId, userLabels, loading, loaded } =
    useThreadList()
  // Multi-select (task 10.3). Subscribed separately so checkbox toggles
  // re-render the list without touching the data subscriptions.
  const selectedIds = useThreadListStore((state) => state.selectedIds)
  const selectionActive = selectedIds.size > 0
  // Bulk targets in the order the rows render (bulkApply applies in order).
  const orderedSelection = useMemo(
    () =>
      threads
        .filter((thread) => selectedIds.has(thread.id))
        .map((thread) => thread.id),
    [threads, selectedIds]
  )

  // Frozen per mount so date groups stay stable while the list is open.
  const [now] = useState(() => new Date())
  // "All mail | Unread" header filter — the toggle itself renders in the
  // shell's pane header; the state lives in the shared store (see
  // thread-list-store).
  const unreadOnly = useThreadListStore((state) => state.unreadOnly)
  const visibleThreads = useMemo(
    () =>
      unreadOnly
        ? threads.filter((thread) => thread.unread_count > 0)
        : threads,
    [threads, unreadOnly]
  )
  const model = useMemo(
    () => buildThreadListModel(drafts, visibleThreads, now),
    [drafts, visibleThreads, now]
  )

  const scrollerRef = useRef<HTMLDivElement>(null)
  // TanStack Virtual returns stable callbacks the React Compiler cannot
  // memoize; nothing it returns crosses into other memoized components.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: model.rows.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index) => model.rows[index]?.key ?? String(index),
  })
  const virtualItems = virtualizer.getVirtualItems()

  // Sticky header label: the group of the first visible row, shown only
  // once that group's own header row has scrolled past the top edge.
  let stickyLabel: DateGroup | null = null
  const first = virtualItems[0]
  if (first && model.rows.length) {
    const offset = virtualizer.scrollOffset ?? 0
    const headerIndex = model.headerIndexAt[first.index] ?? first.index
    const headerItem = virtualItems.find((item) => item.index === headerIndex)
    if (!headerItem || headerItem.start < offset - 1) {
      const header = model.rows[headerIndex]
      if (header?.label) stickyLabel = header.label
    }
  }

  // ---- Actions (tasks 10.2/10.3): the ONLY place the list mutates mail ----

  /** Run a thread action for one row or the whole selection, then
   * refresh. Single target = the same named function the keyboard uses;
   * many targets = bulkApply (one change event for the batch). A BULK run
   * clears the selection afterwards (the task's chosen semantics — the
   * action consumed it); single-thread menu actions leave it alone and
   * the post-action refresh prunes any rows that left the view. */
  const runThreadAction = (action: ThreadActionKind, targetIds: string[]) => {
    void (async () => {
      const accountId = useAccountStore.getState().activeAccountId
      if (!accountId || targetIds.length === 0) return
      const bulk = targetIds.length > 1
      const executor = getThreadListExecutor()
      try {
        if (!bulk) {
          await runSingleThreadAction(action, executor, accountId, targetIds[0])
        } else {
          await bulkApply(executor, accountId, targetIds, action)
        }
      } catch (error) {
        console.warn("[thread-list] thread action failed", error)
        return
      }
      await refreshThreadList()
      if (bulk) useThreadListStore.getState().clearThreadSelection()
    })()
  }

  /** Apply/remove one user label across targets — per-thread
   * applyLabelsToThread in a loop, ONE refresh at the end. Same bulk
   * semantics as runThreadAction: a multi-target run clears the
   * selection afterwards. */
  const toggleLabelOnTargets = (
    labelId: string,
    add: boolean,
    targetIds: string[]
  ) => {
    void (async () => {
      const accountId = useAccountStore.getState().activeAccountId
      if (!accountId || targetIds.length === 0) return
      const bulk = targetIds.length > 1
      const executor = getThreadListExecutor()
      for (const threadId of targetIds) {
        try {
          await applyLabelsToThread(
            executor,
            accountId,
            threadId,
            [labelId],
            add
          )
        } catch (error) {
          console.warn("[thread-list] label apply failed", error)
        }
      }
      await refreshThreadList()
      if (bulk) useThreadListStore.getState().clearThreadSelection()
    })()
  }

  /**
   * Default star wiring (mail-organization spec "Star from the list"):
   * thread-actions setThreadStarred — the exact function the toolbar,
   * the keyboard `s` and the context menu's Star item run — through the
   * list's executor seam, then refresh the list and the folder badges.
   * Deliberately per-thread: the star of a row inside the multi-selection
   * toggles just that thread (row-level affordance; bulk starring stays
   * with the selection bar's future star entry), and a star click never
   * opens the thread or touches the selection.
   */
  const toggleStarFromList = (threadId: string, nextStarred: boolean) => {
    void (async () => {
      const accountId = useAccountStore.getState().activeAccountId
      if (!accountId) return
      try {
        await setThreadStarred(
          getThreadListExecutor(),
          accountId,
          threadId,
          nextStarred
        )
      } catch (error) {
        console.warn("[thread-list] star toggle failed", error)
        return
      }
      await refreshThreadList()
      await useFolderCountsStore.getState().refreshFolderCounts()
    })()
  }

  /**
   * Default reply wiring (mail-organization: the context menu mirrors
   * the toolbar/keyboard actions): the shared reply-opener prefill —
   * the same composer state the reading pane's Reply button and the
   * keyboard `r` produce — through the list's executor seam.
   */
  const replyFromList = (threadId: string) => {
    void openReplyForThread({
      threadId,
      replyAll: false,
      executor: getThreadListExecutor(),
    })
  }

  /**
   * Draft-row activation (task 8.6): resume the snapshot into the
   * composer — never an open-thread action. resumeDraft keeps the row
   * (deletion happens on send/discard in the composer) and its draftKey,
   * so the next autosave updates the same local_drafts row.
   */
  const resumeDraftFromList = (draftId: string) => {
    void resumeDraft(getThreadListExecutor(), draftId)
  }

  /** Prop override wins (tests); otherwise the defaults above run. */
  const handleStarToggle = onStarToggle ?? toggleStarFromList

  const menuHandlers: ThreadMenuHandlers = {
    onOpen: (threadId) => setActiveThread(threadId),
    onReply: (threadId) =>
      onReply ? onReply(threadId) : replyFromList(threadId),
    onAction: runThreadAction,
    onToggleLabel: toggleLabelOnTargets,
  }

  /** Row click: plain = open + move the shift-range anchor; shift =
   * range-select from the anchor WITHOUT opening the thread. */
  const handleRowClick = (threadId: string, shiftKey: boolean) => {
    const store = useThreadListStore.getState()
    if (shiftKey) {
      store.selectRangeTo(threadId)
      return
    }
    store.setThreadSelectionAnchor(threadId)
    setActiveThread(threadId)
  }

  /** Checkbox click (never opens the thread): plain toggles membership,
   * shift extends the selection from the anchor. */
  const handleCheckboxClick = (threadId: string, shiftKey: boolean) => {
    useThreadListStore.getState().toggleThreadSelection(threadId, shiftKey)
  }

  /** A right-clicked row that is part of the selection acts on the whole
   * selection; otherwise it acts on itself alone (Gmail semantics). */
  const targetsForThread = (threadId: string): string[] =>
    selectedIds.has(threadId) ? orderedSelection : [threadId]

  if (!activeAccountId) {
    return (
      <p className="p-8 text-center text-sm text-muted-foreground">
        No account connected
      </p>
    )
  }
  if (loading && !loaded) {
    return (
      <p className="p-8 text-center text-sm text-muted-foreground">Loading…</p>
    )
  }
  // An empty Drafts folder may still hold local drafts — only a view with
  // neither rows nor drafts shows the empty state.
  if (loaded && threads.length === 0 && drafts.length === 0) {
    const empty = emptyStateForView(view)
    return (
      <EmptyState icon={empty.icon} title={empty.title} hint={empty.hint} />
    )
  }

  const allSelected = selectedIds.size === threads.length

  return (
    <div className="flex h-full min-h-0 flex-col">
      {selectionActive && (
        <div
          data-testid="thread-selection-bar"
          className="flex shrink-0 items-center gap-2 border-b bg-muted/50 px-3 py-1"
        >
          <Checkbox
            aria-label={allSelected ? "Clear selection" : "Select all"}
            checked={allSelected}
            onClick={() => {
              const store = useThreadListStore.getState()
              if (allSelected) {
                store.clearThreadSelection()
              } else {
                store.selectAllThreads()
              }
            }}
          />
          <span className="text-xs text-muted-foreground tabular-nums">
            {selectedIds.size} selected
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => runThreadAction("archive", orderedSelection)}
            >
              Archive
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => runThreadAction("trash", orderedSelection)}
            >
              Trash
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => runThreadAction("read", orderedSelection)}
            >
              Mark read
            </Button>
            {userLabels.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button variant="ghost" size="sm">
                      Labels
                      <ChevronDownIcon className="size-3.5 text-muted-foreground" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end">
                  {userLabels.map((label) => {
                    const appliedToAll = orderedSelection.every((threadId) =>
                      (labelsByThreadId[threadId] ?? []).some(
                        (chip) => chip.id === label.id
                      )
                    )
                    return (
                      <DropdownMenuCheckboxItem
                        key={label.id}
                        checked={appliedToAll}
                        closeOnClick={false}
                        onClick={() =>
                          toggleLabelOnTargets(
                            label.id,
                            !appliedToAll,
                            orderedSelection
                          )
                        }
                      >
                        {label.name}
                      </DropdownMenuCheckboxItem>
                    )
                  })}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                useThreadListStore.getState().clearThreadSelection()
              }
            >
              Clear
            </Button>
          </div>
        </div>
      )}
      {unreadOnly && threads.length > 0 && visibleThreads.length === 0 ? (
        <p className="p-8 text-center text-sm text-muted-foreground">
          No unread messages
        </p>
      ) : (
        <div
          ref={scrollerRef}
          data-testid="thread-list-scroll"
          className="min-h-0 flex-1 overflow-y-auto"
        >
          {stickyLabel && (
            <div className="pointer-events-none sticky top-0 z-10 h-0 overflow-visible">
              <div className="border-b bg-background/95 px-4 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase backdrop-blur">
                {stickyLabel}
              </div>
            </div>
          )}
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualItems.map((virtualItem) => {
              const row = model.rows[virtualItem.index]
              if (!row) return null
              if (row.label) {
                return (
                  <div
                    key={virtualItem.key}
                    data-index={virtualItem.index}
                    ref={virtualizer.measureElement}
                    data-group-header={row.label}
                    className="absolute inset-x-0 top-0 border-b bg-background px-4 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase"
                    style={{ transform: `translateY(${virtualItem.start}px)` }}
                  >
                    {row.label}
                  </div>
                )
              }
              if (row.draftIndex !== undefined) {
                const draft = drafts[row.draftIndex]
                if (!draft) return null
                return (
                  <DraftRow
                    key={virtualItem.key}
                    measureRef={virtualizer.measureElement}
                    virtualIndex={virtualItem.index}
                    translateY={virtualItem.start}
                    draft={draft}
                    onResume={resumeDraftFromList}
                  />
                )
              }
              const thread = visibleThreads[row.threadIndex ?? -1]
              if (!thread) return null
              return (
                <ThreadRow
                  key={virtualItem.key}
                  measureRef={virtualizer.measureElement}
                  virtualIndex={virtualItem.index}
                  translateY={virtualItem.start}
                  thread={thread}
                  labels={labelsByThreadId[thread.id] ?? []}
                  selected={activeThread === thread.id}
                  checked={selectedIds.has(thread.id)}
                  selectionActive={selectionActive}
                  targets={targetsForThread(thread.id)}
                  userLabels={userLabels}
                  handlers={menuHandlers}
                  onRowClick={handleRowClick}
                  onToggleCheckbox={handleCheckboxClick}
                  onStarToggle={handleStarToggle}
                />
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

interface ThreadRowProps {
  measureRef: (node: Element | null) => void
  virtualIndex: number
  translateY: number
  thread: ThreadRowData
  labels: ThreadLabelLite[]
  /** Reading-pane cursor (uiStore.activeThread) — not the multi-select. */
  selected: boolean
  /** Multi-select membership (task 10.3). */
  checked: boolean
  /** True when ANY row is selected — keeps all checkboxes visible. */
  selectionActive: boolean
  /** Ids the context menu's state-changing items act on. */
  targets: string[]
  userLabels: ThreadLabelLite[]
  handlers: ThreadMenuHandlers
  onRowClick: (threadId: string, shiftKey: boolean) => void
  onToggleCheckbox: (threadId: string, shiftKey: boolean) => void
  /** Row-level star toggle (list default or prop override); the second
   * arg carries the NEXT state. Never opens the thread. */
  onStarToggle: (threadId: string, nextStarred: boolean) => void
}

function ThreadRow({
  measureRef,
  virtualIndex,
  translateY,
  thread,
  labels,
  selected,
  checked,
  selectionActive,
  targets,
  userLabels,
  handlers,
  onRowClick,
  onToggleCheckbox,
  onStarToggle,
}: ThreadRowProps) {
  const unread = thread.unread_count > 0
  const starred = thread.is_starred === 1
  const participants = formatThreadParticipants(
    parseThreadParticipants(thread.participants)
  )
  const visibleChips = labels.slice(0, MAX_CHIPS)
  const overflow = labels.length - visibleChips.length

  // Drag source (task 10.5): the row itself is the handle; `targets` is
  // selection-or-single, so the payload follows the context menu's Gmail
  // semantics — a row inside the selection drags the whole selection.
  // dnd-kit's PointerSensor is configured with a distance activation
  // constraint (mail-shell), so plain clicks never start a drag.
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: thread.id,
    data: dragPayloadFor(thread.id, targets),
  })
  // The virtualizer's measure ref and the draggable node ref share the
  // row element; a combined stable callback keeps both attached.
  const setRowRef = useCallback(
    (node: HTMLDivElement | null) => {
      measureRef(node)
      setNodeRef(node)
    },
    [measureRef, setNodeRef]
  )

  return (
    <ThreadContextMenu
      thread={thread}
      targetIds={targets}
      userLabels={userLabels}
      memberLabelIds={labels.map((label) => label.id)}
      handlers={handlers}
    >
      <ContextMenuTrigger
        render={
          <div
            ref={setRowRef}
            data-index={virtualIndex}
            data-thread-row={thread.id}
            data-unread={unread ? "true" : "false"}
            data-starred={starred ? "true" : "false"}
            data-has-attachments={thread.has_attachments ? "true" : "false"}
            data-selected={checked ? "true" : "false"}
            data-dragging={isDragging ? "true" : "false"}
            aria-current={selected ? "true" : undefined}
            className="group/row absolute inset-x-0 top-0 px-2 pb-(--density-row) outline-hidden"
            style={{ transform: `translateY(${translateY}px)` }}
            onClick={(event) => onRowClick(thread.id, event.shiftKey)}
            {...attributes}
            {...listeners}
          >
            {/* Card visual (tweakcn mail reference): the virtual row is the
                positioning + hit-area wrapper; the card carries the look.
                dnd activation and clicks live on the wrapper, so the inner
                element stays presentation-only. */}
            <div
              className={cn(
                "flex cursor-default flex-col gap-1 rounded-lg border p-3 text-left text-sm transition-all hover:bg-accent/50 focus-visible:bg-accent/50",
                selected && "bg-muted hover:bg-muted",
                checked && !selected && "bg-accent/40 hover:bg-accent/40",
                isDragging && "opacity-50"
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  data-thread-checkbox={thread.id}
                  className={cn(
                    "flex shrink-0 items-center transition-opacity",
                    checked || selectionActive
                      ? "opacity-100"
                      : "opacity-0 group-hover/row:opacity-100 focus-within:opacity-100"
                  )}
                  onClick={(event) => {
                    // A checkbox click never opens the thread; shift extends
                    // the selection from the anchor (task 10.3).
                    event.stopPropagation()
                    onToggleCheckbox(thread.id, event.shiftKey)
                  }}
                >
                  <Checkbox
                    checked={checked}
                    tabIndex={-1}
                    aria-label={`Select ${thread.subject || "(no subject)"}`}
                  />
                </span>
                <span
                  className={cn(
                    "truncate",
                    unread ? "font-semibold" : "text-muted-foreground"
                  )}
                >
                  {participants || "Unknown sender"}
                </span>
                {unread && (
                  <span
                    aria-label="Unread"
                    className="size-2 shrink-0 rounded-full bg-primary"
                  />
                )}
                <span className="ml-auto flex shrink-0 items-center gap-1.5">
                  {thread.has_attachments === 1 && (
                    <Paperclip
                      aria-label="Has attachments"
                      className="size-3.5 text-muted-foreground"
                    />
                  )}
                  <button
                    type="button"
                    aria-label={starred ? "Starred" : "Not starred"}
                    aria-pressed={starred}
                    className="rounded-sm p-0.5 hover:bg-accent"
                    onClick={(event) => {
                      // Toggle the thread's star (list default or override);
                      // never select the thread from a star click.
                      event.stopPropagation()
                      onStarToggle(thread.id, !starred)
                    }}
                  >
                    <Star
                      className={cn(
                        "size-3.5",
                        starred
                          ? "fill-current text-foreground"
                          : "text-muted-foreground/40"
                      )}
                    />
                  </button>
                  <span
                    className={cn(
                      "shrink-0 text-xs whitespace-nowrap tabular-nums",
                      selected ? "text-foreground" : "text-muted-foreground"
                    )}
                  >
                    {thread.last_message_at === null
                      ? ""
                      : formatDistanceToNow(
                          new Date(thread.last_message_at * 1000),
                          { addSuffix: true }
                        )}
                  </span>
                </span>
              </div>
              <div
                className={cn(
                  "line-clamp-1 text-xs font-medium",
                  !unread && "font-normal text-foreground/90"
                )}
              >
                {thread.subject || "(no subject)"}
              </div>
              <div className="line-clamp-2 text-xs text-muted-foreground">
                {thread.snippet}
              </div>
              {visibleChips.length > 0 && (
                <div className="flex items-center gap-1 pt-0.5">
                  {visibleChips.map((label) => (
                    <span
                      key={label.id}
                      data-label-chip={label.name}
                      className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-px text-xs text-muted-foreground"
                    >
                      {/* Data-color exception (mirrors the sidebar): label.color is
                          user content from the DB rendered as-is, like thread text —
                          not component styling, so the token rule does not apply.
                          NULL colors fall back to a token dot. */}
                      <span
                        aria-hidden
                        className="size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
                        style={
                          label.color
                            ? { backgroundColor: label.color }
                            : undefined
                        }
                      />
                      <span className="max-w-32 truncate">{label.name}</span>
                    </span>
                  ))}
                  {overflow > 0 && (
                    <span className="text-xs text-muted-foreground">
                      +{overflow}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        }
      />
    </ThreadContextMenu>
  )
}

// ---------------------------------------------------------------------------
// Local-draft rows (task 8.6's UI half)
// ---------------------------------------------------------------------------

/** "To: Name <email>" (+N overflow) preview for a draft row; ContactRef
 * and the composer's Recipient are structurally identical. */
function draftRecipientPreview(to: ContactRef[]): string {
  const first = to[0]
  if (!first) return "No recipients"
  const label = first.name ? `${first.name} <${first.email}>` : first.email
  const rest = to.length - 1
  return rest > 0 ? `To: ${label}, +${rest}` : `To: ${label}`
}

interface DraftRowProps {
  measureRef: (node: Element | null) => void
  virtualIndex: number
  translateY: number
  draft: DraftRecord
  onResume: (draftId: string) => void
}

/**
 * One local-draft row, rendered only in the Drafts folder view above the
 * thread rows. Visually distinct from a thread — FileText glyph, "Draft"
 * badge, recipient preview and a relative updated time — and activation
 * NEVER opens a thread: it resumes the snapshot into the composer
 * (reply mode re-entered when the snapshot carries reply fields, the
 * row's draftKey preserved so autosave keeps updating the same
 * local_drafts row; see reply-opener.openDraftForResume). The row stays
 * until the draft is sent or discarded, per the drafts service recipe.
 */
function DraftRow({
  measureRef,
  virtualIndex,
  translateY,
  draft,
  onResume,
}: DraftRowProps) {
  return (
    <div
      ref={measureRef}
      data-index={virtualIndex}
      data-draft-row={draft.id}
      data-draft-key={draft.draftKey ?? undefined}
      role="button"
      tabIndex={0}
      aria-label={`Resume draft ${draft.subject || "(no subject)"}`}
      className="absolute inset-x-0 top-0 px-2 pb-2 outline-hidden"
      style={{ transform: `translateY(${translateY}px)` }}
      onClick={() => onResume(draft.id)}
      onKeyDown={(event) => {
        if (event.key === "Enter") onResume(draft.id)
      }}
    >
      <div className="flex cursor-default items-center gap-2 rounded-lg border p-3 text-sm transition-all hover:bg-accent/50 focus-visible:bg-accent/50">
        <FileText
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />
        <span className="min-w-0 flex-1 truncate text-foreground/90">
          {draft.subject || "(no subject)"}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {draftRecipientPreview(draft.to)}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span
            data-draft-badge="true"
            className="rounded-full bg-muted px-1.5 py-px text-xs font-medium text-muted-foreground"
          >
            Draft
          </span>
          <span className="shrink-0 text-xs whitespace-nowrap text-muted-foreground">
            {formatDistanceToNow(new Date(draft.updatedAt * 1000), {
              addSuffix: true,
            })}
          </span>
        </span>
      </div>
    </div>
  )
}
