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
  addGmailAccount,
} from "../add-gmail"
import type { OauthCallback } from "../oauth-pkce"

vi.mock("@tauri-apps/api/core")
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }))
vi.mock("../../sync/scheduler", () => ({
  triggerRefresh: vi.fn().mockResolvedValue({ synced: [], errors: [] }),
}))

const invokeMock = vi.mocked(invoke)
const openUrlMock = vi.mocked(openUrl)
const triggerRefreshMock = vi.mocked(triggerRefresh)

const TOKEN_URL = "https://oauth2.googleapis.com/token"
const GMAIL_PROFILE_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/profile"

// ---------------------------------------------------------------------------
// Minimal fetch double: URL-substring router returning plain response
// shapes (the code only uses ok/status/text()/json()) and recording calls.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  url: string
  method?: string
  body?: string
}

interface MockRoute {
  pattern: string
  status: number
  payload: unknown
}

interface FetchDouble {
  fetch: typeof fetch
  calls: RecordedRequest[]
}

function createFetchDouble(routes: MockRoute[]): FetchDouble {
  const calls: RecordedRequest[] = []
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method, body: init?.body as string })
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

// ---------------------------------------------------------------------------
// invoke double: start_oauth_server resolves once the (mocked) browser has
// been opened, echoing the state from the consent URL back.
// ---------------------------------------------------------------------------

function routeInvoke(options?: {
  serverError?: Error
  callback?: (state: string | null) => OauthCallback
}): void {
  invokeMock.mockImplementation(((command: string) => {
    if (command !== "start_oauth_server") {
      return Promise.reject(new Error(`unexpected command: ${command}`))
    }
    if (options?.serverError) {
      return Promise.reject(options.serverError)
    }
    return new Promise<OauthCallback>((resolve) => {
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
                  code: "4/0auth-code",
                  state: url.searchParams.get("state"),
                  error: null,
                  errorDescription: null,
                }
          )
        })
    })
  }) as typeof invoke)
}

/** The caught error of a promise, or null when it resolved. */
async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (thrown: unknown) => thrown
  )
}

/** Independent S256 reference (platform WebCrypto) for PKCE assertions. */
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

describe("addGmailAccount", () => {
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

  it("runs consent → exchange → profile → insert with offline consent params and a matching PKCE pair", async () => {
    routeInvoke()
    const double = createFetchDouble([
      {
        pattern: TOKEN_URL,
        status: 200,
        payload: {
          access_token: "ya29.access",
          refresh_token: "1//0refresh",
          expires_in: 3600,
          scope: "https://mail.google.com/ email",
        },
      },
      {
        pattern: GMAIL_PROFILE_URL,
        status: 200,
        payload: { emailAddress: "me@gmail.com", historyId: "77" },
      },
    ])

    const result = await addGmailAccount({
      clientId: "client-id-1",
      fetchImpl: double.fetch,
      executor,
    })

    // Consent URL: full-mailbox scope, forced offline consent, S256 PKCE.
    const authUrl = new URL(openUrlMock.mock.calls[0][0] as string)
    expect(authUrl.searchParams.get("client_id")).toBe("client-id-1")
    expect(authUrl.searchParams.get("redirect_uri")).toBe(
      "http://127.0.0.1:17248"
    )
    expect(authUrl.searchParams.get("scope")).toBe(
      "https://mail.google.com/ email"
    )
    expect(authUrl.searchParams.get("access_type")).toBe("offline")
    expect(authUrl.searchParams.get("prompt")).toBe("consent")
    const authChallenge = authUrl.searchParams.get("code_challenge")
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256")

    // Exchange: code_verifier hashes (S256) to the consent's challenge.
    const tokenCall = double.calls.find((call) => call.url.includes(TOKEN_URL))
    expect(tokenCall?.method).toBe("POST")
    const tokenBody = new URLSearchParams(tokenCall?.body)
    expect(tokenBody.get("grant_type")).toBe("authorization_code")
    expect(tokenBody.get("code")).toBe("4/0auth-code")
    expect(tokenBody.get("client_id")).toBe("client-id-1")
    expect(tokenBody.get("redirect_uri")).toBe("http://127.0.0.1:17248")
    const verifier = tokenBody.get("code_verifier") ?? ""
    expect(await sha256Base64Url(verifier)).toBe(authChallenge)

    // Profile read carried the fresh access token.
    const profileCall = double.calls.find((call) =>
      call.url.includes(GMAIL_PROFILE_URL)
    )
    expect(profileCall).toBeDefined()

    // The account row carries the Gmail identity and OAuth columns.
    const row = await getAccount(executor, result.accountId)
    expect(result.email).toBe("me@gmail.com")
    expect(row?.type).toBe("gmail")
    expect(row?.email).toBe("me@gmail.com")
    expect(row?.oauth_client_id).toBe("client-id-1")
    expect(row?.oauth_scope).toBe("https://mail.google.com/ email")
    // No history cursor preseeded — the first sync must be a full sync.
    expect(row?.gmail_history_id).toBeNull()

    // The persisted envelope is the encrypted GmailTokenEnvelope.
    const envelope = await decryptCredentials<{
      refreshToken: string
      accessToken?: string
      accessTokenExpiresAt?: number
    }>(row?.credentials_json ?? null)
    expect(envelope?.refreshToken).toBe("1//0refresh")
    expect(envelope?.accessToken).toBe("ya29.access")
    expect(row?.credentials_json).not.toContain("1//0refresh")

    // Switcher reloaded; the initial sync started for the new account.
    expect(
      useAccountStore.getState().accounts.map((account) => account.email)
    ).toContain("me@gmail.com")
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
      addGmailAccount({ clientId: "client-id-1", fetchImpl: double.fetch })
    )

    expect(error).toBeInstanceOf(ConsentDeniedError)
    expect((error as ConsentDeniedError).googleError).toBe("access_denied")
    // Nothing was exchanged, nothing was saved, nothing scheduled.
    expect(double.calls).toHaveLength(0)
    expect(await listAccounts(executor)).toHaveLength(0)
    expect(triggerRefreshMock).not.toHaveBeenCalled()
  })

  it("surfaces a local cancel as OauthCancelledError with nothing saved", async () => {
    routeInvoke({ serverError: new Error("OAuth sign-in was cancelled") })
    const double = createFetchDouble([])

    const error = await errorOf(
      addGmailAccount({ clientId: "client-id-1", fetchImpl: double.fetch })
    )

    expect(error).toBeInstanceOf(OauthCancelledError)
    expect(await listAccounts(executor)).toHaveLength(0)
  })

  it("maps invalid_client at the exchange to InvalidClientIdError and saves nothing", async () => {
    routeInvoke()
    const double = createFetchDouble([
      {
        pattern: TOKEN_URL,
        status: 400,
        payload: { error: "invalid_client" },
      },
    ])

    const error = await errorOf(
      addGmailAccount({ clientId: "bad-client-id", fetchImpl: double.fetch })
    )

    expect(error).toBeInstanceOf(InvalidClientIdError)
    expect(await listAccounts(executor)).toHaveLength(0)
    expect(triggerRefreshMock).not.toHaveBeenCalled()
  })

  it("maps other exchange and profile failures to NetworkError", async () => {
    routeInvoke()
    const exchangeFail = createFetchDouble([
      {
        pattern: TOKEN_URL,
        status: 500,
        payload: { error: "backend_error" },
      },
    ])
    const error = await errorOf(
      addGmailAccount({
        clientId: "client-id-1",
        fetchImpl: exchangeFail.fetch,
      })
    )
    expect(error).toBeInstanceOf(NetworkError)
    expect(await listAccounts(executor)).toHaveLength(0)

    // A profile read failure is the same taxonomy and saves nothing.
    routeInvoke()
    const profileFail = createFetchDouble([
      {
        pattern: TOKEN_URL,
        status: 200,
        payload: {
          access_token: "ya29.access",
          refresh_token: "1//0refresh",
          expires_in: 3600,
          scope: "s",
        },
      },
      { pattern: GMAIL_PROFILE_URL, status: 403, payload: {} },
    ])
    const profileError = await errorOf(
      addGmailAccount({
        clientId: "client-id-1",
        fetchImpl: profileFail.fetch,
      })
    )
    expect(profileError).toBeInstanceOf(NetworkError)
    expect(await listAccounts(executor)).toHaveLength(0)
    expect(triggerRefreshMock).not.toHaveBeenCalled()
  })
})
