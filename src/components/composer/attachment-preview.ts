import type { ComposerAttachment } from "@/stores/composer-store"

/**
 * Inline preview classification for a composer attachment (task 2.8,
 * design D14). Pure and side-effect free so the strip stays thin and the
 * precedence rules are unit-testable without a DOM:
 *
 * - "image" → <img> thumbnail from an object URL over the in-memory bytes
 * - "pdf"   → first-page <object> render from a data URL of the bytes
 * - "other" → the plain paperclip icon (unchanged task 8.5 chip)
 *
 * Precedence: the MIME type is trusted first (it was resolved at add time
 * by mimeTypeFor — source-provided, else the extension map), and the raw
 * file-name extension is only consulted when the MIME type does not
 * identify a previewable type (e.g. a generic application/octet-stream or
 * a metadata-only attachment whose MIME was never recorded). Everything
 * is matched case-insensitively.
 */

export type AttachmentPreviewKind = "image" | "pdf" | "other"

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
])

/** Which inline preview an attachment qualifies for. */
export function attachmentPreviewKind(
  attachment: Pick<ComposerAttachment, "name" | "mimeType">
): AttachmentPreviewKind {
  const mimeType = attachment.mimeType?.toLowerCase()
  if (mimeType === "application/pdf") return "pdf"
  if (mimeType?.startsWith("image/")) return "image"

  // MIME type did not resolve to a previewable type — try the extension.
  const dot = attachment.name.lastIndexOf(".")
  if (dot >= 0) {
    const extension = attachment.name.slice(dot + 1).toLowerCase()
    if (extension === "pdf") return "pdf"
    if (IMAGE_EXTENSIONS.has(extension)) return "image"
  }
  return "other"
}

/**
 * Data URL for the PDF first-page render (task 2.8). A data URL rather
 * than an object URL because WKWebView's native PDF painting inside
 * <object>/<embed> is unreliable with blob: URLs, and data URLs need no
 * revoke lifecycle. Base64 is built in chunks: spreading a large PDF's
 * bytes into one String.fromCharCode call would blow the argument limit.
 */
export function attachmentPdfDataUrl(bytes: Uint8Array): string {
  let binary = ""
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return `data:application/pdf;base64,${btoa(binary)}`
}
