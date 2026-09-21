import type { AccountAttachmentRow } from "../db/attachment-search"

/**
 * Attachment-browser filter/search primitives (task 3.7, design D14) —
 * pure and side-effect free, so the browser narrows in-process and the
 * rules are unit-testable without a DOM or database. D14 explicitly
 * rejects an attachments FTS table: the metadata rows are small enough
 * to filter here, over the existing attachment index.
 *
 * The type categories map the stored mime type (primary) and, when the
 * mime type is missing or generic, the filename extension (fallback):
 * images (image/*), PDFs (application/pdf), documents (word/text/rtf),
 * spreadsheets (excel/csv), archives (zip/rar/7z/tar/gz), other.
 * Everything is matched case-insensitively.
 */

export type AttachmentTypeCategory =
  | "images"
  | "pdfs"
  | "documents"
  | "spreadsheets"
  | "archives"
  | "other"

/** Filter-chip order: "all" renders first, then these. */
export const ATTACHMENT_TYPE_CATEGORIES: readonly AttachmentTypeCategory[] = [
  "images",
  "pdfs",
  "documents",
  "spreadsheets",
  "archives",
  "other",
]

/** Chip label for a category (and the "all" pseudo-selection). */
export function attachmentCategoryLabel(
  category: AttachmentTypeCategory | "all"
): string {
  switch (category) {
    case "all":
      return "All"
    case "images":
      return "Images"
    case "pdfs":
      return "PDFs"
    case "documents":
      return "Documents"
    case "spreadsheets":
      return "Spreadsheets"
    case "archives":
      return "Archives"
    case "other":
      return "Other"
  }
}

/** The fields category detection reads (a subset of the browser row). */
export interface AttachmentCategoryInput {
  filename: string | null
  mime_type: string | null
}

const IMAGE_EXTENSIONS = new Set([
  "avif",
  "bmp",
  "gif",
  "heic",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "webp",
])
const DOCUMENT_EXTENSIONS = new Set([
  "doc",
  "docx",
  "md",
  "odt",
  "pages",
  "rtf",
  "txt",
])
const SPREADSHEET_EXTENSIONS = new Set(["csv", "numbers", "ods", "xls", "xlsx"])
const ARCHIVE_EXTENSIONS = new Set(["7z", "bz2", "gz", "rar", "tar", "tgz", "zip"])

function extensionOf(filename: string | null): string | null {
  if (!filename) return null
  const dot = filename.lastIndexOf(".")
  if (dot < 0 || dot === filename.length - 1) return null
  return filename.slice(dot + 1).toLowerCase()
}

/**
 * Which filter bucket an attachment belongs to. The MIME type wins when
 * it identifies a category; a missing or generic `application/octet-
 * stream` falls back to the filename extension. Unknown shapes are
 * "other".
 */
export function attachmentTypeCategory(
  attachment: AttachmentCategoryInput
): AttachmentTypeCategory {
  const mime = attachment.mime_type?.toLowerCase() ?? ""
  if (mime.startsWith("image/")) return "images"
  if (mime === "application/pdf" || mime.includes("pdf")) return "pdfs"
  // Spreadsheets before documents: text/csv is a text/* mime that belongs
  // to the spreadsheet bucket.
  if (
    mime.includes("spreadsheet") ||
    mime.includes("excel") ||
    mime === "text/csv"
  ) {
    return "spreadsheets"
  }
  if (
    mime.includes("word") ||
    mime.includes("rtf") ||
    mime.includes("opendocument.text") ||
    mime.startsWith("text/")
  ) {
    return "documents"
  }
  if (
    mime.includes("zip") ||
    mime.includes("rar") ||
    mime.includes("7z") ||
    mime.includes("tar") ||
    mime.includes("gzip") ||
    mime.includes("compressed")
  ) {
    return "archives"
  }

  // MIME did not resolve (missing or octet-stream) — try the extension.
  const extension = extensionOf(attachment.filename)
  if (extension === "pdf") return "pdfs"
  if (IMAGE_EXTENSIONS.has(extension ?? "")) return "images"
  if (SPREADSHEET_EXTENSIONS.has(extension ?? "")) return "spreadsheets"
  if (DOCUMENT_EXTENSIONS.has(extension ?? "")) return "documents"
  if (ARCHIVE_EXTENSIONS.has(extension ?? "")) return "archives"
  return "other"
}

/**
 * Free-text match (D14 v1 scope): a case-insensitive substring of the
 * filename. An empty/whitespace query matches everything.
 */
export function matchesAttachmentSearch(
  attachment: Pick<AccountAttachmentRow, "filename">,
  query: string
): boolean {
  const needle = query.trim().toLowerCase()
  if (needle === "") return true
  return (attachment.filename ?? "").toLowerCase().includes(needle)
}

export interface AttachmentBrowserFilter {
  /** Free-text filename substring; "" = no text narrowing. */
  query: string
  /** Type bucket to keep; "all" keeps every category. */
  category: AttachmentTypeCategory | "all"
}

/**
 * The browser's in-process narrowing (D14): category predicate AND text
 * match, re-sorted newest-message-first (defensive — the db query already
 * orders this way; the pure helper keeps that invariant local to the
 * filter pipeline so grid/list always agree).
 */
export function filterAccountAttachments(
  attachments: AccountAttachmentRow[],
  filter: AttachmentBrowserFilter
): AccountAttachmentRow[] {
  return attachments
    .filter(
      (attachment) =>
        (filter.category === "all" ||
          attachmentTypeCategory(attachment) === filter.category) &&
        matchesAttachmentSearch(attachment, filter.query)
    )
    // Newest message first. Array#sort is stable, so equal dates keep the
    // db query's insertion ordering (listAccountAttachments' rowid tiebreak).
    .sort((a, b) => b.message_date - a.message_date)
}
