import type { EmailAccount } from "./types"
import { ProviderAuthError } from "./types"
import type { FetchImpl } from "./token-manager"

/**
 * Microsoft (Entra ID) OAuth token manager (parity-round-2 task 3.1,
 * design D2): the Gmail token-manager pattern re-targeted at the Entra
 * `common`-authority v2.0 token endpoint.
 *
 * Silent refresh: POSTs `grant_type=refresh_token` with the public
 * client id (accounts.oauth_client_id) and the refresh token from the
 * decrypted credentials envelope. Access tokens are cached in memory per
 * account with a 60-second expiry margin — never persisted; only the
 * sealed envelope holds durable material.
 *
 * Entra differences from Google that this module owns:
 * - Refresh tokens ROTATE: a refresh grant usually returns a new refresh
 *   token. When the response carries one, the caller-provided `persist`
 *   hook re-seals the updated envelope into credentials_json (best
 *   effort — a persistence failure must not break the API call that
 *   triggered the refresh; the freshly returned token keeps working even
 *   if it was not re-sealed).
 * - A missing refresh token means the original consent omitted
 *   `offline_access` (the flow always requests it, so this surfaces only
 *   for envelopes saved by older builds).
 * - Error taxonomy: `invalid_grant` / `interaction_required` /
 *   `consent_required` (and AADSTS65001 in the description — admin
 *   consent revoked) map to ProviderAuthError with accountType
 *   "microsoft" so the scheduler's auth-error pause and the re-auth
 *   dialog treat them exactly like Gmail; `temporarily_unavailable` and
 *   `server_error` are TRANSIENT and surface as the retryable
 *   TransientTokenError instead of the re-auth state.
 * - Token responses are validated before anything is cached or sealed:
 *   expires_in clamped to [60s, 366 days], tokens non-empty, sane-length
 *   and control-character-free (InvalidTokenResponseError otherwise).
 *
 * Token values never appear in logs or error messages — errors carry
 * only the Entra error code and HTTP status.
 */

export const MICROSOFT_TOKEN_ENDPOINT =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token"

/**
 * Plaintext OAuth credentials envelope as stored in the encrypted
 * `credentials_json` column (same shape as the Gmail envelope: only the
 * refresh token is durable; access tokens live in the in-memory cache).
 */
export interface MicrosoftTokenEnvelope {
  refreshToken: string
  accessToken?: string
  /** unix epoch ms */
  accessTokenExpiresAt?: number
}

export interface ExchangedMicrosoftTokens {
  accessToken: string
  refreshToken: string
  /** seconds until the access token expires */
  expiresIn: number
  /** space-separated granted scopes */
  scope: string
}

/** The account fields the token manager needs. */
export type MicrosoftAccountRef = Pick<EmailAccount, "id" | "oauthClientId">

interface CachedToken {
  token: string
  /** unix epoch ms */
  expiresAtMs: number
}

/** In-memory cache, keyed by account id (never persisted). Separate from
 * the Gmail cache so the two providers' token lifecycles never interact. */
const tokenCache = new Map<string, CachedToken>()
/** Single-flight: one refresh promise per account id. */
const inFlightRefreshes = new Map<string, Promise<string>>()

function isUsable(cached: CachedToken): boolean {
  return cached.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS > Date.now()
}

/** Refresh slightly before expiry so requests never race the deadline. */
export const TOKEN_EXPIRY_MARGIN_MS = 60_000

/**
 * Drop the cached access token for one account (or all when no id is
 * given). Used after a credentials rotation and by tests.
 */
export function clearMicrosoftTokenCache(accountId?: string): void {
  if (accountId === undefined) {
    tokenCache.clear()
    inFlightRefreshes.clear()
  } else {
    tokenCache.delete(accountId)
    inFlightRefreshes.delete(accountId)
  }
}

async function postTokenRequest(
  endpoint: string,
  body: Record<string, string>,
  fetchImpl: FetchImpl
): Promise<{ status: number; payload: Record<string, unknown> | null }> {
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  })
  const text = await response.text()
  let payload: Record<string, unknown> | null = null
  try {
    payload = text ? (JSON.parse(text) as Record<string, unknown>) : null
  } catch {
    // Non-JSON error body — the status alone still identifies the failure.
  }
  return { status: response.status, payload }
}

function entraErrorCode(payload: Record<string, unknown> | null): string {
  return payload && typeof payload.error === "string"
    ? payload.error
    : "unknown_error"
}

function entraErrorDescription(
  payload: Record<string, unknown> | null
): string {
  return payload && typeof payload.error_description === "string"
    ? payload.error_description
    : ""
}

/**
 * Entra error codes that mean the CONSENT itself is gone (revoked or
 * expired refresh token, an interactive sign-in Entra demands, withdrawn
 * admin consent) — a silent refresh can never succeed, so the account
 * must surface its re-auth state instead of a generic sync failure.
 */
const REAUTH_ERROR_CODES = new Set([
  "invalid_grant",
  "interaction_required",
  "consent_required",
])

/**
 * AADSTS65001 — "user or administrator has not consented". Entra usually
 * reports it as one of the codes above, but some tenants carry it only in
 * the error_description; either shape must raise the re-auth state.
 */
const CONSENT_REVOKED_MARKER = "AADSTS65001"

function refreshRequiresReauth(errorCode: string, description: string): boolean {
  return (
    REAUTH_ERROR_CODES.has(errorCode) || description.includes(CONSENT_REVOKED_MARKER)
  )
}

/**
 * A TRANSIENT refresh failure (`temporarily_unavailable`, `server_error`):
 * the same retry with the unchanged refresh token can succeed later, so
 * this must NOT raise the account's re-auth state — it surfaces as a
 * retryable, status-carrying error like the API clients' throttling.
 */
export class TransientTokenError extends Error {
  /** HTTP status the token endpoint answered with. */
  readonly status: number
  /** Entra's bare error code. */
  readonly code: string

  constructor(status: number, code: string) {
    super(`Microsoft token refresh failed with status ${status} (${code})`)
    this.name = "TransientTokenError"
    this.status = status
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Token response validation (fix: never trust/cache/seal a hostile payload)
// ---------------------------------------------------------------------------

/** expires_in bounds (seconds). Entra mints 3600s tokens; a hostile or
 * buggy value is clamped into this window instead of being trusted. */
export const MIN_TOKEN_TTL_SECONDS = 60
export const MAX_TOKEN_TTL_SECONDS = 366 * 24 * 3600
/** Sane upper bound for a bearer/refresh token string. */
export const MAX_TOKEN_LENGTH = 4096

/**
 * The token endpoint answered 200 with an unusable payload (non-numeric
 * lifetime, empty/oversized/control-character token). Treated exactly like
 * a failed refresh — nothing is cached or sealed. Carries NO token
 * material, only which field was unusable.
 */
export class InvalidTokenResponseError extends Error {
  constructor(detail: string) {
    super(`Microsoft returned an unusable token response (${detail})`)
    this.name = "InvalidTokenResponseError"
  }
}

function hasControlChars(value: string): boolean {
  // Control characters are illegal in HTTP header values and never occur
  // in real bearer tokens — a match means the payload is not a token.
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(value)
}

function validSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TOKEN_LENGTH &&
    !hasControlChars(value)
  )
}

interface ValidatedTokenPayload {
  accessToken: string
  /** Present only when the response carried a usable refresh token. */
  refreshToken?: string
  /** Clamped lifetime in seconds. */
  expiresIn: number
}

/**
 * Validate a 200 token response BEFORE anything is cached or sealed:
 * - expires_in must be a finite number (non-numeric is rejected — the old
 *   3600 fallback would mint a token whose real lifetime is unknown) and
 *   is clamped to [MIN_TOKEN_TTL_SECONDS, MAX_TOKEN_TTL_SECONDS];
 * - the access token (and refresh token, when present) must be a
 *   non-empty string of sane length with no control characters.
 */
function validateTokenPayload(
  payload: Record<string, unknown> | null
): ValidatedTokenPayload {
  const accessToken = payload?.access_token
  if (!validSecret(accessToken)) {
    throw new InvalidTokenResponseError("access token is missing or malformed")
  }
  const rawRefresh = payload?.refresh_token
  let refreshToken: string | undefined
  if (typeof rawRefresh === "string" && rawRefresh.length > 0) {
    if (!validSecret(rawRefresh)) {
      throw new InvalidTokenResponseError("refresh token is malformed")
    }
    refreshToken = rawRefresh
  }
  const rawExpiresIn = payload?.expires_in
  if (typeof rawExpiresIn !== "number" || !Number.isFinite(rawExpiresIn)) {
    throw new InvalidTokenResponseError("expires_in is not a number")
  }
  const expiresIn = Math.min(
    Math.max(Math.floor(rawExpiresIn), MIN_TOKEN_TTL_SECONDS),
    MAX_TOKEN_TTL_SECONDS
  )
  return { accessToken, refreshToken, expiresIn }
}

/**
 * The silent refresh itself. Not exported: callers go through
 * createMicrosoftTokenSource so caching and single-flight apply.
 * `persist` receives the envelope to re-seal when Entra rotates the
 * refresh token; it is awaited best-effort (failures are swallowed —
 * the in-memory token is still valid for this session).
 */
async function refreshAccessToken(
  account: MicrosoftAccountRef,
  refreshToken: string,
  fetchImpl: FetchImpl,
  persist?: (envelope: MicrosoftTokenEnvelope) => Promise<void>
): Promise<string> {
  const inFlight = inFlightRefreshes.get(account.id)
  if (inFlight) return inFlight

  const refresh = (async () => {
    if (!account.oauthClientId) {
      throw new Error(`Account ${account.id} has no oauth_client_id configured`)
    }
    const { status, payload } = await postTokenRequest(
      MICROSOFT_TOKEN_ENDPOINT,
      {
        grant_type: "refresh_token",
        client_id: account.oauthClientId,
        refresh_token: refreshToken,
        // No `scope` parameter: Entra mints the new access token for the
        // originally consented scope set (Mail.ReadWrite Mail.Send
        // User.Read), which is exactly what the Graph client needs.
      },
      fetchImpl
    )
    if (status === 200) {
      // Validate BEFORE caching or sealing: a hostile/buggy payload must
      // never enter the cache or the sealed envelope.
      const validated = validateTokenPayload(payload)
      const cached: CachedToken = {
        token: validated.accessToken,
        expiresAtMs: Date.now() + validated.expiresIn * 1000,
      }
      tokenCache.set(account.id, cached)
      // Entra rotates refresh tokens: re-seal the rotated value when the
      // caller wired a persistence hook (best effort, see module docs).
      const rotated = validated.refreshToken
      if (rotated && rotated !== refreshToken && persist) {
        try {
          await persist({
            refreshToken: rotated,
            accessToken: validated.accessToken,
            accessTokenExpiresAt: cached.expiresAtMs,
          })
        } catch {
          // Sealing failed — the session keeps its in-memory token.
        }
      }
      return cached.token
    }
    const error = entraErrorCode(payload)
    const description = entraErrorDescription(payload)
    if (
      status === 400 &&
      refreshRequiresReauth(error, description)
    ) {
      throw new ProviderAuthError(
        account.id,
        "microsoft",
        "Microsoft rejected the stored refresh token (" +
          `${error}); re-authorization is required`
      )
    }
    if (error === "temporarily_unavailable" || error === "server_error") {
      throw new TransientTokenError(status, error)
    }
    throw new Error(
      `Microsoft token refresh failed with status ${status} (${error})`
    )
  })()

  inFlightRefreshes.set(account.id, refresh)
  try {
    return await refresh
  } finally {
    inFlightRefreshes.delete(account.id)
  }
}

/**
 * Exchange an authorization code for tokens (PKCE add flow, task 3.1).
 * The refresh token is only issued when the consent granted
 * `offline_access` — the flow always requests it, so an absent token is
 * a flow error, never a silent downgrade.
 */
export async function exchangeMicrosoftCodeForTokens(
  clientId: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  fetchImpl: FetchImpl = fetch
): Promise<ExchangedMicrosoftTokens> {
  const { status, payload } = await postTokenRequest(
    MICROSOFT_TOKEN_ENDPOINT,
    {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    },
    fetchImpl
  )
  if (status === 200) {
    // Same validation as the silent refresh — an unusable payload must
    // never reach the flow's sealing point.
    const validated = validateTokenPayload(payload)
    if (!validated.refreshToken) {
      throw new Error(
        "Microsoft did not return a refresh token; the consent request " +
          "must include the offline_access scope"
      )
    }
    return {
      accessToken: validated.accessToken,
      refreshToken: validated.refreshToken,
      expiresIn: validated.expiresIn,
      scope: payload && typeof payload.scope === "string" ? payload.scope : "",
    }
  }
  const error = entraErrorCode(payload)
  throw new Error(
    `Microsoft authorization-code exchange failed with status ${status} (${error})`
  )
}

export interface MicrosoftTokenSource {
  /** Access token for an API call; force=true skips the cache and
   * refreshes (the 401 retry path in graph-api). */
  getToken(force?: boolean): Promise<string>
}

export interface MicrosoftTokenSourceOptions {
  /**
   * Re-seal a rotated refresh token (the encrypted envelope write).
   * Optional; production wires it to updateCredentials, tests omit it.
   */
  persist?: (envelope: MicrosoftTokenEnvelope) => Promise<void>
}

/**
 * Token source for one provider instance. `credentials` may be a promise
 * so the encrypted envelope can be decrypted lazily on first use while
 * createMicrosoftGraphProvider stays synchronous.
 */
export function createMicrosoftTokenSource(
  account: MicrosoftAccountRef,
  credentials:
    | MicrosoftTokenEnvelope
    | null
    | Promise<MicrosoftTokenEnvelope | null>,
  fetchImpl: FetchImpl = fetch,
  options: MicrosoftTokenSourceOptions = {}
): MicrosoftTokenSource {
  let resolved: Promise<MicrosoftTokenEnvelope> | null = null

  function ensureCredentials(): Promise<MicrosoftTokenEnvelope> {
    resolved ??= Promise.resolve(credentials).then((envelope) => {
      if (!envelope || !envelope.refreshToken) {
        throw new ProviderAuthError(
          account.id,
          "microsoft",
          "No Microsoft refresh token is stored for this account; " +
            "re-authorization is required"
        )
      }
      return envelope
    })
    // A rejected resolution is not cached — a retried decrypt or a
    // re-auth between calls should get a fresh chance.
    resolved.catch(() => {
      resolved = null
    })
    return resolved
  }

  return {
    async getToken(force = false): Promise<string> {
      if (force) {
        tokenCache.delete(account.id)
        const envelope = await ensureCredentials()
        return refreshAccessToken(
          account,
          envelope.refreshToken,
          fetchImpl,
          options.persist
        )
      }
      const cached = tokenCache.get(account.id)
      if (cached && isUsable(cached)) return cached.token
      const envelope = await ensureCredentials()
      if (
        envelope.accessToken &&
        envelope.accessTokenExpiresAt !== undefined &&
        isUsable({
          token: envelope.accessToken,
          expiresAtMs: envelope.accessTokenExpiresAt,
        })
      ) {
        // Seed the cache from the sealed envelope's access token (saved by
        // the add/re-auth flow) instead of refreshing on first use.
        const seeded: CachedToken = {
          token: envelope.accessToken,
          expiresAtMs: envelope.accessTokenExpiresAt,
        }
        tokenCache.set(account.id, seeded)
        return seeded.token
      }
      return refreshAccessToken(
        account,
        envelope.refreshToken,
        fetchImpl,
        options.persist
      )
    },
  }
}
