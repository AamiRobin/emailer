import { useCallback, useEffect, useMemo, useState } from "react"
import { DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core"
import type { DragEndEvent } from "@dnd-kit/core"
import { formatDistanceToNow } from "date-fns"
import { usePanelRef } from "react-resizable-panels"

import { cn } from "@/lib/utils"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { Separator } from "@/components/ui/separator"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AccountSwitcher } from "@/components/layout/account-switcher"
import { Sidebar } from "@/components/layout/sidebar"
import { StatusBar } from "@/components/layout/status-bar"
import { OfflineBanner } from "@/components/layout/offline-banner"
import { SearchField } from "@/components/search/search-field"
import { CommandPalette } from "@/components/search/command-palette"
import { SplitsTabBar } from "@/components/layout/splits-tab-bar"
import { AddAccountDialog } from "@/components/accounts/add-account-dialog"
import { Composer } from "@/components/composer/composer"
import { UndoSendBanner } from "@/components/composer/undo-send-banner"
import { ContactsBrowser } from "@/components/contacts/contacts-browser"
import { WelcomePanel } from "@/components/email/welcome-panel"
import { accountHue } from "@/components/email/account-hue"
import { ReadingPane } from "@/components/email/reading-pane"
import { ThreadList } from "@/components/email/thread-list"
import { applyDroppedLabels, labelDropDeps } from "@/components/email/label-dnd"
import { SettingsPage } from "@/components/settings/settings-page"
import { Toaster } from "@/components/ui/sonner"
import { initAccountStore, useAccountStore } from "@/stores/account-store"
import type { AccountInfo } from "@/stores/account-store"
import { useComposerStore } from "@/stores/composer-store"
import { useSyncStore } from "@/stores/sync-store"
import type { AccountSyncState } from "@/stores/sync-store"
import { useThreadListStore } from "@/stores/thread-list-store"
import { initOnlineTracking, onOnlineChange } from "@/services/online"
import { useOnlineStore } from "@/stores/online-store"
import { getExecutor } from "@/services/db/executor"
import { applyBootPreferences } from "@/services/settings/preferences"
import { useUiStore, viewDisplayName } from "@/stores/ui-store"

interface MailShellProps {
  defaultLayout: [number, number, number]
  defaultCollapsed: boolean
  navCollapsedSize: number
}

/**
 * Center pane: the active view's header — title and the All/Unread filter
 * toggle over a full-width search row (9.2) — above the thread list
 * (6.4), matching the tweakcn mail reference. While a list-scope override
 * is active the title names the scope instead ("Unified Inbox", task 9.2)
 * and the header carries one hue dot per active account whose tooltip is
 * that account's sync state (the sync-store perAccount slice — no new
 * sync UI, the status bar's SyncIndicator stays the full indicator). The
 * reading-pane position is a settings preference (Settings → Reading); in
 * the "hidden" position an open thread replaces the list with the
 * full-width reading view and a back control (6.5). With no account
 * connected the list area becomes the first-run welcome panel (6.9).
 */
function MailboxPane({ onAddAccount }: { onAddAccount: () => void }) {
  const view = useUiStore((state) => state.view)
  const listScope = useUiStore((state) => state.listScope)
  const readingPane = useUiStore((state) => state.readingPane)
  const activeThread = useUiStore((state) => state.activeThread)
  const setActiveThread = useUiStore((state) => state.setActiveThread)
  const accounts = useAccountStore((state) => state.accounts)
  // First-run (6.9): only after the account load has settled, so a normal
  // startup with accounts never flashes the welcome panel.
  const accountsEmpty = useAccountStore(
    (state) => state.loaded && state.accounts.length === 0
  )
  const unified = listScope?.kind === "unified"
  // Priority inbox (task 13.2, D7) and Nudges (task 14.1, D8): the same
  // retitling pattern as unified — the underlying view selection stays
  // untouched while the scope is on.
  const priority = listScope?.kind === "priority"
  const nudges = listScope?.kind === "nudges"
  // An active split tab (task 9.3) retitles too — its stored name is the
  // list's identity; the underlying folder title would be wrong.
  const splitScope = listScope?.kind === "split" ? listScope : null
  // The dots stand for the ACTIVE accounts — exactly the set the unified
  // scope aggregates (listActiveAccounts).
  const activeAccounts = useMemo(
    () => accounts.filter((account) => account.status === "active"),
    [accounts]
  )

  const readingViewOpen = readingPane === "hidden" && activeThread !== null

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Pane header, matching the tweakcn mail reference: title + filter
          toggle on one row, the search field on its own full-width row.
          The unified scope (9.2) retitles the pane and adds the compact
          per-account sync dots between title and toggle. */}
      <div className="flex items-center justify-between gap-2 px-4 py-1.5">
        <h1 className="truncate text-xl font-bold text-foreground">
          {unified
            ? "Unified Inbox"
            : priority
              ? "Priority inbox"
              : nudges
                ? "Nudges"
                : splitScope
                  ? splitScope.name
                  : viewDisplayName(view)}
        </h1>
        <div className="flex items-center gap-2">
          {unified && activeAccounts.length > 1 && (
            <UnifiedAccountSync accounts={activeAccounts} />
          )}
          <UnreadFilterToggle />
        </div>
      </div>
      <Separator />
      <div className="px-2 py-2">
        <SearchField className="w-full" />
      </div>
      {/* Splits tab bar (task 9.3): one tab per visible split — click to
          enter its query-backed list scope, click the active tab again to
          leave. The "+" at the end creates and manages splits. */}
      <SplitsTabBar />
      <div className="min-h-0 flex-1">
        {accountsEmpty ? (
          <WelcomePanel onAddAccount={onAddAccount} />
        ) : readingViewOpen ? (
          <ReadingPane onBack={() => setActiveThread(null)} />
        ) : (
          <ThreadList />
        )}
      </div>
    </div>
  )
}

/**
 * Mailbox shell. The left pane is the real sidebar (account switcher +
 * compose/folders/labels/settings, task 6.3); the rest is laid out by the
 * reading-pane position (task 6.5, mailbox-ui spec):
 * - right:  sidebar | list | display (classic three-pane)
 * - bottom: sidebar | list-over-display (vertical split)
 * - hidden: sidebar | list; selecting a thread swaps the list for the
 *   full-width reading view with a back control
 * - settings view (11.1): sidebar | settings page — the settings page
 *   replaces the mailbox panes until the user navigates back
 * - contacts view (20.2): sidebar | Contacts browser — the same pane
 *   replacement as settings, entered from the sidebar's Contacts entry
 *
 * Sidebar collapse is a two-way sync between uiStore.sidebarCollapsed and
 * the ResizablePanel: the sidebar's toggle flips the store flag (an effect
 * collapses/expands the panel imperatively), and dragging the divider
 * below the collapsed size writes the flag back via onResize. Switching
 * pane positions remounts the panel group (keyed), so the effect deps
 * include the position to re-apply the collapse state.
 */
export function MailShell({
  defaultLayout = [20, 32, 48],
  defaultCollapsed = false,
  navCollapsedSize = 4,
}: Partial<MailShellProps>) {
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed)
  const setSidebarCollapsed = useUiStore((state) => state.setSidebarCollapsed)
  const readingPane = useUiStore((state) => state.readingPane)
  const composerOpen = useUiStore((state) => state.composerOpen)
  const settingsOpen = useUiStore((state) => state.view.kind === "settings")
  const contactsOpen = useUiStore((state) => state.view.kind === "contacts")
  // Full-pane pages (settings 11.1, Contacts browser 20.2) replace the
  // mailbox panes; the sidebar stays so the user can navigate elsewhere.
  const fullPageOpen = settingsOpen || contactsOpen
  // The composer's own visibility flag (it renders null while closed).
  const composerVisible = useComposerStore((state) => state.open)
  const [addAccountOpen, setAddAccountOpen] = useState(false)
  const panelRef = usePanelRef()

  // Drag-and-drop labeling (task 10.5): one DndContext spans the sidebar
  // (label-row drop targets) and the list (thread-row drag sources) across
  // every reading-pane layout. The PointerSensor's distance constraint is
  // what keeps plain clicks, shift-clicks and context menus working — a
  // drag only starts once the pointer moves 8px on a pressed row.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  )
  const handleDragEnd = (event: DragEndEvent) => {
    void applyDroppedLabels(event, labelDropDeps())
  }

  const openAddAccount = () => setAddAccountOpen(true)

  // Load accounts, unread counts and the last active account once; the
  // switcher renders the "No accounts" empty state until this resolves.
  // Failures (e.g. no DB outside Tauri) are logged, not fatal.
  useEffect(() => {
    useUiStore.getState().setSidebarCollapsed(defaultCollapsed)
    void initAccountStore()
  }, [defaultCollapsed])

  // User preferences (11.2/11.3): apply the persisted density/font-scale
  // tokens, the accent mirror and the saved reading-pane position once at
  // boot. Runs after bootstrap() (App gates the shell on it), so the
  // executor is available; failures keep the defaults.
  useEffect(() => {
    try {
      void applyBootPreferences(getExecutor())
    } catch (error) {
      console.warn("[mail-shell] preference boot-apply skipped", error)
    }
  }, [])

  // Connectivity (6.8): mirror window online/offline events into the
  // online store (drives the offline banner). initOnlineTracking seeds
  // the store and attaches the listeners; the subscription re-pushes
  // transitions so the banner tracks connectivity wherever tracking was
  // initialized first.
  useEffect(() => {
    initOnlineTracking()
    return onOnlineChange((online) => {
      useOnlineStore.getState().setOnline(online)
    })
  }, [])

  // Composer mounting contract (composer-store docstring, 8.1): the shell
  // flag ui-store.composerOpen is what the sidebar/palette set; the
  // composer view itself gates on composer-store.open. Opening bridges
  // into openNew (composed from the active account); a composer-initiated
  // close (Discard) syncs the shell flag back so the next Compose click
  // re-fires the bridge.
  useEffect(() => {
    if (!composerOpen) return
    if (!useComposerStore.getState().open) {
      useComposerStore
        .getState()
        .openNew(useAccountStore.getState().activeAccountId)
    }
  }, [composerOpen])

  useEffect(
    () =>
      useComposerStore.subscribe((state) => {
        if (!state.open && useUiStore.getState().composerOpen) {
          useUiStore.getState().setComposerOpen(false)
        }
      }),
    []
  )

  // Store flag → panel size (the toggle path; a no-op when the drag path
  // already put the panel in the target state). Re-runs on pane-position
  // or full-pane view changes because the panel group remounts.
  useEffect(() => {
    const panel = panelRef.current
    if (!panel || panel.isCollapsed() === sidebarCollapsed) return
    if (sidebarCollapsed) {
      panel.collapse()
    } else {
      panel.expand()
    }
  }, [panelRef, sidebarCollapsed, readingPane, fullPageOpen])

  // Drag-path sync: after a group's layout SETTLES (drag release included —
  // onLayoutChanged deliberately waits for pointer-up), adopt the panel's
  // authoritative collapsed state. Deriving the flag from onResize
  // percentages instead races the imperative toggle path: intermediate
  // sizes write stale values and bounce a collapse() straight back.
  const syncSidebarFromPanel = useCallback(() => {
    const panel = panelRef.current
    if (!panel) return
    const collapsed = panel.isCollapsed()
    if (useUiStore.getState().sidebarCollapsed !== collapsed) {
      setSidebarCollapsed(collapsed)
    }
  }, [panelRef, setSidebarCollapsed])

  const sidebarPane = (
    <ResizablePanel
      panelRef={panelRef}
      defaultSize={`${defaultLayout[0]}%`}
      collapsedSize={`${navCollapsedSize}%`}
      collapsible={true}
      minSize="15%"
      maxSize="20%"
      className={cn(
        sidebarCollapsed &&
          "min-w-[50px] transition-all duration-300 ease-in-out"
      )}
    >
      {/* Height-constrained column: without it the sidebar's h-full adds to
          the switcher + separator heights and pushes the settings footer
          below the fold on short windows. */}
      <div className="flex h-full min-h-0 flex-col">
        <div
          className={cn(
            "flex items-center justify-center px-2 py-1.5",
            sidebarCollapsed && "px-0"
          )}
        >
          <AccountSwitcher
            isCollapsed={sidebarCollapsed}
            onAddAccount={openAddAccount}
          />
        </div>
        <Separator />
        <Sidebar isCollapsed={sidebarCollapsed} />
      </div>
    </ResizablePanel>
  )

  return (
    <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
      <TooltipProvider delay={0}>
        {/* Offline indicator (6.8): fixed top overlay, non-blocking. */}
        <OfflineBanner />
        {/* Undo-send window (5.2, design D3): fixed bottom overlay, the
            pre-send counterpart. Lives at shell level because the window
            (and its banner) survives navigation while the composer pane
            is closed. */}
        <UndoSendBanner />
        {/* Every layout shares one column: the active panel group fills
            the shell above the bottom status bar (sync state + version).
            flex-1: the root is a row flex container, so an unsized child
            would shrink to content width. */}
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Settings view (11.1): the settings page replaces the mailbox
            panes; the sidebar stays so the user can navigate elsewhere. */}
          {settingsOpen && (
            <ResizablePanelGroup
              key="settings"
              orientation="horizontal"
              className="min-h-0 flex-1 items-stretch"
              onLayoutChanged={syncSidebarFromPanel}
            >
              {sidebarPane}
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize="80%" minSize="40%">
                <SettingsPage />
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
          {/* Contacts browser (task 20.2): the address book replaces the
            mailbox panes exactly like the settings page above; the
            sidebar's Contacts entry navigates here. */}
          {contactsOpen && (
            <ResizablePanelGroup
              key="contacts"
              orientation="horizontal"
              className="min-h-0 flex-1 items-stretch"
              onLayoutChanged={syncSidebarFromPanel}
            >
              {sidebarPane}
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize="80%" minSize="40%">
                <ContactsBrowser />
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
          {!fullPageOpen && readingPane === "right" && (
            <ResizablePanelGroup
              key="right"
              orientation="horizontal"
              className="min-h-0 flex-1 items-stretch"
              onLayoutChanged={syncSidebarFromPanel}
            >
              {sidebarPane}
              <ResizableHandle withHandle />
              <ResizablePanel
                defaultSize={`${defaultLayout[1]}%`}
                minSize="30%"
              >
                <MailboxPane onAddAccount={openAddAccount} />
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel
                defaultSize={`${defaultLayout[2]}%`}
                minSize="30%"
              >
                <ReadingPane />
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
          {!fullPageOpen && readingPane === "bottom" && (
            <ResizablePanelGroup
              key="bottom"
              orientation="horizontal"
              className="min-h-0 flex-1 items-stretch"
              onLayoutChanged={syncSidebarFromPanel}
            >
              {sidebarPane}
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize="80%" minSize="40%">
                <ResizablePanelGroup orientation="vertical" className="h-full">
                  <ResizablePanel defaultSize="55%" minSize="25%">
                    <MailboxPane onAddAccount={openAddAccount} />
                  </ResizablePanel>
                  <ResizableHandle withHandle />
                  <ResizablePanel minSize="25%">
                    <ReadingPane />
                  </ResizablePanel>
                </ResizablePanelGroup>
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
          {!fullPageOpen && readingPane === "hidden" && (
            <ResizablePanelGroup
              key="hidden"
              orientation="horizontal"
              className="min-h-0 flex-1 items-stretch"
              onLayoutChanged={syncSidebarFromPanel}
            >
              {sidebarPane}
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize="80%" minSize="40%">
                <MailboxPane onAddAccount={openAddAccount} />
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
          <StatusBar />
        </div>
        {/* Add-account flows (5.3/5.4); hosted here so it overlays the shell.
          The welcome panel (6.9) opens this same chooser. */}
        <AddAccountDialog
          open={addAccountOpen}
          onOpenChange={setAddAccountOpen}
        />
        {/* Command palette (6.7): one global instance; visibility lives in
          the palette store. The global Cmd/Ctrl+K binding is wired by the
          shortcuts task (6.6) — mounting here is the whole contract. */}
        <CommandPalette />
        {/* Composer (8.1/8.2): full-surface overlay while open. Gated on the
          composer store (renders null when closed); ui-store.composerOpen
          is bridged into openNew above. */}
        {composerVisible && (
          <div
            data-testid="composer-overlay"
            className="fixed inset-0 z-40 bg-background"
          >
            <Composer />
          </div>
        )}
        {/* Toast host: theme-aware, bottom-right per the notifications UX. */}
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </DndContext>
  )
}

/**
 * Per-account sync dots for the unified-inbox header (task 9.2, mail-
 * organization spec "reflect per-account sync state"): one hue dot per
 * active account — the same hue its rows' badges use (account-badge's
 * accountHue) — with a title tooltip carrying the address and the sync
 * store's perAccount state. Deliberately tooltip-only, no new sync UI:
 * the full indicator (SyncIndicator) already lives in the status bar.
 */
function syncStateLabel(state?: AccountSyncState): string {
  if (!state) return "Not synced yet"
  if (state.status === "syncing") return "Syncing…"
  if (state.status === "error") return state.error ?? "Last sync failed"
  return state.lastSyncAt
    ? `Synced ${formatDistanceToNow(new Date(state.lastSyncAt * 1000), {
        addSuffix: true,
      })}`
    : "Not synced yet"
}

function UnifiedAccountSync({ accounts }: { accounts: AccountInfo[] }) {
  const perAccount = useSyncStore((state) => state.perAccount)
  return (
    <div className="flex items-center gap-1.5" aria-label="Account sync status">
      {accounts.map((account) => {
        const state = perAccount[account.id]
        return (
          <span
            key={account.id}
            role="img"
            data-account-sync={account.id}
            aria-label={`${account.email}: ${syncStateLabel(state)}`}
            title={`${account.email} — ${syncStateLabel(state)}`}
            className="size-2 rounded-full"
            style={{
              backgroundColor: `hsl(${accountHue(account.id)} 55% 50%)`,
            }}
          />
        )
      })}
    </div>
  )
}

/**
 * "All mail | Unread" segmented filter (the tweakcn mail reference's
 * header toggle). The state lives in thread-list-store while this control
 * renders in the pane header; ThreadList applies the filter to the loaded
 * rows.
 */
function UnreadFilterToggle() {
  const unreadOnly = useThreadListStore((state) => state.unreadOnly)
  const setUnreadOnly = useThreadListStore((state) => state.setUnreadOnly)
  return (
    <div
      role="group"
      aria-label="Filter threads"
      className="flex items-center rounded-lg border bg-muted/40 p-0.5 text-xs"
    >
      <button
        type="button"
        aria-pressed={!unreadOnly}
        className={cn(
          "rounded-md px-2.5 py-1 font-medium transition-colors",
          !unreadOnly
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        )}
        onClick={() => setUnreadOnly(false)}
      >
        All mail
      </button>
      <button
        type="button"
        aria-pressed={unreadOnly}
        className={cn(
          "rounded-md px-2.5 py-1 font-medium transition-colors",
          unreadOnly
            ? "bg-background text-foreground shadow-sm"
            : "text-muted-foreground hover:text-foreground"
        )}
        onClick={() => setUnreadOnly(true)}
      >
        Unread
      </button>
    </div>
  )
}
