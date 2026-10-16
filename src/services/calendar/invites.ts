import type { SqlExecutor } from "../db/executor"
import type { MessageRow } from "../db/messages"
import type { EmailAccount } from "../email/types"
import {
  parseIcsCalendar,
  resolveIcsEventEnd,
} from "./ics"
import type { IcsCalendar, IcsEvent, IcsPerson } from "./ics"
import { readFirstCalendarIcs } from "./ics-detect"
import type { AttachmentDeps } from "../attachments"
import { extractJoinLink, type JoinLink } from "./join-links"

/**
 * Meeting-invite detection + linkage (parity-round-3 tasks 8.2/8.4,
 * design D5): the ONE module the reading pane's meeting card asks to
 * (a) decide whether a message IS an invitation (its text/calendar part
 * with METHOD REQUEST/CANCEL semantics), (b) persist the thread
 * linkage — `threads.invite_uid` plus the v20 event fields
 * (sequence/recurrence_id/partstat) stamped on the matching local
 * calendar event rows — and (c) apply organizer CANCELs per source
 * semantics.
 *
 * Detection happens at message open (the card mounts when the message
 * renders expanded; unread mail renders expanded, so newly-arrived
 * invites are detected on first view). Accounts WITHOUT a connected
 * calendar detect fine too — the card then offers reply-by-email only
 * (spec: "No calendar connection").
 *
 * Matching a local event row keys on the iCalendar UID, the Google
 * bare-id twin (`<event-id>@google.com` ↔ `<event-id>`, the same match
 * `respondToGoogleInvitation` uses) — best-effort by design: Graph rows
 * are keyed by Graph event ids and may not match an iCal UID; the card
 * still works reply-by-email then, and the RSVP layer surfaces its own
 * typed no-event failure without losing the answer.
 *
 * Cancellation semantics per source (spec: "mark the matching local
 * event cancelled or remove it according to the source's semantics"):
 * the cancellation NOTICE does not delete anything server-side (the
 * organizer already did) — locally, Graph rows are REMOVED (Graph
 * expresses cancellation by deleting the event from attendee calendars;
 * the next calendarView sync converges), while Google/CalDAV rows keep
 * the cached blob and flip `status` to "cancelled" (both express
 * cancellation as a status).
 */

/** Why the message is not an invitation (typed — tests + logging). */
export type NoInviteReason =
  | "no-calendar-part"
  | "unreadable"
  | "no-event"
  | "no-method"
  | "unsupported-method"

export type DetectedInvite =
  | {
      ok: true
      /** "request" = invitation; "cancel" = organizer cancellation. */
      kind: "request" | "cancel"
      event: IcsEvent
      /** The user's own ATTENDEE entry in the invite, when listed. */
      selfAttendee: IcsPerson | null
      /**
       * The user's CURRENT recorded answer: the linked local row's
       * partstat (the durable truth — survives re-opening), falling
       * back to the invite's own PARTSTAT for this user. Null when
       * neither carries one (a fresh invitation).
       */
      currentPartstat: string | null
      /** The linked local event, when the calendar is connected and a
       * row matched; null for no-calendar accounts. */
      linkedEvent: LinkedEventInfo | null
      /** The extracted join link, when the surfaces carry one. */
      joinLink: JoinLink | null
    }
  | { ok: false; reason: NoInviteReason }

/** The subset of `calendar_events` the card and the RSVP flow need. */
export interface LinkedEventInfo {
  rowId: string
  sourceId: string
  provider: string
  calendarId: string
  /** The provider's event id (the write-back target — Graph ids, Google
   * event ids, CalDAV resource uids). */
  uid: string
  partstat: string | null
  sequence: number | null
  recurrenceId: string | null
}

/** The raw matched row (also the RSVP write-back's target shape). */
export interface EventRow {
  id: string
  source_id: string
  provider: string
  calendar_id: string
  uid: string
  sequence: number | null
  recurrence_id: string | null
  partstat: string | null
}

/** Injectable seams (tests): the .ics text source. */
export interface InviteDeps {
  /** Overrides reading the message's calendar-part text. */
  readIcs?: (executor: SqlExecutor) => Promise<string | null>
  attachmentDeps?: AttachmentDeps
}

const RSVP_METHODS = new Set(["REQUEST", "CANCEL"])

/** The parsed VEVENT that addresses THIS user, if any. */
function selfAttendeeOf(event: IcsEvent, userEmail: string): IcsPerson | null {
  const needle = userEmail.trim().toLowerCase()
  if (needle === "") return null
  return (
    event.attendees.find(
      (attendee) => attendee.email?.trim().toLowerCase() === needle
    ) ?? null
  )
}

/** Google's iCal-UID suffix form: `<event-id>@google.com` ↔ `<event-id>`. */
export function bareUidOf(uid: string): string {
  return uid.includes("@") ? uid.split("@")[0] : uid
}

/**
 * Local event rows carrying this UID across every connected source, the
 * account-linked sources FIRST (a user with the same meeting on two
 * connected calendars answers the one tied to the mail account).
 * Exported for the RSVP layer (it addresses the same rows) and tests.
 */
export async function findMatchingEventRows(
  executor: SqlExecutor,
  accountId: string,
  uid: string
): Promise<EventRow[]> {
  const bare = bareUidOf(uid)
  const rows = await executor.select<EventRow>(
    `SELECT ce.id, ce.source_id, ce.calendar_id, ce.uid, ce.sequence,
            ce.recurrence_id, ce.partstat, cs.provider,
            (cs.account_id = $1) AS linked
       FROM calendar_events ce
       JOIN calendar_sources cs ON cs.id = ce.source_id
      WHERE ce.uid IN ($2, $3)
      ORDER BY linked DESC, ce.source_id ASC, ce.id ASC`,
    [accountId, uid, bare]
  )
  return rows
}

/**
 * Persist the thread linkage + the v20 event fields (task 8.2):
 * `threads.invite_uid` (the card and future thread-list affordances key
 * on it) and — when a local row matched and the invitation is NEWER
 * (higher SEQUENCE, or the row carries no sequence yet) — the invite's
 * sequence/recurrence_id. The user's partstat is stamped ONLY onto rows
 * without one (an existing answer is never overwritten by re-reading
 * the same invitation).
 */
async function persistInviteLinkage(
  executor: SqlExecutor,
  threadId: string,
  uid: string,
  event: IcsEvent,
  rows: EventRow[],
  selfPartstat: string | null
): Promise<void> {
  await executor.execute("UPDATE threads SET invite_uid = $1 WHERE id = $2", [
    uid,
    threadId,
  ])
  for (const row of rows) {
    const inviteIsNewer =
      event.sequence != null &&
      (row.sequence === null || event.sequence > row.sequence)
    if (!inviteIsNewer) continue
    await executor.execute(
      `UPDATE calendar_events
          SET sequence = $1,
              recurrence_id = $2,
              partstat = COALESCE(partstat, $3)
        WHERE id = $4`,
      [
        event.sequence,
        event.recurrenceId?.raw ?? null,
        selfPartstat ?? "NEEDS-ACTION",
        row.id,
      ]
    )
  }
}

/**
 * Apply an organizer METHOD:CANCEL to the matching local rows (task
 * 8.4): Graph rows are REMOVED, Google/CalDAV rows flip to status
 * "cancelled" (module docs). The thread linkage is NOT cleared — the
 * invitation thread must keep showing its cancelled card. Returns the
 * number of rows affected.
 */
export async function applyCancellation(
  executor: SqlExecutor,
  accountId: string,
  uid: string
): Promise<number> {
  const rows = await findMatchingEventRows(executor, accountId, uid)
  let touched = 0
  for (const row of rows) {
    if (row.provider === "microsoft") {
      const result = await executor.execute(
        "DELETE FROM calendar_events WHERE id = $1",
        [row.id]
      )
      touched += result.rowsAffected
    } else {
      const result = await executor.execute(
        `UPDATE calendar_events SET status = 'cancelled' WHERE id = $1`,
        [row.id]
      )
      touched += result.rowsAffected
    }
  }
  return touched
}

/**
 * Detect the invitation carried by `message` (its first text/calendar
 * part), persist the linkage, and answer the typed detection. Never
 * throws — every failure is a typed `{ok: false, reason}` and NOTHING
 * is persisted for non-invites (spec: non-invite messages untouched).
 */
export async function detectInvite(
  executor: SqlExecutor,
  account: EmailAccount,
  message: MessageRow,
  deps: InviteDeps = {}
): Promise<DetectedInvite> {
  let icsText: string | null
  try {
    icsText = deps.readIcs
      ? await deps.readIcs(executor)
      : await readFirstCalendarIcs(executor, account, message, deps.attachmentDeps ?? {})
  } catch (error) {
    console.warn("[invites] calendar-part read failed", error)
    return { ok: false, reason: "unreadable" }
  }
  if (icsText === null) return { ok: false, reason: "no-calendar-part" }

  const parsed = parseIcsCalendar(icsText)
  if (!parsed.ok) return { ok: false, reason: "unreadable" }
  const event = parsed.calendar.events.find((candidate) => candidate.uid)
  if (!event?.uid) return { ok: false, reason: "no-event" }
  const method = parsed.calendar.method
  if (!method) return { ok: false, reason: "no-method" }
  if (!RSVP_METHODS.has(method)) {
    return { ok: false, reason: "unsupported-method" }
  }
  const kind = method === "CANCEL" ? "cancel" : "request"

  const selfAttendee = selfAttendeeOf(event, account.email)
  const selfPartstat = selfAttendee?.partstat ?? null

  // Local linkage — best-effort: a failing db write must never lose the
  // detection itself (the card renders from the parsed part regardless).
  let rows: EventRow[] = []
  try {
    rows = await findMatchingEventRows(executor, account.id, event.uid)
    await persistInviteLinkage(
      executor,
      message.thread_id,
      event.uid,
      event,
      rows,
      selfPartstat
    )
    if (kind === "cancel") {
      await applyCancellation(executor, account.id, event.uid)
    }
  } catch (error) {
    console.warn("[invites] linkage persistence failed", error)
  }

  const linkedEvent: LinkedEventInfo | null = rows[0]
    ? {
        rowId: rows[0].id,
        sourceId: rows[0].source_id,
        provider: rows[0].provider,
        calendarId: rows[0].calendar_id,
        uid: rows[0].uid,
        // The row's partstat is the durable answer; re-reading the same
        // invite after the user responded must keep showing it.
        partstat:
          rows[0].partstat ??
          (kind === "request" ? selfPartstat : null),
        sequence: rows[0].sequence,
        recurrenceId: rows[0].recurrence_id,
      }
    : null

  return {
    ok: true,
    kind,
    event,
    selfAttendee,
    // Cancelled cards render the cancelled state (no answer to show).
    currentPartstat: kind === "cancel" ? null : (linkedEvent?.partstat ?? selfPartstat),
    linkedEvent,
    joinLink: extractJoinLink(event.location, event.description),
  }
}

/**
 * The event's human end for the card: DTEND, else DTSTART + DURATION
 * (the ics.ts fallback), else null.
 */
export function inviteEndSeconds(event: IcsEvent): number | null {
  return resolveIcsEventEnd(event)?.date
    ? Math.floor(resolveIcsEventEnd(event)!.date!.getTime() / 1000)
    : null
}

/** The invite's start in epoch seconds, or null. */
export function inviteStartSeconds(event: IcsEvent): number | null {
  return event.start?.date ? Math.floor(event.start.date.getTime() / 1000) : null
}

/** Exposed for the RSVP layer's uid matching + tests. */
export function parseInviteCalendar(text: string): IcsCalendar | null {
  const parsed = parseIcsCalendar(text)
  return parsed.ok ? parsed.calendar : null
}
