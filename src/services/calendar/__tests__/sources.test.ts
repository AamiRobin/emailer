import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { openUrl } from "@tauri-apps/plugin-opener"

import {
  CALENDAR_CONNECT_SCOPES,
  CalendarConnectCancelledError,
  CalendarConsentDeniedError,
  CalendarScopeNotGrantedError,
  connectGoogleCalendar,
  testCalendarConnection,
} from "../connect"
import { GOOGLE_CALENDAR_SCOPE } from "../../account-flows/oauth-pkce"
import type { OauthCallback } from "../../account-flows/oauth-pkce"
import { createInMemoryKeyStore } from "../../crypto/__tests__/in-memory-key-store"
import {
  decryptCredentials,
  encryptCredentials,
} from "../../crypto/credentials"
import { setDefaultKeyStore } from "../../crypto/key-management"
import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
// The token manager keys its module-level access-token cache by the
// namespaced source id; tests clear it so cached tokens never leak across
// test cases (fresh executors would otherwise meet a still-valid cache).
import { clearGmailTokenCache } from "../../email/token-manager"
import {
  addCalendarSource,
  getCalendarSource,
  getCalendarSyncState,
  listCalendarSources,
  listCalendarSourcesForAccount,
  removeCalendarSource,
  renameCalendarSource,
  updateCalendarSyncState,
} from "../sources"

/**
 * Calendar source CRUD + connect-flow tests (task 5.1, design D5). The
 * remove-cascades-events and never-touches-mail assertions cover the spec's
 * "Remove a calendar source" scenario; the connect flow drives the REAL
 * oauth-pkce consent loop against mocked invoke/openUrl and a fixture
 * token endpoint, asserting the calendar scope is requested and verified
 * before anything is sealed and stored.
 */

vi.mock("@tauri-apps/api/core")
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }))

const invokeMock = vi.mocked(invoke)
const openUrlMock = vi.mocked(openUrl)

const TOKEN_URL = "https://oauth2.googleapis.com/token"
const CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList"

interface RecordedCall {
  url: string
  method: string
  body?: string
}

/** Minimal fetch double: substring-routed JSON replies, recording calls. */
function createFetchDouble(
  routes: { pattern: string; status?: number; payload: unknown }[]
): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const call: RecordedCall = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      body: typeof init?.body === "string" ? init.body : undefined,
    }
    calls.push(call)
    const route = routes.find((candidate) => url.includes(candidate.pattern))
    if (!route) throw new Error(`unexpected fetch: ${url}`)
    const text = JSON.stringify(route.payload)
    return new Response(text, {
      status: route.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
  return { fetch: stub, calls }
}

/** invoke double: start_oauth_server echoes the state from the auth URL. */
function routeInvoke(callback?: (state: string | null, url: URL) => OauthCallback): void {
  invokeMock.mockImplementation(((command: string) => {
    if (command === "find_free_loopback_port") {
      return Promise.resolve(17248)
    }
    if (command !== "start_oauth_server") {
      return Promise.reject(new Error(`unexpected command: ${command}`))
    }
    return new Promise<OauthCallback>((resolve) => {
      void vi
        .waitFor(() => {
          expect(openUrlMock).toHaveBeenCalledTimes(1)
        })
        .then(() => {
          const url = new URL(openUrlMock.mock.calls[0][0] as string)
          resolve(
            callback
              ? callback(url.searchParams.get("state"), url)
              : {
                  port: 17248,
                  code: "4/0cal-code",
                  state: url.searchParams.get("state"),
                  error: null,
                  errorDescription: null,
                  scope: null,
                }
          )
        })
    })
  }) as typeof invoke)
}

describe("calendar_sources CRUD", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("adds, lists and gets sources with defaults", async () => {
    const accountId = await createAccount(executor)
    await addCalendarSource(executor, {
      id: "src-1",
      accountId,
      provider: "google",
      name: "me@gmail.com",
      configJson: "sealed-ciphertext",
    })

    const sources = await listCalendarSources(executor)
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      id: "src-1",
      accountId,
      provider: "google",
      name: "me@gmail.com",
      configJson: "sealed-ciphertext",
      syncState: {},
    })
    // created_at comes from the unixepoch() default.
    expect(sources[0]?.createdAt).toBeGreaterThan(0)
    expect(await getCalendarSource(executor, "src-1")).toMatchObject({
      id: "src-1",
    })
  })

  it("lists sources per linked account", async () => {
    const accountA = await createAccount(executor)
    const accountB = await createAccount(executor)
    await addCalendarSource(executor, {
      id: "src-a",
      accountId: accountA,
      provider: "google",
      name: "A",
      configJson: "x",
    })
    await addCalendarSource(executor, {
      id: "src-b",
      accountId: accountB,
      provider: "google",
      name: "B",
      configJson: "x",
    })

    const ofA = await listCalendarSourcesForAccount(executor, accountA)
    expect(ofA.map((source) => source.id)).toEqual(["src-a"])
  })

  it("enforces the provider check", async () => {
    await expect(
      executor.execute(
        `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
         VALUES ('src-bad', NULL, 'icloud', 'x', 'y')`
      )
    ).rejects.toThrow()
  })

  it("renames a source without touching config", async () => {
    await addCalendarSource(executor, {
      id: "src-1",
      accountId: null,
      provider: "google",
      name: "Before",
      configJson: "sealed",
    })
    await renameCalendarSource(executor, "src-1", "After")
    const source = await getCalendarSource(executor, "src-1")
    expect(source?.name).toBe("After")
    expect(source?.configJson).toBe("sealed")
  })

  it("removes the source and its events but never the linked account (mail)", async () => {
    const accountId = await createAccount(executor)
    await addCalendarSource(executor, {
      id: "src-1",
      accountId,
      provider: "google",
      name: "me@gmail.com",
      configJson: "sealed",
    })
    await executor.execute(
      `INSERT INTO calendar_events (
         id, source_id, calendar_id, uid, ical, start_at, end_at
       ) VALUES ('e1', 'src-1', 'cal-1', 'uid-1', 'BEGIN:VEVENT', 0, 0),
                 ('e2', 'src-1', 'cal-1', 'uid-2', 'BEGIN:VEVENT', 0, 0)`
    )

    const result = await removeCalendarSource(executor, "src-1")
    expect(result.eventsDeleted).toBe(2)
    expect(await listCalendarSources(executor)).toEqual([])
    const events = await executor.select<{ id: string }>(
      "SELECT id FROM calendar_events WHERE source_id = 'src-1'"
    )
    expect(events).toEqual([])
    // The mail account row survives untouched.
    expect(await getCalendarSource(executor, "src-1")).toBeNull()
    const accounts = await executor.select<{ id: string }>(
      "SELECT id FROM accounts"
    )
    expect(accounts.map((account) => account.id)).toEqual([accountId])
  })

  it("cascades source removal when the linked mail account is deleted", async () => {
    const accountId = await createAccount(executor)
    await addCalendarSource(executor, {
      id: "src-1",
      accountId,
      provider: "google",
      name: "me@gmail.com",
      configJson: "sealed",
    })
    await executor.execute(
      `INSERT INTO calendar_events (
         id, source_id, calendar_id, uid, ical, start_at, end_at
       ) VALUES ('e1', 'src-1', 'cal-1', 'uid-1', 'BEGIN:VEVENT', 0, 0)`
    )

    await executor.execute("DELETE FROM accounts WHERE id = $1", [accountId])
    expect(await listCalendarSources(executor)).toEqual([])
    const events = await executor.select<{ id: string }>(
      "SELECT id FROM calendar_events"
    )
    expect(events).toEqual([])
  })
})

describe("calendar sync state bookkeeping", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("merges per-calendar entries without clobbering other calendars", async () => {
    await addCalendarSource(executor, {
      id: "src-1",
      accountId: null,
      provider: "google",
      name: "me@gmail.com",
      configJson: "sealed",
    })

    await updateCalendarSyncState(executor, "src-1", "cal-a", {
      nextSyncToken: "tok-a",
      lastSyncAt: 111,
    })
    await updateCalendarSyncState(executor, "src-1", "cal-b", {
      nextSyncToken: "tok-b",
    })

    const source = await getCalendarSource(executor, "src-1")
    expect(source?.syncState).toEqual({
      "cal-a": { nextSyncToken: "tok-a", lastSyncAt: 111 },
      "cal-b": { nextSyncToken: "tok-b" },
    })
  })

  it("clears entries with null patches and drops the column when empty", async () => {
    await addCalendarSource(executor, {
      id: "src-1",
      accountId: null,
      provider: "google",
      name: "me@gmail.com",
      configJson: "sealed",
    })
    await updateCalendarSyncState(executor, "src-1", "cal-a", {
      nextSyncToken: "tok-a",
      lastError: "boom",
    })
    await updateCalendarSyncState(executor, "src-1", "cal-a", {
      lastError: null,
    })
    expect(await getCalendarSyncState(executor, "src-1")).toEqual({
      "cal-a": { nextSyncToken: "tok-a" },
    })

    await updateCalendarSyncState(executor, "src-1", "cal-a", {
      nextSyncToken: null,
      lastSyncAt: null,
    })
    // Everything for the calendar removed → the JSON column empties out.
    expect(await getCalendarSyncState(executor, "src-1")).toEqual({})
    const rows = await executor.select<{ sync_state_json: string | null }>(
      "SELECT sync_state_json FROM calendar_sources WHERE id = 'src-1'"
    )
    expect(rows[0]?.sync_state_json).toBeNull()
  })

  it("treats a corrupt sync-state blob as empty", async () => {
    await executor.execute(
      `INSERT INTO calendar_sources (id, account_id, provider, name, config_json, sync_state_json)
       VALUES ('src-x', NULL, 'google', 'x', 'sealed', '{not json')`
    )
    expect(await getCalendarSyncState(executor, "src-x")).toEqual({})
  })
})

describe("connectGoogleCalendar", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(() => {
    invokeMock.mockReset()
    openUrlMock.mockReset()
    executor = createTestExecutor()
    setDefaultKeyStore(createInMemoryKeyStore())
  })

  afterEach(() => {
    clearGmailTokenCache()
    executor.close()
    setDefaultKeyStore(null)
  })

  it("runs the consent with mail + calendar scopes, verifies the grant, seals the tokens and stores the source", async () => {
    accountId = await createAccount(executor)
    routeInvoke()

    const fetchDouble = createFetchDouble([
      {
        pattern: TOKEN_URL,
        payload: {
          access_token: "ya29.cal-access",
          refresh_token: "1//0cal-refresh",
          expires_in: 3600,
          scope: `https://mail.google.com/ email ${GOOGLE_CALENDAR_SCOPE}`,
        },
      },
      {
        pattern: CALENDAR_LIST_URL,
        payload: {
          items: [
            { id: "cal-primary", summary: "me@gmail.com", primary: true },
            { id: "cal-work", summary: "Work" },
          ],
        },
      },
    ])

    const result = await connectGoogleCalendar({
      accountId,
      clientId: "client-id-1",
      executor,
      fetchImpl: fetchDouble.fetch,
    })

    // The consent URL requested mail scopes PLUS the calendar scope, and
    // the standard offline PKCE params are intact.
    const authUrl = new URL(openUrlMock.mock.calls[0][0] as string)
    expect(authUrl.searchParams.get("scope")?.split(" ")).toEqual(
      CALENDAR_CONNECT_SCOPES
    )
    expect(authUrl.searchParams.get("access_type")).toBe("offline")
    expect(authUrl.searchParams.get("prompt")).toBe("consent")

    expect(result.accountId).toBe(accountId)
    expect(result.calendars.map((calendar) => calendar.id)).toEqual([
      "cal-primary",
      "cal-work",
    ])

    const sources = await listCalendarSources(executor)
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      accountId,
      provider: "google",
      // The default name is the linked account's email.
      name: `${accountId}@example.com`,
    })

    // The sealed envelope decrypts to the calendar token set + client id.
    const envelope = await decryptCredentials<{
      refreshToken: string
      accessToken: string
      accessTokenExpiresAt: number
      clientId: string
    }>(sources[0]?.configJson ?? null)
    expect(envelope).toMatchObject({
      refreshToken: "1//0cal-refresh",
      accessToken: "ya29.cal-access",
      clientId: "client-id-1",
    })

    // The mail account's own credentials were NEVER written — the sealed
    // envelope lives only on the source row (remove-source never touches
    // mail, spec scenario).
    const accountRows = await executor.select<{ credentials_json: string | null }>(
      "SELECT credentials_json FROM accounts WHERE id = $1",
      [accountId]
    )
    expect(accountRows[0]?.credentials_json).toBeNull()
  })

  it("fails specifically and persists nothing when the calendar scope is not granted", async () => {
    accountId = await createAccount(executor)
    routeInvoke()
    const fetchDouble = createFetchDouble([
      {
        pattern: TOKEN_URL,
        payload: {
          access_token: "ya29.x",
          refresh_token: "1//0x",
          expires_in: 3600,
          // No calendar scope in the grant (e.g. Workspace policy).
          scope: "https://mail.google.com/ email",
        },
      },
    ])

    await expect(
      connectGoogleCalendar({
        accountId,
        clientId: "client-id-1",
        executor,
        fetchImpl: fetchDouble.fetch,
      })
    ).rejects.toBeInstanceOf(CalendarScopeNotGrantedError)
    expect(await listCalendarSources(executor)).toEqual([])
  })

  it("maps a cancelled consent to the quiet cancellation error", async () => {
    accountId = await createAccount(executor)
    invokeMock.mockImplementation(((command: string) => {
      if (command === "find_free_loopback_port") {
        return Promise.resolve(17248)
      }
      if (command === "start_oauth_server") {
        return Promise.reject(new Error("OAuth sign-in was cancelled"))
      }
      return Promise.reject(new Error(`unexpected command: ${command}`))
    }) as typeof invoke)
    openUrlMock.mockResolvedValue(undefined)

    await expect(
      connectGoogleCalendar({
        accountId,
        clientId: "client-id-1",
        executor,
        fetchImpl: createFetchDouble([]).fetch,
      })
    ).rejects.toBeInstanceOf(CalendarConnectCancelledError)
    expect(await listCalendarSources(executor)).toEqual([])
  })

  it("maps a consent denial to the typed denial error", async () => {
    accountId = await createAccount(executor)
    routeInvoke((_state, url) => ({
      port: 17248,
      code: null,
      state: url.searchParams.get("state"),
      error: "access_denied",
      errorDescription: "Consent was denied",
      scope: null,
    }))

    const error: unknown = await connectGoogleCalendar({
      accountId,
      clientId: "client-id-1",
      executor,
      fetchImpl: createFetchDouble([]).fetch,
    }).then(
      () => null,
      (thrown: unknown) => thrown
    )
    expect(error).toBeInstanceOf(CalendarConsentDeniedError)
    expect((error as CalendarConsentDeniedError).googleError).toBe(
      "access_denied"
    )
    expect(await listCalendarSources(executor)).toEqual([])
  })
})

describe("testCalendarConnection", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
    setDefaultKeyStore(createInMemoryKeyStore())
  })

  afterEach(() => {
    clearGmailTokenCache()
    executor.close()
    setDefaultKeyStore(null)
  })

  it("reports success with the discovered calendars", async () => {
    const accountId = await createAccount(executor)
    const configJson = await encryptCredentials({
      refreshToken: "1//0rt",
      clientId: "client-id-1",
    })
    await addCalendarSource(executor, {
      id: "src-1",
      accountId,
      provider: "google",
      name: "me@gmail.com",
      configJson,
    })

    const fetchDouble = createFetchDouble([
      { pattern: TOKEN_URL, payload: { access_token: "ya29.t", expires_in: 3600 } },
      {
        pattern: CALENDAR_LIST_URL,
        payload: { items: [{ id: "cal-1", summary: "One" }] },
      },
    ])

    const result = await testCalendarConnection(
      executor,
      "src-1",
      fetchDouble.fetch
    )
    expect(result).toMatchObject({
      ok: true,
      provider: "google",
      calendars: [{ id: "cal-1" }],
    })
  })

  it("reports a specific auth failure when the grant is dead", async () => {
    const configJson = await encryptCredentials({
      refreshToken: "1//0dead",
      clientId: "client-id-1",
    })
    await addCalendarSource(executor, {
      id: "src-1",
      accountId: null,
      provider: "google",
      name: "me@gmail.com",
      configJson,
    })

    const fetchDouble = createFetchDouble([
      {
        pattern: TOKEN_URL,
        status: 400,
        payload: { error: "invalid_grant", error_description: "Token expired" },
      },
    ])

    const result = await testCalendarConnection(
      executor,
      "src-1",
      fetchDouble.fetch
    )
    expect(result).toMatchObject({ ok: false, reason: "auth" })
  })

  it("reports missing credentials distinctly (google + caldav)", async () => {
    // A google source whose sealed envelope carries no refresh token.
    const emptyEnvelope = await encryptCredentials({
      clientId: "client-id-1",
    })
    await addCalendarSource(executor, {
      id: "src-empty",
      accountId: null,
      provider: "google",
      name: "me@gmail.com",
      configJson: emptyEnvelope,
    })
    // A caldav source whose envelope cannot be decrypted (task 5.2 routes
    // caldav sources to their own tester; an undecryptable envelope is a
    // missing-credentials failure, never a throw).
    await executor.execute(
      `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
       VALUES ('src-caldav', NULL, 'caldav', 'Fastmail', 'sealed')`
    )

    const missing = await testCalendarConnection(executor, "src-missing")
    expect(missing).toMatchObject({ ok: false, reason: "no-credentials" })

    const empty = await testCalendarConnection(executor, "src-empty")
    expect(empty).toMatchObject({ ok: false, reason: "no-credentials" })

    const caldav = await testCalendarConnection(executor, "src-caldav")
    expect(caldav).toMatchObject({
      ok: false,
      provider: "caldav",
      reason: "no-credentials",
    })
  })

  it("reports an api failure with the HTTP status for non-auth endpoint errors", async () => {
    const configJson = await encryptCredentials({
      refreshToken: "1//0rt",
      clientId: "client-id-1",
    })
    await addCalendarSource(executor, {
      id: "src-1",
      accountId: null,
      provider: "google",
      name: "me@gmail.com",
      configJson,
    })

    const fetchDouble = createFetchDouble([
      { pattern: TOKEN_URL, payload: { access_token: "ya29.t", expires_in: 3600 } },
      { pattern: CALENDAR_LIST_URL, status: 500, payload: { error: {} } },
    ])

    const result = await testCalendarConnection(
      executor,
      "src-1",
      fetchDouble.fetch
    )
    expect(result).toMatchObject({
      ok: false,
      reason: "api",
      detail: "Google Calendar responded with status 500",
    })
  })
})
