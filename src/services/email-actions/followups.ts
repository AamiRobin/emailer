import type { SqlExecutor } from "../db/executor"
import { placeholders } from "../db/executor"
import { getFollowUpDays } from "../settings/preferences"

/**
 * Follow-up reminders (task 14.2, design D8): "follow-ups are ROWS".
 * followup_reminders(thread_id, due_at, cancelled_at) — one row per
 * qualifying send, cancelled by the ingestion hook when a threaded reply
 * arrives, resurfaced by the due pass when the interval elapses with no
 * reply. All timestamps are unix epoch SECONDS, like every schema
 * timestamp.
 *
 * Attach at send time (send.ts): when a send is ACCEPTED (the local-first
 * enqueue — online and offline are the same path, so a queued-offline send
 * attaches exactly like a sent one), a reminder is created for the thread
 * the reply went INTO, due = accept time + the `mail.followUpDays`
 * interval (settings/preferences.ts, default 3, clamped 1–30). Attachment
 * is deliberately REPLY-ONLY: the reminder targets `mode.sourceThreadId`
 * (the conversation being answered — the only thread linkage the composer
 * reliably has; a fresh compose files a provisional Sent thread that the
 * sync reconciliation may delete, and its CASCADE would silently drop the
 * reminder). A forward is likewise skipped: it starts a new conversation
 * rather than continuing one. A failed attach (thread deleted mid-compose,
 * settings read hiccup) never fails the send — it warns and skips.
 *
 * Cancellation (the ingestion hook's FOURTH consumer — rules/ingestion.ts
 * runs it inside runIngestionRules, per newly inserted message): any
 * arrival on the reminder's thread cancels every pending reminder there —
 * a threaded reply arrived, so there is nothing left to chase. Events from
 * the account's OWN address are skipped: the user's own sent copy syncs
 * back through the same hook minutes after the send that just created the
 * reminder, and that echo must not cancel it (the same own-address rule
 * recordSenderStats applies). "Own address" is the account email for now —
 * aliases (task 16, design D10) will widen it.
 *
 * The due pass (runDueFollowUps, registered as "followups.run" at
 * bootstrap beside the other due jobs): due reminders (due_at <= now,
 * still pending) stamp delivered_at = now on their threads — delivered_at
 * tops the inbox ordering (COALESCE(delivered_at, last_message_at)), the
 * exact resurfacing stroke the snooze wake and hold-release strokes use —
 * and then mark the reminder TERMINAL. Terminal state is `cancelled_at`:
 * the column means "closed" for BOTH outcomes (auto-cancelled by a reply,
 * or fired by the due pass); the row is kept either way so the feature
 * stays auditable, and re-running the pass cannot re-fire a fired reminder
 * (idempotent). Honest approximation note: the schema has no separate
 * fired marker, so a fired reminder is indistinguishable from a cancelled
 * one by design; the resurface itself is the user-visible effect.
 *
 * Reminders work offline by construction: the row is local, cancellation
 * rides message ingestion (local upserts), and the due pass runs at every
 * tick plus once at launch (runDueJobsOnce), so intervals that elapsed
 * while the app was closed fire on next launch.
 */

/** Due-job registry name of the follow-up resurfacing handler (design D2). */
export const FOLLOWUPS_DUE_JOB = "followups.run"

/** One followup_reminders row. */
export interface FollowUpReminderRow {
  id: string
  account_id: string
  thread_id: string
  due_at: number
  /** Terminal marker — set when the reminder is auto-cancelled by a
   * threaded reply OR fired by the due pass (see the module comment). */
  cancelled_at: number | null
  created_at: number
}

/**
 * Create one reminder directly (the send flow's write path; exported for
 * tests and future manual-attach UIs). `dueAt` is unix seconds. The
 * thread must exist (FK) — callers guarantee it.
 */
export async function createFollowUpReminder(
  executor: SqlExecutor,
  accountId: string,
  threadId: string,
  dueAt: number
): Promise<string> {
  const id = crypto.randomUUID()
  await executor.execute(
    `INSERT INTO followup_reminders (id, account_id, thread_id, due_at)
     VALUES ($1, $2, $3, $4)`,
    [id, accountId, threadId, dueAt]
  )
  return id
}

/** The subset of the composer's send mode the attach decision needs
 * (structurally satisfied by SendComposerMode). */
export interface FollowUpAttachMode {
  kind: "new" | "reply" | "forward"
  sourceThreadId?: string
}

/**
 * Attach-at-send decision (called from send.ts's accept path): replies
 * carrying a `sourceThreadId` get one reminder (due = now + the
 * configured interval); every other shape — fresh compose, forward, reply
 * without thread linkage — attaches nothing. NEVER throws: a failed
 * attach is logged and skipped, because it must never fail the send it
 * rides. Returns whether a reminder was attached (tests).
 */
export async function attachReplyFollowUp(
  executor: SqlExecutor,
  accountId: string,
  mode: FollowUpAttachMode | undefined,
  now: number = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  if (mode?.kind !== "reply" || !mode.sourceThreadId) return false
  try {
    const days = await getFollowUpDays(executor)
    await createFollowUpReminder(
      executor,
      accountId,
      mode.sourceThreadId,
      now + days * 24 * 60 * 60
    )
    return true
  } catch (error) {
    // Isolated by contract (see the module comment): the send stands.
    console.warn(
      `[followups] could not attach a reminder for thread ${mode.sourceThreadId}; skipping`,
      error
    )
    return false
  }
}

/** The per-event shape the cancellation consumer needs (IngestionEvent
 * satisfies it structurally). */
export interface FollowUpCancellationEvent {
  threadId: string
  fromAddress: string | null
}

/**
 * The ingestion consumer: cancel every pending reminder on the threads
 * the given arrivals landed in, skipping the account's OWN messages (the
 * sent-copy echo — see the module comment). One batched UPDATE for the
 * whole batch. Returns the number of reminders cancelled.
 */
export async function cancelFollowUpsOnArrivals(
  executor: SqlExecutor,
  accountEmail: string | null,
  events: readonly FollowUpCancellationEvent[],
  now: number = Math.floor(Date.now() / 1000)
): Promise<number> {
  const own = accountEmail?.trim().toLowerCase() ?? ""
  const threadIds = [
    ...new Set(
      events
        .filter(
          (event) =>
            own === "" || event.fromAddress?.trim().toLowerCase() !== own
        )
        .map((event) => event.threadId)
    ),
  ]
  if (threadIds.length === 0) return 0
  const result = await executor.execute(
    `UPDATE followup_reminders SET cancelled_at = $1
     WHERE cancelled_at IS NULL
       AND thread_id IN (${placeholders(threadIds.length, 2)})`,
    [now, ...threadIds]
  )
  return result.rowsAffected
}

/**
 * Cancel every pending reminder on ONE thread (the primitive the batched
 * consumer above wraps; also handy for future UIs). Returns the number
 * cancelled.
 */
export async function cancelPendingRemindersForThread(
  executor: SqlExecutor,
  threadId: string,
  now: number = Math.floor(Date.now() / 1000)
): Promise<number> {
  const result = await executor.execute(
    "UPDATE followup_reminders SET cancelled_at = $1 WHERE cancelled_at IS NULL AND thread_id = $2",
    [now, threadId]
  )
  return result.rowsAffected
}

/**
 * The due pass: resurface every reminder whose time has come and mark it
 * terminal. One batch: stamp delivered_at = now on the reminders' threads
 * (tops the inbox ordering — see the module comment), then close the rows
 * (cancelled_at = now — terminal for fired as well as cancelled).
 * Idempotent: closed rows no longer match the predicate, so re-running is
 * a no-op. Returns the number of reminders resurfaced.
 */
export async function runDueFollowUps(
  executor: SqlExecutor,
  now: number = Math.floor(Date.now() / 1000)
): Promise<number> {
  const due = await executor.select<{ id: string; thread_id: string }>(
    `SELECT id, thread_id FROM followup_reminders
     WHERE cancelled_at IS NULL AND due_at <= $1`,
    [now]
  )
  if (due.length === 0) return 0
  const threadIds = [...new Set(due.map((row) => row.thread_id))]
  await executor.execute(
    `UPDATE threads SET delivered_at = $1
     WHERE id IN (${placeholders(threadIds.length, 2)})`,
    [now, ...threadIds]
  )
  await executor.execute(
    `UPDATE followup_reminders SET cancelled_at = $1
     WHERE id IN (${placeholders(due.length, 2)})`,
    [now, ...due.map((row) => row.id)]
  )
  return due.length
}
