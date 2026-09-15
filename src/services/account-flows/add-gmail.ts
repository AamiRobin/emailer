import type { FetchImpl } from "../email/token-manager"
import { exchangeCodeForTokens } from "../email/token-manager"
import type { SqlExecutor } from "../db/executor"
import { getExecutor } from "../db/executor"
import { insertAccount } from "../db/accounts"
import { encryptCredentials } from "../crypto/credentials"
import { useAccountStore } from "../../stores/account-store"
import { triggerRefresh } from "../sync/scheduler"
import { OauthFlowError, runGoogleConsent } from "./oauth-pkce"

/**
 * Add-Gmail account orchestrator (task 5.3, accounts spec "Successful
 * Gmail connect" / "User denies consent").
 *
 * End to end: PKCE setup → browser consent (system browser, loopback
 * callback) → authorization-code exchange (token-manager) → profile read
 * (Gmail API) → AES-256-GCM credentials envelope → account row → store
 * reload → initial sync. Nothing is persisted before the token exchange
 * has produced a refresh token.
 *
 * Error taxonomy for the UI:
 * - ConsentDeniedError  — user denied on Google's screen; retry allowed,
 *   no account created.
 * - InvalidClientIdError — Google rejected the client id at the exchange
 *   (invalid_client); the user can fix the id and retry.
 * - OauthCancelledError — the user cancelled locally (dialog closed /
 *   cancel button); a quiet no-op, not an error banner.
 * - NetworkError — everything else environmental (timeout, loopback
 *   failure, state mismatch, profile read failure); retry allowed.
 *
 * Credential hygiene: token values and the client id never appear in
 * error messages or logs.
 */

/** Gmail profile read used to identify the authorized account. */
const GMAIL_PROFILE_ENDPOINT =
  "https://gmail.googleapis.com/gmail/v1/users/me/profile"

export type GmailFlowStep = "consent" | "exchange" | "profile" | "save"

/** User denied consent on Google's screen (retryable, nothing saved). */
export class ConsentDeniedError extends Error {
  readonly googleError?: string
  readonly googleErrorDescription?: string

  constructor(
    message: string,
    options?: { googleError?: string; googleErrorDescription?: string }
  ) {
    super(message)
    this.name = "ConsentDeniedError"
    this.googleError = options?.googleError
    this.googleErrorDescription = options?.googleErrorDescription
  }
}

/** Google rejected the client id (invalid_client) at the token exchange. */
export class InvalidClientIdError extends Error {
  constructor() {
    super(
      "Google rejected this Client ID. Check that it is complete and of " +
        "type “Desktop app”, then try again."
    )
    this.name = "InvalidClientIdError"
  }
}

/** The user (or a dialog close) aborted the pending consent wait. */
export class OauthCancelledError extends Error {
  constructor() {
    super("Sign-in was cancelled.")
    this.name = "OauthCancelledError"
  }
}

/** Environmental failure (timeout, loopback, state mismatch, network). */
export class NetworkError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined
    )
    this.name = "NetworkError"
  }
}

export interface GmailProfile {
  /** The authorized Google account's email address. */
  emailAddress: string
}

export interface AddGmailOptions {
  /** The user's own Google OAuth Client ID (type "Desktop app"). */
  clientId: string
  /** Optional login_hint for Google's account chooser. */
  loginHint?: string
  /** Step callbacks so the UI can show progress. */
  onProgress?: (step: GmailFlowStep) => void
  /** Test seams (vitest); production uses the defaults. */
  fetchImpl?: FetchImpl
  executor?: SqlExecutor
}

export interface AddGmailResult {
  accountId: string
  email: string
}

function mapOauthFlowError(error: OauthFlowError): Error {
  switch (error.code) {
    case "consent-denied":
      return new ConsentDeniedError(error.message, {
        googleError: error.googleError,
        googleErrorDescription: error.googleErrorDescription,
      })
    case "cancelled":
      return new OauthCancelledError()
    default:
      return new NetworkError(error.message, { cause: error })
  }
}

/**
 * Read the Gmail profile of the freshly authorized account to learn WHICH
 * Google account connected (the consent response itself carries no email).
 */
export async function fetchGmailProfile(
  accessToken: string,
  fetchImpl: FetchImpl = fetch
): Promise<GmailProfile> {
  let response: Response
  try {
    response = await fetchImpl(GMAIL_PROFILE_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  } catch (error) {
    throw new NetworkError(
      "Could not reach Gmail to identify the account. Check your " +
        "connection and try again.",
      { cause: error }
    )
  }
  if (!response.ok) {
    throw new NetworkError(
      `Gmail did not confirm the account (status ${response.status}).`
    )
  }
  const profile = (await response.json()) as {
    emailAddress?: unknown
  }
  if (typeof profile.emailAddress !== "string" || !profile.emailAddress) {
    throw new NetworkError(
      "Gmail's profile response did not include an email address."
    )
  }
  return { emailAddress: profile.emailAddress }
}

/**
 * The code exchange maps raw token-endpoint failures onto the flow's error
 * taxonomy. token-manager formats `status (<google-error>)` — the google
 * error code is re-extracted here instead of leaking token machinery.
 */
async function exchangeWithMappedErrors(
  clientId: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  fetchImpl: FetchImpl
): Promise<{
  accessToken: string
  refreshToken: string
  expiresIn: number
  scope: string
}> {
  try {
    return await exchangeCodeForTokens(
      clientId,
      code,
      codeVerifier,
      redirectUri,
      fetchImpl
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/\(invalid_client\)/.test(message)) {
      throw new InvalidClientIdError()
    }
    throw new NetworkError(
      "The sign-in could not be completed with Google. Please try again.",
      { cause: error }
    )
  }
}

/**
 * Add a Gmail account end to end. Resolves with the new account id only
 * after the row is persisted and the store reloaded; the initial sync is
 * started in the background (the dialog closes without waiting for it).
 */
export async function addGmailAccount(
  options: AddGmailOptions
): Promise<AddGmailResult> {
  const { clientId, loginHint, onProgress, fetchImpl = fetch } = options

  // 1. Browser consent: opens the system browser and waits on the
  //    loopback server. All cancellations/denials surface here.
  onProgress?.("consent")
  const consent = await runGoogleConsent({ clientId, loginHint }).catch(
    (error: unknown) => {
      throw error instanceof OauthFlowError
        ? mapOauthFlowError(error)
        : new NetworkError("Sign-in failed. Please try again.", {
            cause: error,
          })
    }
  )

  // 2. Exchange the authorization code (PKCE) for tokens. A refresh
  //    token is guaranteed by access_type=offline + prompt=consent.
  onProgress?.("exchange")
  const tokens = await exchangeWithMappedErrors(
    clientId,
    consent.code,
    consent.codeVerifier,
    consent.redirectUri,
    fetchImpl
  )

  // 3. Identify the account via the Gmail API.
  onProgress?.("profile")
  const profile = await fetchGmailProfile(tokens.accessToken, fetchImpl)

  // 4. Persist: encrypted OAuth envelope (GmailTokenEnvelope shape) plus
  //    the account row. gmail_history_id stays null so the first sync is
  //    a full sync.
  onProgress?.("save")
  const credentialsJson = await encryptCredentials({
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: Date.now() + tokens.expiresIn * 1000,
  })
  // Bound lazily: the consent/exchange/profile paths above never touch
  // the production database binding.
  const row = await insertAccount(options.executor ?? getExecutor(), {
    type: "gmail",
    email: profile.emailAddress,
    credentialsJson,
    oauthScope: tokens.scope,
    oauthClientId: clientId,
  })

  // 5. Refresh the switcher now; initial sync in the background.
  await useAccountStore.getState().reload()
  void triggerRefresh(row.id).catch((error: unknown) => {
    console.warn(
      `[add-gmail] initial sync for ${row.id} failed to start`,
      error
    )
  })

  return { accountId: row.id, email: profile.emailAddress }
}
