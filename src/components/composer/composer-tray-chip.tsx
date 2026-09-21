import { X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { getComposerKeyActions } from "./composer-key-actions"
import { useComposerStore } from "@/stores/composer-store"

/**
 * The composer's minimized-state tray chip (batch C2): a small pill docked
 * bottom-right while the composer overlay is minimized. Shows what is in
 * the draft ("Draft · <subject or recipient>"); clicking the body restores
 * the composer (and refocuses it via the mounted view's key action), the
 * small × fully closes it through the SAME keep-draft save the close (X)
 * button runs — the draft row stays addressable from Drafts.
 *
 * Rendered by the mail shell beside the overlay; the chip itself is the
 * only visible composer surface while minimized. The overlay's view stays
 * mounted-but-hidden behind it (display:none), so autosave, the undo-send
 * window and every transient composer state survive minimization.
 */
export function ComposerTrayChip() {
  const open = useComposerStore((state) => state.open)
  const minimized = useComposerStore((state) => state.minimized)
  const subject = useComposerStore((state) => state.subject)
  const to = useComposerStore((state) => state.to)
  const cc = useComposerStore((state) => state.cc)
  const bcc = useComposerStore((state) => state.bcc)

  if (!open || !minimized) return null

  // Chip label: subject first, else the first recipient, else a fallback.
  const firstRecipient = [...to, ...cc, ...bcc].find(
    (recipient) => recipient.email.trim() !== ""
  )
  const detail =
    subject.trim() !== ""
      ? subject.trim()
      : (firstRecipient?.email.trim() ?? "New message")

  return (
    <div
      data-testid="composer-tray-chip"
      className="fixed right-4 bottom-4 z-50 flex items-center gap-1 rounded-full border bg-background py-1 ps-3 pe-1 shadow-lg"
    >
      <button
        type="button"
        data-testid="composer-tray-restore"
        aria-label="Restore draft"
        title="Restore draft"
        className="max-w-72 cursor-pointer truncate text-sm text-foreground"
        onClick={() => getComposerKeyActions()?.restore()}
      >
        <span className="font-medium text-muted-foreground">Draft · </span>
        {detail}
      </button>
      <Button
        variant="ghost"
        size="icon"
        className="size-6"
        aria-label="Close and save draft"
        title="Save draft and close"
        onClick={() => getComposerKeyActions()?.keepDraftAndClose()}
      >
        <X aria-hidden className="size-3.5" />
      </Button>
    </div>
  )
}
