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
 * Port-fallback caveat: the redirect URI is always built from the fixed
 * default loopback port (17248, mirroring Rust's DEFAULT_OAUTH_PORT). If
 * another process already owns that port, the Rust command falls back to
 * an ephemeral one — but the browser still redirects to the URI embedded
 * in the authorization URL, so the redirect lands on the other process and
 * the wait ends in the Rust-side timeout. That surfaces as a retryable
 * OauthFlowError("timeout"); freeing the port and retrying fixes it. A
 * code that does arrive on a fallback port is still exchanged against the
 * original redirect URI (Google only compares the URI string), so no
 * special-casing is needed beyond the timeout path.
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

/** Mirrors oauth.rs OauthCallback (serde camelCase). */
export interface OauthCallback {
  /** The port actually bound (may differ from the request on fallback). */
  port: number
  code?: string | null
  state?: string | null
  error?: string | null
  errorDescription?: string | null
}

export type OauthFailureCode =
  "consent-denied" | "state-mismatch" | "timeout" | "cancelled" | "loopback"

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

  constructor(
    code: OauthFailureCode,
    message: string,
    options?: {
      googleError?: string
      googleErrorDescription?: string
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
    scope: GMAIL_SCOPES.join(" "),
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
  const { codeVerifier, codeChallenge } = await createPkcePair()
  const state = createOauthState()
  const redirectUri = `http://127.0.0.1:${OAUTH_LOOPBACK_PORT}`
  const authUrl = buildGoogleAuthUrl({
    clientId: options.clientId,
    redirectUri,
    state,
    codeChallenge,
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
