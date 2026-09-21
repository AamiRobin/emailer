import { open } from "@tauri-apps/plugin-dialog"
import { readFile } from "@tauri-apps/plugin-fs"
import type { Editor } from "@tiptap/react"

import { bytesToBase64 } from "@/services/email/mime-builder"

import { baseName, mimeTypeFor } from "./attachment-input"

/**
 * Inline body images (batch C2): everything between "the user pasted,
 * dropped or picked an image" and "a data-URL <img> sits in the TipTap
 * body". The composer's paste/drop handlers call partitionImageFiles and
 * insert every INLINE-side file at the cursor; the ATTACH-side files
 * (non-images, and images over the inline cap) keep routing to the
 * regular attachment pipeline.
 *
 * The 2 MB cap keeps body HTML (which embeds the base64 and rides every
 * autosave JSON diff, the undo snapshot and the local_drafts row) sane —
 * a bigger image is attached as a file instead, with a toast explaining
 * why (the composer owns that toast; this module only classifies).
 *
 * The MIME side stays data-URL until send time: mime-builder extracts
 * the srcs into multipart/related parts with Content-IDs at build time.
 */

/** Rejection threshold for one INLINE image (2 MB). */
export const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024

/** One image is above the inline cap (the composer toasts this text). */
export function inlineImageTooLargeMessage(fileName: string): string {
  const mb = MAX_INLINE_IMAGE_BYTES / (1024 * 1024)
  return `"${fileName}" is too large to embed inline (over ${mb} MB) — attached as a file instead`
}

const IMAGE_MIME_PREFIX = "image/"

/** An image file the editor may inline: an image/* type under the cap.
 * SVG is excluded — embedded SVG can carry scripts and the receiving
 * sanitizer strips it anyway. */
export function isInlineImageFile(file: {
  type?: string
  name?: string
  size: number
}): boolean {
  if (file.size > MAX_INLINE_IMAGE_BYTES || file.size === 0) return false
  const type = file.type?.trim().toLowerCase()
  if (type) {
    return type.startsWith(IMAGE_MIME_PREFIX) && type !== "image/svg+xml"
  }
  // No source type (some drops): fall back to the extension map.
  const derived = mimeTypeFor(file.name ?? "", undefined)
  return (
    derived !== undefined &&
    derived.startsWith(IMAGE_MIME_PREFIX) &&
    derived !== "image/svg+xml"
  )
}

/** Split a drop/paste batch: images that go INTO the body vs everything
 * else (non-images and over-cap images) that goes to attachments. */
export function partitionImageFiles(files: File[]): {
  inline: File[]
  attach: File[]
} {
  const inline: File[] = []
  const attach: File[] = []
  for (const file of files) {
    if (isInlineImageFile(file)) inline.push(file)
    else attach.push(file)
  }
  return { inline, attach }
}

/** Read a File as a base64 data URL for the editor's src attribute. */
export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.readAsDataURL(file)
  })
}

/**
 * Insert one data-URL image at the cursor (inline: true keeps it flowing
 * inside the paragraph, exactly like the reference composers).
 */
export function insertInlineImage(editor: Editor, dataUrl: string): void {
  editor
    .chain()
    .focus()
    .insertContent({
      type: "image",
      attrs: { src: dataUrl, alt: "" },
    })
    .run()
}

export interface PickedInlineImage {
  name: string
  dataUrl: string
}

export interface InlineImagePickerDeps {
  /** System open dialog. Default: plugin-dialog open (multiple, images). */
  openDialog?: (options: {
    multiple: true
    filters: { name: string; extensions: string[] }[]
  }) => Promise<string | string[] | null>
  /** Read one absolute path's bytes. Default: plugin-fs readFile. */
  readFile?: (path: string) => Promise<Uint8Array>
}

/**
 * The toolbar button's file picker: system dialog filtered to images,
 * bytes read through plugin-fs (the dialog widens the fs scope, the same
 * discipline as the attachment picker), converted to data URLs. Oversized
 * picks resolve as `tooLarge` so the composer can route them to
 * attachments with its toast. Cancel resolves { picked: [] }.
 */
export async function pickInlineImages(
  deps: InlineImagePickerDeps = {}
): Promise<{
  picked: PickedInlineImage[]
  tooLarge: { name: string; bytes: Uint8Array }[]
}> {
  const openDialog =
    deps.openDialog ??
    ((options: {
      multiple: true
      filters: { name: string; extensions: string[] }[]
    }) => open(options))
  const read = deps.readFile ?? (async (path: string) => readFile(path))
  const selection = await openDialog({
    multiple: true,
    filters: [
      {
        name: "Images",
        extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"],
      },
    ],
  })
  if (!selection) return { picked: [], tooLarge: [] }
  const paths = Array.isArray(selection) ? selection : [selection]
  const picked: PickedInlineImage[] = []
  const tooLarge: { name: string; bytes: Uint8Array }[] = []
  for (const path of paths) {
    const name = baseName(path)
    const bytes = await read(path)
    if (bytes.byteLength > MAX_INLINE_IMAGE_BYTES) {
      tooLarge.push({ name, bytes })
      continue
    }
    const mime = mimeTypeFor(name, undefined) ?? "application/octet-stream"
    picked.push({
      name,
      dataUrl: `data:${mime};base64,${bytesToBase64(bytes)}`,
    })
  }
  return { picked, tooLarge }
}
