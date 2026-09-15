import { open } from "@tauri-apps/plugin-dialog"
import { readFile } from "@tauri-apps/plugin-fs"

import { useComposerStore } from "@/stores/composer-store"

import { setAttachmentBytes } from "./attachment-bytes"

/**
 * The composer attachment add pipeline (task 8.5): everything between
 * "the user picked/dropped files" and "metadata + bytes are in the store /
 * registry". Two sources feed it:
 *
 * - Drag-and-drop: the webview hands us `File` objects WITHOUT reliable
 *   OS paths, so bytes are read right here via `arrayBuffer()`.
 * - File picker: plugin-dialog `open({multiple: true})` returns absolute
 *   paths; bytes are read through plugin-fs `readFile` (the dialog plugin
 *   widens the fs scope for picked files automatically).
 *
 * Caps (typical mail-provider limits, enforced at add time with a visible
 * inline error in the composer): one file above
 * MAX_SINGLE_ATTACHMENT_BYTES is rejected; a file that would push the
 * draft's total above MAX_TOTAL_ATTACHMENT_BYTES is rejected. Multi-file
 * adds are partial: every file under the caps is added, the first
 * rejection is reported as `error`. Rejected files leave no trace.
 *
 * The Tauri plugins are only touched through injectable defaults / module
 * mocks — tests substitute fakes (see composer UI tests).
 */

/** Rejection threshold for one file (~typical per-attachment mail cap). */
export const MAX_SINGLE_ATTACHMENT_BYTES = 20 * 1024 * 1024
/** Rejection threshold for the draft's attachment total. */
export const MAX_TOTAL_ATTACHMENT_BYTES = 25 * 1024 * 1024

/** One file is above the per-file cap. */
export class AttachmentTooLargeError extends Error {
  constructor(fileName: string, size: number) {
    super(
      `"${fileName}" is ${formatAttachmentSize(size)} — files can be at most ${formatAttachmentSize(MAX_SINGLE_ATTACHMENT_BYTES)}`
    )
    this.name = "AttachmentTooLargeError"
  }
}

/** One file would push the draft over the total cap. */
export class AttachmentTotalSizeError extends Error {
  constructor(fileName: string) {
    super(
      `"${fileName}" would push the attachments over the ${formatAttachmentSize(MAX_TOTAL_ATTACHMENT_BYTES)} total limit`
    )
    this.name = "AttachmentTotalSizeError"
  }
}

/** Result of a multi-file add: how many made it in and the first
 * rejection (for the composer's inline error), if any. */
export interface AddAttachmentsResult {
  added: number
  error?: string
}

// ---- Formatting / naming helpers (shared with the attachment strip) ----

/** Human size for chips and caps: "812 B", "13 KB", "4.2 MB", "25 MB". */
export function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  const mb = bytes / (1024 * 1024)
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`
}

/** "/home/u/notes.txt" → "notes.txt" (both path separators handled). */
export function baseName(path: string): string {
  const normalized = path.replace(/\\/g, "/")
  const name = normalized.slice(normalized.lastIndexOf("/") + 1)
  return name === "" ? normalized : name
}

const EXTENSION_MIME: Record<string, string> = {
  avi: "video/x-msvideo",
  bmp: "image/bmp",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  html: "text/html",
  ics: "text/calendar",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  ogg: "audio/ogg",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xml: "application/xml",
  zip: "application/zip",
}

/** MIME type for an attachment: the source-provided one when non-empty,
 * else the extension map, else undefined (send falls back to
 * application/octet-stream). */
export function mimeTypeFor(
  fileName: string,
  provided?: string
): string | undefined {
  const explicit = provided?.trim()
  if (explicit) return explicit
  const dot = fileName.lastIndexOf(".")
  if (dot >= 0) {
    const extension = fileName.slice(dot + 1).toLowerCase()
    return EXTENSION_MIME[extension]
  }
  return undefined
}

// ---- Registration ----

function currentTotalBytes(): number {
  return useComposerStore
    .getState()
    .attachments.reduce((total, attachment) => total + attachment.size, 0)
}

/** Enforce the caps, register the bytes, add the metadata. Throws the
 * typed cap errors; nothing is registered when rejected. */
function addOne(file: {
  name: string
  mimeType?: string
  bytes: Uint8Array
}): void {
  if (file.bytes.byteLength > MAX_SINGLE_ATTACHMENT_BYTES) {
    throw new AttachmentTooLargeError(file.name, file.bytes.byteLength)
  }
  if (
    currentTotalBytes() + file.bytes.byteLength >
    MAX_TOTAL_ATTACHMENT_BYTES
  ) {
    throw new AttachmentTotalSizeError(file.name)
  }
  const id = crypto.randomUUID()
  // Bytes first: the store contract says metadata is added for ids the
  // registry can already resolve (getComposerPayload skips the rest).
  setAttachmentBytes(id, file.bytes)
  const mimeType = mimeTypeFor(file.name, file.mimeType)
  useComposerStore.getState().addAttachments([
    {
      id,
      name: file.name,
      size: file.bytes.byteLength,
      ...(mimeType !== undefined ? { mimeType } : {}),
    },
  ])
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ---- Sources ----

/**
 * Files from a drop event (webview `File` objects): read bytes from each
 * and add them. Partial on failure — see the module docstring.
 */
export async function addFileAttachments(
  files: File[]
): Promise<AddAttachmentsResult> {
  let added = 0
  let error: string | undefined
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      addOne({ name: file.name, mimeType: file.type, bytes })
      added += 1
    } catch (caught) {
      error ??= errorMessage(caught)
    }
  }
  return { added, error }
}

export interface AttachmentPathDeps {
  /** Read one absolute path's bytes. Default: plugin-fs readFile. */
  readFile?: (path: string) => Promise<Uint8Array>
}

/**
 * Absolute paths (from the picker, or a future "share to composer"):
 * read each through plugin-fs and add. A read failure (unscoped path,
 * vanished file) is reported like a cap rejection.
 */
export async function addPathAttachments(
  paths: string[],
  deps: AttachmentPathDeps = {}
): Promise<AddAttachmentsResult> {
  const readFile = deps.readFile ?? defaultReadFile
  let added = 0
  let error: string | undefined
  for (const path of paths) {
    try {
      const bytes = await readFile(path)
      addOne({ name: baseName(path), bytes })
      added += 1
    } catch (caught) {
      error ??= errorMessage(caught)
    }
  }
  return { added, error }
}

export interface AttachmentPickerDeps extends AttachmentPathDeps {
  /** System open dialog. Default: plugin-dialog open({multiple: true}). */
  openDialog?: (options: {
    multiple: true
  }) => Promise<string | string[] | null>
}

/**
 * "Attach file" (task 8.5): show the system picker in multiple mode and
 * add everything the user picked. Resolves {added: 0} when the dialog is
 * cancelled.
 */
export async function pickAttachments(
  deps: AttachmentPickerDeps = {}
): Promise<AddAttachmentsResult> {
  const openDialog = deps.openDialog ?? defaultOpenDialog
  const selection = await openDialog({ multiple: true })
  if (!selection) return { added: 0 }
  const paths = Array.isArray(selection) ? selection : [selection]
  return addPathAttachments(paths, deps)
}

// ---- Plugin defaults ----

async function defaultReadFile(path: string): Promise<Uint8Array> {
  return readFile(path)
}

async function defaultOpenDialog(options: {
  multiple: true
}): Promise<string | string[] | null> {
  return open(options)
}
