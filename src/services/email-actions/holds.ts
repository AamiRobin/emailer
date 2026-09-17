import type { SqlExecutor } from "../db/executor"

/**
 * Delivery-hold release (task 12.1, design D6). A delivery schedule
 * (settings/delivery-schedules.ts, consulted at ingestion by the hook in
 * rules/ingestion.ts) stamps threads.held_until with the next window
 * opening; held threads are excluded from the inbox list, the inbox badge
 * and the unread counts at the QUERY level (the strict `held_until IS
 * NULL` predicates in db/threads.ts, db/folder-counts.ts and
 * db/accounts.ts — strict, matching the snooze/mute/Done exclusion style,
 * so release is observable: only this due pass clears the column).
 *
 * The release is deliberately the exact wakeDueThreads pattern
 * (email-actions/snooze.ts): ONE batched UPDATE clears every due hold and
 * stamps delivered_at = now in the same statement. delivered_at is what
 * tops the inbox (the inbox orders by COALESCE(delivered_at,
 * last_message_at) DESC), so a window's whole batch re-enters the inbox
 * TOGETHER, at the top — the spec's "delivered in one batch at the top".
 * Read state is never touched: held messages were stored normally and
 * simply filtered out of the inbox/badges, so clearing held_until restores
 * them exactly as unread/read as they arrived. Nothing moves between
 * folders (D6) — held mail stayed visible in its labels, All Mail and
 * search the whole time.
 *
 * Releases ride the scheduler's due-jobs registry (design D2): bootstrap
 * registers the "delivery-holds.release" handler below, every 60s tick
 * drains it, and the shared runDueJobsOnce() is the launch catch-up for
 * windows that opened while the app was closed. Idempotent: released rows
 * no longer match the predicate. Like all schema timestamps, the units are
 * unix epoch SECONDS.
 */

/** Due-job registry name of the delivery-hold release handler (design D2). */
export const DELIVERY_HOLDS_DUE_JOB = "delivery-holds.release"

/**
 * Release every hold whose window has opened: one UPDATE clears
 * held_until and stamps delivered_at = now on all rows with
 * held_until <= now (never-sent holds — held_until IS NULL — and future
 * windows are untouched). Returns the number of threads released.
 *
 * Registered as the "delivery-holds.release" due-job handler at startup
 * (bootstrap) and also caught up once at launch for windows that passed
 * while the app was closed.
 */
export async function releaseDueHolds(
  executor: SqlExecutor,
  now: number = Math.floor(Date.now() / 1000)
): Promise<number> {
  // Placeholders ascend by occurrence and each parameter is bound exactly
  // once (see executor.ts), hence the two `now` bindings.
  const result = await executor.execute(
    `UPDATE threads
     SET held_until = NULL, delivered_at = $1
     WHERE held_until IS NOT NULL AND held_until <= $2`,
    [now, now]
  )
  return result.rowsAffected
}
