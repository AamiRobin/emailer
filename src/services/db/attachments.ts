import type { SqlExecutor } from "./executor"
import type { AttachmentRow } from "./messages"

/**
 * Attachments query module (task 7.5, service half). Sync projects
 * attachment metadata into the `attachments` table at message insert
 * (messages.ts insertAttachments); content is fetched lazily on first
 * open and cached on disk (design D15) — this module owns the metadata
 * CRUD and the disk-cache bookkeeping columns (`local_path`, `cached_at`,
 * `cache_size`).
 *
 * LRU semantics (D15): the schema has only `cached_at`, so it doubles as
 * the last-access stamp — every cache hit rewrites `cached_at` (see
 * touchCacheAccess), making eviction "least recently used" in the
 * accessed sense. All timestamps are unix epoch seconds.
 */

/** Metadata descriptor for one attachment part (mirrors AttachmentInput
 * in messages.ts; carried separately so this module never imports the
 * insert-side types it does not need). */
export interface AttachmentMetadataInput {
  /** Row id; derived from messageId + providerPartId when absent. */
  id?: string
  filename?: string
  mimeType?: string
  size?: number
  /** cid: referenced from the HTML body for inline images. */
  contentId?: string
  isInline?: boolean
  /** gmail attachment id or imap MIME section path. */
  providerPartId?: string
}

/** Seconds-since-epoch clock, injectable for deterministic tests. */
export type NowSeconds = () => number

/** Default wall clock (matches pending-operations.ts). */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** All attachments of one message, in sync insertion order. */
export async function getAttachmentsForMessage(
  executor: SqlExecutor,
  messageId: string
): Promise<AttachmentRow[]> {
  return executor.select<AttachmentRow>(
    "SELECT * FROM attachments WHERE message_id = $1 ORDER BY rowid ASC",
    [messageId]
  )
}

/** One attachment row, or null. */
export async function getAttachment(
  executor: SqlExecutor,
  attachmentId: string
): Promise<AttachmentRow | null> {
  const rows = await executor.select<AttachmentRow>(
    "SELECT * FROM attachments WHERE id = $1",
    [attachmentId]
  )
  return rows[0] ?? null
}

/**
 * Idempotent by (message_id, provider_part_id): an existing row's
 * metadata is refreshed while its cache columns (local_path, cached_at,
 * cache_size) are left untouched, a missing row is inserted. Tolerates
 * parts without a provider part id by keying on the derived row id.
 *
 * No production writer calls this — sync projects attachment rows itself
 * at message insert (messages.ts insertAttachments). Kept as a repair/
 * tolerance helper for a projection that is incomplete relative to a
 * message's parts (and exercised directly by the tests).
 */
export async function ensureAttachmentRow(
  executor: SqlExecutor,
  accountId: string,
  messageId: string,
  part: AttachmentMetadataInput
): Promise<void> {
  const derivedId =
    part.id ?? `${messageId}-${part.providerPartId ?? "unknown"}`

  const existing = part.providerPartId
    ? await executor.select<Pick<AttachmentRow, "id">>(
        "SELECT id FROM attachments WHERE message_id = $1 AND provider_part_id = $2 LIMIT 1",
        [messageId, part.providerPartId]
      )
    : []
  const existingId = existing[0]?.id

  if (existingId) {
    await executor.execute(
      `UPDATE attachments SET
        filename = $1, mime_type = $2, size = $3, content_id = $4,
        is_inline = $5
      WHERE id = $6`,
      [
        part.filename ?? null,
        part.mimeType ?? null,
        part.size ?? null,
        part.contentId ?? null,
        part.isInline === true ? 1 : 0,
        existingId,
      ]
    )
    return
  }

  await executor.execute(
    `INSERT INTO attachments (
      id, message_id, account_id, filename, mime_type, size, content_id,
      is_inline, provider_part_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      derivedId,
      messageId,
      accountId,
      part.filename ?? null,
      part.mimeType ?? null,
      part.size ?? null,
      part.contentId ?? null,
      part.isInline === true ? 1 : 0,
      part.providerPartId ?? null,
    ]
  )
}

/** Record a successful disk cache write (and refresh the LRU stamp). */
export async function markCached(
  executor: SqlExecutor,
  attachmentId: string,
  localPath: string,
  size: number,
  now: NowSeconds = nowSeconds
): Promise<void> {
  await executor.execute(
    `UPDATE attachments SET local_path = $1, cached_at = $2, cache_size = $3
    WHERE id = $4`,
    [localPath, now(), size, attachmentId]
  )
}

/** Cache hit: refresh `cached_at` so LRU eviction orders by last access. */
export async function touchCacheAccess(
  executor: SqlExecutor,
  attachmentId: string,
  now: NowSeconds = nowSeconds
): Promise<void> {
  await executor.execute(
    "UPDATE attachments SET cached_at = $1 WHERE id = $2",
    [now(), attachmentId]
  )
}

/** Clear the cache columns after the backing file was evicted/deleted. */
export async function clearCacheEntry(
  executor: SqlExecutor,
  attachmentId: string
): Promise<void> {
  await executor.execute(
    `UPDATE attachments SET local_path = NULL, cached_at = NULL,
      cache_size = NULL WHERE id = $1`,
    [attachmentId]
  )
}

/**
 * Oldest-first cache entries, global across accounts (D15: one total-size
 * cap for the whole app). Drives eviction: the head of this list is the
 * least recently used entry.
 */
export async function listCachedOldestFirst(
  executor: SqlExecutor,
  limit = 100
): Promise<AttachmentRow[]> {
  return executor.select<AttachmentRow>(
    `SELECT * FROM attachments WHERE cached_at IS NOT NULL
    ORDER BY cached_at ASC LIMIT $1`,
    [limit]
  )
}

/**
 * Per-account variant of the eviction candidate list — diagnostics/debug
 * only (reporting scripts, tests); no production path reads it. Eviction
 * itself uses the global listCachedOldestFirst (D15's single total cap).
 */
export async function listCachedForAccount(
  executor: SqlExecutor,
  accountId: string,
  limit = 100
): Promise<AttachmentRow[]> {
  return executor.select<AttachmentRow>(
    `SELECT * FROM attachments
    WHERE cached_at IS NOT NULL AND account_id = $1
    ORDER BY cached_at ASC LIMIT $2`,
    [accountId, limit]
  )
}

/**
 * Sum of every cached attachment's `cache_size`, global across accounts —
 * the number the D15 total-size cap is enforced against.
 */
export async function totalCacheSize(executor: SqlExecutor): Promise<number> {
  const rows = await executor.select<{ total: number | null }>(
    "SELECT COALESCE(SUM(cache_size), 0) AS total FROM attachments WHERE cached_at IS NOT NULL"
  )
  return rows[0]?.total ?? 0
}
