import type { SqlExecutor } from "../db/executor"
import {
  decryptCredentials,
  encryptCredentials,
} from "../crypto/credentials"
import {
  GRAPH_API_ROOT,
  GraphApiError,
  MAX_THROTTLE_RETRIES,
  THROTTLE_BASE_MS,
  THROTTLE_MAX_WAIT_MS,
  retryAfterMsOf,
  validatedGraphLink,
} from "../email/graph-api"
import { ProviderAuthError } from "../email/types"
import type { FetchImpl } from "../email/token-manager"
import { createMicrosoftTokenSource } from "../email/microsoft-token-manager"
import type { CalendarEventInput } from "./google-calendar"
import type { CalendarSource } from "./sources"
import { getCalendarSyncState, updateCalendarSyncState } from "./sources"

/**
 * Microsoft Graph calendar provider (parity-round-2 task 3.6).
 *
 * The Microsoft data path in this codebase is TypeScript over the fetch
 * patched by tauri-plugin-http (the Graph mail precedent, design D1) — the
 * Graph calendar surface rides the same graph.microsoft.com capability.
 * This module mirrors calendar/google-calendar.ts: a thin typed client over
 * the injected fetchImpl (tests inject a fixture router), Bearer-
 * authenticated through a token source built on the shared Microsoft token
 * manager — but over the SOURCE'S OWN sealed envelope (the separate
 * calendar-scope consent round's refresh token, see connect-microsoft.ts;
 * never the mail account's credentials envelope), with rotation re-sealing
 * wired back into the source row (Entra rotates refresh tokens; Google's
 * do not, which is why google-calendar.ts needs no persist hook).
 *
 * Incremental sync uses Graph's calendarView delta feed (the reference
 * implementation's shape, translated):
 * - First pass (no stored deltaLink): a full pass over a FIXED window
 *   (one year back, ~13 months ahead) — the offline browsing range the
 *   Google full sync caches. The response's `@odata.deltaLink` is stored
 *   per (source, calendar) in calendar_sources.sync_state_json's
 *   nextSyncToken field (a URL, deliberately not a secret).
 * - Later passes: the stored deltaLink is followed; a 410 GONE (token
 *   expired / window re-anchored server-side) wipes the calendar's local
 *   events and re-runs the full pass once (mode "full-resync").
 *
 * calendarView expands recurring series into occurrences SERVER-SIDE, so
 * no RRULE handling happens anywhere: series masters are skipped, each
 * occurrence/exception is stored as its own row with recurrence NULL (the
 * view-time expander passes such rows straight through), and a master's
 * `@removed` delta item deletes its occurrences by id.
 */

/** Page size for the calendar list (`$top`) — one page covers most users. */
const CALENDAR_PAGE_SIZE = 100
/** Safety cap on delta pages per pass (the reference's loop guard). */
const MAX_DELTA_PAGES = 1000
/** Page size for calendarView delta passes (`$top`). */
const DELTA_PAGE_SIZE = 500

/** Full-sync window: one year back, ~13 months ahead (epoch seconds). */
const FULL_SYNC_WINDOW_PAST_SECONDS = 365 * 24 * 60 * 60
const FULL_SYNC_WINDOW_FUTURE_SECONDS = 400 * 24 * 60 * 60

/**
 * Access-token bundle for calling the Graph calendar surface: the linked
 * mail account id (for typed auth errors) plus a token source built by
 * connect-microsoft.ts over the shared Microsoft token-manager machinery.
 */
export interface MicrosoftCalendarTokens {
  accountId: string
  getToken(force?: boolean): Promise<string>
  fetchImpl?: FetchImpl
  /** Injectable wait for the Retry-After backoff (tests record waits). */
  delayImpl?: (ms: number) => Promise<void>
}

// ---------------------------------------------------------------------------
// Wire types (Graph v1.0 calendar)
// ---------------------------------------------------------------------------

/** GET /me/calendars entry. */
export interface MicrosoftCalendarListEntry {
  id: string
  name?: string
  /** Preset color name ("lightBlue"); hexColor is the CSS form when set. */
  color?: string
  hexColor?: string
  isDefaultCalendar?: boolean
  canEdit?: boolean
}

/** Graph event time: an offset-free local-style dateTime plus a timeZone
 * name — "UTC" in every response this client produces (no Prefer header
 * is ever sent asking for another zone). */
export interface MicrosoftCalendarDateTime {
  dateTime?: string
  timeZone?: string
}

export interface MicrosoftCalendarEvent {
  id: string
  /** Delta tombstone: the event left the view (id only). */
  "@removed"?: unknown
  /** "singleInstance" | "occurrence" | "exception" | "seriesMaster". */
  type?: string
  /** Set on occurrence/exception items: the (unstored) series master id. */
  seriesMasterId?: string
  /** The iCalendar UID across occurrences of a series. */
  iCalUId?: string
  subject?: string
  bodyPreview?: string
  location?: { displayName?: string }
  start?: MicrosoftCalendarDateTime
  end?: MicrosoftCalendarDateTime
  isAllDay?: boolean
  isCancelled?: boolean
  /** RFC 3339 last-modified timestamp. */
  lastModifiedDateTime?: string
  attendees?: {
    emailAddress?: { address?: string; name?: string }
    status?: { response?: string }
  }[]
}

export interface MicrosoftCalendarPage {
  value?: MicrosoftCalendarEvent[]
  "@odata.nextLink"?: string
  /** Present on the LAST delta page — the opaque cursor to persist. */
  "@odata.deltaLink"?: string
}

/**
 * The events.create/update request body (task 3.6): the fields the event
 * form manages. Absent keys are left untouched on update (PATCH
 * semantics); `reminderMinutes === null` turns the reminder OFF (Graph has
 * no "back to calendar default" PATCH — the honest mapping, unlike
 * Google's useDefault:true, is documented in the event-dialog note).
 */
export interface MicrosoftEventPayload {
  subject?: string
  location?: { displayName?: string }
  body?: { contentType: "text"; content: string }
  isAllDay?: boolean
  start?: { dateTime: string; timeZone: "UTC" }
  end?: { dateTime: string; timeZone: "UTC" }
  attendees?: { emailAddress: { address: string }; type: "required" }[]
  isReminderOn?: boolean
  reminderMinutesBeforeStart?: number
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Default backoff wait — the graph-api throttle shape (queue base). */
function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function toApiError(
  method: string,
  pathOrUrl: string,
  response: Response
): Promise<GraphApiError> {
  let apiMessage = ""
  let code: string | undefined
  try {
    const payload = (await response.json()) as {
      error?: { code?: string; message?: string }
    } | null
    apiMessage = payload?.error?.message ?? ""
    code = payload?.error?.code
  } catch {
    // Non-JSON error body — the status alone still identifies the failure.
  }
  const label = pathOrUrl.startsWith("https://")
    ? "Graph request"
    : `Graph ${method} ${pathOrUrl}`
  const detail = apiMessage ? `: ${apiMessage}` : ""
  return new GraphApiError(
    response.status,
    `${label} failed with ${response.status}${code ? ` [${code}]` : ""}${detail}`,
    code
  )
}

/**
 * One Graph calendar request: Bearer-authenticated, one silent refresh +
 * retry on 401, then ProviderAuthError (the broken calendar grant);
 * Retry-After backoff on 429/503 with the graph-api throttle shape and
 * bounded retries; GraphApiError with the VERBATIM Graph error message
 * otherwise. Absolute URLs (validated nextLinks/deltaLinks) pass through
 * unchanged. Token values never appear in errors or logs.
 */
async function calendarRequest<T>(
  method: string,
  pathOrUrl: string,
  tokens: MicrosoftCalendarTokens,
  options: { json?: unknown } = {}
): Promise<T> {
  const fetchImpl = tokens.fetchImpl ?? fetch
  const delayImpl = tokens.delayImpl ?? defaultDelay
  const url = pathOrUrl.startsWith("https://")
    ? pathOrUrl
    : `${GRAPH_API_ROOT}/${pathOrUrl.replace(/^\//, "")}`

  async function send(accessToken: string): Promise<Response> {
    return fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(options.json !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
      ...(options.json !== undefined
        ? { body: JSON.stringify(options.json) }
        : {}),
    })
  }

  let response = await send(await tokens.getToken())
  if (response.status === 401) {
    // One silent refresh, one retry — then the calendar grant is broken.
    response = await send(await tokens.getToken(true))
    if (response.status === 401) {
      throw new ProviderAuthError(
        tokens.accountId,
        "microsoft",
        "Microsoft Graph rejected the calendar access token after a " +
          "silent refresh; re-connect the calendar source"
      )
    }
  }
  for (let retry = 0; retry < MAX_THROTTLE_RETRIES; retry++) {
    if (response.status !== 429 && response.status !== 503) break
    const waitMs =
      retryAfterMsOf((name) => response.headers.get(name)) ??
      Math.min(THROTTLE_BASE_MS * 2 ** retry, THROTTLE_MAX_WAIT_MS)
    await delayImpl(waitMs)
    response = await send(await tokens.getToken())
  }
  if (!response.ok) {
    throw await toApiError(method, pathOrUrl, response)
  }
  // DELETE answers 204 with an empty body — resolve to null rather than
  // failing the JSON parse.
  const text = await response.text()
  if (text.trim().length === 0) {
    return null as T
  }
  return JSON.parse(text) as T
}

/**
 * Discovery (spec: "Connection SHALL discover the available calendars"):
 * GET /me/calendars, following validated nextLinks with the reference's
 * loop guards (a repeated link or an over-long page run fails the pass).
 */
export async function listMicrosoftCalendars(
  tokens: MicrosoftCalendarTokens,
  fetchImpl: FetchImpl = fetch
): Promise<MicrosoftCalendarListEntry[]> {
  const calendars: MicrosoftCalendarListEntry[] = []
  const seenLinks = new Set<string>()
  let url: string | null =
    `me/calendars?$select=id,name,color,hexColor,isDefaultCalendar,canEdit` +
    `&$top=${CALENDAR_PAGE_SIZE}`
  while (url) {
    const page = await calendarRequest<MicrosoftCalendarPage>(
      "GET",
      url,
      { ...tokens, fetchImpl }
    )
    for (const entry of page.value ?? []) {
      if (entry.id) calendars.push(entry)
    }
    const next = page["@odata.nextLink"]
    if (!next) break
    if (seenLinks.has(next)) {
      throw new GraphApiError(
        500,
        "Microsoft Graph repeated a calendar page link",
        "paginationLoop"
      )
    }
    seenLinks.add(next)
    url = validatedGraphLink(next)
  }
  return calendars
}

// ---------------------------------------------------------------------------
// Event writes (task 3.6) — online-write contract
//
// The three write verbs the event form needs, riding the SAME fetch seam
// and the same 401-refresh-retry/error mapping as the read path above.
// Callers (services/calendar/event-writes.ts) enforce the online-write
// contract BEFORE these run: no network call may happen while offline, a
// local calendar_events row is written only after the server confirmed,
// and any failure surfaces as a typed result — the UI must be able to say
// plainly that the write did NOT persist.
// ---------------------------------------------------------------------------

/** events.create — POST the payload into one calendar; returns the stored
 * event (its server-assigned id becomes the local row's uid). */
export async function insertMicrosoftEvent(
  tokens: MicrosoftCalendarTokens,
  calendarId: string,
  payload: MicrosoftEventPayload,
  fetchImpl: FetchImpl = fetch
): Promise<MicrosoftCalendarEvent> {
  return calendarRequest<MicrosoftCalendarEvent>(
    "POST",
    `me/calendars/${encodeURIComponent(calendarId)}/events`,
    { ...tokens, fetchImpl },
    { json: payload }
  )
}

/** events.update via PATCH — only the payload's present keys change. */
export async function updateMicrosoftEvent(
  tokens: MicrosoftCalendarTokens,
  calendarId: string,
  eventId: string,
  payload: MicrosoftEventPayload,
  fetchImpl: FetchImpl = fetch
): Promise<MicrosoftCalendarEvent | null> {
  return calendarRequest<MicrosoftCalendarEvent | null>(
    "PATCH",
    `me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { ...tokens, fetchImpl },
    { json: payload }
  )
}

/**
 * events.delete — an empty 204 body resolves to null. A 404 counts as
 * success (already gone remotely — the reference's tolerant delete); any
 * other failure throws for the caller's typed mapping.
 */
export async function deleteMicrosoftEvent(
  tokens: MicrosoftCalendarTokens,
  calendarId: string,
  eventId: string,
  fetchImpl: FetchImpl = fetch
): Promise<null> {
  try {
    return await calendarRequest<null>(
      "DELETE",
      `me/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { ...tokens, fetchImpl }
    )
  } catch (error) {
    if (
      error instanceof GraphApiError &&
      error.status === 404
    ) {
      return null
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Payload building (form fields → Graph event body)
// ---------------------------------------------------------------------------

/** Offset-free UTC DATE-TIME ("2026-03-02T08:00:00") from epoch seconds —
 * the `timeZone: "UTC"` pair makes Graph render it in the viewer's zone. */
function graphDateTime(seconds: number, allDay: boolean): string {
  const date = new Date(seconds * 1000)
  const pad = (value: number): string => String(value).padStart(2, "0")
  const day = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
  // All-day events must sit on a midnight boundary (the reference's rule).
  return allDay
    ? `${day}T00:00:00`
    : `${day}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
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
 * Build the events.create/update body from merged form fields. All-day
 * events carry `isAllDay: true` with midnight bounds (end EXCLUSIVE — the
 * cache convention, also Graph's), timed events offset-free UTC
 * dateTime strings. Guests go out as required attendees; a number
 * reminder becomes isReminderOn + minutes-before-start, and an explicit
 * null turns the reminder off (see the payload type's doc).
 */
export function buildMicrosoftEventPayload(fields: {
  title?: string
  startAt?: number
  endAt?: number
  allDay?: boolean
  location?: string | null
  description?: string | null
  guests?: string[]
  reminderMinutes?: number | null
}): MicrosoftEventPayload {
  const payload: MicrosoftEventPayload = {}
  if (fields.title !== undefined) payload.subject = fields.title
  if (fields.location !== undefined) {
    payload.location = { displayName: fields.location || "" }
  }
  if (fields.description !== undefined) {
    payload.body = { contentType: "text", content: fields.description || "" }
  }
  if (fields.startAt !== undefined && fields.endAt !== undefined) {
    const allDay = fields.allDay === true
    payload.isAllDay = allDay
    payload.start = {
      dateTime: graphDateTime(fields.startAt, allDay),
      timeZone: "UTC",
    }
    // All-day ends are exclusive; keep at least the one started day.
    const endSeconds = allDay
      ? Math.max(fields.endAt, fields.startAt + 86_400)
      : Math.max(fields.endAt, fields.startAt + 60)
    payload.end = {
      dateTime: graphDateTime(endSeconds, allDay),
      timeZone: "UTC",
    }
  }
  if (fields.guests !== undefined) {
    payload.attendees = dedupeGuests(fields.guests).map((address) => ({
      emailAddress: { address },
      type: "required" as const,
    }))
  }
  if (fields.reminderMinutes !== undefined) {
    if (fields.reminderMinutes === null) {
      payload.isReminderOn = false
    } else {
      payload.isReminderOn = true
      payload.reminderMinutesBeforeStart = fields.reminderMinutes
    }
  }
  return payload
}

// ---------------------------------------------------------------------------
// Event mapping (Graph event → calendar_events row)
// ---------------------------------------------------------------------------

/**
 * Parse a Graph `{ dateTime, timeZone }` pair into epoch seconds. Graph
 * returns an offset-free local-style string interpreted in `timeZone`
 * (UTC unless a Prefer header asked otherwise — none is sent), so a bare
 * string is read as UTC; explicit Z/offset suffixes parse as themselves.
 * Null when absent/unparseable.
 */
export function graphDateTimeSeconds(
  when: MicrosoftCalendarDateTime | undefined
): number | null {
  const raw = when?.dateTime
  if (!raw) return null
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)
  const ms = Date.parse(zoned ? raw : `${raw}Z`)
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

/**
 * Render the cached `ical` column: a minimal RFC 5545 VEVENT from the
 * Graph payload — the same shape google-calendar.ts writes, CRLF line
 * endings, TEXT escaping, all-day DATE values (from the dateTime's date
 * part), UTC DATE-TIME otherwise. Deliberately unfolded: the column is
 * written and consumed by this app only.
 */
export function microsoftEventToIcal(event: MicrosoftCalendarEvent): string {
  function escapeText(value: string): string {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r?\n/g, "\\n")
  }

  function dtProperty(key: string, when: MicrosoftCalendarDateTime): string {
    const seconds = graphDateTimeSeconds(when)
    if (seconds === null) {
      // Unparseable dateTime: echo the raw value rather than inventing one.
      return `${key}:${when.dateTime ?? ""}`
    }
    if (event.isAllDay === true) {
      return `${key};VALUE=DATE:${new Date(seconds * 1000)
        .toISOString()
        .slice(0, 10)
        .replace(/-/g, "")}`
    }
    return `${key}:${new Date(seconds * 1000)
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}/, "")}`
  }

  const lines: string[] = ["BEGIN:VEVENT"]
  lines.push(`UID:${event.id}`)
  if (event.start) lines.push(dtProperty("DTSTART", event.start))
  if (event.end) lines.push(dtProperty("DTEND", event.end))
  if (event.subject) lines.push(`SUMMARY:${escapeText(event.subject)}`)
  const location = event.location?.displayName
  if (location) lines.push(`LOCATION:${escapeText(location)}`)
  if (event.bodyPreview) {
    lines.push(`DESCRIPTION:${escapeText(event.bodyPreview)}`)
  }
  lines.push(`STATUS:${event.isCancelled ? "CANCELLED" : "CONFIRMED"}`)
  lines.push("END:VEVENT")
  return lines.join("\r\n")
}

/** Deterministic calendar_events.id for one provider event key. */
function calendarEventRowId(
  sourceId: string,
  calendarId: string,
  uid: string
): string {
  // Graph ids never contain ":" and source ids are app-generated, so the
  // triple is unambiguous.
  return `ce-${sourceId}:${calendarId}:${uid}`
}

export interface MappedMicrosoftEvent {
  input: CalendarEventInput
  /** `@removed` delta tombstone (id only) — DELETE the local row. */
  isTombstone: boolean
}

/**
 * Map one Graph calendarView event to a calendar_events upsert input:
 * `isAllDay` + midnight bounds → all_day (Graph's all-day end is
 * EXCLUSIVE, stored as-is so the view treats [start, end) uniformly);
 * timed events → epoch seconds from the (UTC) dateTime. isCancelled maps
 * to the Google-style "cancelled" status the row stores. Series MASTERS
 * return null (calendarView materializes their occurrences as individual
 * events — storing the master too would double-render the series);
 * events without usable id/times return null; `@removed` items surface as
 * tombstones so the local row is deleted.
 */
export function mapMicrosoftEvent(
  sourceId: string,
  calendarId: string,
  event: MicrosoftCalendarEvent
): MappedMicrosoftEvent | null {
  const uid = event.id
  if (!uid) return null
  // The series master itself is never stored — see the doc comment.
  if (event.type === "seriesMaster") return null

  if (event["@removed"] !== undefined) {
    return {
      isTombstone: true,
      input: {
        id: calendarEventRowId(sourceId, calendarId, uid),
        sourceId,
        calendarId,
        uid,
        ical: "",
        startAt: 0,
        endAt: 0,
        allDay: false,
        status: "cancelled",
      },
    }
  }

  const startAt = graphDateTimeSeconds(event.start)
  const endAt = graphDateTimeSeconds(event.end)
  if (startAt === null || endAt === null) {
    return null
  }
  const allDay = event.isAllDay === true

  return {
    isTombstone: false,
    input: {
      id: calendarEventRowId(sourceId, calendarId, uid),
      sourceId,
      calendarId,
      uid,
      ical: microsoftEventToIcal(event),
      summary: event.subject,
      location: event.location?.displayName,
      description: event.bodyPreview,
      startAt,
      endAt,
      allDay,
      // calendarView materializes occurrences server-side: rows carry no
      // recurrence rules, so the view-time expander passes them through.
      recurrence: undefined,
      status: event.isCancelled ? "cancelled" : "confirmed",
      updatedAt: event.lastModifiedDateTime
        ? Math.floor(Date.parse(event.lastModifiedDateTime) / 1000) ||
          undefined
        : undefined,
    },
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Upsert events from one calendarView page set (server-wins: mutable
 * fields are overwritten, id/created_at stay). Follows the codebase's
 * select-then-insert-or-update upsert pattern (db/messages.ts, and the
 * google-calendar.ts sibling). `@removed` tombstones DELETE their local
 * row.
 */
export async function upsertMicrosoftEventsFromApi(
  executor: SqlExecutor,
  sourceId: string,
  calendarId: string,
  items: MicrosoftCalendarEvent[]
): Promise<{ stored: number; removed: number }> {
  let stored = 0
  let removed = 0

  for (const event of items) {
    const mapped = mapMicrosoftEvent(sourceId, calendarId, event)
    if (!mapped) continue

    if (mapped.isTombstone) {
      removed += await executor
        .execute(
          "DELETE FROM calendar_events WHERE source_id = $1 AND calendar_id = $2 AND uid = $3",
          [sourceId, calendarId, mapped.input.uid]
        )
        .then((result) => result.rowsAffected)
      continue
    }

    const input = mapped.input
    const existing = await executor.select<{ id: string }>(
      "SELECT id FROM calendar_events WHERE source_id = $1 AND calendar_id = $2 AND uid = $3",
      [sourceId, calendarId, input.uid]
    )
    if (existing.length > 0) {
      await executor.execute(
        `UPDATE calendar_events SET
           ical = $1, summary = $2, location = $3, description = $4,
           start_at = $5, end_at = $6, all_day = $7, recurrence = $8,
           status = $9, updated_at = $10
         WHERE id = $11`,
        [
          input.ical,
          input.summary ?? null,
          input.location ?? null,
          input.description ?? null,
          input.startAt,
          input.endAt,
          input.allDay ? 1 : 0,
          input.recurrence ?? null,
          input.status ?? null,
          input.updatedAt ?? null,
          input.id,
        ]
      )
    } else {
      await executor.execute(
        `INSERT INTO calendar_events (
           id, source_id, calendar_id, uid, ical, summary, location,
           description, start_at, end_at, all_day, recurrence, status,
           updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          input.id,
          sourceId,
          calendarId,
          input.uid,
          input.ical,
          input.summary ?? null,
          input.location ?? null,
          input.description ?? null,
          input.startAt,
          input.endAt,
          input.allDay ? 1 : 0,
          input.recurrence ?? null,
          input.status ?? null,
          input.updatedAt ?? null,
        ]
      )
    }
    stored += 1
  }

  return { stored, removed }
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** `YYYY-MM-DDTHH:mm:ssZ` from epoch seconds — the Z SUFFIX is required:
 * an RFC 3339 `+00:00` offset would put a literal `+` in the query string,
 * which decodes to a space server-side (the reference's insight). */
function zSuffix(seconds: number): string {
  return `${new Date(seconds * 1000).toISOString().slice(0, 19)}Z`
}

/** The initial calendarView delta URL for a calendar and time window. */
function calendarViewDeltaUrl(
  calendarId: string,
  startSeconds: number,
  endSeconds: number
): string {
  return (
    `me/calendars/${encodeURIComponent(calendarId)}/calendarView/delta` +
    `?startDateTime=${zSuffix(startSeconds)}` +
    `&endDateTime=${zSuffix(endSeconds)}` +
    `&$top=${DELTA_PAGE_SIZE}`
  )
}

export interface SyncMicrosoftEventsOptions {
  /**
   * Full-pass window bounds (epoch seconds). Defaults: one year back,
   * ~13 months ahead — the cached offline range, matching the Google full
   * sync's one-year browsing window.
   */
  windowStartSeconds?: number
  windowEndSeconds?: number
  fetchImpl?: FetchImpl
  delayImpl?: (ms: number) => Promise<void>
}

export interface SyncMicrosoftEventsResult {
  mode: "full" | "delta" | "full-resync"
  /** Events upserted (or tombstone-deleted) by this pass. */
  stored: number
  removed: number
  /** The fresh deltaLink persisted for the next incremental pass. */
  deltaLink: string | null
}

/**
 * Incremental sync of one calendar (task 3.6). Reads the stored deltaLink
 * from the source's sync state, pages through calendarView/delta (moving
 * only through pre-validated graph.microsoft.com links, bounded pages,
 * repeated-link guard), upserts the mapped events, and persists the fresh
 * deltaLink. A 410 GONE — the delta token expired and the window must
 * re-anchor — clears the calendar's cached events and re-runs the full
 * pass once (mode "full-resync"); a second failure surfaces to the
 * caller. Series masters are skipped (their occurrences arrive as
 * individual rows), so the deltaLink lives in sync_state_json's
 * nextSyncToken field alongside the Google sync tokens.
 */
export async function syncMicrosoftCalendarEvents(
  executor: SqlExecutor,
  source: CalendarSource,
  calendarId: string,
  tokens: MicrosoftCalendarTokens,
  options: SyncMicrosoftEventsOptions = {}
): Promise<SyncMicrosoftEventsResult> {
  const fetchImpl = options.fetchImpl ?? tokens.fetchImpl ?? fetch

  function windowSeconds(): { start: number; end: number } {
    const now = Math.floor(Date.now() / 1000)
    return {
      start:
        options.windowStartSeconds ??
        now - FULL_SYNC_WINDOW_PAST_SECONDS,
      end: options.windowEndSeconds ?? now + FULL_SYNC_WINDOW_FUTURE_SECONDS,
    }
  }

  async function runPass(
    mode: "full" | "delta" | "full-resync",
    startUrl: string
  ): Promise<SyncMicrosoftEventsResult> {
    const events: MicrosoftCalendarEvent[] = []
    const seenLinks = new Set<string>()
    let deltaLink: string | null = null
    let url: string | null = startUrl

    for (let page = 0; page < MAX_DELTA_PAGES && url; page += 1) {
      const pageData = await calendarRequest<MicrosoftCalendarPage>(
        "GET",
        url,
        { ...tokens, fetchImpl }
      )
      events.push(...(pageData.value ?? []))
      const rawDelta = pageData["@odata.deltaLink"]
      if (rawDelta) {
        // The deltaLink is the pass's real product — an unusable one (non-
        // Graph host) is treated as end-of-pages, and its absence makes
        // the NEXT pass a full one rather than trusting a broken cursor.
        deltaLink = validatedGraphLink(rawDelta)
        break
      }
      const next = pageData["@odata.nextLink"]
      if (!next) break
      if (seenLinks.has(next)) {
        throw new GraphApiError(
          500,
          "Microsoft Graph repeated a pagination link"
        )
      }
      seenLinks.add(next)
      url = validatedGraphLink(next)
    }

    const { stored, removed } = await upsertMicrosoftEventsFromApi(
      executor,
      source.id,
      calendarId,
      events
    )
    return { mode, stored, removed, deltaLink }
  }

  const storedLink =
    (await getCalendarSyncState(executor, source.id))[calendarId]
      ?.nextSyncToken

  let result: SyncMicrosoftEventsResult
  if (storedLink) {
    try {
      result = await runPass("delta", storedLink)
    } catch (error) {
      // 410 GONE: the delta token expired — drop the calendar's cached
      // events and re-anchor the window from scratch once; a second
      // failure surfaces to the caller.
      if (error instanceof GraphApiError && error.status === 410) {
        await executor.execute(
          "DELETE FROM calendar_events WHERE source_id = $1 AND calendar_id = $2",
          [source.id, calendarId]
        )
        const window = windowSeconds()
        result = await runPass(
          "full-resync",
          calendarViewDeltaUrl(calendarId, window.start, window.end)
        )
      } else {
        throw error
      }
    }
  } else {
    const window = windowSeconds()
    result = await runPass(
      "full",
      calendarViewDeltaUrl(calendarId, window.start, window.end)
    )
  }

  await updateCalendarSyncState(executor, source.id, calendarId, {
    nextSyncToken: result.deltaLink,
    lastSyncAt: Math.floor(Date.now() / 1000),
    lastError: null,
  })
  return result
}

// ---------------------------------------------------------------------------
// Token source from a stored (sealed) source row
// ---------------------------------------------------------------------------

/**
 * Production calendar tokens: decrypts the source's SEALED config
 * envelope (the calendar-scope consent round's token set — see
 * connect-microsoft.ts; plaintext never persists and errors never carry
 * token values) and rides the shared Microsoft token manager under a
 * `calendar:<sourceId>` namespaced pseudo-account id, so the in-memory
 * access-token cache cannot collide with the mail account's entries.
 *
 * Rotation re-seal: Entra ROTATES refresh tokens on refresh grants, so
 * the token manager's persist hook re-seals the rotated envelope back
 * into THIS source row's config_json (best effort — a sealing failure
 * never breaks the API call). The mail account's credentials envelope is
 * never touched, and the client id is carried through every re-seal (the
 * envelope must stay self-contained for the next silent refresh).
 */
export async function createMicrosoftCalendarTokens(
  executor: SqlExecutor,
  source: CalendarSource,
  fetchImpl: FetchImpl = fetch
): Promise<MicrosoftCalendarTokens> {
  const envelope = await decryptCredentials<{
    refreshToken: string
    accessToken?: string
    accessTokenExpiresAt?: number
    clientId?: string
  }>(source.configJson)
  if (!envelope?.refreshToken) {
    throw new ProviderAuthError(
      source.accountId ?? source.id,
      "microsoft",
      "No calendar refresh token is stored for this source; " +
        "re-connect the calendar source"
    )
  }
  const clientId = envelope.clientId
  if (!clientId) {
    throw new ProviderAuthError(
      source.accountId ?? source.id,
      "microsoft",
      "No Microsoft OAuth client id is stored for this calendar source; " +
        "re-connect the calendar source"
    )
  }
  const sourceId = source.id
  const tokenSource = createMicrosoftTokenSource(
    { id: `calendar:${sourceId}`, oauthClientId: clientId },
    envelope,
    fetchImpl,
    {
      persist: async (next) => {
        const configJson = await encryptCredentials({ ...next, clientId })
        await executor.execute(
          "UPDATE calendar_sources SET config_json = $1 WHERE id = $2",
          [configJson, sourceId]
        )
      },
    }
  )
  return {
    accountId: source.accountId ?? source.id,
    getToken: (force?: boolean) => tokenSource.getToken(force),
    fetchImpl,
  }
}
