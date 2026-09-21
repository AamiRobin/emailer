import { beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"
import { openUrl } from "@tauri-apps/plugin-opener"

import {
  GOOGLE_AUTH_ENDPOINT,
  GMAIL_SCOPES,
  GOOGLE_CALENDAR_SCOPE,
  OAUTH_LOOPBACK_PORT,
  buildGoogleAuthUrl,
  createCodeChallenge,
  createCodeVerifier,
  createPkcePair,
  createOauthState,
  runGoogleConsent,
} from "../oauth-pkce"
import type { OauthCallback } from "../oauth-pkce"

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

describe("PKCE primitives", () => {
  it("creates a 43-char base64url verifier from 32 random bytes", () => {
    const verifier = createCodeVerifier()
    expect(verifier).toHaveLength(43)
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/)
    // Random: two verifiers never collide.
    expect(createCodeVerifier()).not.toBe(verifier)
  })

  it("derives the S256 challenge as BASE64URL(SHA256(verifier))", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk" // RFC 7636 appendix B
    const challenge = await createCodeChallenge(verifier)
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  })

  it("pairs a verifier with its own challenge", async () => {
    const { codeVerifier, codeChallenge } = await createPkcePair()
    expect(codeChallenge).toBe(await sha256Base64Url(codeVerifier))
  })

  it("generates unpredictable state tokens", () => {
    expect(createOauthState()).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(createOauthState()).not.toBe(createOauthState())
  })
})

describe("buildGoogleAuthUrl", () => {
  const input = {
    clientId: "client-id-1",
    redirectUri: `http://127.0.0.1:${OAUTH_LOOPBACK_PORT}`,
    state: "st4te",
    codeChallenge: "ch4llenge",
  }

  function paramsOf(url: string): URLSearchParams {
    return new URL(url).searchParams
  }

  it("sets the installed-app PKCE parameters", () => {
    const url = buildGoogleAuthUrl(input)
    expect(url.startsWith(GOOGLE_AUTH_ENDPOINT)).toBe(true)
    const params = paramsOf(url)
    expect(params.get("client_id")).toBe("client-id-1")
    expect(params.get("redirect_uri")).toBe("http://127.0.0.1:17248")
    expect(params.get("response_type")).toBe("code")
    // Full mailbox scope (IMAP/SMTP-equivalent) plus identity.
    expect(params.get("scope")).toBe("https://mail.google.com/ email")
    expect(params.get("state")).toBe("st4te")
    expect(params.get("code_challenge")).toBe("ch4llenge")
    expect(params.get("code_challenge_method")).toBe("S256")
  })

  it("always asks for offline access so a refresh token returns", () => {
    const params = paramsOf(buildGoogleAuthUrl(input))
    expect(params.get("access_type")).toBe("offline")
    expect(params.get("prompt")).toBe("consent")
  })

  it("passes login_hint only when provided", () => {
    expect(paramsOf(buildGoogleAuthUrl(input)).get("login_hint")).toBeNull()
    expect(
      paramsOf(buildGoogleAuthUrl({ ...input, loginHint: "me@gmail.com" })).get(
        "login_hint"
      )
    ).toBe("me@gmail.com")
  })

  // Task 5.1, design D5 — the scope guarantee: the DEFAULT (mail) flow
  // never requests the calendar scope. The scope list lives where the URL
  // is built (TS-side), so this is the authoritative test of the guarantee;
  // the Rust oauth.rs tests cover relaying whatever grant Google echoes
  // back verbatim.
  it("never requests the calendar scope in the default mail flow", () => {
    const params = paramsOf(buildGoogleAuthUrl(input))
    const scopes = params.get("scope")?.split(" ") ?? []
    expect(scopes).toEqual(GMAIL_SCOPES)
    expect(params.get("scope")).not.toContain(GOOGLE_CALENDAR_SCOPE)
  })

  it("requests the calendar scope only when explicitly passed (calendar connect)", () => {
    const params = paramsOf(
      buildGoogleAuthUrl({
        ...input,
        scopes: [...GMAIL_SCOPES, GOOGLE_CALENDAR_SCOPE],
      })
    )
    const scopes = params.get("scope")?.split(" ") ?? []
    expect(scopes).toContain(GOOGLE_CALENDAR_SCOPE)
    // The calendar scope is ADDED to the mail grant, not swapped for it.
    expect(scopes).toEqual(expect.arrayContaining(GMAIL_SCOPES))
    expect(scopes).toHaveLength(GMAIL_SCOPES.length + 1)
  })
})

describe("runGoogleConsent — loopback round-trip", () => {
  let resolveServer: ((callback: OauthCallback) => void) | null = null
  let rejectServer: ((error: unknown) => void) | null = null

  function pendingServer(): Promise<OauthCallback> {
    return new Promise<OauthCallback>((resolve, reject) => {
      resolveServer = resolve
      rejectServer = reject
    })
  }

  function mockInvoke(options?: { portBusy?: boolean }): void {
    invokeMock.mockImplementation(((command: string) => {
      if (command === "find_free_loopback_port") {
        // The probe is asked for the FIXED registered port (Google
        // requirement) — busy means fail fast.
        return options?.portBusy
          ? Promise.reject(new Error("loopback port 17248 is not available"))
          : Promise.resolve(OAUTH_LOOPBACK_PORT)
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

  it("probes the fixed registered port before opening the browser", async () => {
    const flow = runGoogleConsent({ clientId: "cid", openDelayMs: 0 })
    const url = await openAuthUrl()
    expect(invokeMock).toHaveBeenCalledWith("find_free_loopback_port", {
      preferred: OAUTH_LOOPBACK_PORT,
    })
    resolveServer?.({
      port: OAUTH_LOOPBACK_PORT,
      code: "4/0OK",
      state: url.searchParams.get("state"),
      error: null,
      errorDescription: null,
    })
    await expect(flow).resolves.toMatchObject({ code: "4/0OK" })
  })

  it("fails fast with the typed port-busy error when the port is taken", async () => {
    mockInvoke({ portBusy: true })
    const error = await runGoogleConsent({
      clientId: "cid",
      openDelayMs: 0,
    }).then(
      () => null,
      (thrown: unknown) => thrown
    )
    expect(error).toMatchObject({
      name: "OauthFlowError",
      code: "port-busy",
      message: expect.stringContaining("port is in use"),
    })
    // The browser was never opened and no server wait was registered.
    expect(openUrlMock).not.toHaveBeenCalled()
    expect(
      invokeMock.mock.calls.some((call) => call[0] === "start_oauth_server")
    ).toBe(false)
  })

  it("starts the loopback server, opens the browser and returns the code", async () => {
    const flow = runGoogleConsent({ clientId: "cid", openDelayMs: 0 })
    const url = await openAuthUrl()

    // The server is invoked on the fixed default port.
    expect(invokeMock).toHaveBeenCalledWith("start_oauth_server", {
      port: OAUTH_LOOPBACK_PORT,
    })
    expect(url.searchParams.get("redirect_uri")).toBe(
      `http://127.0.0.1:${OAUTH_LOOPBACK_PORT}`
    )

    resolveServer?.({
      port: OAUTH_LOOPBACK_PORT,
      code: "4/0ABC",
      state: url.searchParams.get("state"),
      error: null,
      errorDescription: null,
    })
    await expect(flow).resolves.toEqual({
      code: "4/0ABC",
      redirectUri: `http://127.0.0.1:${OAUTH_LOOPBACK_PORT}`,
      codeVerifier: expect.any(String),
    })
  })

  it("requests exactly the scopes it was given (task 5.1 calendar connect)", async () => {
    const flow = runGoogleConsent({
      clientId: "cid",
      scopes: [...GMAIL_SCOPES, GOOGLE_CALENDAR_SCOPE],
      openDelayMs: 0,
    })
    const url = await openAuthUrl()
    expect(url.searchParams.get("scope")?.split(" ")).toEqual([
      ...GMAIL_SCOPES,
      GOOGLE_CALENDAR_SCOPE,
    ])

    resolveServer?.({
      port: OAUTH_LOOPBACK_PORT,
      code: "4/0CAL",
      state: url.searchParams.get("state"),
      error: null,
      errorDescription: null,
      // Google echoes the granted scopes back; relayed on the callback.
      scope: "https://mail.google.com/ email https://www.googleapis.com/auth/calendar",
    })
    await expect(flow).resolves.toMatchObject({ code: "4/0CAL" })
  })

  it("rejects with consent-denied when Google reports an error", async () => {
    const flow = runGoogleConsent({ clientId: "cid", openDelayMs: 0 })
    const url = await openAuthUrl()
    resolveServer?.({
      port: OAUTH_LOOPBACK_PORT,
      code: null,
      state: url.searchParams.get("state"),
      error: "access_denied",
      errorDescription: "Consent was denied",
    })
    await expect(flow).rejects.toMatchObject({
      name: "OauthFlowError",
      code: "consent-denied",
      googleError: "access_denied",
    })
  })

  it("rejects on a state mismatch before looking at the payload", async () => {
    const flow = runGoogleConsent({ clientId: "cid", openDelayMs: 0 })
    await openAuthUrl()
    resolveServer?.({
      port: OAUTH_LOOPBACK_PORT,
      code: "4/0EVIL",
      state: "forged-state",
      error: null,
      errorDescription: null,
    })
    await expect(flow).rejects.toMatchObject({
      name: "OauthFlowError",
      code: "state-mismatch",
    })
  })

  it("maps the Rust cancel rejection to the cancelled code", async () => {
    const flow = runGoogleConsent({ clientId: "cid", openDelayMs: 0 })
    await openAuthUrl()
    rejectServer?.(new Error("OAuth sign-in was cancelled"))
    await expect(flow).rejects.toMatchObject({
      name: "OauthFlowError",
      code: "cancelled",
    })
  })

  it("maps the Rust timeout rejection to the timeout code", async () => {
    const flow = runGoogleConsent({ clientId: "cid", openDelayMs: 0 })
    await openAuthUrl()
    rejectServer?.(new Error("OAuth sign-in timed out after 300 minutes"))
    await expect(flow).rejects.toMatchObject({
      name: "OauthFlowError",
      code: "timeout",
    })
  })

  it("maps a loopback bind failure to the loopback code", async () => {
    const flow = runGoogleConsent({ clientId: "cid", openDelayMs: 0 })
    await openAuthUrl()
    rejectServer?.(new Error("could not bind OAuth port 17248"))
    await expect(flow).rejects.toMatchObject({
      name: "OauthFlowError",
      code: "loopback",
    })
  })

  it("abandons the server wait without an unhandled rejection when openUrl throws", async () => {
    openUrlMock.mockRejectedValue(new Error("no browser available"))
    await expect(
      runGoogleConsent({ clientId: "cid", openDelayMs: 0 })
    ).rejects.toThrow("no browser available")

    // The loopback invocation later rejects on its own (timeout/cancel);
    // the flow must have detached by then — vitest fails this test if the
    // rejection surfaces as unhandled.
    rejectServer?.(new Error("OAuth sign-in timed out"))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
