import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { openUrl } from "@tauri-apps/plugin-opener"

import { decryptCredentials } from "../../crypto/credentials"
import { setDefaultKeyStore } from "../../crypto/key-management"
import { createInMemoryKeyStore } from "../../crypto/__tests__/in-memory-key-store"
import { getAccount, listAccounts } from "../../db/accounts"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "../../../stores/account-store"
import { triggerRefresh } from "../../sync/scheduler"
import {
  ConsentDeniedError,
  InvalidClientIdError,
  NetworkError,
  OauthCancelledError,
} from "../add-gmail"
import {
  addMicrosoftAccount,
  fetchMicrosoftProfile,
} from "../add-microsoft"
import { reauthMicrosoftAccount } from "../reauth"
import { AccountTypeError } from "../reauth"
import { MicrosoftMailScopeNotGrantedError } from "../microsoft-oauth"

vi.mock("@tauri-apps/api/core")
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }))
vi.mock("../../sync/scheduler", () => ({
  triggerRefresh: vi.fn().mockResolvedValue({ synced: [], errors: [] }),
}))

const invokeMock = vi.mocked(invoke)
const openUrlMock = vi.mocked(openUrl)
const triggerRefreshMock = vi.mocked(triggerRefresh)

const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
const GRAPH_ME_URL = "https://graph.microsoft.com/v1.0/me"

// ---------------------------------------------------------------------------
// Fetch double + loopback echo (the add-gmail.test.ts harness, retargeted)
// ---------------------------------------------------------------------------

interface RecordedRequest {
  url: string
  method?: string
  body?: string
  headers?: Record<string, string>
}

interface MockRoute {
  pattern: string
  status: number
  payload: unknown
  headers?: Record<string, string>
}

function createFetchDouble(routes: MockRoute[]): {
  fetch: typeof fetch
  calls: RecordedRequest[]
} {
  const calls: RecordedRequest[] = []
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const headers: Record<string, string> = {}
    if (init?.headers) Object.assign(headers, init.headers)
    calls.push({ url, method: init?.method, body: init?.body as string, headers })
    const route = routes.find((candidate) => url.includes(candidate.pattern))
    if (!route) {
      throw new Error(`unexpected fetch: ${url}`)
    }
    const text = JSON.stringify(route.payload)
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      text: async () => text,
      json: async () => route.payload,
    }
  }) as typeof fetch
  return { fetch: stub, calls }
}

function routeInvoke(options?: {
  serverError?: Error
  callback?: (state: string | null) => {
    port: number
    code: string | null
    state: string | null
    error: string | null
    errorDescription: string | null
  }
}): void {
  invokeMock.mockImplementation(((command: string) => {
    if (command === "find_free_loopback_port") {
      return Promise.resolve(17248)
    }
    if (command !== "start_oauth_server") {
      return Promise.reject(new Error(`unexpected command: ${command}`))
    }
    if (options?.serverError) {
      return Promise.reject(options.serverError)
    }
    return new Promise<{
      port: number
      code: string | null
      state: string | null
      error: string | null
      errorDescription: string | null
    }>((resolve) => {
      void vi
        .waitFor(() => {
          expect(openUrlMock).toHaveBeenCalledTimes(1)
        })
        .then(() => {
          const url = new URL(openUrlMock.mock.calls[0][0] as string)
          resolve(
            options?.callback
              ? options.callback(url.searchParams.get("state"))
              : {
                  port: 17248,
                  code: "M.0auth-code",
                  state: url.searchParams.get("state"),
                  error: null,
                  errorDescription: null,
                }
          )
        })
    })
  }) as typeof invoke)
}

async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (thrown: unknown) => thrown
  )
}

async function sha256Base64Url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input)
  )
  let binary = ""
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

const TOKEN_OK = {
  access_token: "ms-at",
  refresh_token: "ms-rt",
  expires_in: 3600,
  scope: "Mail.ReadWrite Mail.Send User.Read offline_access",
}

describe("addMicrosoftAccount", () => {
  let executor: TestExecutor

  beforeEach(() => {
    invokeMock.mockReset()
    openUrlMock.mockReset()
    triggerRefreshMock.mockClear()
    executor = createTestExecutor()
    setAccountStoreExecutor(executor)
    setDefaultKeyStore(createInMemoryKeyStore())
    useAccountStore.setState({
      accounts: [],
      activeAccountId: null,
      loaded: false,
    })
  })

  afterAll(() => {
    setAccountStoreExecutor(null)
    setDefaultKeyStore(null)
  })

  it("runs consent → exchange → profile → insert with the Entra params and a matching PKCE pair", async () => {
    routeInvoke()
    const double = createFetchDouble([
      { pattern: TOKEN_URL, status: 200, payload: TOKEN_OK },
      {
        pattern: GRAPH_ME_URL,
        status: 200,
        payload: {
          displayName: "Mira Example",
          mail: "me@outlook.com",
          userPrincipalName: "me@outlook.com",
        },
      },
    ])

    const result = await addMicrosoftAccount({
      clientId: "ms-client-1",
      fetchImpl: double.fetch,
      executor,
    })

    // Consent URL: common authority, mail grant incl. offline_access,
    // forced account picker, query response mode, S256 PKCE.
    const authUrl = new URL(openUrlMock.mock.calls[0][0] as string)
    expect(authUrl.origin + authUrl.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"
    )
    expect(authUrl.searchParams.get("scope")?.split(" ")).toContain(
      "offline_access"
    )
    expect(authUrl.searchParams.get("prompt")).toBe("select_account")
    expect(authUrl.searchParams.get("response_mode")).toBe("query")
    const authChallenge = authUrl.searchParams.get("code_challenge")

    // Exchange: the verifier hashes to the challenge; no secret.
    const tokenCall = double.calls.find((call) => call.url.includes(TOKEN_URL))
    const tokenBody = new URLSearchParams(tokenCall?.body)
    expect(tokenBody.get("grant_type")).toBe("authorization_code")
    expect(tokenBody.get("client_id")).toBe("ms-client-1")
    expect(tokenBody.get("client_secret")).toBeNull()
    expect(await sha256Base64Url(tokenBody.get("code_verifier") ?? "")).toBe(
      authChallenge
    )

    // Profile read carried the fresh access token.
    const profileCall = double.calls.find((call) => call.url === GRAPH_ME_URL)
    expect(profileCall?.headers?.Authorization).toBe("Bearer ms-at")

    // The account row carries the Microsoft identity and OAuth columns.
    const row = await getAccount(executor, result.accountId)
    expect(result.email).toBe("me@outlook.com")
    expect(row?.type).toBe("microsoft")
    expect(row?.email).toBe("me@outlook.com")
    expect(row?.display_name).toBe("Mira Example")
    expect(row?.oauth_client_id).toBe("ms-client-1")
    expect(row?.oauth_scope).toContain("offline_access")
    // No delta cursor preseeded — the first sync is a full per-folder pull.
    expect(row?.gmail_history_id).toBeNull()

    // The persisted envelope is sealed; tokens never appear in plaintext.
    const envelope = await decryptCredentials<{
      refreshToken: string
      accessToken?: string
    }>(row?.credentials_json ?? null)
    expect(envelope?.refreshToken).toBe("ms-rt")
    expect(row?.credentials_json).not.toContain("ms-rt")
    expect(row?.credentials_json).not.toContain("ms-at")

    // Switcher reloaded; the initial sync started for the new account.
    expect(
      useAccountStore.getState().accounts.map((account) => account.email)
    ).toContain("me@outlook.com")
    expect(triggerRefreshMock).toHaveBeenCalledWith(result.accountId)
  })

  it("creates no account when the user denies consent, and stays retryable", async () => {
    routeInvoke({
      callback: (state) => ({
        port: 17248,
        code: null,
        state,
        error: "access_denied",
        errorDescription: "nope",
      }),
    })
    const double = createFetchDouble([])

    const error = await errorOf(
      addMicrosoftAccount({ clientId: "ms-client-1", fetchImpl: double.fetch })
    )

    expect(error).toBeInstanceOf(ConsentDeniedError)
    expect((error as ConsentDeniedError).providerError).toBe("access_denied")
    expect(double.calls).toHaveLength(0)
    expect(await listAccounts(executor)).toHaveLength(0)
    expect(triggerRefreshMock).not.toHaveBeenCalled()
  })

  it("surfaces a local cancel as OauthCancelledError with nothing saved", async () => {
    routeInvoke({ serverError: new Error("OAuth sign-in was cancelled") })
    const double = createFetchDouble([])

    const error = await errorOf(
      addMicrosoftAccount({ clientId: "ms-client-1", fetchImpl: double.fetch })
    )
    expect(error).toBeInstanceOf(OauthCancelledError)
    expect(await listAccounts(executor)).toHaveLength(0)
  })

  it("maps invalid_client at the exchange to InvalidClientIdError and saves nothing", async () => {
    routeInvoke()
    const double = createFetchDouble([
      { pattern: TOKEN_URL, status: 400, payload: { error: "invalid_client" } },
    ])

    const error = await errorOf(
      addMicrosoftAccount({ clientId: "bad", fetchImpl: double.fetch })
    )
    expect(error).toBeInstanceOf(InvalidClientIdError)
    expect(await listAccounts(executor)).toHaveLength(0)
  })

  it("fails with the typed scope error and persists nothing when mail scopes are denied", async () => {
    routeInvoke()
    // A work/school tenant granted only the profile + offline scopes.
    const double = createFetchDouble([
      {
        pattern: TOKEN_URL,
        status: 200,
        payload: {
          access_token: "ms-at",
          refresh_token: "ms-rt",
          expires_in: 3600,
          scope: "User.Read offline_access",
        },
      },
    ])

    const error = await errorOf(
      addMicrosoftAccount({ clientId: "ms-client-1", fetchImpl: double.fetch })
    )
    expect(error).toBeInstanceOf(MicrosoftMailScopeNotGrantedError)
    // The error carries the MISSING scope names, never token material.
    expect((error as MicrosoftMailScopeNotGrantedError).missingScopes).toEqual([
      "Mail.ReadWrite",
      "Mail.Send",
    ])
    expect((error as Error).message).toContain("Mail.ReadWrite")
    expect((error as Error).message).toContain("Mail.Send")
    expect((error as Error).message).not.toContain("ms-at")
    expect((error as Error).message).not.toContain("ms-rt")
    // No profile read, no account row, no sync.
    expect(
      double.calls.some((call) => call.url.includes(GRAPH_ME_URL))
    ).toBe(false)
    expect(await listAccounts(executor)).toHaveLength(0)
    expect(triggerRefreshMock).not.toHaveBeenCalled()
  })

  it("treats a missing refresh token (offline_access not granted) as a flow error", async () => {    routeInvoke()
    const double = createFetchDouble([
      {
        pattern: TOKEN_URL,
        status: 200,
        payload: { access_token: "ms-at", expires_in: 3600, scope: "Mail.Send" },
      },
    ])
    const error = await errorOf(
      addMicrosoftAccount({ clientId: "ms-client-1", fetchImpl: double.fetch })
    )
    expect(error).toBeInstanceOf(NetworkError)
    expect((error as Error).message).toContain("Microsoft")
    expect(await listAccounts(executor)).toHaveLength(0)
  })

  it("maps a profile failure to NetworkError with nothing saved", async () => {
    routeInvoke()
    const double = createFetchDouble([
      { pattern: TOKEN_URL, status: 200, payload: TOKEN_OK },
      { pattern: GRAPH_ME_URL, status: 403, payload: {} },
    ])
    const error = await errorOf(
      addMicrosoftAccount({ clientId: "ms-client-1", fetchImpl: double.fetch })
    )
    expect(error).toBeInstanceOf(NetworkError)
    expect(await listAccounts(executor)).toHaveLength(0)
  })

  it("fetchMicrosoftProfile falls back to the UPN and rejects without any address", async () => {
    expect(
      await fetchMicrosoftProfile("t", (async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({ userPrincipalName: "upn@tenant.com" }),
        }
      }) as unknown as typeof fetch)
    ).toEqual({ mail: "upn@tenant.com", displayName: undefined })

    const missing = await errorOf(
      fetchMicrosoftProfile("t", (async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
        }
      }) as unknown as typeof fetch)
    )
    expect(missing).toBeInstanceOf(NetworkError)
  })
})

describe("reauthMicrosoftAccount", () => {
  let executor: TestExecutor

  beforeEach(() => {
    invokeMock.mockReset()
    openUrlMock.mockReset()
    triggerRefreshMock.mockClear()
    executor = createTestExecutor()
    setAccountStoreExecutor(executor)
    setDefaultKeyStore(createInMemoryKeyStore())
    useAccountStore.setState({
      accounts: [],
      activeAccountId: null,
      loaded: false,
    })
  })

  afterAll(() => {
    setAccountStoreExecutor(null)
    setDefaultKeyStore(null)
  })

  async function seedMicrosoftAccount(): Promise<string> {
    const id = "acc-ms-reauth"
    await executor.execute(
      "INSERT INTO accounts (id, type, email, status, oauth_client_id, gmail_history_id) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, "microsoft", "me@outlook.com", "auth-error", "ms-client-1", '{"Inbox":"https://graph.microsoft.com/v1.0/link"}']
    )
    return id
  }

  it("rotates the sealed envelope, reactivates, and keeps the delta cursors", async () => {
    const accountId = await seedMicrosoftAccount()
    routeInvoke()
    const double = createFetchDouble([
      { pattern: TOKEN_URL, status: 200, payload: TOKEN_OK },
    ])

    // Re-auth pins the account's own address in the consent URL.
    const result = await reauthMicrosoftAccount(accountId, {
      clientId: "ms-client-1",
      fetchImpl: double.fetch,
      executor,
    })
    expect(result.email).toBe("me@outlook.com")

    const authUrl = new URL(openUrlMock.mock.calls[0][0] as string)
    expect(authUrl.searchParams.get("login_hint")).toBe("me@outlook.com")
    expect(authUrl.searchParams.get("prompt")).toBeNull()

    const row = await getAccount(executor, accountId)
    expect(row?.status).toBe("active")
    expect(row?.gmail_history_id).toBe('{"Inbox":"https://graph.microsoft.com/v1.0/link"}')
    const envelope = await decryptCredentials<{ refreshToken: string }>(
      row?.credentials_json ?? null
    )
    expect(envelope?.refreshToken).toBe("ms-rt")
    expect(triggerRefreshMock).toHaveBeenCalledWith(accountId)
    // No second account was created.
    expect(await listAccounts(executor)).toHaveLength(1)
  })

  it("rejects a non-microsoft target with AccountTypeError", async () => {
    const id = "acc-imap-x"
    await executor.execute(
      "INSERT INTO accounts (id, type, email, status) VALUES ($1, $2, $3, $4)",
      [id, "imap", "me@fastmail.com", "auth-error"]
    )
    const error = await errorOf(
      reauthMicrosoftAccount(id, {
        clientId: "ms-client-1",
        executor,
      })
    )
    expect(error).toBeInstanceOf(AccountTypeError)
  })

  it("rejects re-auth when the granted scope lacks the mail scopes, changing nothing", async () => {
    const accountId = await seedMicrosoftAccount()
    routeInvoke()
    const double = createFetchDouble([
      {
        pattern: TOKEN_URL,
        status: 200,
        payload: {
          access_token: "ms-at",
          refresh_token: "ms-rt",
          expires_in: 3600,
          scope: "offline_access",
        },
      },
    ])

    const error = await errorOf(
      reauthMicrosoftAccount(accountId, {
        clientId: "ms-client-1",
        fetchImpl: double.fetch,
        executor,
      })
    )
    expect(error).toBeInstanceOf(MicrosoftMailScopeNotGrantedError)
    expect((error as MicrosoftMailScopeNotGrantedError).missingScopes).toEqual([
      "Mail.ReadWrite",
      "Mail.Send",
    ])
    // The account stays paused and nothing was rotated or persisted.
    const row = await getAccount(executor, accountId)
    expect(row?.status).toBe("auth-error")
    expect(row?.credentials_json).toBeNull()
    expect(triggerRefreshMock).not.toHaveBeenCalled()
  })
})
