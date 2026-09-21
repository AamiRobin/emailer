import { beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { openUrl } from "@tauri-apps/plugin-opener"

import {
  MICROSOFT_AUTH_ENDPOINT,
  MICROSOFT_SCOPES,
  OAUTH_LOOPBACK_PORT,
  buildMicrosoftAuthUrl,
  runMicrosoftConsent,
} from "../microsoft-oauth"
import type { MicrosoftOauthCallback } from "../microsoft-oauth"

vi.mock("@tauri-apps/api/core")
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }))

const invokeMock = vi.mocked(invoke)
const openUrlMock = vi.mocked(openUrl)

/** Independent S256 reference implementation via the platform WebCrypto. */
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

beforeEach(() => {
  invokeMock.mockReset()
  openUrlMock.mockReset()
})

describe("buildMicrosoftAuthUrl", () => {
  const input = {
    clientId: "ms-client",
    redirectUri: `http://127.0.0.1:${OAUTH_LOOPBACK_PORT}`,
    state: "st4te",
    codeChallenge: "ch4llenge",
  }

  function paramsOf(url: string): URLSearchParams {
    return new URL(url).searchParams
  }

  it("targets the common-authority v2.0 endpoint with the mail grant", () => {
    const url = buildMicrosoftAuthUrl(input)
    expect(url.startsWith(MICROSOFT_AUTH_ENDPOINT)).toBe(true)
    const params = paramsOf(url)
    expect(params.get("client_id")).toBe("ms-client")
    expect(params.get("redirect_uri")).toBe(`http://127.0.0.1:${OAUTH_LOOPBACK_PORT}`)
    expect(params.get("response_type")).toBe("code")
    // offline_access MUST be listed for a refresh token to come back.
    expect(params.get("scope")?.split(" ")).toEqual([
      "Mail.ReadWrite",
      "Mail.Send",
      "User.Read",
      "offline_access",
    ])
    expect(params.get("state")).toBe("st4te")
    expect(params.get("code_challenge")).toBe("ch4llenge")
    expect(params.get("code_challenge_method")).toBe("S256")
    // The authorization code rides the redirect's QUERY string.
    expect(params.get("response_mode")).toBe("query")
  })

  it("forces the account picker when no login hint is given", () => {
    const params = paramsOf(buildMicrosoftAuthUrl(input))
    expect(params.get("prompt")).toBe("select_account")
    expect(params.get("login_hint")).toBeNull()
  })

  it("pins the account with login_hint instead of the picker (re-auth)", () => {
    const params = paramsOf(
      buildMicrosoftAuthUrl({ ...input, loginHint: "me@outlook.com" })
    )
    expect(params.get("login_hint")).toBe("me@outlook.com")
    expect(params.get("prompt")).toBeNull()
  })

  it("never includes the Google-style offline consent params", () => {
    const params = paramsOf(buildMicrosoftAuthUrl(input))
    // Entra issues a refresh token on every offline_access grant; the
    // access_type/prompt=consent dance is a Google-ism.
    expect(params.get("access_type")).toBeNull()
    expect(MICROSOFT_SCOPES).toContain("offline_access")
  })
})

describe("runMicrosoftConsent — loopback round-trip", () => {
  let resolveServer: ((callback: MicrosoftOauthCallback) => void) | null = null
  let rejectServer: ((error: unknown) => void) | null = null

  /** The free port the probe hands out (differs from the Google default). */
  const PROBED_PORT = 51820

  function pendingServer(): Promise<MicrosoftOauthCallback> {
    return new Promise<MicrosoftOauthCallback>((resolve, reject) => {
      resolveServer = resolve
      rejectServer = reject
    })
  }

  function mockInvoke(options?: { probeError?: Error }): void {
    invokeMock.mockImplementation(((command: string) => {
      if (command === "find_free_loopback_port") {
        return options?.probeError
          ? Promise.reject(options.probeError)
          : Promise.resolve(PROBED_PORT)
      }
      if (command === "start_oauth_server") return pendingServer()
      if (command === "cancel_oauth_server") return Promise.resolve(true)
      return Promise.reject(new Error(`unexpected command: ${command}`))
    }) as typeof invoke)
  }

  async function openAuthUrl(): Promise<URL> {
    await vi.waitFor(() => {
      expect(openUrlMock).toHaveBeenCalledTimes(1)
    })
    return new URL(openUrlMock.mock.calls[0][0] as string)
  }

  beforeEach(() => {
    mockInvoke()
  })

  it("probes a free port, starts the server on it and builds the redirect from it", async () => {
    const flow = runMicrosoftConsent({ clientId: "ms-client", openDelayMs: 0 })
    const url = await openAuthUrl()

    // The probed port flows through BOTH the loopback invocation and the
    // redirect embedded in the authorization URL.
    expect(invokeMock).toHaveBeenCalledWith("find_free_loopback_port")
    expect(invokeMock).toHaveBeenCalledWith("start_oauth_server", {
      port: PROBED_PORT,
    })
    expect(url.searchParams.get("redirect_uri")).toBe(
      `http://127.0.0.1:${PROBED_PORT}`
    )
    const challenge = url.searchParams.get("code_challenge")

    resolveServer?.({
      port: PROBED_PORT,
      code: "M-C0DE",
      state: url.searchParams.get("state"),
      error: null,
      errorDescription: null,
    })
    const result = await flow
    expect(result.code).toBe("M-C0DE")
    expect(result.redirectUri).toBe(`http://127.0.0.1:${PROBED_PORT}`)
    // The verifier hashes (S256) to the consent's challenge.
    expect(await sha256Base64Url(result.codeVerifier)).toBe(challenge)
  })

  it("fails fast with a loopback error when the port probe itself fails", async () => {
    mockInvoke({ probeError: new Error("no network stack") })
    await expect(
      runMicrosoftConsent({ clientId: "ms-client", openDelayMs: 0 })
    ).rejects.toMatchObject({
      name: "OauthFlowError",
      code: "loopback",
    })
    expect(openUrlMock).not.toHaveBeenCalled()
  })

  it("rejects with consent-denied when Microsoft reports an error", async () => {
    const flow = runMicrosoftConsent({ clientId: "ms-client", openDelayMs: 0 })
    const url = await openAuthUrl()
    resolveServer?.({
      port: OAUTH_LOOPBACK_PORT,
      code: null,
      state: url.searchParams.get("state"),
      error: "access_denied",
      errorDescription: "admin consent required",
    })
    await expect(flow).rejects.toMatchObject({
      name: "OauthFlowError",
      code: "consent-denied",
      providerError: "access_denied",
      providerErrorDescription: "admin consent required",
    })
  })

  it("rejects on a state mismatch before looking at the payload", async () => {
    const flow = runMicrosoftConsent({ clientId: "ms-client", openDelayMs: 0 })
    await openAuthUrl()
    resolveServer?.({
      port: OAUTH_LOOPBACK_PORT,
      code: "M-EVIL",
      state: "forged-state",
      error: null,
      errorDescription: null,
    })
    await expect(flow).rejects.toMatchObject({
      name: "OauthFlowError",
      code: "state-mismatch",
    })
  })

  it("maps the Rust cancel/timeout/loopback rejections", async () => {
    for (const [raw, code] of [
      ["OAuth sign-in was cancelled", "cancelled"],
      ["OAuth sign-in timed out after 300 minutes", "timeout"],
      ["could not bind OAuth port 17248", "loopback"],
    ] as const) {
      invokeMock.mockReset()
      openUrlMock.mockReset()
      mockInvoke()
      const flow = runMicrosoftConsent({ clientId: "ms-client", openDelayMs: 0 })
      await openAuthUrl()
      rejectServer?.(new Error(raw))
      await expect(flow).rejects.toMatchObject({
        name: "OauthFlowError",
        code,
      })
    }
  })

  it("abandons the server wait without an unhandled rejection when openUrl throws", async () => {
    openUrlMock.mockRejectedValue(new Error("no browser available"))
    await expect(
      runMicrosoftConsent({ clientId: "ms-client", openDelayMs: 0 })
    ).rejects.toThrow("no browser available")
    rejectServer?.(new Error("OAuth sign-in timed out"))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
