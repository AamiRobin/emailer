import { create } from "zustand"

import type { SpecialUse } from "@/services/db/labels"

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
  | { kind: "settings" }

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
    case "settings":
      return "Settings"
  }
}

interface UiState {
  view: ViewSelection
  sidebarCollapsed: boolean
  composerOpen: boolean
  /** Thread shown in the reading pane; null = no selection. */
  activeThread: string | null
  /** Where the reading pane sits (task 6.5); default "right". */
  readingPane: ReadingPanePosition
  /**
   * Last non-settings view (tasks 9.2/11.1): setView records every
   * non-search AND non-settings selection here. Search views never
   * overwrite it (clearSearch restores the folder/label the user was
   * reading — mail-search spec "Clear a search") and settings views never
   * overwrite it either, so the settings page's back control can restore
   * the mailbox view via setView(previousView).
   */
  previousView: ViewSelection
  setView: (view: ViewSelection) => void
  /** Exit a search back to the pre-search view (task 9.2); falls back to
   * the default inbox when no non-search view was visited yet. Only
   * meaningful while view.kind === "search". */
  clearSearch: () => void
  toggleSidebar: () => void
  /** Direct setter for pane-resize wiring (dragging the divider in/out). */
  setSidebarCollapsed: (collapsed: boolean) => void
  setComposerOpen: (open: boolean) => void
  setActiveThread: (threadId: string | null) => void
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
  activeThread: null,
  readingPane: "right",
  previousView: DEFAULT_VIEW,

  setView: (view) =>
    set((state) => ({
      view,
      // Remember the most recent mailbox selection; a search (including a
      // refined query) and the settings page never clobber it, so both
      // "cancel" paths (clearSearch, settings back) restore what the user
      // was reading.
      previousView:
        view.kind === "search" || view.kind === "settings"
          ? state.previousView
          : view,
    })),
  clearSearch: () => set((state) => ({ view: state.previousView })),
  toggleSidebar: () =>
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setComposerOpen: (composerOpen) => set({ composerOpen }),
  setActiveThread: (activeThread) => set({ activeThread }),
  // In-memory only — persistence is the preferences service's job
  // (setReadingPanePreference), which calls this after its write.
  setReadingPane: (readingPane) => set({ readingPane }),
}))
