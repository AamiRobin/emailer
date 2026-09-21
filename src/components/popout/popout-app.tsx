import { lazy, Suspense, useEffect, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Toaster } from "@/components/ui/sonner"
import { Titlebar } from "@/components/layout/titlebar"
import { ThreadView } from "@/components/email/thread-view"
import { initAccountStore, useAccountStore } from "@/stores/account-store"
import { getExecutor } from "@/services/db/executor"
import { getThread } from "@/services/db/threads"
import { bootstrapPopout } from "@/services/bootstrap"
import {
  forceClosePopout,
  onPopoutCloseRequested,
  popoutThreadId,
} from "@/services/desktop/popout"
import { popoutDraftIsDirty } from "@/services/desktop/popout-draft"
import { installThreadSyncBridge } from "@/services/desktop/thread-sync-bridge"
import { useComposerStore } from "@/stores/composer-store"
import { useUiStore } from "@/stores/ui-store"

// The composer carries the TipTap editor; same code-split as the shell.
const Composer = lazy(() =>
  import("@/components/composer/composer").then((m) => ({
    default: m.Composer,
  }))
)

/**
 * Pop-out thread window surface (task 1.9, spec "Pop-out thread
 * windows"): the whole mail app boots in this window, but the root
 * renders a single thread instead of the shell. Convergence is handled
 * by the shared thread-sync bridge (the thread list is empty here, but
 * badges refresh and the open thread remounts when the main window
 * touches it — and vice versa, since actions broadcast both ways).
 *
 * Close guard (spec: closing with an unsaved draft SHALL prompt): Rust
 * holds every close request for this window and emits
 * popout-close-requested; with a draft in progress a dialog resolves it
 * (save = keep the autosaved draft and close, discard = reset + close),
 * otherwise the close proceeds immediately.
 */

export function PopoutApp() {
  const threadId = popoutThreadId()
  const [booted, setBooted] = useState(false)
  const [bootError, setBootError] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(
    () => useUiStore.getState().composerOpen
  )
  const [closeGuardOpen, setCloseGuardOpen] = useState(false)

  // Pop-out boot: the database only — the sync scheduler, the offline
  // queue replay and the notification system stay main-window-owned
  // (single-authority background work, design D8), while reads and local
  // writes go straight to the shared SQLite file. The account/thread
  // stores are seeded so the reading pane can load immediately.
  useEffect(() => {
    if (threadId === null) return
    let cancelled = false
    bootstrapPopout()
      .then(async () => {
        const thread = await getThread(getExecutor(), threadId)
        if (cancelled) return
        if (!thread) {
          setBootError("This thread no longer exists.")
          return
        }
        await initAccountStore()
        useAccountStore.getState().setActive(thread.account_id)
        useUiStore.getState().setActiveThread(threadId)
        setBooted(true)
      })
      .catch((error) => {
        console.error("[popout] boot failed", error)
        if (!cancelled) setBootError(String(error))
      })
    return () => {
      cancelled = true
    }
  }, [threadId])

  // Mirror ui-store.composerOpen (the shared composer contract: reply
  // flows set the flag, this window mounts the overlay in response).
  useEffect(
    () =>
      useUiStore.subscribe((state) => {
        setComposerOpen(state.composerOpen)
      }),
    []
  )

  // Cross-window convergence: remote thread changes refresh badges and,
  // when the open thread was touched, bump the revision that remounts
  // the ThreadView (see thread-sync-bridge).
  useEffect(() => installThreadSyncBridge(), [])

  // The draft guard: Rust holds the close until this window resolves it.
  useEffect(() => {
    if (threadId === null) return
    let unlisten: (() => void) | undefined
    let disposed = false
    void onPopoutCloseRequested(() => {
      const dirty = popoutDraftIsDirty(useComposerStore.getState())
      if (dirty) {
        setCloseGuardOpen(true)
      } else {
        void forceClosePopout().catch(() => {})
      }
    }).then((off) => {
      if (disposed) off()
      else unlisten = off
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [threadId])

  if (threadId === null) {
    // Only reachable when this surface is mounted outside a pop-out
    // window (dev curiosity) — say so instead of a blank window.
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        No thread window context.
      </div>
    )
  }

  if (bootError !== null) {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <Titlebar />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {bootError}
        </div>
      </div>
    )
  }

  if (!booted) {
    return (
      <div className="flex h-screen flex-col bg-background text-foreground">
        <Titlebar />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          Loading…
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <Titlebar />
      <div className="min-h-0 flex-1 overflow-hidden" data-testid="popout-thread">
        <ThreadView />
      </div>
      {composerOpen && (
        <div
          data-testid="composer-overlay"
          className="fixed inset-0 z-40 bg-background"
        >
          <Suspense fallback={null}>
            <Composer />
          </Suspense>
        </div>
      )}
      {closeGuardOpen && (
        <Dialog open onOpenChange={setCloseGuardOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Save draft before closing?</DialogTitle>
              <DialogDescription>
                This window has a message in progress. The draft is saved
                automatically in Drafts — closing keeps it; discarding
                deletes it.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setCloseGuardOpen(false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  useComposerStore.getState().reset()
                  setCloseGuardOpen(false)
                  void forceClosePopout().catch(() => {})
                }}
              >
                Discard &amp; close
              </Button>
              <Button
                onClick={() => {
                  // Keep the autosaved draft: hide the composer, then close.
                  useComposerStore.getState().close()
                  useUiStore.getState().setComposerOpen(false)
                  setCloseGuardOpen(false)
                  void forceClosePopout().catch(() => {})
                }}
              >
                Save &amp; close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
      <Toaster position="bottom-right" />
    </div>
  )
}
