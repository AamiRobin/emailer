import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  calendarListEntry,
  calendarListPage,
  createCalendarSource,
  createFetchMock,
  googleEvent,
  eventsPage,
} from "./calendar-fixtures"
import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { getCalendarSyncState } from "../sources"
import {
  CalendarApiError,
  googleEventToIcal,
  listCalendars,
  mapGoogleEvent,
  syncEvents,
  upsertEventsFromApi,
} from "../google-calendar"
import type { GoogleCalendarEvent } from "../google-calendar"

/**
 * Google Calendar provider tests (task 5.1, design D5): discovery parsing,
 * full + incremental sync with sync-token persistence, the 410 GONE
 * full-resync fallback, pagination, and the Google-event → calendar_events
 * mapping (all-day DATE handling, exclusive end, raw recurrence JSON).
 * The fetch layer is a fixture router (gmail-fixtures' createFetchMock);
 * the token source is a stub — the token machinery itself is covered by the
 * token-manager and connect tests.
 */

function fakeTokens(accessToken = "at-1") {
  return {
    accountId: "acc-1",
    getToken: (force?: boolean) =>
      Promise.resolve(force ? `${accessToken}-forced` : accessToken),
  }
}

async function storedEvents(
  executor: TestExecutor,
  sourceId: string
): Promise<
  {
    uid: string
    calendar_id: string
    summary: string | null
    start_at: number
    end_at: number
    all_day: number
    recurrence: string | null
    status: string | null
    updated_at: number | null
  }[]
> {
  return executor.select(
    `SELECT uid, calendar_id, summary, start_at, end_at, all_day,
            recurrence, status, updated_at
     FROM calendar_events WHERE source_id = $1 ORDER BY uid ASC`,
    [sourceId]
  )
}

describe("listCalendars (discovery)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("parses the calendar list and drops deleted entries", async () => {
    const mock = createFetchMock()
    mock.on("GET", "/users/me/calendarList", () => ({
      json: calendarListPage([
        calendarListEntry({
          id: "cal-primary",
          summary: "me@gmail.com",
          primary: true,
        }),
        calendarListEntry({ id: "cal-work", summary: "Work" }),
        calendarListEntry({ id: "cal-dead", summary: "Deleted", deleted: true }),
      ]),
    }))

    const calendars = await listCalendars(fakeTokens(), mock.fetch)
    expect(calendars.map((calendar) => calendar.id)).toEqual([
      "cal-primary",
      "cal-work",
    ])
    expect(mock.calls[0]?.url).toContain(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList"
    )
    // Bearer-authenticated from the token source.
    expect(mock.calls[0]?.headers.authorization).toBe("Bearer at-1")
  })

  it("follows nextPageToken across discovery pages", async () => {
    const mock = createFetchMock()
    let call = 0
    mock.on("GET", "/users/me/calendarList", () => {
      call += 1
      return call === 1
        ? {
            json: calendarListPage([calendarListEntry({ id: "cal-a" })], {
              nextPageToken: "tok-2",
            }),
          }
        : { json: calendarListPage([calendarListEntry({ id: "cal-b" })]) }
    })

    const calendars = await listCalendars(fakeTokens(), mock.fetch)
    expect(calendars.map((calendar) => calendar.id)).toEqual([
      "cal-a",
      "cal-b",
    ])
    expect(mock.calls[1]?.url).toContain("pageToken=tok-2")
  })

  it("maps API errors to CalendarApiError with the Google reason", async () => {
    const mock = createFetchMock()
    mock.on("GET", "/users/me/calendarList", () => ({
      status: 403,
      json: {
        error: {
          message: "Policy",
          errors: [{ reason: "policyDenied" }],
        },
      },
    }))

    await expect(listCalendars(fakeTokens(), mock.fetch)).rejects.toMatchObject(
      {
        name: "CalendarApiError",
        status: 403,
        reason: "policyDenied",
      }
    )
  })
})

describe("syncEvents (full + incremental + 410 resync)", () => {
  let executor: TestExecutor
  let sourceId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    const accountId = await createAccount(executor)
    sourceId = await createCalendarSource(executor, accountId)
  })

  afterEach(() => {
    executor.close()
  })

  it("runs a full sync (timeMin lower bound), stores events and persists the sync token", async () => {
    const mock = createFetchMock()
    mock.on("GET", "/calendars/cal-main/events", () => ({
      json: eventsPage(
        [
          googleEvent({
            id: "ev-timed",
            summary: "Timed review",
            start: { dateTime: "2026-03-02T10:00:00+02:00" },
            end: { dateTime: "2026-03-02T11:00:00+02:00" },
          }),
          googleEvent({
            id: "ev-all-day",
            summary: "Offsite",
            start: { date: "2026-03-05" },
            end: { date: "2026-03-07" },
          }),
        ],
        { nextSyncToken: "sync-1" }
      ),
    }))

    const result = await syncEvents(
      executor,
      stubSource(),
      "cal-main",
      fakeTokens(),
      { fetchImpl: mock.fetch }
    )

    expect(result).toMatchObject({ mode: "full", stored: 2 })
    expect(result.nextSyncToken).toBe("sync-1")

    // The full pass sends a timeMin lower bound and no syncToken.
    expect(mock.calls[0]?.url).toContain("timeMin=")
    expect(mock.calls[0]?.url).not.toContain("syncToken=")

    const events = await storedEvents(executor, sourceId)
    expect(events.map((event) => event.uid)).toEqual([
      "ev-all-day",
      "ev-timed",
    ])
    const allDay = events.find((event) => event.uid === "ev-all-day")
    // All-day: UTC midnight of the date; the exclusive end kept as-is.
    expect(allDay).toMatchObject({
      all_day: 1,
      start_at: Date.parse("2026-03-05T00:00:00Z") / 1000,
      end_at: Date.parse("2026-03-07T00:00:00Z") / 1000,
    })
    const timed = events.find((event) => event.uid === "ev-timed")
    expect(timed).toMatchObject({
      all_day: 0,
      start_at: Date.parse("2026-03-02T10:00:00+02:00") / 1000,
      end_at: Date.parse("2026-03-02T11:00:00+02:00") / 1000,
      summary: "Timed review",
    })

    // The cursor persisted per source+calendar in the sync state; lastError
    // is CLEARED on success (the key is removed, not stored as null).
    const state = await getCalendarSyncState(executor, sourceId)
    expect(state["cal-main"]).toEqual({
      nextSyncToken: "sync-1",
      lastSyncAt: expect.any(Number),
    })
    expect(state["cal-main"]?.lastSyncAt).toBeGreaterThan(0)
  })

  it("pages through pageTokens and takes nextSyncToken from the last page", async () => {
    const mock = createFetchMock()
    let call = 0
    mock.on("GET", "/calendars/cal-main/events", () => {
      call += 1
      if (call === 1) {
        return {
          json: eventsPage([googleEvent({ id: "ev-1" })], {
            nextPageToken: "page-2",
          }),
        }
      }
      return {
        json: eventsPage([googleEvent({ id: "ev-2" })], {
          nextSyncToken: "sync-final",
        }),
      }
    })

    const result = await syncEvents(
      executor,
      stubSource(),
      "cal-main",
      fakeTokens(),
      { fetchImpl: mock.fetch }
    )
    expect(result.nextSyncToken).toBe("sync-final")
    expect(mock.calls[1]?.url).toContain("pageToken=page-2")

    const events = await storedEvents(executor, sourceId)
    expect(events.map((event) => event.uid)).toEqual(["ev-1", "ev-2"])
  })

  it("runs an incremental pass with the stored syncToken and applies server-wins updates", async () => {
    // Seed: one stored event + a stored cursor.
    await upsertEventsFromApi(executor, sourceId, "cal-main", [
      googleEvent({ id: "ev-existing", summary: "Old title" }),
    ])
    await executor.execute(
      "UPDATE calendar_sources SET sync_state_json = $1 WHERE id = $2",
      [JSON.stringify({ "cal-main": { nextSyncToken: "sync-old" } }), sourceId]
    )

    const mock = createFetchMock()
    mock.on("GET", "/calendars/cal-main/events", () => ({
      json: eventsPage(
        [
          googleEvent({ id: "ev-existing", summary: "New title" }),
          googleEvent({ id: "ev-added", summary: "Fresh" }),
        ],
        { nextSyncToken: "sync-new" }
      ),
    }))

    const result = await syncEvents(
      executor,
      stubSource(),
      "cal-main",
      fakeTokens(),
      { fetchImpl: mock.fetch }
    )

    expect(result).toMatchObject({ mode: "delta", stored: 2 })
    // Incremental pass: syncToken sent, no timeMin.
    expect(mock.calls[0]?.url).toContain("syncToken=sync-old")
    expect(mock.calls[0]?.url).not.toContain("timeMin=")

    const events = await storedEvents(executor, sourceId)
    const existing = events.find((event) => event.uid === "ev-existing")
    expect(existing?.summary).toBe("New title")
    expect(events.map((event) => event.uid)).toEqual([
      "ev-added",
      "ev-existing",
    ])
    expect(await storedTokenOf("cal-main")).toBe("sync-new")
  })

  it("deletes local rows for cancelled tombstones without times", async () => {
    await upsertEventsFromApi(executor, sourceId, "cal-main", [
      googleEvent({ id: "ev-gone", summary: "Will vanish" }),
    ])

    const removed = await upsertEventsFromApi(executor, sourceId, "cal-main", [
      googleEvent({ id: "ev-gone", status: "cancelled", start: undefined, end: undefined }),
    ])
    expect(removed.removed).toBe(1)
    expect(await storedEvents(executor, sourceId)).toEqual([])
  })

  it("resyncs fully on 410 GONE: clears the calendar, restores events and stores the fresh token", async () => {
    // Seed: stale cached event + expired cursor.
    await upsertEventsFromApi(executor, sourceId, "cal-main", [
      googleEvent({ id: "ev-stale", summary: "Stale" }),
    ])
    await executor.execute(
      "UPDATE calendar_sources SET sync_state_json = $1 WHERE id = $2",
      [JSON.stringify({ "cal-main": { nextSyncToken: "sync-dead" } }), sourceId]
    )

    const mock = createFetchMock()
    let eventsCall = 0
    mock.on("GET", "/calendars/cal-main/events", () => {
      eventsCall += 1
      if (eventsCall === 1) {
        // First (incremental) request: token expired.
        return {
          status: 410,
          json: {
            error: {
              message: "Sync token is no longer valid",
              errors: [{ reason: "gone" }],
            },
          },
        }
      }
      return {
        json: eventsPage(
          [
            googleEvent({ id: "ev-fresh-a", summary: "Fresh A" }),
            googleEvent({
              id: "ev-fresh-b",
              summary: "All-day again",
              start: { date: "2026-04-01" },
              end: { date: "2026-04-02" },
            }),
          ],
          { nextSyncToken: "sync-live" }
        ),
      }
    })

    const result = await syncEvents(
      executor,
      stubSource(),
      "cal-main",
      fakeTokens(),
      { fetchImpl: mock.fetch }
    )

    expect(result).toMatchObject({ mode: "full-resync", stored: 2 })
    // Second request is the full pass: timeMin, no syncToken.
    expect(mock.calls[1]?.url).toContain("timeMin=")
    expect(mock.calls[1]?.url).not.toContain("syncToken=")

    const events = await storedEvents(executor, sourceId)
    expect(events.map((event) => event.uid)).toEqual([
      "ev-fresh-a",
      "ev-fresh-b",
    ])
    expect(await storedTokenOf("cal-main")).toBe("sync-live")
  })

  it("surfaces a 410 that happens on the full-resync pass itself", async () => {
    const mock = createFetchMock()
    mock.on("GET", "/calendars/cal-main/events", () => ({
      status: 410,
      json: { error: { errors: [{ reason: "gone" }] } },
    }))

    await expect(
      syncEvents(executor, stubSource(), "cal-main", fakeTokens(), {
        fetchImpl: mock.fetch,
      })
    ).rejects.toMatchObject({ name: "CalendarApiError", status: 410 })
  })

  async function storedTokenOf(calendarId: string): Promise<string | undefined> {
    const state = await getCalendarSyncState(executor, sourceId)
    return state[calendarId]?.nextSyncToken
  }

  /** The minimal CalendarSource view syncEvents needs. */
  function stubSource() {
    return {
      id: sourceId,
      accountId: null,
      provider: "google" as const,
      name: "me@gmail.com",
      configJson: "sealed",
      syncState: {},
      createdAt: 0,
    }
  }
})

describe("mapGoogleEvent (mapping rules)", () => {
  it("maps date-only start/end to all-day UTC-midnight rows with an exclusive end", () => {
    const mapped = mapGoogleEvent(
      "src-1",
      "cal-1",
      googleEvent({
        id: "ev-day",
        summary: "Holiday",
        start: { date: "2026-05-01" },
        end: { date: "2026-05-03" },
      })
    )
    expect(mapped?.isTombstone).toBe(false)
    expect(mapped?.input).toMatchObject({
      sourceId: "src-1",
      calendarId: "cal-1",
      uid: "ev-day",
      allDay: true,
      startAt: Date.parse("2026-05-01T00:00:00Z") / 1000,
      endAt: Date.parse("2026-05-03T00:00:00Z") / 1000,
    })
    expect(mapped?.input.id).toBe("ce-src-1:cal-1:ev-day")
  })

  it("keeps the raw recurrence array as JSON and the provider timestamps", () => {
    const mapped = mapGoogleEvent(
      "src-1",
      "cal-1",
      googleEvent({
        id: "ev-recur",
        recurrence: ["RRULE:FREQ=WEEKLY;BYDAY=MO", "EXDATE;TZID=Europe/Berlin:20260406T100000"],
        updated: "2026-02-21T09:00:00.000Z",
      })
    )
    expect(mapped?.input.recurrence).toBe(
      JSON.stringify([
        "RRULE:FREQ=WEEKLY;BYDAY=MO",
        "EXDATE;TZID=Europe/Berlin:20260406T100000",
      ])
    )
    expect(mapped?.input.updatedAt).toBe(
      Date.parse("2026-02-21T09:00:00.000Z") / 1000
    )
    expect(mapped?.input.allDay).toBe(false)
  })

  it("returns null for unusable payloads and tombstones for cancelled ones", () => {
    expect(mapGoogleEvent("s", "c", googleEvent({ id: "" }))).toBeNull()
    expect(
      mapGoogleEvent("s", "c", googleEvent({ id: "ev-x", start: undefined }))
    ).toBeNull()

    const tombstone = mapGoogleEvent(
      "s",
      "c",
      googleEvent({ id: "ev-dead", status: "cancelled", start: undefined, end: undefined })
    )
    expect(tombstone?.isTombstone).toBe(true)
    expect(tombstone?.input.status).toBe("cancelled")
  })
})

describe("googleEventToIcal (cached iCalendar form)", () => {
  it("renders a CRLF VEVENT with DATE values for all-day events", () => {
    const ical = googleEventToIcal(
      googleEvent({
        id: "ev-day-1",
        summary: "Off,site",
        location: "Room; A",
        start: { date: "2026-05-01" },
        end: { date: "2026-05-02" },
        status: "confirmed",
      })
    )
    const lines = ical.split("\r\n")
    expect(lines[0]).toBe("BEGIN:VEVENT")
    expect(lines).toContain("UID:ev-day-1")
    expect(lines).toContain("DTSTART;VALUE=DATE:20260501")
    expect(lines).toContain("DTEND;VALUE=DATE:20260502")
    expect(lines).toContain("SUMMARY:Off\\,site")
    expect(lines).toContain("LOCATION:Room\\; A")
    expect(lines).toContain("STATUS:CONFIRMED")
    expect(lines[lines.length - 1]).toBe("END:VEVENT")
  })

  it("normalizes timed values to UTC and emits raw recurrence rules", () => {
    const ical = googleEventToIcal(
      googleEvent({
        id: "ev-time-1",
        start: { dateTime: "2026-03-02T10:00:00+02:00" },
        end: { dateTime: "2026-03-02T11:00:00+02:00" },
        recurrence: ["RRULE:FREQ=DAILY;COUNT=5"],
      })
    )
    const lines = ical.split("\r\n")
    expect(lines).toContain("DTSTART:20260302T080000Z")
    expect(lines).toContain("DTEND:20260302T090000Z")
    expect(lines).toContain("RRULE:FREQ=DAILY;COUNT=5")
  })

  it("escapes newlines in text values", () => {
    const ical = googleEventToIcal(
      googleEvent({ id: "ev-nl", description: "line one\nline two" })
    )
    expect(ical).toContain("DESCRIPTION:line one\\nline two")
  })

  it("is deterministic for the same payload", () => {
    const event: GoogleCalendarEvent = googleEvent({ id: "ev-same" })
    expect(googleEventToIcal(event)).toBe(googleEventToIcal(event))
  })
})

describe("upsertEventsFromApi (persistence rules)", () => {
  let executor: TestExecutor
  let sourceId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    const accountId = await createAccount(executor)
    sourceId = await createCalendarSource(executor, accountId)
  })

  afterEach(() => {
    executor.close()
  })

  it("inserts then updates by (source, calendar, uid) without duplicating", async () => {
    const first = await upsertEventsFromApi(executor, sourceId, "cal-x", [
      googleEvent({ id: "ev-1", summary: "One" }),
    ])
    expect(first).toEqual({ stored: 1, removed: 0 })

    const second = await upsertEventsFromApi(executor, sourceId, "cal-x", [
      googleEvent({ id: "ev-1", summary: "One (moved)", location: "B" }),
    ])
    expect(second).toEqual({ stored: 1, removed: 0 })

    const events = await executor.select<{
      summary: string
      location: string | null
    }>("SELECT summary, location FROM calendar_events WHERE source_id = $1", [
      sourceId,
    ])
    expect(events).toEqual([{ summary: "One (moved)", location: "B" }])
  })

  it("scopes the unique key per calendar: the same uid on another calendar inserts separately", async () => {
    await upsertEventsFromApi(executor, sourceId, "cal-a", [
      googleEvent({ id: "shared" }),
    ])
    await upsertEventsFromApi(executor, sourceId, "cal-b", [
      googleEvent({ id: "shared" }),
    ])
    const events = await executor.select<{ calendar_id: string }>(
      "SELECT calendar_id FROM calendar_events WHERE source_id = $1",
      [sourceId]
    )
    expect(events.map((event) => event.calendar_id).sort()).toEqual([
      "cal-a",
      "cal-b",
    ])
  })

  it("rejects a duplicate (source, calendar, uid) at the schema level", async () => {
    await upsertEventsFromApi(executor, sourceId, "cal-a", [
      googleEvent({ id: "dup" }),
    ])
    await expect(
      executor.execute(
        `INSERT INTO calendar_events (
           id, source_id, calendar_id, uid, ical, start_at, end_at
         ) VALUES ($1, $2, $3, $4, 'x', 0, 0)`,
        ["other-id", sourceId, "cal-a", "dup"]
      )
    ).rejects.toThrow()
  })
})

describe("CalendarApiError", () => {
  it("carries status and reason for the connection report", () => {
    const error = new CalendarApiError(410, "gone", "gone")
    expect(error.status).toBe(410)
    expect(error.reason).toBe("gone")
    expect(error.name).toBe("CalendarApiError")
  })
})
