import type { FetchImpl } from "../email/token-manager"
import { getAccount } from "../db/accounts"
import type { SqlExecutor } from "../db/executor"
import { useOnlineStore } from "../../stores/online-store"
import {
  caldavEventResourcePath,
  deleteCaldavEvent,
  mapCaldavCalendarData,
  putCaldavEvent,
  unsealCaldavConfig,
  upsertEvents,
} from "./caldav"
import {
  createCalendarTokens,
  deleteGoogleEvent,
  getGoogleEvent,
  insertGoogleEvent,
  mapGoogleEvent,
  updateGoogleEvent,
  upsertEventsFromApi,
} from "./google-calendar"
import type {
  CalendarEventInput,
  CalendarTokens,
  GoogleEventPayload,
} from "./google-calendar"
import {
  buildMicrosoftEventPayload,
  createMicrosoftCalendarTokens,
  deleteMicrosoftEvent,
  insertMicrosoftEvent,
  mapMicrosoftEvent,
  updateMicrosoftEvent,
  upsertMicrosoftEventsFromApi,
} from "./microsoft-calendar"
import { parseIcsCalendar } from "./ics"
import type { MicrosoftCalendarTokens } from "./microsoft-calendar"
import type { CalendarEvent } from "./events"
import { listCalendarSources, getCalendarSource } from "./sources"
import type { CalendarProvider, CalendarSource } from "./sources"

/**
 * Event create/update/delete against a connected calendar source
 * (task 5.4, design D5; calendar spec "Event creation and editing").
 *
 * ONLINE-WRITE CONTRACT (the spec's explicit-failure requirement):
 * every write checks `useOnlineStore.getState().online` FIRST and answers
 * the typed `{ ok: false, reason: "offline" }` without ANY network attempt
 * when offline — the UI surfaces "couldn't save: you're offline" instead
 * of pretending. A local `calendar_events` row is written ONLY after the
 * server confirmed the write (no silent local-only edits, no optimistic
 * rows that drift from the source); the returned event reflects the
 * stored row. Every failure is a typed reason + message — never a throw —
 * so the dialog can render one inline banner and keep the form state.
 *
 * Provider paths:
 * - Google: events.insert/update(PATCH)/delete through the same fetch
 *   seam + token machinery as the sync path (google-calendar.ts). Times
 *   go out as absolute RFC 3339 instants (UTC); all-day as DATE with the
 *   exclusive-end convention the cache already stores. Guests ride
 *   `attendees`, the reminder becomes a single popup
 *   `reminders.overrides` entry.
 * - Microsoft (task 3.6): events.create/PATCH/delete through the Graph
 *   calendar surface (microsoft-calendar.ts) and its own sealed envelope
 *   (the separate calendar-scope consent — rotation re-seals into the
 *   source row). Times go out as offset-free UTC dateTime strings paired
 *   with timeZone "UTC"; all-day as isAllDay + midnight bounds; guests as
 *   required attendees; the reminder as isReminderOn +
 *   reminderMinutesBeforeStart (a null patch turns it off — Graph has no
 *   "use calendar default" write).
 * - CalDAV: the .ics blob IS the state — create/update PUT a rebuilt
 *   VCALENDAR to `{collection href}{uid}.ics` (RFC 4791 §5.3.2) through
 *   the `caldav_put_event` command, delete DELETEs the resource. Updates
 *   rebuild the stored blob from the edited fields, preserving the
 *   stored ORGANIZER/ATTENDEE lines (the one provider state not in the
 *   form). No etag concurrency in v1: last-write-wins, the next sync
 *   converges a lost race.
 *
 * Recurring events: writes address the STORED master row. Editing a
 * view-time occurrence (`<masterId>#oc-<n>`) is resolved to the master by
 * the caller (events.ts getCalendarEvent) — v1 writes always touch the
 * whole series, never a single occurrence (matches what Google's own UI
 * does for "this and following" only with much more machinery).
 */

/** Why a write did not happen (typed — the UI maps these to copy). */
export type EventWriteFailureReason =
  /** No active connection: nothing was attempted, nothing changed. */
  | "offline"
  /** The source id is unknown or no longer connected. */
  | "no-source"
  /** The stored connection is unusable (unsealable envelope, no token). */
  | "config"
  /** The event to write/answer is not on the source (deleted, or the
   * invitation was never synced). */
  | "no-event"
  /** The source cannot do this operation (CalDAV iTIP RSVP in v1). */
  | "unsupported"
  /** The provider rejected the write, or transport failed mid-write. */
  | "failed"

/** The user-facing offline line (kept in one place for tests). */
export const OFFLINE_WRITE_MESSAGE =
  "You're offline — the change could not be saved to the server. " +
  "Reconnect and try again."

/** Every write op answers this; failures never throw. */
export type EventWriteResult =
  | { ok: true; event: CalendarEvent }
  | { ok: false; reason: EventWriteFailureReason; message?: string }

/** Delete answers without an event (there isn't one anymore). */
export type EventDeleteResult =
  | { ok: true }
  | { ok: false; reason: EventWriteFailureReason; message?: string }

/** The RSVP answer union (structurally the seam's InvitationResponse). */
export type InvitationAnswer = "yes" | "no" | "maybe"

/** A destination the event form can write to. */
export interface WritableCalendar {
  sourceId: string
  sourceName: string
  provider: CalendarProvider
  /** Google: the provider calendar id; CalDAV: the collection href. */
  calendarId: string
}

/** The fields a CREATE writes (all of them; title is required). */
export interface EventWriteInput {
  sourceId: string
  calendarId: string
  title: string
  /** Epoch seconds; all-day starts sit at UTC midnight (the cache rule). */
  startAt: number
  /** Epoch seconds, EXCLUSIVE end (all-day: midnight after the last day). */
  endAt: number
  allDay: boolean
  location?: string | null
  description?: string | null
  guests?: string[]
  /** Popup reminder in minutes (Google only — CalDAV has no reminder
   * mapping in v1; the form hides the field there). */
  reminderMinutes?: number
}

/**
 * The fields an EDIT writes. Every key is optional so an unchanged field
 * can be OMITTED rather than blanked (Google PATCH semantics; a CalDAV
 * PUT always rewrites the blob, so the merge uses the stored row there).
 * `guests: undefined` leaves the provider's attendee list untouched —
 * the cached Google row does not carry attendees, so the form omits the
 * field unless the user actually edited it.
 */
export interface EventWritePatch {
  title?: string
  startAt?: number
  endAt?: number
  allDay?: boolean
  location?: string | null
  description?: string | null
  guests?: string[]
  reminderMinutes?: number | null
}

export interface EventWriteOptions {
  /** Test seam; production uses the global fetch (tauri-plugin-http). */
  fetchImpl?: FetchImpl
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The offline gate — checked before ANY network attempt (module docs). */
function offlineFailure(): EventWriteResult {
  return { ok: false, reason: "offline", message: OFFLINE_WRITE_MESSAGE }
}

// ---------------------------------------------------------------------------
// Google payload building
// ---------------------------------------------------------------------------

/** RFC 3339 UTC instant ("2026-03-02T08:00:00Z") from epoch seconds. */
function googleRfc3339(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")
}

/** Google all-day DATE ("2026-03-02") from epoch seconds (UTC). */
function googleDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10)
}

function dedupeGuests(guests: string[]): string[] {
  const seen = new Set<string>()
  for (const guest of guests) {
    const email = guest.trim()
    if (email.length > 0) seen.add(email)
  }
  return [...seen]
}

/**
 * Build the events.insert/update body from merged form fields. All-day
 * events carry `date` (end EXCLUSIVE — the cache convention, also
 * Google's), timed events absolute UTC `dateTime` instants. A truthy
 * reminder becomes a single popup override; `reminderMinutes === null`
 * restores the calendar default (PATCH clear).
 */
export function buildGoogleEventPayload(fields: {
  title?: string
  startAt?: number
  endAt?: number
  allDay?: boolean
  location?: string | null
  description?: string | null
  guests?: string[]
  reminderMinutes?: number | null
}): GoogleEventPayload {
  const payload: GoogleEventPayload = {}
  if (fields.title !== undefined) payload.summary = fields.title
  if (fields.location !== undefined) payload.location = fields.location || ""
  if (fields.description !== undefined) {
    payload.description = fields.description || ""
  }
  if (fields.startAt !== undefined && fields.endAt !== undefined) {
    if (fields.allDay) {
      payload.start = { date: googleDate(fields.startAt) }
      // All-day ends are exclusive; keep at least the one started day.
      const end = Math.max(fields.endAt, fields.startAt + 86_400)
      payload.end = { date: googleDate(end) }
    } else {
      payload.start = { dateTime: googleRfc3339(fields.startAt) }
      payload.end = {
        dateTime: googleRfc3339(Math.max(fields.endAt, fields.startAt + 60)),
      }
    }
  }
  if (fields.guests !== undefined) {
    payload.attendees = dedupeGuests(fields.guests).map((email) => ({
      email,
    }))
  }
  if (fields.reminderMinutes !== undefined) {
    payload.reminders =
      fields.reminderMinutes === null
        ? { useDefault: true }
        : {
            useDefault: false,
            overrides: [
              { method: "popup", minutes: fields.reminderMinutes },
            ],
          }
  }
  return payload
}

/** calendar_events row view from a stored/just-written row input. */
function inputToCalendarEvent(input: CalendarEventInput): CalendarEvent {
  return {
    id: input.id,
    sourceId: input.sourceId,
    calendarId: input.calendarId,
    uid: input.uid,
    summary: input.summary ?? null,
    location: input.location ?? null,
    description: input.description ?? null,
    startAt: input.startAt,
    endAt: input.endAt,
    allDay: input.allDay,
    recurrence: input.recurrence ?? null,
    status: input.status ?? null,
  }
}

async function googleTokensFor(
  source: CalendarSource,
  fetchImpl: FetchImpl
): Promise<{ tokens: CalendarTokens } | { message: string }> {
  try {
    return { tokens: await createCalendarTokens(source, fetchImpl) }
  } catch (error) {
    return {
      message:
        messageOf(error) ||
        "The stored Google connection is unusable; re-connect the calendar source",
    }
  }
}

/** Same shape as googleTokensFor, over the Microsoft calendar envelope
 * (which also re-seals Entra's rotated refresh tokens into the source). */
async function microsoftTokensFor(
  executor: SqlExecutor,
  source: CalendarSource,
  fetchImpl: FetchImpl
): Promise<{ tokens: MicrosoftCalendarTokens } | { message: string }> {
  try {
    return {
      tokens: await createMicrosoftCalendarTokens(
        executor,
        source,
        fetchImpl
      ),
    }
  } catch (error) {
    return {
      message:
        messageOf(error) ||
        "The stored Microsoft connection is unusable; re-connect the calendar source",
    }
  }
}

async function loadSource(
  executor: SqlExecutor,
  sourceId: string
): Promise<CalendarSource | EventWriteResult> {
  const source = await getCalendarSource(executor, sourceId)
  if (!source) {
    return {
      ok: false,
      reason: "no-source",
      message: "That calendar source is not connected anymore.",
    }
  }
  return source
}

// ---------------------------------------------------------------------------
// CalDAV ical building + helpers
// ---------------------------------------------------------------------------

/** RFC 5545 UTC DATE-TIME ("20260302T080000Z") from epoch seconds. */
function icsUtc(seconds: number): string {
  return new Date(seconds * 1000)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "")
}

/** RFC 5545 DATE ("20260302") from epoch seconds (UTC midnight form). */
function icsDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10).replace(/-/g, "")
}

/**
 * The full VCALENDAR blob for one event write (create, or a CalDAV edit's
 * rebuilt resource): CRLF lines, TEXT escaping, all-day DATE values with
 * the exclusive end, absolute UTC times otherwise, and one
 * PARTSTAT=NEEDS-ACTION ATTENDEE per guest. Guests carry no CN in v1
 * (the form collects bare emails only).
 */
export function buildEventIcal(
  uid: string,
  input: {
    title: string
    startAt: number
    endAt: number
    allDay: boolean
    location?: string | null
    description?: string | null
    guests?: string[]
    organizerEmail?: string | null
  }
): string {
  function escapeText(value: string): string {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r?\n/g, "\\n")
  }

  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//emailer//Calendar 1.0//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
  ]
  if (input.allDay) {
    lines.push(`DTSTART;VALUE=DATE:${icsDate(input.startAt)}`)
    const end = Math.max(input.endAt, input.startAt + 86_400)
    lines.push(`DTEND;VALUE=DATE:${icsDate(end)}`)
  } else {
    lines.push(`DTSTART:${icsUtc(input.startAt)}`)
    lines.push(`DTEND:${icsUtc(Math.max(input.endAt, input.startAt))}`)
  }
  if (input.title) lines.push(`SUMMARY:${escapeText(input.title)}`)
  if (input.location) lines.push(`LOCATION:${escapeText(input.location)}`)
  if (input.description) {
    lines.push(`DESCRIPTION:${escapeText(input.description)}`)
  }
  if (input.organizerEmail) {
    lines.push(`ORGANIZER:mailto:${input.organizerEmail}`)
  }
  for (const guest of dedupeGuests(input.guests ?? [])) {
    lines.push(`ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:${guest}`)
  }
  lines.push("END:VEVENT", "END:VCALENDAR")
  return lines.join("\r\n")
}

/** Recover the attendee/organizer emails stored in a CalDAV row's verbatim
 * blob — the state an edit must carry across its rebuild. */
function storedCaldavPeople(ical: string | null): {
  guests: string[] | undefined
  organizerEmail: string | null
} {
  if (!ical) return { guests: undefined, organizerEmail: null }
  const parsed = parseIcsCalendar(ical)
  if (!parsed.ok) return { guests: undefined, organizerEmail: null }
  const event = parsed.calendar.events[0]
  if (!event) return { guests: undefined, organizerEmail: null }
  const guests = event.attendees
    .map((attendee) => attendee.email)
    .filter((email): email is string => email !== null)
  return {
    guests: guests.length > 0 ? guests : undefined,
    organizerEmail: event.organizer?.email ?? null,
  }
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Create an event on the chosen source calendar (spec: "Create an event").
 * Online-write contract per the module docs: offline → typed failure with
 * no network; the local row is cached only after the server confirmed.
 */
export async function createEvent(
  executor: SqlExecutor,
  input: EventWriteInput,
  options: EventWriteOptions = {}
): Promise<EventWriteResult> {
  if (!useOnlineStore.getState().online) return offlineFailure()
  const source = await loadSource(executor, input.sourceId)
  if (!("provider" in source)) return source
  const fetchImpl = options.fetchImpl ?? fetch

  try {
    if (source.provider === "google") {
      const auth = await googleTokensFor(source, fetchImpl)
      if ("message" in auth) {
        return { ok: false, reason: "config", message: auth.message }
      }
      const payload = buildGoogleEventPayload(input)
      const created = await insertGoogleEvent(
        auth.tokens,
        input.calendarId,
        payload,
        fetchImpl
      )
      if (!created?.id) {
        return {
          ok: false,
          reason: "failed",
          message: "Google accepted the event but returned no id.",
        }
      }
      // Server write confirmed — now cache the row (and only now).
      await upsertEventsFromApi(executor, source.id, input.calendarId, [
        created,
      ])
      const mapped = mapGoogleEvent(source.id, input.calendarId, created)
      if (!mapped || mapped.isTombstone) {
        return {
          ok: false,
          reason: "failed",
          message: "Google returned an event payload that could not be cached.",
        }
      }
      return { ok: true, event: inputToCalendarEvent(mapped.input) }
    }

    if (source.provider === "microsoft") {
      const auth = await microsoftTokensFor(executor, source, fetchImpl)
      if ("message" in auth) {
        return { ok: false, reason: "config", message: auth.message }
      }
      const payload = buildMicrosoftEventPayload(input)
      const created = await insertMicrosoftEvent(
        auth.tokens,
        input.calendarId,
        payload,
        fetchImpl
      )
      if (!created?.id) {
        return {
          ok: false,
          reason: "failed",
          message: "Microsoft accepted the event but returned no id.",
        }
      }
      // Server write confirmed — now cache the row (and only now).
      await upsertMicrosoftEventsFromApi(executor, source.id, input.calendarId, [
        created,
      ])
      const mapped = mapMicrosoftEvent(source.id, input.calendarId, created)
      if (!mapped || mapped.isTombstone) {
        return {
          ok: false,
          reason: "failed",
          message:
            "Microsoft returned an event payload that could not be cached.",
        }
      }
      return { ok: true, event: inputToCalendarEvent(mapped.input) }
    }

    // CalDAV: PUT the built blob, then cache it with the sync's own mapper.
    const envelope = await unsealCaldavConfig(source)
    if (!envelope) {
      return {
        ok: false,
        reason: "config",
        message:
          "No stored CalDAV connection details for this source; re-connect it",
      }
    }
    if (!envelope.calendarPaths.includes(input.calendarId)) {
      return {
        ok: false,
        reason: "config",
        message: "That calendar is not among the source's connected ones.",
      }
    }
    const uid = crypto.randomUUID()
    const ical = buildEventIcal(uid, input)
    const resourcePath = caldavEventResourcePath(input.calendarId, uid)
    await putCaldavEvent(
      {
        serverUrl: envelope.serverUrl,
        username: envelope.username,
        appPassword: envelope.appPassword,
      },
      resourcePath,
      ical
    )
    const inputs = mapCaldavCalendarData(
      source.id,
      input.calendarId,
      resourcePath,
      ical
    )
    if (!inputs) {
      return {
        ok: false,
        reason: "failed",
        message: "The written event could not be cached locally.",
      }
    }
    await upsertEvents(executor, inputs)
    return { ok: true, event: inputToCalendarEvent(inputs[0]) }
  } catch (error) {
    return { ok: false, reason: "failed", message: messageOf(error) }
  }
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

/**
 * Update an event the user can see (spec: "edit or delete events they
 * created"). `patch` carries the form's edited fields; omitted keys leave
 * the provider value alone (Google PATCH) or keep the stored blob's value
 * (CalDAV rebuild). Online-write contract per the module docs.
 */
export async function updateEvent(
  executor: SqlExecutor,
  existing: CalendarEvent,
  patch: EventWritePatch,
  options: EventWriteOptions = {}
): Promise<EventWriteResult> {
  if (!useOnlineStore.getState().online) return offlineFailure()
  const source = await loadSource(executor, existing.sourceId)
  if (!("provider" in source)) return source
  const fetchImpl = options.fetchImpl ?? fetch

  try {
    if (source.provider === "google") {
      const auth = await googleTokensFor(source, fetchImpl)
      if ("message" in auth) {
        return { ok: false, reason: "config", message: auth.message }
      }
      const payload = buildGoogleEventPayload(patch)
      const updated = await updateGoogleEvent(
        auth.tokens,
        existing.calendarId,
        existing.uid,
        payload,
        fetchImpl
      )
      if (!updated?.id) {
        return {
          ok: false,
          reason: "failed",
          message: "Google did not return the updated event.",
        }
      }
      await upsertEventsFromApi(executor, source.id, existing.calendarId, [
        updated,
      ])
      const mapped = mapGoogleEvent(source.id, existing.calendarId, updated)
      if (!mapped || mapped.isTombstone) {
        return {
          ok: false,
          reason: "failed",
          message: "Google returned an event payload that could not be cached.",
        }
      }
      return { ok: true, event: inputToCalendarEvent(mapped.input) }
    }

    if (source.provider === "microsoft") {
      const auth = await microsoftTokensFor(executor, source, fetchImpl)
      if ("message" in auth) {
        return { ok: false, reason: "config", message: auth.message }
      }
      const payload = buildMicrosoftEventPayload(patch)
      const updated = await updateMicrosoftEvent(
        auth.tokens,
        existing.calendarId,
        existing.uid,
        payload,
        fetchImpl
      )
      if (!updated?.id) {
        return {
          ok: false,
          reason: "failed",
          message: "Microsoft did not return the updated event.",
        }
      }
      await upsertMicrosoftEventsFromApi(
        executor,
        source.id,
        existing.calendarId,
        [updated]
      )
      const mapped = mapMicrosoftEvent(
        source.id,
        existing.calendarId,
        updated
      )
      if (!mapped || mapped.isTombstone) {
        return {
          ok: false,
          reason: "failed",
          message:
            "Microsoft returned an event payload that could not be cached.",
        }
      }
      return { ok: true, event: inputToCalendarEvent(mapped.input) }
    }

    // CalDAV: rebuild the resource from merged fields, preserving the
    // stored ORGANIZER/ATTENDEE lines the form does not edit. The read
    // model does not carry the raw blob, so it is read from the row.
    const envelope = await unsealCaldavConfig(source)
    if (!envelope) {
      return {
        ok: false,
        reason: "config",
        message:
          "No stored CalDAV connection details for this source; re-connect it",
      }
    }
    const blobRows = await executor.select<{ ical: string | null }>(
      "SELECT ical FROM calendar_events WHERE source_id = $1 AND calendar_id = $2 AND uid = $3",
      [existing.sourceId, existing.calendarId, existing.uid]
    )
    const stored = storedCaldavPeople(blobRows[0]?.ical ?? null)
    const merged = {
      title: patch.title ?? existing.summary ?? "",
      startAt: patch.startAt ?? existing.startAt,
      endAt: patch.endAt ?? existing.endAt,
      allDay: patch.allDay ?? existing.allDay,
      location: patch.location !== undefined ? patch.location : existing.location,
      description:
        patch.description !== undefined ? patch.description : existing.description,
      guests: patch.guests ?? stored.guests,
      organizerEmail: stored.organizerEmail,
    }
    const ical = buildEventIcal(existing.uid, merged)
    const resourcePath = caldavEventResourcePath(existing.calendarId, existing.uid)
    await putCaldavEvent(
      {
        serverUrl: envelope.serverUrl,
        username: envelope.username,
        appPassword: envelope.appPassword,
      },
      resourcePath,
      ical
    )
    const inputs = mapCaldavCalendarData(
      source.id,
      existing.calendarId,
      resourcePath,
      ical
    )
    if (!inputs) {
      return {
        ok: false,
        reason: "failed",
        message: "The written event could not be cached locally.",
      }
    }
    await upsertEvents(executor, inputs)
    return { ok: true, event: inputToCalendarEvent(inputs[0]) }
  } catch (error) {
    return { ok: false, reason: "failed", message: messageOf(error) }
  }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/**
 * Delete an event from its source and the local cache, in that order (a
 * failed server delete leaves the row — the event must not vanish from
 * the UI while it still exists on the server). Online-write contract per
 * the module docs.
 */
export async function deleteEvent(
  executor: SqlExecutor,
  existing: CalendarEvent,
  options: EventWriteOptions = {}
): Promise<EventDeleteResult> {
  if (!useOnlineStore.getState().online) {
    return { ok: false, reason: "offline", message: OFFLINE_WRITE_MESSAGE }
  }
  const source = await loadSource(executor, existing.sourceId)
  if (!("provider" in source)) return source
  const fetchImpl = options.fetchImpl ?? fetch

  try {
    if (source.provider === "google") {
      const auth = await googleTokensFor(source, fetchImpl)
      if ("message" in auth) {
        return { ok: false, reason: "config", message: auth.message }
      }
      await deleteGoogleEvent(
        auth.tokens,
        existing.calendarId,
        existing.uid,
        fetchImpl
      )
    } else if (source.provider === "microsoft") {
      const auth = await microsoftTokensFor(executor, source, fetchImpl)
      if ("message" in auth) {
        return { ok: false, reason: "config", message: auth.message }
      }
      await deleteMicrosoftEvent(
        auth.tokens,
        existing.calendarId,
        existing.uid,
        fetchImpl
      )
    } else {
      const envelope = await unsealCaldavConfig(source)
      if (!envelope) {
        return {
          ok: false,
          reason: "config",
          message:
            "No stored CalDAV connection details for this source; re-connect it",
        }
      }
      await deleteCaldavEvent(
        {
          serverUrl: envelope.serverUrl,
          username: envelope.username,
          appPassword: envelope.appPassword,
        },
        caldavEventResourcePath(existing.calendarId, existing.uid)
      )
    }
    await executor.execute(
      "DELETE FROM calendar_events WHERE source_id = $1 AND calendar_id = $2 AND uid = $3",
      [existing.sourceId, existing.calendarId, existing.uid]
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: "failed", message: messageOf(error) }
  }
}

// ---------------------------------------------------------------------------
// Writable destinations (the event form's picker)
// ---------------------------------------------------------------------------

/**
 * Every (source, calendar) pair the event form could write to: Google —
 * the calendars the source has synced (task 5.1's cursor keys), falling
 * back to "primary" before the first sync; Microsoft — the calendars the
 * source has synced (Graph calendar ids have no well-known constant, so a
 * source that has never synced offers nothing yet); CalDAV — the connected
 * collections from the sealed envelope. Sources with no resolvable
 * calendar are skipped (nothing to write to).
 */
export async function listWritableEventCalendars(
  executor: SqlExecutor
): Promise<WritableCalendar[]> {
  const sources = await listCalendarSources(executor)
  const out: WritableCalendar[] = []
  for (const source of sources) {
    if (source.provider === "google" || source.provider === "microsoft") {
      const synced = Object.keys(source.syncState).sort()
      if (synced.length === 0) {
        if (source.provider === "google") {
          out.push({
            sourceId: source.id,
            sourceName: source.name,
            provider: source.provider,
            calendarId: "primary",
          })
        }
        continue
      }
      for (const calendarId of synced) {
        out.push({
          sourceId: source.id,
          sourceName: source.name,
          provider: source.provider,
          calendarId,
        })
      }
      continue
    }
    const envelope = await unsealCaldavConfig(source)
    for (const calendarId of envelope?.calendarPaths ?? []) {
      out.push({
        sourceId: source.id,
        sourceName: source.name,
        provider: source.provider,
        calendarId,
      })
    }
  }
  return out
}

/**
 * The default calendar for one source (the .ics seam's write path): the
 * first synced Google calendar (or "primary"), respectively the first
 * synced Microsoft calendar or the first connected CalDAV collection.
 * Null when the source has none.
 */
export async function defaultWritableCalendarId(
  source: CalendarSource
): Promise<string | null> {
  if (source.provider === "google") {
    return Object.keys(source.syncState).sort()[0] ?? "primary"
  }
  if (source.provider === "microsoft") {
    return Object.keys(source.syncState).sort()[0] ?? null
  }
  const envelope = await unsealCaldavConfig(source)
  return envelope?.calendarPaths[0] ?? null
}

// ---------------------------------------------------------------------------
// Google invitation response (RSVP — task 5.4)
// ---------------------------------------------------------------------------

const RESPONSE_STATUS: Record<InvitationAnswer, string> = {
  yes: "accepted",
  no: "declined",
  maybe: "tentative",
}

/**
 * Answer a METHOD:REQUEST invitation through its Google source (spec:
 * "Respond to an invitation" — "where the source supports them"). The
 * Calendar API does not accept a raw iTIP REPLY: the response is applied
 * by PATCHing the STORED event's `attendees[].responseStatus` for THIS
 * user, which is what Google's own RSVP flow does server-side. The event
 * is found by the invitation's UID in the cache (Google event id; the
 * `…@google.com` iCal-UID suffix form is matched too). Documented v1
 * limitations: the user is identified by the source's linked mail account
 * email — when that is unavailable/absent from the attendee list and the
 * invitation has more than one attendee, the response is refused with a
 * typed `unsupported` rather than answering for the wrong person. A
 * commented REPLY email is NOT sent (Google notifies the organizer).
 */
export async function respondToGoogleInvitation(
  executor: SqlExecutor,
  source: CalendarSource,
  icsUid: string,
  response: InvitationAnswer,
  options: EventWriteOptions = {}
): Promise<EventWriteResult> {
  if (!useOnlineStore.getState().online) return offlineFailure()
  const fetchImpl = options.fetchImpl ?? fetch

  // Match the invitation uid to the cached event: Google stores its event
  // id as our uid; invitation UIDs carry the same id with an @domain
  // suffix (the iCalUID form).
  const bareUid = icsUid.includes("@") ? icsUid.split("@")[0] : icsUid
  const rows = await executor.select<{
    calendar_id: string
    uid: string
  }>(
    `SELECT calendar_id, uid FROM calendar_events
      WHERE source_id = $1 AND uid IN ($2, $3)
      ORDER BY uid ASC`,
    [source.id, icsUid, bareUid]
  )
  const row = rows[0]
  if (!row) {
    return {
      ok: false,
      reason: "no-event",
      message:
        "This event is not on the connected calendar yet — refresh the calendar and try again.",
    }
  }

  const auth = await googleTokensFor(source, fetchImpl)
  if ("message" in auth) {
    return { ok: false, reason: "config", message: auth.message }
  }

  let userEmail: string | null = null
  if (source.accountId) {
    try {
      const account = await getAccount(executor, source.accountId)
      userEmail = account?.email ?? null
    } catch {
      // Account gone — fall through to the single-attendee heuristic.
    }
  }

  try {
    const current = await getGoogleEvent(
      auth.tokens,
      row.calendar_id,
      row.uid,
      fetchImpl
    )
    if (!current?.id) {
      return {
        ok: false,
        reason: "no-event",
        message: "The event could not be found on Google Calendar anymore.",
      }
    }
    const attendees = [...(current.attendees ?? [])]
    let index = -1
    if (userEmail) {
      index = attendees.findIndex(
        (attendee) =>
          attendee.email.toLowerCase() === userEmail?.toLowerCase()
      )
    }
    if (index < 0 && attendees.length === 1) index = 0
    if (index < 0) {
      return {
        ok: false,
        reason: "unsupported",
        message:
          "Could not tell which attendee on this invitation is you; reply by email instead.",
      }
    }
    attendees[index] = { ...attendees[index], responseStatus: RESPONSE_STATUS[response] }
    const updated = await updateGoogleEvent(
      auth.tokens,
      row.calendar_id,
      row.uid,
      { attendees },
      fetchImpl
    )
    // Cache the server truth (also refreshes times/summary if they moved).
    if (updated?.id) {
      await upsertEventsFromApi(executor, source.id, row.calendar_id, [updated])
    }
    return {
      ok: true,
      event: {
        id: `ce-${source.id}:${row.calendar_id}:${row.uid}`,
        sourceId: source.id,
        calendarId: row.calendar_id,
        uid: row.uid,
        summary: updated?.summary ?? current.summary ?? null,
        location: updated?.location ?? current.location ?? null,
        description: updated?.description ?? current.description ?? null,
        startAt: current.start?.dateTime
          ? Math.floor(Date.parse(current.start.dateTime) / 1000)
          : current.start?.date
            ? Math.floor(Date.parse(`${current.start.date}T00:00:00Z`) / 1000)
            : 0,
        endAt: current.end?.dateTime
          ? Math.floor(Date.parse(current.end.dateTime) / 1000)
          : current.end?.date
            ? Math.floor(Date.parse(`${current.end.date}T00:00:00Z`) / 1000)
            : 0,
        allDay: Boolean(current.start?.date),
        recurrence: null,
        status: current.status ?? null,
      },
    }
  } catch (error) {
    return { ok: false, reason: "failed", message: messageOf(error) }
  }
}
