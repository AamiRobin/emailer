import { useEffect, useState } from "react"

import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import type { LabelRow } from "@/services/db/labels"
import { listLabelsByAccount } from "@/services/db/labels"

/**
 * Sidebar data plumbing (task 6.3): the active account's user labels plus
 * the "/"-hierarchy presentation model. Folder counts live on the
 * folder-counts store; this module only handles the label list.
 *
 * Queries go through an injectable SqlExecutor that defaults to
 * getExecutor(); tests pass a node:sqlite executor via
 * setSidebarDataExecutor() (same override pattern as account-store /
 * folder-counts-store — tauri-plugin-sql cannot run under vitest).
 */

let dataExecutorOverride: SqlExecutor | null = null

function resolveDataExecutor(): SqlExecutor {
  return dataExecutorOverride ?? getExecutor()
}

/** Test hook: run the sidebar's label queries against `executor`
 * (node:sqlite under vitest); pass null to restore the production
 * getExecutor() binding. */
export function setSidebarDataExecutor(executor: SqlExecutor | null): void {
  dataExecutorOverride = executor
}

// ---- Refresh seam (task 10.4): the label CRUD flows notify subscribers
// after a local-first mutation so the list reloads from SQLite. ----

const labelsChangedListeners = new Set<() => void>()

/** Tell useUserLabels subscribers to re-query the labels table. Called by
 * the label dialogs after createUserLabel/renameUserLabel/recolorUserLabel/
 * deleteUserLabel applied their local changes. */
export function notifyUserLabelsChanged(): void {
  for (const listener of labelsChangedListeners) listener()
}

export interface LabelNode {
  label: LabelRow
  /** "/" segments above this label — 0 renders at the sidebar's edge. */
  depth: number
  /** Last path segment ("Invoices" for "Work/Invoices"). */
  display: string
}

/** Spacer widths per hierarchy depth (clamped past 4 levels); a spacer
 * span keeps the row button untouched so buttonVariants padding never
 * fights a utility override. */
export const DEPTH_SPACERS = ["w-0", "w-3", "w-6", "w-9", "w-12"]

/**
 * Order labels so a parent always precedes its children: segment-wise
 * comparison sorts "Work" before "Work/Invoices" regardless of what other
 * names share the prefix. Each row stays the full-name label (the
 * hierarchy is purely presentational, per the mail-organization spec).
 */
export function buildLabelHierarchy(labels: LabelRow[]): LabelNode[] {
  const segmentsOf = (label: LabelRow) => label.name.split("/")
  const sorted = [...labels].sort((a, b) => {
    const aSegments = segmentsOf(a)
    const bSegments = segmentsOf(b)
    const shared = Math.min(aSegments.length, bSegments.length)
    for (let index = 0; index < shared; index += 1) {
      const bySegment = aSegments[index].localeCompare(bSegments[index])
      if (bySegment !== 0) return bySegment
    }
    return aSegments.length - bSegments.length
  })
  return sorted.map((label) => {
    const segments = segmentsOf(label)
    return {
      label,
      depth: segments.length - 1,
      display: segments[segments.length - 1] ?? label.name,
    }
  })
}

/** User labels of the active account; DB failures render an empty list.
 * The loaded account travels with the rows so a switch renders [] for the
 * new account without a synchronous setState inside the effect. Reloads
 * on account switches and on notifyUserLabelsChanged() (task 10.4 CRUD
 * flows). */
export function useUserLabels(activeAccountId: string | null): LabelRow[] {
  const [loaded, setLoaded] = useState<{
    accountId: string | null
    labels: LabelRow[]
  }>({ accountId: null, labels: [] })
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const invalidate = (): void => setRevision((value) => value + 1)
    labelsChangedListeners.add(invalidate)
    return () => {
      labelsChangedListeners.delete(invalidate)
    }
  }, [])
  useEffect(() => {
    if (!activeAccountId) return
    let cancelled = false
    listLabelsByAccount(resolveDataExecutor(), activeAccountId)
      .then((rows) => {
        if (!cancelled) {
          setLoaded({
            accountId: activeAccountId,
            labels: rows.filter((row) => row.type === "user"),
          })
        }
      })
      .catch((error) => {
        console.warn("[sidebar] failed to load labels", error)
        if (!cancelled) {
          setLoaded({ accountId: activeAccountId, labels: [] })
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeAccountId, revision])
  return loaded.accountId === activeAccountId ? loaded.labels : []
}
