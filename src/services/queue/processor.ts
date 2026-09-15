import type { SqlExecutor } from "../db/executor"
import { getExecutor } from "../db/executor"
import {
  CredentialDecryptError,
  decryptCredentials,
} from "../crypto/credentials"
import {
  incrementOperationAttempts,
  listPendingOperations,
  markOperationDone,
  markOperationFailed,
  markOperationProcessing,
  requeueOperationForRetry,
  type PendingOperationRow,
} from "../db/pending-operations"
import { getProvider } from "../email/provider-factory"
import { getAccount, toEmailAccount } from "../db/accounts"
import type { EmailProvider, ProviderCredentials } from "../email/types"
import { ProviderAuthError } from "../email/types"
import {
  buildLabelAdminService,
  executeLabelAdminOperation,
  type LabelAdminService,
} from "../labels/label-admin"
import { isOnline } from "../online"
import type { QueueOperation } from "./operation"
import { operationFromRow } from "./operation"
// Side-effect registration (imap + gmail) so getProvider() can build a
// provider for any account type without each caller importing this module.
import "../email/register-providers"

/**
 * The offline replay processor (task 4.5, design D10): drains the
 * `pending_operations` queue in FIFO seq order per account, executing each
 * operation against the account's provider.
 *
 * Semantics:
 * - FIFO per account. Accounts are processed independently (each gets its
 *   own provider); the op order within an account is the enqueue order.
 *   The first resolvable failure stops that account's batch so later
 *   operations never overtake an unresolved earlier one; other accounts
 *   continue. A permanently failed op (retry cap) unblocks the batch.
 * - Offline: a run is skipped entirely while isOnline() is false — no
 *   provider call, no attempt consumed. The 30s interval and the
 *   online-event trigger (initQueueSystem) re-invoke when connectivity
 *   returns.
 * - Retry/backoff: on a transient failure the attempt counter is
 *   incremented; below MAX_OPERATION_ATTEMPTS the row returns to 'pending'
 *   with last_error and is retried on a later cycle after an in-memory
 *   exponential backoff (base 5s, doubled per attempt, capped at 5 min) —
 *   backoff is deliberately not persisted, the schema stays fixed, and a
 *   restart simply retries on the next cycle. At the cap the row moves to
 *   terminal 'failed' and stops replaying (surfaced by the pending-ops
 *   indicator, cleared via clearDoneOperations / account removal).
 * - Auth errors: ProviderAuthError (or missing/undecryptable credentials,
 *   or accounts already marked status = 'auth-error' in the DB) pauses
 *   only that account — its ops stay 'pending' and are skipped for the
 *   session until resumeAccountOperations() is called by the account
 *   auth-error flow (task 5.6).
 * - Idempotency: flag/label/placement operations are idempotent (see
 *   operation.ts), so replaying after a crash or ambiguous failure is
 *   safe; `send` relies on a caller-supplied Message-ID for deduplication.
 * - Single-flight: concurrent processQueue() calls coalesce — overlapping
 *   invocations return the in-flight run and request exactly one follow-up
 *   pass, so runs never overlap.
 */

/** Attempts (including the first) before an operation fails permanently. */
export const MAX_OPERATION_ATTEMPTS = 5

const DEFAULT_INTERVAL_MS = 30_000
const DEFAULT_BACKOFF_BASE_MS = 5_000
const MAX_BACKOFF_MS = 300_000
/** Upper bound on operations considered per cycle; the rest wait for the
 * next tick so a huge backlog cannot monopolize a single pass. */
const MAX_OPS_PER_RUN = 500
const MAX_ERROR_LENGTH = 500

export interface ProcessQueueOptions {
  /** Override the shared executor (tests). Defaults to getExecutor(). */
  executor?: SqlExecutor
  /**
   * Test seam: replaces account loading + credential decryption + the
   * provider factory entirely. Never set in production code.
   */
  getProviderForTest?: (accountId: string) => EmailProvider
  /**
   * Test seam for the label/folder entity ops (task 10.4): replaces the
   * LabelAdminService construction (account loading + credential
   * decryption + gmail/imap transports). Built lazily — only when a
   * label-entity op is actually replayed. Never set in production code.
   */
  getLabelAdminForTest?: (accountId: string) => LabelAdminService
  /** Base delay for the exponential retry backoff in ms (tests use 0). */
  backoffBaseMs?: number
}

export interface QueueRunResult {
  /** Operations attempted this run (execution started). */
  attempted: number
  succeeded: number
  /** Re-enqueued after a transient failure, eligible for a later cycle. */
  requeued: number
  /** Moved to terminal 'failed' (retry cap reached). */
  failed: number
  /** Accounts paused this run due to an auth error. */
  pausedAccounts: string[]
  /** True when the run was skipped because the device is offline. */
  skippedOffline: boolean
}

// ---- Module state (one queue processor per app session) ----

let inFlight: Promise<QueueRunResult> | null = null
let rerunRequested = false
let activeOptions: ProcessQueueOptions = {}
let intervalHandle: ReturnType<typeof setInterval> | null = null

/** Accounts paused by an auth error for this session (task 5.6 resumes). */
const pausedAccounts = new Set<string>()

/** In-memory backoff: op id → epoch ms when the op becomes retry-eligible. */
const retryAt = new Map<string, number>()

/**
 * Run one queue-drain pass. Overlapping calls coalesce into the in-flight
 * run and schedule exactly one follow-up pass after it completes.
 */
export function processQueue(
  options: ProcessQueueOptions = {}
): Promise<QueueRunResult> {
  if (inFlight) {
    rerunRequested = true
    return inFlight
  }
  activeOptions = options
  const tracked = runQueue(options).finally(() => {
    inFlight = null
    if (rerunRequested) {
      rerunRequested = false
      void processQueue(activeOptions)
    }
  })
  inFlight = tracked
  return tracked
}

async function runQueue(options: ProcessQueueOptions): Promise<QueueRunResult> {
  const result: QueueRunResult = {
    attempted: 0,
    succeeded: 0,
    requeued: 0,
    failed: 0,
    pausedAccounts: [],
    skippedOffline: false,
  }
  try {
    if (!isOnline()) {
      result.skippedOffline = true
      return result
    }
    const executor = options.executor ?? getExecutor()
    const dueOps = await collectDueOperations(executor)
    for (const [accountId, ops] of dueOps) {
      if (pausedAccounts.has(accountId)) continue
      await processAccountBatch(executor, accountId, ops, options, result)
    }
    return result
  } catch (error) {
    // A run must never reject: interval ticks would raise unhandled
    // rejections. The failure is logged and retried on the next cycle.
    console.error("queue processor run failed", error)
    return result
  }
}

/**
 * All due pending operations grouped by account, each group in FIFO seq
 * order and account groups ordered by their oldest op's seq. Backoff-gated
 * ops stay pending but are not listed this cycle.
 */
async function collectDueOperations(
  executor: SqlExecutor
): Promise<Map<string, PendingOperationRow[]>> {
  const rows = await listPendingOperations(executor, undefined, MAX_OPS_PER_RUN)
  const nowMs = Date.now()
  const liveIds = new Set(rows.map((row) => row.id))
  for (const id of retryAt.keys()) {
    if (!liveIds.has(id)) retryAt.delete(id)
  }
  const grouped = new Map<string, PendingOperationRow[]>()
  for (const row of rows) {
    const eligibleAt = retryAt.get(row.id)
    if (eligibleAt !== undefined && eligibleAt > nowMs) continue
    const group = grouped.get(row.account_id)
    if (group) group.push(row)
    else grouped.set(row.account_id, [row])
  }
  return grouped
}

/**
 * Replay one account's due ops in order. The batch stops at the first
 * failure that leaves the op unresolved (transient or auth); provider
 * construction is lazy and shared by the batch.
 */
async function processAccountBatch(
  executor: SqlExecutor,
  accountId: string,
  ops: PendingOperationRow[],
  options: ProcessQueueOptions,
  result: QueueRunResult
): Promise<void> {
  let provider: EmailProvider
  try {
    provider = options.getProviderForTest
      ? options.getProviderForTest(accountId)
      : await buildProvider(executor, accountId)
  } catch (error) {
    await handleSetupFailure(
      executor,
      accountId,
      ops[0],
      error,
      options,
      result
    )
    return
  }

  // The LabelAdminService is built lazily on the first label-entity op
  // (task 10.4) and shared by the batch; its setup failures land in the
  // same failure handling below.
  let admin: LabelAdminService | null = null
  const resolveAdmin = async (): Promise<LabelAdminService> => {
    admin ??= options.getLabelAdminForTest
      ? options.getLabelAdminForTest(accountId)
      : await buildLabelAdminService(executor, accountId)
    return admin
  }

  for (const row of ops) {
    await markOperationProcessing(executor, row.id)
    result.attempted += 1
    try {
      await executeOperation(provider, operationFromRow(row), resolveAdmin)
      await markOperationDone(executor, row.id)
      retryAt.delete(row.id)
      result.succeeded += 1
    } catch (error) {
      const stopsBatch = await handleOperationFailure(
        executor,
        accountId,
        row,
        error,
        options,
        result
      )
      if (stopsBatch) return
    }
  }
}

/**
 * Record one failed execution and decide the batch's fate. Returns true
 * when the account's batch must stop (auth pause or FIFO hold on a
 * transient failure); false when the failed op is terminal (cap reached)
 * and the batch may continue past it.
 */
async function handleOperationFailure(
  executor: SqlExecutor,
  accountId: string,
  row: PendingOperationRow,
  error: unknown,
  options: ProcessQueueOptions,
  result: QueueRunResult
): Promise<boolean> {
  const message = sanitizeError(error)
  if (error instanceof ProviderAuthError) {
    // Release the claim and pause the whole account; task 5.6 resumes it
    // after re-auth via resumeAccountOperations().
    await requeueOperationForRetry(executor, row.id, message)
    pauseAccount(accountId, result)
    return true
  }
  const attempts = await incrementOperationAttempts(executor, row.id)
  if (attempts >= MAX_OPERATION_ATTEMPTS) {
    await markOperationFailed(executor, row.id, message)
    retryAt.delete(row.id)
    result.failed += 1
    return false
  }
  await requeueOperationForRetry(executor, row.id, message)
  retryAt.set(row.id, Date.now() + backoffDelayMs(attempts, options))
  result.requeued += 1
  return true
}

/**
 * Provider construction failed before any op ran. Auth-shaped failures
 * pause the account (ops stay pending, retried when 5.6 resumes it);
 * anything else is charged to the head op so a broken configuration still
 * hits the retry cap instead of spinning forever.
 */
async function handleSetupFailure(
  executor: SqlExecutor,
  accountId: string,
  head: PendingOperationRow | undefined,
  error: unknown,
  options: ProcessQueueOptions,
  result: QueueRunResult
): Promise<void> {
  if (!head) return
  if (
    error instanceof ProviderAuthError ||
    error instanceof CredentialDecryptError
  ) {
    pauseAccount(accountId, result)
    return
  }
  await handleOperationFailure(
    executor,
    accountId,
    head,
    error,
    options,
    result
  )
}

function pauseAccount(accountId: string, result: QueueRunResult): void {
  pausedAccounts.add(accountId)
  if (!result.pausedAccounts.includes(accountId)) {
    result.pausedAccounts.push(accountId)
  }
}

/**
 * Build the account's provider through the production path: load the
 * account row, decrypt credentials, ask the factory. A missing or
 * undecryptable credentials envelope surfaces as ProviderAuthError so the
 * standard pause path handles it.
 */
async function buildProvider(
  executor: SqlExecutor,
  accountId: string
): Promise<EmailProvider> {
  const row = await getAccount(executor, accountId)
  if (!row) {
    throw new Error(`queued account ${accountId} no longer exists`)
  }
  if (row.status === "auth-error") {
    // Marked by the account auth-error flow (5.6); keep ops pending.
    throw new ProviderAuthError(
      accountId,
      row.type,
      "account is in auth-error state; queued operations paused"
    )
  }
  let credentials: ProviderCredentials | null
  try {
    credentials = await decryptCredentials<ProviderCredentials>(
      row.credentials_json
    )
  } catch (error) {
    if (error instanceof CredentialDecryptError) {
      throw new ProviderAuthError(
        accountId,
        row.type,
        "stored credentials could not be decrypted"
      )
    }
    throw error
  }
  if (!credentials) {
    throw new ProviderAuthError(
      accountId,
      row.type,
      "account has no stored credentials; queued operations paused"
    )
  }
  return getProvider(toEmailAccount(row), credentials)
}

/**
 * Dispatch a queued operation to its EmailProvider method. Flags, labels
 * and folder placements are idempotent by nature (see operation.ts), so a
 * replayed execution converges on the same server state.
 *
 * The label/folder ENTITY ops (task 10.4) bypass the EmailProvider
 * surface: `resolveAdmin` lazily builds the account's LabelAdminService
 * (gmail label endpoints / imap folder commands) and any setup failure
 * (missing/undecryptable credentials) flows into the same failure
 * handling — auth errors pause the account, everything else retries.
 */
async function executeOperation(
  provider: EmailProvider,
  op: QueueOperation,
  resolveAdmin: () => Promise<LabelAdminService>
): Promise<void> {
  switch (op.kind) {
    case "send":
      await provider.sendMessage(op.input)
      return
    case "archive":
      await provider.archive(op.refs)
      return
    case "trash":
      await provider.trash(op.refs)
      return
    case "mark_read":
      await provider.markRead(op.refs, true)
      return
    case "mark_unread":
      await provider.markRead(op.refs, false)
      return
    case "star":
      await provider.markStarred(op.refs, true)
      return
    case "unstar":
      await provider.markStarred(op.refs, false)
      return
    case "add_labels":
      await provider.addLabels(op.refs, op.labelIds)
      return
    case "remove_labels":
      await provider.removeLabels(op.refs, op.labelIds)
      return
    case "move":
      await provider.moveToFolder(op.refs, op.destinationFolder)
      return
    case "delete_forever":
      await provider.deleteForever(op.refs)
      return
    case "not_spam":
      // Gmail semantics via the label surface: leave Junk, re-enter Inbox.
      // (imap accounts have no server labels — the composition layer
      // queues a `move` for them instead.)
      await provider.removeLabels(op.refs, ["SPAM"])
      await provider.addLabels(op.refs, ["INBOX"])
      return
    case "create_label":
    case "rename_label":
    case "delete_label":
    case "create_folder":
    case "rename_folder":
    case "delete_folder":
      // Idempotent replay classification lives in executeLabelAdminOperation
      // (already-exists / not-found count as applied).
      await executeLabelAdminOperation(await resolveAdmin(), op)
      return
  }
}

/** Exponential backoff: base · 2^(attempts−1), capped. The first retry
 * waits the base delay; attempt 4 and beyond wait the cap. */
function backoffDelayMs(
  attempts: number,
  options: ProcessQueueOptions
): number {
  const base = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS
  return Math.min(base * 2 ** (attempts - 1), MAX_BACKOFF_MS)
}

/** Flatten any thrown value into a storable, credential-free message. */
function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > MAX_ERROR_LENGTH
    ? `${message.slice(0, MAX_ERROR_LENGTH)}…`
    : message
}

// ---- Interval orchestration ----

export interface StartQueueProcessorOptions extends ProcessQueueOptions {
  /** Tick interval; the D10 default is 30 seconds. */
  intervalMs?: number
}

/**
 * Start the background processor: an immediate pass, then one per tick
 * (default 30s). Idempotent — a second call while running is a no-op, so
 * StrictMode double-init and re-chaining are safe.
 */
export function startQueueProcessor(
  options: StartQueueProcessorOptions = {}
): void {
  if (intervalHandle !== null) return
  activeOptions = options
  intervalHandle = setInterval(() => {
    void processQueue(activeOptions)
  }, options.intervalMs ?? DEFAULT_INTERVAL_MS)
  // Drain whatever accumulated before startup without waiting a tick.
  void processQueue(activeOptions)
}

/** Stop the background interval. In-flight and triggered runs complete. */
export function stopQueueProcessor(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}

/**
 * Kick an out-of-band pass (the online-event trigger). Coalesces with any
 * in-flight run via processQueue single-flight.
 */
export function triggerQueueProcessing(): Promise<QueueRunResult> {
  return processQueue(activeOptions)
}

/**
 * Resume a paused account's queued operations after re-auth (task 5.6).
 * Called with no argument to resume every paused account (also used by
 * shutdownQueueSystem for clean teardown).
 */
export function resumeAccountOperations(accountId?: string): void {
  if (accountId === undefined) pausedAccounts.clear()
  else pausedAccounts.delete(accountId)
}

/** True while the account's queue is paused for this session. */
export function isAccountPaused(accountId: string): boolean {
  return pausedAccounts.has(accountId)
}
