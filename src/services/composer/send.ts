import type { ComposerSendPayload } from "../../stores/composer-store"
import { getAccount, type AccountRow } from "../db/accounts"
import { recordContactInteraction } from "../db/contacts"
import type { SqlExecutor } from "../db/executor"
import { getExecutor } from "../db/executor"
import {
  getPendingOperation,
  listOperationsByStatus,
  requeueOperationForRetry,
} from "../db/pending-operations"
import { findLabelsBySpecialUse } from "../db/labels"
import { insertMessage } from "../db/messages"
import {
  insertThread,
  recomputeThreadCaches,
  setThreadFolder,
  setThreadLabels,
} from "../db/threads"
import { generateMessageId, htmlToText } from "../email/mime-builder"
import type { EmailAddress, SendEmailInput } from "../email/types"
import { isOnline } from "../online"
import { enqueueSend, operationFromRow } from "../queue/operation"
import { deleteDraft, deleteDraftByKey } from "./drafts"

/**
 * The send flow (task 8.7, design D10): everything a "Send" click does,
 * as one local-first service call. There is no online/offline branch —
 * EVERY send goes through the pending_operations queue, so both paths are
 * the same code:
 *
 *   1. Validate the composer payload → typed SendValidationError subclasses
 *      (the composer stays open; nothing has been mutated yet).
 *   2. Build the SendEmailInput: from = the account identity, recipients
 *      from the payload, In-Reply-To/References from the reply mode, and a
 *      caller-supplied Message-ID (mime-builder stamps it into the MIME;
 *      the queue replay stays idempotent and the sent copy's Message-ID
 *      header matches the provisional local row — see reconciliation).
 *   3. enqueueSend — the durable op the processor replays when online.
 *   4. recordContactInteraction for every recipient (autocomplete ranking).
 *   5. File the message into the account's Sent view locally: a
 *      provisional thread + message row (provider-aware membership, below)
 *      with no provider ids — server truth catches up on the next sync.
 *   6. Delete the draft (by id or composer key) — spec: sending removes it.
 *   7. Fire onSendCompleted and return {status: "queued"}.
 *
 * Sent filing model: the provisional thread carries the account's
 * sent-role label — gmail: thread_labels membership (setThreadLabels);
 * imap: threads.folder_label_id (setThreadFolder). The message row has
 * gmail_message_id/imap_uid/imap_folder all NULL, which is exactly the
 * "provisional" marker reconcileProvisionalSent matches on when the
 * server copy arrives:
 * - gmail: the next delta/full sync inserts the server copy under its own
 *   server thread; the provisional row is then deleted by the
 *   reconciliation hook in gmail-sync (the thread it emptied is removed).
 * - imap: the sent-folder sync resolves the server copy's thread through
 *   its Message-ID header — which lands it in the provisional thread —
 *   and the provisional row (no uid) is deleted, leaving the real one.
 * Brief duplication between send and the next sync is by design: the
 * local row gives the immediate "shows in Sent" UX the spec requires.
 *
 * Failure model: validation throws before anything mutates. Failures of
 * the local write/enqueue path itself (unexpected — plain SQLite) leave
 * the draft untouched, fire onSendFailed and resolve to
 * {status: "failed", error}. Provider transmission failures are queue
 * territory: the processor re-enqueues up to MAX_OPERATION_ATTEMPTS and
 * then parks the row as terminal 'failed'; the UI surfaces those via
 * listFailedSends + retryFailedSend (below) — this module cannot observe
 * the processor, so terminal send failures are a polled surface, not an
 * event.
 *
 * UI integration (mailbox composer / shell, pure service — no UI here):
 * - onSendCompleted: toast "Message sent", or "Message queued" when
 *   event.queuedOffline is true (offline send — the queue holds it).
 * - onSendFailed: error toast; the composer keeps its content.
 * - listFailedSends: rows for a "failed sends" indicator/menu; each entry
 *   offers retry → retryFailedSend(opId). After a retry the next queue
 *   cycle (interval tick or triggerQueueProcessing) transmits the op.
 */

// ---- Typed errors (the UI maps these to toasts/disabled states) ----

/** Base class of every send-time validation failure. */
export class SendValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SendValidationError"
  }
}

/** No recipients at all — the spec's "fully addressed" gate. */
export class MissingRecipientsError extends SendValidationError {
  constructor() {
    super("Add at least one recipient before sending")
    this.name = "MissingRecipientsError"
  }
}

/**
 * One or more recipient addresses are not sendable. Carries only the
 * COUNT — error text must never echo recipient content (privacy rule).
 */
export class InvalidRecipientError extends SendValidationError {
  readonly count: number

  constructor(count: number) {
    super(
      count === 1
        ? "1 recipient address is not valid"
        : `${count} recipient addresses are not valid`
    )
    this.name = "InvalidRecipientError"
    this.count = count
  }
}

/** Nothing to send: subject and body are both blank/whitespace. */
export class EmptyMessageError extends SendValidationError {
  constructor() {
    super("Write a subject or a message body before sending")
    this.name = "EmptyMessageError"
  }
}

/** The accountId has no row (account removed mid-compose or a bad arg). */
export class SendAccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`account ${accountId} not found; cannot send from it`)
    this.name = "SendAccountNotFoundError"
  }
}

/** retryFailedSend for an op id that no longer exists. */
export class FailedSendNotFoundError extends Error {
  constructor(opId: string) {
    super(`queued send ${opId} not found`)
    this.name = "FailedSendNotFoundError"
  }
}

/** retryFailedSend for an op that is not parked in terminal 'failed'. */
export class FailedSendNotRetryableError extends Error {
  constructor(opId: string, status: string) {
    super(`queued send ${opId} is ${status}, not failed; nothing to retry`)
    this.name = "FailedSendNotRetryableError"
  }
}

// ---- Change notification (same listener pattern as email-actions) ----

export interface SendCompletedEvent {
  accountId: string
  /** pending_operations row id carrying the send. */
  opId: string
  /** Local (provisional) thread the sent message was filed into. */
  threadId: string
  /** Generated Message-ID header shared by the queued input and the local row. */
  messageId: string
  /** True when the device was offline at enqueue time — toast "queued". */
  queuedOffline: boolean
}

export interface SendFailedEvent {
  accountId: string
  /** Sanitized error text — counts only, never recipient content. */
  error: string
}

export type SendCompletedListener = (event: SendCompletedEvent) => void
export type SendFailedListener = (event: SendFailedEvent) => void

const completedListeners = new Set<SendCompletedListener>()
const failedListeners = new Set<SendFailedListener>()

/**
 * Subscribe to accepted sends — fired synchronously AFTER the local-first
 * sequence (enqueue, sent filing, draft deletion) has committed. Returns
 * the unsubscribe function. A throwing listener is isolated (logged) so
 * one bad subscriber cannot break the send flow.
 */
export function onSendCompleted(listener: SendCompletedListener): () => void {
  completedListeners.add(listener)
  return () => {
    completedListeners.delete(listener)
  }
}

/**
 * Subscribe to send-flow failures of the enqueue path itself (provider
 * transmission failures are NOT here — those surface through
 * listFailedSends once the processor parks the op as terminal 'failed').
 */
export function onSendFailed(listener: SendFailedListener): () => void {
  failedListeners.add(listener)
  return () => {
    failedListeners.delete(listener)
  }
}

function emitCompleted(event: SendCompletedEvent): void {
  for (const listener of completedListeners) {
    try {
      listener(event)
    } catch (error) {
      console.error("[composer-send] onSendCompleted listener failed", error)
    }
  }
}

function emitFailed(event: SendFailedEvent): void {
  for (const listener of failedListeners) {
    try {
      listener(event)
    } catch (error) {
      console.error("[composer-send] onSendFailed listener failed", error)
    }
  }
}

// ---- sendComposerDraft ----

/**
 * What the send flow needs from the composer. `payload` is exactly the
 * shape getComposerPayload() returns (ComposerSendPayload); `mode` is the
 * subset of the store's ComposerMode that affects headers — the store's
 * reply/forward modes are structurally assignable as-is.
 */
export interface SendComposerMode {
  kind: "new" | "reply" | "forward"
  /** RFC 5322 Message-ID being replied to ("<id@host>"). */
  inReplyTo?: string
  /** Space-separated References chain, oldest first. */
  references?: string
  sourceMessageId?: string
  sourceThreadId?: string
}

export interface SendComposerDraftArgs {
  /** Defaults to the shared app executor (getExecutor()); tests inject. */
  executor?: SqlExecutor
  accountId: string
  /** getComposerPayload() output: {to, cc, bcc, subject, htmlBody, textBody}. */
  payload: ComposerSendPayload
  /** Draft row id (from the autosave hook / getDraft) — deleted on send. */
  draftId?: string
  /** Composer instance key — deleted on send when no draftId is known. */
  draftKey?: string
  /** Reply/forward context supplying In-Reply-To/References headers. */
  mode?: SendComposerMode
}

export type SendComposerDraftResult =
  | ({ status: "queued" } & SendCompletedEvent)
  | { status: "failed"; error: string }

/**
 * Send the composed message (see the module comment for the full flow).
 * Resolves to {status: "queued"} once the message is durably queued and
 * filed into Sent — never throws for validation (typed errors) — and to
 * {status: "failed", error} when the local write path itself failed (the
 * draft is kept; onSendFailed has fired).
 */
export async function sendComposerDraft(
  args: SendComposerDraftArgs
): Promise<SendComposerDraftResult> {
  const { accountId, payload, mode } = args
  validatePayload(payload)

  const executor = args.executor ?? getExecutor()
  const account = await getAccount(executor, accountId)
  if (!account) throw new SendAccountNotFoundError(accountId)

  const messageId = generateMessageId(account.email)
  const input = buildSendEmailInput(account, payload, mode, messageId)

  try {
    // D10 ordering: the queue op first (the user's intent, durably held),
    // then the local bookkeeping. A failure from here on keeps the draft.
    const opId = await enqueueSend(executor, accountId, input)
    await recordContactInteraction(
      executor,
      accountId,
      payload.to.concat(payload.cc, payload.bcc)
    )
    const threadId = await fileIntoSent(
      executor,
      account,
      payload,
      mode,
      messageId
    )
    await deleteComposedDraft(executor, accountId, args)

    const event: SendCompletedEvent = {
      accountId,
      opId,
      threadId,
      messageId,
      queuedOffline: !isOnline(),
    }
    emitCompleted(event)
    return { status: "queued", ...event }
  } catch (error) {
    const message = sanitizeError(error)
    emitFailed({ accountId, error: message })
    return { status: "failed", error: message }
  }
}

// ---- Validation ----

/**
 * Pragmatic sendable-address check (same rule as the composer's
 * address-validation UI, kept local so the service layer does not depend
 * on components): dot-atom local part, dot-separated domain labels with an
 * alphabetic TLD of 2+ letters.
 */
const EMAIL_PATTERN =
  /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/

function isSendableAddress(address: string): boolean {
  return EMAIL_PATTERN.test(address.trim())
}

/**
 * Send gates, in spec order: at least one recipient across To/Cc/Bcc,
 * every address sendable, and non-empty subject-or-body. Throws the typed
 * SendValidationError subclasses; nothing has been mutated when they fly.
 */
function validatePayload(payload: ComposerSendPayload): void {
  const recipients = payload.to.concat(payload.cc, payload.bcc)
  if (recipients.length === 0) throw new MissingRecipientsError()

  const invalidCount = recipients.filter(
    (recipient) => !isSendableAddress(recipient.email)
  ).length
  if (invalidCount > 0) throw new InvalidRecipientError(invalidCount)

  if (
    payload.subject.trim() === "" &&
    payload.htmlBody.trim() === "" &&
    (payload.textBody ?? "").trim() === ""
  ) {
    throw new EmptyMessageError()
  }
}

// ---- SendEmailInput construction ----

/** Recipient chips → provider addresses (trimmed; validated already). */
function toEmailAddresses(
  recipients: ComposerSendPayload["to"]
): EmailAddress[] {
  return recipients.map((recipient) => ({
    email: recipient.email.trim(),
    ...(recipient.name !== undefined ? { name: recipient.name } : {}),
  }))
}

function buildSendEmailInput(
  account: AccountRow,
  payload: ComposerSendPayload,
  mode: SendComposerMode | undefined,
  messageId: string
): SendEmailInput {
  const input: SendEmailInput = {
    from: {
      email: account.email,
      ...(account.display_name ? { name: account.display_name } : {}),
    },
    to: toEmailAddresses(payload.to),
    subject: payload.subject,
    // Caller-supplied Message-ID (operation.ts): makes a replayed queued
    // send deduplicateable and lets reconciliation match the server copy.
    messageId,
  }
  if (payload.cc.length > 0) input.cc = toEmailAddresses(payload.cc)
  if (payload.bcc.length > 0) input.bcc = toEmailAddresses(payload.bcc)
  if (payload.htmlBody.trim() !== "") input.htmlBody = payload.htmlBody
  // Task 8.5: the payload already carries base64-encoded attachments from
  // getComposerPayload — pass them through to the queued input untouched.
  if (payload.attachments?.length) input.attachments = payload.attachments
  const text = plainTextBody(payload)
  if (text !== "") input.textBody = text
  if (mode?.kind === "reply") {
    if (mode.inReplyTo) input.inReplyTo = mode.inReplyTo
    if (mode.references) input.references = mode.references
  }
  return input
}

/** The payload's text part, generated from the HTML when absent (same
 * rule the composer store uses for getComposerPayload). */
function plainTextBody(payload: ComposerSendPayload): string {
  if (payload.textBody !== undefined && payload.textBody.trim() !== "") {
    return payload.textBody
  }
  if (payload.htmlBody.trim() === "") return ""
  return htmlToText(payload.htmlBody)
}

// ---- Local Sent filing ----

/** Preview cap matching the sync engines' buildSnippet. */
const SNIPPET_LENGTH = 200

/** Collapse the text part into a 200-char one-line preview. */
function buildSnippet(text: string): string | undefined {
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed ? collapsed.slice(0, SNIPPET_LENGTH) : undefined
}

/**
 * Insert the provisional thread + message for a just-sent message and
 * wire it into the account's Sent view:
 * - gmail: thread_labels membership of the sent-role label (setThreadLabels
 *   also rebuilds the folder caches — the thread is "archived" in gmail
 *   terms, exactly like server-sent mail which carries no INBOX label).
 * - imap: threads.folder_label_id = the sent folder (setThreadFolder).
 * When the account has no synced sent-role label yet (labels never
 * synced), the message still files — it surfaces in Sent after the next
 * label+folder sync rebuilds membership.
 */
async function fileIntoSent(
  executor: SqlExecutor,
  account: AccountRow,
  payload: ComposerSendPayload,
  mode: SendComposerMode | undefined,
  messageId: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const sentLabels = await findLabelsBySpecialUse(executor, account.id, "sent")
  const sentLabel = sentLabels[0] ?? null

  const text = plainTextBody(payload)
  const subject = payload.subject
  const threadId = crypto.randomUUID()
  await insertThread(executor, {
    id: threadId,
    accountId: account.id,
    subject: subject === "" ? undefined : subject,
    snippet: buildSnippet(text),
    firstMessageAt: now,
    lastMessageAt: now,
    ...(account.type === "imap" && sentLabel
      ? { folderLabelId: sentLabel.id }
      : {}),
  })

  await insertMessage(executor, {
    id: crypto.randomUUID(),
    threadId,
    accountId: account.id,
    // Provisional on purpose: provider ids stay unset so the sync-side
    // reconcileProvisionalSent hook can recognize the row (see module
    // comment). The server copy replaces it on the next sync.
    messageIdHeader: messageId,
    inReplyTo: mode?.kind === "reply" ? mode.inReplyTo : undefined,
    referencesHeader: mode?.kind === "reply" ? mode.references : undefined,
    subject: subject === "" ? undefined : subject,
    fromName: account.display_name ?? undefined,
    fromAddress: account.email,
    to: payload.to,
    cc: payload.cc,
    bcc: payload.bcc,
    date: now,
    snippet: buildSnippet(text),
    bodyHtml: payload.htmlBody === "" ? undefined : payload.htmlBody,
    bodyText: text === "" ? undefined : text,
    isRead: true,
  })

  await recomputeThreadCaches(executor, threadId)
  if (sentLabel) {
    if (account.type === "gmail") {
      await setThreadLabels(executor, threadId, [sentLabel.id])
    } else {
      await setThreadFolder(executor, threadId, sentLabel.id)
    }
  }
  return threadId
}

/** Remove the sent draft by row id or composer key (spec: sending removes
 * the draft); neither id present (send without autosave) is a no-op. */
async function deleteComposedDraft(
  executor: SqlExecutor,
  accountId: string,
  args: SendComposerDraftArgs
): Promise<void> {
  if (args.draftId !== undefined) {
    await deleteDraft(executor, args.draftId)
    return
  }
  if (args.draftKey !== undefined) {
    await deleteDraftByKey(executor, accountId, args.draftKey)
  }
}

/** Flatten any thrown value into a storable, recipient-free message. */
function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 500 ? `${message.slice(0, 500)}…` : message
}

// ---- Failed-send retry surface (terminal 'failed' queue rows) ----

/** UI-facing view of one parked send. Counts only — no recipient emails. */
export interface FailedSendView {
  /** pending_operations.id — pass to retryFailedSend. */
  opId: string
  accountId: string
  seq: number
  attempts: number
  lastError: string | null
  /** Subject line of the queued message (display only). */
  subject: string | null
  /** How many addresses the message carries (To+Cc+Bcc). */
  recipientCount: number
  createdAt: number
  updatedAt: number
}

/**
 * Terminal 'failed' send ops for one account (the processor's retry cap
 * parked them; they will not replay on their own). This is the UI's
 * source for the failed-send indicator and its per-row Retry affordance.
 */
export async function listFailedSends(
  executor: SqlExecutor | undefined,
  accountId: string
): Promise<FailedSendView[]> {
  const activeExecutor = executor ?? getExecutor()
  const rows = await listOperationsByStatus(activeExecutor, "failed", accountId)
  const views: FailedSendView[] = []
  for (const row of rows) {
    if (row.op_type !== "send") continue
    let subject: string | null = null
    let recipientCount = 0
    try {
      const op = operationFromRow(row)
      if (op.kind === "send") {
        subject = op.input.subject === "" ? null : op.input.subject
        recipientCount =
          op.input.to.length +
          (op.input.cc?.length ?? 0) +
          (op.input.bcc?.length ?? 0)
      }
    } catch {
      // A corrupt payload still surfaces as a failed row, just undescribed.
    }
    views.push({
      opId: row.id,
      accountId: row.account_id,
      seq: row.seq,
      attempts: row.attempts,
      lastError: row.last_error,
      subject,
      recipientCount,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })
  }
  return views
}

/**
 * Manual retry for one parked send: back to 'pending' with the attempt
 * counter reset, so the processor's next cycle (interval tick or a
 * triggerQueueProcessing() call the UI makes) replays it from scratch.
 * Only terminal 'failed' rows are retryable — pending/processing rows are
 * already in the rotation and 'done' rows have been transmitted.
 */
export async function retryFailedSend(
  executor: SqlExecutor | undefined,
  opId: string
): Promise<void> {
  const activeExecutor = executor ?? getExecutor()
  const row = await getPendingOperation(activeExecutor, opId)
  if (!row) throw new FailedSendNotFoundError(opId)
  if (row.status !== "failed") {
    throw new FailedSendNotRetryableError(opId, row.status)
  }
  await requeueOperationForRetry(
    activeExecutor,
    opId,
    "requeued by manual retry"
  )
  // requeueOperationForRetry leaves the attempt counter at the cap, which
  // would retire the row on its first new attempt — a manual retry starts
  // the budget over. (pending-operations.ts ships no reset helper; this is
  // the single statement it would contain.)
  await activeExecutor.execute(
    "UPDATE pending_operations SET attempts = 0 WHERE id = $1",
    [opId]
  )
}

// ---- Provisional Sent reconciliation (sync-side hook) ----

/**
 * The fields of a just-upserted SERVER message the reconciliation match
 * needs. Structurally satisfied by the MessageInput both sync engines
 * build (gmail-sync/imap-sync call this right after their message
 * upserts), so those call sites pass their input through directly.
 */
export interface ReconcilableSentMessage {
  messageIdHeader?: string | null
  subject?: string | null
  fromAddress?: string | null
  /** unix epoch seconds */
  date?: number | null
}

/**
 * Fallback twin match window (±) for servers that drop/rewrite the
 * Message-ID header: same sender + subject within this many days of the
 * server copy's date. Header matching always runs first and wins.
 */
const DATE_TOLERANCE_SECONDS = 7 * 24 * 60 * 60

/**
 * Delete the composer's provisional Sent rows that this server copy
 * replaces. A provisional row is one the send flow created: NO provider
 * ids at all (gmail_message_id, imap_uid and imap_folder all NULL — no
 * other writer produces such rows), plus either the same Message-ID
 * header (the queued send carries the generated one, and both the Gmail
 * API and SMTP preserve it on the filed copy) or, when the header cannot
 * match, the same sender + subject within the date window. The header
 * path stays exact; the looser fallback deletes at most ONE row per call
 * — the oldest match — so a second same-subject send's provisional row
 * survives to be reconciled by its own server copy later.
 *
 * After deleting, the touched threads' caches are recomputed and threads
 * left with zero messages are removed (the usual case: the provisional
 * thread held only this message).
 *
 * Called additively from gmail-sync and imap-sync right after their
 * message upserts; returns the number of provisional rows removed.
 */
export async function reconcileProvisionalSent(
  executor: SqlExecutor,
  accountId: string,
  serverMessage: ReconcilableSentMessage
): Promise<number> {
  const provisional =
    "gmail_message_id IS NULL AND imap_uid IS NULL AND imap_folder IS NULL"

  // Header match first: the provisional row stores exactly the Message-ID
  // the queued send transmitted (both header spellings, like the sync
  // engines' thread-lookup).
  const header = serverMessage.messageIdHeader?.trim() ?? ""
  const bare = header.replace(/^<+/, "").replace(/>+$/, "").trim()
  let rows: { id: string; thread_id: string }[] = []
  if (bare !== "") {
    rows = await executor.select<{ id: string; thread_id: string }>(
      `SELECT id, thread_id FROM messages
       WHERE account_id = $1 AND ${provisional}
         AND message_id_header IN ($2, $3)`,
      [accountId, bare, `<${bare}>`]
    )
  }

  // Fallback: header missing or rewritten server-side — same sender and
  // subject within the tolerance window around the server copy's date.
  // Constrained to ONE row per call (the oldest match): two same-subject
  // sends inside the window each hold a distinct provisional row, and
  // deleting them all on the first server copy's arrival would destroy
  // the twin that is genuinely still waiting for its own server copy.
  if (
    rows.length === 0 &&
    serverMessage.fromAddress &&
    serverMessage.subject !== undefined &&
    serverMessage.subject !== null &&
    serverMessage.date !== undefined &&
    serverMessage.date !== null
  ) {
    rows = await executor.select<{ id: string; thread_id: string }>(
      `SELECT id, thread_id FROM messages
       WHERE account_id = $1 AND ${provisional}
         AND from_address = $2 AND subject = $3
         AND date BETWEEN $4 AND $5
       ORDER BY date ASC
       LIMIT 1`,
      [
        accountId,
        serverMessage.fromAddress,
        serverMessage.subject,
        serverMessage.date - DATE_TOLERANCE_SECONDS,
        serverMessage.date + DATE_TOLERANCE_SECONDS,
      ]
    )
  }

  if (rows.length === 0) return 0

  for (const row of rows) {
    await executor.execute("DELETE FROM messages WHERE id = $1", [row.id])
  }
  const threadIds = [...new Set(rows.map((row) => row.thread_id))]
  for (const threadId of threadIds) {
    await recomputeThreadCaches(executor, threadId)
  }
  // A provisional thread emptied by the deletion goes away with its
  // thread_labels membership (FK cascade); non-empty threads survive.
  await executor.execute(
    `DELETE FROM threads WHERE id IN (${threadIds
      .map((_, index) => `$${index + 1}`)
      .join(", ")}) AND NOT EXISTS (
      SELECT 1 FROM messages WHERE messages.thread_id = threads.id
    )`,
    threadIds
  )
  return rows.length
}
