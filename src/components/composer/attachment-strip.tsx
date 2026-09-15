import { Paperclip, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useComposerStore } from "@/stores/composer-store"
import type { ComposerAttachment } from "@/stores/composer-store"

import {
  formatAttachmentSize,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from "./attachment-input"

/**
 * The composer attachment strip (task 8.5): one chip per attachment above
 * the footer — paperclip icon, file name, human size, and an X remove
 * action — plus a total size indicator against the send cap. Renders
 * nothing while the draft has no attachments.
 */

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ComposerAttachment
  onRemove: () => void
}) {
  return (
    <span
      className="inline-flex max-w-64 items-center gap-1 rounded-md border bg-muted/50 py-0.5 ps-2 pe-0.5 text-xs"
      title={`${attachment.name} (${formatAttachmentSize(attachment.size)})`}
    >
      <Paperclip
        className="size-3 shrink-0 text-muted-foreground"
        aria-hidden
      />
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
