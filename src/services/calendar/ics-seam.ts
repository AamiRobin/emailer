import type { SqlExecutor } from "../db/executor"
import type { FetchImpl } from "../email/token-manager"
import { useOnlineStore } from "../../stores/online-store"
import { parseIcsCalendar, resolveIcsEventEnd } from "./ics"
import type { IcsEvent } from "./ics"
import {
  createEvent,
  defaultWritableCalendarId,
  OFFLINE_WRITE_MESSAGE,
  respondToGoogleInvitation,
} from "./event-writes"
import type { EventWriteInput, EventWriteResult } from "./event-writes"
import { getCalendarSource, listCalendarSources } from "./sources"
import type { CalendarProvider } from "./sources"

/**
 * The .ics → calendar write seam (task 5.5 seam, task 5.4 bodies; design
 * D5) — the ONE module the iCalendar preview dialog calls to (a) discover
 * the calendar sources the event could be added to and (b) perform the
 * add / the invitation response.
 *
 * Task 5.4 replaced the v1 stubs: {@link addIcsEventToCalendar} maps the
 * (already dialog-parsed) first usable VEVENT onto the event-write service
 * (services/calendar/event-writes.ts) and adds it to the chosen source's
 * default calendar; {@link respondToInvitation} routes METHOD:REQUEST
 * answers through the source where it supports them.
 *
 * RSVP SUPPORT MATRIX (spec: "where the source supports them"):
 * - google   → supported, best-effort: the Calendar API has no raw iTIP
 *   REPLY endpoint, so the stored event's `attendees[].responseStatus` is
 *   PATCHed for this user (the event is matched by the invitation's UID in
 *   the local cache — unsynced invitations answer "refresh first"; the
 *   user is identified by the source's linked mail-account email, falling
 *   back to the only attendee). No separate REPLY email is sent (Google
 *   notifies the organizer). See respondToGoogleInvitation.
 * - caldav   → typed `unsupported` in v1: an iTIP REPLY is a
 *   scheduling-transfer (calendar-access PUT of a METHOD:REPLY blob) that
 *   is out of scope for task 5.4 — the UI tells the user to answer by
 *   email instead of pretending a response was sent.
 *
 * Failure contract (typed, never throws — the dialog renders the reason):
 * - "no-source"    nothing (usable) connected, or the listing failed;
 * - "offline"      the explicit online-write failure — no network attempt
 *                  was made and nothing changed (spec "Edit conflict with
 *                  connectivity");
 * - "invalid"      the .ics did not parse;
 * - "no-event"     no usable VEVENT (add) / no UID (respond);
 * - "config"       the chosen source has no writable calendar;
 * - "unsupported"  the source cannot do this operation (CalDAV RSVP);
 * - "failed"       the provider rejected the write / transport failed.
 * "unavailable" remains in the union for the degraded write-layer path.
 *
 * Source discovery now imports the settled task-5.1 sources module
 * directly (the v1 duck-typed lazy glob existed only because 5.1 landed
 * concurrently); any read failure still degrades to [] — never throws.
 */

/** One calendar source the user could add the event to. */
export interface CalendarSourceChoice {
  id: string
  name: string
  provider: CalendarProvider
}

/** Why a write could not happen (typed — the dialog maps these to copy). */
export type IcsWriteFailureReason =
  | "no-source"
  | "offline"
  | "invalid"
  | "no-event"
  | "config"
  | "unsupported"
  | "failed"
  | "unavailable"

/** Result of {@link addIcsEventToCalendar}. */
export type AddIcsEventResult =
  | { ok: true; sourceId: string }
  | { ok: false; reason: IcsWriteFailureReason; message?: string }

/** The user's answer to a METHOD:REQUEST invitation. */
export type InvitationResponse = "yes" | "no" | "maybe"

/** Result of {@link respondToInvitation}. */
export type RespondToInvitationResult =
  | { ok: true; response: InvitationResponse }
  | { ok: false; reason: IcsWriteFailureReason; message?: string }

/** The CalDAV RSVP v1 copy (honest limitation, see the module docs). */
export const CALDAV_RSVP_UNSUPPORTED_MESSAGE =
  "This calendar server does not support in-app invitation responses yet — " +
  "please answer by email."

/** Injectable seams (tests): override source discovery, the event write,
 * the RSVP send, or the transport. */
export interface IcsSeamDeps {
  /** Overrides the source discovery entirely. */
  listSources?: () => Promise<CalendarSourceChoice[]>
  /** Overrides the add-to-calendar write. */
  createEvent?: (
    executor: SqlExecutor,
    input: EventWriteInput
  ) => Promise<EventWriteResult>
  /** Overrides the invitation response send (by source id). */
  respond?: (
    executor: SqlExecutor,
    sourceId: string,
    request: RespondToInvitationRequest
  ) => Promise<RespondToInvitationResult>
  /** Transport seam passed through to the write service. */
  fetchImpl?: FetchImpl
}

/** The request for {@link addIcsEventToCalendar}. */
export interface AddIcsEventRequest {
  /** The raw .ics text (parsed BEFORE the seam — the dialog previews it). */
  ics: string
  /** The source the user picked in the dialog, when one was chosen. */
  preferredSourceId?: string
}

/** The request for {@link respondToInvitation}. */
export interface RespondToInvitationRequest {
  ics: string
  response: InvitationResponse
  preferredSourceId?: string
}

/**
 * Discover the available calendar sources through the task-5.1 sources
 * module (the settled concrete import; see the module docs for why the v1
 * duck-typing is gone). Resolves to [] whenever anything is off — module
 * error, read failure — never throws.
 */
export async function readCalendarSources(
  executor: SqlExecutor
): Promise<CalendarSourceChoice[]> {
  try {
    const sources = await listCalendarSources(executor)
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      provider: source.provider,
    }))
  } catch (error) {
    console.warn("[ics-seam] calendar source lookup failed", error)
    return []
  }
}

/**
 * The dialog-facing source list: the same discovery
 * {@link readCalendarSources} performs, exposed separately so the picker
 * and the write path can share one resolution.
 */
export async function listIcsCalendarSources(
  executor: SqlExecutor,
  deps: IcsSeamDeps = {}
): Promise<CalendarSourceChoice[]> {
  if (deps.listSources) return deps.listSources()
  return readCalendarSources(executor)
}

/** The chosen source: the dialog's pick when present, else the only one
 * (multiple sources always arrive with a preferredSourceId). */
function pickSource(
  sources: CalendarSourceChoice[],
  preferredSourceId?: string
): CalendarSourceChoice | null {
  if (preferredSourceId) {
    const match = sources.find((source) => source.id === preferredSourceId)
    if (match) return match
  }
  return sources[0] ?? null
}

/**
 * Map one parsed VEVENT onto the event-write input: all-day DATE values
 * stay all-day (UTC-midnight start, exclusive end); a missing DTEND/
 * DURATION falls back to one day (all-day) or one hour (timed) rather
 * than writing a zero/negative-length event. Attendee emails become the
 * guest list ("pre-filling details found in the message").
 */
export function icsEventToWriteInput(
  sourceId: string,
  calendarId: string,
  event: IcsEvent
): EventWriteInput | null {
  if (!event.start?.date) return null
  const startAt = Math.floor(event.start.date.getTime() / 1000)
  const allDay = event.start.allDay
  const endDate = resolveIcsEventEnd(event)?.date ?? null
  const endAt = endDate
    ? Math.floor(endDate.getTime() / 1000)
    : allDay
      ? startAt + 86_400
      : startAt + 3_600
  const guests = [
    ...new Set(
      event.attendees
        .map((attendee) => attendee.email)
        .filter((email): email is string => email !== null)
    ),
  ]
  return {
    sourceId,
    calendarId,
    title: event.summary ?? "(untitled)",
    startAt,
    endAt,
    allDay,
    location: event.location ?? null,
    description: event.description ?? null,
    guests,
  }
}

async function resolveSources(
  executor: SqlExecutor,
  deps: IcsSeamDeps
): Promise<CalendarSourceChoice[]> {
  if (deps.listSources) {
    try {
      return await deps.listSources()
    } catch (error) {
      console.warn("[ics-seam] source listing failed", error)
      return []
    }
  }
  return readCalendarSources(executor)
}

/**
 * Add the (already parsed) event carried by `ics` to the user's chosen
 * calendar (task 5.4 body). Picks the dialog's source (or the only one),
 * resolves the source's default writable calendar, and hands the mapped
 * VEVENT to the event-write service — which enforces the online-write
 * contract (offline = typed failure, no network; local row only after the
 * server confirmed). Never throws.
 */
export async function addIcsEventToCalendar(
  executor: SqlExecutor,
  request: AddIcsEventRequest,
  deps: IcsSeamDeps = {}
): Promise<AddIcsEventResult> {
  try {
    const sources = await resolveSources(executor, deps)
    if (sources.length === 0) return { ok: false, reason: "no-source" }
    if (!useOnlineStore.getState().online) {
      return { ok: false, reason: "offline", message: OFFLINE_WRITE_MESSAGE }
    }
    const parsed = parseIcsCalendar(request.ics)
    if (!parsed.ok) {
      return { ok: false, reason: "invalid", message: parsed.message }
    }
    const event =
      parsed.calendar.events.find((candidate) => candidate.start?.date) ?? null
    if (!event) {
      return {
        ok: false,
        reason: "no-event",
        message: "The file carries no event with a usable start time.",
      }
    }
    const choice = pickSource(sources, request.preferredSourceId)
    if (!choice) return { ok: false, reason: "no-source" }
    const source = await getCalendarSource(executor, choice.id)
    if (!source) {
      return {
        ok: false,
        reason: "no-source",
        message: "The chosen calendar source is not connected anymore.",
      }
    }
    const calendarId = await defaultWritableCalendarId(source)
    if (!calendarId) {
      return {
        ok: false,
        reason: "config",
        message: "That source has no calendar to add the event to.",
      }
    }
    const input = icsEventToWriteInput(source.id, calendarId, event)
    if (!input) {
      return {
        ok: false,
        reason: "no-event",
        message: "The event has no usable start time.",
      }
    }
    const write = deps.createEvent ?? createEvent
    const result = await write(executor, input)
    if (result.ok) return { ok: true, sourceId: source.id }
    return { ok: false, reason: result.reason, message: result.message }
  } catch (error) {
    console.warn("[ics-seam] add-to-calendar failed", error)
    return {
      ok: false,
      reason: "failed",
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Answer a METHOD:REQUEST invitation (task 5.4 body; support matrix in
 * the module docs): Google — the stored event's responseStatus is
 * patched for this user through the event-write service; CalDAV — a
 * typed `unsupported` (iTIP REPLY / scheduling transfer is out of scope).
 * Same availability and offline contract as
 * {@link addIcsEventToCalendar}. Never throws.
 */
export async function respondToInvitation(
  executor: SqlExecutor,
  request: RespondToInvitationRequest,
  deps: IcsSeamDeps = {}
): Promise<RespondToInvitationResult> {
  try {
    const sources = await resolveSources(executor, deps)
    if (sources.length === 0) return { ok: false, reason: "no-source" }
    if (!useOnlineStore.getState().online) {
      return { ok: false, reason: "offline", message: OFFLINE_WRITE_MESSAGE }
    }
    const parsed = parseIcsCalendar(request.ics)
    if (!parsed.ok) {
      return { ok: false, reason: "invalid", message: parsed.message }
    }
    const event =
      parsed.calendar.events.find((candidate) => candidate.uid) ?? null
    if (!event?.uid) {
      return {
        ok: false,
        reason: "no-event",
        message: "The invitation carries no event id to respond to.",
      }
    }
    const choice = pickSource(sources, request.preferredSourceId)
    if (!choice) return { ok: false, reason: "no-source" }
    if (deps.respond) {
      return deps.respond(executor, choice.id, request)
    }
    const source = await getCalendarSource(executor, choice.id)
    if (!source) {
      return {
        ok: false,
        reason: "no-source",
        message: "The chosen calendar source is not connected anymore.",
      }
    }
    if (source.provider !== "google") {
      return {
        ok: false,
        reason: "unsupported",
        message: CALDAV_RSVP_UNSUPPORTED_MESSAGE,
      }
    }
    const result = await respondToGoogleInvitation(
      executor,
      source,
      event.uid,
      request.response
    )
    if (result.ok) return { ok: true, response: request.response }
    return { ok: false, reason: result.reason, message: result.message }
  } catch (error) {
    console.warn("[ics-seam] invitation response failed", error)
    return {
      ok: false,
      reason: "failed",
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
