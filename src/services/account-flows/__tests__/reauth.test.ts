import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { openUrl } from "@tauri-apps/plugin-opener"

import { createInMemoryKeyStore } from "../../crypto/__tests__/in-memory-key-store"
import {
  decryptCredentials,
  encryptCredentials,
} from "../../crypto/credentials"
import { setDefaultKeyStore } from "../../crypto/key-management"
import { getAccount, insertAccount, listAccounts } from "../../db/accounts"
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
} from "../add-gmail"
import { ImapTestFailedError, SmtpTestFailedError } from "../add-imap"
import {
  AccountNotFoundError,
  AccountTypeError,
  reauthGmailAccount,
  reauthImapPassword,
} from "../reauth"
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

// ---------------------------------------------------------------------------
// Fetch double: URL-substring router over plain response shapes.
// ---------------------------------------------------------------------------

function createFetchDouble(
  routes: { pattern: string; status: number; payload: unknown }[]
): typeof fetch {
  const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const route = routes.find((candidate) => url.includes(candidate.pattern))
    if (!route) {
      throw new Error(`unexpected fetch: ${url}`)
    }
    void init
    const text = JSON.stringify(route.payload)
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      text: async () => text,
      json: async () => route.payload,
    }
  }) as typeof fetch
  return stub
}

// ---------------------------------------------------------------------------
// invoke doubles for the consent round-trip and the connection tests.
// ---------------------------------------------------------------------------

function routeConsent(
  callback?: (state: string | null) => OauthCallback
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
              ? callback(url.searchParams.get("state"))
              : {
                  port: 17248,
                  code: "4/0reauth-code",
                  state: url.searchParams.get("state"),
                  error: null,
                  errorDescription: null,
                }
          )
        })
    })
  }) as typeof invoke)
}

interface ConnectionTestCall {
  command: string
  params: Record<string, unknown>
}

function routeConnectionTests(options?: {
  imapError?: Error
  smtpError?: Error
}): { calls: ConnectionTestCall[] } {
  const calls: ConnectionTestCall[] = []
  invokeMock.mockImplementation(((command: string, args?: unknown) => {
    const params = ((args as { params?: Record<string, unknown> })?.params ??
      {}) as Record<string, unknown>
    if (command === "imap_test_connection") {
      calls.push({ command, params })
      if (options?.imapError) return Promise.reject(options.imapError)
      return Promise.resolve({
        host: "imap.example.com",
        port: 993,
        security: "tls",
        capabilities: [],
        folderCount: 4,
      })
    }
    if (command === "smtp_test_connection") {
      calls.push({ command, params })
      if (options?.smtpError) return Promise.reject(options.smtpError)
      return Promise.resolve({
        host: "smtp.example.com",
        port: 465,
        security: "tls",
        authenticated: true,
        server: "smtp.example.com",
        capabilities: [],
      })
    }
    return Promise.reject(new Error(`unexpected command: ${command}`))
  }) as typeof invoke)
  return { calls }
}

/** The caught error of a promise, or null when it resolved. */
async function errorOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (thrown: unknown) => thrown
  )
}

// ---------------------------------------------------------------------------
// Seed helpers: rows are created active, then paused the way the
// scheduler would (status "auth-error").
// ---------------------------------------------------------------------------

async function seedGmailAccount(executor: TestExecutor): Promise<string> {
  const row = await insertAccount(executor, {
    type: "gmail",
    email: "me@gmail.com",
    credentialsJson: await encryptCredentials({ refreshToken: "1//0old" }),
    oauthScope: "https://mail.google.com/ email",
    oauthClientId: "client-id-1",
  })
  await updateStatusPaused(executor, row.id)
  return row.id
}

async function seedImapAccount(executor: TestExecutor): Promise<string> {
  const row = await insertAccount(executor, {
    type: "imap",
    email: "user@example.com",
    imapHost: "imap.example.com",
    imapPort: 993,
    imapSecurity: "tls",
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    smtpSecurity: "tls",
    credentialsJson: await encryptCredentials({ password: "old-pass" }),
  })
  await updateStatusPaused(executor, row.id)
  return row.id
}

async function updateStatusPaused(
  executor: TestExecutor,
  accountId: string
): Promise<void> {
  await executor.execute("UPDATE accounts SET status = $1 WHERE id = $2", [
    "auth-error",
    accountId,
  ])
}

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

let executor: TestExecutor

describe("reauthGmailAccount", () => {
  it("rotates the envelope and reactivates the SAME row — no second account, sync resumes", async () => {
    const accountId = await seedGmailAccount(executor)
    routeConsent()
    const fetchDouble = createFetchDouble([
      {
        pattern: TOKEN_URL,
        status: 200,
        payload: {
          access_token: "ya29.new",
          refresh_token: "1//0new",
          expires_in: 3600,
          scope: "https://mail.google.com/ email",
        },
      },
    ])

    const result = await reauthGmailAccount(accountId, {
      clientId: "client-id-1",
      fetchImpl: fetchDouble,
      executor,
    })

    expect(result).toEqual({ accountId, email: "me@gmail.com" })

    // Updated in place: exactly one row with the original id and email.
    const rows = await listAccounts(executor)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(accountId)
    expect(rows[0]?.email).toBe("me@gmail.com")
    expect(rows[0]?.status).toBe("active")
    // The stored Client ID is untouched (refresh needs it).
    expect(rows[0]?.oauth_client_id).toBe("client-id-1")

    // The envelope now carries the new refresh token — encrypted.
    const envelope = await decryptCredentials<{
      refreshToken: string
      accessToken?: string
    }>(rows[0]?.credentials_json ?? null)
    expect(envelope?.refreshToken).toBe("1//0new")
    expect(rows[0]?.credentials_json).not.toContain("1//0new")

    // Consent was pinned to this account's own address.
    const authUrl = new URL(openUrlMock.mock.calls[0][0] as string)
    expect(authUrl.searchParams.get("login_hint")).toBe("me@gmail.com")

    // The switcher shows the account active again; sync resumed.
    const storeAccount = useAccountStore
      .getState()
      .accounts.find((account) => account.id === accountId)
    expect(storeAccount?.status).toBe("active")
    expect(triggerRefreshMock).toHaveBeenCalledWith(accountId)
  })

  it("consent denial changes nothing and stays retryable", async () => {
    const accountId = await seedGmailAccount(executor)
    const before = await getAccount(executor, accountId)
    routeConsent((state) => ({
      port: 17248,
      code: null,
      state,
      error: "access_denied",
      errorDescription: "nope",
    }))

    const error = await errorOf(
      reauthGmailAccount(accountId, {
        clientId: "client-id-1",
        fetchImpl: createFetchDouble([]),
        executor,
      })
    )

    expect(error).toBeInstanceOf(ConsentDeniedError)
    const after = await getAccount(executor, accountId)
    expect(after?.status).toBe("auth-error")
    expect(after?.credentials_json).toBe(before?.credentials_json)
    expect(triggerRefreshMock).not.toHaveBeenCalled()
  })

  it("an invalid_client rejection at the exchange saves nothing", async () => {
    const accountId = await seedGmailAccount(executor)
    const before = await getAccount(executor, accountId)
    routeConsent()

    const error = await errorOf(
      reauthGmailAccount(accountId, {
        clientId: "bad-client-id",
        fetchImpl: createFetchDouble([
          {
            pattern: TOKEN_URL,
            status: 400,
            payload: { error: "invalid_client" },
          },
        ]),
        executor,
      })
    )

    expect(error).toBeInstanceOf(InvalidClientIdError)
    const after = await getAccount(executor, accountId)
    expect(after?.status).toBe("auth-error")
    expect(after?.credentials_json).toBe(before?.credentials_json)
    expect(triggerRefreshMock).not.toHaveBeenCalled()
  })

  it("rejects a missing or non-gmail target without touching anything", async () => {
    const imapId = await seedImapAccount(executor)

    const missing = await errorOf(
      reauthGmailAccount("no-such-account", {
        clientId: "client-id-1",
        fetchImpl: createFetchDouble([]),
        executor,
      })
    )
    expect(missing).toBeInstanceOf(AccountNotFoundError)

    const wrongType = await errorOf(
      reauthGmailAccount(imapId, {
        clientId: "client-id-1",
        fetchImpl: createFetchDouble([]),
        executor,
      })
    )
    expect(wrongType).toBeInstanceOf(AccountTypeError)
    expect(openUrlMock).not.toHaveBeenCalled()
  })
})

describe("reauthImapPassword", () => {
  it("tests BOTH connections against the stored settings before saving, then reactivates", async () => {
    const accountId = await seedImapAccount(executor)
    const { calls } = routeConnectionTests()

    const result = await reauthImapPassword(accountId, "new-pass", {
      executor,
    })

    expect(result).toEqual({ accountId, email: "user@example.com" })

    // IMAP was tested first, SMTP second, both with the NEW password and
    // the account's stored server settings.
    expect(calls.map((call) => call.command)).toEqual([
      "imap_test_connection",
      "smtp_test_connection",
    ])
    for (const call of calls) {
      expect(call.params).toMatchObject({
        host:
          call.command === "imap_test_connection"
            ? "imap.example.com"
            : "smtp.example.com",
        port: call.command === "imap_test_connection" ? 993 : 465,
        security: "tls",
        username: "user@example.com",
        password: "new-pass",
      })
    }

    const rows = await listAccounts(executor)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(accountId)
    expect(rows[0]?.status).toBe("active")
    const envelope = await decryptCredentials<{ password: string }>(
      rows[0]?.credentials_json ?? null
    )
    expect(envelope?.password).toBe("new-pass")
    expect(rows[0]?.credentials_json).not.toContain("new-pass")

    const storeAccount = useAccountStore
      .getState()
      .accounts.find((account) => account.id === accountId)
    expect(storeAccount?.status).toBe("active")
    expect(triggerRefreshMock).toHaveBeenCalledWith(accountId)
  })

  it("an IMAP test failure saves nothing and SMTP is never tried", async () => {
    const accountId = await seedImapAccount(executor)
    const before = await getAccount(executor, accountId)
    const { calls } = routeConnectionTests({
      imapError: new Error("LOGIN failed"),
    })

    const error = await errorOf(
      reauthImapPassword(accountId, "wrong", { executor })
    )

    expect(error).toBeInstanceOf(ImapTestFailedError)
    expect((error as ImapTestFailedError).message).toBe("LOGIN failed")
    expect(calls.map((call) => call.command)).toEqual(["imap_test_connection"])
    const after = await getAccount(executor, accountId)
    expect(after?.status).toBe("auth-error")
    expect(after?.credentials_json).toBe(before?.credentials_json)
    expect(triggerRefreshMock).not.toHaveBeenCalled()
  })

  it("an SMTP test failure saves nothing", async () => {
    const accountId = await seedImapAccount(executor)
    const before = await getAccount(executor, accountId)
    routeConnectionTests({ smtpError: new Error("auth rejected") })

    const error = await errorOf(
      reauthImapPassword(accountId, "wrong", { executor })
    )

    expect(error).toBeInstanceOf(SmtpTestFailedError)
    const after = await getAccount(executor, accountId)
    expect(after?.status).toBe("auth-error")
    expect(after?.credentials_json).toBe(before?.credentials_json)
    expect(triggerRefreshMock).not.toHaveBeenCalled()
  })

  it("rejects a missing target before running any connection test", async () => {
    routeConnectionTests()

    const error = await errorOf(
      reauthImapPassword("no-such-account", "new-pass", { executor })
    )

    expect(error).toBeInstanceOf(AccountNotFoundError)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("wraps environmental failures as NetworkError", async () => {
    const accountId = await seedImapAccount(executor)
    await executor.execute(
      "UPDATE accounts SET imap_host = NULL WHERE id = $1",
      [accountId]
    )

    const error = await errorOf(
      reauthImapPassword(accountId, "new-pass", { executor })
    )

    expect(error).toBeInstanceOf(NetworkError)
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
