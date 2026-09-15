import type { FetchImpl } from "../email/token-manager"
import {
  clearGmailTokenCache,
  exchangeCodeForTokens,
} from "../email/token-manager"
import type { SqlExecutor } from "../db/executor"
import { getExecutor } from "../db/executor"
import { getAccount, updateCredentials, updateStatus } from "../db/accounts"
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
  ImapTestFailedError,
  SmtpTestFailedError,
  testImapSettings,
  testSmtpSettings,
} from "./add-imap"
import type { ImapTestConfig } from "./add-imap"
import { OauthFlowError, runGoogleConsent } from "./oauth-pkce"

/**
 * Re-authentication orchestrators (task 5.6, accounts spec "Runtime
 * credential failures and re-authentication").
 *
 * When the scheduler flags an account "auth-error" (a revoked Gmail
 * refresh token, a changed IMAP password), these flows restore access
 * WITHOUT deleting the account or any of its local mail data:
 *
 * - reauthGmailAccount: reruns the exact PKCE consent → code-exchange
 *   round-trip of the add flow, then rotates the encrypted OAuth
 *   envelope and flips the status back to "active". No insert, no
 *   profile read — the account's identity is already known; the consent
 *   pre-fills Google's account chooser with the account's own address
 *   so the user re-authorizes the same account.
 * - reauthImapPassword: re-tests BOTH the IMAP and the SMTP connection
 *   against the account's stored server settings with the new password
 *   (mandatory test-before-save, accounts spec "Connection test fails"),
 *   then stores the new encrypted envelope and reactivates the account.
 *
 * After either success the store reloads and the scheduler gets a
 * fire-and-forget triggerRefresh(accountId) so syncing resumes
 * immediately; the account row's status = "active" makes the next
 * scheduled pass pick it up again regardless.
 *
 * Error taxonomy mirrors add-gmail (ConsentDeniedError /
 * InvalidClientIdError / OauthCancelledError / NetworkError) and add-imap
 * (ImapTestFailedError / SmtpTestFailedError), plus AccountNotFoundError
 * and AccountTypeError for a stale or mismatched dialog target.
 *
 * Credential hygiene: passwords/tokens never appear in errors or logs;
 * only the AES-256-GCM envelope is persisted.
 */

/** The account row disappeared (removed while the dialog was open). */
export class AccountNotFoundError extends Error {
  constructor(accountId: string) {
    super("This account no longer exists.")
    this.name = "AccountNotFoundError"
    this.accountId = accountId
  }
  readonly accountId: string
}

/** The dialog target's type does not match the flow being run. */
export class AccountTypeError extends Error {
  constructor(expected: string, actual: string) {
    super(
      `This flow expects a ${expected} account, but the account is ` +
        `${actual}.`
    )
    this.name = "AccountTypeError"
  }
}

async function loadAccountOfType(
  executor: SqlExecutor,
  accountId: string,
  type: "gmail" | "imap"
): Promise<{ email: string }> {
  const row = await getAccount(executor, accountId)
  if (!row) throw new AccountNotFoundError(accountId)
  if (row.type !== type) throw new AccountTypeError(type, row.type)
  return { email: row.email }
}

async function finishReauth(
  executor: SqlExecutor,
  accountId: string,
  credentialsJson: string
): Promise<void> {
  await updateCredentials(executor, accountId, credentialsJson)
  await updateStatus(executor, accountId, "active")
  // The switcher drops the warning glyph immediately; the account is
  // eligible for the scheduler again (listActiveAccounts filters on
  // status "active").
  await useAccountStore.getState().reload()
  // Fire-and-forget: sync resumes now instead of waiting for the next
  // 60s tick. Failures only mean the sync waits for the tick.
  void triggerRefresh(accountId).catch((error: unknown) => {
    console.warn(
      `[reauth] resync for account ${accountId} failed to start`,
      error
    )
  })
}

// ---------------------------------------------------------------------------
// Gmail: rerun the OAuth consent
// ---------------------------------------------------------------------------

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

/** Same failure mapping as the add flow's exchange step. */
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

export interface ReauthGmailOptions {
  /** The Google OAuth Client ID the consent round-trip uses. */
  clientId: string
  /** Step callbacks so the UI can show progress. */
  onProgress?: (step: GmailFlowStep) => void
  /** Test seams (vitest); production uses the defaults. */
  fetchImpl?: FetchImpl
  executor?: SqlExecutor
}

export interface ReauthResult {
  accountId: string
  email: string
}

/**
 * Re-authorize an existing Gmail account: browser consent → PKCE code
 * exchange → rotate the encrypted OAuth envelope → status "active". The
 * row is updated in place — no second account is created and local mail
 * data is untouched.
 */
export async function reauthGmailAccount(
  accountId: string,
  options: ReauthGmailOptions
): Promise<ReauthResult> {
  const { clientId, onProgress, fetchImpl = fetch } = options
  const executor = options.executor ?? getExecutor()
  const { email } = await loadAccountOfType(executor, accountId, "gmail")

  // 1. Browser consent, login_hint pinned to this account's own address.
  onProgress?.("consent")
  const consent = await runGoogleConsent({
    clientId,
    loginHint: email,
  }).catch((error: unknown) => {
    throw error instanceof OauthFlowError
      ? mapOauthFlowError(error)
      : new NetworkError("Sign-in failed. Please try again.", { cause: error })
  })

  // 2. Exchange the authorization code; a fresh refresh token is
  //    guaranteed by access_type=offline + prompt=consent.
  onProgress?.("exchange")
  const tokens = await exchangeWithMappedErrors(
    clientId,
    consent.code,
    consent.codeVerifier,
    consent.redirectUri,
    fetchImpl
  )

  // 3. Rotate the envelope in place and reactivate. No profile read and
  //    no insert: the account keeps its id, mail data and history cursor.
  onProgress?.("save")
  const credentialsJson = await encryptCredentials({
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: Date.now() + tokens.expiresIn * 1000,
  })
  // Any cached access token minted from the old grant is now stale.
  clearGmailTokenCache(accountId)
  await finishReauth(executor, accountId, credentialsJson)

  return { accountId, email }
}

// ---------------------------------------------------------------------------
// IMAP: re-enter the password with a mandatory double connection test
// ---------------------------------------------------------------------------

export interface ReauthImapOptions {
  executor?: SqlExecutor
}

/**
 * Store a new password for an existing IMAP/SMTP account. The IMAP and
 * SMTP connection tests run against the account's STORED host/port/
 * security settings — a failing test throws the typed per-side error and
 * nothing is written (the old credentials keep failing, the account
 * stays paused). On success the new encrypted envelope replaces the old
 * one and the account reactivates.
 */
export async function reauthImapPassword(
  accountId: string,
  newPassword: string,
  options: ReauthImapOptions = {}
): Promise<ReauthResult> {
  const executor = options.executor ?? getExecutor()
  const row = await getAccount(executor, accountId)
  if (!row) throw new AccountNotFoundError(accountId)
  if (row.type !== "imap") throw new AccountTypeError("imap", row.type)
  if (
    !row.imap_host ||
    !row.imap_port ||
    !row.imap_security ||
    !row.smtp_host ||
    !row.smtp_port ||
    !row.smtp_security
  ) {
    throw new NetworkError(
      "This account has no stored server settings; " +
        "remove it and add it again."
    )
  }
  const config: ImapTestConfig = {
    email: row.email,
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    imapSecurity: row.imap_security,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpSecurity: row.smtp_security,
  }

  await testImapSettings(config, newPassword).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    throw new ImapTestFailedError(message)
  })
  await testSmtpSettings(config, newPassword).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    throw new SmtpTestFailedError(message)
  })

  const credentialsJson = await encryptCredentials({ password: newPassword })
  await finishReauth(executor, accountId, credentialsJson)

  return { accountId, email: row.email }
}
