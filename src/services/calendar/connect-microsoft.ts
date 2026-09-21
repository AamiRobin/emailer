import { decryptCredentials, encryptCredentials } from "../crypto/credentials"
import { getAccount } from "../db/accounts"
import type { SqlExecutor } from "../db/executor"
import { getExecutor } from "../db/executor"
import { exchangeMicrosoftCodeForTokens } from "../email/microsoft-token-manager"
import type { FetchImpl } from "../email/token-manager"
import {
  MICROSOFT_CALENDAR_SCOPES,
  OauthFlowError,
  runMicrosoftConsent,
} from "../account-flows/microsoft-oauth"
import {
  createMicrosoftCalendarTokens,
  listMicrosoftCalendars,
} from "./microsoft-calendar"
import type { MicrosoftCalendarListEntry } from "./microsoft-calendar"
import { addCalendarSource } from "./sources"
import type { CalendarSource } from "./sources"

/**
 * Microsoft Graph calendar connect (parity-round-2 task 3.6): one FRESH
 * consent round through the same Entra loopback driver as the mail flow,
 * requesting ONLY the calendar scope set, then the resulting tokens sealed
 * into the new calendar source's config envelope.
 *
 * Why a SECOND consent (and not the mail account's stored refresh token):
 * Entra binds every refresh token to the scope set of the consent that
 * produced it — silently refreshing the mail envelope yields access tokens
 * WITHOUT the calendar grant, so Graph would reject them. The separate
 * calendar consent (`Calendar.ReadWrite User.Read offline_access`, design
 * D2) mints a refresh token whose scope set actually covers the calendar,
 * and that envelope is stored per SOURCE, sealed with encryptCredentials
 * (AES-256-GCM, the accounts.credentials_json pattern; the exact Google
 * calendar re-consent rationale). Unlike Google, Entra also ROTATES
 * refresh tokens — microsoft-calendar.ts wires the rotation re-seal back
 * into the source row. Plaintext tokens are never persisted and never
 * logged; the sealing point is marked below. Because the envelope lives on
 * the source row, removing a calendar source discards only calendar
 * credentials — the mail account's stored envelope is never touched (spec:
 * removing a source SHALL NOT affect mail).
 */

/** The calendar-connect consent round requests the calendar scope set
 * (offline_access included so the grant yields a refresh token). */
export const MICROSOFT_CALENDAR_CONNECT_SCOPES = MICROSOFT_CALENDAR_SCOPES

/** The user closed/cancelled the consent dialog — a quiet no-op. */
export class MicrosoftCalendarConnectCancelledError extends Error {
  constructor() {
    super("Calendar sign-in was cancelled.")
    this.name = "MicrosoftCalendarConnectCancelledError"
  }
}

/** The user denied the (calendar-bearing) consent on Microsoft's screen. */
export class MicrosoftCalendarConsentDeniedError extends Error {
  readonly microsoftError?: string
  readonly microsoftErrorDescription?: string

  constructor(
    message: string,
    options?: {
      microsoftError?: string
      microsoftErrorDescription?: string
    }
  ) {
    super(message)
    this.name = "MicrosoftCalendarConsentDeniedError"
    this.microsoftError = options?.microsoftError
    this.microsoftErrorDescription = options?.microsoftErrorDescription
  }
}

/**
 * Microsoft did not actually grant the calendar scope (e.g. a work/school
 * admin policy). Nothing is persisted — the connection reporting calls
 * for this specific failure rather than a generic error.
 */
export class MicrosoftCalendarScopeNotGrantedError extends Error {
  constructor() {
    super(
      "Microsoft did not grant calendar access for this account. If it is " +
        "a work or school account, calendar access may be disabled by " +
        "administrator policy."
    )
    this.name = "MicrosoftCalendarScopeNotGrantedError"
  }
}

/** Environmental failure (timeout, loopback, state mismatch, network). */
export class MicrosoftCalendarConnectError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined
    )
    this.name = "MicrosoftCalendarConnectError"
  }
}

export interface ConnectMicrosoftCalendarOptions {
  /** The connected Microsoft 365 mail account whose calendar is added. */
  accountId: string
  /**
   * The Entra public client id. Defaults to the account's stored
   * oauth_client_id — the same registration the mail flow used.
   */
  clientId?: string
  /** Pre-fills Entra's account chooser with the account's email. */
  loginHint?: string
  /** Test seams (vitest); production uses the defaults. */
  executor?: SqlExecutor
  fetchImpl?: FetchImpl
  /** Overrides the consent driver wholesale (connect-flow tests). */
  runConsent?: typeof runMicrosoftConsent
}

export interface ConnectMicrosoftCalendarResult {
  sourceId: string
  accountId: string
  /** Calendars discovered right after connecting (discovery preview). */
  calendars: MicrosoftCalendarListEntry[]
}

/**
 * Connect a Microsoft account's calendar end to end: consent (calendar
 * scope set) → code exchange → scope verification → sealed envelope →
 * source row → discovery preview. Nothing is persisted before the exchange
 * has produced a refresh token, mirroring the add-microsoft flow.
 */
export async function connectMicrosoftCalendar(
  options: ConnectMicrosoftCalendarOptions
): Promise<ConnectMicrosoftCalendarResult> {
  const executor = options.executor ?? getExecutor()
  const fetchImpl = options.fetchImpl ?? fetch
  const account = await getAccount(executor, options.accountId)
  if (!account) {
    throw new MicrosoftCalendarConnectError(
      `account ${options.accountId} not found`
    )
  }
  if (account.type !== "microsoft") {
    throw new MicrosoftCalendarConnectError(
      "Calendar sources connect from a Microsoft 365 account"
    )
  }
  const clientId = options.clientId ?? account.oauth_client_id
  if (!clientId) {
    throw new MicrosoftCalendarConnectError(
      "The connected Microsoft account has no OAuth client id configured"
    )
  }

  // 1. Consent round with the calendar scope set (design D2). All
  //    cancellations/denials surface here; nothing has been persisted yet.
  //    login_hint pins the SAME account the mail flow authorized while an
  //    existing browser session can still flow through.
  const driveConsent = options.runConsent ?? runMicrosoftConsent
  let consent: Awaited<ReturnType<typeof runMicrosoftConsent>>
  try {
    consent = await driveConsent({
      clientId,
      scopes: MICROSOFT_CALENDAR_CONNECT_SCOPES,
      loginHint: options.loginHint ?? account.email,
    })
  } catch (error) {
    if (error instanceof OauthFlowError) {
      if (error.code === "cancelled") {
        throw new MicrosoftCalendarConnectCancelledError()
      }
      if (error.code === "consent-denied") {
        throw new MicrosoftCalendarConsentDeniedError(error.message, {
          microsoftError: error.providerError,
          microsoftErrorDescription: error.providerErrorDescription,
        })
      }
    }
    throw new MicrosoftCalendarConnectError(
      "Connecting the calendar failed. Please try again.",
      { cause: error }
    )
  }

  // 2. Exchange the authorization code for a calendar-scoped token set.
  let tokens: Awaited<ReturnType<typeof exchangeMicrosoftCodeForTokens>>
  try {
    tokens = await exchangeMicrosoftCodeForTokens(
      clientId,
      consent.code,
      consent.codeVerifier,
      consent.redirectUri,
      fetchImpl
    )
  } catch (error) {
    throw new MicrosoftCalendarConnectError(
      "Microsoft did not complete the calendar sign-in. Please try again.",
      { cause: error }
    )
  }

  // 3. Verify the grant: Entra echoes the granted scopes in the token
  //    response. If the calendar scope is missing (policy), fail
  //    specifically and persist nothing.
  if (!tokens.scope.split(" ").includes("Calendar.ReadWrite")) {
    throw new MicrosoftCalendarScopeNotGrantedError()
  }

  // 4. Discover the calendars (spec: connection discovers the available
  //    calendars) — also validates the fresh token before anything is
  //    stored.
  let calendars: MicrosoftCalendarListEntry[]
  try {
    calendars = await listMicrosoftCalendars(
      {
        accountId: account.id,
        getToken: () => Promise.resolve(tokens.accessToken),
      },
      fetchImpl
    )
  } catch (error) {
    throw new MicrosoftCalendarConnectError(
      "Connected, but the calendar list could not be read. Please try again.",
      { cause: error }
    )
  }

  // 5. SEAL the calendar token envelope (AES-256-GCM) and persist the
  //    source. Sealing point: refreshToken/accessToken live only in memory
  //    before this call and only as ciphertext afterwards; config_json is
  //    decrypted exclusively through crypto/credentials. The client id
  //    rides inside the envelope so the source is self-contained for
  //    silent refresh + rotation re-sealing (see microsoft-calendar.ts).
  const configJson = await encryptCredentials({
    // The calendar consent's own refresh token — NOT the mail account's
    // (scope-set-bound; see the module comment).
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: Date.now() + tokens.expiresIn * 1000,
    clientId,
  })
  const source = await addCalendarSource(executor, {
    id: crypto.randomUUID(),
    accountId: account.id,
    provider: "microsoft",
    name: account.email,
    configJson,
  })

  return { sourceId: source.id, accountId: account.id, calendars }
}

// ---------------------------------------------------------------------------
// Connection test for a STORED source (spec: success or a specific failure)
// ---------------------------------------------------------------------------

/**
 * Connection test for a stored Microsoft source: decrypts the envelope,
 * performs one silent refresh if needed (rotation re-seals best-effort),
 * and lists the calendars. Errors map onto the shared specific reasons;
 * token values never appear in the detail text.
 */
export async function testMicrosoftStoredConnection(
  source: CalendarSource,
  executor: SqlExecutor,
  fetchImpl: FetchImpl = fetch
): Promise<
  | {
      ok: true
      provider: "microsoft"
      calendars: MicrosoftCalendarListEntry[]
    }
  | {
      ok: false
      provider: "microsoft"
      reason:
        | "auth"
        | "no-credentials"
        | "api"
        | "config"
        | "network"
      detail?: string
    }
> {
  let envelope: { refreshToken?: string } | null
  try {
    envelope = await decryptCredentials<{ refreshToken?: string }>(
      source.configJson
    )
  } catch {
    envelope = null
  }
  if (!envelope?.refreshToken) {
    return {
      ok: false,
      provider: "microsoft",
      reason: "no-credentials",
      detail: "No stored calendar credentials; re-connect the source",
    }
  }

  let tokens
  try {
    tokens = await createMicrosoftCalendarTokens(executor, source, fetchImpl)
  } catch {
    return {
      ok: false,
      provider: "microsoft",
      reason: "no-credentials",
      detail: "No usable stored calendar credentials",
    }
  }

  try {
    const calendars = await listMicrosoftCalendars(tokens, fetchImpl)
    return { ok: true, provider: "microsoft", calendars }
  } catch (error) {
    const name = error instanceof Error ? error.name : ""
    const status =
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : undefined
    if (name === "ProviderAuthError") {
      return {
        ok: false,
        provider: "microsoft",
        reason: "auth",
        detail: "Microsoft rejected the stored calendar grant",
      }
    }
    if (typeof status === "number") {
      return {
        ok: false,
        provider: "microsoft",
        reason: "api",
        detail: `Microsoft Graph responded with status ${status}`,
      }
    }
    return {
      ok: false,
      provider: "microsoft",
      reason: "network",
      detail: "Microsoft Graph could not be reached",
    }
  }
}
