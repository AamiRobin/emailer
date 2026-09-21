import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"

import {
  createCalendarSource,
  createFetchMock,
  googleEvent,
  microsoftEvent,
} from "./calendar-fixtures"
import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { setDefaultKeyStore } from "../../crypto/key-management"
import { createInMemoryKeyStore } from "../../crypto/__tests__/in-memory-key-store"
import { encryptCredentials } from "../../crypto/credentials"
import { addCalendarSource } from "../sources"
import type { CalendarSource, CalendarSourceRow } from "../sources"
import { clearMicrosoftTokenCache } from "../../email/microsoft-token-manager"
import { useOnlineStore } from "../../../stores/online-store"
import {
  buildEventIcal,
  buildGoogleEventPayload,
  createEvent,
  defaultWritableCalendarId,
  deleteEvent,
  listWritableEventCalendars,
  respondToGoogleInvitation,
  updateEvent,
} from "../event-writes"
import { upsertEventsFromApi } from "../google-calendar"
import { upsertMicrosoftEventsFromApi } from "../microsoft-calendar"

/**
 * Event write service tests (task 5.4, design D5). Google rides the
 * fixture fetch router (the same seam as the sync tests, plus the token
 * source seeded with a still-valid access token so no refresh call
 * happens); CalDAV rides a mocked `invoke` (the Rust command side has its
 * own loopback mock-server cargo tests). Pinned here:
 *
 * - the ONLINE-WRITE contract: offline → typed "offline" with zero
 *   network calls and zero local mutations, for every verb;
 * - local-row-after-success ordering: a failed provider write leaves NO
 *   calendar_events row;
 * - payload building: all-day exclusive ends, guests, reminder override,
 *   PATCH-without-attendees (an untouched guest list must not be blanked);
 * - the CalDAV .ics blob round-trip: create/update PUT a full VCALENDAR,
 *   the update preserves the stored ORGANIZER/ATTENDEE lines, delete
 *   tolerates 404;
 * - the google RSVP path: attendee matching by the linked account email.
 */

vi.mock("@tauri-apps/api/core")

const invokeMock = vi.mocked(invoke)

const CAL_HOME = "https://dav.example.com/dav/user/calendars/home/"
const SERVER_URL = "https://dav.example.com/"
const USERNAME = "secret-user"
const APP_PASSWORD = "app-pass-99"

/** Epoch seconds used across the google fixtures. */
const START = Date.parse("2026-03-02T10:00:00Z") / 1000
const END = Date.parse("2026-03-02T11:00:00Z") / 1000

function routeInvoke(
  handler: (command: string, args: Record<string, unknown>) => unknown
): void {
  invokeMock.mockImplementation(((command: string, args?: unknown) => {
    return Promise.resolve(
      handler(command, (args ?? {}) as Record<string, unknown>)
    )
  }) as typeof invoke)
}

function rejectInvoke(
  handler: (command: string, args: Record<string, unknown>) => unknown
): void {
  invokeMock.mockImplementation(((command: string, args?: unknown) => {
    return Promise.reject(
      handler(command, (args ?? {}) as Record<string, unknown>)
    )
  }) as typeof invoke)
}

async function rowsOf(
  executor: TestExecutor,
  sourceId: string
): Promise<{
  uid: string
  summary: string | null
  start_at: number
  all_day: number
  ical: string
}[]> {
  return executor.select(
    `SELECT uid, summary, start_at, all_day, ical FROM calendar_events
      WHERE source_id = $1 ORDER BY uid ASC`,
    [sourceId]
  )
}

/** A google source whose sealed envelope carries a still-valid access
 * token (no refresh round-trip under test) + an oauth client id. */
async function seedGoogleSource(
  executor: TestExecutor,
  overrides: { id?: string; accountId?: string | null } = {}
): Promise<CalendarSource> {
  const configJson = await encryptCredentials({
    refreshToken: "rt-1",
    accessToken: "at-1",
    accessTokenExpiresAt: Date.now() + 3_600_000,
    clientId: "client-1",
  })
  const id = overrides.id ?? "src-google"
  await addCalendarSource(executor, {
    id,
    accountId: overrides.accountId ?? null,
    provider: "google",
    name: "me@gmail.com",
    configJson,
  })
  return loadSource(executor, id)
}

/** calendar_sources row → camelCase source view (fresh sync state). */
async function loadSource(
  executor: TestExecutor,
  id: string
): Promise<CalendarSource> {
  const rows = await executor.select<CalendarSourceRow>(
    "SELECT id, account_id, provider, name, config_json, sync_state_json, created_at FROM calendar_sources WHERE id = $1",
    [id]
  )
  const row = rows[0]
  return {
    id: row.id,
    accountId: row.account_id,
    provider: row.provider,
    name: row.name,
    configJson: row.config_json,
    syncState: {},
    createdAt: row.created_at,
  }
}

async function seedCaldavSource(
  executor: TestExecutor
): Promise<CalendarSource> {
  const configJson = await encryptCredentials({
    serverUrl: SERVER_URL,
    username: USERNAME,
    appPassword: APP_PASSWORD,
    calendarPaths: [CAL_HOME],
  })
  await addCalendarSource(executor, {
    id: "src-caldav",
    accountId: null,
    provider: "caldav",
    name: USERNAME,
    configJson,
  })
  return loadSource(executor, "src-caldav")
}

beforeEach(() => {
  setDefaultKeyStore(createInMemoryKeyStore())
  useOnlineStore.setState({ online: true })
  invokeMock.mockReset()
})

afterEach(() => {
  setDefaultKeyStore(null)
  useOnlineStore.setState({ online: true })
})

describe("buildGoogleEventPayload", () => {
  it("maps all-day inputs to DATE values with an exclusive end", () => {
    const startAt = Date.parse("2026-03-05T00:00:00Z") / 1000
    const payload = buildGoogleEventPayload({
      title: "Offsite",
      startAt,
      endAt: startAt + 2 * 86_400,
      allDay: true,
    })
    expect(payload.start).toEqual({ date: "2026-03-05" })
    expect(payload.end).toEqual({ date: "2026-03-07" })
  })

  it("maps timed inputs to absolute UTC instants and clamps a zero length", () => {
    const payload = buildGoogleEventPayload({
      startAt: START,
      endAt: START,
      allDay: false,
    })
    expect(payload.start).toEqual({ dateTime: "2026-03-02T10:00:00Z" })
    expect(payload.end).toEqual({ dateTime: "2026-03-02T10:01:00Z" })
  })

  it("dedupes guests and emits a single popup reminder override", () => {
    const payload = buildGoogleEventPayload({
      guests: [" a@x.com ", "b@x.com", "a@x.com", ""],
      reminderMinutes: 15,
    })
    expect(payload.attendees).toEqual([{ email: "a@x.com" }, { email: "b@x.com" }])
    expect(payload.reminders).toEqual({
      useDefault: false,
      overrides: [{ method: "popup", minutes: 15 }],
    })
    // null clears back to the calendar default (PATCH clear).
    expect(buildGoogleEventPayload({ reminderMinutes: null }).reminders).toEqual(
      { useDefault: true }
    )
  })
})

describe("google event writes", () => {
  let executor: TestExecutor
  let sourceId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    // A REAL sealed envelope (refresh + still-valid access token): the
    // write path unseals it for the token source, unlike the sync tests'
    // opaque ciphertext stand-in.
    const source = await seedGoogleSource(executor, { id: "src-google" })
    sourceId = source.id
  })

  afterEach(() => {
    executor.close()
  })

  it("creates the event on Google and caches the row only after success", async () => {
    const mock = createFetchMock()
    mock.on("POST", "/calendars/cal-main/events", () => ({
      json: googleEvent({
        id: "ev-new",
        summary: "Created",
        start: { dateTime: "2026-03-02T10:00:00Z" },
        end: { dateTime: "2026-03-02T11:00:00Z" },
      }),
    }))

    const result = await createEvent(
      executor,
      {
        sourceId,
        calendarId: "cal-main",
        title: "Created",
        startAt: START,
        endAt: END,
        allDay: false,
        location: "Room 1",
        guests: ["a@x.com", "b@x.com"],
        reminderMinutes: 10,
      },
      { fetchImpl: mock.fetch }
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.event).toMatchObject({
        uid: "ev-new",
        summary: "Created",
        startAt: START,
        endAt: END,
        allDay: false,
      })
    }

    // The request carried the form fields: guests + reminder override.
    const call = mock.calls[0]
    expect(call.method).toBe("POST")
    expect(call.url).toContain("/calendars/cal-main/events")
    const body = JSON.parse(call.body ?? "{}") as {
      summary: string
      location: string
      start: { dateTime: string }
      attendees: { email: string }[]
      reminders: { useDefault: boolean; overrides: { minutes: number }[] }
    }
    expect(body.summary).toBe("Created")
    expect(body.location).toBe("Room 1")
    expect(body.start).toEqual({ dateTime: "2026-03-02T10:00:00Z" })
    expect(body.attendees.map((attendee) => attendee.email)).toEqual([
      "a@x.com",
      "b@x.com",
    ])
    expect(body.reminders).toEqual({
      useDefault: false,
      overrides: [{ method: "popup", minutes: 10 }],
    })

    // Local row cached AFTER the server confirmed.
    const rows = await rowsOf(executor, sourceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ uid: "ev-new", summary: "Created" })
  })

  it("refuses offline creates without any network attempt or local row", async () => {
    const mock = createFetchMock()
    mock.on("POST", "/calendars/cal-main/events", () => ({
      json: googleEvent({ id: "ev-never" }),
    }))
    useOnlineStore.setState({ online: false })

    const result = await createEvent(
      executor,
      {
        sourceId,
        calendarId: "cal-main",
        title: "Offline",
        startAt: START,
        endAt: END,
        allDay: false,
      },
      { fetchImpl: mock.fetch }
    )

    expect(result).toMatchObject({ ok: false, reason: "offline" })
    expect(mock.calls).toHaveLength(0)
    expect(await rowsOf(executor, sourceId)).toEqual([])
  })

  it("answers a failed create with a typed error and NO local row", async () => {
    const mock = createFetchMock()
    mock.on("POST", "/calendars/cal-main/events", () => ({
      status: 500,
      json: { error: { message: "Backend error" } },
    }))

    const result = await createEvent(
      executor,
      {
        sourceId,
        calendarId: "cal-main",
        title: "Never stored",
        startAt: START,
        endAt: END,
        allDay: false,
      },
      { fetchImpl: mock.fetch }
    )

    expect(result).toMatchObject({ ok: false, reason: "failed" })
    if (!result.ok) expect(result.message).toContain("500")
    expect(await rowsOf(executor, sourceId)).toEqual([])
  })

  it("updates via PATCH, omitting untouched fields (guests survive)", async () => {
    await upsertEventsFromApi(executor, sourceId, "cal-main", [
      googleEvent({ id: "ev-edit", summary: "Old title" }),
    ])
    const mock = createFetchMock()
    mock.on("PATCH", "/calendars/cal-main/events/ev-edit", () => ({
      json: googleEvent({ id: "ev-edit", summary: "New title" }),
    }))

    const result = await updateEvent(
      executor,
      {
        id: `ce-${sourceId}:cal-main:ev-edit`,
        sourceId,
        calendarId: "cal-main",
        uid: "ev-edit",
        summary: "Old title",
        location: null,
        description: null,
        startAt: START,
        endAt: END,
        allDay: false,
        recurrence: null,
        status: "confirmed",
      },
      { title: "New title", startAt: START, endAt: END, allDay: false },
      { fetchImpl: mock.fetch }
    )

    expect(result.ok).toBe(true)
    const patch = JSON.parse(mock.calls[0]?.body ?? "{}") as Record<string, unknown>
    expect(patch.summary).toBe("New title")
    // The patch carries only edited fields — an untouched guest list is
    // NOT blanked (the cached row does not know the provider's attendees).
    expect(patch.attendees).toBeUndefined()

    const rows = await rowsOf(executor, sourceId)
    expect(rows[0]).toMatchObject({ uid: "ev-edit", summary: "New title" })
  })

  it("deletes on the server first, then the local row", async () => {
    await upsertEventsFromApi(executor, sourceId, "cal-main", [
      googleEvent({ id: "ev-gone", summary: "Delete me" }),
    ])
    const mock = createFetchMock()
    mock.on("DELETE", "/calendars/cal-main/events/ev-gone", () => ({}))

    const result = await deleteEvent(
      executor,
      {
        id: `ce-${sourceId}:cal-main:ev-gone`,
        sourceId,
        calendarId: "cal-main",
        uid: "ev-gone",
        summary: "Delete me",
        location: null,
        description: null,
        startAt: START,
        endAt: END,
        allDay: false,
        recurrence: null,
        status: "confirmed",
      },
      { fetchImpl: mock.fetch }
    )

    expect(result).toEqual({ ok: true })
    expect(mock.calls[0]?.method).toBe("DELETE")
    expect(await rowsOf(executor, sourceId)).toEqual([])
  })

  it("answers the RSVP by patching the linked account's responseStatus", async () => {
    const accountId = await createAccount(executor)
    const source = await seedGoogleSource(executor, {
      id: "src-rsvp",
      accountId,
    })
    await upsertEventsFromApi(executor, source.id, "cal-main", [
      googleEvent({ id: "evt-rsvp", summary: "Invitation" }),
    ])
    const account = await executor.select<{ email: string }>(
      "SELECT email FROM accounts WHERE id = $1",
      [accountId]
    )
    const myEmail = account[0].email

    const mock = createFetchMock()
    mock.on("GET", "/calendars/cal-main/events/evt-rsvp", () => ({
      json: googleEvent({
        id: "evt-rsvp",
        attendees: [
          { email: "other@x.com", responseStatus: "accepted" },
          { email: myEmail, responseStatus: "needsAction" },
        ],
      }),
    }))
    mock.on("PATCH", "/calendars/cal-main/events/evt-rsvp", () => ({
      json: googleEvent({ id: "evt-rsvp" }),
    }))

    const result = await respondToGoogleInvitation(
      executor,
      source,
      "evt-rsvp@google.com",
      "maybe",
      { fetchImpl: mock.fetch }
    )

    expect(result.ok).toBe(true)
    const patch = JSON.parse(mock.calls[1]?.body ?? "{}") as {
      attendees: { email: string; responseStatus: string }[]
    }
    expect(patch.attendees).toHaveLength(2)
    expect(patch.attendees.find((a) => a.email === myEmail)?.responseStatus).toBe(
      "tentative"
    )
    expect(
      patch.attendees.find((a) => a.email === "other@x.com")?.responseStatus
    ).toBe("accepted")
  })

  it("refuses an RSVP for an event that is not synced (typed no-event)", async () => {
    const source = await seedGoogleSource(executor, { id: "src-rsvp2" })
    const mock = createFetchMock()
    const result = await respondToGoogleInvitation(
      executor,
      source,
      "unknown@google.com",
      "yes",
      { fetchImpl: mock.fetch }
    )
    expect(result).toMatchObject({ ok: false, reason: "no-event" })
    expect(mock.calls).toHaveLength(0)
  })
})

describe("microsoft event writes", () => {
  let executor: TestExecutor
  let sourceId: string

  const MS_CAL = "cal-outlook"
  const ROW_ID = (uid: string) => `ce-src-ms:${MS_CAL}:${uid}`

  beforeEach(async () => {
    executor = createTestExecutor()
    setDefaultKeyStore(createInMemoryKeyStore())
    // A REAL sealed envelope with a still-valid access token: no refresh
    // round-trip under test.
    const configJson = await encryptCredentials({
      refreshToken: "0.rt",
      accessToken: "0.at",
      accessTokenExpiresAt: Date.now() + 3_600_000,
      clientId: "client-1",
    })
    await createCalendarSource(executor, null, {
      id: "src-ms",
      provider: "microsoft",
      name: "me@outlook.com",
      configJson,
    })
    sourceId = "src-ms"
  })

  afterEach(() => {
    clearMicrosoftTokenCache()
    setDefaultKeyStore(null)
    executor.close()
  })

  it("creates through Graph and caches the row only after success", async () => {
    const mock = createFetchMock()
    mock.on("POST", `/me/calendars/${MS_CAL}/events`, () => ({
      json: microsoftEvent({
        id: "gev-new",
        subject: "Created",
        start: { dateTime: "2026-03-02T10:00:00", timeZone: "UTC" },
        end: { dateTime: "2026-03-02T11:00:00", timeZone: "UTC" },
      }),
    }))

    const result = await createEvent(
      executor,
      {
        sourceId,
        calendarId: MS_CAL,
        title: "Created",
        startAt: START,
        endAt: END,
        allDay: false,
        location: "Room 1",
        guests: ["a@x.com"],
        reminderMinutes: 10,
      },
      { fetchImpl: mock.fetch }
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.event).toMatchObject({
        uid: "gev-new",
        summary: "Created",
        startAt: START,
        endAt: END,
        allDay: false,
      })
    }

    const call = mock.calls[0]
    expect(call.url).toContain(`/me/calendars/${MS_CAL}/events`)
    const body = JSON.parse(call.body ?? "{}") as Record<string, unknown>
    expect(body.subject).toBe("Created")
    expect(body.location).toEqual({ displayName: "Room 1" })
    expect(body.start).toEqual({
      dateTime: "2026-03-02T10:00:00",
      timeZone: "UTC",
    })
    expect(body.attendees).toEqual([
      { emailAddress: { address: "a@x.com" }, type: "required" },
    ])
    expect(body.isReminderOn).toBe(true)
    expect(body.reminderMinutesBeforeStart).toBe(10)

    // Local row cached AFTER the server confirmed.
    const rows = await rowsOf(executor, sourceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ uid: "gev-new", summary: "Created" })
  })

  it("answers a failed create with a typed error and NO local row", async () => {
    const mock = createFetchMock()
    mock.on("POST", `/me/calendars/${MS_CAL}/events`, () => ({
      status: 500,
      json: { error: { code: "InternalServerError", message: "boom" } },
    }))

    const result = await createEvent(
      executor,
      {
        sourceId,
        calendarId: MS_CAL,
        title: "Never stored",
        startAt: START,
        endAt: END,
        allDay: false,
      },
      { fetchImpl: mock.fetch }
    )
    expect(result).toMatchObject({ ok: false, reason: "failed" })
    if (!result.ok) expect(result.message).toContain("500")
    expect(await rowsOf(executor, sourceId)).toEqual([])
  })

  it("edits through Graph PATCH and re-caches the server truth", async () => {
    await upsertMicrosoftEventsFromApi(executor, sourceId, MS_CAL, [
      microsoftEvent({ id: "gev-edit", subject: "Old title" }),
    ])
    const mock = createFetchMock()
    mock.on("PATCH", `/me/calendars/${MS_CAL}/events/gev-edit`, () => ({
      json: microsoftEvent({ id: "gev-edit", subject: "New title" }),
    }))

    const result = await updateEvent(
      executor,
      {
        id: ROW_ID("gev-edit"),
        sourceId,
        calendarId: MS_CAL,
        uid: "gev-edit",
        summary: "Old title",
        location: null,
        description: null,
        startAt: START,
        endAt: END,
        allDay: false,
        recurrence: null,
        status: "confirmed",
      },
      { title: "New title", startAt: START, endAt: END, allDay: false },
      { fetchImpl: mock.fetch }
    )

    expect(result.ok).toBe(true)
    // The patch carries only edited fields — an untouched guest list is
    // NOT blanked (PATCH semantics, same contract as Google).
    const patch = JSON.parse(mock.calls[0]?.body ?? "{}") as Record<
      string,
      unknown
    >
    expect(patch.subject).toBe("New title")
    expect(patch.attendees).toBeUndefined()
    const rows = await rowsOf(executor, sourceId)
    expect(rows[0]).toMatchObject({ uid: "gev-edit", summary: "New title" })
  })

  it("deletes through Graph and removes the cached row", async () => {
    await upsertMicrosoftEventsFromApi(executor, sourceId, MS_CAL, [
      microsoftEvent({ id: "gev-del", subject: "Bye" }),
    ])
    const mock = createFetchMock()
    mock.on("DELETE", `/me/calendars/${MS_CAL}/events/gev-del`, () => ({
      // Empty-bodied success (Graph answers 204; the fixture router cannot
      // build a 204 Response with a body).
      status: 200,
      text: "",
    }))

    const result = await deleteEvent(
      executor,
      {
        id: ROW_ID("gev-del"),
        sourceId,
        calendarId: MS_CAL,
        uid: "gev-del",
        summary: "Bye",
        location: null,
        description: null,
        startAt: START,
        endAt: END,
        allDay: false,
        recurrence: null,
        status: "confirmed",
      },
      { fetchImpl: mock.fetch }
    )
    expect(result).toEqual({ ok: true })
    expect(await rowsOf(executor, sourceId)).toEqual([])
  })

  it("offers writable destinations from the synced Graph calendars only", async () => {
    // Not synced yet → no destination (Graph ids have no "primary").
    expect(await listWritableEventCalendars(executor)).toEqual([])

    await executor.execute(
      `UPDATE calendar_sources
          SET sync_state_json = '{"cal-outlook":{"nextSyncToken":"https://graph.microsoft.com/x"}}'
        WHERE id = 'src-ms'`
    )
    expect(await listWritableEventCalendars(executor)).toEqual([
      {
        sourceId: "src-ms",
        sourceName: "me@outlook.com",
        provider: "microsoft",
        calendarId: MS_CAL,
      },
    ])
    expect(
      await defaultWritableCalendarId({
        id: "src-ms",
        accountId: null,
        provider: "microsoft",
        name: "me@outlook.com",
        configJson: "sealed",
        syncState: { [MS_CAL]: {} },
        createdAt: 0,
      })
    ).toBe(MS_CAL)
  })
})

describe("caldav event writes", () => {
  let executor: TestExecutor
  let sourceId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    const source = await seedCaldavSource(executor)
    sourceId = source.id
  })

  afterEach(() => {
    executor.close()
  })

  function putArgs(args: Record<string, unknown>): {
    resourcePath: string
    ical: string
  } {
    expect(args.serverUrl).toBe(SERVER_URL)
    expect(args.username).toBe(USERNAME)
    expect(args.appPassword).toBe(APP_PASSWORD)
    return {
      resourcePath: args.resourcePath as string,
      ical: args.ical as string,
    }
  }

  it("creates via PUT of the built VCALENDAR and caches the row", async () => {
    routeInvoke((command, args) => {
      expect(command).toBe("caldav_put_event")
      const { ical } = putArgs(args)
      expect((args.resourcePath as string).startsWith(CAL_HOME)).toBe(true)
      expect((args.resourcePath as string).endsWith(".ics")).toBe(true)
      expect(ical).toContain("BEGIN:VCALENDAR")
      expect(ical).toContain("SUMMARY:Offline picnic")
      expect(ical).toContain("DTSTART;VALUE=DATE:20260402")
      expect(ical).toContain("DTEND;VALUE=DATE:20260403")
      expect(ical).toContain("ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:a@x.com")
      return null
    })

    const result = await createEvent(executor, {
      sourceId,
      calendarId: CAL_HOME,
      title: "Offline picnic",
      startAt: Date.parse("2026-04-02T00:00:00Z") / 1000,
      endAt: Date.parse("2026-04-03T00:00:00Z") / 1000,
      allDay: true,
      guests: ["a@x.com"],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.event).toMatchObject({
        sourceId,
        calendarId: CAL_HOME,
        summary: "Offline picnic",
        allDay: true,
        startAt: Date.parse("2026-04-02T00:00:00Z") / 1000,
      })
    }
    const rows = await rowsOf(executor, sourceId)
    expect(rows).toHaveLength(1)
    expect(rows[0].ical).toContain("SUMMARY:Offline picnic")
  })

  it("answers offline without invoking the command or writing a row", async () => {
    useOnlineStore.setState({ online: false })
    const result = await createEvent(executor, {
      sourceId,
      calendarId: CAL_HOME,
      title: "Offline",
      startAt: START,
      endAt: END,
      allDay: false,
    })
    expect(result).toMatchObject({ ok: false, reason: "offline" })
    expect(invokeMock).not.toHaveBeenCalled()
    expect(await rowsOf(executor, sourceId)).toEqual([])
  })

  it("answers a failed PUT with a typed error and NO local row", async () => {
    rejectInvoke(() => ({
      kind: "status",
      message: "the CalDAV server returned HTTP 403",
      status: 403,
    }))
    const result = await createEvent(executor, {
      sourceId,
      calendarId: CAL_HOME,
      title: "Denied",
      startAt: START,
      endAt: END,
      allDay: false,
    })
    expect(result).toMatchObject({ ok: false, reason: "failed" })
    expect(await rowsOf(executor, sourceId)).toEqual([])
  })

  it("updates by rebuilding the resource, preserving stored ORGANIZER/ATTENDEE", async () => {
    const storedIcal = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:evt-1",
      "DTSTART:20260301T100000Z",
      "DTEND:20260301T110000Z",
      "SUMMARY:Old title",
      "ORGANIZER:mailto:alice@example.com",
      "ATTENDEE;PARTSTAT=ACCEPTED:mailto:bob@example.com",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n")
    await executor.execute(
      `INSERT INTO calendar_events (
         id, source_id, calendar_id, uid, ical, summary, start_at, end_at
       ) VALUES ($1, $2, $3, 'evt-1', $4, 'Old title', $5, $6)`,
      [
        `ce-${sourceId}:${CAL_HOME}:evt-1`,
        sourceId,
        CAL_HOME,
        storedIcal,
        Date.parse("2026-03-01T10:00:00Z") / 1000,
        Date.parse("2026-03-01T11:00:00Z") / 1000,
      ]
    )

    routeInvoke((_command, args) => {
      const { ical } = putArgs(args)
      expect(args.resourcePath).toBe(`${CAL_HOME}evt-1.ics`)
      expect(ical).toContain("SUMMARY:New title")
      // Preserved from the stored blob — the form did not edit them.
      expect(ical).toContain("ORGANIZER:mailto:alice@example.com")
      expect(ical).toContain("ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:bob@example.com")
      expect(ical).toContain("DTSTART:20260301T120000Z")
      return null
    })

    const result = await updateEvent(
      executor,
      {
        id: `ce-${sourceId}:${CAL_HOME}:evt-1`,
        sourceId,
        calendarId: CAL_HOME,
        uid: "evt-1",
        summary: "Old title",
        location: null,
        description: null,
        startAt: Date.parse("2026-03-01T10:00:00Z") / 1000,
        endAt: Date.parse("2026-03-01T11:00:00Z") / 1000,
        allDay: false,
        recurrence: null,
        status: null,
      },
      {
        title: "New title",
        startAt: Date.parse("2026-03-01T12:00:00Z") / 1000,
        endAt: Date.parse("2026-03-01T13:00:00Z") / 1000,
        allDay: false,
      }
    )

    expect(result.ok).toBe(true)
    const rows = await rowsOf(executor, sourceId)
    expect(rows[0]).toMatchObject({
      uid: "evt-1",
      summary: "New title",
      start_at: Date.parse("2026-03-01T12:00:00Z") / 1000,
    })
  })

  it("deletes the resource (tolerating 404) and then the local row", async () => {
    await executor.execute(
      `INSERT INTO calendar_events (
         id, source_id, calendar_id, uid, ical, summary, start_at, end_at
       ) VALUES ($1, $2, $3, 'del-1', 'BEGIN:VCALENDAR', 'Gone', 0, 0)`,
      [`ce-${sourceId}:${CAL_HOME}:del-1`, sourceId, CAL_HOME]
    )
    routeInvoke((command, args) => {
      expect(command).toBe("caldav_delete_event")
      expect(args.resourcePath).toBe(`${CAL_HOME}del-1.ics`)
      return null
    })

    const result = await deleteEvent(executor, {
      id: `ce-${sourceId}:${CAL_HOME}:del-1`,
      sourceId,
      calendarId: CAL_HOME,
      uid: "del-1",
      summary: "Gone",
      location: null,
      description: null,
      startAt: 0,
      endAt: 0,
      allDay: false,
      recurrence: null,
      status: null,
    })
    expect(result).toEqual({ ok: true })
    expect(await rowsOf(executor, sourceId)).toEqual([])

    // A 404 answer means it was already gone server-side: still a success.
    rejectInvoke(() => ({
      kind: "status",
      message: "the server has no CalDAV resource at that URL (HTTP 404)",
      status: 404,
    }))
    const again = await deleteEvent(executor, {
      id: `ce-${sourceId}:${CAL_HOME}:del-1`,
      sourceId,
      calendarId: CAL_HOME,
      uid: "del-1",
      summary: "Gone",
      location: null,
      description: null,
      startAt: 0,
      endAt: 0,
      allDay: false,
      recurrence: null,
      status: null,
    })
    expect(again).toEqual({ ok: true })
  })
})

describe("writable destinations", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("lists google synced calendars (primary fallback) and caldav collections", async () => {
    await createCalendarSource(executor, null, { id: "src-g" })
    await executor.execute(
      "UPDATE calendar_sources SET sync_state_json = $1 WHERE id = 'src-g'",
      [JSON.stringify({ "cal-main": { nextSyncToken: "t" } })]
    )
    const configJson = await encryptCredentials({
      serverUrl: SERVER_URL,
      username: USERNAME,
      appPassword: APP_PASSWORD,
      calendarPaths: [CAL_HOME, `${CAL_HOME}work/`],
    })
    await addCalendarSource(executor, {
      id: "src-d",
      accountId: null,
      provider: "caldav",
      name: "dav",
      configJson,
    })

    const calendars = await listWritableEventCalendars(executor)
    // listCalendarSources orders by created_at, id — equal stamps fall
    // back to the id order (src-d < src-g).
    expect(calendars).toEqual([
      {
        sourceId: "src-d",
        sourceName: "dav",
        provider: "caldav",
        calendarId: CAL_HOME,
      },
      {
        sourceId: "src-d",
        sourceName: "dav",
        provider: "caldav",
        calendarId: `${CAL_HOME}work/`,
      },
      {
        sourceId: "src-g",
        sourceName: "me@gmail.com",
        provider: "google",
        calendarId: "cal-main",
      },
    ])
  })

  it("falls back to primary for a google source that has not synced yet", async () => {
    await createCalendarSource(executor, null, { id: "src-fresh" })
    const calendars = await listWritableEventCalendars(executor)
    expect(calendars).toEqual([
      {
        sourceId: "src-fresh",
        sourceName: "me@gmail.com",
        provider: "google",
        calendarId: "primary",
      },
    ])
    const source = await loadSource(executor, "src-fresh")
    expect(await defaultWritableCalendarId(source)).toBe("primary")
  })
})

describe("buildEventIcal (caldav blob builder)", () => {
  it("renders an escaping, CRLF VCALENDAR with UTC times and text escapes", () => {
    const ical = buildEventIcal("uid-1", {
      title: "A;B,C\\D",
      startAt: Date.parse("2026-03-02T10:00:00Z") / 1000,
      endAt: Date.parse("2026-03-02T11:00:00Z") / 1000,
      allDay: false,
      location: "Room 1",
      description: "line one\nline two",
      guests: ["a@x.com"],
    })
    const lines = ical.split("\r\n")
    expect(lines[0]).toBe("BEGIN:VCALENDAR")
    expect(lines).toContain("UID:uid-1")
    expect(lines).toContain("DTSTART:20260302T100000Z")
    expect(lines).toContain("DTEND:20260302T110000Z")
    expect(lines).toContain("SUMMARY:A\\;B\\,C\\\\D")
    expect(lines).toContain("DESCRIPTION:line one\\nline two")
    expect(lines).toContain("ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:a@x.com")
    expect(lines[lines.length - 1]).toBe("END:VCALENDAR")
  })
})
