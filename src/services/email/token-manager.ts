import type { EmailAccount } from "./types"
import { ProviderAuthError } from "./types"

/**
 * Gmail OAuth token manager (design D2: "OAuth token refresh in TS").
 *
 * Silent refresh: POSTs `grant_type=refresh_token` to Google's token
 * endpoint with the client id (accounts.oauth_client_id) and the refresh
 * token from the decrypted credentials envelope, then caches the access
 * token in memory per account with a 60-second expiry margin.
 * Concurrency-safe: one in-flight refresh per account (single-flight).
 * A 400 `invalid_grant` surfaces as ProviderAuthError so the account
 * auth-error task (5.6) can pause the account and prompt re-auth.
 *
 * Token values never appear in logs or error messages — errors carry only
 * the Google error code and HTTP status.
 */

/** Plaintext OAuth credentials envelope as stored in the encrypted
 * `credentials_json` column (decryptCredentials task 5.1). The access
 * token fields are optional — only the refresh token is durable; access
 * tokens live in the in-memory cache. */
export interface GmailTokenEnvelope {
  refreshToken: string
  accessToken?: string
  /** unix epoch ms */
  accessTokenExpiresAt?: number
}

/** Result of the authorization-code exchange (add-account flow, task 5.3). */
export interface ExchangedTokens {
  accessToken: string
  refreshToken: string
  /** seconds until the access token expires */
  expiresIn: number
  /** space-separated granted scopes */
  scope: string
}

export type FetchImpl = typeof fetch

export const GMAIL_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"

/** Refresh this long before expiry so requests never race the deadline. */
export const TOKEN_EXPIRY_MARGIN_MS = 60_000

/** The account fields the token manager needs. */
export type AccountRef = Pick<EmailAccount, "id" | "oauthClientId">

interface CachedToken {
  token: string
  /** unix epoch ms */
  expiresAtMs: number
}

/** Module-level in-memory cache, keyed by account id (never persisted). */
const tokenCache = new Map<string, CachedToken>()
/** Single-flight: one refresh promise per account id. */
const inFlightRefreshes = new Map<string, Promise<string>>()

function isUsable(cached: CachedToken): boolean {
  return cached.expiresAtMs - TOKEN_EXPIRY_MARGIN_MS > Date.now()
}

/**
 * Drop the cached access token for one account (or all when no id is
 * given). Used after a credentials change and by tests.
 */
export function clearGmailTokenCache(accountId?: string): void {
  if (accountId === undefined) {
    tokenCache.clear()
    inFlightRefreshes.clear()
  } else {
    tokenCache.delete(accountId)
    inFlightRefreshes.delete(accountId)
  }
}

async function postTokenRequest(
  body: Record<string, string>,
  fetchImpl: FetchImpl
): Promise<{ status: number; payload: Record<string, unknown> | null }> {
  const response = await fetchImpl(GMAIL_TOKEN_ENDPOINT, {
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

function googleErrorCode(payload: Record<string, unknown> | null): string {
  return payload && typeof payload.error === "string"
    ? payload.error
    : "unknown_error"
}

/**
 * The silent refresh itself. Not exported: callers go through
 * getAccessToken / createTokenSource so caching and single-flight apply.
 */
async function refreshAccessToken(
  account: AccountRef,
  refreshToken: string,
  fetchImpl: FetchImpl
): Promise<string> {
  const inFlight = inFlightRefreshes.get(account.id)
  if (inFlight) return inFlight

  const refresh = (async () => {
    if (!account.oauthClientId) {
      throw new Error(`Account ${account.id} has no oauth_client_id configured`)
    }
    const { status, payload } = await postTokenRequest(
      {
        grant_type: "refresh_token",
        client_id: account.oauthClientId,
        refresh_token: refreshToken,
      },
      fetchImpl
    )
    const accessToken =
      payload && typeof payload.access_token === "string"
        ? payload.access_token
        : undefined
    if (status === 200 && accessToken) {
      const expiresIn =
        payload && typeof payload.expires_in === "number"
          ? payload.expires_in
          : 3600
      const cached: CachedToken = {
        token: accessToken,
        expiresAtMs: Date.now() + expiresIn * 1000,
      }
      tokenCache.set(account.id, cached)
      return cached.token
    }
    const error = googleErrorCode(payload)
    if (status === 400 && error === "invalid_grant") {
      throw new ProviderAuthError(
        account.id,
        "gmail",
        "Google rejected the stored refresh token (invalid_grant); " +
          "re-authorization is required"
      )
    }
    throw new Error(
      `Gmail token refresh failed with status ${status} (${error})`
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
 * A still-valid access token for the account: seeded from the envelope
 * (when the caller persisted one) or from the in-memory cache.
 */
function usableTokenFor(
  accountId: string,
  credentials: GmailTokenEnvelope
): string | null {
  if (
    credentials.accessToken &&
    credentials.accessTokenExpiresAt !== undefined
  ) {
    const seeded: CachedToken = {
      token: credentials.accessToken,
      expiresAtMs: credentials.accessTokenExpiresAt,
    }
    if (isUsable(seeded)) {
      tokenCache.set(accountId, seeded)
      return seeded.token
    }
  }
  const cached = tokenCache.get(accountId)
  if (cached && isUsable(cached)) return cached.token
  return null
}

/**
 * Get a usable access token for the account: envelope/cache hit first,
 * one silent refresh otherwise. `fetchImpl` is injectable for tests
 * (production resolves the global fetch patched by tauri-plugin-http).
 */
export async function getAccessToken(
  account: AccountRef,
  credentials: GmailTokenEnvelope,
  fetchImpl: FetchImpl = fetch
): Promise<string> {
  const usable = usableTokenFor(account.id, credentials)
  if (usable) return usable
  return refreshAccessToken(account, credentials.refreshToken, fetchImpl)
}

/**
 * Exchange an authorization code for tokens (PKCE add-account flow,
 * task 5.3). The refresh token is only issued on the first consent —
 * callers must persist it (encrypted) before anything else.
 */
export async function exchangeCodeForTokens(
  clientId: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  fetchImpl: FetchImpl = fetch
): Promise<ExchangedTokens> {
  const { status, payload } = await postTokenRequest(
    {
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    },
    fetchImpl
  )
  const accessToken =
    payload && typeof payload.access_token === "string"
      ? payload.access_token
      : undefined
  if (status === 200 && accessToken) {
    const refreshToken =
      payload && typeof payload.refresh_token === "string"
        ? payload.refresh_token
        : undefined
    if (!refreshToken) {
      throw new Error(
        "Google did not return a refresh token; the consent request must " +
          "use access_type=offline with prompt=consent"
      )
    }
    return {
      accessToken,
      refreshToken,
      expiresIn:
        payload && typeof payload.expires_in === "number"
          ? payload.expires_in
          : 3600,
      scope: payload && typeof payload.scope === "string" ? payload.scope : "",
    }
  }
  const error = googleErrorCode(payload)
  throw new Error(
    `Gmail authorization-code exchange failed with status ${status} (${error})`
  )
}

export interface GmailTokenSource {
  /** Access token for an API call; force=true skips the cache and
   * refreshes (the 401 retry path in gmail-api). */
  getToken(force?: boolean): Promise<string>
}

/**
 * Token source for one provider instance. `credentials` may be a promise
 * so the encrypted envelope (task 5.1) can be decrypted lazily on first
 * use while createGmailProvider stays synchronous.
 */
export function createTokenSource(
  account: AccountRef,
  credentials: GmailTokenEnvelope | null | Promise<GmailTokenEnvelope | null>,
  fetchImpl: FetchImpl = fetch
): GmailTokenSource {
  let resolved: Promise<GmailTokenEnvelope> | null = null

  function ensureCredentials(): Promise<GmailTokenEnvelope> {
    resolved ??= Promise.resolve(credentials).then((envelope) => {
      if (!envelope || !envelope.refreshToken) {
        throw new ProviderAuthError(
          account.id,
          "gmail",
          "No Gmail refresh token is stored for this account; " +
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
        return refreshAccessToken(account, envelope.refreshToken, fetchImpl)
      }
      const cached = tokenCache.get(account.id)
      if (cached && isUsable(cached)) return cached.token
      const envelope = await ensureCredentials()
      const usable = usableTokenFor(account.id, envelope)
      if (usable) return usable
      return refreshAccessToken(account, envelope.refreshToken, fetchImpl)
    },
  }
}
