import type { SqlExecutor } from "./executor"

/**
 * Send-later jobs (design D3, tasks 10.1/10.3): CRUD over the
 * `scheduled_sends` table. A row holds the FULLY BUILT RFC 822 payload
 * (mime-builder output — attachments included as base64 parts), the
 * resolved recipients, the subject and the due time, so firing needs no
 * composer state even after a restart (task 10.2's due pass owns firing).
 *
 * Status model (the schema's CHECK): `scheduled → sending → sent |
 * failed`, with `cancelled` hiding a row before transmission while the
 * row itself is kept for audit. The task-10.2 worker owns the
 * transmission transitions: markScheduledSendSending / markScheduledSendSent /
 * markScheduledSendFailed live here beside the queries they guard (the
 * module doc they were reserved in) as three single UPDATE statements
 * over `status`/`last_error`/`sent_at` filtered by the expected current
 * status, so a concurrent cancel can never race a send into a
 * double transmission and a lost claim simply reports `false`.
 *
 * Crash semantics (task 10.2): a `sending` row is owned by the queue op
 * it was enqueued with (op kind `send_mime`, whose payload carries the
 * row id). The runner reconciles orphaned `sending` rows on every pass
 * via reconcileSendingScheduledSends — a row with a live op keeps
 * waiting, a row whose op finished is stamped with the op's outcome, and
 * a row with no op at all (the app died between the claim and the
 * enqueue) fails as "interrupted" for a manual re-send.
 *
 * Edit strategy (task 10.3): editing a scheduled send CANCELS the row and
 * re-creates it when the composer re-schedules — never an in-place
 * payload replace. The built MIME stamps a Date header and a Message-ID
 * at build time, so an edit that kept the old payload would send stale
 * headers after days in the queue. `replaceScheduledSendPayload` still
 * ships for completeness (same stale-header caveat applies to its
 * callers); the UI edit path does not use it.
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor.
 */

export type ScheduledSendStatus =
  "scheduled" | "sending" | "sent" | "failed" | "cancelled"

export interface ScheduledSendRow {
  id: string
  account_id: string
  mime_payload: string
  /** JSON array of {name?, email} — the resolved recipients (view summary). */
  recipients_json: string
  subject: string | null
  /** unix epoch seconds */
  due_at: number
  status: ScheduledSendStatus
  last_error: string | null
  /** unix epoch seconds, set by 10.2's due pass on success */
  sent_at: number | null
  created_at: number
}

/** A scheduled send's recipient — the composer's Recipient shape. */
export interface ScheduledRecipient {
  name?: string
  email: string
}

export interface CreateScheduledSendInput {
  accountId: string
  mimePayload: string
  recipients: ScheduledRecipient[]
  subject?: string
  /** unix epoch seconds */
  dueAt: number
}

/** Insert a scheduled send as 'scheduled'; returns the generated id. */
export async function createScheduledSend(
  executor: SqlExecutor,
  input: CreateScheduledSendInput
): Promise<string> {
  const id = crypto.randomUUID()
  await executor.execute(
    `INSERT INTO scheduled_sends
       (id, account_id, mime_payload, recipients_json, subject, due_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      input.accountId,
      input.mimePayload,
      JSON.stringify(input.recipients),
      input.subject === undefined || input.subject.trim() === ""
        ? null
        : input.subject,
      input.dueAt,
    ]
  )
  return id
}

/**
 * Scheduled sends for one account — pending jobs first (status
 * 'scheduled' or 'sending', due time ascending so the next send is
 * first), and with `includeHistory` the terminal 'sent'/'failed' rows
 * appended (most recent due first) for the dialog's muted history group.
 * 'cancelled' rows are audit-only and never listed. 'sending' rows are
 * claimed by the 10.2 due pass with their op still queued (offline hold,
 * retry backoff) — they stay visible (and cancellable) until the queue
 * resolves them, so a due send can never vanish from the view.
 */
export async function listScheduledSends(
  executor: SqlExecutor,
  accountId?: string,
  options?: { includeHistory?: boolean }
): Promise<ScheduledSendRow[]> {
  // Placeholders ascend by occurrence in each statement (see executor.ts).
  const accountClause = accountId === undefined ? "" : "account_id = $1 AND "
  const accountParams = accountId === undefined ? [] : [accountId]

  const pending = await executor.select<ScheduledSendRow>(
    `SELECT * FROM scheduled_sends
     WHERE ${accountClause}status IN ('scheduled', 'sending')
     ORDER BY due_at ASC, created_at ASC, id ASC`,
    accountParams
  )
  if (!options?.includeHistory) return pending

  const history = await executor.select<ScheduledSendRow>(
    `SELECT * FROM scheduled_sends
     WHERE ${accountClause}status IN ('sent', 'failed')
     ORDER BY due_at DESC, created_at DESC, id ASC`,
    accountParams
  )
  return [...pending, ...history]
}

/**
 * Fetch one scheduled send by id (any status), or null. The dialog's edit
 * flow uses the list rows; this is for callers addressing a single job.
 */
export async function getScheduledSend(
  executor: SqlExecutor,
  id: string
): Promise<ScheduledSendRow | null> {
  const rows = await executor.select<ScheduledSendRow>(
    "SELECT * FROM scheduled_sends WHERE id = $1",
    [id]
  )
  return rows[0] ?? null
}

/**
 * Cancel a pending scheduled send (task 10.3): status → 'cancelled', the
 * row is kept for audit but hidden from every listing. Both cancellable
 * states move: a 'scheduled' row, and a 'sending' row whose op is still
 * queued (offline hold / retry backoff) — the queue's pre-transmit
 * re-check sees the cancelled row and skips the transmission (see
 * processor.ts executeSendMime). Terminal rows ('sent'/'failed') are
 * history and 'cancelled' is final: neither can be re-cancelled.
 * Returns whether the transition applied (false for unknown ids, rows
 * already cancelled, and terminal rows).
 */
export async function cancelScheduledSend(
  executor: SqlExecutor,
  id: string
): Promise<boolean> {
  const result = await executor.execute(
    `UPDATE scheduled_sends SET status = 'cancelled'
     WHERE id = $1 AND status IN ('scheduled', 'sending')`,
    [id]
  )
  return result.rowsAffected > 0
}

/**
 * Move a pending send's due time (only 'scheduled' rows; the edit flow
 * re-creates rows instead of rescheduling them, so this is for callers
 * that shift a job without touching its content).
 */
export async function updateScheduledSendDue(
  executor: SqlExecutor,
  id: string,
  dueAt: number
): Promise<void> {
  await executor.execute(
    "UPDATE scheduled_sends SET due_at = $1 WHERE id = $2 AND status = 'scheduled'",
    [dueAt, id]
  )
}

/**
 * Replace the stored content of a pending send (payload, recipients,
 * subject, optionally the due time). Kept for completeness — see the
 * module doc for why the UI edit path cancels + re-creates instead
 * (stale Date/Message-ID headers in a kept payload).
 */
export async function replaceScheduledSendPayload(
  executor: SqlExecutor,
  id: string,
  patch: {
    mimePayload: string
    recipients: ScheduledRecipient[]
    subject?: string
    dueAt?: number
  }
): Promise<void> {
  await executor.execute(
    `UPDATE scheduled_sends
     SET mime_payload = $1, recipients_json = $2, subject = $3${
       patch.dueAt !== undefined ? ", due_at = $4" : ""
     }
     WHERE id = $${patch.dueAt !== undefined ? 5 : 4} AND status = 'scheduled'`,
    [
      patch.mimePayload,
      JSON.stringify(patch.recipients),
      patch.subject === undefined || patch.subject.trim() === ""
        ? null
        : patch.subject,
      ...(patch.dueAt !== undefined ? [patch.dueAt] : []),
      id,
    ]
  )
}

/**
 * Parse a row's recipients_json into the recipient list; corrupt JSON
 * degrades to [] rather than throwing (the dialog still shows the row).
 */
export function parseScheduledRecipients(
  recipientsJson: string
): ScheduledRecipient[] {
  try {
    const parsed: unknown = JSON.parse(recipientsJson)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (entry): entry is ScheduledRecipient =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { email?: unknown }).email === "string"
    )
  } catch {
    return []
  }
}

// ---------------------------------------------------------------------------
// Transmission transitions (task 10.2). Each is guarded by the expected
// current status and returns whether it applied, so a concurrent cancel
// or a re-run can never move a row twice: a lost claim reports false and
// the caller skips the row.
// ---------------------------------------------------------------------------

/**
 * Claim a due row for firing: 'scheduled' → 'sending'. False when the row
 * is no longer 'scheduled' (cancelled between the selection and this
 * claim — the race the guard exists for).
 */
export async function markScheduledSendSending(
  executor: SqlExecutor,
  id: string
): Promise<boolean> {
  const result = await executor.execute(
    "UPDATE scheduled_sends SET status = 'sending' WHERE id = $1 AND status = 'scheduled'",
    [id]
  )
  return result.rowsAffected > 0
}

/**
 * Transmission accepted/transmitted: 'sending' → 'sent' with the
 * completion timestamp (`sent_at`, unix epoch seconds). Only the queue
 * completion (or the crash reconciliation below) may call this — a row
 * still waiting in the queue stays 'sending'. False on a non-'sending'
 * row.
 */
export async function markScheduledSendSent(
  executor: SqlExecutor,
  id: string,
  sentAt: number
): Promise<boolean> {
  const result = await executor.execute(
    "UPDATE scheduled_sends SET status = 'sent', sent_at = $1 WHERE id = $2 AND status = 'sending'",
    [sentAt, id]
  )
  return result.rowsAffected > 0
}

/**
 * Transmission failed for good (enqueue failure or the queue's retry cap,
 * or a crash reconciliation): 'sending' → 'failed' with a sanitized
 * `last_error`. The user re-sends manually; the row stays visible in the
 * dialog's history. False on a non-'sending' row.
 */
export async function markScheduledSendFailed(
  executor: SqlExecutor,
  id: string,
  error: string
): Promise<boolean> {
  const result = await executor.execute(
    "UPDATE scheduled_sends SET status = 'failed', last_error = $1 WHERE id = $2 AND status = 'sending'",
    [error, id]
  )
  return result.rowsAffected > 0
}

/**
 * Every due job for this pass: 'scheduled' rows whose time has come
 * (due_at <= now), earliest first. Future rows, cancelled rows and rows
 * already claimed ('sending') are excluded. This is the catch-up query
 * too — a send whose due passed while the app was closed is simply due.
 */
export async function listDueScheduledSends(
  executor: SqlExecutor,
  now: number
): Promise<ScheduledSendRow[]> {
  return executor.select<ScheduledSendRow>(
    `SELECT * FROM scheduled_sends
     WHERE status = 'scheduled' AND due_at <= $1
     ORDER BY due_at ASC, created_at ASC, id ASC`,
    [now]
  )
}

/**
 * Outcome counts of reconcileSendingScheduledSends: rows stamped 'sent'
 * from a finished queue op and rows stamped 'failed' (finished-failed op
 * or no-op orphan).
 */
export interface ScheduledSendReconciliation {
  sent: number
  failed: number
}

/**
 * Resolve `sending` rows orphaned by a crash (task 10.2). A `sending` row
 * is owned by its `send_mime` queue op, identified by the scheduledSendId
 * inside the op's payload JSON (there is no time-in-sending column, so
 * op liveness — not an age threshold — defines "stale"; the runner and
 * the queue are single-flight, so a mid-pass row always has its op):
 *
 * - live op ('pending'/'processing'): left alone — offline hold, retry
 *   backoff or an auth pause; the queue still owns the row.
 * - op 'done': healed to 'sent' with the op's completion time as
 *   sent_at (crash between the provider success and the status stamp).
 * - op terminal 'failed': 'failed' with the op's last_error.
 * - no op at all (died between the claim and the enqueue): 'failed'
 *   "interrupted" — the user re-sends manually; nothing was transmitted.
 *
 * Best-effort by callers (the due pass runs it first); returns the
 * outcome counts for the pass summary.
 */
export async function reconcileSendingScheduledSends(
  executor: SqlExecutor
): Promise<ScheduledSendReconciliation> {
  // Matches `{"…","scheduledSendId":"<row id>"}` inside payload_json.
  // UUIDs carry no LIKE wildcards and the key + surrounding quotes make a
  // cross-row collision impossible.
  const opOf = (status: string): string => `
    SELECT 1 FROM pending_operations
    WHERE op_type = 'send_mime' AND status = '${status}'
      AND payload_json LIKE '%"scheduledSendId":"' || scheduled_sends.id || '"%'`

  const healed = await executor.execute(
    `UPDATE scheduled_sends SET status = 'sent', sent_at = COALESCE((
       SELECT MAX(p.updated_at) FROM pending_operations p
       WHERE p.op_type = 'send_mime' AND p.status = 'done'
         AND p.payload_json LIKE '%"scheduledSendId":"' || scheduled_sends.id || '"%'
     ), sent_at)
     WHERE status = 'sending' AND EXISTS (${opOf("done")})`,
    []
  )
  const failedOps = await executor.execute(
    `UPDATE scheduled_sends SET status = 'failed', last_error = COALESCE((
       SELECT p.last_error FROM pending_operations p
       WHERE p.op_type = 'send_mime' AND p.status = 'failed'
         AND p.payload_json LIKE '%"scheduledSendId":"' || scheduled_sends.id || '"%'
     ), 'the queued send failed')
     WHERE status = 'sending' AND EXISTS (${opOf("failed")})`,
    []
  )
  const orphans = await executor.execute(
    `UPDATE scheduled_sends SET status = 'failed', last_error = 'interrupted: the app closed before the send was queued'
     WHERE status = 'sending' AND NOT EXISTS (${opOf("pending")})
       AND NOT EXISTS (${opOf("processing")})
       AND NOT EXISTS (${opOf("done")})
       AND NOT EXISTS (${opOf("failed")})`,
    []
  )
  return {
    sent: healed.rowsAffected,
    failed: failedOps.rowsAffected + orphans.rowsAffected,
  }
}
