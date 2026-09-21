import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { openUrl } from "@tauri-apps/plugin-opener"

import {
  MICROSOFT_CALENDAR_CONNECT_SCOPES,
  MicrosoftCalendarConnectCancelledError,
  MicrosoftCalendarConnectError,
  MicrosoftCalendarConsentDeniedError,
  MicrosoftCalendarScopeNotGrantedError,
  connectMicrosoftCalendar,
  testMicrosoftStoredConnection,
} from "../connect-microsoft"
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
import { clearMicrosoftTokenCache } from "../../email/microsoft-token-manager"
import {
  addCalendarSource,
  getCalendarSource,
  listCalendarSources,
} from "../sources"

/**
 * Microsoft calendar connect-flow tests (task 3.6). The flow drives the
 * REAL Entra consent loop (microsoft-oauth.ts) against mocked
 * invoke/openUrl and a fixture token + Graph endpoint set, asserting the
 * SEPARATE calendar scope set is requested and verified before anything is
 * sealed and stored — and that every failure persists nothing.
 */

vi.mock("@tauri-apps/api/core")
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }))

const invokeMock = vi.mocked(invoke)
const openUrlMock = vi.mocked(openUrl)

const TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token"
const CALENDAR_LIST_URL = "https://graph.microsoft.com/v1.0/me/calendars"

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
function routeInvoke(
  callback?: (state: string | null, url: URL) => OauthCallback
): void {
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
                  code: "0.cal-code",
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

async function createMicrosoftAccount(
  executor: TestExecutor
): Promise<string> {
  const accountId = await createAccount(executor, "microsoft")
  await executor.execute(
    "UPDATE accounts SET oauth_client_id = 'entra-client-1' WHERE id = $1",
    [accountId]
  )
  return accountId
}


describe("connectMicrosoftCalendar", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(() => {
    invokeMock.mockReset()
    openUrlMock.mockReset()
    executor = createTestExecutor()
    setDefaultKeyStore(createInMemoryKeyStore())
  })

  afterEach(() => {
    clearMicrosoftTokenCache()
    executor.close()
    setDefaultKeyStore(null)
  })

  it("runs a SEPARATE calendar-scope consent, verifies the grant, seals the tokens and stores the source", async () => {
    accountId = await createMicrosoftAccount(executor)
    routeInvoke()

    const fetchDouble = createFetchDouble([
      {
        pattern: TOKEN_URL,
        payload: {
          access_token: "0.calAT",
          refresh_token: "0.calRT",
          expires_in: 3600,
          scope: "Calendar.ReadWrite User.Read offline_access",
        },
      },
      {
        pattern: CALENDAR_LIST_URL,
        payload: {
          value: [
            { id: "cal-1", name: "Calendar", isDefaultCalendar: true },
            { id: "cal-2", name: "Team" },
          ],
        },
      },
    ])

    const result = await connectMicrosoftCalendar({
      accountId,
      executor,
      fetchImpl: fetchDouble.fetch,
    })

    // The consent URL requested the calendar scope set (NOT the mail
    // scopes), pinned the account, and kept the PKCE machinery intact.
    const authUrl = new URL(openUrlMock.mock.calls[0][0] as string)
    expect(authUrl.searchParams.get("scope")?.split(" ")).toEqual(
      MICROSOFT_CALENDAR_CONNECT_SCOPES
    )
    expect(authUrl.searchParams.get("login_hint")).toBe(
      `${accountId}@example.com`
    )
    // A login_hint means no forced account picker (the mail add flow's
    // behavior is unchanged in microsoft-oauth.ts).
    expect(authUrl.searchParams.get("prompt")).toBeNull()

    expect(result.accountId).toBe(accountId)
    expect(result.calendars.map((calendar) => calendar.id)).toEqual([
      "cal-1",
      "cal-2",
    ])

    const sources = await listCalendarSources(executor)
    expect(sources).toHaveLength(1)
    expect(sources[0]).toMatchObject({
      accountId,
      provider: "microsoft",
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
      refreshToken: "0.calRT",
      accessToken: "0.calAT",
      clientId: "entra-client-1",
    })

    // The mail account's own credentials were NEVER written — the sealed
    // envelope lives only on the source row (remove-source never touches
    // mail, spec scenario).
    const accountRows = await executor.select<{
      credentials_json: string | null
    }>("SELECT credentials_json FROM accounts WHERE id = $1", [accountId])
    expect(accountRows[0]?.credentials_json).toBeNull()
  })

  it("fails specifically and persists nothing when the calendar scope is not granted", async () => {
    accountId = await createMicrosoftAccount(executor)
    routeInvoke()
    const fetchDouble = createFetchDouble([
      {
        pattern: TOKEN_URL,
        payload: {
          access_token: "0.x",
          refresh_token: "0.xrt",
          expires_in: 3600,
          // No calendar scope in the grant (e.g. admin policy).
          scope: "User.Read offline_access",
        },
      },
    ])

    await expect(
      connectMicrosoftCalendar({
        accountId,
        executor,
        fetchImpl: fetchDouble.fetch,
      })
    ).rejects.toBeInstanceOf(MicrosoftCalendarScopeNotGrantedError)
    expect(await listCalendarSources(executor)).toEqual([])
  })

  it("maps a cancelled consent to the quiet cancellation error", async () => {
    accountId = await createMicrosoftAccount(executor)
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
      connectMicrosoftCalendar({
        accountId,
        executor,
        fetchImpl: createFetchDouble([]).fetch,
      })
    ).rejects.toBeInstanceOf(MicrosoftCalendarConnectCancelledError)
    expect(await listCalendarSources(executor)).toEqual([])
  })

  it("maps a consent denial to the typed denial error", async () => {
    accountId = await createMicrosoftAccount(executor)
    routeInvoke((_state, url) => ({
      port: 17248,
      code: null,
      state: url.searchParams.get("state"),
      error: "access_denied",
      errorDescription: "Consent was denied",
      scope: null,
    }))

    const error: unknown = await connectMicrosoftCalendar({
      accountId,
      executor,
      fetchImpl: createFetchDouble([]).fetch,
    }).then(
      () => null,
      (thrown: unknown) => thrown
    )
    expect(error).toBeInstanceOf(MicrosoftCalendarConsentDeniedError)
    expect(
      (error as MicrosoftCalendarConsentDeniedError).microsoftError
    ).toBe("access_denied")
    expect(await listCalendarSources(executor)).toEqual([])
  })

  it("refuses to connect from a non-Microsoft account", async () => {
    accountId = await createAccount(executor, "gmail")
    await executor.execute(
      "UPDATE accounts SET oauth_client_id = 'g-client' WHERE id = $1",
      [accountId]
    )

    await expect(
      connectMicrosoftCalendar({
        accountId,
        executor,
        fetchImpl: createFetchDouble([]).fetch,
      })
    ).rejects.toBeInstanceOf(MicrosoftCalendarConnectError)
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(await listCalendarSources(executor)).toEqual([])
  })
})

describe("testMicrosoftStoredConnection", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
    setDefaultKeyStore(createInMemoryKeyStore())
  })

  afterEach(() => {
    clearMicrosoftTokenCache()
    executor.close()
    setDefaultKeyStore(null)
  })

  it("reports success with the discovered calendars", async () => {
    const configJson = await encryptCredentials({
      refreshToken: "0.rt",
      clientId: "entra-client-1",
    })
    await addCalendarSource(executor, {
      id: "src-ms",
      accountId: null,
      provider: "microsoft",
      name: "me@outlook.com",
      configJson,
    })
    const mock = createFetchDouble([
      {
        pattern: TOKEN_URL,
        payload: { access_token: "0.at", expires_in: 3600 },
      },
      {
        pattern: CALENDAR_LIST_URL,
        payload: { value: [{ id: "cal-1", name: "Calendar" }] },
      },
    ])

    const source = await getCalendarSource(executor, "src-ms")
    if (!source) throw new Error("source src-ms not seeded")
    const result = await testMicrosoftStoredConnection(
      source,
      executor,
      mock.fetch
    )
    expect(result).toMatchObject({
      ok: true,
      provider: "microsoft",
      calendars: [{ id: "cal-1" }],
    })
  })

  it("reports a specific auth failure when the grant is dead", async () => {
    const configJson = await encryptCredentials({
      refreshToken: "0.dead",
      clientId: "entra-client-1",
    })
    await addCalendarSource(executor, {
      id: "src-ms",
      accountId: null,
      provider: "microsoft",
      name: "me@outlook.com",
      configJson,
    })
    const mock = createFetchDouble([
      {
        pattern: TOKEN_URL,
        status: 400,
        payload: { error: "invalid_grant" },
      },
    ])

    const source = await getCalendarSource(executor, "src-ms")
    if (!source) throw new Error("source src-ms not seeded")
    const result = await testMicrosoftStoredConnection(
      source,
      executor,
      mock.fetch
    )
    expect(result).toMatchObject({
      ok: false,
      provider: "microsoft",
      reason: "auth",
    })
  })

  it("reports missing credentials for an unsealable envelope", async () => {
    await executor.execute(
      `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
       VALUES ('src-ms', NULL, 'microsoft', 'me@outlook.com', 'sealed')`
    )
    const source = await getCalendarSource(executor, "src-ms")
    if (!source) throw new Error("source src-ms not seeded")
    const result = await testMicrosoftStoredConnection(
      source,
      executor,
      createFetchDouble([]).fetch
    )
    expect(result).toMatchObject({
      ok: false,
      provider: "microsoft",
      reason: "no-credentials",
    })
  })
})
