import { invoke } from "@tauri-apps/api/core"

import type { SqlExecutor } from "../db/executor"
import type { FetchImpl } from "../email/token-manager"
import { bytesToBase64 } from "../email/mime-builder"
import { enqueueSend } from "../queue/operation"
import type { SendEmailInput } from "../email/types"
import { useOnlineStore } from "../../stores/online-store"
import {
  caldavEventResourcePath,
  putCaldavEvent,
  unsealCaldavConfig,
} from "./caldav"
import {
  createMicrosoftCalendarTokens,
  getMicrosoftEvent,
  respondToMicrosoftEvent,
} from "./microsoft-calendar"
import {
  buildIcsReply,
  replyRequestFromInvite,
} from "./ics-reply"
import type { IcsReplyBuildRequest } from "./ics-reply"
import { unfoldIcsLines, type IcsEvent } from "./ics"
import { parseInviteCalendar } from "./invites"
import { getCalendarSource } from "./sources"
import type { CalendarSource } from "./sources"
import { respondToGoogleInvitation } from "./event-writes"

/**
 * The RSVP flow (parity-round-3 task 8.3, design D5): ONE entry point
 * the meeting card's Accept/Tentative/Decline buttons call, for all
 * three account families.
 *
 * Ordering is the spec's failure contract, made concrete:
 *
 *   1. STAMP the chosen answer locally (`calendar_events.partstat` on
 *      the matched row) — the answer is durable BEFORE any network.
 *   2. Calendar WRITE-BACK per source family:
 *        - microsoft → the Graph RSVP actions (accept/decline/
 *          tentativelyAccept, sendResponse:false);
 *        - google    → the existing events.PATCH of this user's
 *          `attendees[].responseStatus` (respondToGoogleInvitation);
 *        - caldav    → PUT the updated attendee PARTSTAT to the event
 *          resource (the .ics blob IS the state).
 *      A write-back FAILURE never loses the answer (it is already
 *      stamped) and is reported per-part — the REPLY still goes out.
 *   3. The iCalendar REPLY mail to the organizer through the NORMAL
 *      send pipeline: the built blob rides `enqueueSend` as the
 *      attachment of a queued `send` op — offline it waits in
 *      pending_operations; a transmission failure parks the op as the
 *      standard retryable failed send (the composer's failed-send
 *      surface lists and retries it). The REPLY carries RECURRENCE-ID
 *      when the user scoped the answer to one occurrence.
 *
 * The Rust `ics_build_reply` command builds the wire blob (the grammar
 * authority, design D5) with the TS twin (`ics-reply.ts`) as fallback
 * when the command is unreachable — byte-identical, pinned by fixture.
 *
 * Occurrence-vs-series: `scope: "occurrence"` addresses the matched
 * occurrence row (Graph: its own cached event id; CalDAV: the PUT
 * carries RECURRENCE-ID; Google's cache stores series masters, so the
 * PATCH answers the series and the REPLY mail carries the occurrence
 * scope — documented per-family behavior). Default: whole series.
 */

/** The card's answer union (structurally the seam's InvitationAnswer). */
export type RsvpAnswer = "yes" | "no" | "maybe"

/** Which part of a recurring meeting the answer addresses. */
export type RsvpScope = "series" | "occurrence"

const ANSWER_PARTSTAT: Record<RsvpAnswer, string> = {
  yes: "ACCEPTED",
  no: "DECLINED",
  maybe: "TENTATIVE",
}

const ANSWER_SUBJECT: Record<RsvpAnswer, string> = {
  yes: "Accepted",
  no: "Declined",
  maybe: "Tentative",
}

/**
 * The human badge label for a stored PARTSTAT — the ONE mapping the
 * mail-side meeting card and the calendar event-details surface share
 * (spec: the event details mirror the mail-side card).
 */
export function rsvpAnswerLabel(partstat: string): string {
  switch (partstat.toUpperCase()) {
    case "ACCEPTED":
      return "Accepted"
    case "TENTATIVE":
      return "Tentative"
    case "DECLINED":
      return "Declined"
    default:
      return "Awaiting reply"
  }
}

/** The badge tint per stored PARTSTAT (same token palette as the auth
 * badge; success green / amber / destructive / neutral). */
export function rsvpAnswerBadgeClass(partstat: string): string {
  switch (partstat.toUpperCase()) {
    case "ACCEPTED":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-500"
    case "TENTATIVE":
      return "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-500"
    case "DECLINED":
      return "border-destructive/30 bg-destructive/10 text-destructive"
    default:
      return "border-border bg-muted/50 text-muted-foreground"
  }
}

/** Per-part outcome of one RSVP click (typed, never a throw). */
export interface RsvpOutcome {
  ok: boolean
  /** The calendar write-back part; `skipped` = nothing connected. */
  writeBack:
    | { status: "applied" }
    | { status: "skipped" }
    | { status: "failed"; reason: string; message: string }
  /** The REPLY-mail part (queued = durably in the send pipeline). */
  reply:
    | { status: "queued"; opId: string }
    | { status: "failed"; reason: string; message: string }
}

/** Injectable seams (tests): the REPLY builder and the transport. */
export interface RsvpDeps {
  fetchImpl?: FetchImpl
  /** Overrides the REPLY blob builder (the Rust command is default). */
  buildReply?: (
    request: IcsReplyBuildRequest
  ) => Promise<string> | string
}

/**
 * The default REPLY builder: the Rust grammar authority first, the TS
 * twin on any bridge failure (vitest realms, mock dev mode).
 */
export async function defaultBuildReply(
  request: IcsReplyBuildRequest
): Promise<string> {
  try {
    return await invoke<string>("ics_build_reply", { request })
  } catch {
    return buildIcsReply(request)
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Stamp the answer on one local row — the durable chosen answer. */
async function stampPartstat(
  executor: SqlExecutor,
  rowId: string,
  partstat: string
): Promise<void> {
  await executor.execute(
    "UPDATE calendar_events SET partstat = $1 WHERE id = $2",
    [partstat, rowId]
  )
}

// ---------------------------------------------------------------------------
// Per-family write-backs
// ---------------------------------------------------------------------------

/** Graph: accept/decline/tentative on the exact event id. */
async function writeBackMicrosoft(
  executor: SqlExecutor,
  source: CalendarSource,
  eventId: string,
  scope: RsvpScope,
  answer: RsvpAnswer,
  fetchImpl: FetchImpl
): Promise<void> {
  const tokens = await createMicrosoftCalendarTokens(
    executor,
    source,
    fetchImpl
  )
  let addressId = eventId
  if (scope === "series") {
    // An occurrence id does not accept series-wide RSVP actions —
    // resolve the cached row's series master when it is an occurrence.
    try {
      const addressing = await getMicrosoftEvent(tokens, eventId, fetchImpl)
      if (addressing?.seriesMasterId) addressId = addressing.seriesMasterId
    } catch {
      // The event may be gone (organizer cancelled) — the RSVP action
      // below surfaces that as its own typed failure.
    }
  }
  await respondToMicrosoftEvent(tokens, addressId, answer, fetchImpl)
}

/**
 * Rebuild a CalDAV event blob with THIS attendee's PARTSTAT updated (the
 * .ics blob IS the state — same rule as the event-form writes): the
 * stored ATTENDEE line for the user carries the new PARTSTAT (missing
 * users are appended); an occurrence-scoped answer adds the
 * RECURRENCE-ID line (the RFC 5545 instance-override form CalDAV
 * servers treat as a per-instance update). Exported for tests.
 */
export async function writeBackCaldavAttendee(
  storedIcal: string,
  attendeeEmail: string,
  partstat: string,
  options: { recurrenceId?: string | null } = {}
): Promise<string> {
  const calendar = parseInviteCalendar(storedIcal)
  if (!calendar || calendar.events.length === 0) {
    throw new Error("the stored event resource is not parseable iCalendar")
  }
  const needle = attendeeEmail.trim().toLowerCase()
  let sawEvent = false
  let sawRecurrenceId = false
  let attendeeUpdated = false
  const out: string[] = []
  // RFC 5545 §3.1 folds long lines at 75 octets — ATTENDEE almost always
  // arrives folded, with the mailto: on a continuation line. Match on
  // UNFOLDED logical lines so the user's entry is rewritten in place;
  // emitting the unfolded form back is valid iCalendar (folding is a
  // transport optimization, and our blob stays under CalDAV's limits for
  // realistic attendee counts).
  for (const line of unfoldIcsLines(storedIcal)) {
    if (line === "BEGIN:VEVENT") sawEvent = true
    if (line === "END:VEVENT") sawEvent = false
    if (sawEvent && line.toUpperCase().startsWith("RECURRENCE-ID")) {
      sawRecurrenceId = true
    }
    const isAttendee = sawEvent && line.toUpperCase().startsWith("ATTENDEE")
    if (isAttendee && line.toLowerCase().includes(`mailto:${needle}`)) {
      out.push(line.replace(/PARTSTAT=[^;:]+/i, `PARTSTAT=${partstat}`))
      attendeeUpdated = true
      continue
    }
    out.push(line)
  }
  if (!attendeeUpdated) {
    // The user was not (or no longer) on the attendee list — add them
    // with the chosen answer so the PUT expresses the partstat anyway.
    const endIndex = out.findIndex((line) => line === "END:VEVENT")
    const attendeeLine = `ATTENDEE;PARTSTAT=${partstat}:mailto:${attendeeEmail.trim()}`
    if (endIndex >= 0) out.splice(endIndex, 0, attendeeLine)
    else out.push(attendeeLine)
  }
  if (options.recurrenceId && !sawRecurrenceId) {
    const endIndex = out.findIndex((line) => line === "END:VEVENT")
    const recurrenceLine = `RECURRENCE-ID:${options.recurrenceId}`
    if (endIndex >= 0) out.splice(endIndex, 0, recurrenceLine)
    else out.push(recurrenceLine)
  }
  return out.join("\r\n")
}

/** CalDAV: unseal, rebuild the blob, PUT it to the event resource. */
async function writeBackCaldav(
  executor: SqlExecutor,
  source: CalendarSource,
  target: { uid: string; calendarId: string },
  attendeeEmail: string,
  partstat: string,
  scope: RsvpScope,
  recurrenceId: string | null
): Promise<void> {
  const envelope = await unsealCaldavConfig(source)
  if (!envelope) {
    throw new Error(
      "No stored CalDAV connection details for this source; re-connect it"
    )
  }
  if (!envelope.calendarPaths.includes(target.calendarId)) {
    throw new Error("That calendar is not among the source's connected ones.")
  }
  const rows = await executor.select<{ ical: string | null }>(
    "SELECT ical FROM calendar_events WHERE source_id = $1 AND calendar_id = $2 AND uid = $3",
    [source.id, target.calendarId, target.uid]
  )
  const stored = rows[0]?.ical
  if (!stored) {
    throw new Error("The event resource is not cached locally anymore.")
  }
  const ical = await writeBackCaldavAttendee(
    stored,
    attendeeEmail,
    partstat,
    { recurrenceId: scope === "occurrence" ? recurrenceId : null }
  )
  await putCaldavEvent(
    {
      serverUrl: envelope.serverUrl,
      username: envelope.username,
      appPassword: envelope.appPassword,
    },
    caldavEventResourcePath(target.calendarId, target.uid),
    ical
  )
}

// ---------------------------------------------------------------------------
// The REPLY mail
// ---------------------------------------------------------------------------

/** The queued REPLY mail's input, built from the parsed invite. */
export function buildReplyMailInput(args: {
  accountEmail: string
  accountName?: string | null
  organizer: IcsEvent["organizer"]
  summary: string | null
  answer: RsvpAnswer
  replyIcs: string
  /** Subject echo fallback when the invite carries no SUMMARY. */
  fallbackSubject: string
}): SendEmailInput | null {
  const organizerEmail = args.organizer?.email?.trim() ?? ""
  if (organizerEmail === "") return null
  const subjectBase = args.summary?.trim() || args.fallbackSubject
  const answerLabel = ANSWER_SUBJECT[args.answer]
  return {
    from: {
      email: args.accountEmail,
      ...(args.accountName ? { name: args.accountName } : {}),
    },
    to: [
      {
        ...(args.organizer?.name ? { name: args.organizer.name } : {}),
        email: organizerEmail,
      },
    ],
    subject: `${answerLabel}: ${subjectBase}`,
    textBody:
      `${args.accountEmail} has ${answerLabel.toLowerCase()} this invitation.\r\n\r\n` +
      "The response is attached in iCalendar (METHOD:REPLY) form.",
    attachments: [
      {
        filename: "invite.ics",
        mimeType: "text/calendar; method=REPLY; charset=UTF-8",
        contentBase64: bytesToBase64(new TextEncoder().encode(args.replyIcs)),
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** What one RSVP click needs — the card's detection result, narrowed. */
export interface RsvpTarget {
  /** The meeting's iCalendar UID. */
  uid: string
  /** The parsed invitation event (echo fields for the REPLY). */
  event: IcsEvent
  /** The matched local row, when the calendar is connected. */
  row: {
    rowId: string
    sourceId: string
    provider: string
    uid: string
    calendarId: string
  } | null
}

/**
 * Respond to an invitation (see the module docs for the ordering and
 * per-family behavior). Never throws: both parts answer typed outcomes
 * and `ok` is true when the answer was durably recorded — the stamped
 * partstat, the write-back (when one applied), or the queued REPLY.
 */
export async function respondToInvite(
  executor: SqlExecutor,
  accountId: string,
  target: RsvpTarget,
  answer: RsvpAnswer,
  scope: RsvpScope = "series",
  deps: RsvpDeps = {}
): Promise<RsvpOutcome> {
  const partstat = ANSWER_PARTSTAT[answer]
  const fetchImpl = deps.fetchImpl ?? fetch

  // 1. The chosen answer, durably local BEFORE any network attempt.
  if (target.row) {
    try {
      await stampPartstat(executor, target.row.rowId, partstat)
    } catch (error) {
      // A pure-SQLite failure still must not block the REPLY.
      console.warn("[rsvp] partstat stamp failed", error)
    }
  }

  // 2. Calendar write-back per family — failure NEVER loses the answer.
  let writeBack: RsvpOutcome["writeBack"] = { status: "skipped" }
  if (target.row) {
    writeBack = await writeBackPerFamily(
      executor,
      accountId,
      target,
      answer,
      scope,
      partstat,
      fetchImpl
    )
  }

  // 3. The universal organizer REPLY mail — through the normal send
  // pipeline (offline-queued; transmission failures surface as the
  // standard retryable failed-send rows).
  try {
    const account = await lookupAccount(executor, accountId)
    const buildReply = deps.buildReply ?? defaultBuildReply
    const request = replyRequestFromInvite({
      event: target.event,
      attendee: {
        email: account?.email ?? "",
        ...(account?.display_name ? { name: account.display_name } : {}),
      },
      partstat,
    })
    // A series-scoped answer addresses the MASTER: echoing RECURRENCE-ID
    // would tell the organizer the answer covers one occurrence while
    // the write-backs above applied it to the whole series. The
    // occurrence echo is only for occurrence scope.
    if (scope !== "occurrence") request.recurrenceId = null
    const replyIcs = await buildReply(request)
    const input = buildReplyMailInput({
      accountEmail: account?.email ?? "",
      accountName: account?.display_name ?? null,
      organizer: target.event.organizer,
      summary: target.event.summary,
      answer,
      replyIcs,
      fallbackSubject: "Meeting invitation",
    })
    if (!input) {
      return {
        ok: writeBack.status === "applied",
        writeBack,
        reply: {
          status: "failed",
          reason: "no-organizer",
          message:
            "The invitation carries no organizer address — the answer " +
            "was recorded on your calendar but could not be mailed.",
        },
      }
    }
    const opId = await enqueueSend(executor, accountId, input)
    return { ok: true, writeBack, reply: { status: "queued", opId } }
  } catch (error) {
    return {
      ok: writeBack.status === "applied",
      writeBack,
      reply: {
        status: "failed",
        reason: "failed",
        message: messageOf(error),
      },
    }
  }
}

async function writeBackPerFamily(
  executor: SqlExecutor,
  accountId: string,
  target: RsvpTarget,
  answer: RsvpAnswer,
  scope: RsvpScope,
  partstat: string,
  fetchImpl: FetchImpl
): Promise<RsvpOutcome["writeBack"]> {
  try {
    const source = await getCalendarSource(executor, target.row!.sourceId)
    if (!source) {
      return {
        status: "failed",
        reason: "no-source",
        message: "The calendar source is not connected anymore.",
      }
    }
    if (!useOnlineStore.getState().online) {
      return {
        status: "failed",
        reason: "offline",
        message:
          "You're offline — the calendar was not updated. " +
          "Reconnect and answer again to sync the response.",
      }
    }
    if (source.provider === "microsoft") {
      await writeBackMicrosoft(
        executor,
        source,
        target.row!.uid,
        scope,
        answer,
        fetchImpl
      )
      return { status: "applied" }
    }
    if (source.provider === "google") {
      // Google's Calendar API has no per-instance RSVP on our cached
      // masters — the PATCH answers the series; the REPLY mail (step 3)
      // still carries the occurrence's RECURRENCE-ID.
      const result = await respondToGoogleInvitation(
        executor,
        source,
        target.uid,
        answer,
        { fetchImpl }
      )
      if (result.ok) return { status: "applied" }
      return {
        status: "failed",
        reason: result.reason,
        message: result.message ?? "Google rejected the response.",
      }
    }
    const account = await lookupAccount(executor, accountId)
    await writeBackCaldav(
      executor,
      source,
      { uid: target.row!.uid, calendarId: target.row!.calendarId },
      account?.email ?? "",
      partstat,
      scope,
      target.event.recurrenceId?.raw ?? null
    )
    return { status: "applied" }
  } catch (error) {
    return { status: "failed", reason: "failed", message: messageOf(error) }
  }
}

/** The one account row the flow needs (envelope + CalDAV attendee). */
async function lookupAccount(
  executor: SqlExecutor,
  accountId: string
): Promise<{ email: string; display_name: string | null } | null> {
  const rows = await executor.select<{
    email: string
    display_name: string | null
  }>("SELECT email, display_name FROM accounts WHERE id = $1", [accountId])
  return rows[0] ?? null
}
