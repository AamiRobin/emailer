import type { ComposerAttachment } from "@/stores/composer-store"

import { base64ToBytes } from "../crypto/aes-gcm"
import { bytesToBase64 } from "../email/mime-builder"
import type { SqlExecutor } from "../db/executor"
import { getAttachmentBytes } from "@/components/composer/attachment-bytes"
import {
  MAX_SINGLE_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from "@/components/composer/attachment-input"

/**
 * Durable attachment bytes for composer drafts (composer batch C1, fix 1).
 *
 * The composer store holds attachment METADATA and the session registry
 * (attachment-bytes.ts) holds the raw bytes — which died with the session,
 * so a resumed draft lost its files. This module persists the bytes into
 * the `draft_attachments` table (migration v19), one row per attachment
 * keyed by the draft's `draft_key`, and restores them on resume:
 *
 * - syncDraftAttachmentBytes runs whenever the composer's attachment LIST
 *   changes (add/remove/mount = the first save). It reconciles the rows
 *   with the list: additions upsert their base64 bytes straight from the
 *   registry, removals delete their rows, and an unchanged set writes
 *   nothing (a resume re-syncs without rewriting megabytes). It runs at
 *   list-change time rather than inside the autosave hook so the poll's
 *   JSON diff never has to stringify up to ~33 MB of payload per tick;
 *   add/remove/mount cover every moment the bytes could still be saved.
 * - restoreDraftAttachmentBytes decodes and validates the stored rows:
 *   a corrupt/oversized payload (impossible via the add-time caps, but a
 *   crash or tampering can produce one) drops THAT attachment only — the
 *   rest of the draft resumes intact and the caller surfaces the dropped
 *   names as a visible warning.
 * - Deletion rides the draft lifecycle: deleteDraft/deleteDraftByKey in
 *   drafts.ts remove the rows together with the draft row (send, discard),
 *   and the account_id FK cascade clears them when the account goes.
 *
 * The bytes stay LOCAL by construction — the server draft mirror
 * deliberately carries headers + body only (drafts.ts), so these rows
 * never leave the device.
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor.
 */

/** One restored attachment: metadata plus its decoded bytes (not yet
 * registered — the resume path registers AFTER openWith, which clears the
 * registry). */
export interface RestoredDraftAttachment {
  id: string
  name: string
  mimeType?: string
  size: number
  bytes: Uint8Array
}

export interface RestoredDraftAttachments {
  attachments: RestoredDraftAttachment[]
  /** Names of stored attachments that failed validation and were dropped
   * (corrupt base64, size mismatch, over the caps). */
  dropped: string[]
}

/** Raw draft_attachments row. */
interface DraftAttachmentRow {
  draft_key: string
  account_id: string
  id: string
  name: string
  mime_type: string | null
  size: number
  content_base64: string
}

/**
 * Reconcile the draft's stored attachment rows with the composer's
 * current attachment list, reading each attachment's bytes from the
 * session registry. Idempotent: an attachment already stored with the
 * same name/mime/size is left untouched (its bytes cannot have changed —
 * ids are per-add UUIDs). Attachments without registered bytes are
 * skipped softly (nothing to persist); stale rows for removed
 * attachments are deleted. Failures throw — the composer effect calls
 * this fire-and-forget and warns, and the next list change retries.
 */
export async function syncDraftAttachmentBytes(
  executor: SqlExecutor,
  accountId: string,
  draftKey: string,
  attachments: readonly ComposerAttachment[]
): Promise<void> {
  if (!draftKey) return
  const rows = await executor.select<Pick<DraftAttachmentRow, "id" | "name" | "mime_type" | "size">>(
    `SELECT id, name, mime_type, size FROM draft_attachments
     WHERE draft_key = $1`,
    [draftKey]
  )
  const stored = new Map(rows.map((row) => [row.id, row]))
  const currentIds = new Set(attachments.map((attachment) => attachment.id))

  // Removals first: rows for ids no longer in the list go away.
  for (const row of rows) {
    if (!currentIds.has(row.id)) {
      await executor.execute(
        "DELETE FROM draft_attachments WHERE draft_key = $1 AND id = $2",
        [draftKey, row.id]
      )
      stored.delete(row.id)
    }
  }

  // Additions: upsert each attachment not already stored unchanged.
  for (const attachment of attachments) {
    const existing = stored.get(attachment.id)
    if (
      existing &&
      existing.name === attachment.name &&
      existing.size === attachment.size &&
      (existing.mime_type ?? undefined) === attachment.mimeType
    ) {
      continue
    }
    const bytes = getAttachmentBytes(attachment.id)
    if (!bytes) continue // no bytes to persist — soft skip, never blocks
    await executor.execute(
      `INSERT OR REPLACE INTO draft_attachments (
         draft_key, account_id, id, name, mime_type, size, content_base64
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        draftKey,
        accountId,
        attachment.id,
        attachment.name,
        attachment.mimeType ?? null,
        attachment.size,
        bytesToBase64(bytes),
      ]
    )
  }
}

/**
 * Load, decode and validate the draft's stored attachment bytes.
 * Registrations do NOT happen here — the resume path must re-register the
 * bytes AFTER openWith (which clears the registry), so this returns the
 * decoded pairs and the caller applies them. Validation is soft: a row
 * failing any check is dropped into `dropped` (by name) while the rest
 * resume; the total is additionally capped at the send-path limit so a
 * tampered store can never balloon the composer past it.
 */
export async function restoreDraftAttachmentBytes(
  executor: SqlExecutor,
  accountId: string,
  draftKey: string
): Promise<RestoredDraftAttachments> {
  const rows = await executor.select<DraftAttachmentRow>(
    `SELECT draft_key, account_id, id, name, mime_type, size, content_base64
     FROM draft_attachments WHERE draft_key = $1 AND account_id = $2
     ORDER BY rowid`,
    [draftKey, accountId]
  )

  const attachments: RestoredDraftAttachment[] = []
  const dropped: string[] = []
  let totalBytes = 0
  for (const row of rows) {
    if (
      row.size > MAX_SINGLE_ATTACHMENT_BYTES ||
      totalBytes + row.size > MAX_TOTAL_ATTACHMENT_BYTES
    ) {
      dropped.push(row.name)
      continue
    }
    let bytes: Uint8Array
    try {
      bytes = base64ToBytes(row.content_base64)
    } catch {
      dropped.push(row.name)
      continue
    }
    if (bytes.byteLength !== row.size) {
      dropped.push(row.name)
      continue
    }
    totalBytes += row.size
    attachments.push({
      id: row.id,
      name: row.name,
      size: row.size,
      ...(row.mime_type !== null ? { mimeType: row.mime_type } : {}),
      bytes,
    })
  }
  return { attachments, dropped }
}

/**
 * Remove every stored attachment row of one draft — the byte-store half of
 * deleteDraft/deleteDraftByKey (send success, confirmed discard). No-op
 * for a blank key. Best-effort by design: the draft row itself is the
 * source of truth, and a failed byte cleanup must not fail the deletion.
 */
export async function deleteDraftAttachmentBytes(
  executor: SqlExecutor,
  accountId: string,
  draftKey: string
): Promise<void> {
  if (!draftKey) return
  await executor.execute(
    "DELETE FROM draft_attachments WHERE account_id = $1 AND draft_key = $2",
    [accountId, draftKey]
  )
}
