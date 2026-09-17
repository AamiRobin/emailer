import type { SqlExecutor } from "@/services/db/executor"
import { getSetting, setSetting } from "@/services/db/settings"

/**
 * Splits (task 9.3, design D4): named operator-query tabs above the inbox.
 * There is NO splits table — splits are local config persisted as ONE JSON
 * row in the settings table under `mail.splits`, exactly like the
 * per-scope thread sorts (`mail.threadSorts`) in preferences.ts. The row
 * holds an array of SplitConfig; `position` is the tab order (kept dense
 * 0…n-1 on every write), `accountId` pins the split to one account
 * (null/omitted = across the active accounts, the same semantics the
 * thread-list store's `split` scope gives the descriptor), and `hidden`
 * removes a tab from the bar without deleting it (unhide via the manage
 * dialog).
 *
 * Every mutation reads the whole array and writes it back (the caller
 * pattern of setThreadSorts — "one row, the service owns merging"), so no
 * read-modify-write races within a user action matter.
 *
 * Names are unique among splits (case-insensitive) — the tab bar matches
 * the active split by name (thread-list scope keys are `split:<name>`),
 * so duplicates would be unselectable. Violations come back as a typed
 * result the dialogs render as a form error (the snippets-section
 * pattern), not an exception.
 */

export const SPLITS_SETTING_KEY = "mail.splits"

export interface SplitConfig {
  id: string
  name: string
  /** The stored operator query, run through the regular search pipeline. */
  query: string
  /** Pin to one account; null/omitted = across the active accounts. */
  accountId?: string | null
  /** Hidden tabs drop out of the bar but stay manageable (unhide). */
  hidden?: boolean
  position: number
}

/** Result of the name-bearing mutations (create/rename). */
export type SplitNameResult =
  | { ok: true; split: SplitConfig }
  | { ok: false; error: "name-required" | "name-taken" }

/** Structural guard for a stored entry — a hand-edited or older-build row
 * must never crash the tab bar; invalid entries are dropped on read. */
function isSplitConfig(value: unknown): value is SplitConfig {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    typeof entry.query === "string" &&
    typeof entry.position === "number" &&
    Number.isFinite(entry.position)
  )
}

/** All splits in tab order. Corrupt stored shapes are dropped, never
 * thrown; a missing or unparseable row means "no splits yet". */
export async function listSplits(
  executor: SqlExecutor
): Promise<SplitConfig[]> {
  const stored = await getSetting<unknown>(executor, SPLITS_SETTING_KEY, [])
  if (!Array.isArray(stored)) return []
  return stored
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => isSplitConfig(entry))
    .sort((a, b) => a.entry.position - b.entry.position || a.index - b.index)
    .map(({ entry }) => entry)
}

/** Persist the whole array with dense positions (internal). */
async function persistSplits(
  executor: SqlExecutor,
  splits: SplitConfig[]
): Promise<void> {
  await setSetting(
    executor,
    SPLITS_SETTING_KEY,
    splits.map((split, position) => ({ ...split, position }))
  )
}

/**
 * Create a split appended at the end of the tab order. The name is
 * trimmed, required, and unique among ALL splits (hidden included —
 * unhiding must not produce a duplicate); the query is stored as typed
 * (the search pipeline handles any string, empty included).
 */
export async function createSplit(
  executor: SqlExecutor,
  input: {
    name: string
    query: string
    accountId?: string | null
  }
): Promise<SplitNameResult> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: "name-required" }
  const splits = await listSplits(executor)
  if (splits.some((split) => split.name.toLowerCase() === name.toLowerCase())) {
    return { ok: false, error: "name-taken" }
  }
  const split: SplitConfig = {
    id: crypto.randomUUID(),
    name,
    query: input.query,
    ...(input.accountId ? { accountId: input.accountId } : {}),
    position: splits.length,
  }
  await persistSplits(executor, [...splits, split])
  return { ok: true, split }
}

/** Rename a split in place (order and query unchanged); the same
 * uniqueness rules as createSplit apply, excluding the split itself. */
export async function renameSplit(
  executor: SqlExecutor,
  splitId: string,
  name: string
): Promise<SplitNameResult> {
  const trimmed = name.trim()
  if (!trimmed) return { ok: false, error: "name-required" }
  const splits = await listSplits(executor)
  const target = splits.find((split) => split.id === splitId)
  if (!target) return { ok: false, error: "name-required" }
  if (
    splits.some(
      (split) =>
        split.id !== splitId &&
        split.name.toLowerCase() === trimmed.toLowerCase()
    )
  ) {
    return { ok: false, error: "name-taken" }
  }
  const next = splits.map((split) =>
    split.id === splitId ? { ...split, name: trimmed } : split
  )
  await persistSplits(executor, next)
  const updated = next.find((split) => split.id === splitId)
  return updated
    ? { ok: true, split: updated }
    : { ok: false, error: "name-required" }
}

/** Delete a split (no-op when the id is unknown). Mail is untouched —
 * splits are queries, not folders. */
export async function deleteSplit(
  executor: SqlExecutor,
  splitId: string
): Promise<void> {
  const splits = await listSplits(executor)
  await persistSplits(
    executor,
    splits.filter((split) => split.id !== splitId)
  )
}

/** Hide or unhide a split (no-op when the id is unknown). */
export async function setSplitHidden(
  executor: SqlExecutor,
  splitId: string,
  hidden: boolean
): Promise<void> {
  const splits = await listSplits(executor)
  await persistSplits(
    executor,
    splits.map((split) => (split.id === splitId ? { ...split, hidden } : split))
  )
}

/**
 * Move a split `offset` tabs left (-1) or right (+1) within the VISIBLE
 * tab order — hidden neighbours are skipped, so the action always does
 * what the bar shows. Already at the edge (or hidden itself): a no-op.
 */
export async function moveSplit(
  executor: SqlExecutor,
  splitId: string,
  offset: -1 | 1
): Promise<void> {
  const splits = await listSplits(executor)
  const visibleIndices = splits.flatMap((split, index) =>
    split.hidden ? [] : [index]
  )
  const from = splits.findIndex((split) => split.id === splitId)
  if (from === -1 || splits[from]!.hidden) return
  const visibleIndex = visibleIndices.indexOf(from)
  const to = visibleIndex + offset
  if (to < 0 || to >= visibleIndices.length) return
  const neighbour = visibleIndices[to]!
  ;[splits[from], splits[neighbour]] = [splits[neighbour]!, splits[from]!]
  await persistSplits(executor, splits)
}
