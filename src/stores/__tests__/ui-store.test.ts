import { beforeEach, describe, expect, it } from "vitest"

import type { ViewSelection } from "../ui-store"
import { DEFAULT_VIEW, useUiStore, viewDisplayName } from "../ui-store"

function resetStore(): void {
  localStorage.clear()
  useUiStore.setState({
    view: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    readingPane: "right",
    previousView: DEFAULT_VIEW,
    listScope: null,
    assistantOpen: false,
  })
}

beforeEach(resetStore)

describe("ui store", () => {
  it("starts on the inbox folder view with everything closed", () => {
    const state = useUiStore.getState()
    expect(state.view).toEqual({
      kind: "folder",
      folder: { kind: "specialUse", specialUse: "inbox" },
    })
    expect(state.sidebarCollapsed).toBe(false)
    expect(state.composerOpen).toBe(false)
    expect(state.activeThread).toBeNull()
  })

  it("setView accepts every selection kind and drives the display name", () => {
    const views: ViewSelection[] = [
      { kind: "folder", folder: { kind: "starred" } },
      { kind: "folder", folder: { kind: "specialUse", specialUse: "sent" } },
      { kind: "folder", folder: { kind: "labelId", labelId: "label-1" } },
      { kind: "label", labelId: "label-1", name: "Work" },
      { kind: "search", query: "invoices" },
      { kind: "settings" },
    ]
    for (const view of views) {
      useUiStore.getState().setView(view)
      expect(useUiStore.getState().view).toEqual(view)
    }
    expect(viewDisplayName(views[0])).toBe("Starred")
    expect(viewDisplayName(views[1])).toBe("Sent")
    expect(viewDisplayName(views[3])).toBe("Work")
    expect(viewDisplayName(views[4])).toBe("Search: invoices")
    expect(viewDisplayName(views[5])).toBe("Settings")
  })

  it("setSidebarCollapsed sets the flag", () => {
    useUiStore.getState().setSidebarCollapsed(true)
    expect(useUiStore.getState().sidebarCollapsed).toBe(true)
    useUiStore.getState().setSidebarCollapsed(false)
    expect(useUiStore.getState().sidebarCollapsed).toBe(false)
  })

  it("setComposerOpen tracks the requested state", () => {
    useUiStore.getState().setComposerOpen(true)
    expect(useUiStore.getState().composerOpen).toBe(true)
    useUiStore.getState().setComposerOpen(false)
    expect(useUiStore.getState().composerOpen).toBe(false)
  })

  it("setActiveThread selects and clears the reading-pane thread", () => {
    useUiStore.getState().setActiveThread("thread-7")
    expect(useUiStore.getState().activeThread).toBe("thread-7")
    useUiStore.getState().setActiveThread(null)
    expect(useUiStore.getState().activeThread).toBeNull()
  })

  // Task 3.1 (design D1/D6): the assistant dialog flag mirrors the
  // helpCenterOpen pattern — entry points set it, the shell mounts the
  // dialog off it.
  it("setAssistantOpen tracks the requested state", () => {
    expect(useUiStore.getState().assistantOpen).toBe(false)
    useUiStore.getState().setAssistantOpen(true)
    expect(useUiStore.getState().assistantOpen).toBe(true)
    useUiStore.getState().setAssistantOpen(false)
    expect(useUiStore.getState().assistantOpen).toBe(false)
  })

  it("setReadingPane switches positions in memory (persistence is the preferences service)", () => {
    expect(useUiStore.getState().readingPane).toBe("right")
    useUiStore.getState().setReadingPane("bottom")
    expect(useUiStore.getState().readingPane).toBe("bottom")
    useUiStore.getState().setReadingPane("hidden")
    expect(useUiStore.getState().readingPane).toBe("hidden")
    // Task 11.3 moved persistence to the settings table
    // (src/services/settings/preferences.ts); the store is in-memory only.
    expect(localStorage.getItem("emailer.reading-pane")).toBeNull()
  })
})

describe("ui store search/clear-to-previous (task 9.2)", () => {
  const starredView: ViewSelection = {
    kind: "folder",
    folder: { kind: "starred" },
  }
  const search = (query: string): ViewSelection => ({
    kind: "search",
    query,
  })

  it("setView records mailbox views as the restore target, never search or settings", () => {
    useUiStore.getState().setView(starredView)
    expect(useUiStore.getState().previousView).toEqual(starredView)
    // The settings page is navigational, not a mailbox state: entering it
    // keeps the restore target so its back control can return to what the
    // user was reading (task 11.1).
    useUiStore.getState().setView({ kind: "settings" })
    expect(useUiStore.getState().previousView).toEqual(starredView)
    expect(useUiStore.getState().view).toEqual({ kind: "settings" })
  })

  it("search views never overwrite the restore target", () => {
    useUiStore.getState().setView(starredView)
    useUiStore.getState().setView(search("invoices"))
    expect(useUiStore.getState().previousView).toEqual(starredView)
    // A refined query is still a search — the memory stays put.
    useUiStore.getState().setView(search("invoices from:acme"))
    expect(useUiStore.getState().previousView).toEqual(starredView)
    expect(useUiStore.getState().view).toEqual(search("invoices from:acme"))
  })

  it("clearSearch restores the pre-search folder view", () => {
    useUiStore.getState().setView(starredView)
    useUiStore.getState().setView(search("invoices"))
    useUiStore.getState().clearSearch()
    expect(useUiStore.getState().view).toEqual(starredView)
  })

  it("clearSearch falls back to the default inbox when nothing else was visited", () => {
    useUiStore.getState().setView(search("first thing"))
    useUiStore.getState().clearSearch()
    expect(useUiStore.getState().view).toEqual(DEFAULT_VIEW)
  })
})

describe("ui store list-scope override (task 9.1)", () => {
  it("enters and leaves a query-backed scope without changing the view", () => {
    expect(useUiStore.getState().listScope).toBeNull()
    useUiStore.getState().setListScope({ kind: "unified" })
    expect(useUiStore.getState().listScope).toEqual({ kind: "unified" })
    // The underlying view selection stays put (the folder the scope was
    // entered from) — the override rides beside it.
    expect(useUiStore.getState().view).toEqual(DEFAULT_VIEW)
    useUiStore.getState().setListScope({
      kind: "split",
      name: "Unread",
      query: "is:unread",
      accountId: "acc-1",
    })
    expect(useUiStore.getState().listScope).toEqual({
      kind: "split",
      name: "Unread",
      query: "is:unread",
      accountId: "acc-1",
    })
    useUiStore.getState().setListScope(null)
    expect(useUiStore.getState().listScope).toBeNull()
  })

  it("any setView clears the override", () => {
    useUiStore.getState().setListScope({ kind: "unified" })
    useUiStore.getState().setView({ kind: "settings" })
    expect(useUiStore.getState().listScope).toBeNull()

    useUiStore.getState().setListScope({
      kind: "saved-search",
      name: "Receipts",
      query: "receipt",
    })
    useUiStore.getState().setView({
      kind: "folder",
      folder: { kind: "specialUse", specialUse: "sent" },
    })
    expect(useUiStore.getState().listScope).toBeNull()
    expect(useUiStore.getState().view).toEqual({
      kind: "folder",
      folder: { kind: "specialUse", specialUse: "sent" },
    })
  })
})
