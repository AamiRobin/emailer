import { notifyScheduledSendsChanged } from "../../components/layout/use-scheduled-sends"
import type { Recipient } from "../../stores/composer-store"
import { useAccountStore } from "../../stores/account-store"
import { useFolderCountsStore } from "../../stores/folder-counts-store"
import { refreshThreadList } from "../../stores/thread-list-store"
import { getAccount } from "../db/accounts"
import {
  listDueScheduledSends,
  markScheduledSendFailed,
  markScheduledSendSending,
  parseScheduledRecipients,
  reconcileSendingScheduledSends,
  getScheduledSend,
  type ScheduledSendRow,
} from "../db/scheduled-sends"
import type { SqlExecutor } from "../db/executor"
import { decomposeMimeMessage, generateMessageId } from "../email/mime-builder"
import type { EmailAddress } from "../email/types"
import { enqueueSendMime } from "../queue/operation"
import { triggerQueueProcessing } from "../queue/processor"
import { fileIntoSent, type SendComposerMode } from "./send"

/**
 * The scheduled-send due pass (design D3, task 10.2): fires every due
 * `scheduled_sends` row through the normal send path and records the
 * outcome. D3 stores the FULLY BUILT MIME payload at schedule time, so
 * firing must transmit those bytes, not rebuild them — a rebuild would
 * re-stamp the Date header (and Message-ID) at wake time.
 *
 * Transmission seam: the due pass enqueues a `send_mime` queue op carrying
 * the frozen payload plus the row id, then runs one queue pass. The queue
 * processor transmits gmail payloads verbatim (messages.send raw) and is
 * the single owner of the row's tail: the row goes 'sent' when the op
 * goes 'done' (provider accepted), 'failed' when the op parks at the
 * retry cap. Feeding due sends through the queue means OFFLINE REPLAY IS
 * FREE: an offline due pass leaves the row honestly 'sending' with the op
 * durably queued, and the 30s queue tick / online-event trigger transmits
 * it when connectivity returns — the same machinery an offline composer
 * send rides.
 *
 * Local Sent copy (parity with an immediate send): the claim also files
 * the row's readable thread/message into the account's Sent view, BEFORE
 * the op is enqueued — the same provisional row sendComposerDraft's
 * fileIntoSent creates (reused directly), decomposed from the frozen
 * MIME, so a fired scheduled send shows up in Sent exactly like a Send
 * click's message. The copy is local-first — it exists offline and never
 * waits for the queue — and transmission does not retract it: an op that
 * parks at the retry cap leaves the copy standing, the same honest local
 * record a terminal-failed immediate send's provisional row leaves (the
 * Scheduled history row still records failed). No server-side Sent work
 * is added here: gmail files sent mail automatically (messages.send, raw
 * endpoint included) and imap sends never appended to a server Sent
 * folder — parity with the immediate path is the bar. The provider ids
 * on the copy stay null, and the next sync's reconcileProvisionalSent
 * replaces it with the server copy, exactly the immediate send's story.
 *
 * Status semantics (the row's full lifecycle):
 *   scheduled → sending   guarded claim (a row cancelled in the race
 *                         simply doesn't fire — cancelScheduledSend only
 *                         ever moves 'scheduled' rows)
 *   sending → sent        only on queue-op completion (or the crash
 *                         reconciliation healing from a done op)
 *   sending → failed      enqueue failure, queue retry cap, or a crash
 *                         reconciliation ("interrupted"); the user
 *                         re-sends manually
 * A 'sending' row with a live op (offline hold, backoff, auth pause) is
 * NOT stale — the queue still owns it. A pass never rejects: per-row
 * errors are isolated into the row's status.
 *
 * Catch-up: there is no launch-specific path — rows whose due passed
 * while the app was closed are simply `due_at <= now` and this same pass
 * fires them at the next tick/launch (bootstrap registers this module as
 * the "scheduled-sends.run" due job and runDueJobsOnce drains it once at
 * startup).
 *
 * Scheduling: single-flight like every pass runner — overlapping calls
 * share the in-flight pass. The refreshes at the bottom mirror the
 * scheduler's post-pass sequence and are best-effort: they must never
 * fail the pass.
 */

/** Due-job registry name bootstrap registers this runner under. */
export const SCHEDULED_SENDS_DUE_JOB = "scheduled-sends.run"

/** What one pass did, for logging/tests. Rows still in flight (offline)
 * count in neither bucket. */
export interface ScheduledSendPassSummary {
  /** Rows that reached 'sent' during this pass. */
  sent: number
  /** Rows that reached 'failed' during this pass (incl. reconciled). */
  failed: number
}

/** Upper bound on error text stored in last_error (send.ts's rule). */
const MAX_ERROR_LENGTH = 500

function sanitizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > MAX_ERROR_LENGTH
    ? `${message.slice(0, MAX_ERROR_LENGTH)}…`
    : message
}

let inFlight: Promise<ScheduledSendPassSummary> | null = null

/**
 * Fire every scheduled send that is due at `now` (unix epoch seconds).
 * Registered as the "scheduled-sends.run" due-job handler at startup and
 * also usable directly (tests pass the executor and clock). Never
 * rejects; returns the outcome counts.
 */
export function runDueScheduledSends(
  executor: SqlExecutor,
  now: number = Math.floor(Date.now() / 1000)
): Promise<ScheduledSendPassSummary> {
  if (inFlight) return inFlight
  inFlight = runPass(executor, now).finally(() => {
    inFlight = null
  })
  return inFlight
}

async function runPass(
  executor: SqlExecutor,
  now: number
): Promise<ScheduledSendPassSummary> {
  const summary: ScheduledSendPassSummary = { sent: 0, failed: 0 }

  // 1. Crash reconciliation first: orphaned 'sending' rows resolve before
  // new claims, so the summary and the dialog reflect one consistent cut.
  const reconciled = await reconcileSendingScheduledSends(executor)
  summary.sent += reconciled.sent
  summary.failed += reconciled.failed

  // 2. Claim and queue every due row, isolating per-row failures.
  const due = await listDueScheduledSends(executor, now)
  const claimed: string[] = []
  // Rows this pass filed a Sent copy for — the thread list must show them
  // whether or not the queue could transmit yet (offline hold).
  let filedCount = 0
  // Rows this pass itself drove terminal by failing their Sent filing or
  // their enqueue — the queue never saw an op for them, so only the pass
  // can announce them.
  let directFailures = 0
  for (const row of due) {
    // Guarded claim: a row cancelled between the select and here keeps
    // its 'cancelled' status and is skipped.
    const isClaimed = await markScheduledSendSending(executor, row.id)
    if (!isClaimed) continue
    claimed.push(row.id)
    try {
      // The Sent copy goes first (D10's local effect before the queue
      // op): a crash between the two writes leaves a 'sending' row the
      // reconciliation fails "interrupted" — with the copy standing, the
      // same record a failed immediate send leaves. The reverse order
      // would lose the copy instead: the replayed op transmits and stamps
      // the row 'sent' with nothing ever filed.
      await fileSentCopy(executor, row)
      filedCount += 1
      await enqueueSendMime(executor, {
        accountId: row.account_id,
        mime: row.mime_payload,
        scheduledSendId: row.id,
      })
    } catch (error) {
      // The op never landed — fail the row so it is not stuck 'sending'
      // (the reconciliation would catch it too; this is the honest,
      // immediate record).
      await markScheduledSendFailed(executor, row.id, sanitizeError(error))
      directFailures += 1
    }
  }

  // 3. One queue pass so online sends transmit now instead of waiting for
  // the 30s tick. Offline the run skips and the queue replays later —
  // that IS the replay mechanism, so this is best-effort by nature.
  if (claimed.length > 0) {
    try {
      await triggerQueueProcessing()
    } catch (error) {
      console.warn("[scheduled-sends] queue pass failed", error)
    }
  }

  // 4. Honest summary: re-read the touched rows after the queue pass.
  for (const id of claimed) {
    const row = await getScheduledSend(executor, id)
    if (row?.status === "sent") summary.sent += 1
    else if (row?.status === "failed") summary.failed += 1
  }

  // 5. UI refreshes (the use-snoozed-threads refreshAfterSnoozeChange
  // sequence): the Scheduled dialog re-queries via its notify seam, and
  // once something actually transmitted the thread list, folder badges
  // and account unread counts catch up. Importing the zustand stores from
  // a service is the accepted layering (scheduler.ts D5). Best-effort —
  // a broken refresh must not fail the pass.
  //
  // What still needs announcing here: only the terminal transitions the
  // pass stamped DIRECTLY (crash-reconciled rows, enqueue failures — no
  // queue op exists to announce those). A claim alone changes nothing the
  // dialog displays (its pending group lists 'scheduled' and 'sending'
  // rows alike), and a send_mime row reaching sent/failed through the
  // queue announces itself at the stamp (processor.ts) — announcing the
  // pass too would fire the seam twice for one transition.
  if (directFailures > 0 || reconciled.sent + reconciled.failed > 0) {
    notifyScheduledSendsChanged()
  }
  // Any filed copy is worth a refresh — an offline pass files Sent rows
  // too, and the folder view must show them without waiting for the
  // queue's eventual replay.
  if (filedCount > 0) {
    await refreshAfterScheduledSend()
  }
  return summary
}

// ---- Local Sent filing (the claim-time copy, see the module doc) ----

/**
 * File the claimed row's readable Sent copy through send.ts's
 * fileIntoSent — the exact helper (and provisional-row semantics) an
 * immediate send uses. The composer payload it files from is decomposed
 * from the row's FROZEN MIME: this app's own builder wrote the payload,
 * so the parts round-trip like they do for the edit flow and the SMTP
 * rebuild — the to/cc/bcc split, alias From, body parts, threading
 * headers and the Message-ID (the reconciliation key when the server
 * copy arrives) all come from what will actually be transmitted. A
 * corrupt payload degrades the same way those paths do: whatever
 * survived is filed, with the row's flat recipients list and stored
 * subject as the fallbacks.
 *
 * Throws on a local write failure (or a vanished account): the caller
 * fails the row — an unfiled copy must not silently transmit.
 */
async function fileSentCopy(
  executor: SqlExecutor,
  row: ScheduledSendRow
): Promise<void> {
  const account = await getAccount(executor, row.account_id)
  if (!account) {
    throw new Error(
      `account ${row.account_id} not found; cannot file the scheduled send`
    )
  }
  const decomposed = decomposeMimeMessage(row.mime_payload)
  const to =
    decomposed.to.length > 0
      ? toRecipients(decomposed.to)
      : parseScheduledRecipients(row.recipients_json)
  // The stored payload's Message-ID is the one the transmission carries;
  // a payload without one (corrupt beyond the header walk) gets a fresh
  // id — fileIntoSent needs the column and nothing else can match anyway.
  const messageId =
    storedHeader(row.mime_payload, "message-id") ??
    generateMessageId(account.email)
  await fileIntoSent(
    executor,
    account,
    {
      to,
      cc: toRecipients(decomposed.cc),
      bcc: toRecipients(decomposed.bcc),
      subject: decomposed.subject ?? row.subject ?? "",
      htmlBody: decomposed.htmlBody ?? "",
      textBody: decomposed.textBody ?? "",
    },
    replyModeFromMime(row.mime_payload),
    messageId,
    aliasFromMime(decomposed.from)
  )
}

/** Header addresses → composer recipients (the edit flow's narrowing:
 * an addressless entry is dropped, never a broken row). */
function toRecipients(addresses: EmailAddress[]): Recipient[] {
  return addresses.flatMap((address) =>
    address.email ? [{ name: address.name, email: address.email }] : []
  )
}

/** The MIME's parsed From header → fileIntoSent's alias shape, or null
 * when the payload carries only the account identity. */
function aliasFromMime(
  from: EmailAddress | null
): { email: string; name?: string } | null {
  const email = from?.email?.trim() ?? ""
  if (!email) return null
  return { email, ...(from?.name !== undefined ? { name: from.name } : {}) }
}

/** The stored threading headers as a reply mode for fileIntoSent, or
 * undefined for a fresh compose (nothing to thread the copy under). */
function replyModeFromMime(mime: string): SendComposerMode | undefined {
  const inReplyTo = storedHeader(mime, "in-reply-to")
  const references = storedHeader(mime, "references")
  if (inReplyTo === undefined && references === undefined) return undefined
  return {
    kind: "reply",
    ...(inReplyTo !== undefined ? { inReplyTo } : {}),
    ...(references !== undefined ? { references } : {}),
  }
}

/**
 * One stored header of the frozen payload: lowercased name → trimmed
 * value, folded headers UNFOLDED first (a long References chain folds).
 * The same shape processor.ts's storedHeader implements for the SMTP
 * rebuild — duplicated rather than imported because the queue's internals
 * are not the runner's surface, and mime-builder's decompose does not
 * expose the threading headers.
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
 * Post-send UI refresh (scheduler.ts's refreshUnreadIndicators minus the
 * OS badge — a send changes no unread state): reload the open thread
 * list, the sidebar folder counts and the account unread counts so the
 * newly filed Sent thread is visible. Best-effort.
 */
async function refreshAfterScheduledSend(): Promise<void> {
  try {
    await Promise.all([
      refreshThreadList(),
      useFolderCountsStore.getState().refreshFolderCounts(),
      useAccountStore.getState().refreshUnreadCounts(),
    ])
  } catch {
    // Cosmetic indicators only.
  }
}
