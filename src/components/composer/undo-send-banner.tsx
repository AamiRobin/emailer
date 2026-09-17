import { Undo2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useComposerStore } from "@/stores/composer-store"

/**
 * Undo-send banner (tasks 5.1/5.2, design D3): the unobtrusive bar shown
 * while a send sits in its pre-send cancellation window — a live
 * countdown plus an Undo action that cancels the pending send and puts
 * the message back into the composer. Mounted at shell level (next to the
 * offline banner) because the window outlives the composer pane: the
 * store closes the composer for the duration, and this reads
 * composer-store.undoWindow wherever the user has navigated.
 */
export function UndoSendBanner() {
  const undoWindow = useComposerStore((state) => state.undoWindow)
  const cancelUndoSend = useComposerStore((state) => state.cancelUndoSend)
  if (!undoWindow) return null
  return (
    <div
      role="status"
      data-testid="undo-send-banner"
      className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-center gap-3 border-t bg-muted/95 px-4 py-1.5 text-sm text-foreground backdrop-blur"
    >
      <span>Sending in {undoWindow.remainingSeconds}s</span>
      <Button
        size="xs"
        variant="outline"
        onClick={() => {
          cancelUndoSend()
        }}
      >
        <Undo2Icon aria-hidden />
        Undo
      </Button>
    </div>
  )
}
