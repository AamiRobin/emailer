import { useEffect } from "react"
import { differenceInCalendarDays, format, fromUnixTime } from "date-fns"
import { create } from "zustand"
import { useShallow } from "zustand/react/shallow"

import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import { listDrafts } from "@/services/composer/drafts"
import type { DraftRecord } from "@/services/composer/drafts"
import { listActiveAccounts } from "@/services/db/accounts"
import { listLabelsByAccount } from "@/services/db/labels"
import { listNudges } from "@/services/db/nudges"
import { listPriorityImportant } from "@/services/priority/view"
import type { ThreadSortOption } from "@/services/db/thread-sort"
import { DEFAULT_THREAD_SORT } from "@/services/db/thread-sort"
import type {
  FolderSelection as DbFolderSelection,
  ThreadLabelLite,
  ThreadRow,
} from "@/services/db/threads"
import {
  getLabelsForThreads,
  listThreadsAcrossAccounts,
  listThreadsByFolder,
} from "@/services/db/threads"
import {
  searchThreadsAcrossAccounts,
  searchThreadsQuery,
} from "@/services/search"
import {
  getNudgeDays,
  getThreadSorts,
  setThreadSorts,
} from "@/services/settings/preferences"
import { useAccountStore } from "@/stores/account-store"
import type { ListScopeOverride, ViewSelection } from "@/stores/ui-store"
import { useUiStore } from "@/stores/ui-store"

/**
 * Thread-list data store (task 6.4): the ThreadRow page behind the center
 * pane, resolved from uiStore.view + the active account.
 *
 * View → scope → query mapping (tasks 6.4 + 9.1, design D4): every view
 * resolves to a ThreadListScope descriptor first (resolveScope), and the
 * scope picks the query. The account filter is part of the descriptor —
 * folder/label/search scopes stay per-account; the unified inbox (and an
 * un-pinned split or a saved search) runs across the ACTIVE accounts via
 * listThreadsAcrossAccounts / searchThreadsAcrossAccounts, and every row
 * carries its `account_id` for the per-row account identity (task 9.2):
 * - folder.specialUse → scope account {folder} → listThreadsByFolder
 * - folder.starred    → scope account {preset starred}
 * - folder.labelId and label → account/label scope → listThreadsByFolder
 * - search            → scope search → searchThreadsQuery
 * - listScope override unified/priority/split/saved-search (ui-store) →
 *   the across-accounts queries; splits and saved searches carry their
 *   query string through the same search pipeline, priority resolves
 *   through listPriorityImportant (sender classification, task 13.2)
 * - settings          → no threads (the settings page replaces the panes)
 *
 * Drafts exception (task 8.6's UI half): in the Drafts folder view the
 * local `local_drafts` rows (composer autosave snapshots, local-only —
 * there is no server draft sync) are listed alongside the synced thread
 * rows, so they load in the same refresh via listDrafts; every other view
 * carries an empty `drafts` array (the drafts pseudo-view stays
 * per-account — no scope override can produce it).
 *
 * Per-view sort (task 4.1): `sort` is the effective ThreadSortOption for
 * the active scope, resolved from one persisted per-scope map
 * (`mail.threadSorts` in the settings table, scope keys from scopeSortKey,
 * default date_desc). setSort updates + persists the map and re-runs
 * refresh; both list queries take the option and map it to fixed ORDER BY
 * fragments that keep pinned-first leading.
 *
 * It is a cache, not a subscription: callers that change mail data (sync
 * completion, mark-read/star/label actions — task 10.1) re-run
 * refreshThreadList() afterwards; the hook additionally reloads whenever
 * the view, the list-scope override or the active account changes, so
 * switching is a local re-read, never a network wait. Label chips come
 * along in the same refresh via the batched getLabelsForThreads query
 * (one round-trip for the whole page) — for the ACTIVE account; unified
 * rows from other accounts surface their chips through task 9.2's
 * per-account work.
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
  /**
   * The scope the current rows were loaded for (null = nothing loaded or
   * a settings/permission-less state) — the resolved ThreadListScope the
   * view + listScope override produced at refresh time (design D4). The
   * unified/split/saved-search scopes surface here; task 9.2 reads it
   * (and each row's account_id) for the per-row account identity.
   */
  scope: ThreadListScope | null
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
   * Effective sort of the current view (task 4.1): the entry for
   * threadSortScopeKey(view) in the persisted per-scope map, or
   * date_desc when that scope has none. Re-resolved on every refresh, so
   * view/account switches pick up the scope's own choice.
   */
  sort: ThreadSortOption
  /** Change the current view's sort: updates the in-memory map, persists
   * the whole map fire-and-forget (a write failure keeps the in-memory
   * choice), and re-runs the regular refresh so the list reloads. */
  setSort: (sort: ThreadSortOption) => void
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
  /**
   * Select every VISIBLE row of the current view (selection-bar
   * select-all): under the unread-only filter only the unread rows join —
   * selection never reaches rows the list is hiding.
   */
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
 * vitest); pass null to restore the production getExecutor() binding.
 * Also drops the cached per-scope sort map so a fresh executor re-reads
 * its settings rows (tests bind a new database per case). */
export function setThreadListStoreExecutor(executor: SqlExecutor | null): void {
  executorOverride = executor
  sortMapCache = null
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

/**
 * The list identity behind the active view (design D4, task 9.1): every
 * list the pipeline serves resolves to one of these descriptors, and the
 * account filter is part of the descriptor — the per-account scopes pin
 * their account while `unified` / `split` / `saved-search` run across the
 * ACTIVE accounts through the across-accounts query variants (rows keep
 * their `account_id` either way). One list pipeline serves all of them.
 *
 * The kinds follow D4's `account | unified | split | saved-search | label
 * | folder` concept space: D4's "folder" and "account" name the same
 * per-account list here (every folder view is account-scoped), so today's
 * folder views resolve to `account` carrying the folder payload, and the
 * ephemeral operator search keeps its own `search` kind (distinct from a
 * stored `saved-search`) so its behavior and scope key are unchanged.
 */
export type ThreadListScope =
  /** A per-account folder view (today's ui "folder" selections). */
  | { kind: "account"; accountId: string; folder: DbFolderSelection }
  /** The cross-account inbox (task 9.2's view): the inbox predicates
   * minus the account filter, across the active accounts. */
  | { kind: "unified" }
  /** The priority inbox (task 13.2, design D7): the active accounts'
   * inbox threads whose newest sender classifies important (the D7
   * sender heuristic + overrides, priority/view.ts) — the lean scoping:
   * Other is everything else, reachable through the ordinary inbox. */
  | { kind: "priority" }
  /** The nudges view (task 14.1, design D8): the active accounts'
   * awaiting-reply threads detected by the db/nudges.ts query — no
   * stored state, recomputed on every refresh. */
  | { kind: "nudges" }
  /** A split tab (task 9.3): a stored operator query run through the
   * search pipeline, pinned to one account (`accountId`) or across the
   * active accounts (omitted). */
  | { kind: "split"; name: string; query: string; accountId?: string }
  /** A saved search (task 7.1 rows) as a listing: a global operator
   * query across every active account. */
  | { kind: "saved-search"; name: string; query: string }
  /** A per-account label view (today's ui "label" selections). */
  | { kind: "label"; accountId: string; labelId: string }
  /** The per-account operator search (today's ui "search" views). */
  | { kind: "search"; accountId: string; query: string }
  /** Settings replaces the panes; nothing lists there. */
  | { kind: "settings" }

/**
 * The internal resolution step (task 9.1): view + ui-store list-scope
 * override + active account → the scope descriptor the pipeline runs.
 * Total — every view maps (settings → the settings scope).
 */
export function resolveScope(
  view: ViewSelection,
  override: ListScopeOverride | null,
  accountId: string
): ThreadListScope {
  if (override) {
    switch (override.kind) {
      case "unified":
        return { kind: "unified" }
      case "priority":
        return { kind: "priority" }
      case "nudges":
        return { kind: "nudges" }
      case "split":
        return {
          kind: "split",
          name: override.name,
          query: override.query,
          ...(override.accountId ? { accountId: override.accountId } : {}),
        }
      case "saved-search":
        return {
          kind: "saved-search",
          name: override.name,
          query: override.query,
        }
    }
  }
  switch (view.kind) {
    case "settings":
      return { kind: "settings" }
    case "contacts":
      // The Contacts browser (task 20.2) replaces the mailbox panes like
      // settings and lists no threads, so it shares the settings scope.
      return { kind: "settings" }
    case "search":
      return { kind: "search", accountId, query: view.query }
    case "label":
      return { kind: "label", accountId, labelId: view.labelId }
    case "folder":
      return {
        kind: "account",
        accountId,
        folder:
          view.folder.kind === "starred"
            ? // The UI's starred pseudo-folder is the db layer's preset.
              { kind: "preset", preset: "starred" }
            : view.folder,
      }
  }
}

/**
 * Persistence scope for the per-view sort choice (tasks 4.1 + 9.1). One
 * key per list identity, kept in a single `mail.threadSorts` settings row:
 * - account scopes (folder views) → `special:<role>` for specialUse roles,
 *   `special:starred` for the starred preset, `label:<labelId>` for a
 *   folder.labelId selection
 * - label views → `label:<labelId>` (same query as folder.labelId, so they
 *   share one scope)
 * - the ephemeral search → `search` (one shared scope regardless of the
 *   query text — refining a search keeps the sort)
 * - unified → `unified`
 * - priority → `priority` (the classification view is one list identity
 *   across the active accounts, like unified)
 * - split / saved-search → `split:<name>` / `saved-search:<name>` (each
 *   named query is its own list identity)
 * - settings → `settings` (nothing lists there; kept for totality)
 */
export function scopeSortKey(scope: ThreadListScope): string {
  switch (scope.kind) {
    case "account":
      if (scope.folder.kind === "specialUse") {
        return `special:${scope.folder.specialUse}`
      }
      if (scope.folder.kind === "preset") {
        // The starred preset behaves like a system view (its key predates
        // the scope concept); other presets are never view-resolved today.
        return scope.folder.preset === "starred"
          ? "special:starred"
          : `preset:${scope.folder.preset}`
      }
      return `label:${scope.folder.labelId}`
    case "label":
      return `label:${scope.labelId}`
    case "search":
      return "search"
    case "unified":
      return "unified"
    case "priority":
      return "priority"
    case "nudges":
      return "nudges"
    case "split":
      return `split:${scope.name}`
    case "saved-search":
      return `saved-search:${scope.name}`
    case "settings":
      return "settings"
  }
}

/**
 * View-level form of scopeSortKey (kept for the pre-9.1 callers' shape):
 * the scope key of the view's own resolution, ignoring any list-scope
 * override.
 */
export function threadSortScopeKey(view: ViewSelection): string {
  return scopeSortKey(resolveScope(view, null, ""))
}

/**
 * Per-scope sort map, loaded lazily ONCE from the settings row
 * (`mail.threadSorts`, via the preferences service) and then kept in
 * memory — same cached-read pattern as the other settings consumers.
 * setSort updates the map and persists the whole object fire-and-forget;
 * the test executor hook above drops the cache so a fresh database is
 * re-read.
 */
let sortMapCache: Record<string, ThreadSortOption> | null = null

/**
 * True when the scope's rows can span more than one account: the scope
 * lists across the ACTIVE accounts (listActiveAccounts — status
 * "active"), so its rows carry foreign account ids and consumers show
 * per-row account identity (the AccountBadge). The exact set of scopes
 * that also need the account-id set resolved before the query.
 */
export function scopeSpansAccounts(scope: ThreadListScope): boolean {
  return (
    scope.kind === "unified" ||
    scope.kind === "priority" ||
    scope.kind === "nudges" ||
    scope.kind === "saved-search" ||
    (scope.kind === "split" && scope.accountId === undefined)
  )
}

/**
 * True for the scopes that list across the ACTIVE accounts and therefore
 * need the account-id set (listActiveAccounts — status "active")
 * resolved before the query; refresh re-reads it every time.
 */
function scopeNeedsActiveAccounts(scope: ThreadListScope): boolean {
  return scopeSpansAccounts(scope)
}

async function queryThreads(
  executor: SqlExecutor,
  scope: ThreadListScope,
  sort: ThreadSortOption,
  activeAccountIds: string[]
): Promise<ThreadRow[]> {
  switch (scope.kind) {
    case "settings":
      return []
    case "search":
      return searchThreadsQuery(executor, scope.accountId, scope.query, {
        sort,
      })
    case "label":
      return listThreadsByFolder(executor, {
        accountId: scope.accountId,
        folder: { kind: "labelId", labelId: scope.labelId },
        sort,
      })
    case "account":
      return listThreadsByFolder(executor, {
        accountId: scope.accountId,
        folder: scope.folder,
        sort,
      })
    case "unified":
      // The unified inbox (task 9.2's view): the account-scoped inbox
      // query minus the account filter, across the active accounts — the
      // PRESET inbox, whose predicates carry the full exclusion set
      // (trash/spam caches plus snoozed/muted/done). An empty active set
      // lists nothing — listThreadsAcrossAccounts's empty set means
      // "every account", which is never what the unified view means
      // (auth-error accounts must stay out).
      if (!activeAccountIds.length) return []
      return listThreadsAcrossAccounts(executor, {
        accountIds: activeAccountIds,
        folder: { kind: "preset", preset: "inbox" },
        sort,
      })
    case "priority":
      // The priority inbox (task 13.2, D7): the active accounts' inbox
      // threads whose newest sender classifies important (sender stats +
      // overrides via priority/view.ts). Same empty-guard as unified — an
      // empty active set lists nothing (null would mean "every account").
      if (!activeAccountIds.length) return []
      return listPriorityImportant(executor, activeAccountIds, sort)
    case "nudges": {
      // The nudges view (task 14.1, D8): the detection query over the
      // active accounts (db/nudges.ts), with the age threshold read from
      // the `mail.nudgeDays` preference on every refresh. Same
      // empty-guard as the other across-accounts scopes.
      if (!activeAccountIds.length) return []
      const thresholdDays = await getNudgeDays(executor)
      return listNudges(executor, {
        accountIds: activeAccountIds,
        thresholdDays,
        sort,
      })
    }
    case "split":
      // A split (task 9.3) runs its stored query through the same search
      // pipeline: pinned to its account, or across the active accounts.
      if (scope.accountId) {
        return searchThreadsQuery(executor, scope.accountId, scope.query, {
          sort,
        })
      }
      return searchThreadsAcrossAccounts(
        executor,
        activeAccountIds,
        scope.query,
        { sort }
      )
    case "saved-search":
      // A saved search is a global bookmark: across every active account.
      return searchThreadsAcrossAccounts(
        executor,
        activeAccountIds,
        scope.query,
        { sort }
      )
  }
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
  scope: null,
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
  sort: DEFAULT_THREAD_SORT,

  setSort: (sort) => {
    const { view, listScope: override } = useUiStore.getState()
    if (view.kind === "settings") return
    const accountId = useAccountStore.getState().activeAccountId ?? ""
    const scopeKey = scopeSortKey(resolveScope(view, override, accountId))
    const nextMap = { ...(sortMapCache ?? {}), [scopeKey]: sort }
    sortMapCache = nextMap
    set({ sort })
    // Fire-and-forget persist: a failed write (e.g. no DB yet) keeps the
    // in-memory choice and only loses the cross-launch persistence.
    void (async () => {
      try {
        await setThreadSorts(resolveExecutor(), nextMap)
      } catch (error) {
        console.warn("[thread-list-store] sort persist failed", error)
      }
    })()
    // The store's regular reload path re-runs the query with the new sort.
    void get().refresh()
  },

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
    const { threads, unreadOnly } = get()
    // The same predicate ThreadList renders visibleThreads with: under
    // the unread-only filter, select-all covers only the unread rows.
    const visible = unreadOnly
      ? threads.filter((thread) => thread.unread_count > 0)
      : threads
    set({
      selectedIds: new Set(visible.map((thread) => thread.id)),
    })
  },

  clearThreadSelection: () => {
    set({ selectedIds: new Set<string>(), selectionAnchor: null })
  },

  refresh: async () => {
    const accountId = useAccountStore.getState().activeAccountId
    const { view, listScope: override } = useUiStore.getState()
    const scope =
      accountId === null ? null : resolveScope(view, override, accountId)
    // A view/scope/account change is a new page: the multi-selection and
    // its anchor do not survive it (spec 10.3). Same-page refreshes (post
    // action) only get pruned to the surviving rows below.
    const previous = get()
    const changedPage =
      previous.accountId !== accountId ||
      previous.scope === null ||
      scope === null ||
      JSON.stringify(previous.scope) !== JSON.stringify(scope)
    if (!accountId || view.kind === "settings") {
      set({
        accountId,
        view,
        scope,
        threads: [],
        drafts: [],
        labelsByThreadId: {},
        userLabels: [],
        loading: false,
        loaded: true,
        selectedIds: new Set<string>(),
        selectionAnchor: null,
        sort: DEFAULT_THREAD_SORT,
      })
      return
    }
    // resolveScope is total for a non-null account; this guard narrows the
    // type for the query below (and backstops the invariant at runtime).
    if (scope === null) return
    set({ loading: true })
    // The page the response must still belong to when each await settles —
    // later loads are dropped otherwise (staleness guard). The view key
    // plus the raw override (its JSON) is the page identity: a scope
    // switch (unified → split) changes neither the view nor the account.
    // Across-accounts scopes additionally pin the active-account SET they
    // were loaded against (JSON below, set once listActiveAccounts ran) —
    // a deactivation/deletion mid-refresh makes the in-flight page stale.
    let activeAccountSet: string | null = null
    const isStale = (freshActiveAccountIds?: string[]) => {
      const ui = useUiStore.getState()
      if (useAccountStore.getState().activeAccountId !== accountId) return true
      if (viewKey(ui.view) !== viewKey(view)) return true
      if (JSON.stringify(ui.listScope ?? null) !== JSON.stringify(override)) {
        return true
      }
      if (activeAccountSet !== null && freshActiveAccountIds !== undefined) {
        if (JSON.stringify(freshActiveAccountIds) !== activeAccountSet) {
          return true
        }
      }
      return false
    }
    try {
      const executor = resolveExecutor()
      // One lazy settings read for the whole session; the scope's own
      // entry (or the default) is resolved from the map on every refresh,
      // so view switches re-resolve the sort without extra queries.
      sortMapCache ??= await getThreadSorts(executor)
      const sort = sortMapCache[scopeSortKey(scope)] ?? DEFAULT_THREAD_SORT
      if (isStale()) return
      set({ sort })
      // The active-account set feeds the across-accounts scopes (unified,
      // un-pinned splits, saved searches); re-read on every refresh so a
      // newly activated/deactivated account is picked up on the next pass.
      let activeAccountIds: string[] = []
      if (scopeNeedsActiveAccounts(scope)) {
        activeAccountIds = (await listActiveAccounts(executor)).map(
          (row) => row.id
        )
        activeAccountSet = JSON.stringify(activeAccountIds)
        if (isStale()) return
      }
      const threads = await queryThreads(
        executor,
        scope,
        sort,
        activeAccountIds
      )
      // Drop the response if the page changed while it ran.
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
      const drafts =
        isDraftsView(view) && override === null
          ? await listDrafts(executor, accountId)
          : []
      if (isStale()) return
      // The account set can change while the queries ran (an account
      // removed or flipped auth-error mid-refresh): re-read it and drop
      // the page when it no longer matches what the rows were loaded
      // against — ghost rows from a deactivated/deleted account must not
      // land, and nothing here re-refreshes (the flow that changed the
      // set triggers its own refresh). Account-pinned scopes skip this.
      if (activeAccountSet !== null) {
        const freshIds = (await listActiveAccounts(executor)).map(
          (row) => row.id
        )
        if (isStale(freshIds)) return
      }
      set({
        accountId,
        view,
        scope,
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
      // The reading pane's cursor (ui-store.activeThread) follows the list:
      // when the thread LEFT the loaded page — it was among the previous
      // refresh's rows and the new page no longer contains it (a view/
      // scope switch landed a different folder's mail, an action or a
      // state change removed the row) — clear it so the pane does not keep
      // a thread the list dropped. Threads the list never showed (opened
      // from the Todos section, Contacts browser or a cold standalone
      // reading pane) are not the list's to clear.
      const activeThread = useUiStore.getState().activeThread
      if (
        activeThread !== null &&
        previous.threads.some((thread) => thread.id === activeThread) &&
        !threads.some((thread) => thread.id === activeThread) &&
        !drafts.some((draft) => draft.id === activeThread)
      ) {
        useUiStore.getState().setActiveThread(null)
      }
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
 * view, the list-scope override (ui-store) or the active account changes.
 */
export function useThreadList(): UseThreadListResult {
  const view = useUiStore((state) => state.view)
  const listScope = useUiStore((state) => state.listScope)
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  const refresh = useThreadListStore((state) => state.refresh)

  useEffect(() => {
    void refresh()
  }, [view, listScope, activeAccountId, refresh])

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
