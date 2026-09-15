import { useEffect, useState, type PropsWithChildren } from "react"
import { useDroppable } from "@dnd-kit/core"
import {
  CirclePlus,
  PanelLeftClose,
  PanelLeftOpen,
  Settings,
  SquarePen,
} from "lucide-react"

import { cn } from "@/lib/utils"
import { Button, buttonVariants } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { LabelDeleteDialog } from "@/components/labels/label-delete-dialog"
import {
  LabelDialog,
  type LabelDialogState,
} from "@/components/labels/label-dialog"
import { LabelRowMenu } from "@/components/labels/label-row-menu"
import type { LabelRow } from "@/services/db/labels"
import { useAccountStore } from "@/stores/account-store"
import { useFolderCountsStore } from "@/stores/folder-counts-store"
import type { FolderSelection, ViewSelection } from "@/stores/ui-store"
import { useUiStore } from "@/stores/ui-store"
import {
  buildLabelHierarchy,
  DEPTH_SPACERS,
  useUserLabels,
} from "@/components/layout/use-sidebar-data"
import { FOLDER_ITEMS } from "./folders"

/**
 * The real mailbox sidebar (task 6.3, mailbox-ui spec "Sidebar
 * navigation"): compose button, system folders with live unread counts,
 * the active account's user labels as a "/"-hierarchy, and a settings
 * entry. Collapses to an icon rail (tooltips carry the names) — the
 * collapsed flag lives in uiStore and the shell mirrors it onto the
 * ResizablePanel. The account switcher stays above this composite in the
 * shell's left pane. The folder rows come from the shared FOLDER_ITEMS
 * constant (./folders) so the sidebar and the command palette render the
 * identical folder set.
 */

function isFolderActive(view: ViewSelection, folder: FolderSelection): boolean {
  if (view.kind !== "folder") return false
  if (view.folder.kind !== folder.kind) return false
  if (view.folder.kind === "specialUse" && folder.kind === "specialUse") {
    return view.folder.specialUse === folder.specialUse
  }
  return true
}

function isLabelActive(view: ViewSelection, labelId: string): boolean {
  if (view.kind === "label") return view.labelId === labelId
  return (
    view.kind === "folder" &&
    view.folder.kind === "labelId" &&
    view.folder.labelId === labelId
  )
}

/**
 * Drop target wrapper around a user label row (task 10.5, mail-organization
 * spec "Drag a thread onto a label"): registers the row with the shell's
 * DndContext under the label's id and highlights it while a thread drag
 * hovers (ring + accent tint, token-only). The whole row — including the
 * options-menu trigger — is the target area.
 */
function LabelDropTarget({
  labelId,
  children,
}: PropsWithChildren<{ labelId: string }>) {
  const { setNodeRef, isOver } = useDroppable({ id: labelId })
  return (
    <div
      ref={setNodeRef}
      data-label-drop-target={labelId}
      data-drag-over={isOver ? "true" : "false"}
      className={cn(
        "flex w-full items-center gap-0.5 rounded-md",
        isOver && "bg-accent ring-2 ring-ring/50"
      )}
    >
      {children}
    </div>
  )
}

interface SidebarProps {
  /** Icon-rail mode; mirrored from uiStore.sidebarCollapsed by the shell. */
  isCollapsed: boolean
}

export function Sidebar({ isCollapsed }: SidebarProps) {
  const view = useUiStore((state) => state.view)
  const setView = useUiStore((state) => state.setView)
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  const activeAccount = useAccountStore(
    (state) =>
      state.accounts.find((account) => account.id === state.activeAccountId) ??
      null
  )
  const counts = useFolderCountsStore((state) => state.counts)
  const refreshFolderCounts = useFolderCountsStore(
    (state) => state.refreshFolderCounts
  )

  // Refresh badges + labels on mount and on every account switch — the
  // sidebar subscribes to the account store directly (the store itself
  // stays sidebar-agnostic).
  const labels = useUserLabels(activeAccountId)
  useEffect(() => {
    void refreshFolderCounts()
  }, [activeAccountId, refreshFolderCounts])

  // Label CRUD dialog state (task 10.4): null = nothing open. The dialogs
  // run the local-first label-admin flows and notify the label hook.
  const [labelDialog, setLabelDialog] = useState<LabelDialogState | null>(null)
  const [deletingLabel, setDeletingLabel] = useState<LabelRow | null>(null)

  const selectFolder = (folder: FolderSelection) => {
    setView({ kind: "folder", folder })
  }
  const selectLabel = (label: LabelRow) => {
    setView({ kind: "label", labelId: label.id, name: label.name })
  }

  const labelNodes = buildLabelHierarchy(labels)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 py-2">
      {/* Compose — the composer itself lands with task 8.1, which consumes
          uiStore.composerOpen; until then setting the flag is a no-op. */}
      {isCollapsed ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-lg"
                aria-label="Compose"
                className="mx-auto"
                onClick={() => useUiStore.getState().setComposerOpen(true)}
              >
                <SquarePen />
              </Button>
            }
          />
          <TooltipContent side="right">Compose</TooltipContent>
        </Tooltip>
      ) : (
        <div className="px-2">
          <Button
            size="lg"
            className="w-full justify-start"
            onClick={() => useUiStore.getState().setComposerOpen(true)}
          >
            <SquarePen />
            Compose
          </Button>
        </div>
      )}
      <Separator />
      <ScrollArea className="min-h-0 flex-1">
        {/* justify-items-center: grid cells stretch by default, which
            pins the icon buttons to the rail's left edge when collapsed. */}
        <nav
          aria-label="Folders"
          className={cn(
            "grid items-start gap-0.5 p-2",
            isCollapsed && "justify-items-center"
          )}
        >
          {FOLDER_ITEMS.map((item) =>
            isCollapsed ? (
              <Tooltip key={item.countKey}>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={item.title}
                      aria-current={
                        isFolderActive(view, item.folder) ? "true" : undefined
                      }
                      className={cn(
                        buttonVariants({ variant: "ghost", size: "icon-lg" }),
                        "mx-auto",
                        isFolderActive(view, item.folder) &&
                          "bg-muted text-foreground"
                      )}
                      onClick={() => selectFolder(item.folder)}
                    >
                      <item.icon />
                    </button>
                  }
                />
                <TooltipContent side="right" className="gap-2">
                  {item.title}
                  {counts[item.countKey] > 0 && (
                    <span className="text-muted-foreground tabular-nums">
                      {counts[item.countKey]}
                    </span>
                  )}
                </TooltipContent>
              </Tooltip>
            ) : (
              <button
                key={item.countKey}
                type="button"
                aria-current={
                  isFolderActive(view, item.folder) ? "true" : undefined
                }
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "w-full justify-start",
                  isFolderActive(view, item.folder) &&
                    "bg-muted text-foreground"
                )}
                onClick={() => selectFolder(item.folder)}
              >
                <item.icon />
                {item.title}
                {counts[item.countKey] > 0 && (
                  <span className="ml-auto rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground tabular-nums">
                    {counts[item.countKey]}
                  </span>
                )}
              </button>
            )
          )}
        </nav>
        {/* User labels keep the wide layout only — an icon rail cannot
            represent a hierarchy, so the section yields until expanded.
            The section (and its "+" button) renders whenever expanded, so
            the first label can be created too (task 10.4). */}
        {!isCollapsed && (
          <>
            <Separator />
            <nav aria-label="Labels" className="grid items-start gap-0.5 p-2">
              <div className="flex items-center justify-between gap-1 pr-0.5">
                <p className="px-2 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  Labels
                </p>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="New label"
                        disabled={activeAccount === null}
                        onClick={() => setLabelDialog({ mode: "create" })}
                      >
                        <CirclePlus />
                      </Button>
                    }
                  />
                  <TooltipContent side="right">New label</TooltipContent>
                </Tooltip>
              </div>
              {labelNodes.map(({ label, depth, display }) => (
                <LabelDropTarget key={label.id} labelId={label.id}>
                  <button
                    type="button"
                    aria-current={
                      isLabelActive(view, label.id) ? "true" : undefined
                    }
                    className={cn(
                      buttonVariants({ variant: "ghost", size: "sm" }),
                      "min-w-0 flex-1 justify-start",
                      isLabelActive(view, label.id) &&
                        "bg-muted text-foreground"
                    )}
                    onClick={() => selectLabel(label)}
                  >
                    <span
                      aria-hidden
                      className={cn("shrink-0", DEPTH_SPACERS[depth] ?? "w-12")}
                    />
                    {/* Data-color exception: label.color is user content from
                        the DB (e.g. a Gmail hex string imported by sync or a
                        var(--chart-N) token reference) — rendered as-is, like
                        thread text. This is not component styling, so the
                        token rule does not apply; NULL colors fall back to a
                        token dot. */}
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full bg-muted-foreground/40"
                      style={
                        label.color
                          ? { backgroundColor: label.color }
                          : undefined
                      }
                    />
                    <span className="truncate">{display}</span>
                  </button>
                  {/* Only user labels reach this list (system labels are
                      filtered by the hook), so every row gets its menu. */}
                  <LabelRowMenu
                    label={label}
                    onRename={(row) =>
                      setLabelDialog({ mode: "rename", label: row })
                    }
                    onRecolor={(row) =>
                      setLabelDialog({ mode: "color", label: row })
                    }
                    onDelete={setDeletingLabel}
                  />
                </LabelDropTarget>
              ))}
            </nav>
          </>
        )}
      </ScrollArea>
      <Separator />
      {/* Footer: settings + collapse only. The sync/queue indicators live
          in the shell's bottom status bar (status-bar.tsx). */}
      <div
        className={cn(
          "flex items-center gap-0.5 p-2",
          isCollapsed && "flex-col px-0"
        )}
      >
        {isCollapsed ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Settings"
                  aria-current={view.kind === "settings" ? "true" : undefined}
                  className={cn(
                    buttonVariants({ variant: "ghost", size: "icon-lg" }),
                    "mx-auto",
                    view.kind === "settings" && "bg-muted text-foreground"
                  )}
                  onClick={() => setView({ kind: "settings" })}
                >
                  <Settings />
                </button>
              }
            />
            <TooltipContent side="right">Settings</TooltipContent>
          </Tooltip>
        ) : (
          <button
            type="button"
            aria-current={view.kind === "settings" ? "true" : undefined}
            className={cn(
              buttonVariants({ variant: "ghost", size: "sm" }),
              "shrink-0 justify-start",
              view.kind === "settings" && "bg-muted text-foreground"
            )}
            onClick={() => setView({ kind: "settings" })}
          >
            <Settings />
            Settings
          </button>
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size={isCollapsed ? "icon-lg" : "icon"}
                variant="ghost"
                aria-label={isCollapsed ? "Expand sidebar" : "Collapse sidebar"}
                className={cn(!isCollapsed && "ml-auto")}
                onClick={toggleSidebar}
              >
                {isCollapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
              </Button>
            }
          />
          {isCollapsed && (
            <TooltipContent side="right">Expand sidebar</TooltipContent>
          )}
        </Tooltip>
      </div>
      {/* Label CRUD (task 10.4). Keying the dialog by mode + label remounts
          it on every open so its input/error state always starts fresh. */}
      {labelDialog && (
        <LabelDialog
          key={`${labelDialog.mode}:${labelDialog.label?.id ?? "new"}`}
          state={labelDialog}
          account={
            activeAccount
              ? { id: activeAccount.id, type: activeAccount.type }
              : null
          }
          parentOptions={labels}
          onOpenChange={(open) => {
            if (!open) setLabelDialog(null)
          }}
        />
      )}
      <LabelDeleteDialog
        label={deletingLabel}
        account={
          activeAccount
            ? { id: activeAccount.id, type: activeAccount.type }
            : null
        }
        onOpenChange={(open) => {
          if (!open) setDeletingLabel(null)
        }}
      />
    </div>
  )
}
