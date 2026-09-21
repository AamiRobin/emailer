import { useEffect, useState } from "react"
import { Paperclip, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useComposerStore } from "@/stores/composer-store"
import type { ComposerAttachment } from "@/stores/composer-store"

import { getAttachmentBytes } from "./attachment-bytes"
import {
  formatAttachmentSize,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from "./attachment-input"
import {
  attachmentPdfDataUrl,
  attachmentPreviewKind,
} from "./attachment-preview"

/**
 * The composer attachment strip (task 8.5): one chip per attachment above
 * the footer — paperclip icon, file name, human size, and an X remove
 * action — plus a total size indicator against the send cap. Renders
 * nothing while the draft has no attachments.
 *
 * Inline previews (task 2.8, design D14): attachments whose bytes are
 * registered in the session registry additionally show a preview in the
 * chip's leading icon slot — images as a thumbnail, PDFs as a first-page
 * render with the icon layered underneath (the webview paints over it
 * when it can render, the icon stays visible when it cannot), everything
 * else keeps the plain paperclip. Previews derive from the already
 * in-memory bytes only; no new persistence and no extra read of the file.
 * Attachments restored from a persisted draft have metadata but no
 * registered bytes (drafts store metadata only), so they fall back to the
 * icon until the file is re-attached.
 */

/** Fixed preview box in the chip's leading slot (task 2.8). */
function PreviewBox({
  children,
  label,
}: {
  children: React.ReactNode
  label: string
}) {
  return (
    <span
      className="relative flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-md border bg-background"
      title={label}
    >
      {children}
    </span>
  )
}

/**
 * Image thumbnail: an object URL over the registered bytes, created in an
 * effect (never during render) and revoked by that effect's cleanup —
 * keyed by the bytes identity, so re-set bytes rotate the URL and
 * unmounting the chip (attachment removed, draft reset) always revokes.
 */
function AttachmentImagePreview({
  attachment,
  bytes,
}: {
  attachment: ComposerAttachment
  bytes: Uint8Array
}) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null)

  useEffect(() => {
    const url = URL.createObjectURL(
      new Blob([bytes as BlobPart], {
        type: attachment.mimeType ?? "application/octet-stream",
      })
    )
    // The object URL is an external resource the render cannot derive on
    // its own: the chip must re-render once it exists (and the cleanup
    // below must always revoke). set-state-in-effect flags exactly this
    // external-system sync; the alternative (creating the URL during
    // render in useMemo) leaks one URL per StrictMode double render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setObjectUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [bytes, attachment.mimeType])

  if (!objectUrl) return null
  return (
    <img
      src={objectUrl}
      alt={attachment.name}
      loading="lazy"
      className="absolute inset-0 size-full object-cover"
    />
  )
}

/**
 * PDF first-page approximation: an <object> with a data URL of the
 * registered bytes absolutely positioned over the paperclip. WKWebView
 * paints PDFs natively (first page fills the box); if the webview cannot
 * render it the <object> stays transparent and the layered icon shows.
 */
function AttachmentPdfPreview({ bytes }: { bytes: Uint8Array }) {
  return (
    <>
      <Paperclip
        className="size-3 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <object
        data={attachmentPdfDataUrl(bytes)}
        type="application/pdf"
        aria-hidden
        className="absolute inset-0 size-full"
      />
    </>
  )
}

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ComposerAttachment
  onRemove: () => void
}) {
  const bytes = getAttachmentBytes(attachment.id)
  const previewKind = bytes
    ? attachmentPreviewKind(attachment)
    : ("other" as const)

  return (
    <span
      className="inline-flex max-w-64 items-center gap-1 rounded-md border bg-muted/50 py-0.5 ps-2 pe-0.5 text-xs"
      title={`${attachment.name} (${formatAttachmentSize(attachment.size)})`}
    >
      {previewKind === "other" || !bytes ? (
        <Paperclip
          className="size-3 shrink-0 text-muted-foreground"
          aria-hidden
        />
      ) : (
        <PreviewBox label={attachment.name}>
          {previewKind === "image" ? (
            <AttachmentImagePreview attachment={attachment} bytes={bytes} />
          ) : (
            <AttachmentPdfPreview bytes={bytes} />
          )}
        </PreviewBox>
      )}
      <span className="truncate">{attachment.name}</span>
      <span className="shrink-0 text-muted-foreground">
        {formatAttachmentSize(attachment.size)}
      </span>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove ${attachment.name}`}
        onClick={onRemove}
      >
        <X aria-hidden />
      </Button>
    </span>
  )
}

export function AttachmentStrip() {
  const attachments = useComposerStore((state) => state.attachments)
  const removeAttachment = useComposerStore((state) => state.removeAttachment)

  if (attachments.length === 0) return null

  const totalBytes = attachments.reduce(
    (total, attachment) => total + attachment.size,
    0
  )

  return (
    <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {attachments.map((attachment) => (
          <AttachmentChip
            key={attachment.id}
            attachment={attachment}
            onRemove={() => removeAttachment(attachment.id)}
          />
        ))}
      </div>
      <span className="text-xs text-muted-foreground" aria-live="polite">
        {attachments.length === 1 ? "1 file" : `${attachments.length} files`} ·{" "}
        {formatAttachmentSize(totalBytes)} /{" "}
        {formatAttachmentSize(MAX_TOTAL_ATTACHMENT_BYTES)}
      </span>
    </div>
  )
}
