/**
 * Session-scoped byte registry for composer attachments (task 8.5).
 *
 * The composer store holds only serializable metadata
 * ({id, name, size, mimeType?}); the raw file bytes live in this
 * module-level Map keyed by the attachment id. That keeps the zustand
 * state (and anything that serializes it — draft snapshots, devtools)
 * JSON-safe, while `getComposerPayload` still reaches the bytes here to
 * base64-encode them into the send payload.
 *
 * Lifecycle: bytes are read at ADD time — a drop event hands us webview
 * `File` objects whose bytes we read via `arrayBuffer()` (dropped OS files
 * expose no reliable path in the webview), and the picker path is read
 * through plugin-fs (see attachment-input.ts). The store's
 * `removeAttachment` deletes the entry and `reset`/`openNew`/`openWith`
 * clear the registry together with the draft. Bytes are deliberately NOT
 * persisted with drafts — attachments survive within the session only
 * (acceptable v1; see services/composer/drafts.ts, metadata-only
 * attachments_json).
 *
 * File contents never leave this module except through the send payload:
 * they are never logged (privacy rule).
 */

const bytesById = new Map<string, Uint8Array>()

/** Store the bytes for one attachment id (overwrites on re-set). */
export function setAttachmentBytes(id: string, bytes: Uint8Array): void {
  bytesById.set(id, bytes)
}

/** The bytes for an attachment id, or undefined when absent. */
export function getAttachmentBytes(id: string): Uint8Array | undefined {
  return bytesById.get(id)
}

/** Drop one attachment's bytes; no-op when the id is unknown. */
export function deleteAttachmentBytes(id: string): void {
  bytesById.delete(id)
}

/** Drop every attachment's bytes — the draft was discarded or replaced. */
export function clearAttachmentBytes(): void {
  bytesById.clear()
}
