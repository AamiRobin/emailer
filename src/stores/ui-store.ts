import { create } from "zustand"

import type { SpecialUse } from "@/services/db/labels"
import type { Category } from "@/services/categorization/classify"

/**
 * View-state store (design D5): pure in-memory UI state for the mailbox
 * shell — which folder/label/search the center pane shows, whether the
 * sidebar is collapsed, whether the composer is open, which thread the
 * reading pane displays, and where the reading pane sits (6.5). Nothing
 * persists here: the reading-pane position is persisted through the
 * settings table by the preferences service (src/services/settings/
 * preferences.ts, task 11.3), which feeds it back at boot via
 * setReadingPane. Everything else rebuilds from SQLite on launch (default
 * view: inbox), keeping the database the single source of truth.
 *
 * Consumed by the sidebar (6.3), the thread list (6.4) and the reading
 * pane (6.5); composerOpen is consumed by the composer task (8.1) and the
 * settings view by the settings page task (11.1).
 *
 * Mapping from ViewSelection to thread-list queries (task 6.4) — every
 * view resolves through src/services/db/threads.ts listThreadsByFolder:
 * - {kind:"folder", folder:{kind:"specialUse", specialUse}}
 *     → folder: {kind:"specialUse", specialUse}  (membership via the
 *       account's label(s) carrying that RFC 6154 role, both account
 *       models)
 * - {kind:"folder", folder:{kind:"starred"}}
 *     → folder: {kind:"preset", preset:"starred"}  (is_starred is a
 *       per-thread flag, not a folder; excludes trash and spam)
 * - {kind:"folder", folder:{kind:"labelId", labelId}}
 *     → folder: {kind:"labelId", labelId}
 * - {kind:"label", labelId, name}
 *     → same query as labelId above — the variant exists so the UI keeps
 *       the label's display name (and "/"-hierarchy context) alongside
 *       the selection without a re-lookup
 * - {kind:"search", query}
 *     → searchThreads (src/services/db/search), not listThreadsByFolder
 * - {kind:"contacts"}
 *     → no thread list; the Contacts browser (task 20.2) replaces the
 *       mailbox panes exactly like the settings view
 * - {kind:"attachments"}
 *     → no thread list; the Attachments browser (task 3.7, design D14)
 *       replaces the mailbox panes exactly like the settings view
 * - {kind:"calendar"}
 *     → no thread list; the Calendar view (task 5.3, design D5) replaces
 *       the mailbox panes exactly like the settings view
 * - {kind:"settings"}
 *     → no thread list; the settings page (11.1) replaces the mailbox panes
 */

/**
 * A mailbox folder selection. "specialUse" covers both system folders
 * (inbox/sent/drafts resolved through role labels) and provider folders
 * with those roles; "starred" is the threads.is_starred flag (deliberately
 * not a folder row); "labelId" selects a single user label.
 */
export type FolderSelection =
  | { kind: "specialUse"; specialUse: SpecialUse }
  | { kind: "starred" }
  | { kind: "labelId"; labelId: string }

/**
 * What the mailbox center pane is currently showing. The active view also
 * drives the sidebar's highlight (6.3) and the pane header title.
 */
export type ViewSelection =
  | { kind: "folder"; folder: FolderSelection }
  | { kind: "label"; labelId: string; name: string }
  | { kind: "search"; query: string }
  | { kind: "contacts" }
  | { kind: "attachments" }
  | { kind: "calendar" }
  | { kind: "settings" }

/**
 * Query-backed list scopes the mailbox can enter WITHOUT a ViewSelection
 * kind (design D4, task 9.1). The ViewSelection union stays closed —
 * components switch over its kinds — so the unified inbox (task 9.2),
 * split tabs and saved-search listings (task 9.3) live BESIDE the view:
 * a non-null `listScope` means the thread list shows that scope instead
 * of the folder/label/search selection, and any setView() clears it
 * again. `split` carries an optional account pin (one account) — omit it
 * for the across-accounts variant; `saved-search` is always global.
 * `category` (task 3.5, design D4) is the inbox category tab row's scope:
 * one of the five categories, across the active accounts — the tab-bar
 * sibling of the split kind (categories ordered first in the row).
 * `priority` (task 13.2, design D7) is the priority inbox: the active
 * accounts' inbox threads whose newest sender classifies important — not
 * an operator query (the classification is a scored heuristic, not
 * expressible as a search string), hence its own variant beside
 * unified/split/saved-search. `nudges` (task 14.1, design D8) is the same
 * kind of variant: the awaiting-reply threads the detection query in
 * db/nudges.ts finds — again not expressible as a search string. Task
 * 9.2/9.3/13.2/14.1/3.5 hang their UI on setListScope(); the thread-list
 * store resolves the override into its scope descriptors
 * (ThreadListScope).
 */
export type ListScopeOverride =
  | { kind: "unified" }
  | { kind: "priority" }
  | { kind: "nudges" }
  | { kind: "split"; name: string; query: string; accountId?: string }
  | { kind: "saved-search"; name: string; query: string }
  | { kind: "category"; category: Category }

/** Default view on launch: the account's inbox (also the test reset base). */
export const DEFAULT_VIEW: ViewSelection = {
  kind: "folder",
  folder: { kind: "specialUse", specialUse: "inbox" },
}

/** Display titles for special-use roles (token-free constants, not data). */
const SPECIAL_USE_DISPLAY: Record<SpecialUse, string> = {
  inbox: "Inbox",
  sent: "Sent",
  drafts: "Drafts",
  archive: "Archive",
  spam: "Spam",
  trash: "Trash",
  all: "All mail",
  flagged: "Flagged",
}

/**
 * Human title for a view, used by the mailbox pane header. Label views
 * carry their own name; a bare folder.labelId has no name in the shape
 * (construct {kind:"label"} when the name is known) so it falls back to
 * the label id.
 */
export function viewDisplayName(view: ViewSelection): string {
  switch (view.kind) {
    case "folder":
      if (view.folder.kind === "starred") return "Starred"
      if (view.folder.kind === "specialUse") {
        return SPECIAL_USE_DISPLAY[view.folder.specialUse]
      }
      return view.folder.labelId
    case "label":
      return view.name
    case "search":
      return `Search: ${view.query}`
    case "contacts":
      return "Contacts"
    case "attachments":
      return "Attachments"
    case "calendar":
      return "Calendar"
    case "settings":
      return "Settings"
  }
}

/**
 * Composer surface size (batch C2): "centered" (the default) renders the
 * composer as a large rounded card floating over the mailbox — non-modal:
 * the mail behind stays visible and clickable (the shell's overlay lets
 * pointer events through everywhere but the card). "full" is the
 * shell-filling overlay the composer originally had, kept as the expand
 * option. Persisted by the preferences service (`mail.composerMode`);
 * the in-code default here is only the fresh-install value.
 */
export type ComposerSizeMode = "centered" | "full"

interface UiState {
  view: ViewSelection
  sidebarCollapsed: boolean
  composerOpen: boolean
  /** Composer surface mode (see ComposerSizeMode); toggled by the
   * composer header's maximize/restore button. */
  composerMode: ComposerSizeMode
  /**
   * Reading-pane find bar visibility (task 1.1, mail-reading spec "Find
   * in message"): set by the global Ctrl/Cmd+F binding and by the frames'
   * in-body key reach-through, consumed by ThreadView (the session and
   * highlight state live there — this flag only decides whether the bar
   * is mounted). Like composerOpen, pure in-memory view state.
   */
  readingPaneFindOpen: boolean
  /** Help-center dialog visibility (task 2.9): set by the command
   * palette's "Open help center" entry; the dialog is mounted at the
   * mail-shell level. The Settings → Help section mounts the center
   * inline and does not consult this flag. */
  helpCenterOpen: boolean
  /** AI-assistant panel visibility (task 3.1, design D1/D6): flipped by
   * the three self-gating entry points (the search-field Sparkles
   * button, the palette's "Open AI assistant" command and the app-global
   * Cmd/Ctrl+J binding); since the panel rework (task 7.3, design D1
   * revised) the docked panel is mounted inside mail-shell's mailbox
   * panel groups while this flag is set, and the conversation itself
   * persists in the assistant-store across open/close. Pure in-memory
   * view state. */
  assistantOpen: boolean
  /** Thread shown in the reading pane; null = no selection. */
  activeThread: string | null
  /** Bumped whenever the open thread changes in another window (task 1.9
   * cross-window bridge): ThreadView keys on it, so the pane remounts and
   * re-reads the thread from SQLite without the user reselecting it. */
  activeThreadRevision: number
  /** Where the reading pane sits (task 6.5); default "right". */
  readingPane: ReadingPanePosition
  /**
   * Last non-settings view (tasks 9.2/11.1): setView records every
   * non-search, non-settings AND non-contacts selection here. Search views
   * never overwrite it (clearSearch restores the folder/label the user was
   * reading — mail-search spec "Clear a search") and the full-pane pages
   * (settings 11.1, Contacts browser 20.2) never overwrite it either, so
   * their back controls can restore the mailbox view via
   * setView(previousView).
   */
  previousView: ViewSelection
  /**
   * The query-backed scope overriding the view (see ListScopeOverride);
   * null = the view itself drives the thread list. Cleared by setView,
   * set directly by setListScope (task 9.2/9.3 entry points).
   */
  listScope: ListScopeOverride | null
  setView: (view: ViewSelection) => void
  /** Enter/leave a query-backed list scope (unified inbox, split tab,
   * saved search) without changing the underlying view selection. */
  setListScope: (scope: ListScopeOverride | null) => void
  /** Exit a search back to the pre-search view (task 9.2); falls back to
   * the default inbox when no non-search view was visited yet. Only
   * meaningful while view.kind === "search". */
  clearSearch: () => void
  /** Direct setter for pane-resize wiring (dragging the divider in/out)
   * and the explicit collapse gestures; persistence is layered on by the
   * preferences service's setSidebarCollapsedWithPersist. */
  setSidebarCollapsed: (collapsed: boolean) => void
  setComposerOpen: (open: boolean) => void
  setComposerMode: (mode: ComposerSizeMode) => void
  setReadingPaneFindOpen: (open: boolean) => void
  setHelpCenterOpen: (open: boolean) => void
  setAssistantOpen: (open: boolean) => void
  setActiveThread: (threadId: string | null) => void
  /** Remote thread-change signal (task 1.9): forces the reading pane to
   * re-read the currently open thread. */
  bumpActiveThreadRevision: () => void
  setReadingPane: (position: ReadingPanePosition) => void
}

/**
 * Reading-pane layout, per the mailbox-ui spec: right (classic three-pane),
 * bottom (list stacked over the display pane) or hidden (two-pane; opening
 * a thread expands a full-width reading view with a back control).
 */
export type ReadingPanePosition = "right" | "bottom" | "hidden"

export const useUiStore = create<UiState>((set) => ({
  view: DEFAULT_VIEW,
  sidebarCollapsed: false,
  composerOpen: false,
  composerMode: "centered",
  readingPaneFindOpen: false,
  helpCenterOpen: false,
  assistantOpen: false,
  activeThread: null,
  activeThreadRevision: 0,
  readingPane: "right",
  previousView: DEFAULT_VIEW,
  listScope: null,

  setView: (view) =>
    set((state) => ({
      view,
      // Any explicit view selection replaces a query-backed scope override
      // (leaving the unified inbox / a split by navigating a folder or
      // running a search).
      listScope: null,
      // Remember the most recent mailbox selection; a search (including a
      // refined query) and the full-pane pages (settings, the Contacts
      // browser, task 20.2, the Attachments browser, task 3.7, the
      // Calendar view, task 5.3) never clobber it, so the "cancel"/back
      // paths (clearSearch, settings back, the browsers' back controls)
      // restore what the user was reading.
      previousView:
        view.kind === "search" ||
        view.kind === "settings" ||
        view.kind === "contacts" ||
        view.kind === "attachments" ||
        view.kind === "calendar"
          ? state.previousView
          : view,
    })),
  setListScope: (listScope) => set({ listScope }),
  clearSearch: () => set((state) => ({ view: state.previousView })),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setComposerOpen: (composerOpen) => set({ composerOpen }),
  setComposerMode: (composerMode) => set({ composerMode }),
  setReadingPaneFindOpen: (readingPaneFindOpen) => set({ readingPaneFindOpen }),
  setHelpCenterOpen: (helpCenterOpen) => set({ helpCenterOpen }),
  setAssistantOpen: (assistantOpen) => set({ assistantOpen }),
  setActiveThread: (activeThread) => set({ activeThread }),
  bumpActiveThreadRevision: () =>
    set((state) => ({
      activeThreadRevision: state.activeThreadRevision + 1,
    })),
  // In-memory only — persistence is the preferences service's job
  // (setReadingPanePreference), which calls this after its write.
  setReadingPane: (readingPane) => set({ readingPane }),
}))
