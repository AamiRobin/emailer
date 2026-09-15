import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ProviderAuthError } from "../types"
import {
  clearGmailTokenCache,
  createTokenSource,
  exchangeCodeForTokens,
  getAccessToken,
  GMAIL_TOKEN_ENDPOINT,
} from "../token-manager"
import {
  createFetchMock,
  gmailAccount,
  mockTokenSuccess,
} from "./gmail-fixtures"

beforeEach(() => {
  clearGmailTokenCache()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("getAccessToken — silent refresh", () => {
  it("posts the refresh-token grant and caches the access token", async () => {
    const mock = createFetchMock()
    mockTokenSuccess(mock, "at-1", 3600)
    const account = gmailAccount()

    const token = await getAccessToken(
      account,
      { refreshToken: "rt-1" },
      mock.fetch
    )

    expect(token).toBe("at-1")
    const tokenCalls = mock.callsTo(GMAIL_TOKEN_ENDPOINT)
    expect(tokenCalls).toHaveLength(1)
    const body = new URLSearchParams(tokenCalls[0].body)
    expect(body.get("grant_type")).toBe("refresh_token")
    expect(body.get("client_id")).toBe("client-123")
    expect(body.get("refresh_token")).toBe("rt-1")
    expect(tokenCalls[0].headers["content-type"]).toBe(
      "application/x-www-form-urlencoded"
    )

    // Cached: the second call makes no HTTP request.
    await expect(
      getAccessToken(account, { refreshToken: "rt-1" }, mock.fetch)
    ).resolves.toBe("at-1")
    expect(mock.callsTo(GMAIL_TOKEN_ENDPOINT)).toHaveLength(1)
  })

  it("seeds from a still-valid envelope access token without any request", async () => {
    const mock = createFetchMock()
    const token = await getAccessToken(
      gmailAccount(),
      {
        refreshToken: "rt-1",
        accessToken: "seeded-at",
        accessTokenExpiresAt: Date.now() + 600_000,
      },
      mock.fetch
    )
    expect(token).toBe("seeded-at")
    expect(mock.calls).toHaveLength(0)
  })

  it("refreshes again once the cache expires inside the 60s margin", async () => {
    vi.useFakeTimers()
    const mock = createFetchMock()
    mock.on("POST", GMAIL_TOKEN_ENDPOINT, () => ({
      json: { access_token: "at-1", expires_in: 3600 },
    }))
    const account = gmailAccount()

    await expect(
      getAccessToken(account, { refreshToken: "rt-1" }, mock.fetch)
    ).resolves.toBe("at-1")

    // 3540s of validity remain (3600 - 60 margin) — still cached at 3500s.
    vi.setSystemTime(Date.now() + 3500_000)
    await expect(
      getAccessToken(account, { refreshToken: "rt-1" }, mock.fetch)
    ).resolves.toBe("at-1")
    expect(mock.calls).toHaveLength(1)

    // Past the margin — a new refresh happens.
    vi.setSystemTime(Date.now() + 3500_000 + 41_000)
    mock.on("POST", GMAIL_TOKEN_ENDPOINT, () => ({
      json: { access_token: "at-2", expires_in: 3600 },
    }))
    await expect(
      getAccessToken(account, { refreshToken: "rt-1" }, mock.fetch)
    ).resolves.toBe("at-2")
    expect(mock.calls).toHaveLength(2)
  })

  it("single-flights concurrent misses into one refresh", async () => {
    const mock = createFetchMock()
    let refreshCount = 0
    mock.on("POST", GMAIL_TOKEN_ENDPOINT, () => {
      refreshCount += 1
      return { json: { access_token: `at-${refreshCount}`, expires_in: 3600 } }
    })
    const account = gmailAccount()

    const tokens = await Promise.all([
      getAccessToken(account, { refreshToken: "rt-1" }, mock.fetch),
      getAccessToken(account, { refreshToken: "rt-1" }, mock.fetch),
      getAccessToken(account, { refreshToken: "rt-1" }, mock.fetch),
    ])

    expect(tokens).toEqual(["at-1", "at-1", "at-1"])
    expect(mock.calls).toHaveLength(1)
  })

  it("throws ProviderAuthError on invalid_grant without leaking tokens", async () => {
    const mock = createFetchMock()
    mock.on("POST", GMAIL_TOKEN_ENDPOINT, () => ({
      status: 400,
      json: {
        error: "invalid_grant",
        error_description: "Token has been expired or revoked.",
      },
    }))

    const error = await getAccessToken(
      gmailAccount(),
      { refreshToken: "rt-secret" },
      mock.fetch
    ).catch((caught) => caught)

    expect(error).toBeInstanceOf(ProviderAuthError)
    expect((error as ProviderAuthError).accountType).toBe("gmail")
    expect((error as ProviderAuthError).accountId).toBe("acc-g")
    expect((error as Error).message).toContain("invalid_grant")
    expect((error as Error).message).not.toContain("rt-secret")
    expect((error as Error).message).not.toContain("at-")
  })

  it("surfaces other 400s as plain errors", async () => {
    const mock = createFetchMock()
    mock.on("POST", GMAIL_TOKEN_ENDPOINT, () => ({
      status: 400,
      json: { error: "invalid_client" },
    }))

    const error = await getAccessToken(
      gmailAccount(),
      { refreshToken: "rt-1" },
      mock.fetch
    ).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(ProviderAuthError)
    expect((error as Error).message).toContain("invalid_client")
  })

  it("throws a clear error when the account has no client id", async () => {
    const mock = createFetchMock()
    await expect(
      getAccessToken(
        gmailAccount({ oauthClientId: undefined }),
        { refreshToken: "rt-1" },
        mock.fetch
      )
    ).rejects.toThrowError(/oauth_client_id/)
  })
})

describe("exchangeCodeForTokens (task 5.3 add-account seam)", () => {
  it("posts the authorization-code grant and returns parsed tokens", async () => {
    const mock = createFetchMock()
    mock.on("POST", GMAIL_TOKEN_ENDPOINT, () => ({
      json: {
        access_token: "at-new",
        expires_in: 3599,
        refresh_token: "rt-new",
        scope: "https://www.googleapis.com/auth/gmail.modify openid",
      },
    }))

    const tokens = await exchangeCodeForTokens(
      "client-123",
      "one-time-code",
      "verifier-abc",
      "http://127.0.0.1:17248/callback",
      mock.fetch
    )

    expect(tokens).toEqual({
      accessToken: "at-new",
      refreshToken: "rt-new",
      expiresIn: 3599,
      scope: "https://www.googleapis.com/auth/gmail.modify openid",
    })
    const body = new URLSearchParams(mock.calls[0].body)
    expect(body.get("grant_type")).toBe("authorization_code")
    expect(body.get("code")).toBe("one-time-code")
    expect(body.get("code_verifier")).toBe("verifier-abc")
    expect(body.get("redirect_uri")).toBe("http://127.0.0.1:17248/callback")
    expect(body.get("client_id")).toBe("client-123")
  })

  it("fails clearly when Google omits the refresh token", async () => {
    const mock = createFetchMock()
    mock.on("POST", GMAIL_TOKEN_ENDPOINT, () => ({
      json: { access_token: "at-new", expires_in: 3600 },
    }))

    await expect(
      exchangeCodeForTokens(
        "client-123",
        "code",
        "verifier",
        "http://127.0.0.1:17248",
        mock.fetch
      )
    ).rejects.toThrowError(/refresh token/)
  })

  it("reports the Google error code without echoing the code value", async () => {
    const mock = createFetchMock()
    mock.on("POST", GMAIL_TOKEN_ENDPOINT, () => ({
      status: 400,
      json: { error: "invalid_grant" },
    }))

    const error = await exchangeCodeForTokens(
      "client-123",
      "one-time-code",
      "verifier",
      "http://127.0.0.1:17248",
      mock.fetch
    ).catch((caught) => caught)

    expect((error as Error).message).toContain("invalid_grant")
    expect((error as Error).message).not.toContain("one-time-code")
  })
})

describe("createTokenSource", () => {
  it("resolves a promised envelope lazily and refreshes on force", async () => {
    const mock = createFetchMock()
    mockTokenSuccess(mock, "at-1", 3600)
    const account = gmailAccount()
    const source = createTokenSource(
      account,
      Promise.resolve({ refreshToken: "rt-1" }),
      mock.fetch
    )

    await expect(source.getToken()).resolves.toBe("at-1")

    // force=true skips the cache and refreshes again.
    mock.on("POST", GMAIL_TOKEN_ENDPOINT, () => ({
      json: { access_token: "at-2", expires_in: 3600 },
    }))
    await expect(source.getToken(true)).resolves.toBe("at-2")
    expect(mock.calls).toHaveLength(2)
  })

  it("throws ProviderAuthError when no refresh token is stored", async () => {
    const mock = createFetchMock()
    const source = createTokenSource(
      gmailAccount(),
      Promise.resolve(null),
      mock.fetch
    )
    await expect(source.getToken()).rejects.toBeInstanceOf(ProviderAuthError)
    expect(mock.calls).toHaveLength(0)
  })
})
