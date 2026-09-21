import { lazy, Suspense, useEffect, useState } from "react"

import { Toaster } from "@/components/ui/sonner"
import {
  composerPopoutDraftKey,
  forceClosePopout,
  onPopoutCloseRequested,
} from "@/services/desktop/popout"
import { bootstrapPopout } from "@/services/bootstrap"
import {
  restoreDraftAttachmentBytes,
  type RestoredDraftAttachment,
} from "@/services/composer/draft-attachments"
import { getDraftByKey } from "@/services/composer/drafts"
import { getExecutor } from "@/services/db/executor"
import { openDraftForResume } from "@/components/email/reply-opener"
import { initAccountStore, useAccountStore } from "@/stores/account-store"
import { useComposerStore } from "@/stores/composer-store"
import { useUiStore } from "@/stores/ui-store"

// The composer carries the TipTap editor; same code-split as the shell.
const Composer = lazy(() =>
  import("@/components/composer/composer").then((m) => ({
    default: m.Composer,
  }))
)

/**
 * Composer pop-out window surface (batch C2): the JS half of the "pop the
 * composer into its own window" header button. The window's Tauri label is
 * `popout-composer-<draftKey>` — the label IS the state transfer. The main
 * window persists the current snapshot (saveNow) BEFORE opening this
 * window and closes its own overlay; here the draft — including the
 * batch-C1-persisted attachment bytes — is resumed from the shared
 * local_drafts row through the ONE resume path (openDraftForResume), so
 * the popout's autosave keeps updating the same row the main window was
 * writing. No draft fields ever travel through a URL.
 *
 * The surface is the composer alone, full-window (the shell's centered/
 * full size-mode chrome is meaningless in a window of its own — the
 * minimize and pop-out header buttons hide inside this surface via
 * isComposerPopoutWindow()).
 *
 * Close discipline: the draft survives EVERY exit. The Rust close guard
 * holds CloseRequested for `popout-*` labels and emits
 * popout-close-requested; this surface answers it by closing the composer
 * (the unmount autosave flush keeps the row current) and then force-closing
 * the window. The composer's own X button runs saveNow + close; when the
 * composer closes that way, this surface closes the window with it.
 */
export function ComposerPopoutApp() {
  const draftKey = composerPopoutDraftKey()
  const [booted, setBooted] = useState(false)
  const [bootError, setBootError] = useState<string | null>(null)
  const [composerOpen, setComposerOpen] = useState(
    () => useUiStore.getState().composerOpen
  )

  // Pop-out boot: the database only (bootstrapPopout), then the draft row
  // by label key and its persisted attachment bytes. openDraftForResume
  // configures the composer store and flips ui-store.composerOpen, which
  // mounts the overlay below — the exact bridge the shell uses.
  useEffect(() => {
    if (draftKey === null) return
    let cancelled = false
    void (async () => {
      try {
        await bootstrapPopout()
        const executor = getExecutor()
        const draft = await getDraftByKey(executor, draftKey)
        if (cancelled) return
        if (!draft) {
          setBootError("This draft no longer exists.")
          return
        }
        let restored: RestoredDraftAttachment[] = []
        try {
          const loaded = await restoreDraftAttachmentBytes(
            executor,
            draft.accountId,
            draft.draftKey ?? draftKey
          )
          restored = loaded.attachments
        } catch (error) {
          console.warn("[composer-popout] attachment restore failed", error)
        }
        await initAccountStore()
        if (cancelled) return
        useAccountStore.getState().setActive(draft.accountId)
        openDraftForResume(draft, restored)
        setBooted(true)
      } catch (error) {
        console.error("[composer-popout] boot failed", error)
        if (!cancelled) setBootError(String(error))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [draftKey])

  // Mirror ui-store.composerOpen into component state so the overlay and
  // the window-close reaction track the shared composer contract.
  useEffect(
    () =>
      useUiStore.subscribe((state) => {
        setComposerOpen(state.composerOpen)
      }),
    []
  )

  // Rust close guard: keep the draft, then let the window die. The
  // composer close comes first so the unmount autosave flush lands
  // before destruction.
  useEffect(() => {
    if (draftKey === null) return
    let unlisten: (() => void) | undefined
    let disposed = false
    void onPopoutCloseRequested(() => {
      closeComposerKeepingDraft()
      window.setTimeout(() => {
        void forceClosePopout().catch(() => {})
      }, 200)
    }).then((off) => {
      if (disposed) off()
      else unlisten = off
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [draftKey])

  // The composer closed itself (the X button's saveNow + close): the
  // window's whole purpose is gone — close it, keeping the draft.
  useEffect(() => {
    if (booted && !composerOpen) {
      const timer = window.setTimeout(() => {
        void forceClosePopout().catch(() => {})
      }, 200)
      return () => window.clearTimeout(timer)
    }
  }, [booted, composerOpen])

  if (draftKey === null) {
    // Only reachable outside a composer pop-out window (dev curiosity).
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        No composer window context.
      </div>
    )
  }

  if (bootError !== null) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        {bootError}
      </div>
    )
  }

  if (!booted) {
    return (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading…
      </div>
    )
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-background text-foreground">
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
      <Toaster position="bottom-right" />
    </div>
  )
}

/** The keep-draft close: drop the open flags only — the local_drafts row
 * stays for the Drafts folder (same store discipline as the main shell). */
function closeComposerKeepingDraft(): void {
  useComposerStore.getState().close()
  useUiStore.getState().setComposerOpen(false)
}
