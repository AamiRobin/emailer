import type { SqlExecutor } from "@/services/db/executor"
import { getSetting, setSetting } from "@/services/db/settings"

/**
 * Semantic-search settings (parity-round-3 design D1, task 6.5) — one
 * JSON row in the settings table under `ai.semanticSearch`, the same
 * single-row pattern as `ai.config` (services/ai/settings.ts) and
 * `notifications.enabled`. Deliberately its own row, NOT a field on the
 * AI config envelope: the semantic index is a LOCAL feature (its model
 * and vectors never leave the machine) and its lifecycle (download,
 * index, disable) must be independent of the provider configuration —
 * toggling it must never rewrite the provider row.
 *
 * Fail toward off (every other settings reader's rule): an absent,
 * corrupt or wrong-shape row reads as disabled, so the pipeline never
 * runs and the model never downloads until the user explicitly enables
 * the feature (spec "Enablement and download").
 */

/** The one settings-table row owned by this module. */
export const SEMANTIC_SEARCH_SETTING_KEY = "ai.semanticSearch"

/** The stored row shape. */
export interface SemanticSearchSettings {
  enabled: boolean
}

const DEFAULT_SETTINGS: SemanticSearchSettings = { enabled: false }

/** Read + validate the stored row; every malformed shape reads as off. */
export async function getSemanticSearchSettings(
  executor: SqlExecutor
): Promise<SemanticSearchSettings> {
  const stored = await getSetting<unknown>(
    executor,
    SEMANTIC_SEARCH_SETTING_KEY,
    DEFAULT_SETTINGS
  )
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
    return { ...DEFAULT_SETTINGS }
  }
  const row = stored as Record<string, unknown>
  return { enabled: row.enabled === true }
}

/** Whether the semantic index feature is enabled (default: no). */
export async function isSemanticSearchEnabled(
  executor: SqlExecutor
): Promise<boolean> {
  return (await getSemanticSearchSettings(executor)).enabled
}

/** Persist the enable flag (the settings section's toggle). Toggling
 * OFF leaves the model files and the stored vectors in place — the next
 * enable resumes indexing from the content hashes instead of paying for
 * a full re-embed (task 6.2's incremental contract). */
export async function setSemanticSearchEnabled(
  executor: SqlExecutor,
  enabled: boolean
): Promise<void> {
  await setSetting(executor, SEMANTIC_SEARCH_SETTING_KEY, { enabled })
}
