import { useEffect, useState } from "react"

import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import type { LabelRow } from "@/services/db/labels"
import { listLabelsByAccount } from "@/services/db/labels"

/**
 * Label data for the command palette (task 6.7): the active account's
 * user labels as full-name rows ("Work/Invoices", hierarchy included in
 * the name). Same loader contract as the sidebar's useUserLabels
 * (src/components/layout/use-sidebar-data.ts) but kept self-contained so
 * the palette does not depend on layout internals.
 *
 * Queries go through an injectable SqlExecutor that defaults to
 * getExecutor(); tests pass a node:sqlite executor via
 * setPaletteLabelsExecutor() (same override pattern as account-store /
 * folder-counts-store — tauri-plugin-sql cannot run under vitest).
 */

let labelExecutorOverride: SqlExecutor | null = null

function resolveLabelExecutor(): SqlExecutor {
  return labelExecutorOverride ?? getExecutor()
}

/** Test hook: run the palette's label queries against `executor`
 * (node:sqlite under vitest); pass null to restore the production
 * getExecutor() binding. */
export function setPaletteLabelsExecutor(executor: SqlExecutor | null): void {
  labelExecutorOverride = executor
}

/** User labels of the active account (system/special-use rows filtered
 * out — folders are already listed separately). DB failures render an
 * empty list. The loaded account travels with the rows so an account
 * switch renders [] for the new account without a synchronous setState
 * inside the effect. */
export function usePaletteLabels(activeAccountId: string | null): LabelRow[] {
  const [loaded, setLoaded] = useState<{
    accountId: string | null
    labels: LabelRow[]
  }>({ accountId: null, labels: [] })
  useEffect(() => {
    if (!activeAccountId) return
    let cancelled = false
    listLabelsByAccount(resolveLabelExecutor(), activeAccountId)
      .then((rows) => {
        if (!cancelled) {
          setLoaded({
            accountId: activeAccountId,
            labels: rows.filter((row) => row.type === "user"),
          })
        }
      })
      .catch((error) => {
        console.warn("[command-palette] failed to load labels", error)
        if (!cancelled) {
          setLoaded({ accountId: activeAccountId, labels: [] })
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeAccountId])
  return loaded.accountId === activeAccountId ? loaded.labels : []
}
