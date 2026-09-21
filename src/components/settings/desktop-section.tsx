import { useEffect, useRef, useState } from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { getExecutor } from "@/services/db/executor"
import {
  getMailtoDefaultState,
  setMailtoDefault,
} from "@/services/desktop/mailto"
import { isAutostartEnabled, isTrayAvailable, setAutostartEnabled } from "@/services/desktop/tray"
import {
  getCloseAction,
  getComposeShortcut,
  getMailtoPreviousHandler,
  setCloseActionPreference,
  setComposeShortcutPreference,
  setMailtoPreviousHandler,
  type CloseAction,
} from "@/services/settings/preferences"

/**
 * Settings "Desktop" section (tasks 1.2/1.4/1.5/1.6, spec
 * desktop-integration): the close-to-tray vs quit choice, the
 * default-mail-client control, the global compose shortcut, and
 * launch-at-login. Tray-dependent controls are hidden when the platform
 * has no tray (`tray_available` is false — Linux without appindicator,
 * the plain-vite mock): the spec requires the app to behave as a normal
 * windowed application there, so the control would be a lie.
 *
 * The mailto toggle reflects the live OS state on every mount; taking
 * over records the displaced handler (macOS LaunchServices cannot name
 * it afterwards) so "unset" restores the actual previous client.
 *
 * The compose shortcut is stored as the accelerator string the global-
 * shortcut plugin understands ("CmdOrCtrl+Shift+E"); the Rust command
 * validates and registers, and a rejected binding surfaces its specific
 * error inline (spec: validated for conflicts where the OS reports
 * them). Clearing the field unregisters.
 *
 * Launch-at-login reflects the actual OS registration on every mount
 * (the registration itself persists — no settings row); an autostart
 * boot passes --hidden, so the app starts parked in the tray.
 */

const CLOSE_ACTION_OPTIONS: { value: CloseAction; label: string }[] = [
  { value: "quit", label: "Quit Emailer" },
  { value: "hide", label: "Hide to tray" },
]

export function DesktopSection() {
  const [trayAvailable, setTrayAvailable] = useState(false)
  const [closeAction, setCloseAction] = useState<CloseAction>("quit")
  const [isMailtoDefault, setIsMailtoDefault] = useState(false)
  const [mailtoBusy, setMailtoBusy] = useState(false)
  const [shortcut, setShortcut] = useState<string | null>(null)
  const [shortcutDraft, setShortcutDraft] = useState("")
  const [shortcutError, setShortcutError] = useState<string | null>(null)
  const [autostart, setAutostart] = useState(false)
  // Set as soon as the user toggles: the async initial load must never
  // clobber a change with a stale DB read (same ref discipline as the
  // reading section's notification toggle).
  const dirtyRef = useRef(false)

  const refreshMailtoState = useRef(async () => {
    const state = await getMailtoDefaultState()
    if (state) setIsMailtoDefault(state.is_default)
  })

  useEffect(() => {
    void isTrayAvailable().then(setTrayAvailable)
    void refreshMailtoState.current()
    void isAutostartEnabled().then(setAutostart)
    try {
      void getCloseAction(getExecutor())
        .then((action) => {
          if (!dirtyRef.current) setCloseAction(action)
        })
        .catch(() => {})
      void getComposeShortcut(getExecutor())
        .then((stored) => {
          setShortcut(stored)
          setShortcutDraft(stored ?? "")
        })
        .catch(() => {})
    } catch (error) {
      console.warn("[settings] desktop preference load failed", error)
    }
  }, [])

  async function changeCloseAction(action: CloseAction): Promise<void> {
    const previous = closeAction
    dirtyRef.current = true
    setCloseAction(action)
    try {
      // Persists to the settings table AND pushes the live value to the
      // Rust close-request handler (the next close behaves immediately).
      await setCloseActionPreference(getExecutor(), action)
    } catch (error) {
      setCloseAction(previous)
      console.warn("[settings] failed to persist close action", error)
    }
  }

  async function changeMailtoDefault(enabled: boolean): Promise<void> {
    setMailtoBusy(true)
    try {
      if (enabled) {
        // Record the displaced handler BEFORE taking over, so unsetting
        // can restore the actual previous client (not just a guess).
        const state = await getMailtoDefaultState()
        const displaced = state?.current_handler ?? null
        await setMailtoPreviousHandler(
          getExecutor(),
          state?.is_default ? null : displaced
        )
        await setMailtoDefault(true, null)
      } else {
        const stored = await getMailtoPreviousHandler(getExecutor())
        await setMailtoDefault(false, stored)
        await setMailtoPreviousHandler(getExecutor(), null)
      }
      await refreshMailtoState.current()
    } catch (error) {
      console.warn("[settings] mailto registration failed", error)
    } finally {
      setMailtoBusy(false)
    }
  }

  async function saveComposeShortcut(accelerator: string | null): Promise<void> {
    setShortcutError(null)
    try {
      // The Rust command validates the accelerator (parse + OS register)
      // and rejects with the specific reason; only then does the row
      // persist, so the saved value always matches the live registration.
      await setComposeShortcutPreference(getExecutor(), accelerator)
      setShortcut(accelerator)
      setShortcutDraft(accelerator ?? "")

    } catch (error) {
      setShortcutError(String(error))
    }
  }

  return (
    <section aria-label="Desktop" className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">Desktop</h2>
        <p className="text-sm text-muted-foreground">
          How Emailer behaves in your operating system.
        </p>
      </div>
      <Separator />
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor="desktop-mailto-default">Default mail client</Label>
          <p className="text-xs text-muted-foreground">
            Handle mailto: links from your browser and other apps in Emailer.
            Unsetting restores the previous default mail client.
          </p>
        </div>
        <Switch
          id="desktop-mailto-default"
          checked={isMailtoDefault}
          disabled={mailtoBusy}
          onCheckedChange={(checked) => {
            void changeMailtoDefault(checked)
          }}
        />
      </div>
      <Separator />
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor="desktop-autostart">Launch at login</Label>
          <p className="text-xs text-muted-foreground">
            Start Emailer automatically when you log in, hidden in the tray —
            syncing and notifying from the start.
          </p>
        </div>
        <Switch
          id="desktop-autostart"
          checked={autostart}
          onCheckedChange={(checked) => {
            const previous = autostart
            setAutostart(checked)
            void setAutostartEnabled(checked).catch(() => {
              // Roll the toggle back when the OS refuses the registration.
              setAutostart(previous)
            })
          }}
        />
      </div>
      <Separator />
      <div className="grid gap-2">
        <Label htmlFor="desktop-compose-shortcut">Global compose shortcut</Label>
        <div className="flex items-center gap-2">
          <Input
            id="desktop-compose-shortcut"
            value={shortcutDraft}
            placeholder="e.g. CmdOrCtrl+Shift+E"
            className="w-64 font-mono text-xs"
            onChange={(event) => {
              setShortcutDraft(event.target.value)
              setShortcutError(null)
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={shortcutDraft.trim() === (shortcut ?? "")}
            onClick={() => {
              void saveComposeShortcut(
                shortcutDraft.trim() === "" ? null : shortcutDraft.trim()
              )
            }}
          >
            Save
          </Button>
          {shortcut !== null && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void saveComposeShortcut(null)
              }}
            >
              Clear
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {shortcut
            ? "Registered — pressing it in any application surfaces Emailer with a fresh composer."
            : "No global shortcut registered. Use modifier prefixes like CmdOrCtrl+Shift+…"}
        </p>
        {shortcutError && (
          <p role="alert" className="text-xs text-destructive">
            {shortcutError}
          </p>
        )}
      </div>
      {trayAvailable ? (
        <div className="grid gap-2">
          <Label htmlFor="desktop-close-action">When closing the window</Label>
          <Select
            value={closeAction}
            items={{
              quit: "Quit Emailer",
              hide: "Hide to tray",
            }}
            onValueChange={(value) => {
              void changeCloseAction(String(value) as CloseAction)
            }}
          >
            <SelectTrigger id="desktop-close-action" className="w-64">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CLOSE_ACTION_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {closeAction === "hide"
              ? "Emailer keeps running in the system tray — mail keeps syncing and notifications keep arriving. Restore it from the tray icon."
              : "Closing the window quits Emailer and stops background syncing."}
          </p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Tray integration is not available on this platform; Emailer behaves
          as a regular windowed application.
        </p>
      )}
    </section>
  )
}
