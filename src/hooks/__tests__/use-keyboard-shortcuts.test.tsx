import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

/**
 * Keyboard-shortcuts hook tests (task 6.6). The hook's service imports
 * are mocked (executor, thread-actions, scheduler) so each test is
 * hermetic; store state is seeded directly (cached list rows) exactly as
 * the thread-list store would hold it after a refresh. Key events are
 * dispatched with fireEvent against window/document targets — the hook
 * listens on the window capture phase, so events bubbling from a focused
 * input traverse it with the right event.target.
 */

vi.mock("@/services/db/executor", () => ({
  getExecutor: () => ({
    select: async () => [],
    execute: async () => ({ rowsAffected: 0 }),
  }),
}))

vi.mock("@/services/email-actions/thread-actions", () => ({
  archiveThread: vi.fn(async () => {}),
  trashThread: vi.fn(async () => {}),
  setThreadRead: vi.fn(async () => {}),
  setThreadStarred: vi.fn(async () => {}),
}))

vi.mock("@/services/sync/scheduler", () => ({
  triggerRefresh: vi.fn(async () => ({ synced: [], errors: [] })),
}))

// The reply binding delegates to the shared reply opener (components/
// email/reply-opener.ts); its db-backed behavior is covered by
// reply-opener.test.ts(x) — here we assert the wiring only.
const openReplyForThreadMock = vi.hoisted(() => vi.fn(async () => true))

vi.mock("@/components/email/reply-opener", () => ({
  openReplyForThread: openReplyForThreadMock,
}))

import {
  archiveThread,
  setThreadRead,
  setThreadStarred,
  trashThread,
} from "@/services/email-actions/thread-actions"
import { triggerRefresh } from "@/services/sync/scheduler"
import type { ThreadRow } from "@/services/db/threads"
import { useAccountStore } from "@/stores/account-store"
import { useComposerStore } from "@/stores/composer-store"
import { useFolderCountsStore } from "@/stores/folder-counts-store"
import { usePaletteStore } from "@/stores/palette-store"
import { useThreadListStore } from "@/stores/thread-list-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { useKeyboardShortcuts } from "../use-keyboard-shortcuts"

function threadRow(id: string, overrides: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id,
    account_id: "acc1",
    subject: `Subject ${id}`,
    snippet: null,
    first_message_at: 1_700_000_000,
    last_message_at: 1_700_000_000,
    message_count: 1,
    unread_count: 1,
    has_attachments: 0,
    is_starred: 0,
    participants: null,
    gmail_thread_id: null,
    folder_label_id: null,
    is_archived: 0,
    is_trashed: 0,
    is_spam: 0,
    created_at: 1_700_000_000,
    ...overrides,
  }
}

const T1 = threadRow("t1")
const T2 = threadRow("t2", { unread_count: 0 })
const T3 = threadRow("t3", { is_starred: 1 })

const refreshThreadListMock = vi.fn(async () => {})
const refreshFolderCountsMock = vi.fn(async () => {})

/**
 * Test host: mounts the hook exactly like App does (help state via
 * useState) plus the `data-testid="search-input"` fixture that stands in
 * for the shell's search field (see the hook's search-input contract).
 */
function HookHost({
  initialHelpOpen = false,
  withSearchInput = true,
}: {
  initialHelpOpen?: boolean
  withSearchInput?: boolean
}) {
  const [helpOpen, setHelpOpen] = useState(initialHelpOpen)
  useKeyboardShortcuts({ helpOpen, setHelpOpen })
  return (
    <div>
      <span data-testid="help-state" data-open={helpOpen ? "true" : "false"} />
      {withSearchInput ? (
        <input data-testid="search-input" aria-label="Search mail" />
      ) : null}
    </div>
  )
}

function renderHarness(
  options: { initialHelpOpen?: boolean; withSearchInput?: boolean } = {}
) {
  return render(
    <HookHost
      initialHelpOpen={options.initialHelpOpen}
      withSearchInput={options.withSearchInput}
    />
  )
}

/** Dispatch a keydown; default target is document.body (bubbles to the
 * window capture listener with target=body). */
function press(
  key: string,
  init: Partial<KeyboardEventInit> = {},
  target: Element | Window = document.body
) {
  fireEvent.keyDown(target, { key, bubbles: true, cancelable: true, ...init })
}

function helpState(): string {
  return screen.getByTestId("help-state").getAttribute("data-open") as string
}

function seedThreads(threads: ThreadRow[]): void {
  useThreadListStore.setState({
    accountId: "acc1",
    view: DEFAULT_VIEW,
    threads,
    labelsByThreadId: {},
    loading: false,
    loaded: true,
    refresh: refreshThreadListMock,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  useUiStore.setState({
    view: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    readingPane: "right",
  })
  useAccountStore.setState({
    accounts: [],
    activeAccountId: "acc1",
    loaded: true,
  })
  seedThreads([T1, T2, T3])
  useFolderCountsStore.setState({
    accountId: "acc1",
    refreshFolderCounts: refreshFolderCountsMock,
  })
  usePaletteStore.setState({ open: false })
  useComposerStore.setState({ open: false, activeAccountId: null })
})

afterEach(() => {
  cleanup()
})

describe("useKeyboardShortcuts — list navigation", () => {
  it("j selects the first thread, then walks down; clamps at the end", () => {
    renderHarness()
    press("j")
    expect(useUiStore.getState().activeThread).toBe("t1")
    press("j")
    press("j")
    expect(useUiStore.getState().activeThread).toBe("t3")
    press("j")
    expect(useUiStore.getState().activeThread).toBe("t3")
  })

  it("ArrowDown / ArrowUp are aliases; k walks back up and clamps at the top", () => {
    renderHarness()
    press("ArrowDown")
    press("ArrowDown")
    expect(useUiStore.getState().activeThread).toBe("t2")
    press("k")
    expect(useUiStore.getState().activeThread).toBe("t1")
    press("k")
    expect(useUiStore.getState().activeThread).toBe("t1")
  })

  it("navigation repeats are allowed (held key walks the list)", () => {
    renderHarness()
    press("j", { repeat: true })
    press("j", { repeat: true })
    expect(useUiStore.getState().activeThread).toBe("t2")
  })

  it("navigation is a no-op on an empty list", () => {
    seedThreads([])
    renderHarness()
    press("j")
    press("k")
    expect(useUiStore.getState().activeThread).toBeNull()
  })

  it("navigation is ignored outside a thread-list context (settings view)", () => {
    useUiStore.setState({ view: { kind: "settings" } })
    renderHarness()
    press("j")
    expect(useUiStore.getState().activeThread).toBeNull()
  })

  it("Enter / o opens the selected thread (falls back to the first row)", () => {
    renderHarness()
    press("Enter")
    expect(useUiStore.getState().activeThread).toBe("t1")
    press("j")
    press("o")
    expect(useUiStore.getState().activeThread).toBe("t2")
  })
})

describe("useKeyboardShortcuts — thread actions", () => {
  it("e archives the selected thread via the executor-first service", async () => {
    renderHarness()
    press("j")
    press("e")
    await waitFor(() => expect(archiveThread).toHaveBeenCalledTimes(1))
    expect(archiveThread).toHaveBeenCalledWith(expect.anything(), "acc1", "t1")
    // List + folder badges refresh after the action (task 10.1 wiring).
    expect(refreshThreadListMock).toHaveBeenCalled()
    expect(refreshFolderCountsMock).toHaveBeenCalled()
  })

  it("archive/trash advance the selection to the next thread", async () => {
    renderHarness()
    press("j")
    press("e")
    await waitFor(() => expect(refreshThreadListMock).toHaveBeenCalled())
    expect(useUiStore.getState().activeThread).toBe("t2")
  })

  it("# trashes the selected thread", async () => {
    renderHarness()
    press("j")
    press("j")
    press("#")
    await waitFor(() => expect(trashThread).toHaveBeenCalledTimes(1))
    expect(trashThread).toHaveBeenCalledWith(expect.anything(), "acc1", "t2")
  })

  it("m toggles unread → read and read → unread", async () => {
    renderHarness()
    press("j")
    press("m")
    await waitFor(() => expect(setThreadRead).toHaveBeenCalledTimes(1))
    expect(setThreadRead).toHaveBeenCalledWith(
      expect.anything(),
      "acc1",
      "t1",
      true
    )
  })

  it("m marks a read thread unread", async () => {
    seedThreads([T2, T1])
    renderHarness()
    press("j")
    press("m")
    await waitFor(() => expect(setThreadRead).toHaveBeenCalledTimes(1))
    expect(setThreadRead).toHaveBeenCalledWith(
      expect.anything(),
      "acc1",
      "t2",
      false
    )
  })

  it("s stars an unstarred thread", async () => {
    renderHarness()
    press("j")
    press("s")
    await waitFor(() => expect(setThreadStarred).toHaveBeenCalledTimes(1))
    expect(setThreadStarred).toHaveBeenCalledWith(
      expect.anything(),
      "acc1",
      "t1",
      true
    )
  })

  it("s unstars a starred thread", async () => {
    seedThreads([T3])
    renderHarness()
    press("j")
    press("s")
    await waitFor(() => expect(setThreadStarred).toHaveBeenCalledTimes(1))
    expect(setThreadStarred).toHaveBeenCalledWith(
      expect.anything(),
      "acc1",
      "t3",
      false
    )
  })

  it("thread actions are no-ops with no active account", async () => {
    useAccountStore.setState({ activeAccountId: null })
    renderHarness()
    press("j")
    press("e")
    press("#")
    press("m")
    press("s")
    // Let microtasks settle, then confirm nothing fired.
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(archiveThread).not.toHaveBeenCalled()
    expect(trashThread).not.toHaveBeenCalled()
    expect(setThreadRead).not.toHaveBeenCalled()
    expect(setThreadStarred).not.toHaveBeenCalled()
  })

  it("thread actions are no-ops without a selected thread", () => {
    renderHarness()
    press("e")
    expect(archiveThread).not.toHaveBeenCalled()
  })
})

describe("useKeyboardShortcuts — compose and reply", () => {
  it("c opens a blank composer for the active account", () => {
    renderHarness()
    press("c")
    const composer = useComposerStore.getState()
    expect(composer.open).toBe(true)
    expect(composer.mode).toEqual({ kind: "new" })
    expect(composer.activeAccountId).toBe("acc1")
    expect(useUiStore.getState().composerOpen).toBe(true)
  })

  it("r opens a prefilled reply for the selected thread via the shared opener", async () => {
    renderHarness()
    press("j")
    press("r")
    await waitFor(() => expect(openReplyForThreadMock).toHaveBeenCalledTimes(1))
    expect(openReplyForThreadMock).toHaveBeenCalledWith({
      threadId: "t1",
      replyAll: false,
    })
    // The opener owns the composer state (prefill); the hook only
    // delegates.
    expect(useComposerStore.getState().mode).toEqual({ kind: "new" })
  })

  it("r without a selected thread does nothing", () => {
    renderHarness()
    press("r")
    expect(openReplyForThreadMock).not.toHaveBeenCalled()
    expect(useComposerStore.getState().open).toBe(false)
    expect(useUiStore.getState().composerOpen).toBe(false)
  })

  it("no keys pass through while the composer is open", () => {
    useUiStore.setState({ composerOpen: true })
    renderHarness()
    press("e")
    press("c")
    press("?")
    expect(archiveThread).not.toHaveBeenCalled()
    expect(useComposerStore.getState().open).toBe(false)
    expect(helpState()).toBe("false")
  })
})

describe("useKeyboardShortcuts — palette, help, refresh", () => {
  it("Cmd/Ctrl+K toggles the palette store", () => {
    renderHarness()
    press("k", { ctrlKey: true })
    expect(usePaletteStore.getState().open).toBe(true)
    press("k", { ctrlKey: true })
    expect(usePaletteStore.getState().open).toBe(false)
    press("k", { metaKey: true })
    expect(usePaletteStore.getState().open).toBe(true)
  })

  it("plain keys are ignored while the palette is open", () => {
    usePaletteStore.setState({ open: true })
    renderHarness()
    press("e")
    press("j")
    expect(archiveThread).not.toHaveBeenCalled()
    expect(useUiStore.getState().activeThread).toBeNull()
  })

  it("? opens the help overlay (via the caller-owned state)", () => {
    renderHarness()
    press("?", { shiftKey: true })
    expect(helpState()).toBe("true")
  })

  it("Esc dismisses the help overlay", () => {
    renderHarness({ initialHelpOpen: true })
    press("Escape")
    expect(helpState()).toBe("false")
  })

  it("only Esc passes while the help overlay is open", () => {
    renderHarness({ initialHelpOpen: true })
    press("e")
    press("j")
    expect(archiveThread).not.toHaveBeenCalled()
    expect(useUiStore.getState().activeThread).toBeNull()
    expect(helpState()).toBe("true")
  })

  it("Shift+R triggers the manual refresh", async () => {
    renderHarness()
    press("R", { shiftKey: true })
    await waitFor(() => expect(triggerRefresh).toHaveBeenCalledTimes(1))
  })

  it("auto-repeat is ignored for non-navigation bindings", () => {
    renderHarness()
    press("j")
    press("e", { repeat: true })
    press("c", { repeat: true })
    expect(archiveThread).not.toHaveBeenCalled()
    expect(useComposerStore.getState().open).toBe(false)
  })

  it("menu modifiers alone do not trigger plain-key bindings", () => {
    renderHarness()
    press("e", { metaKey: true })
    press("c", { ctrlKey: true })
    expect(archiveThread).not.toHaveBeenCalled()
    expect(useComposerStore.getState().open).toBe(false)
  })
})

describe("useKeyboardShortcuts — typing contexts", () => {
  it("keys typed inside an input are ignored", () => {
    renderHarness()
    const input = screen.getByTestId("search-input") as HTMLInputElement
    input.focus()
    press("j", {}, input)
    press("e", {}, input)
    press("c", {}, input)
    press("?", {}, input)
    expect(useUiStore.getState().activeThread).toBeNull()
    expect(archiveThread).not.toHaveBeenCalled()
    expect(useComposerStore.getState().open).toBe(false)
    expect(helpState()).toBe("false")
  })

  it("/ focuses the search input when it is present", () => {
    renderHarness()
    press("/")
    expect(document.activeElement).toBe(screen.getByTestId("search-input"))
  })

  it("/ no-ops gracefully when no search input exists", () => {
    renderHarness({ withSearchInput: false })
    expect(() => press("/")).not.toThrow()
    expect(document.activeElement).toBe(document.body)
  })

  it("/ also focuses the shell's current mail-search fixture", () => {
    renderHarness({ withSearchInput: false })
    // The shell worker's search-field currently renders
    // data-testid="mail-search"; the hook accepts both testids until the
    // contract converges (see the focus-search handler).
    const shellInput = document.createElement("input")
    shellInput.setAttribute("data-testid", "mail-search")
    document.body.appendChild(shellInput)
    press("/")
    expect(document.activeElement).toBe(shellInput)
    shellInput.remove()
  })
})
