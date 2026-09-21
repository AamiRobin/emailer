import type { SqlExecutor } from "../db/executor"
import { decryptCredentials } from "../crypto/credentials"
import type { FetchImpl } from "../email/token-manager"
import { createTokenSource } from "../email/token-manager"
import { ProviderAuthError } from "../email/types"
import type { CalendarSource } from "./sources"
import { getCalendarSyncState, updateCalendarSyncState } from "./sources"

/**
 * Google Calendar provider (task 5.1, design D5).
 *
 * The Google data path in this codebase is TypeScript over the fetch patched
 * by tauri-plugin-http (the Gmail provider precedent, design D2) — the
 * Calendar REST API v3 rides the same www.googleapis.com capability. This
 * module mirrors email/gmail-api.ts: a thin typed client over the injected
 * fetchImpl (tests inject a fixture router; production resolves the global
 * fetch), Bearer-authenticated through a token source built on the shared
 * token-manager machinery.
 *
 * Incremental sync uses Google's events.list sync tokens:
 * - First pass (no stored nextSyncToken): a full sync with a `timeMin`
   * lower bound (default: one year back) — the offline browsing range the
 *   calendar spec asks for. The response's `nextSyncToken` is stored per
 *   (source, calendar) in calendar_sources.sync_state_json.
 * - Later passes: only `syncToken` is sent (Google rejects it together with
 *   timeMin) and events are upserted by (source, calendar, uid); tombstones
 *   arrive as status=cancelled entries.
 * - A 410 GONE (token expired/pruned server-side) wipes the local events of
 *   that calendar and re-runs the full sync once, storing the fresh token.
 *
 * Sync tokens require singleEvents=false, so recurring events are stored as
 * their RRULE-bearing master (the raw recurrence array JSON) — occurrence
 * expansion happens at view time (task 5.3).
 */

export const CALENDAR_API_ROOT = "https://www.googleapis.com/calendar/v3"

/** events.list page size — the API maximum, minimizing round-trips. */
const MAX_RESULTS = 2500

/** Default full-sync lower bound: one year back, in seconds. */
const DEFAULT_FULL_SYNC_WINDOW_SECONDS = 365 * 24 * 60 * 60

/**
 * Access-token bundle for calling the Calendar API: the linked mail
 * account id (for typed auth errors) plus a token source built by
 * calendar/connect.ts over the shared token-manager machinery.
 */
export interface CalendarTokens {
  accountId: string
  getToken(force?: boolean): Promise<string>
  fetchImpl?: FetchImpl
}

/** Typed non-auth API failure: HTTP status plus Google's reason code. */
export class CalendarApiError extends Error {
  readonly status: number
  readonly reason?: string

  constructor(status: number, message: string, reason?: string) {
    super(message)
    this.name = "CalendarApiError"
    this.status = status
    this.reason = reason
  }
}

// ---------------------------------------------------------------------------
// Wire types (Calendar API v3)
// ---------------------------------------------------------------------------

/** GET /users/me/calendarList entry. */
export interface GoogleCalendarListEntry {
  id: string
  summary?: string
  /** Per-calendar override of the display name. */
  summaryOverride?: string
  description?: string
  location?: string
  timeZone?: string
  primary?: boolean
  deleted?: boolean
  accessRole?: string
  backgroundColor?: string
  foregroundColor?: string
}

export interface GoogleCalendarListPage {
  items?: GoogleCalendarListEntry[]
  nextPageToken?: string
}

/** Google's event time: all-day events carry `date`, timed events `dateTime`. */
export interface GoogleEventDateTime {
  date?: string
  /** RFC 3339 with offset. */
  dateTime?: string
  timeZone?: string
}

export interface GoogleCalendarEvent {
  id: string
  status?: "confirmed" | "tentative" | "cancelled"
  summary?: string
  description?: string
  location?: string
  start?: GoogleEventDateTime
  end?: GoogleEventDateTime
  /** Raw recurrence rules, e.g. ["RRULE:FREQ=WEEKLY", "EXDATE:..."]. */
  recurrence?: string[]
  /** RFC 3339 last-modified timestamp. */
  updated?: string
  /** Guests (task 5.4 writes; present on events created/updated here). */
  attendees?: GoogleEventAttendee[]
}

/** One guest on an event (task 5.4 write path). */
export interface GoogleEventAttendee {
  email: string
  /** accepted | tentative | declined | needsAction (RSVP state). */
  responseStatus?: string
}

/**
 * The events.insert/update request body (task 5.4): the fields the event
 * form manages. Absent keys are left untouched on update (PATCH
 * semantics); an explicit `attendees: []` clears the guest list and
 * `reminders: { useDefault: true }` restores the calendar's default
 * reminder.
 */
export interface GoogleEventPayload {
  summary?: string
  location?: string
  description?: string
  start?: GoogleEventDateTime
  end?: GoogleEventDateTime
  attendees?: GoogleEventAttendee[]
  reminders?: {
    useDefault: boolean
    overrides?: { method: "popup" | "email"; minutes: number }[]
  }
}

export interface GoogleEventsPage {
  items?: GoogleCalendarEvent[]
  nextPageToken?: string
  /** Present on the last page of a sync-compatible query. */
  nextSyncToken?: string
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

function queryOf(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) query.set(key, String(value))
  }
  return query.toString()
}

async function calendarRequest<T>(
  path: string,
  query: string,
  tokens: CalendarTokens,
  fetchImpl: FetchImpl,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const method = options.method ?? "GET"
  async function send(accessToken: string): Promise<Response> {
    return fetchImpl(`${CALENDAR_API_ROOT}${path}${query ? `?${query}` : ""}`, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(options.body !== undefined
          ? { "content-type": "application/json" }
          : {}),
      },
      ...(options.body !== undefined
        ? { body: JSON.stringify(options.body) }
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
        "gmail",
        "Google Calendar rejected the access token after a silent refresh; " +
          "re-connect the calendar source"
      )
    }
  }
  if (!response.ok) {
    let reason: string | undefined
    let apiMessage = ""
    try {
      const payload = (await response.json()) as {
        error?: { message?: string; errors?: { reason?: string }[] }
      } | null
      apiMessage = payload?.error?.message ?? ""
      reason = payload?.error?.errors?.[0]?.reason
    } catch {
      // Non-JSON error body — the status alone still identifies the failure.
    }
    throw new CalendarApiError(
      response.status,
      `Google Calendar request failed with ${response.status}` +
        `${reason ? ` [${reason}]` : ""}${apiMessage ? `: ${apiMessage}` : ""}`,
      reason
    )
  }
  // Writes may answer with an empty body (DELETE 200, PATCH 200 without
  // content) — resolve to null rather than failing the JSON parse.
  const text = await response.text()
  if (text.trim().length === 0) {
    return null as T
  }
  return JSON.parse(text) as T
}

/**
 * Discovery (spec: "Connection SHALL discover the available calendars"):
 * GET /users/me/calendarList, following nextPageToken, dropping deleted
 * entries. The user chooses which are shown from this list (task 5.3 wires
 * the checkboxes).
 */
export async function listCalendars(
  tokens: CalendarTokens,
  fetchImpl: FetchImpl = fetch
): Promise<GoogleCalendarListEntry[]> {
  const calendars: GoogleCalendarListEntry[] = []
  let pageToken: string | undefined
  do {
    const page = await calendarRequest<GoogleCalendarListPage>(
      "/users/me/calendarList",
      queryOf({ maxResults: MAX_RESULTS, pageToken }),
      tokens,
      fetchImpl
    )
    for (const entry of page.items ?? []) {
      if (entry.deleted !== true) calendars.push(entry)
    }
    pageToken = page.nextPageToken
  } while (pageToken)
  return calendars
}

// ---------------------------------------------------------------------------
// Event writes (task 5.4, design D5) — online-write contract
//
// The three write verbs the event form needs, riding the SAME fetch seam
// and the same 401-refresh-retry/error mapping as the read path above.
// Callers (services/calendar/event-writes.ts) enforce the online-write
// contract BEFORE these run: no network call may happen while offline, a
// local calendar_events row is written only after the server confirmed,
// and any failure surfaces as a typed result — the UI must be able to say
// plainly that the write did NOT persist.
// ---------------------------------------------------------------------------

/** events.insert — POST the payload, returns the stored event (with its
 * server-assigned id, which becomes the local row's uid). */
export async function insertGoogleEvent(
  tokens: CalendarTokens,
  calendarId: string,
  payload: GoogleEventPayload,
  fetchImpl: FetchImpl = fetch
): Promise<GoogleCalendarEvent> {
  return calendarRequest<GoogleCalendarEvent>(
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    "",
    tokens,
    fetchImpl,
    { method: "POST", body: payload }
  )
}

/** events.update via PATCH — only the payload's present keys change. */
export async function updateGoogleEvent(
  tokens: CalendarTokens,
  calendarId: string,
  eventId: string,
  payload: GoogleEventPayload,
  fetchImpl: FetchImpl = fetch
): Promise<GoogleCalendarEvent | null> {
  return calendarRequest<GoogleCalendarEvent | null>(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    "",
    tokens,
    fetchImpl,
    { method: "PATCH", body: payload }
  )
}

/** events.get — the stored event (the RSVP path reads the authoritative
 * attendee list before PATCHing one responseStatus). */
export async function getGoogleEvent(
  tokens: CalendarTokens,
  calendarId: string,
  eventId: string,
  fetchImpl: FetchImpl = fetch
): Promise<GoogleCalendarEvent | null> {
  return calendarRequest<GoogleCalendarEvent | null>(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    "",
    tokens,
    fetchImpl
  )
}

/** events.delete — an empty 200 body resolves to null (fire-and-forget
 * read of the response is not needed). */
export async function deleteGoogleEvent(
  tokens: CalendarTokens,
  calendarId: string,
  eventId: string,
  fetchImpl: FetchImpl = fetch
): Promise<null> {
  return calendarRequest<null>(
    `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    "",
    tokens,
    fetchImpl,
    { method: "DELETE" }
  )
}

// ---------------------------------------------------------------------------
// Event mapping (Google event → calendar_events row)
// ---------------------------------------------------------------------------

/** unix epoch seconds from an RFC 3339 string; NaN when unparseable. */
function parseRfc3339Seconds(value: string): number {
  return Math.floor(Date.parse(value) / 1000)
}

export interface CalendarEventInput {
  id: string
  sourceId: string
  calendarId: string
  uid: string
  ical: string
  summary?: string
  location?: string
  description?: string
  startAt: number
  endAt: number
  allDay: boolean
  recurrence?: string
  status?: string
  updatedAt?: number
}

/** Deterministic calendar_events.id for one provider event key. */
function calendarEventRowId(
  sourceId: string,
  calendarId: string,
  uid: string
): string {
  // ":" never appears in Google event ids (base32url charset) and source
  // ids are app-generated, so the triple is unambiguous.
  return `ce-${sourceId}:${calendarId}:${uid}`
}

/**
 * Render the cached `ical` column: a minimal RFC 5545 VEVENT from the
 * Google payload — CRLF line endings, TEXT escaping (backslash, semicolon,
 * comma, newline), all-day DATE values, and the raw recurrence rules as
 * RRULE/EXDATE lines. Deliberately unfolded (no 75-octet folding): the
 * column is written and consumed by this app only, and the .ics flows
 * (task 5.4+) own any folding when they serialize attachments.
 */
export function googleEventToIcal(event: GoogleCalendarEvent): string {
  function escapeText(value: string): string {
    return value
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r?\n/g, "\\n")
  }

  function dtProperty(key: string, when: GoogleEventDateTime): string {
    if (when.date) {
      return `${key};VALUE=DATE:${when.date.replace(/-/g, "")}`
    }
    const seconds = parseRfc3339Seconds(when.dateTime ?? "")
    if (!Number.isNaN(seconds)) {
      // Normalized to UTC DATE-TIME (basic format, Z suffix).
      return `${key}:${new Date(seconds * 1000)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}/, "")}`
    }
    // Unparseable dateTime: echo the raw value rather than inventing one.
    return `${key}:${when.dateTime ?? ""}`
  }

  const lines: string[] = ["BEGIN:VEVENT"]
  lines.push(`UID:${event.id}`)
  if (event.start) lines.push(dtProperty("DTSTART", event.start))
  if (event.end) lines.push(dtProperty("DTEND", event.end))
  if (event.summary) lines.push(`SUMMARY:${escapeText(event.summary)}`)
  if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`)
  if (event.description) {
    lines.push(`DESCRIPTION:${escapeText(event.description)}`)
  }
  if (event.status) lines.push(`STATUS:${event.status.toUpperCase()}`)
  // Recurrence rules are structural (non-TEXT) content per RFC 5545 —
  // emitted raw, never escaped.
  for (const rule of event.recurrence ?? []) {
    lines.push(rule)
  }
  lines.push("END:VEVENT")
  return lines.join("\r\n")
}

export interface MappedGoogleEvent {
  input: CalendarEventInput
  /** status=cancelled tombstone without times — DELETE the local row. */
  isTombstone: boolean
}

/**
 * Map one Google event to a calendar_events upsert input (task 5.1):
 * `date`-only start/end → all_day at UTC midnight (Google's `end.date` is
 * EXCLUSIVE, stored as-is so the view treats [start, end) uniformly with
 * timed events); `dateTime` → unix seconds from the RFC 3339 offset.
 * `recurrence` keeps the raw rule array JSON. Returns null when the event
 * carries no usable id/times (a cancelled master that lost its payload).
 */
export function mapGoogleEvent(
  sourceId: string,
  calendarId: string,
  event: GoogleCalendarEvent
): MappedGoogleEvent | null {
  const uid = event.id
  if (!uid) return null

  const cancelled = event.status === "cancelled"
  const start = event.start
  const end = event.end

  function whenSeconds(
    when: GoogleEventDateTime | undefined
  ): { seconds: number; allDay: boolean } | null {
    if (!when) return null
    if (when.date) {
      const seconds = parseRfc3339Seconds(`${when.date}T00:00:00Z`)
      return Number.isNaN(seconds) ? null : { seconds, allDay: true }
    }
    if (when.dateTime) {
      const seconds = parseRfc3339Seconds(when.dateTime)
      return Number.isNaN(seconds) ? null : { seconds, allDay: false }
    }
    return null
  }

  const startWhen = whenSeconds(start)
  const endWhen = whenSeconds(end)

  if (!startWhen || !endWhen) {
    // Google's deletion tombstones for single (non-instance) events carry
    // only id + status — surfaced as tombstones so the local row is removed.
    if (cancelled) {
      return {
        isTombstone: true,
        input: {
          id: calendarEventRowId(sourceId, calendarId, uid),
          sourceId,
          calendarId,
          uid,
          ical: googleEventToIcal(event),
          startAt: 0,
          endAt: 0,
          allDay: false,
          status: event.status,
        },
      }
    }
    return null
  }

  return {
    isTombstone: false,
    input: {
      id: calendarEventRowId(sourceId, calendarId, uid),
      sourceId,
      calendarId,
      uid,
      ical: googleEventToIcal(event),
      summary: event.summary,
      location: event.location,
      description: event.description,
      startAt: startWhen.seconds,
      endAt: endWhen.seconds,
      allDay: startWhen.allDay,
      recurrence:
        event.recurrence && event.recurrence.length > 0
          ? JSON.stringify(event.recurrence)
          : undefined,
      status: event.status,
      updatedAt: event.updated
        ? parseRfc3339Seconds(event.updated) || undefined
        : undefined,
    },
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Upsert events from one events.list response (server-wins: mutable fields
 * are overwritten, id/created_at stay). Follows the codebase's
 * select-then-insert-or-update upsert pattern (db/messages.ts) — positional
 * placeholders must ascend by first occurrence, so ON CONFLICT reuse is
 * avoided. Cancelled tombstones without times DELETE their local row.
 */
export async function upsertEventsFromApi(
  executor: SqlExecutor,
  sourceId: string,
  calendarId: string,
  items: GoogleCalendarEvent[]
): Promise<{ stored: number; removed: number }> {
  let stored = 0
  let removed = 0

  for (const event of items) {
    const mapped = mapGoogleEvent(sourceId, calendarId, event)
    if (!mapped) continue

    if (mapped.isTombstone) {
      removed += await executor.execute(
        "DELETE FROM calendar_events WHERE source_id = $1 AND calendar_id = $2 AND uid = $3",
        [sourceId, calendarId, mapped.input.uid]
      ).then((result) => result.rowsAffected)
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

export interface SyncEventsOptions {
  /**
   * Full-sync lower bound (epoch seconds). Default: one year back — the
   * cached offline range. Never sent on incremental passes (Google rejects
   * timeMin together with syncToken).
   */
  timeMinSeconds?: number
  fetchImpl?: FetchImpl
}

export interface SyncEventsResult {
  mode: "full" | "delta" | "full-resync"
  /** Events upserted (or tombstone-deleted) by this pass. */
  stored: number
  removed: number
  /** The fresh cursor persisted for the next incremental pass. */
  nextSyncToken: string | null
}

/**
 * Incremental sync of one calendar (task 5.1). Reads the stored sync token
 * from the source's sync state, pages through events.list, upserts the
 * mapped events, and persists the new nextSyncToken. A 410 GONE — Google
 * expired/pruned the token — clears the calendar's local events and re-runs
 * the full sync once (mode "full-resync"), storing the replacement token.
 * The token lives in sync_state_json (NOT the sealed config envelope):
 * cursors are not secrets and refresh on every pass.
 */
export async function syncEvents(
  executor: SqlExecutor,
  source: CalendarSource,
  calendarId: string,
  tokens: CalendarTokens,
  options: SyncEventsOptions = {}
): Promise<SyncEventsResult> {
  const fetchImpl = options.fetchImpl ?? tokens.fetchImpl ?? fetch

  async function runPass(
    mode: "full" | "delta" | "full-resync",
    syncToken: string | undefined
  ): Promise<SyncEventsResult> {
    const timeMin =
      syncToken === undefined
        ? (options.timeMinSeconds ??
          Math.floor(Date.now() / 1000) - DEFAULT_FULL_SYNC_WINDOW_SECONDS)
        : undefined
    const events: GoogleCalendarEvent[] = []
    let pageToken: string | undefined
    let nextSyncToken: string | null = null

    // Page through pageTokens; the final page carries nextSyncToken.
    for (;;) {
      const page = await calendarRequest<GoogleEventsPage>(
        `/calendars/${encodeURIComponent(calendarId)}/events`,
        queryOf({
          maxResults: MAX_RESULTS,
          syncToken,
          timeMin,
          pageToken,
        }),
        tokens,
        fetchImpl
      )
      events.push(...(page.items ?? []))
      if (page.nextSyncToken) {
        nextSyncToken = page.nextSyncToken
        break
      }
      if (!page.nextPageToken || page.nextPageToken === pageToken) {
        break
      }
      pageToken = page.nextPageToken
    }

    const { stored, removed } = await upsertEventsFromApi(
      executor,
      source.id,
      calendarId,
      events
    )
    return { mode, stored, removed, nextSyncToken }
  }

  const storedToken =
    (await getCalendarSyncState(executor, source.id))[calendarId]
      ?.nextSyncToken

  let result: SyncEventsResult
  if (storedToken) {
    try {
      result = await runPass("delta", storedToken)
    } catch (error) {
      // 410 GONE (reason "gone"/"expired"/"fullSyncRequired"): the token is
      // no longer valid — drop the calendar's cached events and resync from
      // scratch once; a second failure surfaces to the caller.
      if (
        error instanceof CalendarApiError &&
        error.status === 410
      ) {
        await executor.execute(
          "DELETE FROM calendar_events WHERE source_id = $1 AND calendar_id = $2",
          [source.id, calendarId]
        )
        result = await runPass("full-resync", undefined)
      } else {
        throw error
      }
    }
  } else {
    result = await runPass("full", undefined)
  }

  await updateCalendarSyncState(executor, source.id, calendarId, {
    ...(result.nextSyncToken ? { nextSyncToken: result.nextSyncToken } : {}),
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
 * envelope (an OAuth token envelope from the calendar-scope consent round —
 * see calendar/connect.ts; plaintext never persists and errors never carry
 * token values) and rides the shared token-manager silent refresh under a
 * `calendar:<sourceId>` pseudo-account id, so the in-memory access-token
 * cache cannot collide with the mail account's entries.
 */
export async function createCalendarTokens(
  source: CalendarSource,
  fetchImpl: FetchImpl = fetch
): Promise<CalendarTokens> {
  const envelope = await decryptCredentials<{
    refreshToken: string
    accessToken?: string
    accessTokenExpiresAt?: number
    clientId?: string
  }>(source.configJson)
  if (!envelope?.refreshToken) {
    throw new ProviderAuthError(
      source.accountId ?? source.id,
      "gmail",
      "No calendar refresh token is stored for this source; " +
        "re-connect the calendar source"
    )
  }
  const clientId = envelope.clientId
  if (!clientId) {
    throw new ProviderAuthError(
      source.accountId ?? source.id,
      "gmail",
      "No OAuth client id is stored for this calendar source; " +
        "re-connect the calendar source"
    )
  }
  // Namespaced pseudo-account id: the token cache is keyed per id and the
  // calendar envelope's tokens must never be served to a mail call (or vice
  // versa) — see connect.ts for the sealing story.
  const tokenSource = createTokenSource(
    { id: `calendar:${source.id}`, oauthClientId: clientId },
    envelope,
    fetchImpl
  )
  return {
    accountId: source.accountId ?? source.id,
    getToken: (force?: boolean) => tokenSource.getToken(force),
  }
}
