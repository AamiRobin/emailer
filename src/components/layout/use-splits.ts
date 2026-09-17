import { useEffect, useState } from "react"
import { toast } from "sonner"

import { listActiveAccounts } from "@/services/db/accounts"
import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import { countThreadsForQuery } from "@/services/search"
import {
  createSplit,
  deleteSplit,
  listSplits,
  moveSplit,
  setSplitHidden,
  type SplitConfig,
} from "@/services/settings/splits"
import {
  refreshThreadList,
  useThreadListStore,
} from "@/stores/thread-list-store"
import { useUiStore } from "@/stores/ui-store"

/**
 * Splits tab-bar data plumbing (task 9.3) — the use-saved-searches.ts
 * pattern: an injectable SqlExecutor for tests plus a module-level notify
 * seam. The component lives in splits-tab-bar.tsx.
 *
 * Every mutation flow funnels through here so the settings-row write, the
 * notify and the scope bookkeeping stay in lockstep:
 * - createSplitWithToast (the tab bar's "+" dialog and the results view's
 *   "Save as Split" affordance): create + toast + notify, optionally
 *   entering the new split right away.
 * - enterSplit / leaveSplit (tab clicks): set/clear the ui-store
 *   list-scope override (design D4's task 9.1 machinery) plus an explicit
 *   refreshThreadList, so the list is current even when no ThreadList
 *   instance is mounted to react to the scope change.
 * - moveSplitById / setSplitHiddenById / deleteSplitById (the per-tab
 *   menu): reorder/hide/delete; deleting or hiding the ACTIVE split tab
 *   also leaves the scope (the list would otherwise keep showing a query
 *   with no tab).
 *
 * Splits are local config (one `mail.splits` settings row — see
 * services/settings/splits.ts), so the hook needs no account id; it
 * reloads on mount and on notifySplitsChanged().
 */

let sectionExecutorOverride: SqlExecutor | null = null

function resolveExecutor(): SqlExecutor {
  return sectionExecutorOverride ?? getExecutor()
}

/** Test hook: run the tab bar's queries against `executor` (node:sqlite
 * under vitest); pass null to restore the production getExecutor()
 * binding. */
export function setSplitsSectionExecutor(executor: SqlExecutor | null): void {
  sectionExecutorOverride = executor
}

// ---- Refresh seam: the create/move/hide/delete flows notify subscribers
// after their mutation so the tab bar (list + counts) re-reads the row. ----

const splitsChangedListeners = new Set<() => void>()

/** Tell useSplits subscribers to re-read the splits row. */
export function notifySplitsChanged(): void {
  for (const listener of splitsChangedListeners) listener()
}

/** The ui-store list-scope override a split tab stands for (the optional
 * account pin rides along; omitting it means across the active accounts). */
function splitScope(split: SplitConfig): {
  kind: "split"
  name: string
  query: string
  accountId?: string
} {
  return {
    kind: "split",
    name: split.name,
    query: split.query,
    ...(split.accountId ? { accountId: split.accountId } : {}),
  }
}

/** Enter a split (tab click): set the ui-store list-scope override and
 * refresh — the same sequence runSavedSearch uses for saved searches. */
export async function enterSplit(split: SplitConfig): Promise<void> {
  useUiStore.getState().setListScope(splitScope(split))
  await refreshThreadList()
}

/** Leave the active split (clicking the active tab again): back to the
 * underlying view selection, explicitly refreshed. */
export async function leaveSplit(): Promise<void> {
  useUiStore.getState().setListScope(null)
  await refreshThreadList()
}

/** If the named split owns the active scope, leave it — the delete/hide
 * flows call this so the thread list stops showing a scope with no tab. */
function leaveIfActiveSplit(name: string): void {
  const scope = useUiStore.getState().listScope
  if (scope?.kind === "split" && scope.name === name) {
    useUiStore.getState().setListScope(null)
    void refreshThreadList()
  }
}

/** Outcome of createSplitWithToast: the typed CRUD result for invalid or
 * duplicate names (the dialogs render a form error), or a write failure. */
export type SplitCreateOutcome =
  | { ok: true; split: SplitConfig }
  | { ok: false; error: "name-required" | "name-taken" | "failed" }

/**
 * Create a split (both create dialogs) and notify the tab bar. With
 * `enter`, the new split becomes the active scope right away — the
 * "Save as Split" flow. Duplicate names come back as { ok: false,
 * error: "name-taken" } WITHOUT a toast, so the dialog can point at the
 * field; unexpected write failures toast once here.
 */
export async function createSplitWithToast(input: {
  name: string
  query: string
  accountId?: string | null
  enter?: boolean
}): Promise<SplitCreateOutcome> {
  let result
  try {
    result = await createSplit(resolveExecutor(), {
      name: input.name,
      query: input.query,
      accountId: input.accountId,
    })
  } catch (error) {
    console.warn("[splits] create failed", error)
    toast.error("Could not create the split.")
    return { ok: false, error: "failed" }
  }
  if (!result.ok) return result
  toast.success(`Split “${result.split.name}” created`)
  notifySplitsChanged()
  if (input.enter) await enterSplit(result.split)
  return result
}

/** Move a split left/right (the tab's menu) and notify the bar. */
export async function moveSplitById(
  splitId: string,
  offset: -1 | 1
): Promise<void> {
  try {
    await moveSplit(resolveExecutor(), splitId, offset)
  } catch (error) {
    console.warn("[splits] move failed", error)
    return
  }
  notifySplitsChanged()
}

/** Hide or unhide a split (the tab's menu / the manage dialog) and notify
 * the bar; hiding the ACTIVE split also leaves its scope. */
export async function setSplitHiddenById(
  splitId: string,
  hidden: boolean
): Promise<void> {
  try {
    const splits = await listSplits(resolveExecutor())
    const target = splits.find((split) => split.id === splitId)
    await setSplitHidden(resolveExecutor(), splitId, hidden)
    if (target && hidden) leaveIfActiveSplit(target.name)
  } catch (error) {
    console.warn("[splits] hide failed", error)
    return
  }
  notifySplitsChanged()
}

/** Delete a split (the tab's menu / the manage dialog) and notify the
 * bar; local-only — the underlying messages are unaffected. Deleting the
 * ACTIVE split also leaves its scope. */
export async function deleteSplitById(splitId: string): Promise<void> {
  try {
    const splits = await listSplits(resolveExecutor())
    const target = splits.find((split) => split.id === splitId)
    await deleteSplit(resolveExecutor(), splitId)
    if (target) leaveIfActiveSplit(target.name)
  } catch (error) {
    console.warn("[splits] delete failed", error)
    return
  }
  notifySplitsChanged()
}

/** All splits in tab order (hidden ones included — the bar filters);
 * DB failures render no tabs. Reloads on mount and on
 * notifySplitsChanged() (the create/move/hide/delete flows). */
export function useSplits(): SplitConfig[] {
  const [splits, setSplits] = useState<SplitConfig[]>([])
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const invalidate = (): void => setRevision((value) => value + 1)
    splitsChangedListeners.add(invalidate)
    return () => {
      splitsChangedListeners.delete(invalidate)
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    // The promise hop keeps the load (and the no-DB fallback —
    // resolveExecutor() throws outside Tauri) out of the effect body.
    Promise.resolve()
      .then(() => listSplits(resolveExecutor()))
      .then((rows) => {
        if (!cancelled) setSplits(rows)
      })
      .catch((error) => {
        console.warn("[splits] failed to load splits", error)
        if (!cancelled) setSplits([])
      })
    return () => {
      cancelled = true
    }
  }, [revision])
  return splits
}

/**
 * Per-tab thread counts, keyed by split id (task 9.3): one
 * countThreadsForQuery per visible split — the split's own account when
 * pinned, the ACTIVE accounts otherwise, exactly the account set the
 * thread-list scope would run. Recomputed on mount, on
 * notifySplitsChanged(), whenever the visible split set changes, and on
 * every thread-list reload: the list store is a cache re-filled by
 * refreshThreadList() after sync completion and thread actions, and its
 * new rows identity is the cheapest "mail changed" signal available.
 */
export function useSplitCounts(splits: SplitConfig[]): Record<string, number> {
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const invalidate = (): void => setRevision((value) => value + 1)
    splitsChangedListeners.add(invalidate)
    return () => {
      splitsChangedListeners.delete(invalidate)
    }
  }, [])

  useEffect(
    () =>
      useThreadListStore.subscribe((state, previous) => {
        if (state.threads !== previous.threads) {
          setRevision((value) => value + 1)
        }
      }),
    []
  )

  useEffect(() => {
    const visible = splits.filter((split) => !split.hidden)
    let cancelled = false
    Promise.resolve()
      .then(async () => {
        if (!visible.length) return {}
        const executor = resolveExecutor()
        const activeIds = (await listActiveAccounts(executor)).map(
          (row) => row.id
        )
        const entries = await Promise.all(
          visible.map(async (split) => {
            try {
              const count = await countThreadsForQuery(
                executor,
                split.accountId ? [split.accountId] : activeIds,
                split.query
              )
              return [split.id, count] as const
            } catch (error) {
              console.warn("[splits] count failed", error)
              return [split.id, 0] as const
            }
          })
        )
        return Object.fromEntries(entries)
      })
      .then((next) => {
        if (!cancelled && next) setCounts(next)
      })
      .catch((error) => {
        console.warn("[splits] failed to load split counts", error)
        if (!cancelled) setCounts({})
      })
    return () => {
      cancelled = true
    }
  }, [splits, revision])

  return counts
}
