import { invoke } from "@tauri-apps/api/core"
import { openUrl } from "@tauri-apps/plugin-opener"

/**
 * Google OAuth 2.0 + PKCE driver for the Add Gmail flow (task 5.3).
 *
 * Everything stays client-side (no client secret, no backend): the
 * code_verifier/challenge pair and the anti-CSRF state are generated here
 * with WebCrypto, the consent page opens in the system browser through the
 * opener plugin, and the authorization code is captured by the Rust
 * loopback server (src-tauri/src/oauth.rs, `start_oauth_server`).
 *
 * Port policy: Google requires the EXACT registered loopback port (unlike
 * Microsoft, which accepts any localhost port) — the redirect URI is always
 * built from the fixed default loopback port (17248, mirroring Rust's
 * DEFAULT_OAUTH_PORT). The flow therefore probes that port with
 * `find_free_loopback_port({ preferred })` BEFORE opening the browser: when
 * another process already owns it, the browser redirect would land nowhere
 * and the wait would end in a silent timeout, so it fails fast with the
 * typed "port-busy" OauthFlowError ("the sign-in port is in use — close
 * the other app and retry") instead.
 *
 * Credential hygiene: token values, the verifier and the client id never
 * appear in error messages or logs.
 */

/** Loopback port for Google's redirect — keep in sync with oauth.rs. */
export const OAUTH_LOOPBACK_PORT = 17248

export const GOOGLE_AUTH_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth"

/**
 * Full-gmail-access scope: "https://mail.google.com/" grants IMAP/SMTP-
 * equivalent access over the Gmail API (the provider reads labels,
 * messages and history), plus "email" to identify the account.
 */
export const GMAIL_SCOPES = ["https://mail.google.com/", "email"]

/**
 * Google Calendar scope (task 5.1, design D5): requested ONLY by the
 * calendar-connect consent round (see calendar/connect.ts), never by the
 * mail flow — `buildGoogleAuthUrl`'s default is exactly GMAIL_SCOPES, so a
 * mail-only OAuth round cannot even ask for calendar access.
 */
export const GOOGLE_CALENDAR_SCOPE =
  "https://www.googleapis.com/auth/calendar"

/** Mirrors oauth.rs OauthCallback (serde camelCase). */
export interface OauthCallback {
  /** The port actually bound (may differ from the request on fallback). */
  port: number
  code?: string | null
  state?: string | null
  error?: string | null
  errorDescription?: string | null
  /**
   * Space-separated scopes Google GRANTED, relayed verbatim from the
   * success redirect's `scope` query parameter (absent on error
   * redirects). Task 5.1: the calendar connect verifies the calendar scope
   * actually landed before storing anything.
   */
  scope?: string | null
}

export type OauthFailureCode =
  | "consent-denied"
  | "state-mismatch"
  | "timeout"
  | "cancelled"
  | "loopback"
  /** The fixed loopback port is owned by another process (Google flow). */
  | "port-busy"

/**
 * Typed failure of the browser consent round-trip. `consent-denied` is
 * the user's own choice (the accounts spec: inline error, retry allowed,
 * no account created); the others are environmental.
 */
export class OauthFlowError extends Error {
  readonly code: OauthFailureCode
  /** Google's bare error code on consent-denied (e.g. "access_denied"). */
  readonly googleError?: string
  /** Google's human-readable description, when provided. */
  readonly googleErrorDescription?: string
  /**
   * Provider-neutral aliases (Microsoft flows set these INSTEAD of the
   * google* pair; the google* fields stay for the Google flow's shape).
   */
  readonly providerError?: string
  readonly providerErrorDescription?: string

  constructor(
    code: OauthFailureCode,
    message: string,
    options?: {
      googleError?: string
      googleErrorDescription?: string
      providerError?: string
      providerErrorDescription?: string
      cause?: unknown
    }
  ) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined
    )
    this.name = "OauthFlowError"
    this.code = code
    this.googleError = options?.googleError
    this.googleErrorDescription = options?.googleErrorDescription
    this.providerError = options?.providerError
    this.providerErrorDescription = options?.providerErrorDescription
  }
}

// ---------------------------------------------------------------------------
// PKCE + state primitives (S256, WebCrypto)
// ---------------------------------------------------------------------------

/** BASE64URL without padding (RFC 7636 appendix A). */
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** The code_verifier: 32 random bytes, base64url → 43 chars (43–128 ok). */
export function createCodeVerifier(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

/** The anti-CSRF state token, same entropy budget as the verifier. */
export function createOauthState(): string {
  return createCodeVerifier()
}

/** BASE64URL(SHA256(verifier)) — the S256 code_challenge. */
export async function createCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  )
  return base64UrlEncode(new Uint8Array(digest))
}

export interface PkcePair {
  codeVerifier: string
  codeChallenge: string
}

export async function createPkcePair(): Promise<PkcePair> {
  const codeVerifier = createCodeVerifier()
  return {
    codeVerifier,
    codeChallenge: await createCodeChallenge(codeVerifier),
  }
}

// ---------------------------------------------------------------------------
// Authorization URL
// ---------------------------------------------------------------------------

export interface GoogleAuthUrlInput {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  /**
   * Scopes to request. Defaults to GMAIL_SCOPES — the DEFAULT (mail) path
   * requests exactly what it always did, never the calendar scope
   * (task 5.1, design D5: the calendar scope is added only by the
   * calendar-connect consent round, which passes it explicitly).
   */
  scopes?: string[]
  /** Pre-fills Google's account chooser. */
  loginHint?: string
}

/**
 * Google's authorization endpoint URL for an installed-app PKCE flow.
 * access_type=offline + prompt=consent guarantee a refresh_token comes
 * back on every consent (Google otherwise skips it on repeat grants).
 */
export function buildGoogleAuthUrl(input: GoogleAuthUrlInput): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: (input.scopes ?? GMAIL_SCOPES).join(" "),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    prompt: "consent",
  })
  if (input.loginHint) {
    params.set("login_hint", input.loginHint)
  }
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`
}

// ---------------------------------------------------------------------------
// Consent round-trip driver
// ---------------------------------------------------------------------------

/** Short settle delay between binding the loopback port and opening the
 * browser, so the listener is accepting before the redirect can race it. */
const BROWSER_OPEN_DELAY_MS = 250

export interface ConsentResult {
  /** The authorization code from Google's redirect. */
  code: string
  /** The redirect_uri exactly as embedded in the authorization URL —
   * the token exchange must repeat it verbatim. */
  redirectUri: string
  codeVerifier: string
}

export interface RunConsentOptions {
  clientId: string
  loginHint?: string
  /**
   * Scopes to request; defaults to GMAIL_SCOPES (the unchanged mail flow).
   * The calendar connect passes GMAIL_SCOPES plus the calendar scope
   * (task 5.1, design D5) so the fresh consent yields a refresh token that
   * covers both grants.
   */
  scopes?: string[]
  /**
   * Milliseconds to wait after starting the loopback server before opening
   * the browser (tests pass 0 with fake-timer-free mocks).
   */
  openDelayMs?: number
}

/**
 * Drive one consent round-trip: start the loopback server, open Google's
 * consent page in the system browser, wait for the redirect, validate the
 * state and return the authorization code plus its PKCE verifier.
 * Throws OauthFlowError with a code describing what went wrong; on
 * consent denial no account data of any kind exists yet.
 */
export async function runGoogleConsent(
  options: RunConsentOptions
): Promise<ConsentResult> {
  // Probe the fixed loopback port BEFORE opening the browser: Google only
  // ever redirects to the exact registered port, so a port owned by
  // another process can only end in the redirect landing nowhere and the
  // wait timing out. Fail fast with an actionable, typed error instead.
  const free = await invoke<number>("find_free_loopback_port", {
    preferred: OAUTH_LOOPBACK_PORT,
  }).catch(() => null)
  if (free !== OAUTH_LOOPBACK_PORT) {
    throw new OauthFlowError(
      "port-busy",
      "The sign-in port is in use — close the other app and retry."
    )
  }

  const { codeVerifier, codeChallenge } = await createPkcePair()
  const state = createOauthState()
  const redirectUri = `http://127.0.0.1:${OAUTH_LOOPBACK_PORT}`
  const authUrl = buildGoogleAuthUrl({
    clientId: options.clientId,
    redirectUri,
    state,
    codeChallenge,
    scopes: options.scopes,
    loginHint: options.loginHint,
  })

  const serverWait = invoke<OauthCallback>("start_oauth_server", {
    port: OAUTH_LOOPBACK_PORT,
  })
  // If the flow abandons the wait below (openUrl throws, the delay
  // unwinds), the loopback invocation still rejects eventually (its own
  // timeout or a cancel). Attach a no-op handler so the abandoned
  // promise is never an unhandled rejection; the awaited use further
  // down keeps the real error paths (cancelled / timeout / loopback).
  void serverWait.catch(() => {})

  await delay(options.openDelayMs ?? BROWSER_OPEN_DELAY_MS)
  await openUrl(authUrl)

  let callback: OauthCallback
  try {
    callback = await serverWait
  } catch (error) {
    // The Rust command rejects with a plain error string.
    const raw = error instanceof Error ? error.message : String(error)
    if (raw.includes("cancelled")) {
      throw new OauthFlowError("cancelled", "Sign-in was cancelled.", {
        cause: error,
      })
    }
    if (raw.includes("timed out")) {
      throw new OauthFlowError(
        "timeout",
        "Sign-in timed out before Google redirected back to the app. " +
          "Please try again.",
        { cause: error }
      )
    }
    throw new OauthFlowError(
      "loopback",
      "Could not receive the sign-in callback on this machine. " + raw,
      { cause: error }
    )
  }

  // CSRF guard first: an unexpected state invalidates the response even
  // when it carries an error or a code.
  if (callback.state !== state) {
    throw new OauthFlowError(
      "state-mismatch",
      "The sign-in response could not be verified. Please try again."
    )
  }

  if (callback.error) {
    throw new OauthFlowError(
      "consent-denied",
      callback.errorDescription
        ? `Google reported “${callback.error}”: ${callback.errorDescription}`
        : `Google reported “${callback.error}” and no account was connected.`,
      {
        googleError: callback.error,
        googleErrorDescription: callback.errorDescription ?? undefined,
      }
    )
  }

  if (!callback.code) {
    throw new OauthFlowError(
      "loopback",
      "The sign-in response did not contain an authorization code. " +
        "Please try again."
    )
  }

  return { code: callback.code, redirectUri, codeVerifier }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * Abort a pending consent wait (user pressed cancel, or the dialog
 * closed). Resolves false when nothing was pending — both outcomes are
 * success for the caller.
 */
export async function cancelOauthWait(): Promise<boolean> {
  return invoke<boolean>("cancel_oauth_server")
}
