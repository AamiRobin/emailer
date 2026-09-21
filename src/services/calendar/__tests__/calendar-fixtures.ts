import type { SqlExecutor } from "../../db/executor"
import { uid } from "../../db/__tests__/fixtures"
import type {
  GoogleCalendarEvent,
  GoogleCalendarListEntry,
  GoogleEventAttendee,
} from "../google-calendar"
import type { GoogleCalendarListPage, GoogleEventsPage } from "../google-calendar"
import type {
  MicrosoftCalendarDateTime,
  MicrosoftCalendarEvent,
  MicrosoftCalendarListEntry,
  MicrosoftCalendarPage,
} from "../microsoft-calendar"

/**
 * Google Calendar API fixtures (task 5.1) — wire-shape builders for the
 * provider tests. The fetch seam itself (a URL-substring router) is reused
 * from the Gmail fixtures so both REST clients test through the same
 * double.
 */

export { createFetchMock } from "../../email/__tests__/gmail-fixtures"
export type { FetchMock, RecordedRequest } from "../../email/__tests__/gmail-fixtures"

// ---------------------------------------------------------------------------
// Wire payload builders
// ---------------------------------------------------------------------------

export function calendarListEntry(
  overrides: Partial<GoogleCalendarListEntry> = {}
): GoogleCalendarListEntry {
  return {
    id: uid("cal"),
    summary: "Test calendar",
    accessRole: "owner",
    ...overrides,
  }
}

export interface SampleEventOverrides {
  id?: string
  status?: GoogleCalendarEvent["status"]
  summary?: string
  location?: string
  description?: string
  start?: GoogleCalendarEvent["start"]
  end?: GoogleCalendarEvent["end"]
  recurrence?: string[]
  attendees?: GoogleEventAttendee[]
  updated?: string
}

/** A typical timed event (fixed instants, +02:00 offset like real data). */
export function googleEvent(
  overrides: SampleEventOverrides = {}
): GoogleCalendarEvent {
  return {
    id: uid("ev"),
    status: "confirmed",
    summary: "Review",
    start: { dateTime: "2026-03-02T10:00:00+02:00" },
    end: { dateTime: "2026-03-02T11:00:00+02:00" },
    updated: "2026-02-20T08:30:00.000Z",
    ...overrides,
  }
}

export function eventsPage(
  items: GoogleCalendarEvent[],
  overrides: Partial<GoogleEventsPage> = {}
): GoogleEventsPage {
  return { items, ...overrides }
}

export function calendarListPage(
  items: GoogleCalendarListEntry[],
  overrides: Partial<GoogleCalendarListPage> = {}
): GoogleCalendarListPage {
  return { items, ...overrides }
}

// ---------------------------------------------------------------------------
// DB fixture: a stored calendar source (config stays sealed/opaque here)
// ---------------------------------------------------------------------------

export async function createCalendarSource(
  executor: SqlExecutor,
  accountId: string | null,
  overrides: {
    id?: string
    name?: string
    provider?: "google" | "caldav" | "microsoft"
    configJson?: string
    syncStateJson?: string
  } = {}
): Promise<string> {
  const id = overrides.id ?? uid("src")
  await executor.execute(
    `INSERT INTO calendar_sources (id, account_id, provider, name, config_json, sync_state_json)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      accountId,
      overrides.provider ?? "google",
      overrides.name ?? "me@gmail.com",
      // Sealed-envelope stand-in: provider tests inject fake token sources,
      // so the ciphertext content is never opened.
      overrides.configJson ?? "sealed-config-ciphertext",
      overrides.syncStateJson ?? null,
    ]
  )
  return id
}

// ---------------------------------------------------------------------------
// Microsoft Graph payload builders (task 3.6)
// ---------------------------------------------------------------------------

/** A calendar from GET /me/calendars. */
export function microsoftCalendar(
  overrides: Partial<MicrosoftCalendarListEntry> = {}
): MicrosoftCalendarListEntry {
  return {
    id: uid("gcal"),
    name: "Calendar",
    isDefaultCalendar: false,
    canEdit: true,
    ...overrides,
  }
}

export interface MicrosoftEventOverrides {
  id?: string
  removed?: boolean
  type?: string
  seriesMasterId?: string
  iCalUId?: string
  subject?: string
  bodyPreview?: string
  location?: string
  /** Wire date-time pairs (defaults: offset-free UTC dateTimes). */
  start?: MicrosoftCalendarDateTime
  end?: MicrosoftCalendarDateTime
  isAllDay?: boolean
  isCancelled?: boolean
  lastModifiedDateTime?: string
}

/** A typical calendarView delta item: timed, offset-free UTC times. */
export function microsoftEvent(
  overrides: MicrosoftEventOverrides = {}
): MicrosoftCalendarEvent {
  if (overrides.removed) {
    // A delta tombstone carries only the id plus @removed.
    return { id: overrides.id ?? uid("gev"), "@removed": { reason: "deleted" } }
  }
  const { location, ...rest } = overrides
  return {
    id: uid("gev"),
    type: "singleInstance",
    subject: "Review",
    bodyPreview: "Quarterly review notes",
    location: { displayName: location ?? "Room 4" },
    start: { dateTime: "2026-03-02T08:00:00", timeZone: "UTC" },
    end: { dateTime: "2026-03-02T09:00:00", timeZone: "UTC" },
    isAllDay: false,
    isCancelled: false,
    lastModifiedDateTime: "2026-02-20T08:30:00Z",
    ...rest,
  }
}

export function microsoftViewPage(
  items: MicrosoftCalendarEvent[],
  overrides: { nextLink?: string; deltaLink?: string } = {}
): MicrosoftCalendarPage {
  return {
    value: items,
    ...(overrides.nextLink ? { "@odata.nextLink": overrides.nextLink } : {}),
    ...(overrides.deltaLink
      ? { "@odata.deltaLink": overrides.deltaLink }
      : {}),
  }
}
