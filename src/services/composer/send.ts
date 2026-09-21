import type * as OpenPGP from "openpgp"

import type { ComposerSendPayload } from "../../stores/composer-store"
import {
  findEncryptionKeysByEmails,
  getDecryptedPrivateKey,
  getDefaultPrivateKey,
} from "../crypto/pgp-keys"
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
import {
  buildMimeMessagePgp,
  generateMessageId,
  htmlToText,
  type PgpMimeOptions,
} from "../email/mime-builder"
import type { EmailAddress, SendEmailInput } from "../email/types"
import { archiveThread } from "../email-actions/thread-actions"
import { attachReplyFollowUp } from "../email-actions/followups"
import { isOnline } from "../online"
import { playSentSound } from "../notifications/sounds"
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
 *      Task 18.5: when the caller passes `pgp`, the built input is also
 *      transformed into RFC 3156 PGP/MIME at this point (the passphrase
 *      exists only in this call's scope) and the queued op carries the
 *      finished message for verbatim transmission; the LOCAL Sent row is
 *      filed from the plaintext payload so the user's copy stays readable.
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

// ---- PGP send (task 18.5, spec mail-security "PGP send (sign and encrypt)") ----

/**
 * Per-message PGP options (the composer's Sign/Encrypt toggles): what the
 * send flow should do to the MIME after building it. NOT persisted
 * settings — they ride the single send attempt. `passphrase` unlocks the
 * account's default private key for the sign modes; per the pgp-keys.ts
 * discipline it is per-use and never persisted, which is why the
 * transform runs HERE and the queued op carries the finished PGP/MIME
 * (see sendComposerDraft).
 */
export interface PgpSendOptions {
  mode: PgpMimeOptions["mode"]
  /** The signing key's passphrase (sign modes only); optional for
   * encrypt-only sends. */
  passphrase?: string
}

/** Sign requested but the account has no default private key (18.4's
 * key management). The composer surfaces this as a send error. */
export class PgpSigningKeyMissingError extends SendValidationError {
  constructor() {
    super("Add a PGP private key for this account before signing messages")
    this.name = "PgpSigningKeyMissingError"
  }
}

/**
 * Encrypt requested but these recipients have no known public key. Unlike
 * the count-only InvalidRecipientError, the spec (mail-security, "Missing
 * recipient key" scenario) requires NAMING the recipients in the
 * message — that is what lets the user remove them or import their keys.
 */
export class MissingPgpKeysError extends SendValidationError {
  /** The blocked addresses, lowercased, in first-appearance order. */
  readonly emails: string[]

  constructor(emails: string[]) {
    super(`No PGP public key for: ${emails.join(", ")}`)
    this.name = "MissingPgpKeysError"
    this.emails = emails
  }
}

/**
 * Which of `addresses` (recipients only — the sender's own key is
 * best-effort) have no stored encryption-capable public key. The
 * composer's missing-key guard and the send path's backstop share this so
 * both name the same set.
 */
export async function resolveMissingPgpRecipients(
  executor: SqlExecutor,
  accountId: string,
  addresses: readonly string[]
): Promise<string[]> {
  const normalized = [
    ...new Set(
      addresses
        .map((address) => address.trim().toLowerCase())
        .filter((address) => address !== "")
    ),
  ]
  if (normalized.length === 0) return []
  const keys = await findEncryptionKeysByEmails(executor, accountId, normalized)
  return normalized.filter((address) => !keys.has(address))
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
  /**
   * The From-picker alias (task 16.2, design D10): the MIME From HEADER
   * carries this identity while `input.from` remains the envelope. Null/
   * absent = the bare account identity.
   */
  fromAlias?: { email: string; name?: string } | null
  /**
   * PGP send (task 18.5): sign and/or encrypt the message. Absent = a
   * plain send, byte-identical to before this task.
   */
  pgp?: PgpSendOptions
  /**
   * Send & Archive (batch C2): archive this source thread once the send
   * has COMMITTED — i.e. after the enqueue/sent-filing/draft-deletion
   * sequence finished (status "queued"). The composer's split button sets
   * it from the reply/forward mode's sourceThreadId, and because it rides
   * the send args it lands at the correct undo-window hook point too: the
   * expiry transmits these exact args, so the archive happens when the
   * send does — after the window expires, never on cancel, never when
   * validation or the enqueue path failed. An archive failure is logged
   * and never fails the committed send.
   */
  archiveSourceThreadId?: string
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
  validateComposerPayload(payload)

  const executor = args.executor ?? getExecutor()
  const account = await getAccount(executor, accountId)
  if (!account) throw new SendAccountNotFoundError(accountId)

  // Shape-sanitized here, then VERIFIED against the account's aliases
  // table (resolveSendableFromAlias below): the selection came from the
  // From picker, but the row it pointed at can be deleted from settings
  // while still selected — sending a removed From would have Gmail reject
  // the queued send at replay (terminal failed).
  const fromAlias = await resolveSendableFromAlias(
    executor,
    accountId,
    args.fromAlias
  )
  const messageId = generateMessageId(account.email)
  const input = buildSendEmailInput(
    account,
    payload,
    mode,
    messageId,
    fromAlias
  )

  // PGP send (task 18.5, design D11): the sign/encrypt transform runs HERE
  // — after the composer's guards and undo-window decisions, before
  // anything is queued — because the passphrase exists only in this call's
  // scope (pgp-keys.ts: per-use, never persisted), so the queued op must
  // carry the FINISHED PGP/MIME for the processor to transmit verbatim
  // (gmail via messages.send raw; imap via the raw SMTP command). Every
  // provider type carries the prebuilt bytes — a PGP send is never
  // silently downgraded to plaintext. Validation-order like the gates
  // above: key/recipient resolution throws BEFORE any mutation, keeping
  // the draft untouched.
  if (args.pgp) {
    const pgpOptions = await preparePgpOptions(
      executor,
      accountId,
      input,
      args.pgp
    )
    const built = await buildMimeMessagePgp(input, pgpOptions)
    input.pgpMime = built.mime
  }

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
      messageId,
      fromAlias
    )
    await deleteComposedDraft(executor, accountId, args)

    // Follow-up reminders (task 14.2, design D8): attach at ACCEPT time —
    // this line runs for queued-offline sends exactly like online ones,
    // and the undo-send window's real send re-enters through here at
    // expiry, so it is covered too. Replies carry the source thread (the
    // conversation being answered); a reminder due in `mail.followUpDays`
    // attaches there. Fresh composes and forwards attach nothing (the
    // provisional Sent thread is not stable linkage). attachReplyFollowUp
    // never throws — a failed attach must never fail the send.
    await attachReplyFollowUp(executor, accountId, mode)

    const event: SendCompletedEvent = {
      accountId,
      opId,
      threadId,
      messageId,
      queuedOffline: !isOnline(),
    }
    emitCompleted(event)
    // Sent-confirmation chime (task 1.5, settings spec, design D12): the
    // same surface as the UI's "Message sent" toast — an accepted send —
    // and only there: an offline enqueue toasts "Message queued", which
    // is not a sent confirmation. playSentSound consults its own toggle
    // (default off) and never throws.
    if (!event.queuedOffline) void playSentSound()
    // Send & Archive (batch C2): strictly AFTER the send committed (the
    // same archive action the thread list uses — local mutation, provider
    // enqueue, list event). It re-enters on the undo-window expiry path
    // too, because the flag rides the frozen send args. An archive
    // failure never fails the committed send.
    if (args.archiveSourceThreadId) {
      try {
        await archiveThread(executor, accountId, args.archiveSourceThreadId)
      } catch (error) {
        console.warn(
          "[composer-send] send & archive: archiving the source thread failed",
          error
        )
      }
    }
    return { status: "queued", ...event }
  } catch (error) {
    const message = sanitizeError(error)
    emitFailed({ accountId, error: message })
    return { status: "failed", error: message }
  }
}

// ---- PGP transform options (task 18.5) ----

/**
 * Resolve the PGP/MIME options for one send: unlock the account's default
 * private key for the sign modes (the passphrase is per-use — a wrong one
 * surfaces as PgpKeyError before anything is queued) and collect the
 * recipients' public keys for the encrypt modes, throwing
 * MissingPgpKeysError naming whoever lacks one. The SENDER's key is
 * best-effort: when known (18.4 stores the public half of every private
 * key under the account's identity), it is added so the transmitted copy
 * is readable by the user too (encrypt-to-self); the LOCAL sent row is
 * plaintext either way (fileIntoSent stores the composer payload).
 */
async function preparePgpOptions(
  executor: SqlExecutor,
  accountId: string,
  input: SendEmailInput,
  pgp: PgpSendOptions
): Promise<PgpMimeOptions> {
  const wantsSign = pgp.mode === "sign" || pgp.mode === "sign+encrypt"
  const wantsEncrypt = pgp.mode === "encrypt" || pgp.mode === "sign+encrypt"

  let signingKey: OpenPGP.PrivateKey | undefined
  if (wantsSign) {
    if (!pgp.passphrase) {
      throw new SendValidationError(
        "Enter your PGP passphrase to sign this message"
      )
    }
    const key = await getDefaultPrivateKey(executor, accountId)
    if (!key) throw new PgpSigningKeyMissingError()
    signingKey = await getDecryptedPrivateKey(
      executor,
      accountId,
      key.id,
      pgp.passphrase
    )
  }

  let encryptionArmors: string[] | undefined
  if (wantsEncrypt) {
    const recipientAddresses = [
      ...input.to,
      ...(input.cc ?? []),
      ...(input.bcc ?? []),
    ]
      .map((address) => address.email?.trim() ?? "")
      .filter((address) => address !== "")
    const senderAddress = (input.fromAlias ?? input.from).email
      .trim()
      .toLowerCase()
    const keys = await findEncryptionKeysByEmails(executor, accountId, [
      ...recipientAddresses,
      senderAddress,
    ])
    const missing = await resolveMissingPgpRecipients(
      executor,
      accountId,
      recipientAddresses
    )
    if (missing.length > 0) throw new MissingPgpKeysError(missing)
    encryptionArmors = recipientAddresses.map(
      (address) => keys.get(address.toLowerCase())!.armor
    )
    const selfKey = keys.get(senderAddress)
    if (selfKey) encryptionArmors.push(selfKey.armor)
  }

  return {
    mode: pgp.mode,
    ...(signingKey !== undefined ? { signingKey } : {}),
    ...(encryptionArmors !== undefined ? { encryptionArmors } : {}),
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
 * every address sendable, and non-empty subject-or-body-or-attachment.
 * Throws the typed SendValidationError subclasses; nothing has been
 * mutated when they fly. An attachment-only payload is sendable —
 * drafts.ts deliberately keeps attachment-only drafts, so requiring a
 * body here would make them un-sendable.
 *
 * Exported for the schedule-send flow (task 10.1), which runs the exact
 * same gates before it stores the built MIME payload — a scheduled send
 * must never be one a plain Send would have rejected.
 */
export function validateComposerPayload(payload: ComposerSendPayload): void {
  const recipients = payload.to.concat(payload.cc, payload.bcc)
  if (recipients.length === 0) throw new MissingRecipientsError()

  const invalidCount = recipients.filter(
    (recipient) => !isSendableAddress(recipient.email)
  ).length
  if (invalidCount > 0) throw new InvalidRecipientError(invalidCount)

  const hasBody =
    payload.subject.trim() !== "" ||
    payload.htmlBody.trim() !== "" ||
    (payload.textBody ?? "").trim() !== ""
  const hasAttachment = (payload.attachments?.length ?? 0) > 0
  if (!hasBody && !hasAttachment) throw new EmptyMessageError()
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

/**
 * Normalize the From-picker selection: trim + lowercase the address, and
 * drop anything without a usable one (a stale store value must not send a
 * headerless From). Shape only — membership is resolveSendableFromAlias's
 * job.
 */
function sanitizeFromAlias(
  fromAlias: { email: string; name?: string } | null | undefined
): { email: string; name?: string } | null {
  const email = fromAlias?.email.trim().toLowerCase() ?? ""
  if (!email) return null
  return {
    email,
    ...(fromAlias?.name !== undefined ? { name: fromAlias.name } : {}),
  }
}

/**
 * The send-build-time alias gate (sanitizeFromAlias's caller-side
 * wrapper): one SELECT verifies the (lowercased) address is still a row
 * in the account's aliases table. An alias deleted from settings while it
 * was selected falls back to the bare account identity — sending the
 * removed From would fail at the provider (Gmail rejects the send-as at
 * replay → the queued op parks terminal 'failed'). Alias emails are
 * stored lowercase (aliases.ts normalizeAliasEmail), matching the
 * sanitized shape exactly; the executor is at hand so this is a single
 * indexed lookup on the UNIQUE (account_id, email) pair.
 */
async function resolveSendableFromAlias(
  executor: SqlExecutor,
  accountId: string,
  fromAlias: { email: string; name?: string } | null | undefined
): Promise<{ email: string; name?: string } | null> {
  const sanitized = sanitizeFromAlias(fromAlias)
  if (!sanitized) return null
  const rows = await executor.select<{ id: string }>(
    "SELECT id FROM aliases WHERE account_id = $1 AND email = $2 LIMIT 1",
    [accountId, sanitized.email]
  )
  return rows.length > 0 ? sanitized : null
}

/**
 * Build the provider-agnostic SendEmailInput for a composed message:
 * from = the account identity (the ENVELOPE — design D10: MAIL FROM and
 * the Gmail API user stay the authenticated account even when an alias
 * sends), the optional `fromAlias` rides along as the header-only From
 * override, recipients come from the payload, reply headers from the
 * mode, and the caller-supplied Message-ID. Pure and shared with the
 * schedule-send flow (task 10.1), which builds the same input before
 * storing its MIME — the stored payload is byte-identical to what a Send
 * would have transmitted.
 */
export function buildSendEmailInput(
  account: AccountRow,
  payload: ComposerSendPayload,
  mode: SendComposerMode | undefined,
  messageId: string,
  fromAlias?: { email: string; name?: string } | null
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
  if (fromAlias) {
    input.fromAlias = {
      email: fromAlias.email,
      ...(fromAlias.name !== undefined ? { name: fromAlias.name } : {}),
    }
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
 *
 * Also the filing helper the scheduled-send runner reuses (task 10.2): a
 * due row files the same provisional copy at claim time, so a fired
 * scheduled send is readable in Sent exactly like an immediate one.
 */
export async function fileIntoSent(
  executor: SqlExecutor,
  account: AccountRow,
  payload: ComposerSendPayload,
  mode: SendComposerMode | undefined,
  messageId: string,
  fromAlias?: { email: string; name?: string } | null
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const sentLabels = await findLabelsBySpecialUse(executor, account.id, "sent")
  const sentLabel = sentLabels[0] ?? null

  // The provisional row shows the identity the message was SENT with
  // (the alias's From header, task 16.2) — the server copy that replaces
  // it parses the same header, so the fallback reconciliation branch
  // (sender + subject) keeps matching too.
  const senderAddress = fromAlias?.email ?? account.email
  const senderName = fromAlias?.name ?? account.display_name ?? undefined

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
    fromName: senderName,
    fromAddress: senderAddress,
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
