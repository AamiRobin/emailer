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
import { getAccount, toEmailAccount, type AccountRow } from "../db/accounts"
import type {
  EmailProvider,
  ProviderCredentials,
  SendEmailInput,
} from "../email/types"
import { ProviderAuthError } from "../email/types"
import { GraphApiError } from "../email/graph-api"
import type { GmailTokenEnvelope } from "../email/token-manager"
import { createTokenSource } from "../email/token-manager"
import { createGmailClient } from "../email/gmail-api"
import { decomposeMimeMessage, stringToBase64Url } from "../email/mime-builder"
import {
  getScheduledSend,
  markScheduledSendFailed,
  markScheduledSendSent,
} from "../db/scheduled-sends"
import {
  buildLabelAdminService,
  executeLabelAdminOperation,
  type LabelAdminService,
} from "../labels/label-admin"
import { postOneClickUnsubscribe } from "../security/unsubscribe"
import { isOnline } from "../online"
import { notifyScheduledSendsChanged } from "../../components/layout/use-scheduled-sends"
import type {
  DraftDeleteOperation,
  DraftUpsertOperation,
  QueueOperation,
  SendMimeOperation,
  UnsubscribePostOperation,
} from "./operation"
import { operationFromRow } from "./operation"
import {
  executeDraftDelete,
  executeDraftUpsert,
  type DraftMirrorDeps,
} from "./draft-mirror"
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
 * - Permanent Graph rejections: a Graph 404 (message gone server-side),
 *   400 or 403 can never succeed on replay — the op completes as terminal
 *   'failed' on the first attempt (error recorded once, no retries) and
 *   the batch continues past it.
 * - Idempotency: flag/label/placement operations are idempotent (see
 *   operation.ts), so replaying after a crash or ambiguous failure is
 *   safe; `send` relies on a caller-supplied Message-ID for deduplication.
 * - Scheduled sends (task 10.2, design D3): the `send_mime` op transmits
 *   a scheduled send's PREBUILT MIME (gmail: messages.send raw; smtp:
 *   documented rebuild from the stored payload) and owns its row's
 *   lifecycle tail — the row goes 'sent' when the op goes 'done', 'failed'
 *   when the op parks at the retry cap, and stays 'sending' while its op
 *   is queued (offline hold, retry backoff, auth pause) or lives again
 *   through the runner's crash reconciliation.
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
  /**
   * Test seam for the prebuilt-MIME send (task 10.2): replaces the whole
   * `send_mime` transmission (gmail raw endpoint / provider rebuild).
   * Never set in production code.
   */
  sendMimeForTest?: (accountId: string, op: SendMimeOperation) => Promise<void>
  /**
   * Test seam for the draft-mirror ops (task 17.x, design D9): replaces
   * the TRANSPORTS only (gmail fetch / imap invoke) while the real
   * draft-mirror execution path runs — account loading, ref bookkeeping
   * and dispatch included. Never set in production code.
   */
  draftMirrorForTest?: DraftMirrorDeps
  /**
   * Test seam for the one-click unsubscribe replay (task 18.3, D13):
   * replaces the RFC 8058 POST only; dispatch and row lifecycle run for
   * real. Never set in production code.
   */
  unsubscribePostForTest?: (
    accountId: string,
    op: UnsubscribePostOperation
  ) => Promise<void>
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
 * order and account groups ordered by their oldest op's seq. The backoff
 * gate is account-wide: if the account's OLDEST pending op (lowest seq
 * among its pending rows) is backoff-gated, the whole account is skipped
 * this cycle and everything behind it waits — a later op must never
 * overtake a gated head (a stale draft_upsert replaying past a newer one
 * would overwrite it; flag/delete orderings would break too). An op
 * deeper in the batch that carries a backoff still stops the batch when
 * the replay reaches it (within-cycle fail-fast + the same head gate on
 * the next cycle).
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
    const group = grouped.get(row.account_id)
    if (group) group.push(row)
    else grouped.set(row.account_id, [row])
  }
  for (const [accountId, group] of grouped) {
    const head = group[0]
    const eligibleAt = head === undefined ? undefined : retryAt.get(head.id)
    if (eligibleAt !== undefined && eligibleAt > nowMs) {
      grouped.delete(accountId)
    }
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

  // The prebuilt-MIME send (task 10.2) is dispatched through this closure:
  // the test seam when set, the real gmail-raw / provider-rebuild path
  // otherwise.
  const transmitMime = (op: SendMimeOperation): Promise<void> =>
    options.sendMimeForTest
      ? options.sendMimeForTest(accountId, op)
      : executeSendMime(executor, provider, accountId, op)

  // The draft-mirror ops (task 17.x) always run the real execution path —
  // only the transports are replaceable (see draftMirrorForTest).
  const executeDraftOp = (
    op: DraftUpsertOperation | DraftDeleteOperation
  ): Promise<void> => {
    const deps = options.draftMirrorForTest ?? {}
    return op.kind === "draft_upsert"
      ? executeDraftUpsert(executor, op, deps)
      : executeDraftDelete(executor, op, deps)
  }

  // The one-click unsubscribe replay (task 18.3): the POST is replaceable
  // for tests (see unsubscribePostForTest); the dispatch is real either way.
  const postUnsubscribe = (op: UnsubscribePostOperation): Promise<void> =>
    options.unsubscribePostForTest
      ? options.unsubscribePostForTest(accountId, op)
      : postOneClickUnsubscribe(op.url)

  for (const row of ops) {
    // Defense in depth for the account-wide FIFO gate: if a mid-batch op
    // somehow carries a live backoff (its retry time is still in the
    // future), stop here — it becomes the account's head and gates the
    // next cycle, so later ops never overtake it.
    const eligibleAt = retryAt.get(row.id)
    if (eligibleAt !== undefined && eligibleAt > Date.now()) return
    await markOperationProcessing(executor, row.id)
    result.attempted += 1
    try {
      await executeOperation(
        provider,
        operationFromRow(row),
        resolveAdmin,
        transmitMime,
        executeDraftOp,
        postUnsubscribe
      )
      await markOperationDone(executor, row.id)
      // Task 10.2: the provider accepted the transmission — stamp the
      // scheduled row 'sent' right after the op goes 'done' (no-op for
      // every other op kind).
      await completeScheduledSend(executor, row, Math.floor(Date.now() / 1000))
      retryAt.delete(row.id)
      result.succeeded += 1
    } catch (error) {
      const stopsBatch = await handleOperationFailure(
        executor,
        accountId,
        row,
        error,
        options,
        result,
        scheduledSendIdOf(row)
      )
      if (stopsBatch) return
    }
  }
}

/**
 * Graph rejections that can NEVER succeed on replay: 404 (the message was
 * moved or deleted on another device — `ErrorItemNotFound`), 400 (the
 * request itself is invalid) and 403 (permission denied). Such an op
 * completes as terminal 'failed' on the FIRST attempt — the error is
 * recorded once, and the batch continues past it — instead of burning the
 * retry budget on backoff noise before landing in the same place.
 */
function isTerminalGraphFailure(error: unknown): boolean {
  return (
    error instanceof GraphApiError &&
    (error.status === 400 || error.status === 403 || error.status === 404)
  )
}

/**
 * Park an operation in terminal 'failed': the error is recorded once, a
 * send_mime op's scheduled row is stamped failed with the same sanitized
 * message, and the batch may continue past the op.
 */
async function finalizeFailedOperation(
  executor: SqlExecutor,
  row: PendingOperationRow,
  message: string,
  result: QueueRunResult,
  scheduledSendId: string | null
): Promise<void> {
  await markOperationFailed(executor, row.id, message)
  // Task 10.2: a send_mime op reaching a terminal state fails its
  // scheduled row with the same sanitized error (the user re-sends
  // manually).
  if (scheduledSendId !== null) {
    const applied = await markScheduledSendFailed(
      executor,
      scheduledSendId,
      message
    )
    // Terminal transition: the Scheduled dialog must re-query (the row
    // left the pending group for the failed history). Best-effort.
    if (applied) notifyScheduledSendsTerminal()
  }
  retryAt.delete(row.id)
  result.failed += 1
}

/**
 * Record one failed execution and decide the batch's fate. Returns true
 * when the account's batch must stop (auth pause or FIFO hold on a
 * transient failure); false when the failed op is terminal (permanent
 * Graph rejection or cap reached) and the batch may continue past it.
 */
async function handleOperationFailure(
  executor: SqlExecutor,
  accountId: string,
  row: PendingOperationRow,
  error: unknown,
  options: ProcessQueueOptions,
  result: QueueRunResult,
  scheduledSendId: string | null = null
): Promise<boolean> {
  const message = sanitizeError(error)
  if (error instanceof ProviderAuthError) {
    // Release the claim and pause the whole account; task 5.6 resumes it
    // after re-auth via resumeAccountOperations(). A scheduled send under
    // a paused account stays 'sending' — its op stays queued and the row
    // is stamped when the resumed replay transmits.
    await requeueOperationForRetry(executor, row.id, message)
    pauseAccount(accountId, result)
    return true
  }
  if (isTerminalGraphFailure(error)) {
    // Permanent Graph rejection (404/400/403): fail-fast terminal on the
    // first attempt — recorded once, no retries.
    await finalizeFailedOperation(executor, row, message, result, scheduledSendId)
    return false
  }
  const attempts = await incrementOperationAttempts(executor, row.id)
  if (attempts >= MAX_OPERATION_ATTEMPTS) {
    await finalizeFailedOperation(
      executor,
      row,
      message,
      result,
      scheduledSendId
    )
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
 *
 * The draft-mirror ops (task 17.x, design D9) dispatch through
 * `executeDraftOp` into queue/draft-mirror.ts: gmail Drafts API create/
 * update/delete, imap APPEND/delete keyed by the local draft row's
 * server_draft_ref. Their setup failures use the same semantics.
 */
async function executeOperation(
  provider: EmailProvider,
  op: QueueOperation,
  resolveAdmin: () => Promise<LabelAdminService>,
  transmitMime: (op: SendMimeOperation) => Promise<void>,
  executeDraftOp: (
    op: DraftUpsertOperation | DraftDeleteOperation
  ) => Promise<void>,
  postUnsubscribe: (op: UnsubscribePostOperation) => Promise<void>
): Promise<void> {
  switch (op.kind) {
    case "send":
      await provider.sendMessage(op.input)
      return
    case "send_mime":
      // Task 10.2: the prebuilt payload is transmitted, never rebuilt
      // (its Date/Message-ID were frozen at schedule time) — see
      // executeSendMime for the per-account-type path.
      await transmitMime(op)
      return
    case "draft_upsert":
    case "draft_delete":
      // Design D9: server draft mirroring behind the queue (offline
      // replay free); dispatched per account type in draft-mirror.ts.
      await executeDraftOp(op)
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
    case "unsubscribe_post":
      // Task 18.3, D13: the queued RFC 8058 one-click POST (enqueued by
      // performUnsubscribe while offline). No provider involvement — the
      // target is an arbitrary https list-owner URL carried by the payload.
      await postUnsubscribe(op)
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

// ---- Prebuilt-MIME send (design D3, task 10.2) ----

/** The scheduled_sends row a send_mime op fires, or null for other ops
 * (or an unparseable payload — the op then just can't stamp a row). */
function scheduledSendIdOf(row: PendingOperationRow): string | null {
  if (row.op_type !== "send_mime") return null
  try {
    const payload = JSON.parse(row.payload_json) as {
      scheduledSendId?: unknown
    }
    return typeof payload.scheduledSendId === "string"
      ? payload.scheduledSendId
      : null
  } catch {
    return null
  }
}

/**
 * Stamp the scheduled row 'sent' right after its op goes 'done' (the
 * provider accepted the transmission). Best-effort honesty: if the app
 * crashes between the two stamps, the runner's reconciliation heals the
 * row from the finished op on the next pass. No-op for other op kinds
 * (and for a row whose guarded stamp did not apply — e.g. a row the user
 * cancelled after its claim; it stays 'cancelled').
 */
async function completeScheduledSend(
  executor: SqlExecutor,
  row: PendingOperationRow,
  nowSeconds: number
): Promise<void> {
  const scheduledSendId = scheduledSendIdOf(row)
  if (scheduledSendId !== null) {
    const applied = await markScheduledSendSent(
      executor,
      scheduledSendId,
      nowSeconds
    )
    // Terminal transition: the Scheduled dialog must re-query (the row
    // left the pending group for the sent history). Best-effort.
    if (applied) notifyScheduledSendsTerminal()
  }
}

/**
 * Tell the Scheduled dialog a send_mime row reached a terminal state
 * (sent or failed). The service→store layering follows the scheduler
 * (D5) and the runner's own notify seam; the queue fires it because the
 * terminal transition can also happen on a later replay cycle (offline
 * holds, retry backoff), outside any runner pass. Best-effort: a broken
 * listener must never fail the queue run.
 */
function notifyScheduledSendsTerminal(): void {
  try {
    notifyScheduledSendsChanged()
  } catch (error) {
    console.warn("queue processor: scheduled-sends notify failed", error)
  }
}

/**
 * Transmit a scheduled send's frozen MIME for one account (task 10.2).
 * Gmail transmits the bytes verbatim through the messages.send raw
 * endpoint — the payload's Date header and Message-ID are exactly what
 * was frozen at schedule time. SMTP has no raw surface (the Rust command
 * builds the message from structured fields), so those accounts rebuild
 * the send input from the stored MIME via the same decompose the edit
 * flow uses: recipients, body, subject and attachments round-trip, the
 * Message-ID / In-Reply-To / References headers are preserved for
 * deduplication and threading, and only Date re-stamps at transmission.
 *
 * Cancel race (the mirror of the runner's guarded claim): the row is
 * re-read immediately before transmission and the send is SKIPPED —
 * treated as applied, no retry — when the row is no longer 'sending'.
 * A row the user cancelled after the due pass claimed it (its op sat
 * queued through an offline hold or retry backoff) must never transmit;
 * the op still completes so it cannot retry, and the guarded
 * 'sending'-only stamps leave the row honestly 'cancelled'.
 */
async function executeSendMime(
  executor: SqlExecutor,
  provider: EmailProvider,
  accountId: string,
  op: SendMimeOperation
): Promise<void> {
  const scheduled = await getScheduledSend(executor, op.scheduledSendId)
  if (scheduled && scheduled.status !== "sending") {
    return
  }
  const row = await getAccount(executor, accountId)
  if (!row) {
    throw new Error(`queued account ${accountId} no longer exists`)
  }
  if (row.type === "gmail") {
    await sendGmailRawMime(row, accountId, op.mime)
    return
  }
  await provider.sendMessage(rebuildSendInputFromMime(row, op.mime))
}

/**
 * Gmail messages.send of the prebuilt MIME: the same client construction
 * createGmailProvider uses internally (encrypted envelope → token source
 * → REST client), exposed here so the queue can fire the frozen payload
 * without routing through a MIME rebuild. Auth-shaped failures surface as
 * ProviderAuthError so the standard account-pause path handles them.
 */
async function sendGmailRawMime(
  row: AccountRow,
  accountId: string,
  mime: string
): Promise<void> {
  if (!row.oauth_client_id) {
    throw new Error(
      `Account ${row.email} (${accountId}) has no oauth_client_id configured`
    )
  }
  const envelope = decryptCredentials<GmailTokenEnvelope>(
    row.credentials_json
  ).catch((error: unknown) => {
    if (error instanceof CredentialDecryptError) {
      throw new ProviderAuthError(
        accountId,
        "gmail",
        "stored credentials could not be decrypted"
      )
    }
    throw error
  })
  const tokenSource = createTokenSource(toEmailAccount(row), envelope)
  const client = createGmailClient({
    accountId,
    getToken: (force) => tokenSource.getToken(force),
  })
  await client.sendMessageRaw(stringToBase64Url(mime))
}

/**
 * One stored header of a message this app's builder wrote: lowercased
 * name → trimmed value, or undefined. Folded headers are UNFOLDED first —
 * the builder folds long encoded-word headers with CRLF + WSP (see
 * mime-builder's encodeHeaderValue), and a folded From header would
 * otherwise parse as a truncated name or a bare address.
 */
function storedHeader(mime: string, name: string): string | undefined {
  const lines = mime.split(/\r\n|\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (line === "") return undefined // end of headers
    const colon = line.indexOf(":")
    if (colon === -1 || line.slice(0, colon).trim().toLowerCase() !== name) {
      continue
    }
    // Unfold: continuation lines (leading WSP) belong to this header.
    // Join with a single space, like decomposeMimeMessage's unfold — the
    // whitespace between two encoded-words is ignored on re-encode.
    let value = line.slice(colon + 1).trim()
    while (index + 1 < lines.length && /^[ \t]/.test(lines[index + 1]!)) {
      index += 1
      value += ` ${lines[index]!.trim()}`
    }
    return value
  }
  return undefined
}

/**
 * The stored MIME's From header parsed back into an address identity
 * (task 16.2 alias follow-up), or null when the header is missing or has
 * no usable address. Handles the exact shapes buildMimeMessage's
 * formatAddress emits: bare address, `Name <addr>`, `"Quoted Name"
 * <addr>` and encoded-word names (kept encoded here — the provider
 * re-encodes through the normal build path; a decoded non-ASCII name
 * would double-encode).
 */
function storedFrom(mime: string): { name?: string; email: string } | null {
  const value = storedHeader(mime, "from")
  if (value === undefined) return null
  const lt = value.lastIndexOf("<")
  const gt = value.lastIndexOf(">")
  if (lt !== -1 && gt !== -1 && gt > lt) {
    const email = value.slice(lt + 1, gt).trim()
    if (!email) return null
    let name = value.slice(0, lt).trim()
    if (name.startsWith('"') && name.endsWith('"')) {
      name = name.slice(1, -1).replace(/\\"/g, '"')
    }
    return { email, ...(name ? { name } : {}) }
  }
  const email = value.trim()
  return email ? { email } : null
}

/**
 * Rebuild the provider send input from a stored MIME payload (SMTP
 * fallback — see executeSendMime). decomposeMimeMessage is the exact
 * inverse the edit flow uses on these payloads; From comes from the
 * account identity (the SMTP envelope sender must be the account), and
 * the threading/dedup headers are preserved from the stored message.
 *
 * The stored MIME's From HEADER rides along as `fromAlias` (design D10):
 * the payload was frozen with the alias the composer had selected, so
 * without this the rebuilt send's header degrades to the account
 * identity. The envelope (`from`) stays the account — MAIL FROM can
 * never diverge from the credentials.
 */
function rebuildSendInputFromMime(
  row: Pick<AccountRow, "email" | "display_name">,
  mime: string
): SendEmailInput {
  const decomposed = decomposeMimeMessage(mime)
  const fromHeader = storedFrom(mime)
  const input: SendEmailInput = {
    from: {
      email: row.email,
      ...(row.display_name ? { name: row.display_name } : {}),
    },
    ...(fromHeader ? { fromAlias: fromHeader } : {}),
    to: decomposed.to,
    subject: decomposed.subject ?? "",
    ...(decomposed.cc.length > 0 ? { cc: decomposed.cc } : {}),
    ...(decomposed.bcc.length > 0 ? { bcc: decomposed.bcc } : {}),
    // The plain-text part rides along (shared contract: decomposeMimeMessage
    // carries textBody since the text-only round-trip fix) — a text/plain-only
    // or PGP/MIME-shaped payload rebuilds with its body, not an empty one.
    ...(decomposed.textBody ? { textBody: decomposed.textBody } : {}),
    ...(decomposed.htmlBody !== null ? { htmlBody: decomposed.htmlBody } : {}),
    ...(decomposed.attachments.length > 0
      ? { attachments: decomposed.attachments }
      : {}),
  }
  const messageId = storedHeader(mime, "message-id")
  const inReplyTo = storedHeader(mime, "in-reply-to")
  const references = storedHeader(mime, "references")
  if (messageId !== undefined) input.messageId = messageId
  if (inReplyTo !== undefined) input.inReplyTo = inReplyTo
  if (references !== undefined) input.references = references
  return input
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
