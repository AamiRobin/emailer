import { useEffect, useState } from "react"

import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import { listQuickSteps } from "@/services/settings/quick-steps"
import type { QuickStep } from "@/services/settings/quick-steps"

/**
 * Quick-step data for the command palette (task 3.2): the user's steps
 * re-read every time the palette OPENS, so a settings edit applies to
 * the next open (the same freshness rule the per-keyboard-digit path
 * follows — settings changes apply to subsequent runs everywhere).
 * Account-agnostic by design: the entries run against the current
 * selection or the active thread, whatever accounts own it.
 *
 * Same loader contract as usePaletteLabels (self-contained, executor
 * injectable for tests via setPaletteQuickStepsExecutor — the same
 * override pattern as account-store / folder-counts-store, since
 * tauri-plugin-sql cannot run under vitest).
 */

let quickStepsExecutorOverride: SqlExecutor | null = null

function resolveQuickStepsExecutor(): SqlExecutor {
  return quickStepsExecutorOverride ?? getExecutor()
}

/** Test hook: run the palette's quick-step queries against `executor`
 * (node:sqlite under vitest); pass null to restore the production
 * getExecutor() binding. */
export function setPaletteQuickStepsExecutor(
  executor: SqlExecutor | null
): void {
  quickStepsExecutorOverride = executor
}

/** All quick steps in manage order, re-read on every palette open; a DB
 * failure renders no group (the palette keeps its other entries). */
export function usePaletteQuickSteps(open: boolean): QuickStep[] {
  const [steps, setSteps] = useState<QuickStep[]>([])
  useEffect(() => {
    if (!open) return
    let cancelled = false
    // The read runs one microtask later, so a synchronous failure (the
    // executor unavailable outside bootstrap) lands in the same catch as
    // an async one and the effect body itself stays setState-free.
    Promise.resolve()
      .then(() => listQuickSteps(resolveQuickStepsExecutor()))
      .then((loaded) => {
        if (!cancelled) setSteps(loaded)
      })
      .catch((error) => {
        console.warn("[command-palette] failed to load quick steps", error)
        if (!cancelled) setSteps([])
      })
    return () => {
      cancelled = true
    }
  }, [open])
  return steps
}
