import type { FetchImpl } from "../email/token-manager"
import { exchangeMicrosoftCodeForTokens } from "../email/microsoft-token-manager"
import type { SqlExecutor } from "../db/executor"
import { getExecutor } from "../db/executor"
import { insertAccount } from "../db/accounts"
import { encryptCredentials } from "../crypto/credentials"
import { useAccountStore } from "../../stores/account-store"
import { triggerRefresh } from "../sync/scheduler"
import {
  ConsentDeniedError,
  InvalidClientIdError,
  NetworkError,
  OauthCancelledError,
} from "./add-gmail"
import type { GmailFlowStep } from "./add-gmail"
import {
  MicrosoftMailScopeNotGrantedError,
  missingMailScopes,
  OauthFlowError,
  runMicrosoftConsent,
} from "./microsoft-oauth"

/**
 * Add-Microsoft 365 account orchestrator (parity-round-2 task 3.1,
 * accounts spec "Connect with consent" / "Custom client registration").
 *
 * End to end: PKCE setup → browser consent (Entra `common` authority,
 * system browser, loopback callback) → authorization-code exchange
 * (microsoft-token-manager) → Graph profile read (which account signed
 * in) → AES-256-GCM credentials envelope → account row → store reload →
 * initial sync. Nothing is persisted before the exchange has produced a
 * refresh token.
 *
 * Error taxonomy mirrors add-gmail exactly, so the dialog code and the
 * re-auth flows stay provider-agnostic:
 * - ConsentDeniedError  — user denied on Microsoft's screen.
 * - InvalidClientIdError — Entra rejected the client id (invalid_client);
 *   the user can fix the registration and retry.
 * - OauthCancelledError — the user cancelled locally; quiet no-op.
 * - NetworkError — everything else environmental.
 *
 * Credential hygiene: token values and the client id never appear in
 * error messages or logs.
 */

/** Graph profile read used to identify the authorized account. */
const GRAPH_ME_ENDPOINT = "https://graph.microsoft.com/v1.0/me"

export type MicrosoftFlowStep = GmailFlowStep

export interface MicrosoftProfile {
  /** The authorized account's SMTP address (or UPN). */
  mail: string
  displayName?: string
}

export interface AddMicrosoftOptions {
  /** The user's own Microsoft app registration's client id (public client). */
  clientId: string
  /** Optional login_hint for Entra's account chooser. */
  loginHint?: string
  /** Step callbacks so the UI can show progress. */
  onProgress?: (step: MicrosoftFlowStep) => void
  /** Test seams (vitest); production uses the defaults. */
  fetchImpl?: FetchImpl
  executor?: SqlExecutor
}

export interface AddMicrosoftResult {
  accountId: string
  email: string
}

function mapOauthFlowError(error: OauthFlowError): Error {
  switch (error.code) {
    case "consent-denied":
      return new ConsentDeniedError(error.message, {
        providerError: error.providerError,
        providerErrorDescription: error.providerErrorDescription,
      })
    case "cancelled":
      return new OauthCancelledError()
    default:
      return new NetworkError(error.message, { cause: error })
  }
}

/**
 * Read the Graph profile of the freshly authorized account to learn
 * WHICH Microsoft account connected (the consent response itself carries
 * no email).
 */
export async function fetchMicrosoftProfile(
  accessToken: string,
  fetchImpl: FetchImpl = fetch
): Promise<MicrosoftProfile> {
  let response: Response
  try {
    response = await fetchImpl(GRAPH_ME_ENDPOINT, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  } catch (error) {
    throw new NetworkError(
      "Could not reach Microsoft Graph to identify the account. Check " +
        "your connection and try again.",
      { cause: error }
    )
  }
  if (!response.ok) {
    throw new NetworkError(
      `Microsoft did not confirm the account (status ${response.status}).`
    )
  }
  const profile = (await response.json()) as {
    mail?: unknown
    userPrincipalName?: unknown
    displayName?: unknown
  }
  const mail =
    typeof profile.mail === "string" && profile.mail
      ? profile.mail
      : typeof profile.userPrincipalName === "string"
        ? profile.userPrincipalName
        : undefined
  if (!mail) {
    throw new NetworkError(
      "Microsoft's profile response did not include an email address."
    )
  }
  return {
    mail,
    displayName:
      typeof profile.displayName === "string" && profile.displayName
        ? profile.displayName
        : undefined,
  }
}

/**
 * The code exchange maps raw token-endpoint failures onto the flow's
 * error taxonomy. token-manager formats `status (<entra-error>)` — the
 * Entra error code is re-extracted here instead of leaking token
 * machinery. invalid_client means the registration is wrong/typed
 * wrong; invalid_grant means a code/verifier/redirect mismatch.
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
    return await exchangeMicrosoftCodeForTokens(
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
    if (/\(invalid_grant\)/.test(message)) {
      throw new NetworkError(
        "Microsoft rejected the sign-in result. Please try again.",
        { cause: error }
      )
    }
    throw new NetworkError(
      "The sign-in could not be completed with Microsoft. Please try again.",
      { cause: error }
    )
  }
}

/**
 * Add a Microsoft 365 account end to end. Resolves with the new account
 * id only after the row is persisted and the store reloaded; the initial
 * sync is started in the background (the dialog closes without waiting
 * for it).
 */
export async function addMicrosoftAccount(
  options: AddMicrosoftOptions
): Promise<AddMicrosoftResult> {
  const { clientId, loginHint, onProgress, fetchImpl = fetch } = options

  // 1. Browser consent: opens the system browser and waits on the
  //    loopback server. All cancellations/denials surface here.
  onProgress?.("consent")
  const consent = await runMicrosoftConsent({ clientId, loginHint }).catch(
    (error: unknown) => {
      throw error instanceof OauthFlowError
        ? mapOauthFlowError(error)
        : new NetworkError("Sign-in failed. Please try again.", {
            cause: error,
          })
    }
  )

  // 2. Exchange the authorization code (PKCE) for tokens. A refresh
  //    token is guaranteed by the offline_access scope in the grant.
  onProgress?.("exchange")
  const tokens = await exchangeWithMappedErrors(
    clientId,
    consent.code,
    consent.codeVerifier,
    consent.redirectUri,
    fetchImpl
  )

  // 3. Verify the grant: Entra echoes the GRANTED scopes in the token
  //    response. A work/school account with admin-denied mail scopes must
  //    fail here with the missing scope names — never store as "active"
  //    only to fail opaquely on every sync. Nothing has been persisted.
  const missing = missingMailScopes(tokens.scope)
  if (missing.length > 0) {
    throw new MicrosoftMailScopeNotGrantedError(missing)
  }

  // 4. Identify the account via Microsoft Graph.
  onProgress?.("profile")
  const profile = await fetchMicrosoftProfile(tokens.accessToken, fetchImpl)

  // 5. Persist: encrypted OAuth envelope (MicrosoftTokenEnvelope shape)
  //    plus the account row. The per-folder delta-link cursors start
  //    unset, so the first sync is a full pull.
  onProgress?.("save")
  const credentialsJson = await encryptCredentials({
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: Date.now() + tokens.expiresIn * 1000,
  })
  // Bound lazily: the consent/exchange/profile paths above never touch
  // the production database binding.
  const row = await insertAccount(options.executor ?? getExecutor(), {
    type: "microsoft",
    email: profile.mail,
    ...(profile.displayName ? { displayName: profile.displayName } : {}),
    credentialsJson,
    oauthScope: tokens.scope,
    oauthClientId: clientId,
  })

  // 6. Refresh the switcher now; initial sync in the background.
  await useAccountStore.getState().reload()
  void triggerRefresh(row.id).catch((error: unknown) => {
    console.warn(
      `[add-microsoft] initial sync for ${row.id} failed to start`,
      error
    )
  })

  return { accountId: row.id, email: profile.mail }
}
