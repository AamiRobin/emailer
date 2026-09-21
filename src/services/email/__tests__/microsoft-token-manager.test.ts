import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  MAX_TOKEN_TTL_SECONDS,
  MICROSOFT_TOKEN_ENDPOINT,
  MIN_TOKEN_TTL_SECONDS,
  InvalidTokenResponseError,
  TransientTokenError,
  clearMicrosoftTokenCache,
  createMicrosoftTokenSource,
  exchangeMicrosoftCodeForTokens,
} from "../microsoft-token-manager"
import type { MicrosoftTokenEnvelope } from "../microsoft-token-manager"
import { ProviderAuthError } from "../types"
import { createFetchMock } from "./gmail-fixtures"
import type { FetchMock } from "./gmail-fixtures"
import {
  ENTRA_TOKEN_URL,
  microsoftAccount,
  mockEntraTokenError,
  mockEntraTokenSuccess,
} from "./microsoft-fixtures"

function account(overrides = {}) {
  return microsoftAccount(overrides)
}

const envelope: MicrosoftTokenEnvelope = { refreshToken: "ms-rt-1" }

beforeEach(() => {
  clearMicrosoftTokenCache()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("exchangeMicrosoftCodeForTokens", () => {
  it("posts the PKCE exchange and returns the token fields", async () => {
    const mock = createFetchMock()
    mockEntraTokenSuccess(mock, "at-1", { refreshToken: "rt-new" })
    const tokens = await exchangeMicrosoftCodeForTokens(
      "cid",
      "auth-code",
      "verifier",
      "http://127.0.0.1:17248",
      mock.fetch
    )
    expect(tokens).toMatchObject({
      accessToken: "at-1",
      refreshToken: "rt-new",
      scope: "Mail.ReadWrite Mail.Send User.Read",
    })
    const call = mock.calls.find((entry) => entry.url === ENTRA_TOKEN_URL)
    expect(call?.method).toBe("POST")
    const body = new URLSearchParams(call?.body)
    expect(body.get("grant_type")).toBe("authorization_code")
    expect(body.get("code")).toBe("auth-code")
    expect(body.get("code_verifier")).toBe("verifier")
    expect(body.get("client_id")).toBe("cid")
    expect(body.get("redirect_uri")).toBe("http://127.0.0.1:17248")
    // No client secret: Entra public clients authenticate with PKCE only.
    expect(body.get("client_secret")).toBeNull()
  })

  it("errors when offline_access was not granted (no refresh token)", async () => {
    const mock = createFetchMock()
    mock.on("POST", ENTRA_TOKEN_URL, () => ({
      status: 200,
      json: { access_token: "at-1", token_type: "Bearer", expires_in: 3600 },
    }))
    await expect(
      exchangeMicrosoftCodeForTokens("cid", "c", "v", "r", mock.fetch)
    ).rejects.toThrow("offline_access")
  })

  it("carries the Entra error code in the failure message", async () => {
    const mock = createFetchMock()
    mockEntraTokenError(mock, "invalid_client")
    await expect(
      exchangeMicrosoftCodeForTokens("cid", "c", "v", "r", mock.fetch)
    ).rejects.toThrow("(invalid_client)")
  })
})

describe("createMicrosoftTokenSource", () => {
  it("seeds from a fresh envelope access token without a network call", async () => {
    const mock = createFetchMock()
    mockEntraTokenSuccess(mock)
    const source = createMicrosoftTokenSource(
      account(),
      {
        refreshToken: "rt",
        accessToken: "seeded",
        accessTokenExpiresAt: Date.now() + 3600_000,
      },
      mock.fetch
    )
    expect(await source.getToken()).toBe("seeded")
    expect(mock.calls).toHaveLength(0)
  })

  it("refreshes silently and caches; a second call skips the network", async () => {
    const mock = createFetchMock()
    mockEntraTokenSuccess(mock, "at-refreshed")
    const source = createMicrosoftTokenSource(account(), envelope, mock.fetch)
    expect(await source.getToken()).toBe("at-refreshed")
    expect(await source.getToken()).toBe("at-refreshed")
    expect(mock.calls).toHaveLength(1)
    const body = new URLSearchParams(mock.calls[0]?.body)
    expect(body.get("grant_type")).toBe("refresh_token")
    expect(body.get("refresh_token")).toBe("ms-rt-1")
    expect(body.get("client_id")).toBe("ms-client-123")
    // No scope parameter: the token mints for the consented scope set.
    expect(body.get("scope")).toBeNull()
  })

  it("single-flights concurrent refreshes into one token request", async () => {
    const mock = createFetchMock()
    mockEntraTokenSuccess(mock, "at-1")
    const source = createMicrosoftTokenSource(account(), envelope, mock.fetch)
    const [first, second] = await Promise.all([
      source.getToken(),
      source.getToken(),
    ])
    expect(first).toBe("at-1")
    expect(second).toBe("at-1")
    expect(mock.calls).toHaveLength(1)
  })

  it("persists a ROTATED refresh token through the persist hook", async () => {
    const mock = createFetchMock()
    mockEntraTokenSuccess(mock, "at-2", { refreshToken: "rt-rotated" })
    const persist = vi.fn().mockResolvedValue(undefined)
    const source = createMicrosoftTokenSource(
      account(),
      envelope,
      mock.fetch,
      { persist }
    )
    await source.getToken()
    expect(persist).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: "rt-rotated" })
    )
  })

  it("keeps the token usable when the persist hook fails (best effort)", async () => {
    const mock = createFetchMock()
    mockEntraTokenSuccess(mock, "at-3", { refreshToken: "rt-rotated" })
    const source = createMicrosoftTokenSource(account(), envelope, mock.fetch, {
      persist: () => Promise.reject(new Error("no db binding")),
    })
    await expect(source.getToken()).resolves.toBe("at-3")
  })

  it("force=true bypasses the cache and refreshes", async () => {
    const mock = createFetchMock()
    mockEntraTokenSuccess(mock, "at-first")
    const source = createMicrosoftTokenSource(account(), envelope, mock.fetch)
    await source.getToken()
    mockEntraTokenSuccess(mock, "at-forced")
    expect(await source.getToken(true)).toBe("at-forced")
    expect(mock.calls).toHaveLength(2)
  })

  it("maps invalid_grant to ProviderAuthError with the microsoft type", async () => {
    const mock = createFetchMock()
    mockEntraTokenError(mock, "invalid_grant")
    const source = createMicrosoftTokenSource(account(), envelope, mock.fetch)
    const error = await source.getToken().then(
      () => null,
      (thrown: unknown) => thrown
    )
    expect(error).toBeInstanceOf(ProviderAuthError)
    expect((error as ProviderAuthError).accountType).toBe("microsoft")
    expect((error as ProviderAuthError).message).toContain("invalid_grant")
    // The refresh token value never rides the error.
    expect((error as ProviderAuthError).message).not.toContain("ms-rt-1")
  })

  it("maps interaction_required, consent_required and AADSTS65001 to ProviderAuthError too", async () => {
    for (const payload of [
      { error: "interaction_required", error_description: "login needed" },
      { error: "consent_required", error_description: "consent needed" },
      {
        // Admin consent revoked: the marker rides the description.
        error: "invalid_grant",
        error_description:
          "AADSTS65001: The user or administrator has not consented to use the application.",
      },
      {
        error: "unknown_shape",
        error_description: "AADSTS65001: consent missing",
      },
    ]) {
      const mock = createFetchMock()
      mock.on("POST", ENTRA_TOKEN_URL, () => ({ status: 400, json: payload }))
      const source = createMicrosoftTokenSource(account(), envelope, mock.fetch)
      const error = await source.getToken().then(
        () => null,
        (thrown: unknown) => thrown
      )
      expect(error, payload.error).toBeInstanceOf(ProviderAuthError)
      expect((error as ProviderAuthError).message).not.toContain("ms-rt-1")
    }
  })

  it("surfaces transient Entra failures as retryable TransientTokenError, not auth errors", async () => {
    for (const code of ["temporarily_unavailable", "server_error"]) {
      const mock = createFetchMock()
      mockEntraTokenError(mock, code, 503)
      const source = createMicrosoftTokenSource(account(), envelope, mock.fetch)
      const error = await source.getToken().then(
        () => null,
        (thrown: unknown) => thrown
      )
      expect(error, code).toBeInstanceOf(TransientTokenError)
      expect(error, code).not.toBeInstanceOf(ProviderAuthError)
      expect((error as TransientTokenError).status).toBe(503)
      expect((error as TransientTokenError).code).toBe(code)
      expect((error as Error).message).toContain(`status 503 (${code})`)
      // The refresh token never rides the error.
      expect((error as Error).message).not.toContain("ms-rt-1")
    }
  })

  it("surfaces a missing envelope as ProviderAuthError (re-auth required)", async () => {
    const mock = createFetchMock()
    const source = createMicrosoftTokenSource(account(), null, mock.fetch)
    await expect(source.getToken()).rejects.toBeInstanceOf(ProviderAuthError)
    expect(mock.calls).toHaveLength(0)
  })

  it("reports a non-OAuth refresh failure with the status and code", async () => {
    const mock = createFetchMock()
    mockEntraTokenError(mock, "temporarily_unavailable", 503)
    const source = createMicrosoftTokenSource(account(), envelope, mock.fetch)
    await expect(source.getToken()).rejects.toThrow(
      "status 503 (temporarily_unavailable)"
    )
  })

  it("rejects an account with no client id", async () => {
    const mock = createFetchMock()
    mockEntraTokenSuccess(mock)
    const source = createMicrosoftTokenSource(
      account({ oauthClientId: undefined }),
      envelope,
      mock.fetch
    )
    await expect(source.getToken()).rejects.toThrow("no oauth_client_id")
  })

  // ---- Token response validation (fix 9) ----

  describe("token response validation", () => {
    function mockRawTokenResponse(
      payload: Record<string, unknown>,
      status = 200
    ): FetchMock {
      const mock = createFetchMock()
      mock.on("POST", ENTRA_TOKEN_URL, () => ({ status, json: payload }))
      return mock
    }

    it("clamps zero, negative and huge expires_in before caching and sealing", async () => {
      for (const [expiresIn, minSeconds, maxSeconds] of [
        [0, MIN_TOKEN_TTL_SECONDS, MIN_TOKEN_TTL_SECONDS],
        [-500, MIN_TOKEN_TTL_SECONDS, MIN_TOKEN_TTL_SECONDS],
        [
          Number(MAX_TOKEN_TTL_SECONDS) * 10,
          MAX_TOKEN_TTL_SECONDS,
          MAX_TOKEN_TTL_SECONDS,
        ],
      ] as const) {
        const mock = mockRawTokenResponse({
          access_token: "at-clamp",
          refresh_token: "rt-clamp",
          expires_in: expiresIn,
        })
        const persist = vi.fn().mockResolvedValue(undefined)
        const before = Date.now()
        const source = createMicrosoftTokenSource(account(), envelope, mock.fetch, {
          persist,
        })
        await expect(source.getToken()).resolves.toBe("at-clamp")
        const sealed = persist.mock.calls[0]?.[0]
        const ttl = (sealed?.accessTokenExpiresAt ?? 0) - before
        expect(ttl).toBeGreaterThanOrEqual(minSeconds * 1000 - 1000)
        expect(ttl).toBeLessThanOrEqual(maxSeconds * 1000 + 1000)
      }
    })

    it("rejects a non-numeric expires_in as a failed refresh and caches nothing", async () => {
      const mock = mockRawTokenResponse({
        access_token: "at-bad",
        expires_in: "3600",
      })
      const persist = vi.fn().mockResolvedValue(undefined)
      const source = createMicrosoftTokenSource(account(), envelope, mock.fetch, {
        persist,
      })
      await expect(source.getToken()).rejects.toBeInstanceOf(
        InvalidTokenResponseError
      )
      expect(persist).not.toHaveBeenCalled()
      // Nothing was cached: the next call hits the network again.
      await expect(source.getToken()).rejects.toBeInstanceOf(
        InvalidTokenResponseError
      )
      expect(mock.calls).toHaveLength(2)
    })

    it("rejects an oversized token with the typed error", async () => {
      const mock = mockRawTokenResponse({
        access_token: "x".repeat(5000),
        expires_in: 3600,
      })
      const source = createMicrosoftTokenSource(account(), envelope, mock.fetch)
      await expect(source.getToken()).rejects.toBeInstanceOf(
        InvalidTokenResponseError
      )
    })

    it("rejects a control-character token and never caches or seals it", async () => {
      const mock = mockRawTokenResponse({
        access_token: "bad\u0000token",
        expires_in: 3600,
        refresh_token: "rt\u001frotated",
      })
      const persist = vi.fn().mockResolvedValue(undefined)
      const source = createMicrosoftTokenSource(account(), envelope, mock.fetch, {
        persist,
      })
      const error = await source.getToken().then(
        () => null,
        (thrown: unknown) => thrown
      )
      expect(error).toBeInstanceOf(InvalidTokenResponseError)
      // The (invalid) token material never appears in the error.
      expect((error as Error).message).not.toContain("bad")
      expect(persist).not.toHaveBeenCalled()
      expect(mock.calls).toHaveLength(1)
    })

    it("applies the same validation to the authorization-code exchange", async () => {
      const missing = mockRawTokenResponse({ access_token: "at", expires_in: 3600 })
      await expect(
        exchangeMicrosoftCodeForTokens("cid", "c", "v", "r", missing.fetch)
      ).rejects.toThrow("offline_access")

      const bad = mockRawTokenResponse({
        access_token: "at",
        refresh_token: "rt",
        expires_in: null,
      })
      await expect(
        exchangeMicrosoftCodeForTokens("cid", "c", "v", "r", bad.fetch)
      ).rejects.toBeInstanceOf(InvalidTokenResponseError)

      const control = mockRawTokenResponse({
        access_token: "at\u0007bell",
        refresh_token: "rt",
        expires_in: 3600,
      })
      await expect(
        exchangeMicrosoftCodeForTokens("cid", "c", "v", "r", control.fetch)
      ).rejects.toBeInstanceOf(InvalidTokenResponseError)
    })
  })

  it("accepts a lazily-resolved envelope promise", async () => {
    const mock = createFetchMock()
    mockEntraTokenSuccess(mock, "at-lazy")
    let resolve: (value: MicrosoftTokenEnvelope | null) => void = () => {}
    const lazy = new Promise<MicrosoftTokenEnvelope | null>((res) => {
      resolve = res
    })
    const source = createMicrosoftTokenSource(account(), lazy, mock.fetch)
    const pending = source.getToken()
    resolve({ refreshToken: "rt-late" })
    await expect(pending).resolves.toBe("at-lazy")
  })

  it("clearMicrosoftTokenCache drops the cached access token", async () => {
    const mock = createFetchMock()
    mockEntraTokenSuccess(mock, "at-1")
    const source = createMicrosoftTokenSource(account(), envelope, mock.fetch)
    await source.getToken()
    clearMicrosoftTokenCache("acc-m")
    mockEntraTokenSuccess(mock, "at-2")
    expect(await source.getToken()).toBe("at-2")
    expect(mock.calls).toHaveLength(2)
  })

  it("the token endpoint is the Entra common-authority v2.0 URL", () => {
    expect(MICROSOFT_TOKEN_ENDPOINT).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token"
    )
  })
})
