import { decryptCredentials, encryptCredentials } from "../crypto/credentials"
import { getAccount } from "../db/accounts"
import type { SqlExecutor } from "../db/executor"
import { getExecutor } from "../db/executor"
import { exchangeCodeForTokens } from "../email/token-manager"
import type { FetchImpl } from "../email/token-manager"
import { OauthFlowError, runGoogleConsent } from "../account-flows/oauth-pkce"
import { GMAIL_SCOPES, GOOGLE_CALENDAR_SCOPE } from "../account-flows/oauth-pkce"
import {
  CaldavProviderError,
  testCaldavConnection,
} from "./caldav"
import type { CaldavDiscoveredCalendar, CaldavSourceConfig } from "./caldav"
import { createCalendarTokens, listCalendars } from "./google-calendar"
import type { GoogleCalendarListEntry } from "./google-calendar"
import { testMicrosoftStoredConnection } from "./connect-microsoft"
import type { MicrosoftCalendarListEntry } from "./microsoft-calendar"
import { addCalendarSource, getCalendarSource } from "./sources"
import type { CalendarSource } from "./sources"

/**
 * Google calendar connect (task 5.1, design D5): one fresh OAuth consent
 * round through the EXISTING loopback flow, with the calendar scope
 * requested ADDITIONALLY to the mail scopes, then the resulting tokens
 * sealed into the new calendar source's config envelope.
 *
 * Why a NEW consent (and not the mail account's stored refresh token):
 * Google refresh tokens are bound to the scope set of the consent that
 * produced them — silently refreshing the mail envelope would yield access
 * tokens WITHOUT the calendar grant, so the API rejects them. The consent
 * round therefore requests mail + calendar (prompt=consent always returns a
 * fresh refresh token), and that calendar envelope is stored per SOURCE,
 * sealed with encryptCredentials (AES-256-GCM, the accounts.credentials_json
 * pattern). Plaintext tokens are never persisted and never logged; the
 * sealing point is marked below. Because the envelope lives on the source
 * row, removing a calendar source discards only calendar credentials — the
 * mail account's stored envelope is never touched (spec: removing a source
 * SHALL NOT affect mail).
 *
 * Scope guarantee: GMAIL_SCOPES (the mail flow's list) never contains the
 * calendar scope; the mail path passes no `scopes` at all, so its
 * authorization URL is built exactly as before (see oauth-pkce.ts and its
 * tests — the mail-OAuth-never-requests-calendar guarantee lives where the
 * URL is built, TS-side).
 */

/** The calendar-connect consent round requests the mail scopes plus the
 * calendar scope (design D5: "requested additionally"). */
export const CALENDAR_CONNECT_SCOPES: string[] = [
  ...GMAIL_SCOPES,
  GOOGLE_CALENDAR_SCOPE,
]

/** The user closed/cancelled the consent dialog — a quiet no-op. */
export class CalendarConnectCancelledError extends Error {
  constructor() {
    super("Calendar sign-in was cancelled.")
    this.name = "CalendarConnectCancelledError"
  }
}

/** The user denied the (calendar-bearing) consent on Google's screen. */
export class CalendarConsentDeniedError extends Error {
  readonly googleError?: string
  readonly googleErrorDescription?: string

  constructor(
    message: string,
    options?: { googleError?: string; googleErrorDescription?: string }
  ) {
    super(message)
    this.name = "CalendarConsentDeniedError"
    this.googleError = options?.googleError
    this.googleErrorDescription = options?.googleErrorDescription
  }
}

/**
 * Google did not actually grant the calendar scope (e.g. a Workspace admin
 * policy). Nothing is persisted — the spec's connection reporting calls for
 * this specific failure rather than a generic error.
 */
export class CalendarScopeNotGrantedError extends Error {
  constructor() {
    super(
      "Google did not grant calendar access for this account. If it is " +
        "managed (Workspace), calendar sharing may be disabled by policy."
    )
    this.name = "CalendarScopeNotGrantedError"
  }
}

/** Environmental failure (timeout, loopback, state mismatch, network). */
export class CalendarConnectError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(
      message,
      options?.cause !== undefined ? { cause: options.cause } : undefined
    )
    this.name = "CalendarConnectError"
  }
}

export interface ConnectGoogleCalendarOptions {
  /** The mail account whose calendar is being connected. */
  accountId: string
  /**
   * The Google OAuth client id (type "Desktop app"). Defaults to the
   * account's stored oauth_client_id — the same client the mail flow used.
   */
  clientId?: string
  /** Pre-fills Google's account chooser with the account's email. */
  loginHint?: string
  /** Test seams (vitest); production uses the defaults. */
  executor?: SqlExecutor
  fetchImpl?: FetchImpl
  /** Overrides the consent driver wholesale (connect-flow tests). */
  runConsent?: typeof runGoogleConsent
}

export interface ConnectGoogleCalendarResult {
  sourceId: string
  accountId: string
  /** Calendar IDs discovered right after connecting (discovery preview). */
  calendars: GoogleCalendarListEntry[]
}

/**
 * Connect a Google account's calendar end to end: consent (calendar scope
 * added) → code exchange → scope verification → sealed envelope → source
 * row → discovery preview. Nothing is persisted before the exchange has
 * produced a refresh token, mirroring the add-gmail flow.
 */
export async function connectGoogleCalendar(
  options: ConnectGoogleCalendarOptions
): Promise<ConnectGoogleCalendarResult> {
  const executor = options.executor ?? getExecutor()
  const fetchImpl = options.fetchImpl ?? fetch
  const account = await getAccount(executor, options.accountId)
  if (!account) {
    throw new CalendarConnectError(
      `account ${options.accountId} not found`
    )
  }
  const clientId = options.clientId ?? account.oauth_client_id
  if (!clientId) {
    throw new CalendarConnectError(
      "The connected Gmail account has no OAuth client id configured"
    )
  }

  // 1. Consent round with the calendar scope ADDED (design D5). All
  //    cancellations/denials surface here; nothing has been persisted yet.
  const driveConsent = options.runConsent ?? runGoogleConsent
  let consent: Awaited<ReturnType<typeof runGoogleConsent>>
  try {
    consent = await driveConsent({
      clientId,
      scopes: CALENDAR_CONNECT_SCOPES,
      loginHint: options.loginHint ?? account.email,
    })
  } catch (error) {
    if (error instanceof OauthFlowError) {
      if (error.code === "cancelled") {
        throw new CalendarConnectCancelledError()
      }
      if (error.code === "consent-denied") {
        throw new CalendarConsentDeniedError(error.message, {
          googleError: error.googleError,
          googleErrorDescription: error.googleErrorDescription,
        })
      }
    }
    throw new CalendarConnectError(
      "Connecting the calendar failed. Please try again.",
      { cause: error }
    )
  }

  // 2. Exchange the authorization code for a calendar-scoped token set.
  let tokens: Awaited<ReturnType<typeof exchangeCodeForTokens>>
  try {
    tokens = await exchangeCodeForTokens(
      clientId,
      consent.code,
      consent.codeVerifier,
      consent.redirectUri,
      fetchImpl
    )
  } catch (error) {
    throw new CalendarConnectError(
      "Google did not complete the calendar sign-in. Please try again.",
      { cause: error }
    )
  }

  // 3. Verify the grant: Google echoes the granted scopes in both the
  //    redirect's scope parameter and the token response. If the calendar
  //    scope is missing (policy), fail specifically and persist nothing.
  if (!tokens.scope.split(" ").includes(GOOGLE_CALENDAR_SCOPE)) {
    throw new CalendarScopeNotGrantedError()
  }

  // 4. Discover the calendars (spec: connection discovers the available
  //    calendars) — also validates the fresh token before anything is
  //    stored.
  let calendars: GoogleCalendarListEntry[]
  try {
    calendars = await listCalendars(
      {
        accountId: account.id,
        getToken: () => Promise.resolve(tokens.accessToken),
      },
      fetchImpl
    )
  } catch (error) {
    throw new CalendarConnectError(
      "Connected, but the calendar list could not be read. Please try again.",
      { cause: error }
    )
  }

  // 5. SEAL the calendar token envelope (AES-256-GCM) and persist the
  //    source. Sealing point: refreshToken/accessToken live only in memory
  //    before this call and only as ciphertext afterwards; config_json is
  //    decrypted exclusively through crypto/credentials.
  const configJson = await encryptCredentials({
    // The calendar consent's own refresh token — NOT the mail account's
    // (scope-set-bound; see the module comment).
    refreshToken: tokens.refreshToken,
    accessToken: tokens.accessToken,
    accessTokenExpiresAt: Date.now() + tokens.expiresIn * 1000,
    // Same desktop client as the mail flow; stored inside the envelope so
    // the source is self-contained for silent refresh.
    clientId,
  })
  const source = await addCalendarSource(executor, {
    id: crypto.randomUUID(),
    accountId: account.id,
    provider: "google",
    name: account.email,
    configJson,
  })

  return { sourceId: source.id, accountId: account.id, calendars }
}

// ---------------------------------------------------------------------------
// Connection test (spec: reports success or a specific failure reason)
// ---------------------------------------------------------------------------

export type CalendarConnectionFailure =
  /** The stored calendar grant no longer works (revoked/expired), or the
   * CalDAV server rejected the stored username/app password. */
  | "auth"
  /** The source has no usable stored credentials (never connected fully). */
  | "no-credentials"
  /** The server/endpoint rejected the request for a non-auth reason. */
  | "api"
  /** The stored connection details are unusable (e.g. a malformed URL). */
  | "config"
  /** The request could not reach the server at all. */
  | "network"
  /** Provider exists in the schema but its client lands in a later task. */
  | "unsupported"

export type CalendarConnectionTestResult =
  | {
      ok: true
      provider: "google"
      calendars: GoogleCalendarListEntry[]
    }
  | {
      ok: true
      provider: "caldav"
      /** The discovered calendars (discovery preview, task 5.2). */
      calendars: CaldavDiscoveredCalendar[]
    }
  | {
      ok: true
      provider: "microsoft"
      calendars: MicrosoftCalendarListEntry[]
    }
  | {
      ok: false
      provider: "google" | "caldav" | "microsoft"
      reason: CalendarConnectionFailure
      detail?: string
    }

/**
 * Connection test for a stored source (spec: "A connection test SHALL
 * report success or a specific failure reason"): decrypts the envelope,
 * performs one silent refresh if needed, and lists the calendars. Errors
 * map to specific reasons; token values never appear in the detail text.
 */
export async function testCalendarConnection(
  executor: SqlExecutor,
  sourceId: string,
  fetchImpl: FetchImpl = fetch
): Promise<CalendarConnectionTestResult> {
  const source: CalendarSource | null = await getCalendarSource(
    executor,
    sourceId
  )
  if (!source) {
    return {
      ok: false,
      provider: "caldav",
      reason: "no-credentials",
      detail: "Calendar source not found",
    }
  }
  if (source.provider === "microsoft") {
    return testMicrosoftStoredConnection(source, executor, fetchImpl)
  }
  if (source.provider !== "google") {
    return testCaldavStoredConnection(source)
  }

  let tokens
  try {
    tokens = await createCalendarTokens(source, fetchImpl)
  } catch {
    return {
      ok: false,
      provider: "google",
      reason: "no-credentials",
      detail: "No usable stored calendar credentials",
    }
  }

  try {
    const calendars = await listCalendars(tokens, fetchImpl)
    return { ok: true, provider: "google", calendars }
  } catch (error) {
    const name = error instanceof Error ? error.name : ""
    const status =
      typeof (error as { status?: unknown }).status === "number"
        ? (error as { status: number }).status
        : undefined
    if (name === "ProviderAuthError") {
      return {
        ok: false,
        provider: "google",
        reason: "auth",
        detail: "Google rejected the stored calendar grant",
      }
    }
    if (typeof status === "number") {
      return {
        ok: false,
        provider: "google",
        reason: "api",
        detail: `Google Calendar responded with status ${status}`,
      }
    }
    return {
      ok: false,
      provider: "google",
      reason: "network",
      detail: "Google Calendar could not be reached",
    }
  }
}

/**
 * CalDAV connection test for a STORED source (task 5.2): unseals the
 * envelope and runs one PROPFIND through the `caldav_test_connection`
 * command with the credentials passed PER CALL (the caldav.ts contract —
 * plaintext exists only for this invoke, is never logged, and the Rust
 * side redacts it from errors). Failures map onto the shared specific
 * reasons: 401/403 → "auth", no transport → "network", everything else →
 * "api"/"config" with the redacted Rust message as the detail.
 */
async function testCaldavStoredConnection(
  source: CalendarSource
): Promise<CalendarConnectionTestResult> {
  let envelope: CaldavSourceConfig | null
  try {
    envelope = await decryptCredentials<CaldavSourceConfig>(source.configJson)
  } catch {
    envelope = null
  }
  if (
    !envelope?.serverUrl ||
    !envelope.username ||
    !envelope.appPassword
  ) {
    return {
      ok: false,
      provider: "caldav",
      reason: "no-credentials",
      detail: "No stored CalDAV connection details; re-connect the source",
    }
  }
  const credentials = {
    serverUrl: envelope.serverUrl,
    username: envelope.username,
    appPassword: envelope.appPassword,
  }
  try {
    await testCaldavConnection(credentials)
    return { ok: true, provider: "caldav", calendars: [] }
  } catch (error) {
    const providerError =
      error instanceof CaldavProviderError
        ? error
        : new CaldavProviderError(
            "network",
            error instanceof Error ? error.message : String(error)
          )
    if (providerError.kind === "status" && (providerError.status === 401 || providerError.status === 403)) {
      return {
        ok: false,
        provider: "caldav",
        reason: "auth",
        detail: providerError.message,
      }
    }
    if (providerError.kind === "network") {
      return {
        ok: false,
        provider: "caldav",
        reason: "network",
        detail: providerError.message,
      }
    }
    return {
      ok: false,
      provider: "caldav",
      reason: providerError.kind === "config" ? "config" : "api",
      detail: providerError.message,
    }
  }
}
