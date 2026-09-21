import { invoke } from "@tauri-apps/api/core"
import {
  BaseDirectory,
  mkdir,
  readFile,
  remove,
  writeFile as fsWriteFile,
} from "@tauri-apps/plugin-fs"

import {
  decryptCredentials,
  encryptCredentials,
} from "../crypto/credentials"
import {
  clearCacheEntry,
  getAttachment,
  listCachedOldestFirst,
  markCached,
  nowSeconds,
  touchCacheAccess,
  totalCacheSize,
} from "../db/attachments"
import { updateCredentials } from "../db/accounts"
import { getExecutor } from "../db/executor"
import type { SqlExecutor } from "../db/executor"
import type { AttachmentRow, MessageRow } from "../db/messages"
import { createGmailClient } from "../email/gmail-api"
import { createGraphClient } from "../email/graph-api"
import type { ImapParams } from "../email/invoke"
import {
  createTokenSource,
  type GmailTokenEnvelope,
} from "../email/token-manager"
import {
  createMicrosoftTokenSource,
  type MicrosoftTokenEnvelope,
} from "../email/microsoft-token-manager"
import type { EmailAccount, ProviderCredentials } from "../email/types"
import { ProviderAuthError } from "../email/types"

/**
 * Attachment content cache (task 7.5, design D15). Content is fetched
 * from the server on first access — imap via BODY.PEEK[section] through
 * the `imap_fetch_attachment` Rust command, gmail via the attachments
 * REST endpoint — written to `AppData/attachment_cache/<sha-256>.bin`
 * and recorded in the `attachments` row (`local_path`, `cached_at`,
 * `cache_size`). Subsequent reads are served from disk and refresh
 * `cached_at` (the LRU stamp — the schema's only cache timestamp doubles
 * as last-access). A global total-size cap (default 200 MB) is enforced
 * after every fetch by evicting the least recently used entries; the
 * entry just written is never the victim.
 *
 * Everything with side effects — server fetch, disk, clock — sits behind
 * `AttachmentDeps` so the whole flow runs under vitest with in-memory
 * fakes; production resolves to the Tauri plugins and the account's
 * decrypted credentials (token/password values never appear in logs or
 * error messages).
 */

export const CACHE_DIR = "attachment_cache"

/** D15 total-size cap, global across accounts. */
export const DEFAULT_MAX_CACHE_BYTES = 200 * 1024 * 1024

/**
 * Graph only inlines `contentBytes` for file attachments of roughly 3 MB
 * and below; anything larger (or a list form without the field) must be
 * downloaded from the raw `$value` endpoint instead.
 */
export const MAX_INLINE_CONTENTBYTES_BYTES = 3 * 1024 * 1024

/** The message fields the fetch seam needs (mirrors MessageRow columns). */
export type AttachmentMessageSource = Pick<
  MessageRow,
  "gmail_message_id" | "imap_folder" | "imap_uid"
>

/**
 * Server seam: fetch one attachment's decoded bytes. Implementations must
 * not log or embed credential material in thrown errors.
 */
export type FetchAttachmentFn = (
  account: EmailAccount,
  message: AttachmentMessageSource,
  attachment: AttachmentRow
) => Promise<Uint8Array>

/** Disk seam, scoped to the app data directory (paths are relative). */
export interface CacheFs {
  ensureCacheDir(): Promise<void>
  writeFile(relPath: string, data: Uint8Array): Promise<void>
  readFile(relPath: string): Promise<Uint8Array>
  removeFile(relPath: string): Promise<void>
}

export interface AttachmentDeps {
  /** Server fetch. Default: imap Tauri command / Gmail REST. */
  fetchAttachment?: FetchAttachmentFn
  /** Disk under AppData. Default: @tauri-apps/plugin-fs. */
  fs?: CacheFs
  /** Unix-seconds clock for the LRU stamp. Default: wall clock. */
  now?: () => number
  /** Total cache cap in bytes (D15). Default 200 MB. */
  maxCacheBytes?: number
  /** Cache-key hash (hex). Default sha-256 via WebCrypto. */
  hash?: (key: string) => Promise<string>
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/** Standard base64 → raw bytes (the Rust command's wire payload). */
export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** base64url → raw bytes (gmail attachment `data`). */
export function base64UrlToBytes(encoded: string): Uint8Array {
  let normalized = encoded.replace(/-/g, "+").replace(/_/g, "/")
  while (normalized.length % 4 !== 0) normalized += "="
  return base64ToBytes(normalized)
}

/** sha-256 of the cache identity, hex-encoded (WebCrypto). */
export async function sha256Hex(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key)
  )
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Deterministic hashed cache file name for one attachment:
 * `<CACHE_DIR>/<sha-256(accountId|messageId|partId|filename)>.bin`.
 * Filenames are hashed so user content never lands on disk as-is.
 */
export async function attachmentCachePath(
  accountId: string,
  messageId: string,
  providerPartId: string,
  filename: string,
  hash: (key: string) => Promise<string> = sha256Hex
): Promise<string> {
  const digest = await hash(
    [accountId, messageId, providerPartId, filename].join("|")
  )
  return `${CACHE_DIR}/${digest}.bin`
}

// ---------------------------------------------------------------------------
// Production seams
// ---------------------------------------------------------------------------

/** plugin-fs backed cache directory under AppData. */
export function createPluginCacheFs(): CacheFs {
  return {
    async ensureCacheDir() {
      try {
        await mkdir(CACHE_DIR, {
          baseDir: BaseDirectory.AppData,
          recursive: true,
        })
      } catch {
        // Directory already exists.
      }
    },
    async writeFile(relPath, data) {
      await fsWriteFile(relPath, data, { baseDir: BaseDirectory.AppData })
    },
    async readFile(relPath) {
      return readFile(relPath, { baseDir: BaseDirectory.AppData })
    },
    async removeFile(relPath) {
      await remove(relPath, { baseDir: BaseDirectory.AppData })
    },
  }
}

async function fetchGmailAttachment(
  account: EmailAccount,
  message: AttachmentMessageSource,
  attachment: AttachmentRow
): Promise<Uint8Array> {
  if (!message.gmail_message_id) {
    throw new Error("gmail attachment is missing the server message id")
  }
  if (!attachment.provider_part_id) {
    throw new Error("attachment row has no provider part id")
  }
  const envelope = await decryptCredentials<GmailTokenEnvelope>(
    account.credentialsJson ?? null
  )
  if (!envelope?.refreshToken) {
    throw new ProviderAuthError(
      account.id,
      "gmail",
      "no stored Gmail token; re-authorization is required"
    )
  }
  // Same construction as gmail-provider: token source caches and
  // single-flights, and force=true on the 401 retry triggers a refresh.
  const tokenSource = createTokenSource(account, envelope)
  const client = createGmailClient({
    accountId: account.id,
    getToken: (force) => tokenSource.getToken(force),
  })
  const result = await client.getAttachment(
    message.gmail_message_id,
    attachment.provider_part_id
  )
  if (!result.data) {
    throw new Error("Gmail returned no content for the attachment")
  }
  return base64UrlToBytes(result.data)
}

async function fetchMicrosoftAttachment(
  account: EmailAccount,
  message: AttachmentMessageSource,
  attachment: AttachmentRow
): Promise<Uint8Array> {
  if (!message.gmail_message_id) {
    // The Graph message id lives in the provider-id column (the same
    // opaque-id channel gmail uses).
    throw new Error("microsoft attachment is missing the server message id")
  }
  if (!attachment.provider_part_id) {
    throw new Error("attachment row has no provider part id")
  }
  const envelope = await decryptCredentials<MicrosoftTokenEnvelope>(
    account.credentialsJson ?? null
  )
  if (!envelope?.refreshToken) {
    throw new ProviderAuthError(
      account.id,
      "microsoft",
      "no stored Microsoft token; re-authorization is required"
    )
  }
  // Same construction as the graph provider: token source caches and
  // single-flights, and force=true on the 401 retry triggers a refresh.
  // Entra ROTATES refresh tokens — the persist hook re-seals the rotated
  // envelope exactly like the mail provider and the calendar do (best
  // effort: a failed seal keeps the session's in-memory token usable),
  // otherwise the one attachment call would drop the rotation on the
  // floor and the stored envelope would go stale.
  const tokenSource = createMicrosoftTokenSource(account, envelope, undefined, {
    persist: async (rotated) => {
      try {
        const credentialsJson = await encryptCredentials(rotated)
        await updateCredentials(getExecutor(), account.id, credentialsJson)
      } catch {
        // No database binding (tests/dev) or transient write failure.
      }
    },
  })
  const client = createGraphClient({
    accountId: account.id,
    getToken: (force) => tokenSource.getToken(force),
  })
  const result = await client.getAttachment(
    message.gmail_message_id,
    attachment.provider_part_id
  )
  // contentBytes only exists for small file attachments (≲3 MB). Larger
  // ones (or a payload missing the field) ride the raw $value endpoint.
  const size =
    typeof result.size === "number"
      ? result.size
      : (attachment.size ?? 0)
  if (result.contentBytes && size <= MAX_INLINE_CONTENTBYTES_BYTES) {
    return base64ToBytes(result.contentBytes)
  }
  const bytes = await client.getAttachmentValue(
    message.gmail_message_id,
    attachment.provider_part_id
  )
  if (bytes.byteLength === 0) {
    throw new Error("Microsoft Graph returned no content for the attachment")
  }
  return bytes
}

async function fetchImapAttachment(
  account: EmailAccount,
  message: AttachmentMessageSource,
  attachment: AttachmentRow
): Promise<Uint8Array> {
  if (message.imap_folder == null || message.imap_uid == null) {
    throw new Error("imap attachment is missing the folder/uid location")
  }
  if (!attachment.provider_part_id) {
    throw new Error("attachment row has no provider part id")
  }
  if (!account.imapHost || !account.imapPort || !account.imapSecurity) {
    throw new Error("imap account is missing server configuration")
  }
  const credentials = await decryptCredentials<ProviderCredentials>(
    account.credentialsJson ?? null
  )
  if (!credentials?.password) {
    throw new ProviderAuthError(
      account.id,
      "imap",
      "no stored password for imap account; re-authentication is required"
    )
  }
  const params: ImapParams = {
    host: account.imapHost,
    port: account.imapPort,
    security: account.imapSecurity,
    username: account.email,
    password: credentials.password,
    acceptInvalidCerts: credentials.acceptInvalidCerts ?? false,
  }
  const base64 = await invoke<string>("imap_fetch_attachment", {
    params,
    folder: message.imap_folder,
    uid: message.imap_uid,
    partId: attachment.provider_part_id,
  })
  return base64ToBytes(base64)
}

/** Production fetch seam — dispatches on the account type. */
export function defaultFetchAttachment(
  account: EmailAccount,
  message: AttachmentMessageSource,
  attachment: AttachmentRow
): Promise<Uint8Array> {
  if (account.type === "gmail") {
    return fetchGmailAttachment(account, message, attachment)
  }
  if (account.type === "microsoft") {
    return fetchMicrosoftAttachment(account, message, attachment)
  }
  return fetchImapAttachment(account, message, attachment)
}

// ---------------------------------------------------------------------------
// Cache flow
// ---------------------------------------------------------------------------

export interface CachedAttachment {
  bytes: Uint8Array
  /** Path relative to AppData, as stored in `attachments.local_path`. */
  localPath: string
  /** True when served from disk (no server round trip). */
  fromCache: boolean
}

/**
 * Resolve an attachment to its decoded bytes and make sure they are
 * cached: disk hit (touch + return), otherwise fetch → write → mark →
 * enforce the D15 cap. A `local_path` whose file vanished (manual
 * deletion, partial eviction) falls through to a refetch and re-cache.
 *
 * The row is re-read from the database first so callers may pass a
 * metadata snapshot from before an earlier cache write; the fresh
 * `local_path` decides hit vs refetch, never the stale object.
 */
export async function ensureAttachmentCached(
  executor: SqlExecutor,
  account: EmailAccount,
  message: AttachmentMessageSource,
  attachment: AttachmentRow,
  deps: AttachmentDeps = {}
): Promise<CachedAttachment> {
  const fs = deps.fs ?? createPluginCacheFs()
  const now = deps.now ?? nowSeconds
  const current = (await getAttachment(executor, attachment.id)) ?? attachment

  if (current.local_path) {
    try {
      const bytes = await fs.readFile(current.local_path)
      // LRU-by-access: a hit refreshes the eviction stamp.
      await touchCacheAccess(executor, current.id, now)
      return { bytes, localPath: current.local_path, fromCache: true }
    } catch {
      // Claimed file is gone/unreadable — fall through to a refetch.
    }
  }

  const bytes = await (deps.fetchAttachment ?? defaultFetchAttachment)(
    account,
    message,
    current
  )

  const localPath =
    current.local_path ??
    (await attachmentCachePath(
      account.id,
      current.message_id,
      current.provider_part_id ?? "unknown",
      current.filename ?? "",
      deps.hash
    ))
  await fs.ensureCacheDir()
  await fs.writeFile(localPath, bytes)
  await markCached(executor, current.id, localPath, bytes.byteLength, now)

  await enforceCacheCap(executor, fs, deps, current.id)

  return { bytes, localPath, fromCache: false }
}

/** Decode-only convenience wrapper returning the attachment bytes. */
export async function getAttachmentContent(
  executor: SqlExecutor,
  account: EmailAccount,
  message: AttachmentMessageSource,
  attachment: AttachmentRow,
  deps: AttachmentDeps = {}
): Promise<Uint8Array> {
  const { bytes } = await ensureAttachmentCached(
    executor,
    account,
    message,
    attachment,
    deps
  )
  return bytes
}

/**
 * Enforce the D15 total-size cap: while the global SUM(cache_size) is
 * over the cap, evict the least recently cached entry — delete its file
 * and clear its cache columns — never the entry just written.
 */
export async function enforceCacheCap(
  executor: SqlExecutor,
  fs: CacheFs,
  deps: AttachmentDeps,
  justWrittenId: string
): Promise<void> {
  const cap = deps.maxCacheBytes ?? DEFAULT_MAX_CACHE_BYTES
  let total = await totalCacheSize(executor)

  while (total > cap) {
    const victim = (await listCachedOldestFirst(executor)).find(
      (row) => row.id !== justWrittenId
    )
    if (!victim?.local_path) break
    try {
      await fs.removeFile(victim.local_path)
    } catch {
      // File already gone — still clear the bookkeeping below.
    }
    await clearCacheEntry(executor, victim.id)
    const freed = victim.cache_size ?? 0
    if (freed <= 0) break // cannot make progress; avoid spinning
    total -= freed
  }
}
