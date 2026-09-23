import { cn } from "cn"
import * as ResizablePrimitive from "react-resizable-panels"

function ResizablePanelGroup({
  className,
  ...props
}: ResizablePrimitive.GroupProps) {
  return (
    <ResizablePrimitive.Group
      data-slot="resizable-panel-group"
      className={cn(
        "flex h-full w-full aria-[orientation=vertical]:flex-col",
        className
      )}
      {...props}
    />
  )
}

function ResizablePanel({ ...props }: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

/** localStorage-backed LayoutStorage. The try/catch keeps privacy-mode and
 * quota errors from crashing layout saves (defaults return next boot). */
const layoutStorage: ResizablePrimitive.LayoutStorage = {
  getItem: (key) => {
    try {
      const raw = localStorage.getItem(key)
      if (raw === null) return null
      // useDefaultLayout parses its stored value WITHOUT a guard, so a
      // corrupt entry would throw during render and blank the whole
      // shell. Only hand over values shaped like a Layout
      // ({ [panelId]: number }) — anything else degrades to defaults.
      const parsed: unknown = JSON.parse(raw)
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        Object.values(parsed).every((value) => typeof value === "number")
      ) {
        return raw
      }
      return null
    } catch {
      return null
    }
  },
  setItem: (key, value) => {
    try {
      localStorage.setItem(key, value)
    } catch {
      // Save dropped; the in-session layout keeps working.
    }
  },
}

/**
 * Saved-layout wiring for one panel group (react-resizable-panels v4):
 * restores the group's last user-dragged sizes at mount and saves them
 * back on user-driven layout changes only. Imperative resizes — the
 * sidebar rail collapse, the narrow-window auto-rail — never enter the
 * saved layout; the collapsed state has its own preference. `panelIds`
 * must match the panels the group renders at mount.
 */
export function useSavedLayout(id: string, panelIds: string[]) {
  return ResizablePrimitive.useDefaultLayout({
    id,
    storage: layoutStorage,
    panelIds,
    onlySaveAfterUserInteractions: true,
  })
}

function ResizableHandle({
  withHandle,
  className,
  ...props
}: ResizablePrimitive.SeparatorProps & {
  withHandle?: boolean
}) {
  return (
    <ResizablePrimitive.Separator
      data-slot="resizable-handle"
      className={cn(
        "relative flex w-px items-center justify-center bg-border ring-offset-background after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2 focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-hidden aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full aria-[orientation=horizontal]:after:left-0 aria-[orientation=horizontal]:after:h-1 aria-[orientation=horizontal]:after:w-full aria-[orientation=horizontal]:after:translate-x-0 aria-[orientation=horizontal]:after:-translate-y-1/2 [&[aria-orientation=horizontal]>div]:rotate-90",
        className
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-6 w-1 shrink-0 rounded-lg bg-border" />
      )}
    </ResizablePrimitive.Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
