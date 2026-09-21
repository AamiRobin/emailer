import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createCalendarSource,
  createFetchMock,
  microsoftCalendar,
  microsoftEvent,
  microsoftViewPage,
} from "./calendar-fixtures"
import { setDefaultKeyStore } from "../../crypto/key-management"
import { createInMemoryKeyStore } from "../../crypto/__tests__/in-memory-key-store"
import { encryptCredentials, decryptCredentials } from "../../crypto/credentials"
import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { clearMicrosoftTokenCache } from "../../email/microsoft-token-manager"
import { GraphApiError } from "../../email/graph-api"
import { getCalendarSyncState } from "../sources"
import {
  buildMicrosoftEventPayload,
  createMicrosoftCalendarTokens,
  deleteMicrosoftEvent,
  graphDateTimeSeconds,
  insertMicrosoftEvent,
  listMicrosoftCalendars,
  mapMicrosoftEvent,
  microsoftEventToIcal,
  syncMicrosoftCalendarEvents,
  updateMicrosoftEvent,
} from "../microsoft-calendar"
import type { MicrosoftCalendarTokens } from "../microsoft-calendar"

/**
 * Microsoft Graph calendar provider tests (task 3.6): discovery parsing,
 * full + delta calendarView syncs with deltaLink persistence, the 410 GONE
 * full-resync fallback, nextLink paging with the loop guards, the Graph
 * event → calendar_events mapping (all-day + timed round trip, series
 * master skip, @removed tombstones), and the event CRUD surface over the
 * fixture router — including the 401 → refresh-retry → ProviderAuthError
 * path and the Retry-After throttle, through the REAL sealed-envelope
 * token source. No live network anywhere.
 */

function fakeTokens(accessToken = "at-1"): MicrosoftCalendarTokens {
  return {
    accountId: "acc-1",
    getToken: (force?: boolean) =>
      Promise.resolve(force ? `${accessToken}-forced` : accessToken),
  }
}

const DELTA_LINK =
  "https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$deltatoken=dlt1"

async function storedEvents(
  executor: TestExecutor,
  sourceId: string
): Promise<
  {
    uid: string
    summary: string | null
    start_at: number
    end_at: number
    all_day: number
    status: string | null
  }[]
> {
  return executor.select(
    `SELECT uid, summary, start_at, end_at, all_day, status
     FROM calendar_events WHERE source_id = $1 ORDER BY uid ASC`,
    [sourceId]
  )
}

describe("listMicrosoftCalendars (discovery)", () => {
  it("parses the calendar list with Bearer auth", async () => {
    const mock = createFetchMock()
    mock.on("GET", "/me/calendars", () => ({
      json: {
        value: [
          microsoftCalendar({ id: "cal-1", name: "Calendar", isDefaultCalendar: true }),
          microsoftCalendar({ id: "cal-2", name: "Team" }),
        ],
      },
    }))

    const calendars = await listMicrosoftCalendars(fakeTokens(), mock.fetch)
    expect(calendars.map((calendar) => calendar.id)).toEqual([
      "cal-1",
      "cal-2",
    ])
    expect(mock.calls[0]?.url).toContain(
      "https://graph.microsoft.com/v1.0/me/calendars"
    )
    expect(mock.calls[0]?.url).toContain("isDefaultCalendar")
    expect(mock.calls[0]?.headers.authorization).toBe("Bearer at-1")
  })

  it("follows validated nextLinks across pages and stops at a hostile one", async () => {
    const mock = createFetchMock()
    let call = 0
    mock.on("GET", "/me/calendars", () => {
      call += 1
      if (call === 1) {
        return {
          json: {
            value: [microsoftCalendar({ id: "cal-a" })],
            "@odata.nextLink":
              "https://graph.microsoft.com/v1.0/me/calendars?$skipToken=abc",
          },
        }
      }
      if (call === 2) {
        return {
          json: {
            value: [microsoftCalendar({ id: "cal-b" })],
            // A hostile (non-Graph) link must NOT become a bearer fetch.
            "@odata.nextLink": "https://evil.example.com/steal?token=1",
          },
        }
      }
      throw new Error("must not follow the hostile link")
    })

    const calendars = await listMicrosoftCalendars(fakeTokens(), mock.fetch)
    expect(calendars.map((calendar) => calendar.id)).toEqual([
      "cal-a",
      "cal-b",
    ])
    expect(
      mock.calls.every((call) => call.url.includes("graph.microsoft.com"))
    ).toBe(true)
  })
})

describe("graph time mapping", () => {
  it("reads offset-free UTC dateTimes and explicit offsets", () => {
    // Offset-free → UTC (Graph's default response shape, no Prefer header).
    expect(graphDateTimeSeconds({ dateTime: "2026-03-02T08:00:00" })).toBe(
      Math.floor(Date.parse("2026-03-02T08:00:00Z") / 1000)
    )
    // Explicit offsets parse as themselves.
    expect(
      graphDateTimeSeconds({ dateTime: "2026-03-02T10:00:00+02:00" })
    ).toBe(Math.floor(Date.parse("2026-03-02T08:00:00Z") / 1000))
    expect(graphDateTimeSeconds({})).toBeNull()
  })

  it("round-trips timed and all-day events through the row mapping + ical", () => {
    const timed = microsoftEvent({ id: "gev-timed" })
    const mapped = mapMicrosoftEvent("src-1", "cal-1", timed)
    expect(mapped?.isTombstone).toBe(false)
    expect(mapped?.input).toMatchObject({
      uid: "gev-timed",
      summary: "Review",
      location: "Room 4",
      description: "Quarterly review notes",
      allDay: false,
      status: "confirmed",
      recurrence: undefined,
      startAt: Math.floor(Date.parse("2026-03-02T08:00:00Z") / 1000),
      endAt: Math.floor(Date.parse("2026-03-02T09:00:00Z") / 1000),
    })
    const ical = mapped?.input.ical ?? ""
    expect(ical).toContain("BEGIN:VEVENT")
    expect(ical).toContain("UID:gev-timed")
    expect(ical).toContain("DTSTART:20260302T080000Z")
    expect(ical).toContain("DTEND:20260302T090000Z")
    expect(ical).toContain("SUMMARY:Review")
    expect(ical).toContain("STATUS:CONFIRMED")

    // All-day: midnight bounds, VALUE=DATE, exclusive end stored as-is.
    const allDay = mapMicrosoftEvent(
      "src-1",
      "cal-1",
      microsoftEvent({
        id: "gev-allday",
        subject: "Offsite",
        isAllDay: true,
        start: { dateTime: "2026-03-02T00:00:00", timeZone: "UTC" },
        end: { dateTime: "2026-03-04T00:00:00", timeZone: "UTC" },
      })
    )
    expect(allDay?.input.allDay).toBe(true)
    expect(allDay?.input.startAt).toBe(
      Math.floor(Date.parse("2026-03-02T00:00:00Z") / 1000)
    )
    expect(allDay?.input.endAt).toBe(
      Math.floor(Date.parse("2026-03-04T00:00:00Z") / 1000)
    )
    expect(allDay?.input.ical).toContain("DTSTART;VALUE=DATE:20260302")
    expect(allDay?.input.ical).toContain("DTEND;VALUE=DATE:20260304")
  })

  it("maps cancellation and delta tombstones", () => {
    // A cancelled occurrence keeps its payload with a cancelled status.
    const cancelled = mapMicrosoftEvent(
      "src-1",
      "cal-1",
      microsoftEvent({ id: "gev-c", isCancelled: true })
    )
    expect(cancelled?.input.status).toBe("cancelled")

    // An @removed item carries only the id — a tombstone that deletes.
    const removed = mapMicrosoftEvent(
      "src-1",
      "cal-1",
      microsoftEvent({ id: "gev-d", removed: true })
    )
    expect(removed?.isTombstone).toBe(true)
    expect(removed?.input.uid).toBe("gev-d")
  })

  it("renders the ical STATUS from isCancelled", () => {
    const ical = microsoftEventToIcal(
      microsoftEvent({ id: "gev-x", isCancelled: true })
    )
    expect(ical).toContain("STATUS:CANCELLED")
  })
})

describe("buildMicrosoftEventPayload", () => {
  it("sends offset-free UTC dateTimes with timeZone UTC", () => {
    const payload = buildMicrosoftEventPayload({
      title: "Sync",
      startAt: Math.floor(Date.parse("2026-03-02T08:00:00Z") / 1000),
      endAt: Math.floor(Date.parse("2026-03-02T09:00:00Z") / 1000),
      allDay: false,
      location: "Room 4",
      description: "Notes",
      guests: ["a@example.com", "b@example.com", " a@example.com "],
      reminderMinutes: 15,
    })
    expect(payload.subject).toBe("Sync")
    expect(payload.isAllDay).toBe(false)
    expect(payload.start).toEqual({
      dateTime: "2026-03-02T08:00:00",
      timeZone: "UTC",
    })
    expect(payload.end).toEqual({
      dateTime: "2026-03-02T09:00:00",
      timeZone: "UTC",
    })
    expect(payload.body).toEqual({ contentType: "text", content: "Notes" })
    expect(payload.attendees).toEqual([
      { emailAddress: { address: "a@example.com" }, type: "required" },
      { emailAddress: { address: "b@example.com" }, type: "required" },
    ])
    expect(payload.isReminderOn).toBe(true)
    expect(payload.reminderMinutesBeforeStart).toBe(15)
  })

  it("sends midnight bounds for all-day events (exclusive end kept)", () => {
    const payload = buildMicrosoftEventPayload({
      title: "Offsite",
      startAt: Math.floor(Date.parse("2026-03-02T00:00:00Z") / 1000),
      endAt: Math.floor(Date.parse("2026-03-02T00:00:00Z") / 1000),
      allDay: true,
    })
    expect(payload.isAllDay).toBe(true)
    expect(payload.start?.dateTime).toBe("2026-03-02T00:00:00")
    // A same-day all-day event still spans its one started day.
    expect(payload.end?.dateTime).toBe("2026-03-03T00:00:00")
  })

  it("turns the reminder off when the patch clears it", () => {
    const payload = buildMicrosoftEventPayload({ reminderMinutes: null })
    expect(payload.isReminderOn).toBe(false)
    expect(payload.reminderMinutesBeforeStart).toBeUndefined()
  })
})

describe("event CRUD surface", () => {
  it("inserts into a calendar and returns the stored event", async () => {
    const mock = createFetchMock()
    mock.on("POST", "/me/calendars/cal-1/events", () => ({
      json: microsoftEvent({ id: "gev-new", subject: "Created" }),
    }))

    const created = await insertMicrosoftEvent(
      fakeTokens(),
      "cal-1",
      buildMicrosoftEventPayload({ title: "Created" }),
      mock.fetch
    )
    expect(created.id).toBe("gev-new")
    expect(mock.calls[0]?.headers.authorization).toBe("Bearer at-1")
    const body = JSON.parse(mock.calls[0]?.body ?? "{}") as {
      subject?: string
    }
    expect(body.subject).toBe("Created")
  })

  it("patches one event and tolerates an empty delete body", async () => {
    const mock = createFetchMock()
    mock.on("PATCH", "/me/calendars/cal-1/events/gev-1", () => ({
      json: microsoftEvent({ id: "gev-1", subject: "Moved" }),
    }))
    mock.on("DELETE", "/me/calendars/cal-1/events/gev-1", () => ({
      // An empty-bodied success (Graph answers 204; the fixture router
      // cannot build a 204 Response with a body, 200 + empty text is the
      // same shape client-side).
      status: 200,
      text: "",
    }))

    const updated = await updateMicrosoftEvent(
      fakeTokens(),
      "cal-1",
      "gev-1",
      { subject: "Moved" },
      mock.fetch
    )
    expect(updated?.subject).toBe("Moved")

    await expect(
      deleteMicrosoftEvent(fakeTokens(), "cal-1", "gev-1", mock.fetch)
    ).resolves.toBeNull()
  })

  it("counts a 404 delete as already-gone", async () => {
    const mock = createFetchMock()
    mock.on("DELETE", "/me/calendars/cal-1/events/gev-gone", () => ({
      status: 404,
      json: { error: { code: "ErrorItemNotFound", message: "not found" } },
    }))
    await expect(
      deleteMicrosoftEvent(fakeTokens(), "cal-1", "gev-gone", mock.fetch)
    ).resolves.toBeNull()
  })

  it("honors Retry-After on a 429 with bounded recorded waits", async () => {
    const waits: number[] = []
    const tokens: MicrosoftCalendarTokens = {
      ...fakeTokens(),
      delayImpl: (ms) => {
        waits.push(ms)
        return Promise.resolve()
      },
    }
    const mock = createFetchMock()
    let call = 0
    mock.on("GET", "/me/calendars", () => {
      call += 1
      if (call === 1) {
        return {
          status: 429,
          json: { error: { code: "tooManyRequests" } },
          headers: { "retry-after": "2" },
        }
      }
      return { json: { value: [microsoftCalendar({ id: "cal-1" })] } }
    })

    const calendars = await listMicrosoftCalendars(tokens, mock.fetch)
    expect(calendars.map((calendar) => calendar.id)).toEqual(["cal-1"])
    expect(call).toBe(2)
    // The header wins: 2s, capped by the shared throttle ceiling.
    expect(waits).toEqual([Math.min(2000, 60_000)])
  })

  it("throws GraphApiError with the verbatim Graph message", async () => {
    const mock = createFetchMock()
    mock.on("GET", "/me/calendars", () => ({
      status: 403,
      json: {
        error: { code: "ErrorAccessDenied", message: "Admin policy" },
      },
    }))
    const error: unknown = await listMicrosoftCalendars(
      fakeTokens(),
      mock.fetch
    ).then(
      () => null,
      (thrown: unknown) => thrown
    )
    expect(error).toBeInstanceOf(GraphApiError)
    expect((error as GraphApiError).status).toBe(403)
    expect((error as GraphApiError).code).toBe("ErrorAccessDenied")
    expect((error as GraphApiError).message).toContain("Admin policy")
  })
})

describe("syncMicrosoftCalendarEvents", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
    setDefaultKeyStore(createInMemoryKeyStore())
  })

  afterEach(() => {
    clearMicrosoftTokenCache()
    setDefaultKeyStore(null)
    executor.close()
  })

  it("runs the full pass over the delta window, skips series masters, and stores the deltaLink", async () => {
    const sourceId = await createCalendarSource(executor, null, {
      id: "src-ms",
      provider: "microsoft",
    })
    const mock = createFetchMock()
    mock.on("GET", "/me/calendars/cal-1/calendarView/delta", () => ({
      json: microsoftViewPage(
        [
          microsoftEvent({ id: "gev-1", subject: "Single" }),
          microsoftEvent({
            id: "gev-master",
            type: "seriesMaster",
            subject: "Weekly (master)",
          }),
          microsoftEvent({
            id: "gev-occ",
            type: "occurrence",
            seriesMasterId: "gev-master",
            subject: "Weekly",
          }),
        ],
        { deltaLink: DELTA_LINK }
      ),
    }))

    const result = await syncMicrosoftCalendarEvents(
      executor,
      {
        id: sourceId,
        accountId: null,
        provider: "microsoft",
        name: "me@outlook.com",
        configJson: "sealed",
        syncState: {},
        createdAt: 0,
      },
      "cal-1",
      fakeTokens(),
      { fetchImpl: mock.fetch }
    )

    expect(result.mode).toBe("full")
    // The master is skipped; its occurrence materializes as its own row.
    expect(result.stored).toBe(2)
    const events = await storedEvents(executor, sourceId)
    expect(events.map((event) => event.uid).sort()).toEqual([
      "gev-1",
      "gev-occ",
    ])
    // Occurrence rows carry no recurrence payload (server-side expansion).
    const occurrence = await executor.select<{ recurrence: string | null }>(
      "SELECT recurrence FROM calendar_events WHERE uid = 'gev-occ'"
    )
    expect(occurrence[0]?.recurrence).toBeNull()

    // The initial URL carries the fixed window with Z-suffix instants.
    const url = mock.calls[0]?.url ?? ""
    expect(url).toContain("/me/calendars/cal-1/calendarView/delta")
    expect(url).toContain("startDateTime=")
    expect(url).toContain("Z&")

    // The deltaLink is the next pass's cursor (in the generic
    // nextSyncToken field).
    const state = await getCalendarSyncState(executor, sourceId)
    expect(state["cal-1"]?.nextSyncToken).toBe(DELTA_LINK)
    expect(state["cal-1"]?.lastError).toBeUndefined()
  })

  it("delta-syncs through the stored link and applies @removed tombstones", async () => {
    const sourceId = await createCalendarSource(executor, null, {
      id: "src-ms",
      provider: "microsoft",
      syncStateJson: JSON.stringify({
        "cal-1": { nextSyncToken: DELTA_LINK, lastSyncAt: 1 },
      }),
    })
    await executor.execute(
      `INSERT INTO calendar_events (
         id, source_id, calendar_id, uid, ical, summary, start_at, end_at
       ) VALUES ('row-1', '${sourceId}', 'cal-1', 'gev-gone', 'BEGIN:VEVENT', 'Gone', 0, 0)`
    )
    const mock = createFetchMock()
    mock.on("GET", "$deltatoken=dlt1", () => ({
      json: microsoftViewPage([microsoftEvent({ id: "gev-gone", removed: true })], {
        deltaLink: DELTA_LINK,
      }),
    }))

    const result = await syncMicrosoftCalendarEvents(
      executor,
      {
        id: sourceId,
        accountId: null,
        provider: "microsoft",
        name: "me@outlook.com",
        configJson: "sealed",
        syncState: { "cal-1": { nextSyncToken: DELTA_LINK } },
        createdAt: 0,
      },
      "cal-1",
      fakeTokens(),
      { fetchImpl: mock.fetch }
    )

    expect(result.mode).toBe("delta")
    expect(result.removed).toBe(1)
    const events = await storedEvents(executor, sourceId)
    expect(events).toEqual([])
    // The pass followed the STORED link, not a fresh window.
    expect(mock.calls[0]?.url).toBe(DELTA_LINK)
  })

  it("re-anchors the window once after 410 GONE (full-resync)", async () => {
    const sourceId = await createCalendarSource(executor, null, {
      id: "src-ms",
      provider: "microsoft",
      syncStateJson: JSON.stringify({
        "cal-1": { nextSyncToken: DELTA_LINK },
      }),
    })
    await executor.execute(
      `INSERT INTO calendar_events (
         id, source_id, calendar_id, uid, ical, summary, start_at, end_at
       ) VALUES ('row-1', '${sourceId}', 'cal-1', 'gev-stale', 'BEGIN:VEVENT', 'Stale', 0, 0)`
    )
    let call = 0
    const mock = createFetchMock()
    mock.on("GET", "calendarView/delta", () => {
      call += 1
      if (call === 1) {
        return {
          status: 410,
          json: { error: { code: "resyncRequired", message: "gone" } },
        }
      }
      return {
        json: microsoftViewPage(
          [microsoftEvent({ id: "gev-fresh", subject: "Fresh" })],
          { deltaLink: DELTA_LINK }
        ),
      }
    })

    const result = await syncMicrosoftCalendarEvents(
      executor,
      {
        id: sourceId,
        accountId: null,
        provider: "microsoft",
        name: "me@outlook.com",
        configJson: "sealed",
        syncState: { "cal-1": { nextSyncToken: DELTA_LINK } },
        createdAt: 0,
      },
      "cal-1",
      fakeTokens(),
      { fetchImpl: mock.fetch }
    )

    expect(result.mode).toBe("full-resync")
    // The stale cached row was wiped before the fresh full pass.
    const events = await storedEvents(executor, sourceId)
    expect(events.map((event) => event.uid)).toEqual(["gev-fresh"])
    expect(call).toBe(2)
  })

  it("pages through nextLinks within one pass", async () => {
    const sourceId = await createCalendarSource(executor, null, {
      id: "src-ms",
      provider: "microsoft",
    })
    const nextLink =
      "https://graph.microsoft.com/v1.0/me/calendars/cal-1/calendarView/delta?$skiptoken=pg2"
    const mock = createFetchMock()
    let call = 0
    mock.on("GET", "calendarView/delta", () => {
      call += 1
      if (call === 1) {
        return {
          json: microsoftViewPage([microsoftEvent({ id: "gev-p1" })], {
            nextLink,
          }),
        }
      }
      return {
        json: microsoftViewPage([microsoftEvent({ id: "gev-p2" })], {
          deltaLink: DELTA_LINK,
        }),
      }
    })

    const result = await syncMicrosoftCalendarEvents(
      executor,
      {
        id: sourceId,
        accountId: null,
        provider: "microsoft",
        name: "me@outlook.com",
        configJson: "sealed",
        syncState: {},
        createdAt: 0,
      },
      "cal-1",
      fakeTokens(),
      { fetchImpl: mock.fetch }
    )
    expect(result.stored).toBe(2)
    expect(call).toBe(2)
    expect(mock.calls[1]?.url).toBe(nextLink)
  })
})

describe("createMicrosoftCalendarTokens (sealed envelope + rotation re-seal)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
    setDefaultKeyStore(createInMemoryKeyStore())
  })

  afterEach(() => {
    clearMicrosoftTokenCache()
    setDefaultKeyStore(null)
    executor.close()
  })

  function seededSource(configJson: string) {
    return {
      id: "src-ms",
      accountId: "acc-1",
      provider: "microsoft" as const,
      name: "me@outlook.com",
      configJson,
      syncState: {},
      createdAt: 0,
    }
  }

  it("refreshes once on a 401 and fails with ProviderAuthError after a second 401", async () => {
    const configJson = await encryptCredentials({
      refreshToken: "0.calRT",
      clientId: "client-1",
    })
    const mock = createFetchMock()
    mock.on("POST", "/common/oauth2/v2.0/token", () => ({
      json: { access_token: "0.calAT", expires_in: 3600 },
    }))
    mock.on("GET", "/me/calendars", () => ({
      status: 401,
      json: { error: { code: "InvalidAuthenticationToken" } },
    }))

    const tokens = await createMicrosoftCalendarTokens(
      executor,
      seededSource(configJson),
      mock.fetch
    )
    const error: unknown = await listMicrosoftCalendars(tokens, mock.fetch).then(
      () => null,
      (thrown: unknown) => thrown
    )
    expect((error as Error | null)?.name).toBe("ProviderAuthError")
    // Two attempts only: initial + one silent refresh.
    expect(mock.calls.filter((call) => call.method === "GET")).toHaveLength(2)
    // The refresh used the source's own calendar envelope + client id.
    const refresh = mock.calls.find((call) => call.url.includes("/token"))
    expect(refresh?.body).toContain("client_id=client-1")
    expect(refresh?.body).toContain("refresh_token=0.calRT")
  })

  it("re-seals Entra's rotated refresh token into the source row (never the mail envelope)", async () => {
    const accountId = await createAccount(executor, "microsoft")
    const configJson = await encryptCredentials({
      refreshToken: "0.oldRT",
      clientId: "client-1",
    })
    await createCalendarSource(executor, accountId, {
      id: "src-ms",
      provider: "microsoft",
      configJson,
    })
    const rows = await executor.select<{ config_json: string }>(
      "SELECT config_json FROM calendar_sources WHERE id = 'src-ms'"
    )
    const source = {
      id: "src-ms",
      accountId,
      provider: "microsoft" as const,
      name: "me@outlook.com",
      configJson: rows[0]?.config_json ?? configJson,
      syncState: {},
      createdAt: 0,
    }
    const mock = createFetchMock()
    mock.on("POST", "/common/oauth2/v2.0/token", () => ({
      json: {
        access_token: "0.newAT",
        refresh_token: "0.rotatedRT",
        expires_in: 3600,
      },
    }))
    mock.on("GET", "/me/calendars", () => ({
      json: { value: [microsoftCalendar({ id: "cal-1" })] },
    }))

    const tokens = await createMicrosoftCalendarTokens(
      executor,
      source,
      mock.fetch
    )
    await listMicrosoftCalendars(tokens, mock.fetch)

    // A forced refresh (the 401-retry shape) triggers the rotation re-seal.
    clearMicrosoftTokenCache("calendar:src-ms")
    mock.on("POST", "/common/oauth2/v2.0/token", () => ({
      json: {
        access_token: "0.nextAT",
        refresh_token: "0.rotatedRT2",
        expires_in: 3600,
      },
    }))
    await tokens.getToken(true)

    const sealed = await executor.select<{ config_json: string }>(
      "SELECT config_json FROM calendar_sources WHERE id = 'src-ms'"
    )
    const envelope = await decryptCredentials<{
      refreshToken: string
      clientId?: string
    }>(sealed[0]?.config_json ?? null)
    expect(envelope?.refreshToken).toBe("0.rotatedRT2")
    // The client id survives every re-seal (self-contained envelope).
    expect(envelope?.clientId).toBe("client-1")
    // The mail account's own credentials were never written.
    const accountRows = await executor.select<{
      credentials_json: string | null
    }>("SELECT credentials_json FROM accounts WHERE id = $1", [accountId])
    expect(accountRows[0]?.credentials_json).toBeNull()
  })
})
