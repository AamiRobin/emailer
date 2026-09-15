import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"

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
  ImapTestFailedError,
  MissingSettingsError,
  SmtpTestFailedError,
  addImapAccount,
  testImapSettings,
  testSmtpSettings,
} from "../add-imap"

vi.mock("@tauri-apps/api/core")
vi.mock("../../sync/scheduler", () => ({
  triggerRefresh: vi.fn().mockResolvedValue({ synced: [], errors: [] }),
}))

const invokeMock = vi.mocked(invoke)
const triggerRefreshMock = vi.mocked(triggerRefresh)

const yahooConfig = {
  imapHost: "imap.mail.yahoo.com",
  imapPort: 993,
  imapSecurity: "tls" as const,
  smtpHost: "smtp.mail.yahoo.com",
  smtpPort: 465,
  smtpSecurity: "tls" as const,
}

function imapSuccess() {
  return {
    host: "imap.mail.yahoo.com",
    port: 993,
    security: "tls",
    capabilities: ["IMAP4rev1"],
    folderCount: 4,
  }
}

function smtpSuccess() {
  return {
    host: "smtp.mail.yahoo.com",
    port: 465,
    security: "tls",
    authenticated: true,
    server: "smtp.mail.yahoo.com",
    capabilities: ["PIPELINING"],
  }
}

/** Command router over the mocked Tauri invoke. Handlers that throw are
 * turned into rejected promises (mirroring the real invoke contract). */
function routeInvoke(routes: {
  imap?: (params: unknown) => unknown
  smtp?: (params: unknown) => unknown
}): void {
  invokeMock.mockImplementation(((command: string, args?: unknown) => {
    const params = (args as { params?: unknown } | undefined)?.params
    if (command === "imap_test_connection") {
      const handler = routes.imap
      if (!handler)
        return Promise.reject(new Error("unexpected imap_test_connection"))
      return Promise.resolve().then(() => handler(params))
    }
    if (command === "smtp_test_connection") {
      const handler = routes.smtp
      if (!handler)
        return Promise.reject(new Error("unexpected smtp_test_connection"))
      return Promise.resolve().then(() => handler(params))
    }
    return Promise.reject(new Error(`unexpected command: ${command}`))
  }) as typeof invoke)
}

describe("addImapAccount", () => {
  let executor: TestExecutor

  beforeEach(() => {
    invokeMock.mockReset()
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

  it("tests IMAP then SMTP, saves the account with encrypted credentials, reloads and triggers the initial sync", async () => {
    const seen: { imap?: unknown; smtp?: unknown } = {}
    routeInvoke({
      imap: (params) => {
        seen.imap = params
        return imapSuccess()
      },
      smtp: (params) => {
        seen.smtp = params
        return smtpSuccess()
      },
    })

    const result = await addImapAccount({
      email: "user@yahoo.com",
      password: "app-password-1",
      config: yahooConfig,
      executor,
    })

    // Both sides were tested with the email as username.
    expect(seen.imap).toMatchObject({
      host: "imap.mail.yahoo.com",
      port: 993,
      security: "tls",
      username: "user@yahoo.com",
      password: "app-password-1",
      acceptInvalidCerts: false,
    })
    expect(seen.smtp).toMatchObject({
      host: "smtp.mail.yahoo.com",
      port: 465,
      security: "tls",
      username: "user@yahoo.com",
      password: "app-password-1",
    })

    // The row landed with the server columns set.
    const row = await getAccount(executor, result.accountId)
    expect(row?.type).toBe("imap")
    expect(row?.email).toBe("user@yahoo.com")
    expect(row?.imap_host).toBe("imap.mail.yahoo.com")
    expect(row?.imap_port).toBe(993)
    expect(row?.imap_security).toBe("tls")
    expect(row?.smtp_host).toBe("smtp.mail.yahoo.com")
    expect(row?.smtp_port).toBe(465)
    expect(row?.status).toBe("active")

    // Credentials are stored encrypted — round-trip via the envelope.
    const envelope = await decryptCredentials<{ password: string }>(
      row?.credentials_json ?? null
    )
    expect(envelope).toEqual({ password: "app-password-1" })
    expect(row?.credentials_json).not.toContain("app-password-1")

    // Store reloaded (switcher sees the account) + initial sync started.
    expect(
      useAccountStore.getState().accounts.map((account) => account.email)
    ).toContain("user@yahoo.com")
    expect(triggerRefreshMock).toHaveBeenCalledWith(result.accountId)
  })

  it("discovers settings for a known domain when no config is given", async () => {
    let imapParams: Record<string, unknown> | undefined
    routeInvoke({
      imap: (params) => {
        imapParams = params as Record<string, unknown>
        return imapSuccess()
      },
      smtp: () => smtpSuccess(),
    })

    await addImapAccount({
      email: "user@yahoo.co.uk",
      password: "pw",
      executor,
    })

    expect(imapParams).toMatchObject({
      host: "imap.mail.yahoo.com",
      port: 993,
      security: "tls",
      username: "user@yahoo.co.uk",
    })
  })

  it("throws MissingSettingsError without touching the network for an unknown domain and no config", async () => {
    routeInvoke({})
    await expect(
      addImapAccount({
        email: "user@unknown-provider.example",
        password: "pw",
      })
    ).rejects.toBeInstanceOf(MissingSettingsError)
    expect(invokeMock).not.toHaveBeenCalled()
    expect(await listAccounts(executor)).toHaveLength(0)
  })

  it("does NOT save when the IMAP test fails, and never reaches SMTP", async () => {
    routeInvoke({
      imap: () => {
        throw new Error("connection refused by imap.mail.yahoo.com:993")
      },
      smtp: () => smtpSuccess(),
    })

    const error = await addImapAccount({
      email: "user@yahoo.com",
      password: "pw",
      config: yahooConfig,
    }).then(
      () => null,
      (thrown: unknown) => thrown
    )

    expect(error).toBeInstanceOf(ImapTestFailedError)
    expect((error as Error).message).toContain("connection refused")

    expect(await listAccounts(executor)).toHaveLength(0)
    expect(triggerRefreshMock).not.toHaveBeenCalled()
    expect(
      invokeMock.mock.calls.filter(
        ([command]) => command === "smtp_test_connection"
      )
    ).toHaveLength(0)
  })

  it("does NOT save when the SMTP test fails (IMAP already passed)", async () => {
    routeInvoke({
      imap: () => imapSuccess(),
      smtp: () => {
        throw new Error("535 authentication credentials invalid")
      },
    })

    const error = await addImapAccount({
      email: "user@yahoo.com",
      password: "pw",
      config: yahooConfig,
    }).then(
      () => null,
      (thrown: unknown) => thrown
    )

    expect(error).toBeInstanceOf(SmtpTestFailedError)
    expect((error as Error).message).toContain("535")

    expect(await listAccounts(executor)).toHaveLength(0)
    expect(triggerRefreshMock).not.toHaveBeenCalled()
  })

  it("exposes per-side test helpers for the UI's Test buttons", async () => {
    routeInvoke({
      imap: () => imapSuccess(),
      smtp: () => smtpSuccess(),
    })
    const config = { email: "user@yahoo.com", ...yahooConfig }

    const imap = await testImapSettings(config, "pw")
    expect(imap.folderCount).toBe(4)
    const smtp = await testSmtpSettings(config, "pw")
    expect(smtp.authenticated).toBe(true)
  })
})
