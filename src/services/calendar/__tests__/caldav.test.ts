import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"

import {
  connectCaldavSource,
  discoverCaldavCalendars,
  extractRecurrenceRules,
  removedHrefToUid,
  syncCaldavSource,
  testCaldavConnection,
} from "../caldav"
import {
  decryptCredentials,
  encryptCredentials,
} from "../../crypto/credentials"
import { createInMemoryKeyStore } from "../../crypto/__tests__/in-memory-key-store"
import { setDefaultKeyStore } from "../../crypto/key-management"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { addCalendarSource, getCalendarSource, getCalendarSyncState } from "../sources"
import type { CalendarSource } from "../sources"
import { testCalendarConnection } from "../connect"

/**
 * CalDAV provider tests (task 5.2, design D5). The command wrappers are
 * exercised against a mocked `invoke` (the Rust side has its own loopback
 * mock-server cargo tests); the sync/persistence half runs against the
 * REAL v11 schema in node:sqlite — discovery mapping, event storage with
 * token persistence, delta removals, full-pass pruning, per-calendar
 * error recording, and the connection-test routing.
 */

vi.mock("@tauri-apps/api/core")

const invokeMock = vi.mocked(invoke)

const SERVER_URL = "https://dav.example.com/"
const USERNAME = "secret-user"
const APP_PASSWORD = "app-pass-99"
const CAL_HOME = "https://dav.example.com/dav/user/calendars/home/"

function caldavIcal(uid: string, summary: string): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SUMMARY:${summary}`,
    "DTSTART:20260301T100000Z",
    "DTEND:20260301T110000Z",
    "RRULE:FREQ=WEEKLY",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n")
}

function allDayIcal(uid: string): string {
  return [
    "BEGIN:VCALENDAR",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    "SUMMARY:Offsite",
    "DTSTART;VALUE=DATE:20260402",
    "DTEND;VALUE=DATE:20260403",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n")
}

/** Seed a caldav source whose sealed envelope carries these calendars. */
async function seedCaldavSource(
  executor: TestExecutor,
  calendarPaths: string[],
  id = "src-caldav"
): Promise<CalendarSource> {
  const configJson = await encryptCredentials({
    serverUrl: SERVER_URL,
    username: USERNAME,
    appPassword: APP_PASSWORD,
    calendarPaths,
  })
  await addCalendarSource(executor, {
    id,
    accountId: null,
    provider: "caldav",
    name: USERNAME,
    configJson,
  })
  const loaded = await getCalendarSource(executor, id)
  if (!loaded) throw new Error("seed failed")
  return loaded
}

/** Route invoke by command name. */
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

describe("caldav command wrappers", () => {
  it("discovers calendars and maps the wire shape", async () => {
    routeInvoke((command, args) => {
      expect(command).toBe("caldav_discover")
      expect(args).toMatchObject({
        serverUrl: SERVER_URL,
        username: USERNAME,
        appPassword: APP_PASSWORD,
      })
      return {
        calendars: [
          {
            href: CAL_HOME,
            display_name: "Home",
            description: "Family",
            ctag: "CTAG-1",
          },
        ],
      }
    })

    const calendars = await discoverCaldavCalendars({
      serverUrl: SERVER_URL,
      username: USERNAME,
      appPassword: APP_PASSWORD,
    })
    expect(calendars).toEqual([
      {
        href: CAL_HOME,
        displayName: "Home",
        description: "Family",
        ctag: "CTAG-1",
      },
    ])
  })

  it("surfaces the structured command error with its kind and status", async () => {
    rejectInvoke(() => ({
      kind: "status",
      message: "the server rejected the username or app password (HTTP 401)",
      status: 401,
    }))
    await expect(
      testCaldavConnection({
        serverUrl: SERVER_URL,
        username: USERNAME,
        appPassword: APP_PASSWORD,
      })
    ).rejects.toMatchObject({
      name: "CaldavProviderError",
      kind: "status",
      status: 401,
    })
  })

  it("normalizes non-structured rejections to network failures", async () => {
    rejectInvoke(() => new Error("ipc down"))
    await expect(
      testCaldavConnection({
        serverUrl: SERVER_URL,
        username: USERNAME,
        appPassword: APP_PASSWORD,
      })
    ).rejects.toMatchObject({ kind: "network" })
  })
})

describe("connectCaldavSource", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
    setDefaultKeyStore(createInMemoryKeyStore())
  })

  afterEach(() => {
    setDefaultKeyStore(null)
    executor.close()
  })

  it("seals the credentials and stores the selected calendar paths", async () => {
    const source = await connectCaldavSource(executor, {
      serverUrl: SERVER_URL,
      username: USERNAME,
      appPassword: APP_PASSWORD,
      calendars: [{ href: CAL_HOME, displayName: "Home" }],
    })

    expect(source.provider).toBe("caldav")
    expect(source.accountId).toBeNull()
    // The plaintext credentials never persist.
    expect(source.configJson).not.toContain(USERNAME)
    expect(source.configJson).not.toContain(APP_PASSWORD)

    const envelope = await decryptCredentials<{
      serverUrl: string
      username: string
      appPassword: string
      calendarPaths: string[]
    }>(source.configJson)
    expect(envelope).toEqual({
      serverUrl: SERVER_URL,
      username: USERNAME,
      appPassword: APP_PASSWORD,
      calendarPaths: [CAL_HOME],
    })
  })
})

describe("syncCaldavSource", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
    setDefaultKeyStore(createInMemoryKeyStore())
    invokeMock.mockReset()
  })

  afterEach(() => {
    setDefaultKeyStore(null)
    executor.close()
  })

  function rows(): { uid: string; summary: string | null; ical: string }[] {
    return executor.select(`
      SELECT uid, summary, ical FROM calendar_events
      WHERE source_id = 'src-caldav' ORDER BY uid ASC
    `) as never
  }

  it("stores a full pass as events and persists the fresh token", async () => {
    await seedCaldavSource(executor, [CAL_HOME])
    routeInvoke((command, args) => {
      expect(command).toBe("caldav_sync")
      expect(args).toMatchObject({
        serverUrl: SERVER_URL,
        username: USERNAME,
        appPassword: APP_PASSWORD,
        calendarPath: CAL_HOME,
        syncToken: null,
      })
      return {
        mode: "full",
        next_sync_token: "tok-1",
        changed: [
          { href: `${CAL_HOME}evt-1.ics`, ical: caldavIcal("evt-1", "Lunch") },
        ],
        removed: [],
      }
    })

    const source = await getCalendarSource(executor, "src-caldav")
    const result = await syncCaldavSource(executor, source!)
    expect(result.calendars).toHaveLength(1)
    expect(result.calendars[0]).toMatchObject({
      calendarPath: CAL_HOME,
      mode: "full",
      stored: 1,
      removed: 0,
      parseFailures: 0,
    })

    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      uid: "evt-1",
      summary: "Lunch",
      ical: caldavIcal("evt-1", "Lunch"),
    })
    const state = await getCalendarSyncState(executor, "src-caldav")
    expect(state[CAL_HOME]).toMatchObject({ nextSyncToken: "tok-1" })
    expect(state[CAL_HOME]?.lastSyncAt).toBeGreaterThan(0)
    expect(state[CAL_HOME]?.lastError).toBeUndefined()
  })

  it("maps all-day DATE values with an exclusive end", async () => {
    await seedCaldavSource(executor, [CAL_HOME])
    routeInvoke(() => ({
      mode: "full",
      next_sync_token: "tok-1",
      changed: [
        { href: `${CAL_HOME}off.ics`, ical: allDayIcal("off-1") },
      ],
      removed: [],
    }))
    await syncCaldavSource(executor, (await getCalendarSource(executor, "src-caldav"))!)

    const [row] = await executor.select<{
      start_at: number
      end_at: number
      all_day: number
    }>(
      "SELECT start_at, end_at, all_day FROM calendar_events WHERE source_id = 'src-caldav'"
    )
    expect(row?.all_day).toBe(1)
    expect(row?.start_at).toBe(Math.floor(Date.parse("2026-04-02T00:00:00Z") / 1000))
    expect(row?.end_at).toBe(Math.floor(Date.parse("2026-04-03T00:00:00Z") / 1000))
  })

  it("sends the stored token on the delta pass and applies href removals", async () => {
    await seedCaldavSource(executor, [CAL_HOME])
    const passes: unknown[] = [
      {
        mode: "full",
        next_sync_token: "tok-1",
        changed: [
          { href: `${CAL_HOME}evt-1.ics`, ical: caldavIcal("evt-1", "Lunch") },
          { href: `${CAL_HOME}gone.ics`, ical: caldavIcal("gone", "Old") },
        ],
        removed: [],
      },
      {
        mode: "delta",
        next_sync_token: "tok-2",
        changed: [
          {
            href: `${CAL_HOME}evt-1.ics`,
            ical: caldavIcal("evt-1", "Lunch moved"),
          },
        ],
        removed: [`${CAL_HOME}gone.ics`],
      },
    ]
    const seenSyncTokens: (string | null)[] = []
    let pass = 0
    routeInvoke((_command, args) => {
      seenSyncTokens.push((args.syncToken as string | null) ?? null)
      return passes[pass++] ?? { mode: "delta", next_sync_token: null, changed: [], removed: [] }
    })

    const source = await getCalendarSource(executor, "src-caldav")
    await syncCaldavSource(executor, source!)
    await syncCaldavSource(executor, source!)

    // The second pass rode the persisted cursor.
    expect(seenSyncTokens).toEqual([null, "tok-1"])
    const stored = await rows()
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ uid: "evt-1", summary: "Lunch moved" })
    // Server-wins update, row id stable.
    expect(stored[0]?.ical).toContain("Lunch moved")
  })

  it("prunes stale rows on a full pass", async () => {
    await seedCaldavSource(executor, [CAL_HOME])
    const passes: unknown[] = [
      {
        mode: "full",
        next_sync_token: null,
        changed: [
          { href: `${CAL_HOME}evt-1.ics`, ical: caldavIcal("evt-1", "Keep") },
          { href: `${CAL_HOME}stale.ics`, ical: caldavIcal("stale", "Old") },
        ],
        removed: [],
      },
      {
        mode: "full",
        next_sync_token: null,
        changed: [
          { href: `${CAL_HOME}evt-1.ics`, ical: caldavIcal("evt-1", "Keep") },
        ],
        removed: [],
      },
    ]
    let pass = 0
    routeInvoke(() => passes[pass++] ?? { mode: "full", next_sync_token: null, changed: [], removed: [] })

    const source = await getCalendarSource(executor, "src-caldav")
    const first = await syncCaldavSource(executor, source!)
    expect(first.calendars[0]).toMatchObject({ stored: 2, removed: 0 })
    const second = await syncCaldavSource(executor, source!)
    expect(second.calendars[0]).toMatchObject({ stored: 1, removed: 1, mode: "full" })
    expect((await rows()).map((row) => row.uid)).toEqual(["evt-1"])
  })

  it("counts unparseable calendar-data without failing the pass", async () => {
    await seedCaldavSource(executor, [CAL_HOME])
    routeInvoke(() => ({
      mode: "full",
      next_sync_token: "tok-1",
      changed: [
        { href: `${CAL_HOME}bad.ics`, ical: "this is not iCalendar" },
      ],
      removed: [],
    }))
    const result = await syncCaldavSource(
      executor,
      (await getCalendarSource(executor, "src-caldav"))!
    )
    expect(result.calendars[0]).toMatchObject({ parseFailures: 1, stored: 0 })
  })

  it("records a per-calendar failure and still syncs the others", async () => {
    const CAL_B = `${CAL_HOME}work/`
    await seedCaldavSource(executor, [CAL_HOME, CAL_B])
    invokeMock.mockImplementation(((command: string, args?: unknown) => {
      const call = (args ?? {}) as Record<string, unknown>
      if (command !== "caldav_sync") {
        return Promise.reject(new Error(`unexpected command: ${command}`))
      }
      if (call.calendarPath === CAL_HOME) {
        return Promise.reject({
          kind: "network",
          message: "connect to dav.example.com timed out",
        })
      }
      return Promise.resolve({
        mode: "full",
        next_sync_token: "tok-b",
        changed: [
          { href: `${CAL_B}b.ics`, ical: caldavIcal("b-1", "Work") },
        ],
        removed: [],
      })
    }) as typeof invoke)
    const result = await syncCaldavSource(
      executor,
      (await getCalendarSource(executor, "src-caldav"))!
    )
    expect(result.calendars[0]).toMatchObject({
      calendarPath: CAL_HOME,
      error: "connect to dav.example.com timed out",
    })
    expect(result.calendars[1]).toMatchObject({
      calendarPath: CAL_B,
      stored: 1,
    })

    const state = await getCalendarSyncState(executor, "src-caldav")
    expect(state[CAL_HOME]?.lastError).toBe("connect to dav.example.com timed out")
    expect(state[CAL_HOME]?.nextSyncToken).toBeUndefined()
    expect(state[CAL_B]).toMatchObject({ nextSyncToken: "tok-b" })
    // The failed calendar still shows its old rows (nothing was pruned).
    expect((await rows()).map((row) => row.uid)).toEqual(["b-1"])
  })

  it("throws (without touching rows) when the envelope cannot be unsealed", async () => {
    await addCalendarSource(executor, {
      id: "src-broken",
      accountId: null,
      provider: "caldav",
      name: "broken",
      configJson: "sealed",
    })
    const source = await getCalendarSource(executor, "src-broken")
    await expect(syncCaldavSource(executor, source!)).rejects.toThrow(
      /re-connect/
    )
  })
})

describe("testCalendarConnection for caldav sources", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
    setDefaultKeyStore(createInMemoryKeyStore())
  })

  afterEach(() => {
    setDefaultKeyStore(null)
    executor.close()
  })

  it("reports success with the caldav provider", async () => {
    await seedCaldavSource(executor, [CAL_HOME])
    routeInvoke((command) => {
      expect(command).toBe("caldav_test_connection")
      return null
    })
    await expect(
      testCalendarConnection(executor, "src-caldav")
    ).resolves.toMatchObject({ ok: true, provider: "caldav" })
  })

  it("maps 401 to the auth reason with the redacted detail", async () => {
    await seedCaldavSource(executor, [CAL_HOME])
    rejectInvoke(() => ({
      kind: "status",
      message: "the server rejected the username or app password (HTTP 401)",
      status: 401,
    }))
    const result = await testCalendarConnection(executor, "src-caldav")
    expect(result).toMatchObject({
      ok: false,
      provider: "caldav",
      reason: "auth",
    })
    if (!result.ok) {
      expect(result.detail).toContain("HTTP 401")
    }
  })

  it("maps transport and endpoint failures to their specific reasons", async () => {
    await seedCaldavSource(executor, [CAL_HOME])
    rejectInvoke((_command, args) => {
      // Credentials ride per call — assert they were passed, then fail.
      expect(args).toMatchObject({ serverUrl: SERVER_URL })
      return { kind: "network", message: "connect timed out" }
    })
    expect(await testCalendarConnection(executor, "src-caldav")).toMatchObject({
      ok: false,
      provider: "caldav",
      reason: "network",
    })

    rejectInvoke(() => ({
      kind: "status",
      message: "the CalDAV server returned HTTP 503",
      status: 503,
    }))
    expect(await testCalendarConnection(executor, "src-caldav")).toMatchObject({
      ok: false,
      provider: "caldav",
      reason: "api",
    })
  })
})

describe("caldav mapping helpers", () => {
  it("derives uid candidates from removed hrefs", () => {
    expect(removedHrefToUid("https://dav.x/cal/evt-1.ics")).toBe("evt-1")
    expect(removedHrefToUid("https://dav.x/cal/My%20Event.ics")).toBe(
      "My Event"
    )
    expect(removedHrefToUid("/dav/cal/no-extension")).toBe("no-extension")
    expect(removedHrefToUid("https://dav.x/cal/upper.ICS")).toBe("upper")
  })

  it("extracts raw recurrence rules from an ical blob", () => {
    expect(extractRecurrenceRules(caldavIcal("u", "s"))).toEqual([
      "RRULE:FREQ=WEEKLY",
    ])
    expect(
      extractRecurrenceRules("BEGIN:VEVENT\r\nEXDATE:20260401T100000Z\r\nEND:VEVENT")
    ).toEqual(["EXDATE:20260401T100000Z"])
    expect(extractRecurrenceRules("SUMMARY:none here")).toEqual([])
  })
})
