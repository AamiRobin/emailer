import type { SqlExecutor } from "./executor"

/**
 * Query layer for `pending_operations` (migrations.ts v1): the durable
 * offline mutation queue behind every "works offline" scenario (design
 * D10). Every server mutation is written locally first, then enqueued
 * here; the replay processor (src/services/queue/processor.ts) drains the
 * queue in seq (FIFO) order once connectivity returns. Executor-first
 * style, same as the other src/services/db modules.
 */

export type PendingOperationStatus =
  "pending" | "processing" | "done" | "failed"

export interface PendingOperationRow {
  /** Autoincrement FIFO replay order. */
  seq: number
  id: string
  account_id: string
  /** Discriminant of the queue operation union (see queue/operation.ts). */
  op_type: string
  /** JSON-encoded typed payload (see queue/operation.ts). */
  payload_json: string
  status: PendingOperationStatus
  attempts: number
  last_error: string | null
  /** unix epoch seconds */
  created_at: number
  /** unix epoch seconds */
  updated_at: number
}

export interface EnqueuePendingOperationInput {
  accountId: string
  opType: string
  /** JSON-serializable payload; stored JSON-encoded in `payload_json`. */
  payload: unknown
}

export interface PendingOperationCountRow {
  account_id: string
  status: PendingOperationStatus
  count: number
}

function now(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Append an operation to the queue and return its generated id. The row
 * starts as 'pending'; seq assigns the FIFO replay position. Payload must
 * be JSON-serializable — it round-trips through `payload_json`.
 */
export async function enqueuePendingOperation(
  executor: SqlExecutor,
  input: EnqueuePendingOperationInput
): Promise<string> {
  const id = crypto.randomUUID()
  await executor.execute(
    `INSERT INTO pending_operations (id, account_id, op_type, payload_json)
    VALUES ($1, $2, $3, $4)`,
    [id, input.accountId, input.opType, JSON.stringify(input.payload)]
  )
  return id
}

export async function getPendingOperation(
  executor: SqlExecutor,
  id: string
): Promise<PendingOperationRow | null> {
  const rows = await executor.select<PendingOperationRow>(
    "SELECT * FROM pending_operations WHERE id = $1",
    [id]
  )
  return rows[0] ?? null
}

/**
 * Pending operations in FIFO order, oldest seq first — the replay order
 * the processor consumes. Optional account filter and row cap (the
 * processor caps each cycle to bound a single pass).
 */
export async function listPendingOperations(
  executor: SqlExecutor,
  accountId?: string,
  limit?: number
): Promise<PendingOperationRow[]> {
  const conditions = ["status = 'pending'"]
  const params: unknown[] = []
  if (accountId !== undefined) {
    params.push(accountId)
    conditions.push(`account_id = $${params.length}`)
  }
  let sql = `SELECT * FROM pending_operations WHERE ${conditions.join(" AND ")} ORDER BY seq ASC`
  if (limit !== undefined) {
    params.push(limit)
    sql += ` LIMIT $${params.length}`
  }
  return executor.select<PendingOperationRow>(sql, params)
}

/** All operations with the given status, FIFO order; same filters as above. */
export async function listOperationsByStatus(
  executor: SqlExecutor,
  status: PendingOperationStatus,
  accountId?: string,
  limit?: number
): Promise<PendingOperationRow[]> {
  const conditions = ["status = $1"]
  const params: unknown[] = [status]
  if (accountId !== undefined) {
    params.push(accountId)
    conditions.push(`account_id = $${params.length}`)
  }
  let sql = `SELECT * FROM pending_operations WHERE ${conditions.join(" AND ")} ORDER BY seq ASC`
  if (limit !== undefined) {
    params.push(limit)
    sql += ` LIMIT $${params.length}`
  }
  return executor.select<PendingOperationRow>(sql, params)
}

/** Claim an operation: 'pending' → 'processing'. */
export async function markOperationProcessing(
  executor: SqlExecutor,
  id: string
): Promise<void> {
  await executor.execute(
    "UPDATE pending_operations SET status = 'processing', updated_at = $1 WHERE id = $2",
    [now(), id]
  )
}

/** Operation replayed successfully: terminal 'done'. */
export async function markOperationDone(
  executor: SqlExecutor,
  id: string
): Promise<void> {
  await executor.execute(
    "UPDATE pending_operations SET status = 'done', updated_at = $1 WHERE id = $2",
    [now(), id]
  )
}

/**
 * Terminal failure (retry cap reached): 'failed' is final — the processor
 * stops retrying; the pending-ops indicator surfaces the row until the
 * user discards it via clearDoneOperations or account removal (FK cascade).
 */
export async function markOperationFailed(
  executor: SqlExecutor,
  id: string,
  error: string
): Promise<void> {
  await executor.execute(
    "UPDATE pending_operations SET status = 'failed', last_error = $1, updated_at = $2 WHERE id = $3",
    [error, now(), id]
  )
}

/**
 * Bump the attempt counter before a retry decision. Returns the new
 * attempts value (UPDATE + SELECT keeps the SQL portable across both
 * drivers; the app is single-process so the read-back is safe).
 */
export async function incrementOperationAttempts(
  executor: SqlExecutor,
  id: string
): Promise<number> {
  await executor.execute(
    "UPDATE pending_operations SET attempts = attempts + 1, updated_at = $1 WHERE id = $2",
    [now(), id]
  )
  const rows = await executor.select<{ attempts: number }>(
    "SELECT attempts FROM pending_operations WHERE id = $1",
    [id]
  )
  return rows[0]?.attempts ?? 0
}

/**
 * Put an operation back into the replay rotation ('processing' →
 * 'pending' or 'pending' after a failed attempt), recording the error.
 * Used by the processor for auth pauses (release the claim) and transient
 * failures (retry on a later cycle, subject to the attempts cap).
 */
export async function requeueOperationForRetry(
  executor: SqlExecutor,
  id: string,
  error: string
): Promise<void> {
  await executor.execute(
    "UPDATE pending_operations SET status = 'pending', last_error = $1, updated_at = $2 WHERE id = $3",
    [error, now(), id]
  )
}

/**
 * Per-account, per-status counts for the pending-ops indicator
 * (mailbox-ui 6.8). Filter to status = 'pending' for the queue badge;
 * 'failed' rows are surfaced separately.
 */
export async function countPendingOperationsByAccount(
  executor: SqlExecutor,
  accountId?: string
): Promise<PendingOperationCountRow[]> {
  const params: unknown[] = []
  let sql = `
    SELECT account_id, status, COUNT(*) AS count
    FROM pending_operations`
  if (accountId !== undefined) {
    params.push(accountId)
    sql += ` WHERE account_id = $1`
  }
  sql += ` GROUP BY account_id, status ORDER BY account_id, status`
  return executor.select<PendingOperationCountRow>(sql, params)
}

/**
 * Garbage collection for terminal rows: delete 'done' operations, or only
 * those finished before the given unix-seconds cutoff when provided.
 * Returns the number of rows removed.
 */
export async function clearDoneOperations(
  executor: SqlExecutor,
  olderThan?: number
): Promise<number> {
  const params: unknown[] = []
  let sql = "DELETE FROM pending_operations WHERE status = 'done'"
  if (olderThan !== undefined) {
    params.push(olderThan)
    sql += ` AND updated_at < $1`
  }
  const result = await executor.execute(sql, params)
  return result.rowsAffected
}

/**
 * Crash recovery: rows left in 'processing' by a previous session that
 * died mid-replay would otherwise be invisible to listPendingOperations
 * forever. Reset them to 'pending' so the next cycle replays them. Called
 * once at startup by initQueueSystem (with maxAgeSeconds = 0 — nothing
 * else is running yet, so every 'processing' row is stale). Operations
 * are idempotent (flags/labels) or deduplicateable (send via Message-ID),
 * so a replay after a crash is safe per D10. Returns rows reset.
 */
export async function requeueStaleProcessingOperations(
  executor: SqlExecutor,
  maxAgeSeconds = 300
): Promise<number> {
  const cutoff = now() - maxAgeSeconds
  const result = await executor.execute(
    "UPDATE pending_operations SET status = 'pending', updated_at = $1 WHERE status = 'processing' AND updated_at <= $2",
    [now(), cutoff]
  )
  return result.rowsAffected
}
