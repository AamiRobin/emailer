import { useEffect, useState } from "react"
import { addDays, format, set } from "date-fns"

import { setAttachmentBytes } from "@/components/composer/attachment-bytes"
import {
  buildSendEmailInput,
  validateComposerPayload,
} from "@/services/composer/send"
import { deleteDraftByKey } from "@/services/composer/drafts"
import type {
  ComposerAttachment,
  ComposerMode,
  ComposerSendPayload,
  Recipient,
} from "@/stores/composer-store"
import { useComposerStore } from "@/stores/composer-store"
import { getAccount, type AccountRow } from "@/services/db/accounts"
import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import type { EmailAddress } from "@/services/email/types"
import {
  cancelScheduledSend,
  createScheduledSend,
  listScheduledSends,
  parseScheduledRecipients,
  type ScheduledRecipient,
  type ScheduledSendRow,
} from "@/services/db/scheduled-sends"
import {
  base64ToBytes,
  buildMimeMessage,
  decomposeMimeMessage,
  generateMessageId,
} from "@/services/email/mime-builder"

/**
 * Scheduled-sends data plumbing (tasks 10.1/10.3) — the use-snoozed-
 * threads.ts pattern: an injectable SqlExecutor for tests plus a
 * module-level notify seam. The dialog lives in
 * scheduled-sends-dialog.tsx (sidebar entry + dialog), the composer's
 * schedule picker imports the flows below.
 *
 * Every mutation funnels through here so the DB write, the notify and the
 * follow-up stay in lockstep:
 * - scheduleComposerSend (the composer's "Schedule send" pick): runs the
 *   EXACT send gates (validateComposerPayload) and builds the EXACT
 *   payload a Send would (buildSendEmailInput → buildMimeMessage), then
 *   stores it in scheduled_sends and removes the draft — scheduling is
 *   sending's sibling, not a third state. Firing is task 10.2's due pass;
 *   nothing transmits here.
 * - cancelScheduledSendById (the dialog row button): status →
 *   'cancelled', row kept for audit, hidden from the lists.
 * - editScheduledSend (the dialog row button): decomposes the stored MIME
 *   back into composer fields (recipients from the To/Cc/Bcc headers,
 *   HTML body and attachments from the MIME parts) and re-opens the
 *   composer with them, cancelling the row — the schedule is cancelled
 *   until the user re-sends or re-schedules (design D3, task 10.3).
 *
 * Header-vs-flat recipients: scheduled_sends.recipients_json is a flat
 * array (view summary), so the to/cc/bcc split for the round-trip comes
 * from the stored MIME headers — which this app's own builder wrote. If
 * headers cannot be parsed (corrupt payload), the flat list degrades into
 * the To field, and an empty decompose aborts the edit, leaving the
 * schedule intact.
 */

let sectionExecutorOverride: SqlExecutor | null = null

function resolveExecutor(): SqlExecutor {
  return sectionExecutorOverride ?? getExecutor()
}

/** Test hook: run the flows and queries against `executor` (node:sqlite
 * under vitest); pass null to restore the production getExecutor()
 * binding. */
export function setScheduledSendsExecutor(executor: SqlExecutor | null): void {
  sectionExecutorOverride = executor
}

// ---- Refresh seam: the schedule/cancel/edit flows notify subscribers
// after their mutation so the dialog (and the sidebar count) re-query. ----

const scheduledSendsChangedListeners = new Set<() => void>()

/** Tell useScheduledSends subscribers to re-query the scheduled sends. */
export function notifyScheduledSendsChanged(): void {
  for (const listener of scheduledSendsChangedListeners) listener()
}

/**
 * Scheduled sends (pending + sent/failed history) of one account, pending
 * due-ascending first. DB failures render an empty list. Reloads on
 * account switches and on notifyScheduledSendsChanged().
 */
export function useScheduledSends(
  activeAccountId: string | null
): ScheduledSendRow[] {
  const [loaded, setLoaded] = useState<{
    accountId: string | null
    rows: ScheduledSendRow[]
  }>({ accountId: null, rows: [] })
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const invalidate = (): void => setRevision((value) => value + 1)
    scheduledSendsChangedListeners.add(invalidate)
    return () => {
      scheduledSendsChangedListeners.delete(invalidate)
    }
  }, [])
  useEffect(() => {
    if (!activeAccountId) return
    let cancelled = false
    // The promise hop keeps the load (and the no-DB fallback —
    // resolveExecutor() throws outside Tauri) out of the effect body.
    Promise.resolve()
      .then(() =>
        listScheduledSends(resolveExecutor(), activeAccountId, {
          includeHistory: true,
        })
      )
      .then((rows) => {
        if (!cancelled) setLoaded({ accountId: activeAccountId, rows })
      })
      .catch((error) => {
        console.warn("[scheduled-sends] failed to load scheduled sends", error)
        if (!cancelled) setLoaded({ accountId: activeAccountId, rows: [] })
      })
    return () => {
      cancelled = true
    }
  }, [activeAccountId, revision])
  return loaded.accountId === activeAccountId ? loaded.rows : []
}

// ---- Schedule flow (task 10.1) ----

export interface ScheduleComposerSendArgs {
  accountId: string
  /** getComposerPayload() output — built and stored exactly as a Send. */
  payload: ComposerSendPayload
  /** Reply/forward context for the In-Reply-To/References headers. */
  mode: ComposerMode
  /** The composer instance's autosave row — removed on scheduling, like
   * on send (spec: sending removes the draft; scheduling captures it). */
  draftKey?: string
  /** unix epoch seconds */
  dueAt: number
}

export type ScheduleComposerSendResult =
  { status: "scheduled" } | { status: "failed"; error: string }

/**
 * Schedule the composed message for `dueAt`: validate → build the MIME
 * exactly as sendComposerDraft would → persist the row → remove the
 * draft. Never throws; validation or local-write failures resolve to
 * {status: "failed", error} with the composer kept open by the caller.
 */
export async function scheduleComposerSend(
  args: ScheduleComposerSendArgs
): Promise<ScheduleComposerSendResult> {
  try {
    // Same gates as Send: a scheduled send must never be one a plain
    // Send would have rejected.
    validateComposerPayload(args.payload)
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const executor = resolveExecutor()
  try {
    const account = await getAccount(executor, args.accountId)
    if (!account) {
      return {
        status: "failed",
        error: "the account for this message no longer exists",
      }
    }
    // Task 16.2, design D10: the From-picker selection rides into the
    // stored MIME exactly as a Send would build it (buildSendEmailInput →
    // buildMimeMessage renders the alias into the From header) — the 10.2
    // runner transmits the stored bytes verbatim, so the alias must be on
    // them. Read from the store because the composer passes only its
    // payload here; the selection is still live at schedule time (reset()
    // runs only after the schedule succeeded).
    const fromAlias = useComposerStore.getState().fromAlias
    const built = buildMimeMessage(
      buildSendEmailInput(
        account,
        args.payload,
        args.mode,
        generateMessageId(account.email),
        fromAlias
      )
    )
    await createScheduledSend(executor, {
      accountId: args.accountId,
      mimePayload: built.mime,
      recipients: args.payload.to
        .concat(args.payload.cc, args.payload.bcc)
        .map((recipient) => ({
          email: recipient.email.trim(),
          ...(recipient.name !== undefined ? { name: recipient.name } : {}),
        })),
      subject: args.payload.subject,
      dueAt: args.dueAt,
    })
    // Captured in the scheduled row — the draft goes, same rule as send.
    if (args.draftKey !== undefined) {
      await deleteDraftByKey(executor, args.accountId, args.draftKey)
    }
    notifyScheduledSendsChanged()
    return { status: "scheduled" }
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// ---- Cancel + edit flows (task 10.3) ----

/**
 * Cancel a pending scheduled send (the dialog row's X button). Local-only:
 * the stored payload is dropped from every list (row kept for audit).
 */
export async function cancelScheduledSendById(id: string): Promise<boolean> {
  try {
    await cancelScheduledSend(resolveExecutor(), id)
  } catch (error) {
    console.warn("[scheduled-sends] cancel failed", error)
    return false
  }
  notifyScheduledSendsChanged()
  return true
}

/**
 * Narrow optional-email addresses (the parsed MIME headers / flat
 * recipients list) into the composer store's Recipients: entries without
 * a non-empty address are dropped — an addressless recipient is simply
 * invalid, never restoreable.
 */
function toComposerRecipients(addresses: EmailAddress[]): Recipient[] {
  return addresses.flatMap((address) =>
    address.email ? [{ name: address.name, email: address.email }] : []
  )
}

/**
 * Edit a scheduled send (the dialog row's pencil button): decompose the
 * stored payload back into composer fields and open the composer with
 * them, then cancel the row — the schedule stands cancelled until the
 * message is sent or re-scheduled (task 10.3). Attachment bytes are
 * re-registered from the MIME parts, so the restored draft re-sends with
 * its files intact. Resolves false when nothing usable could be restored
 * or the row could not be cancelled (the schedule stays in place, the
 * composer is never opened).
 *
 * Ordering (a failed cancel must never meet an open composer — the row
 * would stay scheduled while the user edits a copy, a double-send):
 * 1. decompose (read-only) — an unusable payload aborts before any
 *    mutation, so "nothing restorable" leaves the schedule intact;
 * 2. cancel the row — cancelScheduledSend reports whether the cancel
 *    applied (status IN ('scheduled','sending')); a false report or a
 *    thrown DB error aborts the edit;
 * 3. only then open the composer and layer the stored content on top.
 * The stored From header (task 16.2) preselects the composer's From
 * alias when it differs from the account's primary address, so a
 * scheduled-from-alias message re-sends from the alias; otherwise the
 * bare account identity is selected.
 */
export async function editScheduledSend(
  row: ScheduledSendRow
): Promise<boolean> {
  const executor = resolveExecutor()
  const decomposed = decomposeMimeMessage(row.mime_payload)
  let to = decomposed.to
  const cc = decomposed.cc
  const bcc = decomposed.bcc
  if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
    // Header parse came up empty — degrade to the flat recipients list.
    to = parseScheduledRecipients(row.recipients_json)
    if (to.length === 0) return false
  }
  const attachmentBytes = decomposed.attachments.map((attachment) =>
    base64ToBytes(attachment.contentBase64)
  )

  // The account for the From-alias comparison; a missing/unreadable row
  // just degrades the alias restore to the bare identity.
  let account: AccountRow | null
  try {
    account = await getAccount(executor, row.account_id)
  } catch {
    account = null
  }

  // Cancel BEFORE the composer opens; see the ordering note above.
  // cancelScheduledSend resolves the applied boolean (the parallel
  // worker's signature); on older builds it resolves void and only a
  // throw reports failure — `applied === false` treats void as success
  // so both shapes behave correctly.
  let cancelled: boolean
  try {
    const applied: unknown = await cancelScheduledSend(executor, row.id)
    cancelled = applied !== false
  } catch (error) {
    console.warn("[scheduled-sends] cancel failed", error)
    cancelled = false
  }
  if (!cancelled) return false
  notifyScheduledSendsChanged()

  const store = useComposerStore.getState()
  // openNew drops any open draft and clears the attachment registry
  // first; the stored content layers on top of the fresh instance.
  store.openNew(row.account_id)
  // Header/flat recipients carry an optional email (EmailAddress); the
  // composer store's Recipient requires one, so entries without a usable
  // address are dropped at this boundary.
  store.setTo(toComposerRecipients(to))
  const ccRecipients = toComposerRecipients(cc)
  if (ccRecipients.length > 0) store.setCc(ccRecipients)
  const bccRecipients = toComposerRecipients(bcc)
  if (bccRecipients.length > 0) store.setBcc(bccRecipients)
  store.setSubject(row.subject ?? decomposed.subject ?? "")
  if (decomposed.htmlBody !== null) store.setHtml(decomposed.htmlBody)
  if (decomposed.attachments.length > 0) {
    const restored: ComposerAttachment[] = decomposed.attachments.map(
      (attachment, index) => ({
        id: crypto.randomUUID(),
        name: attachment.filename,
        size: attachmentBytes[index]!.length,
        ...(attachment.mimeType !== undefined
          ? { mimeType: attachment.mimeType }
          : {}),
      })
    )
    decomposed.attachments.forEach((_, index) => {
      setAttachmentBytes(restored[index]!.id, attachmentBytes[index]!)
    })
    store.addAttachments(restored)
  }
  // Task 16.2: restore the sender identity the message was scheduled
  // with (the MIME From header) so the re-send uses the same alias —
  // openNew reset it to the bare identity, which would silently flip
  // the sender. openNew already set null for the identity case; the
  // explicit branch documents both outcomes.
  const storedFrom = decomposed.from
  if (
    account &&
    storedFrom?.email &&
    storedFrom.email.trim().toLowerCase() !== account.email.trim().toLowerCase()
  ) {
    store.setFromAlias({
      email: storedFrom.email,
      ...(storedFrom.name ? { name: storedFrom.name } : {}),
    })
  } else {
    store.setFromAlias(null)
  }
  return true
}

// ---- Schedule presets (the composer picker's data) ----

/** One send-later preset entry for the schedule picker. */
export interface ScheduleSendPreset {
  /** Stable menu key (tests, identity). */
  id: "tomorrow_morning" | "monday_morning"
  /** Ready-to-render menu label. */
  label: string
  /** Send time, unix epoch seconds (scheduled_sends.due_at units). */
  dueAt: number
}

/** Morning hour for the send-later presets. */
const MORNING_HOUR = 8

/**
 * Compute the send-later presets for `now` (defaults to the current
 * time). Pure: no clock reads, so callers and tests pass their own base
 * time. Both presets are strictly future; the picker appends the custom
 * date/time entry (showCustomPicker).
 */
export function getScheduleSendPresets(now: Date = new Date()): {
  presets: ScheduleSendPreset[]
  showCustomPicker: true
} {
  const atMorningHour = (base: Date): Date =>
    set(base, {
      hours: MORNING_HOUR,
      minutes: 0,
      seconds: 0,
      milliseconds: 0,
    })
  const toUnixSeconds = (date: Date): number =>
    Math.floor(date.getTime() / 1000)

  const tomorrow = atMorningHour(addDays(now, 1))
  // Next Monday strictly after today, at the morning hour.
  let monday = addDays(atMorningHour(now), 1)
  while (monday.getDay() !== 1) monday = addDays(monday, 1)

  return {
    presets: [
      {
        id: "tomorrow_morning",
        label: format(tomorrow, "'Tomorrow' h:mm a"),
        dueAt: toUnixSeconds(tomorrow),
      },
      {
        id: "monday_morning",
        label: format(monday, "'Monday' h:mm a"),
        dueAt: toUnixSeconds(monday),
      },
    ],
    showCustomPicker: true,
  }
}

/** Recipient summary for a row: "a@x, b@y" (names when present). */
export function summarizeRecipients(recipients: ScheduledRecipient[]): string {
  return recipients
    .map((recipient) =>
      recipient.name !== undefined && recipient.name !== ""
        ? `${recipient.name} <${recipient.email}>`
        : recipient.email
    )
    .join(", ")
}
