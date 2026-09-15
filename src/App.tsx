import { useEffect, useState } from "react"

import { MailShell } from "@/components/layout/mail-shell"
import { ShortcutsOverlay } from "@/components/layout/shortcuts-overlay"
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

  if (initError) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
        <p className="max-w-md text-center text-sm text-muted-foreground">
          Failed to initialize the local database. {initError}
        </p>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="flex h-screen w-screen items-center justify-center bg-background text-foreground">
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    )
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <MailShell />
      <ShortcutsOverlay open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
  )
}
