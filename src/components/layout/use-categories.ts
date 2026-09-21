import { useEffect, useRef, useState } from "react"
import { useSyncExternalStore } from "react"
import { toast } from "sonner"

import type { Category } from "@/services/categorization/classify"
import { CATEGORIES } from "@/services/categorization/classify"
import {
  cancelCategoryBackfill,
  getCategoryBackfillProgress,
  startCategoryBackfill,
  subscribeCategoryBackfillProgress,
  type CategoryBackfillProgress,
} from "@/services/categorization/backfill"
import { listActiveAccounts } from "@/services/db/accounts"
import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import {
  countThreadsByCategoryAcrossAccounts,
  type CategoryThreadCounts,
} from "@/services/db/threads"
import {
  getCategoriesEnabled,
  setCategoriesEnabled,
} from "@/services/settings/categories"
import { useUiStore } from "@/stores/ui-store"

/**
 * Category tab-bar data plumbing (task 3.5, design D4, mailbox-ui spec
 * "Category tab presentation") — the use-splits.ts pattern: an injectable
 * SqlExecutor for tests plus a module-level notify seam. The tabs live in
 * splits-tab-bar.tsx (categories ordered first); the settings page's
 * Categories section consumes the same hooks.
 *
 * What lives here:
 * - CATEGORY_LABELS: the five display names, in tab order (also the
 *   context-menu and pane-title labels).
 * - useCategoriesEnabled: the `organization.categoriesEnabled` row
 *   (services/settings/categories.ts) as a reactive boolean — re-reads on
 *   notifyCategoriesChanged() (the settings flip) so the tab row and the
 *   context-menu submenus appear/disappear live.
 * - enterCategory / leaveCategory (tab clicks): set/clear the ui-store
 *   list-scope override ({kind:"category", category}) plus an explicit
 *   refreshThreadList — exactly the split tab's enterSplit/leaveSplit
 *   sequence. Any setView or split/unified scope switch replaces the
 *   override, so back control mirrors the splits for free.
 * - setCategoryTabsEnabled: persist + notify; disabling also LEAVES an
 *   active category scope (the list would otherwise show a tab-less
 *   scope — the hide-an-active-split rule).
 * - useCategoryCounts: per-category {total, unread} over the unified-
 *   inbox scope of the ACTIVE accounts — ONE grouped COUNT query
 *   (countThreadsByCategoryAcrossAccounts, NULL ≡ primary). Live via the
 *   same seams as useSplitCounts: notifyCategoriesChanged, the tab bar's
 *   thread-list reload signal (notifyCategoryMailChanged — see the
 *   refresh-seam note), and the backfill's progress events (a backfill
 *   batch re-fills the tabs).
 * - categorizeExistingMail: the backfill launch (fresh start — the
 *   on-demand entry the spec's "back-categorizable on demand" scenario
 *   needs; the bootstrap-registered tick handler drains the rest).
 * - useCategoryBackfillProgress: the backfill job's observable snapshot
 *   via useSyncExternalStore (the module docstring's intended consumer).
 */

/** Tab/display order labels for the five categories (task 3.5). */
export const CATEGORY_LABELS: Record<Category, string> = {
  primary: "Primary",
  updates: "Updates",
  promotions: "Promotions",
  social: "Social",
  newsletters: "Newsletters",
}

let sectionExecutorOverride: SqlExecutor | null = null

function resolveExecutor(): SqlExecutor {
  return sectionExecutorOverride ?? getExecutor()
}

/** Test hook: run the tab bar's queries against `executor` (node:sqlite
 * under vitest); pass null to restore the production getExecutor()
 * binding. */
export function setCategoriesSectionExecutor(
  executor: SqlExecutor | null
): void {
  sectionExecutorOverride = executor
}

/** Executor resolution for the category feature's components (the status
 * surface queries the backfill's remaining count through it). */
export function resolveCategoriesExecutor(): SqlExecutor {
  return resolveExecutor()
}

// ---- List-refresh seam (task 3.5, the design D11 lazy-load guard): the
// settings page statically imports this module (its Categories section),
// and the settings graph must stay free of the thread-list store — the
// store module statically carries the composer drafts feature, whose
// send pipeline reaches crypto/pgp-transform (the pgp-lazy-loading guard
// suite pins exactly this). So this module NEVER imports the list store;
// the tab bar — which owns the store connection anyway — registers
// refreshThreadList here at import time, and every scope flip below
// routes through the registration (a no-op when only the settings
// section is mounted, where no list is showing anyway). ----

type ListRefresh = () => Promise<void>

let listRefresh: ListRefresh | null = null

/** Register the list-refresh implementation (the tab bar's import-time
 * wiring; see the seam note above). Idempotent — both mailbox consumers
 * register the same function. */
export function registerCategoryListRefresh(refresh: ListRefresh): void {
  listRefresh = refresh
}

/** Refresh the thread list through the registered seam. */
export function refreshCategoryList(): Promise<void> {
  return listRefresh ? listRefresh() : Promise.resolve()
}

// ---- Mail-changed seam for the counts hook: same shape as the splits
// module's notifySplitsChanged, fed by the tab bar's thread-list store
// subscription (post-action refreshes) so the five tab badges stay live
// without this module touching the store. ----

const listChangedListeners = new Set<() => void>()

/** Tell useCategoryCounts subscribers that the loaded mail changed. */
export function notifyCategoryMailChanged(): void {
  for (const listener of listChangedListeners) listener()
}

function subscribeListChanged(listener: () => void): () => void {
  listChangedListeners.add(listener)
  return () => {
    listChangedListeners.delete(listener)
  }
}

// ---- Refresh seam: the enable/disable flow notifies subscribers so the
// tab row, the counts and the context-menu submenus re-read the setting. ----

const categoriesChangedListeners = new Set<() => void>()

/** Tell useCategoriesEnabled/useCategoryCounts subscribers to re-read. */
export function notifyCategoriesChanged(): void {
  for (const listener of categoriesChangedListeners) listener()
}

/**
 * Persist the tab row's visibility and notify. Disabling also leaves an
 * active category scope first (mirroring setSplitHiddenById's
 * leave-if-active rule), so the list never shows a scope with no tab; the
 * underlying inbox list is otherwise untouched (the spec's "the inbox
 * list is unaffected").
 */
export async function setCategoryTabsEnabled(enabled: boolean): Promise<void> {
  try {
    await setCategoriesEnabled(resolveExecutor(), enabled)
  } catch (error) {
    console.warn("[categories] persist failed", error)
    return
  }
  if (!enabled) {
    const scope = useUiStore.getState().listScope
    if (scope?.kind === "category") {
      useUiStore.getState().setListScope(null)
      void refreshCategoryList()
    }
  }
  notifyCategoriesChanged()
}

/** Enter a category tab (click): set the ui-store list-scope override and
 * refresh — the same sequence enterSplit runs for split tabs. */
export async function enterCategory(category: Category): Promise<void> {
  useUiStore.getState().setListScope({ kind: "category", category })
  await refreshCategoryList()
}

/** Leave the active category tab (clicking the active tab again): back to
 * the underlying view selection, explicitly refreshed. */
export async function leaveCategory(): Promise<void> {
  useUiStore.getState().setListScope(null)
  await refreshCategoryList()
}

/** The ui-store list-scope override for a category tab click. */
export function categoryScopeActive(category: Category): boolean {
  const scope = useUiStore.getState().listScope
  return scope?.kind === "category" && scope.category === category
}

/**
 * The category tab row's visibility, reactive: loads on mount and re-reads
 * on notifyCategoriesChanged(). DB failures keep the default (off) — the
 * tabs are opt-in, so failing toward off preserves the pre-3.5 bar.
 */
export function useCategoriesEnabled(): boolean {
  const [enabled, setEnabled] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const invalidate = (): void => setRevision((value) => value + 1)
    categoriesChangedListeners.add(invalidate)
    return () => {
      categoriesChangedListeners.delete(invalidate)
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    // The promise hop keeps the load (and the no-DB fallback —
    // resolveExecutor() throws outside Tauri) out of the effect body.
    Promise.resolve()
      .then(() => getCategoriesEnabled(resolveExecutor()))
      .then((value) => {
        if (!cancelled) setEnabled(value)
      })
      .catch((error) => {
        console.warn("[categories] failed to load the setting", error)
        if (!cancelled) setEnabled(false)
      })
    return () => {
      cancelled = true
    }
  }, [revision])
  return enabled
}

const ZERO_COUNTS: Record<Category, CategoryThreadCounts> = {
  primary: { total: 0, unread: 0 },
  updates: { total: 0, unread: 0 },
  promotions: { total: 0, unread: 0 },
  social: { total: 0, unread: 0 },
  newsletters: { total: 0, unread: 0 },
}

/**
 * Per-category {total, unread} counts for the five tabs (task 3.5): one
 * grouped COUNT over the unified-inbox scope of the ACTIVE accounts
 * (exactly the account set the category list scope runs; NULL categories
 * count as Primary). Recomputed on mount, on notifyCategoriesChanged(),
 * on every thread-list reload (the same "mail changed" signal
 * useSplitCounts subscribes to), and on every backfill progress event —
 * a batch of newly categorized mail re-fills the tabs live.
 */
export function useCategoryCounts(): Record<Category, CategoryThreadCounts> {
  const [counts, setCounts] =
    useState<Record<Category, CategoryThreadCounts>>(ZERO_COUNTS)
  const [revision, setRevision] = useState(0)
  const lastBackfillEvent = useRef<CategoryBackfillProgress | null>(null)

  useEffect(() => {
    const invalidate = (): void => setRevision((value) => value + 1)
    categoriesChangedListeners.add(invalidate)
    return () => {
      categoriesChangedListeners.delete(invalidate)
    }
  }, [])

  useEffect(
    () =>
      // Mail changed = the tab bar saw the thread-list store's rows move
      // (the post-action refresh) — the same signal useSplitCounts
      // subscribes to, routed over this module's seam (see the refresh-
      // seam note: no static list-store import here).
      subscribeListChanged(() => {
        setRevision((value) => value + 1)
      }),
    []
  )

  useEffect(
    () =>
      subscribeCategoryBackfillProgress((next) => {
        // The listener carries only the new snapshot; the ref keeps the
        // "did the numbers move" comparison across events.
        const previous = lastBackfillEvent.current
        lastBackfillEvent.current = next
        if (
          previous === null ||
          next.categorized !== previous.categorized ||
          next.done !== previous.done
        ) {
          setRevision((value) => value + 1)
        }
      }),
    []
  )

  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(async () => {
        const executor = resolveExecutor()
        const activeIds = (await listActiveAccounts(executor)).map(
          (row) => row.id
        )
        return countThreadsByCategoryAcrossAccounts(executor, activeIds)
      })
      .then((next) => {
        if (!cancelled) setCounts(next)
      })
      .catch((error) => {
        console.warn("[categories] failed to load category counts", error)
        if (!cancelled) setCounts(ZERO_COUNTS)
      })
    return () => {
      cancelled = true
    }
  }, [revision])

  return counts
}

/**
 * The backfill job's progress as a React value (task 3.5): a
 * useSyncExternalStore over the module's subscribable snapshot — the
 * stable-reference contract getCategoryBackfillProgress documents.
 */
export function useCategoryBackfillProgress(): CategoryBackfillProgress {
  return useSyncExternalStore(
    subscribeCategoryBackfillProgress,
    getCategoryBackfillProgress
  )
}

/**
 * True while a backfill should render as in-flight: the job has done real
 * work (or is mid-slice) and has neither finished nor been cancelled. The
 * between-slices yields (running flips false every batch group, the next
 * 60s tick resumes) keep the line up — only `done`/`cancelled` end it.
 */
export function isBackfillActive(progress: CategoryBackfillProgress): boolean {
  return (
    !progress.done &&
    !progress.cancelled &&
    (progress.running || progress.scanned > 0)
  )
}

/**
 * Launch the back-categorization pass (task 3.5's "Categorize existing
 * mail"): a FRESH start (resets progress, the resume cursor and a previous
 * cancel) whose first slice runs immediately; the bootstrap-registered
 * due-job handler continues the remaining slices on the scheduler ticks.
 * The progress surface (CategoryBackfillStatus) reports and owns the done
 * toast.
 */
export async function categorizeExistingMail(): Promise<void> {
  try {
    await startCategoryBackfill(resolveExecutor(), { fresh: true })
  } catch (error) {
    console.warn("[categories] backfill start failed", error)
    toast.error("Could not start categorizing existing mail.")
  }
}

/** Cancel affordance for the progress surface (delegates to the job). */
export function cancelExistingMailBackfill(): void {
  cancelCategoryBackfill()
}

// Re-exported so consumers (and tests) have one import site for the five-
// category order used by the tabs and the menus.
export { CATEGORIES }
