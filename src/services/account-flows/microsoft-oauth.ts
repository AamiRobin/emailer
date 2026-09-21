import { invoke } from "@tauri-apps/api/core"
import { openUrl } from "@tauri-apps/plugin-opener"

import {
  OAUTH_LOOPBACK_PORT,
  OauthFlowError,
  cancelOauthWait,
  createOauthState,
  createPkcePair,
} from "./oauth-pkce"

/**
 * Microsoft (Entra ID) OAuth 2.0 + PKCE driver for the Add Microsoft 365
 * flow (task 3.1, design D2): the Google flow's shape re-targeted at the
 * `common`-authority v2.0 endpoints so BOTH personal outlook.com and
 * work/school accounts can consent.
 *
 * Everything stays client-side (public client, no secret): the
 * code_verifier/challenge pair and the anti-CSRF state are generated
 * here with WebCrypto, the consent page opens in the system browser, and
 * the authorization code is captured by the same Rust loopback server
 * the Google flow uses (src-tauri/src/oauth.rs, `start_oauth_server` —
 * one-shot authorization-code capture, reused unchanged).
 *
 * Entra specifics this driver owns:
 * - `offline_access` MUST be in the scope list or Microsoft issues no
 *   refresh token (mail scopes alone mint only access tokens).
 * - `response_mode=query` — the authorization code lands in the
 *   redirect's query string (the loopback server's default parse).
 * - `prompt=select_account` when no login_hint is given: an active
 *   Microsoft SSO session would otherwise sign in silently as whoever
 *   the browser is logged in as — the account picker makes signing in an
 *   explicit, visible choice (the reference implementation's behavior).
 * - No access_type/prompt=consent dance (a Google-ism): Entra always
 *   returns a fresh refresh token on every authorization-code grant that
 *   carries offline_access.
 *
 * Redirect URI: a FREE loopback port probed just before the flow starts
 * (`find_free_loopback_port`), not a fixed one — Microsoft accepts ANY
 * localhost port for public clients (RFC 8252 §7.3), so probing an
 * ephemeral port means another process owning 17248 (or a second sign-in
 * running elsewhere) can no longer black-hole the redirect into a silent
 * timeout. The probed port is handed to `start_oauth_server` explicitly
 * and used to build the redirect embedded in the authorization URL; the
 * app registration must list `http://localhost` redirect URIs for public
 * clients so any port matches. This requirement is what the flow's help
 * text explains.
 *
 * Credential hygiene: token values, the verifier and the client id never
 * appear in error messages or logs.
 */

export const MICROSOFT_AUTH_ENDPOINT =
  "https://login.microsoftonline.com/common/oauth2/v2.0/authorize"

/**
 * The mail grant (design D2): read/write mail, send as the user, read
 * the profile to identify the account, and offline_access so the consent
 * yields a refresh token. Graph calendar scope is requested by a
 * SEPARATE consent round when adding a Graph calendar source (task 3.6;
 * refresh tokens bind to scope sets, same rationale as Google).
 */
export const MICROSOFT_SCOPES = [
  "Mail.ReadWrite",
  "Mail.Send",
  "User.Read",
  "offline_access",
]

/**
 * The scopes a MAIL account REQUIRES in the granted set (User.Read and
 * offline_access are requested too, but without the mail grant the account
 * would store as "active" and then fail opaquely on every sync).
 */
export const REQUIRED_MAIL_SCOPES = ["Mail.ReadWrite", "Mail.Send"]

/**
 * Entra's granted scope set omitted a required mail scope (typically a
 * work/school tenant where admin policy denies mail access). Carries the
 * MISSING scope names — never token material — so the dialog can explain
 * exactly what was withheld. Nothing is persisted when this is thrown.
 */
export class MicrosoftMailScopeNotGrantedError extends Error {
  /** The required scopes absent from Entra's granted scope string. */
  readonly missingScopes: string[]

  constructor(missingScopes: string[]) {
    super(
      "Microsoft did not grant mail access for this account (missing: " +
        `${missingScopes.join(", ")}). If it is a work or school account, ` +
        "mail access may be disabled by administrator policy."
    )
    this.name = "MicrosoftMailScopeNotGrantedError"
    this.missingScopes = missingScopes
  }
}

/**
 * The required mail scopes absent from an Entra granted-scope string
 * (space-separated, echoed verbatim in the token response); empty when
 * the grant covers the mail scenario.
 */
export function missingMailScopes(grantedScope: string): string[] {
  const granted = new Set(grantedScope.split(/\s+/).filter(Boolean))
  return REQUIRED_MAIL_SCOPES.filter((scope) => !granted.has(scope))
}

/**
 * The calendar grant (parity-round-2 task 3.6): read/write the user's
 * calendars through Graph, identify the account, and keep a refresh token.
 * Requested by a SEPARATE consent round when adding a Graph calendar
 * source — never bundled into the mail grant — because Entra binds each
 * refresh token to the scope set of the consent that produced it: silently
 * refreshing the mail envelope could never yield a calendar-capable access
 * token (and vice versa). The calendar source therefore stores its OWN
 * sealed envelope from this round (connect-microsoft.ts), exactly the
 * Google calendar re-consent rationale.
 */
export const MICROSOFT_CALENDAR_SCOPES = [
  "Calendar.ReadWrite",
  "User.Read",
  "offline_access",
]

/** OauthCallback relayed by the loopback server (same shape as Google). */
export type MicrosoftOauthCallback = {
  port: number
  code?: string | null
  state?: string | null
  error?: string | null
  errorDescription?: string | null
  scope?: string | null
}

export interface MicrosoftAuthUrlInput {
  clientId: string
  redirectUri: string
  state: string
  codeChallenge: string
  /** Defaults to MICROSOFT_SCOPES (the mail grant, incl. offline_access). */
  scopes?: string[]
  /** Pre-fills Entra's account chooser (re-auth pins the account). */
  loginHint?: string
}

export function buildMicrosoftAuthUrl(input: MicrosoftAuthUrlInput): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    response_mode: "query",
    scope: (input.scopes ?? MICROSOFT_SCOPES).join(" "),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  })
  if (input.loginHint) {
    // Re-auth: pin the account but let an existing session flow through.
    params.set("login_hint", input.loginHint)
  } else {
    // Add flow: force the explicit account picker (never a silent SSO
    // sign-in as the browser's incidental Microsoft session).
    params.set("prompt", "select_account")
  }
  return `${MICROSOFT_AUTH_ENDPOINT}?${params.toString()}`
}

export interface MicrosoftConsentResult {
  /** The authorization code from Entra's redirect. */
  code: string
  /** The redirect_uri exactly as embedded (repeated at the exchange). */
  redirectUri: string
  codeVerifier: string
}

export interface RunMicrosoftConsentOptions {
  clientId: string
  loginHint?: string
  /**
   * Scopes to request. Defaults to MICROSOFT_SCOPES (the mail grant) — the
   * default path builds its authorization URL exactly as before. The
   * calendar connect (task 3.6) passes MICROSOFT_CALENDAR_SCOPES for the
   * separate calendar-scope consent round.
   */
  scopes?: string[]
  /** Milliseconds before opening the browser (tests pass 0). */
  openDelayMs?: number
}

/**
 * Drive one consent round-trip: start the loopback server, open Entra's
 * consent page in the system browser, wait for the redirect, validate
 * the state and return the authorization code plus its PKCE verifier.
 * Throws OauthFlowError with a code describing what went wrong; on
 * consent denial no account data of any kind exists yet.
 */
export async function runMicrosoftConsent(
  options: RunMicrosoftConsentOptions
): Promise<MicrosoftConsentResult> {
  const { codeVerifier, codeChallenge } = await createPkcePair()
  const state = createOauthState()
  // Probe a FREE loopback port up front: the flow passes it explicitly to
  // the loopback server and builds the redirect from it (see the module
  // comment — Microsoft accepts any localhost port for public clients).
  let port: number
  try {
    port = await invoke<number>("find_free_loopback_port")
  } catch (error) {
    throw new OauthFlowError(
      "loopback",
      "Could not prepare the sign-in callback on this machine. Please try again.",
      { cause: error }
    )
  }
  const redirectUri = `http://127.0.0.1:${port}`
  const authUrl = buildMicrosoftAuthUrl({
    clientId: options.clientId,
    redirectUri,
    state,
    codeChallenge,
    scopes: options.scopes,
    loginHint: options.loginHint,
  })

  const serverWait = invoke<MicrosoftOauthCallback>("start_oauth_server", {
    port,
  })
  // If the flow abandons the wait below, the loopback invocation still
  // rejects eventually; detach so the abandoned promise is never an
  // unhandled rejection (the awaited use keeps the real error paths).
  void serverWait.catch(() => {})

  await delay(options.openDelayMs ?? 250)
  await openUrl(authUrl)

  let callback: MicrosoftOauthCallback
  try {
    callback = await serverWait
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error)
    if (raw.includes("cancelled")) {
      throw new OauthFlowError("cancelled", "Sign-in was cancelled.", {
        cause: error,
      })
    }
    if (raw.includes("timed out")) {
      throw new OauthFlowError(
        "timeout",
        "Sign-in timed out before Microsoft redirected back to the app. " +
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
        ? `Microsoft reported “${callback.error}”: ${callback.errorDescription}`
        : `Microsoft reported “${callback.error}” and no account was connected.`,
      {
        providerError: callback.error,
        providerErrorDescription: callback.errorDescription ?? undefined,
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

// Re-exported for the flows' error taxonomy — the same classes as the
// Google flow, so the dialogs can treat both providers identically.
export { OauthFlowError, OAUTH_LOOPBACK_PORT, cancelOauthWait }
