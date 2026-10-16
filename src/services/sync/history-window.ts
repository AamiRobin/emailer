import type { SqlExecutor } from "../db/executor"
import { getSetting, setSetting } from "../db/settings"

/**
 * Mail history download window (parity-round-3 task 3.x, design D6): the
 * per-account FIRST-sync download boundary. The value is the stored
 * `accounts.history_window` TEXT grammar — "1m" / "3m" / "6m" / "1y" or
 * NULL (= all history; every account created before the setting, and the
 * default for new ones). The sync layer owns the value grammar so new
 * windows never need another migration (the v20 column comment).
 *
 * The boundary is download-only: it clamps each driver's initial pass
 * (IMAP page-down, Gmail `after:` query, Graph `receivedDateTime` filter)
 * and is never re-applied to delta sync. A message counts as IN the window
 * when its date is at or after the boundary; the boundary itself is
 * midnight UTC of the day exactly N months (or one year) before `now`, so
 * the value is stable within a sync pass and readable in provider queries.
 */

/** The bounded windows a user can pick; null (= All) is not in the list. */
export type HistoryWindow = "1m" | "3m" | "6m" | "1y"

/** The stored setting: a bounded window or null (= all history). */
export type HistoryWindowSetting = HistoryWindow | null

export const HISTORY_WINDOWS: readonly HistoryWindow[] = [
  "1m",
  "3m",
  "6m",
  "1y",
]

/**
 * Coerce a stored TEXT value into the setting grammar. Anything but the
 * four known tokens (including an empty string) reads as null — a corrupt
 * row degrades to the unbounded default, never to a sync failure.
 */
export function parseHistoryWindow(
  value: string | null | undefined
): HistoryWindowSetting {
  return value === "1m" || value === "3m" || value === "6m" || value === "1y"
    ? value
    : null
}

/** Rough month ordering (1m < 3m < 6m < 1y < null) — 0 is the narrowest. */
function windowRank(window: HistoryWindowSetting): number {
  switch (window) {
    case "1m":
      return 1
    case "3m":
      return 2
    case "6m":
      return 3
    case "1y":
      return 4
    case null:
      return 5
  }
}

/** True when `next` covers strictly more history than `current`. */
export function windowIsWider(
  current: HistoryWindowSetting,
  next: HistoryWindowSetting
): boolean {
  return windowRank(next) > windowRank(current)
}

/**
 * The boundary as unix epoch seconds: messages with `date < boundary` sit
 * outside the window. Null for the unbounded setting (no clamp). The
 * boundary is the start of the UTC day exactly N months (or one calendar
 * year) before `nowSeconds` — day-granular so provider-side date filters
 * (`after:`, `receivedDateTime ge`, IMAP SINCE semantics) match the
 * engine-side second filter exactly.
 */
export function historyWindowBoundary(
  window: HistoryWindowSetting,
  nowSeconds: number
): number | null {
  if (window === null) return null
  const months =
    window === "1y" ? 12 : window === "6m" ? 6 : window === "3m" ? 3 : 1
  const now = new Date(nowSeconds * 1000)
  // Day-granular: pin to UTC midnight of the current day first, then step
  // back. setUTCMonth normalizes overflow (May 31 → Mar 3 for -2) — the
  // exact-day edge is accepted drift for a download boundary.
  const boundary = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  )
  boundary.setUTCMonth(boundary.getUTCMonth() - months)
  return Math.floor(boundary.getTime() / 1000)
}

/**
 * Keep only the in-window messages (`date >= boundary`) — the engine-side
 * half of every clamp. Applied after the provider call even when the
 * provider clamped server-side: it guards date drift between the provider
 * grammar and the stored dates, and it IS the whole clamp for the IMAP
 * page-down (the Rust fetch seam has no SINCE parameter).
 */
export function clampToWindow<T extends { date: number }>(
  messages: T[],
  boundary: number | null
): T[] {
  if (boundary === null) return messages
  return messages.filter((message) => message.date >= boundary)
}

/** All pages older than this are done: every message predates `boundary`. */
export function pageIsEntirelyOutOfWindow(
  messages: { date: number }[],
  boundary: number | null
): boolean {
  if (boundary === null) return false
  return messages.every((message) => message.date < boundary)
}

/**
 * A widening backfill's target: the half-open date range [since, until)
 * in unix seconds — the history the narrower window skipped. `until`
 * null = open-ended down to the beginning of history (widening to All).
 * The queue op payload freezes both values at enqueue time so a
 * restart/retry replays the exact promised range.
 */
export interface HistoryBackfillRange {
  since: number
  until: number | null
}

/** Keep only the messages inside a backfill range [since, until). */
export function clampToRange<T extends { date: number }>(
  messages: T[],
  range: HistoryBackfillRange
): T[] {
  return messages.filter(
    (message) =>
      message.date >= range.since &&
      (range.until === null || message.date < range.until)
  )
}

// ---------------------------------------------------------------------------
// Bounded-first-sync state (the 3.4 indicator's persistence)
// ---------------------------------------------------------------------------

/**
 * Per-account flags in the `settings` table (JSON values, keyed per
 * account — the same table the other account-scoped toggles use). The
 * bounded flag is set by each engine after a bounded initial pass actually
 * ran for the account; the dismissed flag is the notice's user dismissal.
 * Neither is a column on `accounts` on purpose: they are UI-state-shaped,
 * derivable, and must not widen the account schema.
 */
export function boundedFirstSyncKey(accountId: string): string {
  return `historyWindow.bounded.${accountId}`
}

export function boundedNoticeDismissedKey(accountId: string): string {
  return `historyWindow.dismissed.${accountId}`
}

export async function markBoundedFirstSync(
  executor: SqlExecutor,
  accountId: string
): Promise<void> {
  await setSetting(executor, boundedFirstSyncKey(accountId), true)
}

export async function isBoundedFirstSync(
  executor: SqlExecutor,
  accountId: string
): Promise<boolean> {
  return getSetting<boolean>(executor, boundedFirstSyncKey(accountId), false)
}

export async function dismissBoundedFirstSyncNotice(
  executor: SqlExecutor,
  accountId: string
): Promise<void> {
  await setSetting(executor, boundedNoticeDismissedKey(accountId), true)
}

export async function isBoundedNoticeDismissed(
  executor: SqlExecutor,
  accountId: string
): Promise<boolean> {
  return getSetting<boolean>(
    executor,
    boundedNoticeDismissedKey(accountId),
    false
  )
}

// ---------------------------------------------------------------------------
// Human labels (display data — domain-adjacent, so component files that
// only render can import without exporting anything themselves)
// ---------------------------------------------------------------------------

/** Select values are strings; "all" is the sentinel for the null setting. */
export const ALL_HISTORY_VALUE = "all"

/** The picker's items — value → human label, shared by every window pick. */
export const WINDOW_ITEM_LABELS: Record<
  HistoryWindow | typeof ALL_HISTORY_VALUE,
  string
> = {
  "1m": "Last month",
  "3m": "Last 3 months",
  "6m": "Last 6 months",
  "1y": "Last year",
  all: "All history",
}

/** Human label for a stored setting (accounts row, confirm dialogs). */
export function historyWindowLabel(window: HistoryWindowSetting): string {
  return window === null
    ? WINDOW_ITEM_LABELS[ALL_HISTORY_VALUE]
    : WINDOW_ITEM_LABELS[window]
}
