import { addDays, addWeeks, isBefore, set } from "date-fns"

import type { SqlExecutor } from "../db/executor"
import type { ThreadRow } from "../db/threads"
// Reused (not redefined) so the UI's single not-found catch keeps working;
// snooze.ts must not shadow thread-actions' exports (index.ts star-exports
// both modules).
import { ThreadNotFoundError } from "./thread-actions"

/**
 * Snooze (mail-organization spec): hide a thread from the inbox until a
 * chosen time, then return it to the top of the inbox at that time.
 *
 * Local-only by design — no queue operation is enqueued and no provider is
 * ever contacted; the state lives in threads.snoozed_until and works
 * identically for gmail and imap accounts, online or offline.
 *
 * "Restoring its prior unread state" is implemented WITHOUT touching read
 * state: snooze never mutates unread_count or messages.is_read. Instead,
 * snoozed threads are excluded from the inbox list, the inbox badge and
 * the total unread count at the QUERY level (see the `snoozed_until IS
 * NULL` predicates in db/threads.ts, db/folder-counts.ts and
 * db/accounts.ts), while the thread stays visible in its labels, All Mail
 * and search. Waking therefore inherently restores the prior unread
 * state: the wake-up handler below only clears snoozed_until and stamps
 * delivered_at (which tops the inbox ordering) — the thread reappears
 * exactly as unread/read as it was when it was snoozed.
 *
 * Wake-ups ride the scheduler's due-jobs registry (design D2): bootstrap
 * registers the "snooze.wake" handler below, every 60s tick drains it,
 * and runDueJobsOnce() provides the launch catch-up for wake-ups whose
 * time passed while the app was closed. The optional wake notification is
 * a later task's concern — the handler deliberately does not notify yet.
 *
 * Like the rest of the schema, all timestamps are unix epoch SECONDS.
 */

/**
 * Snooze a thread until `untilTs` (unix seconds): the thread leaves the
 * inbox, stops counting toward the inbox badge and the OS unread badge,
 * and stays reachable via search, labels and All Mail. Throws the shared
 * ThreadNotFoundError when the thread does not exist (a bad caller arg is
 * a programming error; re-snoozing an already-snoozed thread simply
 * moves its wake-up time).
 */
export async function snoozeThread(
  executor: SqlExecutor,
  threadId: string,
  untilTs: number
): Promise<void> {
  const rows = await executor.select<Pick<ThreadRow, "id">>(
    "SELECT id FROM threads WHERE id = $1",
    [threadId]
  )
  if (!rows.length) {
    throw new ThreadNotFoundError(threadId)
  }
  await executor.execute(
    "UPDATE threads SET snoozed_until = $1 WHERE id = $2",
    [untilTs, threadId]
  )
}

/**
 * Cancel a snooze: a plain cancel that clears snoozed_until only.
 * delivered_at is deliberately left untouched — it only influences the
 * inbox ordering, and a cancelled snooze must not bump the thread to the
 * top of the inbox as a wake would. Read state is never touched (see the
 * module doc: snooze never mutates unread state).
 */
export async function unsnoozeThread(
  executor: SqlExecutor,
  threadId: string
): Promise<void> {
  await executor.execute(
    "UPDATE threads SET snoozed_until = NULL WHERE id = $1",
    [threadId]
  )
}

/**
 * Wake every thread whose snooze time has passed: one UPDATE clears
 * snoozed_until and stamps delivered_at = now on all rows with
 * snoozed_until <= now. delivered_at is what tops the inbox (the inbox
 * list orders by COALESCE(delivered_at, last_message_at) DESC), so woken
 * threads reappear at the top with their prior unread state restored.
 * Future snoozes and never-snoozed rows are untouched. Returns the number
 * of threads woken.
 *
 * Registered as the "snooze.wake" due-job handler at startup (bootstrap)
 * and also called once at launch as the catch-up sweep for wake-ups that
 * came due while the app was closed (spec: offline wake-ups).
 */
export async function wakeDueThreads(
  executor: SqlExecutor,
  now: number = Math.floor(Date.now() / 1000)
): Promise<number> {
  // Placeholders ascend by occurrence and each parameter is bound exactly
  // once (see executor.ts), hence the two `now` bindings.
  const result = await executor.execute(
    `UPDATE threads
     SET snoozed_until = NULL, delivered_at = $1
     WHERE snoozed_until IS NOT NULL AND snoozed_until <= $2`,
    [now, now]
  )
  return result.rowsAffected
}

/**
 * Threads currently snoozed, earliest wake-up first — the backing query
 * for the later Snoozed view; `snoozed_until` on each row is the wake-up
 * time the UI renders as a countdown.
 */
export async function listSnoozedThreads(
  executor: SqlExecutor
): Promise<ThreadRow[]> {
  return executor.select<ThreadRow>(
    `SELECT * FROM threads
     WHERE snoozed_until IS NOT NULL
     ORDER BY snoozed_until ASC`
  )
}

// ---- Snooze presets + custom picker data (UI consumption) ----

/** One snooze preset entry for the snooze menu. */
export interface SnoozePreset {
  /** Stable menu key (tests, keyboard, analytics-safe identity). */
  id: "later_today" | "tomorrow" | "next_week"
  /** Ready-to-render menu label (matches the spec's preset names). */
  label: string
  /** Wake-up time, unix epoch seconds (threads.snoozed_until units). */
  until: number
}

/**
 * What the snooze menu renders: the applicable presets plus a marker
 * telling the UI to offer the custom date/time picker entry (the spec's
 * "presets plus custom date/time").
 */
export interface SnoozePickerData {
  presets: SnoozePreset[]
  /** True — the UI should append a custom date/time picker entry. */
  showCustomPicker: boolean
}

/** "Later today" target hour: past 6 PM the preset is no longer future. */
const LATER_TODAY_HOUR = 18
/** Morning hour for the Tomorrow / Next week presets (spec: "Tomorrow 8 AM"). */
const MORNING_HOUR = 8

/**
 * Compute the snooze presets for `now` (defaults to the current time).
 * Pure: no clock reads, so callers and tests pass their own base time.
 * "Later today" (today 6 PM) is only offered while still in the future;
 * the other presets are always future. All times are local to `now`.
 */
export function getSnoozePresets(now: Date = new Date()): SnoozePickerData {
  const presets: SnoozePreset[] = []
  const atMorningHour = (base: Date): Date =>
    set(base, {
      hours: MORNING_HOUR,
      minutes: 0,
      seconds: 0,
      milliseconds: 0,
    })
  const toUnixSeconds = (date: Date): number =>
    Math.floor(date.getTime() / 1000)

  const laterToday = set(now, {
    hours: LATER_TODAY_HOUR,
    minutes: 0,
    seconds: 0,
    milliseconds: 0,
  })
  if (isBefore(now, laterToday)) {
    presets.push({
      id: "later_today",
      label: "Later today",
      until: toUnixSeconds(laterToday),
    })
  }
  presets.push(
    {
      id: "tomorrow",
      label: "Tomorrow 8:00",
      until: toUnixSeconds(atMorningHour(addDays(now, 1))),
    },
    {
      id: "next_week",
      label: "Next week",
      until: toUnixSeconds(atMorningHour(addWeeks(now, 1))),
    }
  )
  return { presets, showCustomPicker: true }
}
