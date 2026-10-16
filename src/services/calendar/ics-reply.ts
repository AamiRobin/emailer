import type { IcsEvent } from "./ics"

/**
 * The iCalendar METHOD:REPLY builder (parity-round-3 task 8.3, design
 * D5) — the TypeScript twin of `src-tauri/src/ics/mod.rs::build_reply`.
 *
 * Rust is the grammar authority (design D5 puts ics parse/build in the
 * `ics/` module); the RSVP flow prefers the Rust command
 * (`ics_build_reply`, a pure JSON-in/string-out command — no SQL, per
 * the DB-stack rule) and falls back to THIS builder when the command is
 * unreachable (vitest realms, mock dev mode, a degraded bridge). The two
 * implementations are pinned BYTE-IDENTICAL by a shared fixture: the
 * Rust test `ics::tests::reply_blob_matches_the_canonical_fixture` and
 * the TS test in `__tests__/ics-reply.test.ts` both assert
 * `CANONICAL_REPLY_FIXTURE` below — change one, change both.
 *
 * Blob shape (RFC 5546 §3.2.3, the attendee's answer):
 *   BEGIN:VCALENDAR / VERSION:2.0 / PRODID / METHOD:REPLY
 *   BEGIN:VEVENT
 *     UID            — the meeting's iCalendar UID, echoed
 *     SEQUENCE       — echoed when known (iTIP §3.2.4)
 *     RECURRENCE-ID  — when the answer scopes to ONE occurrence
 *     DTSTART        — echoed when known (organizer-side object lookup)
 *     ORGANIZER[;CN] — the organizer, CN preserved when known (the
 *                      minimal CALENDARSERVER-organizer respect)
 *     ATTENDEE[;CN];PARTSTAT=…:mailto:… — exactly one: THE replier
 *     SUMMARY        — echoed when known
 *   END:VEVENT / END:VCALENDAR
 * CRLF line breaks, RFC 5545 §3.3.11 TEXT escaping, trailing CRLF.
 */

/** Same PRODID the Rust builder and the event-writes CalDAV blob use. */
export const ICS_PRODID = "-//emailer//Calendar 1.0//EN"

/** One person an echo line needs (the Rust IcsPersonInput mirror). */
export interface IcsReplyPerson {
  email: string
  name?: string | null
}

/** The build request (the Rust IcsReplyRequest mirror). */
export interface IcsReplyBuildRequest {
  /** The meeting's iCalendar UID, echoed verbatim. */
  uid: string
  /** SEQUENCE echoed from the invitation when known. */
  sequence?: number | null
  /** RECURRENCE-ID (raw iCalendar value) for single-occurrence answers. */
  recurrenceId?: string | null
  /** The meeting DTSTART (raw iCalendar value) echoed when known. */
  dtStart?: string | null
  /** The organizer; the REPLY mail is addressed to this person. */
  organizer?: IcsReplyPerson | null
  /** THE RESPONDING ATTENDEE (this user). */
  attendee: IcsReplyPerson
  /** Uppercase PARTSTAT: ACCEPTED / TENTATIVE / DECLINED / NEEDS-ACTION. */
  partstat: string
  /** Echoed SUMMARY when known. */
  summary?: string | null
}

/** RFC 5545 §3.3.11 TEXT escaping (same rule as Rust `escape_text`). */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n")
}

const VALID_PARTSTATS = new Set([
  "ACCEPTED",
  "DECLINED",
  "TENTATIVE",
  "NEEDS-ACTION",
  "DELEGATED",
])

/**
 * Build the METHOD:REPLY blob — byte-identical to the Rust
 * `ics::build_reply` (see the module docs). Throws TypeError on the same
 * invalid inputs the Rust builder rejects (missing UID, unknown PARTSTAT,
 * missing attendee email) so both boundaries agree.
 */
export function buildIcsReply(request: IcsReplyBuildRequest): string {
  const uid = request.uid.trim()
  if (uid === "") {
    throw new TypeError("a meeting UID is required to build a REPLY")
  }
  const partstat = request.partstat.trim().toUpperCase()
  if (!VALID_PARTSTATS.has(partstat)) {
    throw new TypeError(`not a valid PARTSTAT value: ${partstat}`)
  }
  const attendeeEmail = request.attendee.email.trim()
  if (attendeeEmail === "") {
    throw new TypeError("the answering attendee's email is required")
  }

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${ICS_PRODID}`,
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    `UID:${escapeText(uid)}`,
  ]
  if (request.sequence !== undefined && request.sequence !== null) {
    lines.push(`SEQUENCE:${request.sequence}`)
  }
  const recurrenceId = request.recurrenceId?.trim()
  if (recurrenceId) {
    lines.push(`RECURRENCE-ID:${escapeText(recurrenceId)}`)
  }
  const dtStart = request.dtStart?.trim()
  if (dtStart) {
    lines.push(`DTSTART:${escapeText(dtStart)}`)
  }
  const organizerEmail = request.organizer?.email.trim()
  if (organizerEmail) {
    const organizerName = request.organizer?.name?.trim()
    const cn =
      organizerName !== undefined &&
      organizerName !== null &&
      organizerName !== ""
        ? `;CN=${escapeText(organizerName)}`
        : ""
    lines.push(`ORGANIZER${cn}:mailto:${escapeText(organizerEmail)}`)
  }
  const attendeeName = request.attendee.name?.trim()
  const attendeeCn =
    attendeeName !== undefined && attendeeName !== null && attendeeName !== ""
      ? `;CN=${escapeText(attendeeName)}`
      : ""
  lines.push(
    `ATTENDEE${attendeeCn};PARTSTAT=${partstat}:mailto:${escapeText(attendeeEmail)}`
  )
  const summary = request.summary?.trim()
  if (summary) {
    lines.push(`SUMMARY:${escapeText(summary)}`)
  }
  lines.push("END:VEVENT", "END:VCALENDAR")
  // RFC 5545 §3.4: the object ends with CRLF.
  return `${lines.join("\r\n")}\r\n`
}

/**
 * The echo fields the REPLY builder needs from a PARSED invitation
 * VEVENT (the raw iCalendar values ride along for byte-faithful echoes).
 */
export function replyRequestFromInvite(input: {
  event: IcsEvent
  /** The answering user's identity (email required, name best-effort). */
  attendee: IcsReplyPerson
  /** Uppercase PARTSTAT answer. */
  partstat: string
}): IcsReplyBuildRequest {
  const organizer: IcsReplyPerson | null = input.event.organizer
    ? ({
        email: input.event.organizer.email ?? "",
        ...(input.event.organizer.name !== null
          ? { name: input.event.organizer.name }
          : {}),
      } satisfies IcsReplyPerson)
    : null
  return {
    uid: input.event.uid ?? "",
    sequence: input.event.sequence,
    recurrenceId: input.event.recurrenceId?.raw ?? null,
    dtStart: input.event.start?.raw ?? null,
    ...(organizer ? { organizer } : {}),
    attendee: input.attendee,
    partstat: input.partstat,
    summary: input.event.summary,
  }
}
