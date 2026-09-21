import type { SqlExecutor } from "./executor"
import type { AttachmentRow } from "./messages"

/**
 * Account-wide attachment listing (task 3.7, design D14): the Attachments
 * browser's query. Reads ONLY the existing attachment index — the
 * `attachments` projection (task 7.5) joined to `messages` for the
 * columns the browser entries display and act on:
 * - sender/date/subject  → entry metadata (name, sender, date, size)
 * - thread_id            → "show in message" (jump to the source thread)
 * - provider location    → lazy content fetch through the existing
 *                          cache/download path (AttachmentMessageSource)
 *
 * No new storage and no duplicated bytes (D14): filtering/search happens
 * in-process on these metadata rows (see
 * src/services/attachments/attachment-categories.ts) — deliberately no
 * FTS table.
 */
export interface AccountAttachmentRow extends AttachmentRow {
  /** The source message's thread — the jump-to-source target. */
  thread_id: string
  message_subject: string | null
  from_name: string | null
  from_address: string | null
  /** The source message's date (unix seconds); the browser's sort key. */
  message_date: number
  /** Server fetch location for the lazy content path (cache.ts). */
  gmail_message_id: string | null
  imap_folder: string | null
  imap_uid: number | null
}

/**
 * Every attachment of one account, newest message first (ties broken by
 * sync insertion order). All rows are listed — including inline `cid:`
 * parts — since the browser is a plain view over the existing index; the
 * type filters are applied in-process by the browser component.
 */
export async function listAccountAttachments(
  executor: SqlExecutor,
  accountId: string
): Promise<AccountAttachmentRow[]> {
  return executor.select<AccountAttachmentRow>(
    `SELECT
      a.id, a.message_id, a.account_id, a.filename, a.mime_type, a.size,
      a.content_id, a.is_inline, a.provider_part_id, a.local_path,
      a.cached_at, a.cache_size,
      m.thread_id, m.subject AS message_subject,
      m.from_name, m.from_address, m.date AS message_date,
      m.gmail_message_id, m.imap_folder, m.imap_uid
    FROM attachments a
    JOIN messages m ON m.id = a.message_id
    WHERE a.account_id = $1
    ORDER BY m.date DESC, a.rowid ASC`,
    [accountId]
  )
}
