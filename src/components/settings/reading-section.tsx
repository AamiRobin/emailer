import { useEffect, useRef, useState } from "react"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { getNotificationsEnabled } from "@/services/db/settings"
import { getExecutor } from "@/services/db/executor"
import { setNotificationsEnabled } from "@/services/notifications/new-mail-notifier"
import { setReadingPanePreference } from "@/services/settings/preferences"
import type { ReadingPanePosition } from "@/stores/ui-store"
import { useUiStore } from "@/stores/ui-store"

/**
 * Settings "Reading" section (tasks 11.2/11.3): the default reading-pane
 * position (persisted through the settings table and applied to the
 * ui-store live — the same API the shell's pane switcher uses) and the
 * new-mail notification toggle (persisted via the notifier's
 * setNotificationsEnabled, which also invalidates its settings cache).
 * Unread counts are unaffected by the toggle — it only gates the OS
 * notification, not the badge computations.
 */

const PANE_OPTIONS: { value: ReadingPanePosition; label: string }[] = [
  { value: "right", label: "Right" },
  { value: "bottom", label: "Bottom" },
  { value: "hidden", label: "Hidden" },
]

const PANE_HINTS: Record<ReadingPanePosition, string> = {
  right: "Classic three-pane layout",
  bottom: "List stacked over the message",
  hidden: "Two-pane; messages open full-width",
}

export function ReadingSection() {
  const readingPane = useUiStore((state) => state.readingPane)
  const [notifications, setNotifications] = useState(true)
  // Set as soon as the user toggles: the async initial load must never
  // clobber a change with a stale DB read.
  const dirtyRef = useRef(false)

  // Load the persisted notification setting once (the shell only mounts
  // this page after bootstrap(), so the executor is available). The pane
  // position needs no load — the ui-store is the live source, seeded at
  // boot by applyBootPreferences. Failures keep the default (on).
  useEffect(() => {
    try {
      void getNotificationsEnabled(getExecutor())
        .then((enabled) => {
          if (!dirtyRef.current) setNotifications(enabled)
        })
        .catch(() => {})
    } catch (error) {
      console.warn("[reading] preference load failed", error)
    }
  }, [])

  function changePane(position: ReadingPanePosition): void {
    try {
      // Persists to the settings table, then updates the ui-store (live
      // re-layout; the shell's boot hook re-applies it on restart).
      void setReadingPanePreference(getExecutor(), position).catch((error) => {
        console.warn("[reading] failed to persist pane position", error)
      })
    } catch (error) {
      console.warn("[reading] failed to persist pane position", error)
    }
  }

  async function changeNotifications(enabled: boolean): Promise<void> {
    const previous = notifications
    dirtyRef.current = true
    setNotifications(enabled)
    try {
      // Persists AND refreshes the notifier's in-memory cache (30s TTL),
      // so the flip takes effect on the very next sync pass.
      await setNotificationsEnabled(enabled)
    } catch (error) {
      setNotifications(previous)
      console.warn("[reading] failed to persist notifications", error)
    }
  }

  return (
    <section aria-label="Reading" className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">Reading</h2>
        <p className="text-sm text-muted-foreground">
          How the mailbox is laid out and when you are notified about new mail.
        </p>
      </div>
      <div className="divide-y divide-border">
        <div className="flex items-center justify-between gap-6 py-3">
          <div className="grid gap-0.5">
            <Label htmlFor="reading-pane-position">Reading pane</Label>
            <p className="text-xs text-muted-foreground">
              {PANE_HINTS[readingPane]}.
            </p>
          </div>
          <Select
            value={readingPane}
            items={Object.fromEntries(
              PANE_OPTIONS.map((option) => [option.value, option.label])
            )}
            onValueChange={(value) =>
              changePane(String(value) as ReadingPanePosition)
            }
          >
            <SelectTrigger id="reading-pane-position" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PANE_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between gap-6 py-3">
          <div className="grid gap-0.5">
            <Label htmlFor="reading-notifications">
              New-mail notifications
            </Label>
            <p className="text-xs text-muted-foreground">
              Show a system notification when sync finds new messages. Unread
              badges are always kept up to date.
            </p>
          </div>
          <Switch
            id="reading-notifications"
            checked={notifications}
            onCheckedChange={(checked) => {
              void changeNotifications(checked)
            }}
          />
        </div>
      </div>
    </section>
  )
}
