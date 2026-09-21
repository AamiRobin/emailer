import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"

import { MailShell } from "@/components/layout/mail-shell"
import { ShortcutsOverlay } from "@/components/layout/shortcuts-overlay"
import { Titlebar } from "@/components/layout/titlebar"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { bootstrap } from "@/services/bootstrap"

export default function App() {
  const [ready, setReady] = useState(false)
  const [initError, setInitError] = useState<string | null>(null)
  // Shortcuts help overlay state (task 6.6): owned here so the global
  // hook (`?` opens, Esc dismisses) and the overlay share it without a
  // dedicated store — design D13 keeps shortcut UI state minimal.
  const [helpOpen, setHelpOpen] = useState(false)

  // Global keyboard shortcuts: ONE hook, ONE window listener (D13).
  useKeyboardShortcuts({ helpOpen, setHelpOpen })

  // Initialize the database (migrations included) before rendering the
  // shell — features and stores read from it as soon as they mount.
  useEffect(() => {
    let cancelled = false
    bootstrap()
      .then(() => {
        if (!cancelled) setReady(true)
      })
      .catch((error) => {
        console.error("App initialization failed", error)
        if (!cancelled) setInitError(String(error))
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Splash screen (task 1.7): the shell is ready — drop the splash and
  // land on the main window. Best-effort: outside Tauri (mock mode)
  // there is no splash, and the Rust side carries a hard timeout that
  // also lands the user on the main window if this signal never fires.
  useEffect(() => {
    if (!ready && initError === null) return
    invoke("close_splashscreen").catch(() => {})
  }, [ready, initError])

  if (initError) {
    return (
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
        <Titlebar />
        <div className="flex flex-1 items-center justify-center">
          <p className="max-w-md text-center text-sm text-muted-foreground">
            Failed to initialize the local database. {initError}
          </p>
        </div>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
        <Titlebar />
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-muted-foreground">Loading…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <Titlebar />
      <div className="flex min-h-0 flex-1">
        <MailShell />
        <ShortcutsOverlay open={helpOpen} onOpenChange={setHelpOpen} />
      </div>
    </div>
  )
}
