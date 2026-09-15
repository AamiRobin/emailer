import { ArrowLeft } from "lucide-react"

import { ThreadView } from "@/components/email/thread-view"

/**
 * Reading-pane bridge: mounts the real ThreadView (tasks 7.1/7.3/7.4/7.5)
 * for uiStore.activeThread. The view resolves the thread id and active
 * account from the stores itself and renders its own empty state when
 * nothing is selected.
 *
 * With `onBack` (the hidden-pane position) a back control renders above
 * the display; invoking it is the mailbox's way back to the list.
 */

interface ReadingPaneProps {
  /** When set, a back-to-list control renders above the display. */
  onBack?: () => void
}

export function ReadingPane({ onBack }: ReadingPaneProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {onBack && (
        <>
          <div className="flex items-center px-2 py-1">
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              onClick={onBack}
            >
              <ArrowLeft className="size-4" />
              Back to list
            </button>
          </div>
          <div className="border-b border-border" />
        </>
      )}
      <div className="min-h-0 flex-1">
        <ThreadView />
      </div>
    </div>
  )
}
