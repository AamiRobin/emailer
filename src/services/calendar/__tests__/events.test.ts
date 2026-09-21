import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount } from "../../db/__tests__/fixtures"
import { uid } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { createInMemoryKeyStore } from "../../crypto/__tests__/in-memory-key-store"
import { encryptCredentials } from "../../crypto/credentials"
import { setDefaultKeyStore } from "../../crypto/key-management"
import { clearGmailTokenCache } from "../../email/token-manager"
import { clearMicrosoftTokenCache } from "../../email/microsoft-token-manager"
import {
  createFetchMock,
  createCalendarSource,
  googleEvent,
  eventsPage,
  calendarListEntry,
  calendarListPage,
  microsoftEvent,
  microsoftViewPage,
} from "./calendar-fixtures"
import {
  expandEventsInRange,
  listEventsInRange,
  listVisibleCalendars,
  refreshCalendars,
} from "../events"

/**
 * Calendar read-model + refresh tests (task 5.3, design D5): the range
 * query's boundary semantics ([start, end), end-exclusive), the view-time
 * RRULE expansion (daily/weekly masters starting before the range, EXDATE,
 * UNTIL, unsupported-part graceful degradation), the visible-calendar
 * listing, and refreshCalendars' per-source error isolation with the REAL
 * Google client over the fixture fetch router. Offline behavior needs no
 * service-level case: the calendar_events rows ARE the cache and the views
 * render them without any fetch — skipping the refresh when offline is a
 * UI (online-store) concern covered in the calendar-view tests.
 */

let executor: TestExecutor

/** Epoch seconds for a UTC instant (all-day seeds sit at UTC midnight). */
function utcSeconds(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0
): number {
  return Math.floor(Date.UTC(year, month - 1, day, hour, minute) / 1000)
}

interface SeedEventOverrides {
  sourceId?: string
  calendarId?: string
  uid?: string
  summary?: string
  startAt: number
  endAt: number
  allDay?: boolean
  recurrence?: string[]
  status?: string
}

async function seedEvent(overrides: SeedEventOverrides): Promise<string> {
  const id = `ce-${uid("e")}`
  await executor.execute(
    `INSERT INTO calendar_events (
       id, source_id, calendar_id, uid, ical, summary, start_at, end_at,
       all_day, recurrence, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      overrides.sourceId ?? "src-1",
      overrides.calendarId ?? "cal-1",
      overrides.uid ?? uid("uid"),
      "BEGIN:VEVENT",
      overrides.summary ?? "Seeded",
      overrides.startAt,
      overrides.endAt,
      overrides.allDay ? 1 : 0,
      overrides.recurrence ? JSON.stringify(overrides.recurrence) : null,
      overrides.status ?? "confirmed",
    ]
  )
  return id
}

beforeEach(() => {
  executor = createTestExecutor()
  setDefaultKeyStore(createInMemoryKeyStore())
})

afterEach(() => {
  clearGmailTokenCache()
  setDefaultKeyStore(null)
  executor.close()
})

describe("listEventsInRange", () => {
  beforeEach(async () => {
    await executor.execute(
      `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
       VALUES ('src-1', NULL, 'google', 'Source One', 'sealed'),
              ('src-2', NULL, 'google', 'Source Two', 'sealed')`
    )
  })

  it("returns events overlapping the range, ordered by start", async () => {
    await seedEvent({
      summary: "inside",
      startAt: utcSeconds(2026, 3, 2, 10),
      endAt: utcSeconds(2026, 3, 2, 11),
    })
    await seedEvent({
      summary: "earlier",
      startAt: utcSeconds(2026, 3, 1, 8),
      endAt: utcSeconds(2026, 3, 1, 9),
    })
    await seedEvent({
      summary: "spanning",
      startAt: utcSeconds(2026, 2, 20),
      endAt: utcSeconds(2026, 3, 3),
    })
    await seedEvent({
      summary: "after",
      startAt: utcSeconds(2026, 3, 10),
      endAt: utcSeconds(2026, 3, 11),
    })

    const events = await listEventsInRange(
      executor,
      undefined,
      utcSeconds(2026, 3, 2),
      utcSeconds(2026, 3, 8)
    )
    expect(events.map((event) => event.summary)).toEqual([
      "spanning",
      "inside",
    ])
  })

  it("applies exclusive boundaries: ends exactly at range start and starts exactly at range end are excluded", async () => {
    await seedEvent({
      summary: "ends-at-start",
      startAt: utcSeconds(2026, 3, 1, 10),
      endAt: utcSeconds(2026, 3, 2),
    })
    await seedEvent({
      summary: "starts-at-end",
      startAt: utcSeconds(2026, 3, 8),
      endAt: utcSeconds(2026, 3, 8, 9),
    })
    await seedEvent({
      summary: "kept",
      startAt: utcSeconds(2026, 3, 2),
      endAt: utcSeconds(2026, 3, 8),
    })

    const events = await listEventsInRange(
      executor,
      undefined,
      utcSeconds(2026, 3, 2),
      utcSeconds(2026, 3, 8)
    )
    expect(events.map((event) => event.summary)).toEqual(["kept"])
  })

  it("includes all-day events and maps columns to camelCase", async () => {
    await seedEvent({
      summary: "Offsite",
      startAt: utcSeconds(2026, 3, 5),
      endAt: utcSeconds(2026, 3, 7),
      allDay: true,
    })
    const [event] = await listEventsInRange(
      executor,
      undefined,
      utcSeconds(2026, 3, 5),
      utcSeconds(2026, 3, 6)
    )
    expect(event).toMatchObject({
      sourceId: "src-1",
      calendarId: "cal-1",
      summary: "Offsite",
      allDay: true,
      startAt: utcSeconds(2026, 3, 5),
      endAt: utcSeconds(2026, 3, 7),
      status: "confirmed",
    })
  })

  it("filters by source ids; an empty id list selects nothing", async () => {
    await seedEvent({
      sourceId: "src-1",
      startAt: utcSeconds(2026, 3, 2, 10),
      endAt: utcSeconds(2026, 3, 2, 11),
    })
    await seedEvent({
      sourceId: "src-2",
      summary: "other-source",
      startAt: utcSeconds(2026, 3, 2, 12),
      endAt: utcSeconds(2026, 3, 2, 13),
    })

    const both = await listEventsInRange(
      executor,
      undefined,
      utcSeconds(2026, 3, 2),
      utcSeconds(2026, 3, 3)
    )
    expect(both).toHaveLength(2)

    const onlyTwo = await listEventsInRange(
      executor,
      ["src-2"],
      utcSeconds(2026, 3, 2),
      utcSeconds(2026, 3, 3)
    )
    expect(onlyTwo.map((event) => event.summary)).toEqual(["other-source"])

    const none = await listEventsInRange(
      executor,
      [],
      utcSeconds(2026, 3, 2),
      utcSeconds(2026, 3, 3)
    )
    expect(none).toEqual([])
  })
})

describe("expandEventsInRange (view-time RRULE expansion)", () => {
  it("expands a daily COUNT rule into id-suffixed occurrences", () => {
    const master = {
      id: "master-1",
      sourceId: "src-1",
      calendarId: "cal-1",
      uid: "u1",
      summary: "Standup",
      location: null,
      description: null,
      startAt: utcSeconds(2026, 3, 2, 9),
      endAt: utcSeconds(2026, 3, 2, 9, 30),
      allDay: false,
      recurrence: JSON.stringify(["RRULE:FREQ=DAILY;COUNT=5"]),
      status: "confirmed",
    }
    // Window covers the 3rd and 4th occurrences only.
    const occurrences = expandEventsInRange(
      [master],
      utcSeconds(2026, 3, 4),
      utcSeconds(2026, 3, 6)
    )
    expect(occurrences.map((event) => event.startAt)).toEqual([
      utcSeconds(2026, 3, 4, 9),
      utcSeconds(2026, 3, 5, 9),
    ])
    expect(occurrences[0]?.id).toBe("master-1#oc-2")
    expect(occurrences[0]?.recurrence).toBeNull()
    expect(occurrences[0]?.summary).toBe("Standup")
  })

  it("finds a weekly master that started before the range and honors UNTIL", () => {
    const master = {
      id: "master-2",
      sourceId: "src-1",
      calendarId: "cal-1",
      uid: "u2",
      summary: "Weekly review",
      location: null,
      description: null,
      // Tuesdays, started in January — the overlap predicate alone would
      // miss it in March; the recurrence IS NOT NULL clause admits it.
      startAt: utcSeconds(2026, 1, 6, 14),
      endAt: utcSeconds(2026, 1, 6, 15),
      allDay: false,
      recurrence: JSON.stringify(["RRULE:FREQ=WEEKLY;UNTIL=20260310T235959Z"]),
      status: "confirmed",
    }
    const occurrences = expandEventsInRange(
      [master],
      utcSeconds(2026, 3, 1),
      utcSeconds(2026, 3, 15)
    )
    // Tuesdays in the window: Mar 3 and Mar 10 (UNTIL inclusive).
    expect(occurrences.map((event) => event.startAt)).toEqual([
      utcSeconds(2026, 3, 3, 14),
      utcSeconds(2026, 3, 10, 14),
    ])
  })

  it("drops EXDATE occurrences and supports biweekly INTERVAL", () => {
    const master = {
      id: "master-3",
      sourceId: "src-1",
      calendarId: "cal-1",
      uid: "u3",
      summary: "Biweekly",
      location: null,
      description: null,
      startAt: utcSeconds(2026, 3, 2, 10),
      endAt: utcSeconds(2026, 3, 2, 11),
      allDay: false,
      recurrence: JSON.stringify([
        "RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=4",
        "EXDATE:20260316T100000Z",
      ]),
      status: "confirmed",
    }
    const occurrences = expandEventsInRange(
      [master],
      utcSeconds(2026, 3, 1),
      utcSeconds(2026, 4, 1)
    )
    // Mar 2, Mar 16 (EXDATE-dropped), Mar 30 — COUNT=4 would add Apr 13,
    // outside the window anyway.
    expect(occurrences.map((event) => event.startAt)).toEqual([
      utcSeconds(2026, 3, 2, 10),
      utcSeconds(2026, 3, 30, 10),
    ])
  })

  it("expands all-day recurrences on UTC day boundaries", () => {
    const master = {
      id: "master-4",
      sourceId: "src-1",
      calendarId: "cal-1",
      uid: "u4",
      summary: "Monthly report",
      location: null,
      description: null,
      startAt: utcSeconds(2026, 1, 1),
      endAt: utcSeconds(2026, 1, 2),
      allDay: true,
      recurrence: JSON.stringify(["RRULE:FREQ=MONTHLY;COUNT=3"]),
      status: "confirmed",
    }
    const occurrences = expandEventsInRange(
      [master],
      utcSeconds(2026, 2, 1),
      utcSeconds(2026, 4, 1)
    )
    expect(occurrences.map((event) => event.startAt)).toEqual([
      utcSeconds(2026, 2, 1),
      utcSeconds(2026, 3, 1),
    ])
    expect(occurrences[0]?.allDay).toBe(true)
  })

  it("degrades gracefully: unsupported parts (BYDAY) render the master when it overlaps, nothing otherwise", () => {
    const base = {
      sourceId: "src-1",
      calendarId: "cal-1",
      uid: "u5",
      location: null,
      description: null,
      allDay: false,
      status: "confirmed",
    }
    const overlapping = {
      ...base,
      id: "master-5",
      summary: "Complex",
      startAt: utcSeconds(2026, 3, 2, 9),
      endAt: utcSeconds(2026, 3, 2, 10),
      recurrence: JSON.stringify(["RRULE:FREQ=WEEKLY;BYDAY=MO,WE"]),
    }
    expect(
      expandEventsInRange(
        [overlapping],
        utcSeconds(2026, 3, 1),
        utcSeconds(2026, 3, 8)
      ).map((event) => event.id)
    ).toEqual(["master-5"])
    expect(
      expandEventsInRange(
        [overlapping],
        utcSeconds(2026, 4, 1),
        utcSeconds(2026, 4, 8)
      )
    ).toEqual([])
  })
})

describe("listVisibleCalendars", () => {
  it("lists the distinct (source, calendar) pairs with the source display name", async () => {
    await executor.execute(
      `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
       VALUES ('src-1', NULL, 'google', 'me@gmail.com', 'sealed')`
    )
    await seedEvent({
      sourceId: "src-1",
      calendarId: "cal-work",
      startAt: utcSeconds(2026, 3, 2, 10),
      endAt: utcSeconds(2026, 3, 2, 11),
    })
    await seedEvent({
      sourceId: "src-1",
      calendarId: "cal-work",
      summary: "duplicate pair",
      startAt: utcSeconds(2026, 3, 3, 10),
      endAt: utcSeconds(2026, 3, 3, 11),
    })
    await seedEvent({
      sourceId: "src-1",
      calendarId: "cal-family",
      startAt: utcSeconds(2026, 3, 4, 10),
      endAt: utcSeconds(2026, 3, 4, 11),
    })
    // A source without events contributes nothing (visibility = has cache).
    await createCalendarSource(executor, null, { id: "src-2" })

    const calendars = await listVisibleCalendars(executor)
    expect(calendars).toEqual([
      {
        sourceId: "src-1",
        sourceName: "me@gmail.com",
        provider: "google",
        calendarId: "cal-family",
      },
      {
        sourceId: "src-1",
        sourceName: "me@gmail.com",
        provider: "google",
        calendarId: "cal-work",
      },
    ])
  })
})

describe("refreshCalendars", () => {
  it("delta-syncs each discovered calendar of a google source and counts it refreshed", async () => {
    const accountId = await createAccount(executor)
    const configJson = await encryptCredentials({
      refreshToken: "1//0rt",
      clientId: "client-id-1",
    })
    await executor.execute(
      `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
       VALUES ('src-g', $1, 'google', 'me@gmail.com', $2)`,
      [accountId, configJson]
    )

    const mock = createFetchMock()
    mock.on("POST", "/token", () => ({
      json: { access_token: "ya29.r", expires_in: 3600 },
    }))
    mock.on("GET", "/users/me/calendarList", () => ({
      json: calendarListPage([
        calendarListEntry({ id: "cal-main" }),
        calendarListEntry({ id: "cal-side" }),
      ]),
    }))
    mock.on("GET", "/calendars/cal-main/events", () => ({
      json: eventsPage([
        googleEvent({
          id: "ev-1",
          summary: "Synced from main",
          start: { dateTime: "2026-03-02T10:00:00Z" },
          end: { dateTime: "2026-03-02T11:00:00Z" },
        }),
      ]),
    }))
    mock.on("GET", "/calendars/cal-side/events", () => ({
      json: eventsPage([]),
    }))

    const result = await refreshCalendars(executor, { fetchImpl: mock.fetch })
    expect(result).toEqual({ refreshed: 1, errors: [] })
    const events = await executor.select<{ summary: string | null }>(
      "SELECT summary FROM calendar_events WHERE source_id = 'src-g'"
    )
    expect(events.map((event) => event.summary)).toEqual([
      "Synced from main",
    ])
  })

  it("isolates a failing source: records its error and still refreshes the healthy one", async () => {
    const accountId = await createAccount(executor)
    // Dead grant: the token endpoint rejects the refresh.
    const dead = await encryptCredentials({
      refreshToken: "1//0dead",
      clientId: "client-id-1",
    })
    await executor.execute(
      `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
       VALUES ('src-dead', $1, 'google', 'me@gmail.com', $2)`,
      [accountId, dead]
    )
    // Healthy-shaped source whose envelope has no usable refresh token →
    // typed failure with a distinct message; isolation is what matters.
    const empty = await encryptCredentials({ clientId: "client-id-1" })
    await executor.execute(
      `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
       VALUES ('src-empty', $1, 'google', 'me@gmail.com', $2)`,
      [accountId, empty]
    )

    const mock = createFetchMock()
    mock.on("POST", "/token", () => ({
      status: 400,
      json: { error: "invalid_grant" },
    }))

    const result = await refreshCalendars(executor, { fetchImpl: mock.fetch })
    expect(result.refreshed).toBe(0)
    expect(result.errors.map((error) => error.sourceId).sort()).toEqual([
      "src-dead",
      "src-empty",
    ])
    for (const error of result.errors) {
      expect(error.message).not.toContain("1//0")
      expect(typeof error.message).toBe("string")
    }
  })

  it("falls back to the known sync-state calendars when discovery fails", async () => {
    const accountId = await createAccount(executor)
    const configJson = await encryptCredentials({
      refreshToken: "1//0rt",
      clientId: "client-id-1",
    })
    await executor.execute(
      `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
       VALUES ('src-known', $1, 'google', 'me@gmail.com', $2)`,
      [accountId, configJson]
    )
    await executor.execute(
      `UPDATE calendar_sources
          SET sync_state_json = '{"cal-kept":{"nextSyncToken":"tok-1"}}'
        WHERE id = 'src-known'`
    )

    const mock = createFetchMock()
    mock.on("POST", "/token", () => ({
      json: { access_token: "ya29.k", expires_in: 3600 },
    }))
    mock.on("GET", "/users/me/calendarList", () => ({
      status: 500,
      json: { error: {} },
    }))
    mock.on("GET", "/calendars/cal-kept/events", () => ({
      json: eventsPage([
        googleEvent({
          id: "ev-kept",
          summary: "Delta on known calendar",
          start: { dateTime: "2026-03-03T09:00:00Z" },
          end: { dateTime: "2026-03-03T10:00:00Z" },
        }),
      ]),
    }))

    const result = await refreshCalendars(executor, { fetchImpl: mock.fetch })
    expect(result).toEqual({ refreshed: 1, errors: [] })
    const events = await executor.select<{ summary: string | null }>(
      "SELECT summary FROM calendar_events WHERE source_id = 'src-known'"
    )
    expect(events.map((event) => event.summary)).toEqual([
      "Delta on known calendar",
    ])
  })

  it("syncs a microsoft source through the Graph calendarView feed into the SAME cache (view parity)", async () => {
    clearMicrosoftTokenCache()
    const accountId = await createAccount(executor)
    const configJson = await encryptCredentials({
      refreshToken: "0.rt",
      clientId: "client-1",
    })
    await createCalendarSource(executor, accountId, {
      id: "src-ms",
      provider: "microsoft",
      name: "me@outlook.com",
      configJson,
    })

    const mock = createFetchMock()
    mock.on("POST", "/token", () => ({
      json: { access_token: "0.at", expires_in: 3600 },
    }))
    mock.on("GET", "/me/calendars?$select", () => ({
      json: {
        value: [{ id: "cal-outlook" }, { id: "cal-shared" }],
      },
    }))
    mock.on(
      "GET",
      "/me/calendars/cal-outlook/calendarView/delta",
      () => ({
        json: microsoftViewPage(
          [
            microsoftEvent({
              id: "gev-1",
              subject: "From Outlook",
              start: { dateTime: "2026-03-02T10:00:00", timeZone: "UTC" },
              end: { dateTime: "2026-03-02T11:00:00", timeZone: "UTC" },
            }),
          ],
          {
            deltaLink:
              "https://graph.microsoft.com/v1.0/me/calendars/cal-outlook/calendarView/delta?$deltatoken=t1",
          }
        ),
      })
    )
    mock.on("GET", "/me/calendars/cal-shared/calendarView/delta", () => ({
      json: microsoftViewPage([], {
        deltaLink:
          "https://graph.microsoft.com/v1.0/me/calendars/cal-shared/calendarView/delta?$deltatoken=t2",
      }),
    }))

    const result = await refreshCalendars(executor, { fetchImpl: mock.fetch })
    expect(result).toEqual({ refreshed: 1, errors: [] })

    // The Graph events land in the SAME calendar_events cache: the shared
    // range query and the visible-calendar listing see them exactly like
    // Google/CalDAV rows — no view changes for the new source type.
    const events = await listEventsInRange(
      executor,
      undefined,
      utcSeconds(2026, 3, 2, 0, 0),
      utcSeconds(2026, 3, 3, 0, 0)
    )
    expect(events.map((event) => event.summary)).toEqual(["From Outlook"])
    expect(events[0]?.sourceId).toBe("src-ms")
    const visible = await listVisibleCalendars(executor)
    expect(visible).toEqual([
      {
        sourceId: "src-ms",
        sourceName: "me@outlook.com",
        provider: "microsoft",
        calendarId: "cal-outlook",
      },
    ])
    clearMicrosoftTokenCache()
  })

  it("records a caldav source failure without throwing (best-effort dynamic call into the task 5.2 connector)", async () => {
    // The stored "sealed" blob is not a real CalDAV envelope, so the
    // connector's unseal step fails — the refresh records the per-source
    // error and returns instead of throwing.
    await executor.execute(
      `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
       VALUES ('src-caldav', NULL, 'caldav', 'Fastmail', 'sealed')`
    )
    const result = await refreshCalendars(executor, { fetchImpl: fetch })
    expect(result.refreshed).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.sourceId).toBe("src-caldav")
    expect(typeof result.errors[0]?.message).toBe("string")
    expect(result.errors[0]?.message.length).toBeGreaterThan(0)
  })
})
