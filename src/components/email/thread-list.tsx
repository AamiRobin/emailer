import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useDraggable } from "@dnd-kit/core"
import { useVirtualizer } from "@tanstack/react-virtual"
import { formatDistanceToNow } from "date-fns"
import {
  Archive,
  ArrowUpDown,
  BellOff,
  BellRingIcon,
  Check,
  ChevronDownIcon,
  ChevronRightIcon,
  Clock,
  Columns2Icon,
  FileText,
  InboxIcon,
  LayersIcon,
  Paperclip,
  Pin,
  SearchXIcon,
  Star,
  StickyNote,
  TagIcon,
  Trash2,
  ZapIcon,
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
import type { BlockedSenderAction } from "@/services/db/blocked-senders"
import type { SqlExecutor } from "@/services/db/executor"
import {
  getThreadListExecutor,
  refreshThreadList,
  scopeSpansAccounts,
  useThreadList,
  useThreadListStore,
  formatThreadParticipants,
  parseThreadParticipants,
} from "@/stores/thread-list-store"
import { useAccountStore } from "@/stores/account-store"
import type { AccountInfo } from "@/stores/account-store"
import { useFolderCountsStore } from "@/stores/folder-counts-store"
import type { ViewSelection } from "@/stores/ui-store"
import { useUiStore, viewDisplayName } from "@/stores/ui-store"
import { Checkbox } from "@/components/ui/checkbox"
import { ContextMenuTrigger } from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { ThreadSortOption } from "@/services/db/thread-sort"
import { THREAD_SORT_OPTIONS } from "@/services/db/thread-sort"
import { Button } from "@/components/ui/button"
import { AccountBadge } from "./account-badge"
import { EmptyState } from "./empty-state"
import { ThreadContextMenu } from "./thread-context-menu"
import type { ThreadMenuHandlers } from "./thread-context-menu"
import { openReplyForThread, resumeDraft } from "./reply-opener"
import { SnoozeMenu } from "./snooze-menu"
import { snoozeThreadsWithRefresh } from "./snooze-flow"
import { blockSenderWithRefresh } from "./block-sender-flow"
import {
  applyThreadStatesWithRefresh,
  type ThreadStateKind,
} from "./thread-state-flow"
import { dragPayloadFor } from "./label-dnd"
import type { GroupedSegment, SenderBundle } from "./bundles"
import { bundleMemberIds, groupByConsecutiveSender } from "./bundles"
import {
  getGroupBySenderPreference,
  setGroupBySenderPreference,
} from "@/services/settings/preferences"

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
 * Mark read / Mute / Pin / Done / Labels; bulk actions run thread-actions
 * bulkApply (or the local-state flow for the last three) and
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
 *
 * Unified inbox (task 9.2, design D4): while the ui-store list scope is
 * "unified", the store serves the across-accounts inbox and every row
 * renders its owning account's badge (./account-badge). The account-scoped
 * actions — archive/trash/spam/read/star, labels, reply — resolve the
 * ROW's account (groupTargetsByAccount splits a mixed selection into one
 * account-scoped run per account), while the local-only states
 * (snooze/mute/pin/done) are plain thread-id writes that need no account.
 *
 * Group-by-sender bundles (task 9.4, design D4): a global "Group by
 * sender" toggle (persisted as `mail.groupBySender` via the preferences
 * service) collapses CONSECUTIVE same-sender runs of the loaded,
 * already-materialized rows into one bundle row — ./bundles owns the pure
 * grouping; the SQL stays untouched (the GROUP BY runs on the window,
 * not the mailbox). A bundle row shows the sender, the member count and
 * the latest subject, expands in place (client-side Set of bundle keys,
 * per-session), and its Archive / Trash / Snooze / Mark-read controls are
 * plain multi-target actions: the member ids flow through the SAME
 * handlers the selection bar uses (runThreadAction → bulkApply per
 * account group, snoozeThreadsWithRefresh), so mixed-account bundles work
 * in the unified inbox for free. Bundle rows do not participate in the
 * multi-selection (no checkbox); member rows inside an expanded bundle
 * select as usual.
 */

interface FlatRow {
  key: string
  threadIndex?: number
  draftIndex?: number
  /** Bundle row (task 9.4): a collapsed ≥2-run of same-sender threads. */
  bundle?: SenderBundle
  /** Thread row spliced under an expanded bundle (renders indented). */
  memberOf?: SenderBundle
}

/**
 * Flat row model: local drafts first (task 8.6 — composer snapshots, not
 * received mail), then the threads newest-first — either flat (grouping
 * off) or with consecutive same-sender runs collapsed into one bundle row
 * each (task 9.4); an expanded bundle splices its member rows right after
 * the bundle row.
 */
function buildThreadListModel(
  drafts: { id: string }[],
  threads: ThreadRowData[],
  groups: GroupedSegment[] | null,
  expandedBundles: ReadonlySet<string>
): FlatRow[] {
  const rows: FlatRow[] = []
  for (let index = 0; index < drafts.length; index += 1) {
    rows.push({ key: `draft:${drafts[index].id}`, draftIndex: index })
  }
  if (!groups) {
    for (let index = 0; index < threads.length; index += 1) {
      rows.push({ key: `thread:${threads[index].id}`, threadIndex: index })
    }
    return rows
  }
  const indexById = new Map(threads.map((thread, index) => [thread.id, index]))
  for (const segment of groups) {
    if (segment.kind === "single") {
      rows.push({
        key: `thread:${segment.thread.id}`,
        threadIndex: indexById.get(segment.thread.id),
      })
      continue
    }
    const bundle = segment.bundle
    rows.push({ key: bundle.key, bundle })
    if (!expandedBundles.has(bundle.key)) continue
    for (const member of bundle.members) {
      rows.push({
        key: `thread:${member.id}`,
        threadIndex: indexById.get(member.id),
        memberOf: bundle,
      })
    }
  }
  return rows
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
    case "contacts":
      // Unreachable today (the contacts pane owns its own listing), kept
      // only so the switch stays exhaustive over ViewSelection.
      return {
        icon: InboxIcon,
        title: "Nothing to list",
        hint: "",
      }
  }
}

/**
 * Empty state of the unified inbox (task 9.2): the underlying view is
 * still a folder/label/search selection, so without this branch the
 * empty copy would name the wrong place — the aggregation is the list.
 */
const UNIFIED_EMPTY_STATE = {
  icon: LayersIcon,
  title: "Unified inbox is empty",
  hint: "Inbox threads from every active account appear here as they sync.",
}

/**
 * Empty state of the priority inbox (task 13.2, design D7): like unified,
 * the underlying view is still a folder/label/search selection, so without
 * this branch the copy would name the wrong place. Priority lists the
 * inbox threads whose newest sender classifies important; everything else
 * stays reachable in the ordinary inbox.
 */
const PRIORITY_EMPTY_STATE = {
  icon: ZapIcon,
  title: "Priority inbox is empty",
  hint: "Threads from senders you reply to or that address you directly show up here as mail arrives.",
}

/**
 * Empty state of the nudges view (task 14.1, design D8): like unified/
 * priority, the underlying view is still a folder/label/search selection,
 * so without this branch the copy would name the wrong place. Nudges
 * lists the threads the detection query finds; nothing to answer right
 * now is the good case.
 */
const NUDGES_EMPTY_STATE = {
  icon: BellRingIcon,
  title: "No nudges right now",
  hint: "Threads waiting on your reply will gather here once they sit unanswered past your nudge threshold.",
}

/**
 * Empty state of an active split tab (task 9.3): like unified/priority/
 * nudges, the underlying view is still a folder/label/search selection,
 * so without this branch the copy would name the wrong place. The split's
 * stored query IS the list — an empty result is the split's own empty,
 * not the underlying folder's.
 */
function splitEmptyState(name: string) {
  return {
    icon: Columns2Icon,
    title: `No threads in "${name}"`,
    hint: "Threads matching this split's search will appear here as they sync.",
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

/**
 * The owning account of one target row (task 9.2): the row's own
 * account_id from the loaded list. In the per-account views this IS the
 * active account (behavior-preserving); in the unified inbox a target may
 * belong to any active account, and the account-scoped thread-actions
 * refuse a foreign accountId (resolveContext → ThreadNotFoundError), so
 * the row's account is the only correct resolution. An unresolvable id
 * falls back to the active account (the pre-9.2 semantics).
 */
function accountForTarget(threadId: string): string | null {
  const activeAccountId = useAccountStore.getState().activeAccountId
  return (
    useThreadListStore
      .getState()
      .threads.find((thread) => thread.id === threadId)?.account_id ??
    activeAccountId
  )
}

/**
 * Targets grouped by their owning account, in encounter order: a
 * unified-inbox selection can span accounts, so the account-scoped
 * actions run once per account group (a single target stays a single
 * call; per-account views always produce exactly one group).
 */
function groupTargetsByAccount(targetIds: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const threadId of targetIds) {
    const accountId = accountForTarget(threadId)
    if (!accountId) continue
    const group = groups.get(accountId)
    if (group) {
      group.push(threadId)
    } else {
      groups.set(accountId, [threadId])
    }
  }
  return groups
}

/** Human labels for the five sort options (task 4.1), in selector order. */
const THREAD_SORT_LABELS: Record<ThreadSortOption, string> = {
  date_desc: "Newest first",
  date_asc: "Oldest first",
  sender: "Sender",
  subject: "Subject",
  unread_first: "Unread first",
}

/**
 * Sort selector (task 4.1): a compact icon + label dropdown in the list
 * header. The choice lives per view scope in thread-list-store
 * (persisted via the `mail.threadSorts` settings row); setSort re-runs
 * the store's refresh, so the list reloads in the chosen order. The
 * checked entry mirrors the store's effective `sort`.
 */
function SortSelector() {
  const sort = useThreadListStore((state) => state.sort)
  const setSort = useThreadListStore((state) => state.setSort)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label="Sort threads"
            data-testid="thread-sort-selector"
            className="gap-1 text-xs font-normal text-muted-foreground"
          >
            <ArrowUpDown className="size-3.5" />
            {THREAD_SORT_LABELS[sort]}
            <ChevronDownIcon className="size-3.5" />
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={sort}>
          {THREAD_SORT_OPTIONS.map((option) => (
            <DropdownMenuRadioItem
              key={option}
              value={option}
              className="text-xs"
              onClick={() => setSort(option)}
            >
              {THREAD_SORT_LABELS[option]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Group-by-sender toggle (task 9.4): a pressed-state icon button next to
 * the sort selector, matching the header's ghost-button look. The choice
 * is one GLOBAL preference (`mail.groupBySender` via the preferences
 * service — the simplest workable scheme, deliberately not per-scope like
 * the sorts): the ThreadList loads it once on mount and persists each
 * toggle fire-and-forget (a failed write keeps the in-memory choice,
 * same semantics as setSort). Grouping itself is a client-side view over
 * the loaded rows — no requery, toggling is instant.
 */
function GroupBySenderToggle({
  enabled,
  onToggle,
}: {
  enabled: boolean
  onToggle: () => void
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label="Group by sender"
      aria-pressed={enabled}
      data-testid="group-by-sender-toggle"
      title="Group consecutive threads from the same sender"
      className={cn(
        "gap-1 text-xs font-normal",
        enabled ? "text-foreground" : "text-muted-foreground"
      )}
      onClick={onToggle}
    >
      <LayersIcon className="size-3.5" />
      Group
    </Button>
  )
}

export function ThreadList({ onStarToggle, onReply }: ThreadListProps) {
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  const view = useUiStore((state) => state.view)
  const listScope = useUiStore((state) => state.listScope)
  const activeThread = useUiStore((state) => state.activeThread)
  const setActiveThread = useUiStore((state) => state.setActiveThread)
  // Unified inbox (task 9.2): a non-null ui-store list-scope override
  // resolves the across-accounts scope (thread-list-store); the rows then
  // carry their own account_id and render the per-row account badge.
  // Priority (task 13.2) enters a scope too but keeps standard rows.
  const unified = listScope?.kind === "unified"
  // Nudges (task 14.1): enters a scope too and keeps standard rows; only
  // its empty state differs.
  const nudges = listScope?.kind === "nudges"
  // An active split tab (task 9.3) owns the pane's title and empty state.
  const splitScope = listScope?.kind === "split" ? listScope : null
  // Every cross-account scope — unified, priority, nudges, saved searches
  // AND un-pinned splits — may render rows from several accounts, so each
  // row carries its owning account's badge; account-pinned scopes stay
  // clean. Resolved from the store's scope descriptor (the same predicate
  // that picks the across-accounts queries).
  const scope = useThreadListStore((state) => state.scope)
  const crossAccount = scope !== null && scopeSpansAccounts(scope)
  const priority = useUiStore((state) => state.listScope?.kind === "priority")
  const accounts = useAccountStore((state) => state.accounts)
  const accountById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account])),
    [accounts]
  )
  const { threads, drafts, labelsByThreadId, userLabels, loading, loaded } =
    useThreadList()
  // Multi-select (task 10.3). Subscribed separately so checkbox toggles
  // re-render the list without touching the data subscriptions.
  const selectedIds = useThreadListStore((state) => state.selectedIds)
  const selectionActive = selectedIds.size > 0

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
  // Bulk targets in the order the rows render (bulkApply applies in order)
  // — the VISIBLE rows only: under the unread-only filter a hidden row is
  // neither selectable nor actionable, so select-all and the bulk buttons
  // never reach past what the list is showing.
  const orderedSelection = useMemo(
    () =>
      visibleThreads
        .filter((thread) => selectedIds.has(thread.id))
        .map((thread) => thread.id),
    [visibleThreads, selectedIds]
  )

  // Group-by-sender bundles (task 9.4). The flag is a global preference:
  // read once per mount through the list's executor seam (a failed read
  // keeps the default off), persisted on every toggle fire-and-forget.
  // Expansion is deliberately session-local component state (a Set of
  // bundle keys) — losing it on refresh is acceptable per the design.
  const [groupBySender, setGroupBySender] = useState(false)
  const [expandedBundles, setExpandedBundles] = useState<Set<string>>(
    () => new Set()
  )
  // Set on the first local toggle: the mount-time preference read below
  // must never clobber a choice the user already made while it resolved.
  const groupPrefTouched = useRef(false)
  useEffect(() => {
    let cancelled = false
    getGroupBySenderPreference(getThreadListExecutor())
      .then((enabled) => {
        if (!cancelled && !groupPrefTouched.current) setGroupBySender(enabled)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])
  const toggleGroupBySender = useCallback(() => {
    groupPrefTouched.current = true
    setGroupBySender((previous) => {
      const next = !previous
      void setGroupBySenderPreference(getThreadListExecutor(), next).catch(
        (error) => {
          console.warn("[thread-list] group-by-sender persist failed", error)
        }
      )
      return next
    })
    // Toggling off drops the (now meaningless) expansion state with it.
    setExpandedBundles(new Set())
  }, [])

  // The collapse step (design D4): GROUP BY over the already-materialized
  // window — visibleThreads in the current sort order; the query is
  // untouched. Runs of one stay plain rows, so a quiet mailbox looks the
  // same grouped or not.
  const grouped = useMemo(
    () => (groupBySender ? groupByConsecutiveSender(visibleThreads) : null),
    [groupBySender, visibleThreads]
  )
  const model = useMemo(
    () =>
      buildThreadListModel(drafts, visibleThreads, grouped, expandedBundles),
    [drafts, visibleThreads, grouped, expandedBundles]
  )

  const scrollerRef = useRef<HTMLDivElement>(null)
  // TanStack Virtual returns stable callbacks the React Compiler cannot
  // memoize; nothing it returns crosses into other memoized components.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: model.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => ESTIMATED_ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index) => model[index]?.key ?? String(index),
  })
  const virtualItems = virtualizer.getVirtualItems()

  // ---- Actions (tasks 10.2/10.3): the ONLY place the list mutates mail ----

  /** Run a thread action for one row or the whole selection, then
   * refresh. Single target = the same named function the keyboard uses;
   * many targets = bulkApply (one change event for the batch). A BULK run
   * clears the selection afterwards (the task's chosen semantics — the
   * action consumed it); single-thread menu actions leave it alone and
   * the post-action refresh prunes any rows that left the view. */
  const runThreadAction = (action: ThreadActionKind, targetIds: string[]) => {
    void (async () => {
      if (targetIds.length === 0) return
      const bulk = targetIds.length > 1
      const executor = getThreadListExecutor()
      // One run per owning-account group (task 9.2): a unified selection
      // spans accounts, and bulkApply/runSingleThreadAction are
      // account-scoped. Per-account views resolve a single group. Failure
      // isolation per group (like toggleLabelOnTargets): one group's
      // rejection is logged and the remaining groups still run — and the
      // rows that DID apply are durably gone from the view, so the
      // refresh (and the bulk selection-clear) always follow.
      for (const [accountId, ids] of groupTargetsByAccount(targetIds)) {
        try {
          if (!bulk) {
            await runSingleThreadAction(action, executor, accountId, ids[0])
          } else {
            await bulkApply(executor, accountId, ids, action)
          }
        } catch (error) {
          console.warn("[thread-list] thread action failed", error)
        }
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
      if (targetIds.length === 0) return
      const bulk = targetIds.length > 1
      const executor = getThreadListExecutor()
      // Per owning-account group (task 9.2): a label belongs to one
      // account, so each thread is applied with ITS account (foreign
      // label ids no-op inside the service rather than cross accounts).
      for (const [accountId, ids] of groupTargetsByAccount(targetIds)) {
        for (const threadId of ids) {
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
      // The row's owning account (task 9.2) — in the unified inbox a row
      // may belong to a non-active account.
      const accountId = accountForTarget(threadId)
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
      // Compose from the row's owning account (task 9.2); the opener
      // defaults to the active account when this resolves to null.
      accountId: accountForTarget(threadId) ?? undefined,
      executor: getThreadListExecutor(),
    })
  }

  /**
   * Snooze the targets (task 2.3): per-thread snoozeThread (the service
   * is local-only SQL — there is no bulk op) through the shared flow,
   * which owns the toast and the list/badge/section refreshes. The
   * post-action list refresh prunes the snoozed rows from the view.
   */
  const snoozeTargets = (targetIds: string[], until: number, label: string) => {
    void snoozeThreadsWithRefresh(
      getThreadListExecutor(),
      targetIds,
      until,
      label
    )
  }

  /**
   * Apply a local-only state (task 3.3) to the targets through the shared
   * flow — per-thread service writes, one toast, the trimmed refresh
   * sequence. Multi-target runs clear the selection afterwards, like the
   * other bulk actions; a mute/done run also drops those rows from the
   * inbox view via the flow's list refresh.
   */
  const applyStateToTargets = (kind: ThreadStateKind, targetIds: string[]) => {
    void applyThreadStatesWithRefresh(
      getThreadListExecutor(),
      targetIds,
      kind
    ).then((applied) => {
      if (applied && targetIds.length > 1) {
        useThreadListStore.getState().clearThreadSelection()
      }
    })
  }

  /**
   * Block the thread's sender (task 18.2) through the SHARED block flow
   * (block-sender-flow.ts — the reading-pane toolbar's block entry runs
   * the exact same path): the blocklist row (per the dialog's action
   * choice) plus the optional existing-mail cleanup through the bulk
   * thread-actions path, one toast, then the list refresh — the blocked
   * sender's rows leave the inbox view.
   */
  const blockSenderFromList = (
    accountId: string,
    sender: string,
    action: BlockedSenderAction,
    applyToExisting: boolean
  ) => {
    void blockSenderWithRefresh(
      getThreadListExecutor(),
      accountId,
      sender,
      action,
      applyToExisting
    )
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

  // ---- Bundle rows (task 9.4): a bundle action IS a multi-target action ----

  /** Expand/collapse one bundle (client-side Set of bundle keys). */
  const toggleBundleExpanded = useCallback((bundle: SenderBundle) => {
    setExpandedBundles((previous) => {
      const next = new Set(previous)
      if (next.has(bundle.key)) {
        next.delete(bundle.key)
      } else {
        next.add(bundle.key)
      }
      return next
    })
  }, [])

  /**
   * Bundle-level archive/trash/mark-read: every member id through the
   * SAME runThreadAction the selection bar uses — >1 members go through
   * bulkApply per owning-account group, so a mixed-account bundle in the
   * unified inbox is handled by the 9.2 machinery untouched.
   */
  const runBundleArchive = (bundle: SenderBundle) => {
    runThreadAction("archive", bundleMemberIds(bundle))
  }
  const runBundleTrash = (bundle: SenderBundle) => {
    runThreadAction("trash", bundleMemberIds(bundle))
  }
  const runBundleMarkRead = (bundle: SenderBundle) => {
    runThreadAction("read", bundleMemberIds(bundle))
  }

  /** Bundle snooze: every member through the shared snooze flow. */
  const snoozeBundle = (bundle: SenderBundle, until: number, label: string) => {
    snoozeTargets(bundleMemberIds(bundle), until, label)
  }

  /** Prop override wins (tests); otherwise the defaults above run. */
  const handleStarToggle = onStarToggle ?? toggleStarFromList

  const menuHandlers: ThreadMenuHandlers = {
    onOpen: (threadId) => setActiveThread(threadId),
    onReply: (threadId) =>
      onReply ? onReply(threadId) : replyFromList(threadId),
    onAction: runThreadAction,
    onToggleLabel: toggleLabelOnTargets,
    onSnooze: snoozeTargets,
    onThreadState: applyStateToTargets,
    onBlockSender: blockSenderFromList,
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
    const empty = unified
      ? UNIFIED_EMPTY_STATE
      : priority
        ? PRIORITY_EMPTY_STATE
        : nudges
          ? NUDGES_EMPTY_STATE
          : splitScope
            ? splitEmptyState(splitScope.name)
            : emptyStateForView(view)
    return (
      <EmptyState icon={empty.icon} title={empty.title} hint={empty.hint} />
    )
  }

  // The header checkbox mirrors the VISIBLE rows: under the unread-only
  // filter, "all selected" means every shown row is checked (and select-
  // all toggles to exactly that set — the store applies the same filter).
  const allSelected = selectedIds.size === visibleThreads.length

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* List header (task 4.1): the group-by-sender toggle + the sort
          selector, right-aligned like the pane header's controls above it.
          The pinned-first lead is part of every store query, so the picker
          only changes the trailing sort. */}
      <div className="flex shrink-0 items-center justify-end gap-1 border-b px-2 py-1">
        <GroupBySenderToggle
          enabled={groupBySender}
          onToggle={toggleGroupBySender}
        />
        <SortSelector />
      </div>
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
            {/* Local-only states (task 3.3): the bar offers the positive
                action for the whole selection — the inverses live in the
                context menu and the reading-pane toolbar. */}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => applyStateToTargets("mute", orderedSelection)}
            >
              Mute
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => applyStateToTargets("pin", orderedSelection)}
            >
              Pin
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => applyStateToTargets("done", orderedSelection)}
            >
              Done
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
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualItems.map((virtualItem) => {
              const row = model[virtualItem.index]
              if (!row) return null
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
              // Bundle row (task 9.4): one virtual row per collapsed
              // same-sender run; activation expands it in place.
              if (row.bundle) {
                return (
                  <BundleRow
                    key={virtualItem.key}
                    measureRef={virtualizer.measureElement}
                    virtualIndex={virtualItem.index}
                    translateY={virtualItem.start}
                    bundle={row.bundle}
                    expanded={expandedBundles.has(row.bundle.key)}
                    onToggle={toggleBundleExpanded}
                    onArchive={runBundleArchive}
                    onTrash={runBundleTrash}
                    onMarkRead={runBundleMarkRead}
                    onSnooze={snoozeBundle}
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
                  // Per-row account identity (task 9.2): only the
                  // cross-account scopes show the badge — per-account and
                  // account-pinned views stay clean.
                  account={
                    crossAccount
                      ? (accountById.get(thread.account_id) ?? null)
                      : null
                  }
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
                  bundleMember={row.memberOf}
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
  /** Owning account — set only in the unified scope (task 9.2); null
   * elsewhere so the per-account views render no badge. */
  account: AccountInfo | null
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
  /** Set when the row renders under an expanded bundle (task 9.4): the
   * row indents and marks itself as a bundle member. */
  bundleMember?: SenderBundle
}

function ThreadRow({
  measureRef,
  virtualIndex,
  translateY,
  thread,
  account,
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
  bundleMember,
}: ThreadRowProps) {
  const unread = thread.unread_count > 0
  const starred = thread.is_starred === 1
  // Local-only states (task 3.3) — rendered as subtle state indicators.
  const muted = thread.muted_at != null
  const pinned = thread.pinned_at != null
  const done = thread.done_at != null
  // Local-only note (task 15.1) — same subtle indicator treatment.
  const hasNote = thread.note != null
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
  // row element; a combined stable callback keeps both attached. The
  // element is also held in state — the context menu's custom snooze
  // picker anchors its popover at the row.
  const [rowElement, setRowElement] = useState<HTMLDivElement | null>(null)
  const setRowRef = useCallback(
    (node: HTMLDivElement | null) => {
      measureRef(node)
      setNodeRef(node)
      setRowElement(node)
    },
    [measureRef, setNodeRef]
  )

  return (
    <ThreadContextMenu
      thread={thread}
      targetIds={targets}
      userLabels={userLabels}
      memberLabelIds={labels.map((label) => label.id)}
      anchorElement={rowElement}
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
            data-muted={muted ? "true" : "false"}
            data-pinned={pinned ? "true" : "false"}
            data-done={done ? "true" : "false"}
            data-has-note={hasNote ? "true" : "false"}
            data-has-attachments={thread.has_attachments ? "true" : "false"}
            data-selected={checked ? "true" : "false"}
            data-dragging={isDragging ? "true" : "false"}
            data-bundle-member={bundleMember ? "true" : undefined}
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
                isDragging && "opacity-50",
                // Bundle members (task 9.4) indent under their bundle row
                // with a subtle left accent marking the nesting.
                bundleMember && "ml-6 border-l-2 border-l-primary/30"
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
                  {/* Account identity (task 9.2): unified-scope rows carry
                      the owning account's badge (hue dot + email tooltip);
                      every other scope passes null and stays clean. */}
                  {account && <AccountBadge account={account} />}
                  {/* State indicators (task 3.3): muted/pinned/done, subtle
                      like the attachment glyph — a muted/done thread left
                      the inbox, so these mostly show in label, All Mail
                      and search views (pinned shows everywhere). */}
                  {muted && (
                    <BellOff
                      aria-label="Muted"
                      className="size-3.5 text-muted-foreground"
                    />
                  )}
                  {pinned && (
                    <Pin
                      aria-label="Pinned"
                      className="size-3.5 text-muted-foreground"
                    />
                  )}
                  {done && (
                    <Check
                      aria-label="Done"
                      className="size-3.5 text-muted-foreground"
                    />
                  )}
                  {hasNote && (
                    <StickyNote
                      aria-label="Has note"
                      className="size-3.5 text-muted-foreground"
                    />
                  )}
                  {thread.has_attachments === 1 && (
                    <Paperclip
                      aria-label="Has attachments"
                      className="size-3.5 text-muted-foreground"
                    />
                  )}
                  {/* Snooze affordance (task 2.3): hover-revealed like the
                      checkbox — a click never opens the thread or touches
                      the selection; it opens the shared snooze menu. */}
                  <span
                    data-thread-snooze={thread.id}
                    className={cn(
                      "flex shrink-0 items-center transition-opacity",
                      "opacity-0 group-hover/row:opacity-100 focus-within:opacity-100"
                    )}
                    onClick={(event) => event.stopPropagation()}
                  >
                    <SnoozeMenu
                      onPick={(until, label) =>
                        handlers.onSnooze([thread.id], until, label)
                      }
                    >
                      <button
                        type="button"
                        aria-label="Snooze"
                        className="rounded-sm p-0.5 hover:bg-accent"
                      >
                        <Clock className="size-3.5 text-muted-foreground" />
                      </button>
                    </SnoozeMenu>
                  </span>
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
// Bundle rows (task 9.4, group-by-sender)
// ---------------------------------------------------------------------------

interface BundleRowProps {
  measureRef: (node: Element | null) => void
  virtualIndex: number
  translateY: number
  bundle: SenderBundle
  expanded: boolean
  onToggle: (bundle: SenderBundle) => void
  onArchive: (bundle: SenderBundle) => void
  onTrash: (bundle: SenderBundle) => void
  onMarkRead: (bundle: SenderBundle) => void
  onSnooze: (bundle: SenderBundle, until: number, label: string) => void
}

/**
 * One collapsed same-sender run (task 9.4): sender display name, a count
 * chip and the LATEST subject among the members — visually distinct from
 * a thread card (dashed border, muted surface) without inventing a new
 * design language. Activation (click, or Enter/Space on the focused row)
 * expands the members in place.
 *
 * The action cluster — Archive / Trash / Mark read / Snooze — is exactly
 * the multi-target action set: each control funnels the member ids
 * through the same handlers the selection bar and the context menu use,
 * so bundle semantics can never drift from bulk semantics. The cluster
 * stops click propagation (a button press must not toggle expansion),
 * and the row itself stays OUT of the multi-selection — there is no
 * checkbox here; the members select individually once expanded.
 */
function BundleRow({
  measureRef,
  virtualIndex,
  translateY,
  bundle,
  expanded,
  onToggle,
  onArchive,
  onTrash,
  onMarkRead,
  onSnooze,
}: BundleRowProps) {
  const count = bundle.members.length
  return (
    <div
      ref={measureRef}
      data-index={virtualIndex}
      data-bundle-row={bundle.key}
      data-bundle-count={count}
      data-bundle-expanded={expanded ? "true" : "false"}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      aria-label={`Bundle of ${count} threads from ${bundle.sender.name}`}
      className="absolute inset-x-0 top-0 px-2 pb-(--density-row) outline-hidden"
      style={{ transform: `translateY(${translateY}px)` }}
      onClick={() => onToggle(bundle)}
      onKeyDown={(event) => {
        // Enter/Space expand — and stop before the global shortcuts hook
        // turns the keypress into "open thread".
        if (event.key !== "Enter" && event.key !== " ") return
        event.stopPropagation()
        event.preventDefault()
        onToggle(bundle)
      }}
    >
      <div className="flex cursor-default items-center gap-2 rounded-lg border border-dashed bg-muted/30 p-2.5 text-sm transition-all hover:bg-accent/50 focus-visible:bg-accent/50">
        {expanded ? (
          <ChevronDownIcon
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
        ) : (
          <ChevronRightIcon
            aria-hidden
            className="size-4 shrink-0 text-muted-foreground"
          />
        )}
        <span className="shrink-0 font-medium">{bundle.sender.name}</span>
        <span
          data-bundle-count-chip="true"
          className="shrink-0 rounded-full bg-muted px-1.5 py-px text-xs text-muted-foreground tabular-nums"
        >
          {count} {count === 1 ? "thread" : "threads"}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {bundle.latest.subject || "(no subject)"}
        </span>
        <span
          className="ml-auto flex shrink-0 items-center gap-0.5"
          onClick={(event) => event.stopPropagation()}
        >
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            onClick={() => onArchive(bundle)}
          >
            <Archive className="size-3.5" />
            Archive
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            onClick={() => onTrash(bundle)}
          >
            <Trash2 className="size-3.5" />
            Trash
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs text-muted-foreground"
            onClick={() => onMarkRead(bundle)}
          >
            <Check className="size-3.5" />
            Mark read
          </Button>
          <SnoozeMenu onPick={(until, label) => onSnooze(bundle, until, label)}>
            <button
              type="button"
              aria-label="Snooze bundle"
              className="rounded-sm p-0.5 hover:bg-accent"
            >
              <Clock className="size-3.5 text-muted-foreground" />
            </button>
          </SnoozeMenu>
        </span>
      </div>
    </div>
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
