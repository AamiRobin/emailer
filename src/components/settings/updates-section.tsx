import { useEffect, useRef, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import { relaunch } from "@tauri-apps/plugin-process"
import { CircleCheck, Download, Loader2, RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { getExecutor } from "@/services/db/executor"
import {
  checkForUpdate,
  downloadAndInstallUpdate,
  getUpdateChannel,
  setUpdateChannel,
  UPDATE_DOWNLOAD_PROGRESS_EVENT,
  type UpdateChannel,
  type UpdateMetadata,
} from "@/services/updates/updater"

/**
 * Settings "Updates" section: the release channel (stable / beta) plus a
 * manual check-for-updates button. Checks go through the Rust updater
 * commands (src/services/updates/updater.ts) so the channel's manifest
 * endpoint is picked server-side; installing hands back to the plugin and
 * relaunches.
 *
 * Only the packaged desktop app can check — in the browser (mock mode)
 * there is no Tauri IPC, and the section says so instead of offering a
 * button that can only fail.
 */

const IS_DESKTOP_APP =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window

type CheckState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date" }
  | { kind: "available"; update: UpdateMetadata }
  | { kind: "downloading"; received: number; total: number | null }
  | { kind: "ready" }
  | { kind: "error"; message: string }

export function UpdatesSection() {
  const [channel, setChannel] = useState<UpdateChannel>("stable")
  const [state, setState] = useState<CheckState>({ kind: "idle" })
  // Set as soon as the user changes the channel: the async initial load
  // must never clobber a change with a stale DB read (reading-section
  // pattern).
  const dirtyRef = useRef(false)

  useEffect(() => {
    try {
      void getUpdateChannel(getExecutor())
        .then((stored) => {
          if (!dirtyRef.current) setChannel(stored)
        })
        .catch(() => {})
    } catch (error) {
      console.warn("[updates] channel load failed", error)
    }
  }, [])

  function changeChannel(next: UpdateChannel) {
    dirtyRef.current = true
    setChannel(next)
    setState({ kind: "idle" })
    try {
      void setUpdateChannel(getExecutor(), next).catch(() => {})
    } catch {
      // Unpersisted channel (browser mock): the choice still holds for
      // this session's manual check.
    }
  }

  async function runCheck() {
    setState({ kind: "checking" })
    try {
      const update = await checkForUpdate(channel)
      if (!update) {
        setState({ kind: "up-to-date" })
        return
      }
      setState({ kind: "available", update })
    } catch (error) {
      setState({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Could not check for updates.",
      })
    }
  }

  async function downloadAndInstall() {
    setState({ kind: "downloading", received: 0, total: null })
    const unlisten = await listen<{
      received: number
      total: number | null
    }>(UPDATE_DOWNLOAD_PROGRESS_EVENT, (event) => {
      setState({
        kind: "downloading",
        received: event.payload.received,
        total: event.payload.total,
      })
    })
    try {
      await downloadAndInstallUpdate()
      setState({ kind: "ready" })
    } catch (error) {
      setState({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "The update could not be downloaded.",
      })
    } finally {
      unlisten()
    }
  }

  return (
    <section aria-label="Updates" className="flex flex-col gap-4">
      <div>
        <h2 className="text-base font-semibold text-foreground">Updates</h2>
        <p className="text-sm text-muted-foreground">
          You are running emailer v{__APP_VERSION__}
          {channel === "beta" ? " on the beta channel" : ""}.
        </p>
      </div>

      <div className="grid gap-1.5">
        <Label htmlFor="update-channel">Release channel</Label>
        <Select
          items={{ stable: "Stable", beta: "Beta" }}
          value={channel}
          onValueChange={(value) => {
            if (value === "stable" || value === "beta") changeChannel(value)
          }}
        >
          <SelectTrigger id="update-channel" className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stable">
              Stable — tagged releases only
            </SelectItem>
            <SelectItem value="beta">
              Beta — prereleases as soon as they build
            </SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          The channel decides which manifest update checks ask; switching
          takes effect on the next check.
        </p>
      </div>

      {IS_DESKTOP_APP ? (
        <div className="flex flex-col items-start gap-2">
          <Button
            size="sm"
            onClick={() => void runCheck()}
            disabled={state.kind === "checking" || state.kind === "downloading"}
          >
            {state.kind === "checking" ? (
              <Loader2 className="animate-spin" aria-hidden />
            ) : (
              <RefreshCw />
            )}
            Check for updates
          </Button>
          <CheckStatus
            state={state}
            channel={channel}
            onInstall={() => void downloadAndInstall()}
            onRestart={() => void relaunch()}
          />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Update checks are only available in the installed desktop app.
        </p>
      )}
    </section>
  )
}

function CheckStatus({
  state,
  channel,
  onInstall,
  onRestart,
}: {
  state: CheckState
  channel: UpdateChannel
  onInstall: () => void
  onRestart: () => void
}) {
  switch (state.kind) {
    case "idle":
      return null
    case "checking":
      return <p className="text-sm text-muted-foreground">Checking the {channel} channel…</p>
    case "up-to-date":
      return (
        <p
          role="status"
          className="flex items-center gap-1.5 text-sm text-muted-foreground"
        >
          <CircleCheck className="size-4" aria-hidden />
          emailer is up to date.
        </p>
      )
    case "available":
      return (
        <div className="flex flex-col items-start gap-2">
          <p role="status" className="text-sm text-foreground">
            Version {state.update.version} is available on the {channel}{" "}
            channel (you are on {state.update.currentVersion}).
          </p>
          <Button size="sm" onClick={() => onInstall()}>
            <Download />
            Download and install
          </Button>
        </div>
      )
    case "downloading": {
      const percent =
        state.total && state.total > 0
          ? Math.min(100, Math.round((state.received / state.total) * 100))
          : null
      return (
        <p role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden />
          Downloading{percent !== null ? ` — ${percent}%` : "…"}
        </p>
      )
    }
    case "ready":
      return (
        <div className="flex flex-col items-start gap-2">
          <p role="status" className="text-sm text-foreground">
            Update installed — restart to apply it.
          </p>
          <Button size="sm" onClick={onRestart}>
            <RefreshCw />
            Restart
          </Button>
        </div>
      )
    case "error":
      return (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      )
  }
}
