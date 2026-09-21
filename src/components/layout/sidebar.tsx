import { useEffect, useState, type PropsWithChildren } from "react"
import { useDroppable } from "@dnd-kit/core"
import {
  BellRing,
  BookUser,
  Calendar,
  CirclePlus,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  Paperclip,
  Settings,
  SquarePen,
  Zap,
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
import { getExecutor } from "@/services/db/executor"
import { listActiveAccounts } from "@/services/db/accounts"
import { countNudges } from "@/services/db/nudges"
import { getNudgeDays } from "@/services/settings/preferences"
import type { LabelRow } from "@/services/db/labels"
import { useAccountStore } from "@/stores/account-store"
import { useFolderCountsStore } from "@/stores/folder-counts-store"
import { useThreadListStore } from "@/stores/thread-list-store"
import type { FolderSelection, ViewSelection } from "@/stores/ui-store"
import { useUiStore } from "@/stores/ui-store"
import {
  buildLabelHierarchy,
  DEPTH_SPACERS,
  useUserLabels,
} from "@/components/layout/use-sidebar-data"
import { SavedSearchesSection } from "./saved-searches-section"
import { ScheduledSendsSection } from "./scheduled-sends-dialog"
import { SnoozedSection } from "./snoozed-section"
import { TasksSection } from "./tasks-section"
import { TodosSection } from "./todos-section"
import { FOLDER_ITEMS } from "./folders"

/**
 * The real mailbox sidebar (task 6.3, mailbox-ui spec "Sidebar
 * navigation"): compose button, system folders with live unread counts,
 * the active account's user labels as a "/"-hierarchy, and a settings
 * entry — plus the scope entries above the folders: Unified inbox with 2+
 * active accounts (task 9.2), the Priority inbox (task 13.2, design D7)
 * and Nudges (task 14.1, design D8) with 1+ — all entering an
 * across-accounts list scope without changing the view selection. The
 * Nudges row carries the inbox marker: a live count of awaiting-reply
 * threads. Collapses to an icon rail (tooltips carry
 * the names) — the
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

/**
 * The Nudges inbox marker (task 14.1, mail-organization spec "surface
 * them in a Nudges view and/or with an inbox marker"): the count of
 * awaiting-reply threads across the ACTIVE accounts (db/nudges.countNudges
 * — the exact detection the view lists), rendered as a small pill on the
 * sidebar's Nudges entry. Liveness mirrors the split-tab counts (the
 * cheapest "mail changed" signal available): recomputed on mount, on
 * every account switch, and whenever the thread-list store's rows change
 * (refreshThreadList runs after sync completion and thread actions). A
 * failed count (e.g. no DB outside Tauri) keeps the badge empty.
 */
function useNudgeCount(): number {
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  const [count, setCount] = useState(0)
  const [revision, setRevision] = useState(0)
  useEffect(
    () =>
      useThreadListStore.subscribe((state, previous) => {
        if (state.threads !== previous.threads) {
          setRevision((value) => value + 1)
        }
      }),
    []
  )
  useEffect(() => {
    let cancelled = false
    Promise.resolve()
      .then(async () => {
        const executor = getExecutor()
        const activeIds = (await listActiveAccounts(executor)).map(
          (row) => row.id
        )
        if (activeIds.length === 0) return 0
        const thresholdDays = await getNudgeDays(executor)
        return countNudges(executor, { accountIds: activeIds, thresholdDays })
      })
      .then((next) => {
        if (!cancelled) setCount(next ?? 0)
      })
      .catch((error) => {
        console.warn("[sidebar] nudge count failed", error)
        if (!cancelled) setCount(0)
      })
    return () => {
      cancelled = true
    }
  }, [revision, activeAccountId])
  return count
}

export function Sidebar({ isCollapsed }: SidebarProps) {
  const view = useUiStore((state) => state.view)
  const setView = useUiStore((state) => state.setView)
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)
  const activeAccountId = useAccountStore((state) => state.activeAccountId)
  // Unified inbox entry (task 9.2): the entry point for the across-
  // accounts scope. It earns its place only with 2+ ACTIVE accounts —
  // with fewer it would just duplicate the single account's inbox.
  // Entering is one ui-store write; setView clears the scope again, so
  // every other navigation doubles as the way out.
  const accounts = useAccountStore((state) => state.accounts)
  const listScopeKind = useUiStore((state) => state.listScope?.kind)
  const unifiedActive = listScopeKind === "unified"
  const unifiedAvailable =
    accounts.filter((account) => account.status === "active").length >= 2
  // Priority inbox entry (task 13.2, design D7): unlike unified it is
  // useful with a SINGLE active account (the classification works within
  // one mailbox), so it renders with 1+ active accounts, next to Unified.
  const priorityAvailable = accounts.some(
    (account) => account.status === "active"
  )
  const priorityActive = listScopeKind === "priority"
  // Nudges entry (task 14.1, design D8): like Priority it is useful with
  // a single active account, so it renders with 1+ — always (the marker
  // count, not the entry, appears only while nudges exist).
  const nudgesAvailable = accounts.some(
    (account) => account.status === "active"
  )
  const nudgesActive = listScopeKind === "nudges"
  const nudgeCount = useNudgeCount()
  // Contacts entry (task 20.2): the address book accumulated across the
  // ACTIVE accounts, useful with 1+ like Priority/Nudges. Unlike those
  // scopes it is a real ViewSelection — the browser replaces the mailbox
  // panes (settings-style), so entering is one setView and any folder or
  // label click navigates out of it again.
  const contactsAvailable = accounts.some(
    (account) => account.status === "active"
  )
  const contactsActive = view.kind === "contacts"
  const enterContacts = () => {
    setView({ kind: "contacts" })
  }
  // Attachments entry (task 3.7, design D14): the CURRENT account's
  // attachments behind the ui-store "attachments" view — the same
  // settings-style full-pane browser as Contacts, scoped to the active
  // account (the hook re-queries on account switches).
  const attachmentsAvailable = accounts.some(
    (account) => account.status === "active"
  )
  const attachmentsActive = view.kind === "attachments"
  const enterAttachments = () => {
    setView({ kind: "attachments" })
  }
  // Calendar entry (task 5.3, design D5): the month/week/day calendar view
  // behind the ui-store "calendar" view — the same settings-style
  // full-pane surface as Contacts/Attachments, rendering the cached
  // calendar_events of every connected source. Renders with 1+ active
  // accounts like the other aggregate entries.
  const calendarAvailable = accounts.some(
    (account) => account.status === "active"
  )
  const calendarActive = view.kind === "calendar"
  const enterCalendar = () => {
    setView({ kind: "calendar" })
  }
  const enterUnifiedInbox = () => {
    useUiStore.getState().setListScope({ kind: "unified" })
  }
  const enterPriorityInbox = () => {
    useUiStore.getState().setListScope({ kind: "priority" })
  }
  const enterNudges = () => {
    useUiStore.getState().setListScope({ kind: "nudges" })
  }
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
          {/* Unified inbox (task 9.2): aggregates the active accounts'
              inboxes through the ui-store list-scope override — the view
              selection stays untouched, so any folder/label/search click
              exits again via setView. Rendered with 2+ active accounts in
              both layouts; the icon rail keeps the name in the tooltip. */}
          {unifiedAvailable &&
            (isCollapsed ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Unified inbox"
                      aria-current={unifiedActive ? "true" : undefined}
                      className={cn(
                        buttonVariants({ variant: "ghost", size: "icon-lg" }),
                        "mx-auto",
                        unifiedActive && "bg-muted text-foreground"
                      )}
                      onClick={enterUnifiedInbox}
                    >
                      <Layers />
                    </button>
                  }
                />
                <TooltipContent side="right">Unified inbox</TooltipContent>
              </Tooltip>
            ) : (
              <button
                type="button"
                aria-current={unifiedActive ? "true" : undefined}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "w-full justify-start",
                  unifiedActive && "bg-muted text-foreground"
                )}
                onClick={enterUnifiedInbox}
              >
                <Layers />
                Unified inbox
              </button>
            ))}
          {/* Priority inbox (task 13.2, design D7): the classified view —
              inbox threads whose newest sender scores important — entered
              through the same list-scope mechanism as Unified. Renders
              with 1+ active accounts (useful within a single mailbox). */}
          {priorityAvailable &&
            (isCollapsed ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Priority"
                      aria-current={priorityActive ? "true" : undefined}
                      className={cn(
                        buttonVariants({ variant: "ghost", size: "icon-lg" }),
                        "mx-auto",
                        priorityActive && "bg-muted text-foreground"
                      )}
                      onClick={enterPriorityInbox}
                    >
                      <Zap />
                    </button>
                  }
                />
                <TooltipContent side="right">Priority</TooltipContent>
              </Tooltip>
            ) : (
              <button
                type="button"
                aria-current={priorityActive ? "true" : undefined}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "w-full justify-start",
                  priorityActive && "bg-muted text-foreground"
                )}
                onClick={enterPriorityInbox}
              >
                <Zap />
                Priority
              </button>
            ))}
          {/* Nudges (task 14.1, design D8): the awaiting-reply threads the
              db/nudges.ts detection finds, entered through the same
              list-scope mechanism as Unified/Priority. The pill is the
              inbox marker — the count across the active accounts, shown
              only while it is positive (the folder-badge styling). */}
          {nudgesAvailable &&
            (isCollapsed ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Nudges"
                      aria-current={nudgesActive ? "true" : undefined}
                      className={cn(
                        buttonVariants({ variant: "ghost", size: "icon-lg" }),
                        "mx-auto",
                        nudgesActive && "bg-muted text-foreground"
                      )}
                      onClick={enterNudges}
                    >
                      <BellRing />
                    </button>
                  }
                />
                <TooltipContent side="right" className="gap-2">
                  Nudges
                  {nudgeCount > 0 && (
                    <span className="text-muted-foreground tabular-nums">
                      {nudgeCount}
                    </span>
                  )}
                </TooltipContent>
              </Tooltip>
            ) : (
              <button
                type="button"
                aria-current={nudgesActive ? "true" : undefined}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "w-full justify-start",
                  nudgesActive && "bg-muted text-foreground"
                )}
                onClick={enterNudges}
              >
                <BellRing />
                Nudges
                {nudgeCount > 0 && (
                  <span className="ml-auto rounded-full bg-muted px-1.5 text-xs font-medium text-muted-foreground tabular-nums">
                    {nudgeCount}
                  </span>
                )}
              </button>
            ))}
          {/* Contacts (task 20.2): the cross-account address book behind
              the ui-store "contacts" view — the settings-style full-pane
              browser (search/detail/edit/compose/delete). Renders with 1+
              active accounts, in both layouts like the entries above. */}
          {contactsAvailable &&
            (isCollapsed ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Contacts"
                      aria-current={contactsActive ? "true" : undefined}
                      className={cn(
                        buttonVariants({ variant: "ghost", size: "icon-lg" }),
                        "mx-auto",
                        contactsActive && "bg-muted text-foreground"
                      )}
                      onClick={enterContacts}
                    >
                      <BookUser />
                    </button>
                  }
                />
                <TooltipContent side="right">Contacts</TooltipContent>
              </Tooltip>
            ) : (
              <button
                type="button"
                aria-current={contactsActive ? "true" : undefined}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "w-full justify-start",
                  contactsActive && "bg-muted text-foreground"
                )}
                onClick={enterContacts}
              >
                <BookUser />
                Contacts
              </button>
            ))}
          {/* Attachments (task 3.7, design D14): the current account's
              attachment index behind the ui-store "attachments" view —
              the settings-style full-pane browser (search/type filters/
              grid-list/preview/save/jump-to-source). Sits with the other
              aggregate entries and renders with 1+ active accounts, in
              both layouts like Contacts above. */}
          {attachmentsAvailable &&
            (isCollapsed ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Attachments"
                      aria-current={attachmentsActive ? "true" : undefined}
                      className={cn(
                        buttonVariants({ variant: "ghost", size: "icon-lg" }),
                        "mx-auto",
                        attachmentsActive && "bg-muted text-foreground"
                      )}
                      onClick={enterAttachments}
                    >
                      <Paperclip />
                    </button>
                  }
                />
                <TooltipContent side="right">Attachments</TooltipContent>
              </Tooltip>
            ) : (
              <button
                type="button"
                aria-current={attachmentsActive ? "true" : undefined}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "w-full justify-start",
                  attachmentsActive && "bg-muted text-foreground"
                )}
                onClick={enterAttachments}
              >
                <Paperclip />
                Attachments
              </button>
            ))}
          {/* Calendar (task 5.3, design D5): the connected calendars'
              month/week/day view behind the ui-store "calendar" view — the
              settings-style full-pane browser (today/prev/next by unit,
              all-day row, per-calendar colors, cached offline ranges).
              Sits with the other aggregate entries and renders with 1+
              active accounts, in both layouts like Attachments above. */}
          {calendarAvailable &&
            (isCollapsed ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label="Calendar"
                      aria-current={calendarActive ? "true" : undefined}
                      className={cn(
                        buttonVariants({ variant: "ghost", size: "icon-lg" }),
                        "mx-auto",
                        calendarActive && "bg-muted text-foreground"
                      )}
                      onClick={enterCalendar}
                    >
                      <Calendar />
                    </button>
                  }
                />
                <TooltipContent side="right">Calendar</TooltipContent>
              </Tooltip>
            ) : (
              <button
                type="button"
                aria-current={calendarActive ? "true" : undefined}
                className={cn(
                  buttonVariants({ variant: "ghost", size: "sm" }),
                  "w-full justify-start",
                  calendarActive && "bg-muted text-foreground"
                )}
                onClick={enterCalendar}
              >
                <Calendar />
                Calendar
              </button>
            ))}
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
        {/* Scheduled sends (tasks 10.1/10.3): the sidebar entry opens the
            dialog listing pending sends (edit/cancel) plus sent/failed
            history — deliberately not a threads view, so it is a dialog
            like the label dialogs, not a ViewSelection. Always rendered
            expanded (discoverable before the first scheduled send); the
            badge counts pending rows. */}
        {!isCollapsed && <ScheduledSendsSection />}
        {/* Tasks (task 5.7, design D6): the task manager's sidebar home —
            open tasks across ALL accounts with due/overdue ordering, the
            one-action "Today & overdue" filter, completion and the
            completed disclosure. Deliberately coexists with the
            lightweight Todos section below it, and — unlike that
            ephemeral inventory — renders ALWAYS (with an empty state)
            while expanded, yielding to the icon rail like the other user
            sections. */}
        {!isCollapsed && <TasksSection />}
        {/* Todos (task 15.2): pending threads across ALL accounts, each
            row completing/reordering/removing in place — renders only
            while pending todos exist, like the Snoozed section. */}
        {!isCollapsed && <TodosSection />}
        {/* Snoozed (task 2.4): renders only while the account has snoozed
            threads — like the labels section it yields to the icon rail. */}
        {!isCollapsed && <SnoozedSection />}
        {/* Saved searches (task 7.1): stored query bookmarks created from
            the results view's "Save search" affordance; sits with the other
            user-created sections, just above Labels. */}
        {!isCollapsed && <SavedSearchesSection />}
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
          "flex items-center gap-0.5 px-2 py-1",
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
