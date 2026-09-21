import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react"
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
import { HelpCenterDialog } from "@/components/help/help-center"
import { SplitsTabBar } from "@/components/layout/splits-tab-bar"
import { CATEGORY_LABELS } from "@/components/layout/use-categories"
import { AddAccountDialog } from "@/components/accounts/add-account-dialog"
import { UndoSendBanner } from "@/components/composer/undo-send-banner"
import { ComposerTrayChip } from "@/components/composer/composer-tray-chip"
import { ContactsBrowser } from "@/components/contacts/contacts-browser"
import { AttachmentsBrowser } from "@/components/attachments/attachments-browser"
import { CalendarView } from "@/components/calendar/calendar-view"
import { WelcomePanel } from "@/components/email/welcome-panel"
import { accountHue } from "@/components/email/account-hue"
import { ReadingPane } from "@/components/email/reading-pane"
import { ThreadList } from "@/components/email/thread-list"
// Quick steps (task 3.2): the shell-level confirm-once dialog host plus
// the per-step digit shortcut listener — both global, like the palette.
import { QuickStepConfirmHost } from "@/components/email/quick-step-confirm-dialog"
import { useQuickStepShortcuts } from "@/hooks/use-quick-step-shortcuts"
import { applyDroppedLabels, labelDropDeps } from "@/components/email/label-dnd"
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
import {
  initialMailtoLinks,
  mailtoBodyToHtml,
  onMailtoLink,
  parseMailto,
} from "@/services/desktop/mailto"
import { onComposeRequest } from "@/services/desktop/tray"
import { installThreadSyncBridge } from "@/services/desktop/thread-sync-bridge"
import { applyBootPreferences } from "@/services/settings/preferences"
import { useUiStore, viewDisplayName } from "@/stores/ui-store"

interface MailShellProps {
  defaultLayout: [number, number, number]
  defaultCollapsed: boolean
}

// Code-split surfaces: the composer carries the TipTap/ProseMirror editor
// and the settings page its section tree (incl. the PGP panel). Both mount
// behind explicit UI state, so they load on first open instead of at
// startup.
const Composer = lazy(() =>
  import("@/components/composer/composer").then((m) => ({
    default: m.Composer,
  }))
)
const SettingsPage = lazy(() =>
  import("@/components/settings/settings-page").then((m) => ({
    default: m.SettingsPage,
  }))
)

/** Width of the collapsed icon rail; also the sidebar panel's floor. */
const SIDEBAR_RAIL_SIZE = "52px"
// Sidebar content flips to the icon rail below the first threshold and
// back to the full sidebar above the second; between them the previous
// state wins (a 1% deadband, so a drag resting at the boundary cannot
// oscillate the flag). Measured as a percentage of the group width.
const SIDEBAR_COLLAPSE_BELOW_PCT = 15
const SIDEBAR_EXPAND_ABOVE_PCT = 16

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
  // list's identity; the underlying folder title would be wrong. An active
  // category tab (task 3.5) retitles with the category's display name.
  const splitScope = listScope?.kind === "split" ? listScope : null
  const categoryScope = listScope?.kind === "category" ? listScope : null
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
                  : categoryScope
                    ? CATEGORY_LABELS[categoryScope.category]
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
 * collapses/expands the panel imperatively), and any separator drag that
 * squeezes the sidebar adopts the flag back by width threshold. That
 * includes the LIST divider: react-resizable-panels lets a drag push the
 * neighbouring panel through its minimum once the dragged panel is at its
 * own limit, so dragging the list divider left eventually "crosses" the
 * nav bar, collapsing the sidebar to the rail. The sidebar's floor equals
 * the rail width (SIDEBAR_RAIL_SIZE), so the drag can always physically
 * reach the collapse point instead of snapping back to an invisible
 * minimum (which depended on the gesture landing below the library's
 * collapse midpoint in one motion). Switching pane positions remounts the
 * panel group (keyed), so the effect deps include the position to
 * re-apply the collapse state.
 */
export function MailShell({
  defaultLayout = [20, 32, 48],
  defaultCollapsed = false,
}: Partial<MailShellProps>) {
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed)
  const setSidebarCollapsed = useUiStore((state) => state.setSidebarCollapsed)
  const readingPane = useUiStore((state) => state.readingPane)
  const composerOpen = useUiStore((state) => state.composerOpen)
  const settingsOpen = useUiStore((state) => state.view.kind === "settings")
  const contactsOpen = useUiStore((state) => state.view.kind === "contacts")
  const attachmentsOpen = useUiStore(
    (state) => state.view.kind === "attachments"
  )
  const calendarOpen = useUiStore((state) => state.view.kind === "calendar")
  // Full-pane pages (settings 11.1, Contacts browser 20.2, Attachments
  // browser 3.7, Calendar view 5.3) replace the mailbox panes; the sidebar
  // stays so the user can navigate elsewhere.
  const fullPageOpen =
    settingsOpen || contactsOpen || attachmentsOpen || calendarOpen
  // The composer's own visibility flag (it renders null while closed).
  const composerVisible = useComposerStore((state) => state.open)
  // Minimized (batch C2): the overlay stays MOUNTED but display-none, so
  // the TipTap instance, autosave and every transient state survive; the
  // tray chip below is the only visible composer surface.
  const composerMinimized = useComposerStore((state) => state.minimized)
  // Surface size (batch C2): full-surface overlay or the centered card.
  const composerMode = useUiStore((state) => state.composerMode)
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

  // Per-step quick-step digit shortcuts (task 3.2): one global keydown
  // listener mounted beside the shell, like the 6.6 shortcuts hook.
  useQuickStepShortcuts()

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

  // Tray menu (1.2): the tray's Compose item emits tray-compose from Rust
  // (which first surfaces the window); mirror the sidebar Compose click.
  // Degrades to a no-op unsubscribe outside the Tauri runtime.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let disposed = false
    void onComposeRequest(() => {
      useUiStore.getState().setComposerOpen(true)
    }).then((off) => {
      if (disposed) off()
      else unlisten = off
    })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // Mailto links (1.4): live links (warm start, all platforms) arrive via
  // the deep-link event; links that started this process (cold start) are
  // queried once at boot — the startup event fires before the webview
  // listens. Both paths converge on openMailtoDraft below. The parse is
  // pure (services/desktop/mailto.ts); this effect owns the composer
  // bridging, mirroring what the reply openers do with their setters.
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let disposed = false
    const openDraft = (url: string): void => {
      const draft = parseMailto(url)
      if (!draft) return
      const composer = useComposerStore.getState()
      composer.openNew(useAccountStore.getState().activeAccountId)
      if (draft.to.length > 0) composer.setTo(draft.to)
      if (draft.cc.length > 0) composer.setCc(draft.cc)
      if (draft.bcc.length > 0) composer.setBcc(draft.bcc)
      if (draft.subject !== null) composer.setSubject(draft.subject)
      if (draft.body !== null) composer.setHtml(mailtoBodyToHtml(draft.body))
      useUiStore.getState().setComposerOpen(true)
    }
    void onMailtoLink(openDraft).then((off) => {
      if (disposed) off()
      else unlisten = off
    })
    void initialMailtoLinks().then((urls) => {
      if (disposed) return
      for (const url of urls) openDraft(url)
    })
    return () => {
      disposed = true
      unlisten?.()
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

  // Cross-window convergence (1.9): remote thread changes (made in pop-out
  // windows) refresh the list, the badges and the open reading pane here.
  useEffect(() => installThreadSyncBridge(), [])

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

  const dragLayoutRef = useRef(false)
  // Last width the user had while expanded (≥ the expand threshold); the
  // toggle-expand path targets it because expand() itself restores the
  // pre-collapse size, which for a drag-caused collapse is whatever
  // mid-drag width happened to cross the threshold — restoring that would
  // drop the panel straight back into the collapse zone.
  const lastExpandedSizeRef = useRef<string | null>(null)

  // Store flag → panel size (the toggle path; a no-op when the drag path
  // already put the panel in the target state). Re-runs on pane-position
  // or full-pane view changes because the panel group remounts. Skipped
  // while a drag is flipping the flag (dragLayoutRef): the imperative
  // snap would be overwritten by the next pointer move anyway and only
  // makes the panel flicker; onSidebarLayoutChanged snaps once settled.
  useEffect(() => {
    if (dragLayoutRef.current) return
    const panel = panelRef.current
    if (!panel || panel.isCollapsed() === sidebarCollapsed) return
    if (sidebarCollapsed) {
      panel.collapse()
    } else {
      const target = lastExpandedSizeRef.current
      if (target) {
        panel.resize(target)
      } else {
        panel.expand()
      }
    }
  }, [panelRef, sidebarCollapsed, readingPane, fullPageOpen])

  // Layout-path sync (both directions): every layout update re-derives the
  // sidebar flag from the panel's rendered width, so the flip point is the
  // same whether the sidebar's own divider or the list divider is dragged,
  // and whether the gesture lands below the threshold in one motion or in
  // many small steps (the library recomputes each move from the gesture's
  // start, so per-step flag flips must not fire the imperative snap —
  // dragLayoutRef suppresses the toggle effect until the drag settles).
  // On settle, a panel parked between the rail and the thresholds snaps to
  // the state the thresholds picked (rail or expanded).
  const adoptSidebarLayout = useCallback(
    (settled: boolean) => {
      const panel = panelRef.current
      if (!panel) return
      const size = panel.getSize().asPercentage
      const current = useUiStore.getState().sidebarCollapsed
      const collapsed =
        size < SIDEBAR_COLLAPSE_BELOW_PCT
          ? true
          : size >= SIDEBAR_EXPAND_ABOVE_PCT
            ? false
            : current
      if (!collapsed && size >= SIDEBAR_EXPAND_ABOVE_PCT) {
        lastExpandedSizeRef.current = `${size}%`
      }
      if (collapsed !== current) {
        if (!settled) dragLayoutRef.current = true
        setSidebarCollapsed(collapsed)
      }
      if (settled && panel.isCollapsed() !== collapsed) {
        if (collapsed) {
          panel.collapse()
        } else {
          panel.expand()
        }
      }
    },
    [panelRef, setSidebarCollapsed]
  )
  const onSidebarLayoutChange = useCallback(
    () => adoptSidebarLayout(false),
    [adoptSidebarLayout]
  )
  const onSidebarLayoutChanged = useCallback(() => {
    dragLayoutRef.current = false
    adoptSidebarLayout(true)
  }, [adoptSidebarLayout])

  const sidebarPane = (
    <ResizablePanel
      panelRef={panelRef}
      id="sidebar"
      defaultSize={`${defaultLayout[0]}%`}
      collapsedSize={SIDEBAR_RAIL_SIZE}
      collapsible={true}
      minSize={SIDEBAR_RAIL_SIZE}
      maxSize="20%"
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
              onLayoutChange={onSidebarLayoutChange}
              onLayoutChanged={onSidebarLayoutChanged}
            >
              {sidebarPane}
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize="80%" minSize="40%">
                <Suspense fallback={null}>
                  <SettingsPage />
                </Suspense>
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
              onLayoutChange={onSidebarLayoutChange}
              onLayoutChanged={onSidebarLayoutChanged}
            >
              {sidebarPane}
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize="80%" minSize="40%">
                <ContactsBrowser />
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
          {/* Attachments browser (task 3.7, design D14): the current
            account's attachments replace the mailbox panes exactly like
            the settings/contacts pages above; the sidebar's Attachments
            entry navigates here. */}
          {attachmentsOpen && (
            <ResizablePanelGroup
              key="attachments"
              orientation="horizontal"
              className="min-h-0 flex-1 items-stretch"
              onLayoutChange={onSidebarLayoutChange}
              onLayoutChanged={onSidebarLayoutChanged}
            >
              {sidebarPane}
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize="80%" minSize="40%">
                <AttachmentsBrowser />
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
          {/* Calendar view (task 5.3, design D5): the connected calendars'
            month/week/day grid replaces the mailbox panes exactly like the
            settings/contacts/attachments pages above; the sidebar's
            Calendar entry navigates here. */}
          {calendarOpen && (
            <ResizablePanelGroup
              key="calendar"
              orientation="horizontal"
              className="min-h-0 flex-1 items-stretch"
              onLayoutChange={onSidebarLayoutChange}
              onLayoutChanged={onSidebarLayoutChanged}
            >
              {sidebarPane}
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize="80%" minSize="40%">
                <CalendarView />
              </ResizablePanel>
            </ResizablePanelGroup>
          )}
          {!fullPageOpen && readingPane === "right" && (
            <ResizablePanelGroup
              key="right"
              orientation="horizontal"
              className="min-h-0 flex-1 items-stretch"
              onLayoutChange={onSidebarLayoutChange}
              onLayoutChanged={onSidebarLayoutChanged}
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
              onLayoutChange={onSidebarLayoutChange}
              onLayoutChanged={onSidebarLayoutChanged}
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
              onLayoutChange={onSidebarLayoutChange}
              onLayoutChanged={onSidebarLayoutChanged}
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
        {/* Quick-step confirm-once dialog (task 3.2): one global host the
          context menu / palette / digit shortcuts raise requests against
          (see run-with-confirm.ts). Renders nothing until a destructive
          first run needs the gate. */}
        <QuickStepConfirmHost />
        {/* Help center dialog (task 2.9): one global instance, driven by
          ui-store.helpCenterOpen (the command palette's "Open help center"
          entry is the app's help-menu hook — there is no OS menu bar).
          The Settings → Help section mounts the same center inline. */}
        <HelpCenterDialog />
        {/* Composer (8.1/8.2; batch C2 size modes + minimize): Gated on the
          composer store (renders null when closed); ui-store.composerOpen
          is bridged into openNew above. CENTERED (the default) is
          deliberately NON-modal: the wrapper is pointer-events-none and
          carries no backdrop dim, so the mailbox behind stays visible and
          clickable while the card floats above it (the keyboard layer
          routes keys by focus — see use-keyboard-shortcuts gate 3.25).
          FULL keeps the original shell-filling modal surface. Minimized
          keeps the view mounted behind display:none — only the tray chip
          shows. */}
        {composerVisible && (
          <div
            data-testid="composer-overlay"
            data-composer-mode={composerMode}
            className={cn(
              "fixed inset-0 z-40",
              composerMinimized && "hidden",
              // The flex classes must drop out while minimized: `flex` and
              // `hidden` are both display utilities, and whichever comes
              // later in the generated stylesheet wins — with both applied
              // the card visibly stayed on screen next to the tray chip.
              composerMode === "centered" &&
                !composerMinimized &&
                "pointer-events-none flex items-center justify-center p-4"
            )}
          >
            {composerMode === "centered" ? (
              <CenteredComposerCard>
                <Suspense fallback={null}>
                  <Composer />
                </Suspense>
              </CenteredComposerCard>
            ) : (
              <div className="h-full w-full bg-background">
                <Suspense fallback={null}>
                  <Composer />
                </Suspense>
              </div>
            )}
          </div>
        )}
        {/* Minimized-composer tray chip (batch C2): docked bottom-right,
            the only visible composer surface while minimized. */}
        <ComposerTrayChip />
        {/* Toast host: theme-aware, bottom-right per the notifications UX. */}
        <Toaster position="bottom-right" />
      </TooltipProvider>
    </DndContext>
  )
}

/**
 * The centered composer's draggable, resizable card: the floating card can
 * be moved by its header strip (the row carrying data-composer-drag-handle
 * inside the composer surface — buttons and fields inside it are excluded)
 * and resized from its right/bottom edges and the bottom-right corner, so
 * the user can park it beside the thread they are reading while the
 * mailbox behind stays interactive. Pointer capture keeps both gestures
 * alive over the click-through overlay; the offset clamps to the viewport
 * so the card can never be dropped off-screen; resizing anchors the
 * top-left corner (compensating the flex centering through the same
 * translate offset the drag uses); double-click on the header snaps it
 * back to center. State is deliberately component-local — the card
 * unmounts with the overlay when the composer closes, which is the reset,
 * while a minimize (the overlay stays mounted behind display: none) keeps
 * the parked position and size.
 */
type ResizeDirection = "right" | "bottom" | "corner"

const COMPOSER_MIN_WIDTH = 420
const COMPOSER_MIN_HEIGHT = 340

function CenteredComposerCard({ children }: { children: ReactNode }) {
  const [offset, setOffset] = useState<{ x: number; y: number } | null>(null)
  const [size, setSize] = useState<{ width: number; height: number } | null>(
    null
  )
  const cardRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    baseX: number
    baseY: number
    left: number
    top: number
    width: number
    height: number
  } | null>(null)
  const resizeRef = useRef<{
    direction: ResizeDirection
    pointerId: number
    startX: number
    startY: number
    baseWidth: number
    baseHeight: number
    left: number
    top: number
    baseOffsetX: number
    baseOffsetY: number
  } | null>(null)

  const isHandleTarget = (target: EventTarget | null): boolean =>
    target instanceof Element &&
    target.closest('[data-composer-drag-handle]') !== null &&
    // Buttons inside the header row keep their click; dragging starts on
    // the title strip and the empty space around it only.
    target.closest("button, a, input, select, textarea, [role='button']") ===
      null

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    if (!isHandleTarget(event.target)) return
    const card = cardRef.current
    if (!card) return
    const rect = card.getBoundingClientRect()
    const current = offset ?? { x: 0, y: 0 }
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseX: current.x,
      baseY: current.y,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (drag) {
      if (drag.pointerId !== event.pointerId) return
      // Clamp to the viewport (16px gutter): the dragged card stays fully
      // reachable — a card wider/taller than the window degrades to the
      // gutter edge on that axis.
      const gutter = 16
      const vw = window.innerWidth
      const vh = window.innerHeight
      const nx = Math.min(
        Math.max(
          drag.baseX + (event.clientX - drag.startX),
          drag.baseX + gutter - drag.left
        ),
        drag.baseX + vw - gutter - drag.left - drag.width
      )
      const ny = Math.min(
        Math.max(
          drag.baseY + (event.clientY - drag.startY),
          drag.baseY + gutter - drag.top
        ),
        drag.baseY + vh - gutter - drag.top - drag.height
      )
      setOffset({ x: nx, y: ny })
      return
    }
    const resize = resizeRef.current
    if (!resize || resize.pointerId !== event.pointerId) return
    const gutter = 16
    const vw = window.innerWidth
    const vh = window.innerHeight
    // Width/height follow the pointer, clamped to a usable minimum and to
    // the viewport from where the top-left corner sits (the resize anchors
    // that corner, so the bottom-right edge is the viewport limit).
    const maxWidth = Math.max(
      COMPOSER_MIN_WIDTH,
      vw - gutter - resize.left
    )
    const maxHeight = Math.max(
      COMPOSER_MIN_HEIGHT,
      vh - gutter - resize.top
    )
    const growX = resize.direction === "bottom" ? 0 : event.clientX - resize.startX
    const growY = resize.direction === "right" ? 0 : event.clientY - resize.startY
    const width = Math.min(
      Math.max(resize.baseWidth + growX, COMPOSER_MIN_WIDTH),
      maxWidth
    )
    const height = Math.min(
      Math.max(resize.baseHeight + growY, COMPOSER_MIN_HEIGHT),
      maxHeight
    )
    setSize({ width, height })
    // The card is flex-centered, so growing it would otherwise grow both
    // edges; shift the translate offset by half the delta to anchor the
    // top-left corner where the user grabbed the edge.
    setOffset({
      x: resize.baseOffsetX + (width - resize.baseWidth) / 2,
      y: resize.baseOffsetY + (height - resize.baseHeight) / 2,
    })
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null
    if (resizeRef.current?.pointerId === event.pointerId) resizeRef.current = null
  }

  function onResizePointerDown(
    event: ReactPointerEvent<HTMLDivElement>
  ): void {
    if (event.button !== 0) return
    const direction = event.currentTarget.dataset.resizeDirection
    if (direction !== "right" && direction !== "bottom" && direction !== "corner")
      return
    const card = cardRef.current
    if (!card) return
    const rect = card.getBoundingClientRect()
    const current = offset ?? { x: 0, y: 0 }
    resizeRef.current = {
      direction,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      baseWidth: rect.width,
      baseHeight: rect.height,
      left: rect.left,
      top: rect.top,
      baseOffsetX: current.x,
      baseOffsetY: current.y,
    }
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  return (
    <div
      ref={cardRef}
      data-testid="composer-card"
      className={
        size
          ? "pointer-events-auto relative flex flex-col overflow-hidden rounded-xl border bg-background shadow-2xl"
          : "pointer-events-auto relative flex h-[85vh] max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border bg-background shadow-2xl"
      }
      style={{
        ...(size ? { width: size.width, height: size.height } : {}),
        ...(offset ? { transform: `translate(${offset.x}px, ${offset.y}px)` } : {}),
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(event) => {
        if (isHandleTarget(event.target)) setOffset(null)
      }}
    >
      {children}
      {/* Resize affordances (pointer-only, aria-hidden): right edge, bottom
          edge and the bottom-right corner. The edge handles stop short of
          the rounded corners so the window border stays clean. */}
      <div
        aria-hidden="true"
        data-testid="composer-resize-right"
        data-resize-direction="right"
        onPointerDown={onResizePointerDown}
        className="absolute bottom-5 right-0 top-10 w-1.5 cursor-ew-resize touch-none"
      />
      <div
        aria-hidden="true"
        data-testid="composer-resize-bottom"
        data-resize-direction="bottom"
        onPointerDown={onResizePointerDown}
        className="absolute bottom-0 left-10 right-5 h-1.5 cursor-ns-resize touch-none"
      />
      <div
        aria-hidden="true"
        data-testid="composer-resize-corner"
        data-resize-direction="corner"
        onPointerDown={onResizePointerDown}
        className="absolute bottom-0 right-0 size-5 cursor-nwse-resize touch-none"
      />
    </div>
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
