/**
 * Attachment content service (task 7.5, design D15) — the API surface
 * the attachment-list UI worker consumes. Sync stores metadata only;
 * content is fetched on first access, cached under
 * `AppData/attachment_cache` (hashed filenames, 200 MB total cap, LRU
 * eviction by last access) and re-served from disk afterwards, which is
 * what keeps previously viewed attachments (and `cid:` inline images)
 * working offline.
 *
 * UI flows (attachment rows come from getMessage() in
 * src/services/db/messages.ts — MessageWithAttachments.attachments):
 *
 * - List: render the AttachmentRow metadata directly (filename, size,
 *   mime_type, is_inline). No content is downloaded for listing.
 * - Download/open: `getAttachmentContent(executor, account, message,
 *   attachment)` resolves bytes on demand (server on first access, disk
 *   afterwards).
 * - Save: `saveAttachmentAs(attachment, content)` → system save dialog,
 *   writes the chosen path, null on cancel.
 * - Open: `openAttachment(executor, account, message, attachment)` →
 *   ensures the content is cached, then opens the cached file with the
 *   OS default app.
 * - Inline `cid:` images: `ensureAttachmentCached(...)` returns
 *   `{ bytes, localPath, fromCache }` — the HTML sanitizer/viewer can
 *   swap a cid: placeholder once bytes are available.
 *
 * `account` is the EmailAccount (src/services/email/types.ts) for the
 * attachment's account_id; `message` needs only the
 * `gmail_message_id` / `imap_folder` / `imap_uid` columns of the message
 * row. All lower-level pieces (query module in src/services/db/
 * attachments.ts, cache internals, file action plugins) are exported
 * below for tests and advanced flows.
 */

export {
  CACHE_DIR,
  DEFAULT_MAX_CACHE_BYTES,
  attachmentCachePath,
  base64ToBytes,
  base64UrlToBytes,
  createPluginCacheFs,
  defaultFetchAttachment,
  enforceCacheCap,
  ensureAttachmentCached,
  getAttachmentContent,
  sha256Hex,
  type AttachmentDeps,
  type AttachmentMessageSource,
  type CachedAttachment,
  type CacheFs,
  type FetchAttachmentFn,
} from "./cache"

export {
  openAttachment,
  saveAttachmentAs,
  type FileActionDeps,
} from "./file-actions"
