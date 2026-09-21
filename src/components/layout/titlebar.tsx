import { Minus, Square, X } from "lucide-react"

import { cn } from "@/lib/utils"
import { isTauriRuntime } from "@/services/desktop/popout"
import { getCurrentWindow } from "@tauri-apps/api/window"

/**
 * Custom titlebar (task 1.8, spec mailbox-ui "Custom titlebar"). One
 * component, two platform configurations (design D8):
 *
 * - macOS keeps the native traffic lights over the webview
 *   (`titleBarStyle: overlay` in tauri.conf.json); the titlebar is a
 *   themed drag region with an inset for the lights.
 * - Windows/Linux run undecorated (`tauri.{windows,linux}.conf.json`) and
 *   the titlebar carries the min/max/close controls. Close routes through
 *   the window's CloseRequested (lib.rs), so it honors the hide-to-tray
 *   setting exactly like the OS close would.
 *
 * Dragging and double-click-to-maximize are the runtime's drag-region
 * handling on the marked elements (`data-tauri-drag-region`); the window
 * control buttons deliberately lack the attribute so clicks don't drag.
 * Rendered only inside the Tauri runtime — the plain-vite mock has no
 * window to control.
 */

/** True on macOS (where the traffic lights live), false elsewhere. */
function isMacPlatform(): boolean {
  const uaData = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData
  if (uaData?.platform) return /mac/i.test(uaData.platform)
  return /Mac|iPhone|iPad/i.test(navigator.platform)
}

export function Titlebar() {
  if (!isTauriRuntime()) return null

  const mac = isMacPlatform()
  const window = getCurrentWindow()

  return (
    <div
      data-tauri-drag-region
      className={cn(
        "flex h-10 shrink-0 items-center",
        "border-b border-border bg-background",
        "select-none"
      )}
    >
      {/* macOS: inset for the native traffic lights (still draggable). */}
      {mac && <div data-tauri-drag-region className="w-[76px] shrink-0" />}
      <div data-tauri-drag-region className="flex-1 self-stretch" />
      {!mac && (
        <div className="flex shrink-0 items-stretch self-stretch">
          <TitlebarButton
            label="Minimize"
            onClick={() => {
              void window.minimize()
            }}
          >
            <Minus />
          </TitlebarButton>
          <TitlebarButton
            label="Maximize"
            onClick={() => {
              void window.toggleMaximize()
            }}
          >
            <Square />
          </TitlebarButton>
          <TitlebarButton
            label="Close"
            onClick={() => {
              void window.close()
            }}
          >
            <X />
          </TitlebarButton>
        </div>
      )}
    </div>
  )
}

function TitlebarButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="flex w-12 items-center justify-center text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {children}
    </button>
  )
}
