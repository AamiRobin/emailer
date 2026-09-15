import { useEffect } from "react"
import { differenceInCalendarDays, format, fromUnixTime } from "date-fns"
import { create } from "zustand"
import { useShallow } from "zustand/react/shallow"

import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import { listDrafts } from "@/services/composer/drafts"
import type { DraftRecord } from "@/services/composer/drafts"
import { listLabelsByAccount } from "@/services/db/labels"
import type { ThreadLabelLite, ThreadRow } from "@/services/db/threads"
import { getLabelsForThreads, listThreadsByFolder } from "@/services/db/threads"
import { searchThreadsQuery } from "@/services/search"
import { useAccountStore } from "@/stores/account-store"
import type { ViewSelection } from "@/stores/ui-store"
import { useUiStore } from "@/stores/ui-store"

/**
 * Thread-list data store (task 6.4): the ThreadRow page behind the center
 * pane, resolved from uiStore.view + the active account.
 *
 * View → query mapping (see the ui-store comment):
 * - folder.specialUse → listThreadsByFolder {kind:"specialUse"}
 * - folder.starred    → listThreadsByFolder {kind:"preset", preset:"starred"}
 * - folder.labelId and label → listThreadsByFolder {kind:"labelId"}
 * - search            → searchThreadsQuery (services/search)
 * - settings          → no threads (the settings page replaces the panes)
 *
 * Drafts exception (task 8.6's UI half): in the Drafts folder view the
 * local `local_drafts` rows (composer autosave snapshots, local-only —
 * there is no server draft sync) are listed alongside the synced thread
 * rows, so they load in the same refresh via listDrafts; every other view
 * carries an empty `drafts` array.
 *
 * It is a cache, not a subscription: callers that change mail data (sync
 * completion, mark-read/star/label actions — task 10.1) re-run
 * refreshThreadList() afterwards; the hook additionally reloads whenever
 * the view or active account changes, so switching is a local re-read,
 * never a network wait. Label chips come along in the same refresh via the
 * batched getLabelsForThreads query (one round-trip for the whole page).
 *
 * Queries go through an injectable SqlExecutor that defaults to
 * getExecutor(); tests pass a node:sqlite executor via
 * setThreadListStoreExecutor() (same override pattern as account-store).
 */

interface ThreadListState {
  /** Account the current rows belong to (null = no active account). */
  accountId: string | null
  /** View the current rows were loaded for (null = nothing loaded yet). */
  view: ViewSelection | null
  threads: ThreadRow[]
  /**
   * Local composer drafts for the current view — populated ONLY in the
   * Drafts folder view (see the module docstring's drafts exception),
   * newest edit first (listDrafts ordering). The thread list renders them
   * as resumable rows above the thread rows; empty everywhere else.
   */
  drafts: DraftRecord[]
  /** Gmail label chips per thread id, loaded alongside the rows. */
  labelsByThreadId: Record<string, ThreadLabelLite[]>
  /**
   * The account's USER labels (context-menu Labels submenu + selection-bar
   * label dropdown, tasks 10.2/10.3). Loaded in the same refresh; empty
   * for imap accounts (their labels are folders, not chips).
   */
  userLabels: ThreadLabelLite[]
  loading: boolean
  /** True once a load has completed for the current (account, view). */
  loaded: boolean
  /**
   * Multi-select (task 10.3): the checked row ids. Empty set = no
   * multi-select; uiStore.activeThread stays the single "cursor" row the
   * reading pane and the keyboard shortcuts follow.
   */
  selectedIds: Set<string>
  /**
   * Index into the ordered `threads` of the last PLAIN selection click —
   * the anchor shift-click / shift-arrow ranges extend from. Null after a
   * view/account change or once the index falls off the reloaded list.
   */
  selectionAnchor: number | null
  /**
   * "All mail | Unread" header-toggle filter (the tweakcn mail reference's
   * segmented control). Client-side over the loaded rows: unread-only hides
   * threads with nothing unread without a requery. Lives here (not local
   * component state) because the toggle renders in the shell's pane header,
   * next to the title, while the filtering happens in ThreadList.
   */
  unreadOnly: boolean
  setUnreadOnly: (unreadOnly: boolean) => void
  /**
   * Checkbox toggle (task 10.3). Plain toggle flips the row's membership
   * and MOVES the anchor to it. With `range` (shift-click) the run of rows
   * from the anchor to the target joins the selection instead (union —
   * already-selected rows in between stay), and the anchor stays put.
   */
  toggleThreadSelection(threadId: string, range?: boolean): void
  /**
   * Range-select seam for shift-arrow (shift+j/k) wiring in the shortcuts
   * hook (task 6.6's file — not wired yet): adds the rows from the anchor
   * to `threadId` (inclusive) to the selection, WITHOUT moving the anchor.
   * Without an anchor it selects the single row only.
   */
  selectRangeTo(threadId: string): void
  /** Move the shift-range anchor to `threadId` (a plain open-click does
   * this too, so opening then shift-clicking extends from the open row). */
  setThreadSelectionAnchor(threadId: string): void
  /** Select every row of the current view (selection-bar select-all). */
  selectAllThreads(): void
  /** Drop the whole multi-selection (also resets the anchor). */
  clearThreadSelection(): void
  /** Re-run the thread + label queries for the current view and account. */
  refresh(): Promise<void>
}

let executorOverride: SqlExecutor | null = null

function resolveExecutor(): SqlExecutor {
  return executorOverride ?? getExecutor()
}

/** Test hook: run the list queries against `executor` (node:sqlite under
 * vitest); pass null to restore the production getExecutor() binding. */
export function setThreadListStoreExecutor(executor: SqlExecutor | null): void {
  executorOverride = executor
}

/**
 * Executor seam for the thread-list UI (tasks 10.2/10.3): the context
 * menu and selection bar run thread-actions with the same executor the
 * store reads through, so tests inject one node:sqlite database via
 * setThreadListStoreExecutor() and both layers hit it.
 */
export function getThreadListExecutor(): SqlExecutor {
  return resolveExecutor()
}

/** Canonical change key for a view (drives reload-on-change + staleness). */
export function viewKey(view: ViewSelection): string {
  return JSON.stringify(view)
}

async function queryThreads(
  executor: SqlExecutor,
  accountId: string,
  view: ViewSelection
): Promise<ThreadRow[]> {
  if (view.kind === "settings") return []
  if (view.kind === "search") {
    return searchThreadsQuery(executor, accountId, view.query)
  }
  if (view.kind === "label") {
    return listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "labelId", labelId: view.labelId },
    })
  }
  const folder = view.folder
  if (folder.kind === "starred") {
    return listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "starred" },
    })
  }
  return listThreadsByFolder(executor, { accountId, folder })
}

/** True when the view is the Drafts system folder — the one view whose
 * listing includes the account's local composer drafts (task 8.6). */
function isDraftsView(view: ViewSelection): boolean {
  return (
    view.kind === "folder" &&
    view.folder.kind === "specialUse" &&
    view.folder.specialUse === "drafts"
  )
}

export const useThreadListStore = create<ThreadListState>((set, get) => ({
  accountId: null,
  view: null,
  threads: [],
  drafts: [],
  labelsByThreadId: {},
  userLabels: [],
  loading: false,
  loaded: false,
  selectedIds: new Set<string>(),
  selectionAnchor: null,
  unreadOnly: false,
  setUnreadOnly: (unreadOnly) => set({ unreadOnly }),

  toggleThreadSelection: (threadId, range = false) => {
    const { threads, selectedIds } = get()
    const index = threads.findIndex((thread) => thread.id === threadId)
    if (index === -1) return
    if (range) {
      const next = idsInRange(
        threads,
        get().selectionAnchor,
        index,
        selectedIds
      )
      set({ selectedIds: next })
      return
    }
    const next = new Set(selectedIds)
    if (next.has(threadId)) {
      next.delete(threadId)
    } else {
      next.add(threadId)
    }
    set({ selectedIds: next, selectionAnchor: index })
  },

  selectRangeTo: (threadId) => {
    const { threads, selectedIds, selectionAnchor } = get()
    const index = threads.findIndex((thread) => thread.id === threadId)
    if (index === -1) return
    set({
      selectedIds: idsInRange(threads, selectionAnchor, index, selectedIds),
    })
  },

  setThreadSelectionAnchor: (threadId) => {
    const index = get().threads.findIndex((thread) => thread.id === threadId)
    if (index === -1) return
    set({ selectionAnchor: index })
  },

  selectAllThreads: () => {
    set({
      selectedIds: new Set(get().threads.map((thread) => thread.id)),
    })
  },

  clearThreadSelection: () => {
    set({ selectedIds: new Set<string>(), selectionAnchor: null })
  },

  refresh: async () => {
    const accountId = useAccountStore.getState().activeAccountId
    const view = useUiStore.getState().view
    // A view/account change is a new page: the multi-selection and its
    // anchor do not survive it (spec 10.3). Same-view refreshes (post
    // action) only get pruned to the surviving rows below.
    const previous = get()
    const changedPage =
      previous.accountId !== accountId ||
      previous.view === null ||
      viewKey(previous.view) !== viewKey(view)
    if (!accountId || view.kind === "settings") {
      set({
        accountId,
        view,
        threads: [],
        drafts: [],
        labelsByThreadId: {},
        userLabels: [],
        loading: false,
        loaded: true,
        selectedIds: new Set<string>(),
        selectionAnchor: null,
      })
      return
    }
    set({ loading: true })
    // The account/view the response must still belong to when each await
    // settles — later loads are dropped otherwise (staleness guard).
    const isStale = () =>
      useAccountStore.getState().activeAccountId !== accountId ||
      viewKey(useUiStore.getState().view) !== viewKey(view)
    try {
      const executor = resolveExecutor()
      const threads = await queryThreads(executor, accountId, view)
      // Drop the response if the view/account changed while it ran.
      if (isStale()) return
      const labels = await getLabelsForThreads(
        executor,
        accountId,
        threads.map((thread) => thread.id)
      )
      const allLabels = await listLabelsByAccount(executor, accountId)
      if (isStale()) return
      // Drafts rows ride along only in the Drafts folder view (local-only
      // data; every other view keeps the array empty).
      const drafts = isDraftsView(view)
        ? await listDrafts(executor, accountId)
        : []
      if (isStale()) return
      set({
        accountId,
        view,
        threads,
        drafts,
        labelsByThreadId: Object.fromEntries(labels),
        userLabels: allLabels
          .filter((label) => label.type === "user")
          .map((label) => ({
            id: label.id,
            name: label.name,
            color: label.color,
          })),
        loading: false,
        loaded: true,
        ...nextSelection(get(), changedPage, threads),
      })
    } catch (error) {
      // No DB outside Tauri (plain vite) — show the empty list, not a crash.
      console.warn("[thread-list-store] refresh failed", error)
      if (get().loading) {
        set({
          loading: false,
          loaded: true,
          threads: [],
          drafts: [],
          labelsByThreadId: {},
          userLabels: [],
        })
      }
    }
  },
}))

/**
 * Selection carried across a same-view refresh: rows removed by actions
 * (archived, trashed, deleted) leave the selection, and an anchor that
 * fell off the reloaded list is dropped. A changed page resets both.
 */
function nextSelection(
  state: { selectedIds: Set<string>; selectionAnchor: number | null },
  changedPage: boolean,
  threads: ThreadRow[]
): { selectedIds: Set<string>; selectionAnchor: number | null } {
  if (changedPage) {
    return { selectedIds: new Set<string>(), selectionAnchor: null }
  }
  const ids = new Set(threads.map((thread) => thread.id))
  const selectedIds = new Set(
    [...state.selectedIds].filter((id) => ids.has(id))
  )
  const selectionAnchor =
    state.selectionAnchor !== null && state.selectionAnchor < threads.length
      ? state.selectionAnchor
      : null
  return { selectedIds, selectionAnchor }
}

// ---- Multi-selection helpers (task 10.3, exported like 6.6's) ----

/**
 * Standalone entry points over the store's selection actions — the same
 * delegation pattern as moveThreadSelection above, so the thread list and
 * (later) the shortcuts hook can call them without subscribing.
 */

/** Checkbox toggle; `range` = shift-click (see the store action docs). */
export function toggleThreadSelection(threadId: string, range = false): void {
  useThreadListStore.getState().toggleThreadSelection(threadId, range)
}

/**
 * Range-select seam for shift-arrow (shift+j/k): adds anchor…threadId to
 * the selection without moving the anchor. NOT wired into the shortcuts
 * hook yet (6.6's file) — noted as the follow-up gap in task 10.3.
 */
export function selectRangeTo(threadId: string): void {
  useThreadListStore.getState().selectRangeTo(threadId)
}

/** Select every row of the current view (selection-bar select-all). */
export function selectAllThreads(): void {
  useThreadListStore.getState().selectAllThreads()
}

/** Drop the whole multi-selection (also resets the anchor). */
export function clearThreadSelection(): void {
  useThreadListStore.getState().clearThreadSelection()
}

/**
 * The ids of the inclusive `anchor…target` run of `threads`, unioned with
 * the current selection. With a null anchor (no plain click yet) only the
 * target row is returned — the first shift-click without an anchor behaves
 * like selecting that single row.
 */
function idsInRange(
  threads: ThreadRow[],
  anchor: number | null,
  targetIndex: number,
  selectedIds: Set<string>
): Set<string> {
  const next = new Set(selectedIds)
  if (anchor === null) {
    next.add(threads[targetIndex].id)
    return next
  }
  const start = Math.min(anchor, targetIndex)
  const end = Math.max(anchor, targetIndex)
  for (let index = start; index <= end; index += 1) {
    next.add(threads[index].id)
  }
  return next
}

/**
 * Refresh entry point for other features: after any action that changes
 * thread rows (sync completion, mark-read, star, archive, label changes —
 * wired in task 10.1), call refreshThreadList() to re-read the current
 * view. Safe to call anytime; a no-op refresh costs two small queries.
 */
export function refreshThreadList(): Promise<void> {
  return useThreadListStore.getState().refresh()
}

// ---- Keyboard selection helpers (task 6.6, additive) ----

/**
 * Selection lives in uiStore.activeThread over THIS store's ordered
 * `threads`; the shortcuts hook (src/hooks/use-keyboard-shortcuts.ts)
 * owns the binding table but delegates the index arithmetic to these two
 * helpers so it stays next to the list it indexes. Both are no-ops on an
 * empty list and never touch any other state.
 */

/**
 * Move the list selection `delta` rows (clamped to the list bounds). With
 * no selection yet, any delta selects the FIRST row — pressing j/k in a
 * fresh mailbox enters the list at the top.
 */
export function moveThreadSelection(delta: number): void {
  const { threads } = useThreadListStore.getState()
  if (threads.length === 0) return
  const currentId = useUiStore.getState().activeThread
  const currentIndex = currentId
    ? threads.findIndex((thread) => thread.id === currentId)
    : -1
  const nextIndex =
    currentIndex === -1
      ? 0
      : Math.min(Math.max(currentIndex + delta, 0), threads.length - 1)
  useUiStore.getState().setActiveThread(threads[nextIndex].id)
}

/**
 * After a removal-style keyboard action (archive / trash, task 6.6):
 * keep the cursor stable by selecting the row AFTER `removedThreadId` —
 * the mailbox-ui keyboard scenario's "selection advancing to the next
 * thread" — falling back to the previous row, then to no selection.
 * Computed against the current cached rows (pre-refresh), which is
 * exactly the ordering the user sees.
 */
export function selectNeighboringThread(removedThreadId: string): void {
  const { threads } = useThreadListStore.getState()
  const index = threads.findIndex((thread) => thread.id === removedThreadId)
  if (index === -1) return
  const next = threads[index + 1] ?? threads[index - 1] ?? null
  useUiStore.getState().setActiveThread(next ? next.id : null)
}

export interface UseThreadListResult {
  threads: ThreadRow[]
  /** Local drafts — populated only in the Drafts folder view (task 8.6). */
  drafts: DraftRecord[]
  labelsByThreadId: Record<string, ThreadLabelLite[]>
  /** The account's user labels (menus, task 10.2/10.3). */
  userLabels: ThreadLabelLite[]
  loading: boolean
  loaded: boolean
}

/**
 * React binding: subscribes to the list data and reloads whenever the
 * view (uiStore) or the active account (account-store) changes.
 */
export function useThreadList(): UseThreadListResult {
  const view = useUiStore((state) => state.view)
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  const refresh = useThreadListStore((state) => state.refresh)

  useEffect(() => {
    void refresh()
  }, [view, activeAccountId, refresh])

  return useThreadListStore(
    useShallow((state) => ({
      threads: state.threads,
      drafts: state.drafts,
      labelsByThreadId: state.labelsByThreadId,
      userLabels: state.userLabels,
      loading: state.loading,
      loaded: state.loaded,
    }))
  )
}

/*
 * Thread-list presentation helpers shared by the row composite and the
 * reading pane's bridge to the mock MailDisplay (kept out of the tsx so
 * fast-refresh sees components only).
 */

/** The four date groups, in display order. */
export type DateGroup = "Today" | "Yesterday" | "This week" | "Earlier"

/**
 * Calendar-day bucket for a thread's last_message_at (unix seconds).
 * Future timestamps (clock skew) count as Today; a missing date lands in
 * the last group so it never breaks the ordering.
 */
export function dateGroupLabel(
  lastMessageAt: number | null,
  now: Date = new Date()
): DateGroup {
  if (lastMessageAt === null) return "Earlier"
  // days FROM the message TO now: positive for the past, negative for the
  // future (clock skew lands in Today).
  const days = differenceInCalendarDays(now, fromUnixTime(lastMessageAt))
  if (days <= 0) return "Today"
  if (days === 1) return "Yesterday"
  if (days < 7) return "This week"
  return "Earlier"
}

/** Row timestamp: clock time for today, short date otherwise. */
export function formatRowTimestamp(
  lastMessageAt: number | null,
  now: Date = new Date()
): string {
  if (lastMessageAt === null) return ""
  const date = fromUnixTime(lastMessageAt)
  if (differenceInCalendarDays(now, date) === 0) return format(date, "h:mm a")
  if (date.getFullYear() === now.getFullYear()) return format(date, "MMM d")
  return format(date, "MMM d, yyyy")
}

/** `{name?, email}` participant as cached in threads.participants. */
export interface ThreadParticipant {
  name?: string
  email: string
}

export function parseThreadParticipants(
  json: string | null
): ThreadParticipant[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is ThreadParticipant =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as ThreadParticipant).email === "string"
    )
  } catch {
    return []
  }
}

/** "name" (falling back to the address) of the first cached participant. */
export function primaryParticipantName(
  participants: ThreadParticipant[]
): string {
  const first = participants[0]
  return first ? first.name || first.email : ""
}

/** List display: primary participant plus a "+N" for the rest. */
export function formatThreadParticipants(
  participants: ThreadParticipant[]
): string {
  const primary = primaryParticipantName(participants)
  if (!primary) return ""
  const rest = participants.length - 1
  return rest > 0 ? `${primary} (+${rest})` : primary
}
