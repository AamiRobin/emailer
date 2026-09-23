import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Shell-integration tests for tasks 9.2 (search UI + clear-to-previous),
 * 6.8 (offline banner, pending-ops badge, sync indicator) and 6.9
 * (welcome + informative empty states), plus the palette/composer/toaster
 * mounts. Same executor-injection pattern as mail-shell.test.tsx: the
 * executor module is mocked to hand every store/consumer the seeded
 * node:sqlite executor.
 */

// jsdom lacks matchMedia (queried by the sonner Toaster, the narrow-
// viewport hooks, and cmdk) and Element.scrollIntoView (selection
// scrolling in cmdk); stub both. The stub registers "change" listeners so
// narrow-viewport tests can fire real threshold crossings.
const matchMediaListeners = new Set<(event: unknown) => void>()
beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: (_type: string, listener: (event: unknown) => void) => {
      matchMediaListeners.add(listener)
    },
    removeEventListener: (
      _type: string,
      listener: (event: unknown) => void
    ) => {
      matchMediaListeners.delete(listener)
    },
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  Element.prototype.scrollIntoView = () => {}
})
const executorHolder = vi.hoisted(() => ({
  current: null as SqlExecutor | null,
}))

vi.mock("@/services/db/executor", () => ({
  getExecutor: () => {
    const executor = executorHolder.current
    if (!executor) throw new Error("test executor not set")
    return executor
  },
  placeholders: (count: number, firstIndex = 1): string =>
    Array.from({ length: count }, (_, index) => `$${index + firstIndex}`).join(
      ", "
    ),
}))

import { toast } from "sonner"

import {
  createAccount,
  createGmailLabel,
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  enqueuePendingOperation,
  markOperationDone,
  markOperationFailed,
} from "@/services/db/pending-operations"
import { recomputeThreadCaches, setThreadLabels } from "@/services/db/threads"
import { resetOnlineTrackingForTests } from "@/services/online"
import {
  installResizeObserverMock,
  setMockViewportHeight,
  uninstallResizeObserverMock,
} from "@/components/email/__tests__/resize-observer-mock"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import { useComposerStore } from "@/stores/composer-store"
import { setFolderCountsStoreExecutor } from "@/stores/folder-counts-store"
import { usePaletteStore } from "@/stores/palette-store"
import { useOnlineStore } from "@/stores/online-store"
import {
  setThreadListStoreExecutor,
  useThreadListStore,
} from "@/stores/thread-list-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { setSidebarDataExecutor } from "../use-sidebar-data"
import { MailShell } from "../mail-shell"

let executor: TestExecutor

function resetStores(): void {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    readingPane: "right",
    previousView: DEFAULT_VIEW,
  })
  // Fresh per-test database: force the next shell mount to re-init the
  // account store against the new executor (init short-circuits on
  // loaded=true).
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: false,
  })
  useThreadListStore.setState({
    accountId: null,
    view: null,
    threads: [],
    labelsByThreadId: {},
    loading: false,
    loaded: false,
  })
  useComposerStore.getState().reset()
  usePaletteStore.getState().setOpen(false)
  useOnlineStore
    .getState()
    .setOnline(typeof navigator !== "undefined" ? navigator.onLine : true)
  localStorage.clear()
}

async function seedMailbox(): Promise<string> {
  const accountId = await createAccount(executor, "gmail")
  const inbox = await createGmailLabel(
    executor,
    accountId,
    "INBOX",
    "INBOX",
    "inbox"
  )
  for (const [subject, seconds] of [
    ["First thread", 60],
    ["Second thread", 120],
  ] as const) {
    const threadId = await createThread(executor, accountId, { subject })
    await createMessage(executor, {
      threadId,
      accountId,
      date: Math.floor(Date.now() / 1000) - seconds,
      subject,
      snippet: `${subject} preview`,
      fromName: "Alice",
      fromAddress: "alice@example.com",
    })
    await recomputeThreadCaches(executor, threadId)
    await setThreadLabels(executor, threadId, [inbox])
  }
  return accountId
}

function rowSubjects(container: HTMLElement): string {
  return Array.from(container.querySelectorAll("[data-thread-row]"))
    .map((row) => row.textContent)
    .join("|")
}

beforeEach(() => {
  resetStores()
  installResizeObserverMock()
  setMockViewportHeight(4000)
  executor = createTestExecutor()
  executorHolder.current = executor
  setThreadListStoreExecutor(executor)
  setAccountStoreExecutor(executor)
  setFolderCountsStoreExecutor(executor)
  setSidebarDataExecutor(executor)
})

afterEach(() => {
  cleanup()
  uninstallResizeObserverMock()
  resetOnlineTrackingForTests()
  setThreadListStoreExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  setSidebarDataExecutor(null)
  executorHolder.current = null
  executor.close()
})

afterAll(() => {
  // Leave a pristine environment for other suites in the worker.
  delete (window as { matchMedia?: unknown }).matchMedia
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
})

describe("search UI: submit and clear-to-previous-view (9.2)", () => {
  it("submits a search, shows the query chip, and restores the previous view on clear", async () => {
    await seedMailbox()
    const { container } = render(<MailShell />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    expect(rowSubjects(container)).toContain("Second thread")

    // Submit from the header field.
    fireEvent.change(screen.getByLabelText("Search mail"), {
      target: { value: "First" },
    })
    fireEvent.submit(screen.getByRole("search"))

    // View transitions to search; the header chip and title reflect it.
    await waitFor(() =>
      expect(useUiStore.getState().view).toEqual({
        kind: "search",
        query: "First",
      })
    )
    const chip = await screen.findByTestId("search-query-chip")
    expect(chip.textContent).toContain("First")
    expect(screen.getByText("Search: First")).not.toBeNull()
    // The input keeps reflecting the active query.
    expect(
      (screen.getByLabelText("Search mail") as HTMLInputElement).value
    ).toBe("First")
    // Results render through the thread list.
    await waitFor(() => {
      const subjects = rowSubjects(container)
      expect(subjects).toContain("First thread")
      expect(subjects).not.toContain("Second thread")
    })

    // Clear: back to the pre-search folder view (the inbox), chip gone,
    // field reset, full list back.
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }))
    await waitFor(() =>
      expect(useUiStore.getState().view).toEqual(DEFAULT_VIEW)
    )
    expect(useUiStore.getState().view.kind).toBe("folder")
    expect(screen.queryByTestId("search-query-chip")).toBeNull()
    expect(
      (screen.getByLabelText("Search mail") as HTMLInputElement).value
    ).toBe("")
    await waitFor(() => {
      const subjects = rowSubjects(container)
      expect(subjects).toContain("First thread")
      expect(subjects).toContain("Second thread")
    })
  })

  it("ignores an empty submit", async () => {
    await seedMailbox()
    const { container } = render(<MailShell />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    fireEvent.submit(screen.getByRole("search"))
    expect(useUiStore.getState().view).toEqual(DEFAULT_VIEW)
    expect(screen.queryByTestId("search-query-chip")).toBeNull()
  })

  it("submits on Enter in the field (the webview has no implicit submission)", async () => {
    await seedMailbox()
    const { container } = render(<MailShell />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )

    // The form has no submit button, and neither the webview nor jsdom
    // performs the browser's implicit Enter submission — the field's
    // keydown handler must submit it explicitly.
    fireEvent.change(screen.getByLabelText("Search mail"), {
      target: { value: "invoice" },
    })
    fireEvent.keyDown(screen.getByLabelText("Search mail"), { key: "Enter" })

    await waitFor(() =>
      expect(useUiStore.getState().view).toEqual({
        kind: "search",
        query: "invoice",
      })
    )
    expect(await screen.findByTestId("search-query-chip")).toBeTruthy()
  })
})

describe("offline banner (6.8)", () => {
  it("appears on the window offline event and disappears on online", async () => {
    await seedMailbox()
    render(<MailShell />)
    expect(screen.queryByTestId("offline-banner")).toBeNull()

    act(() => {
      window.dispatchEvent(new Event("offline"))
    })
    const banner = screen.getByTestId("offline-banner")
    expect(banner.textContent).toContain(
      "You're offline — changes will sync when you reconnect"
    )
    expect(useOnlineStore.getState().online).toBe(false)

    act(() => {
      window.dispatchEvent(new Event("online"))
    })
    await waitFor(() =>
      expect(screen.queryByTestId("offline-banner")).toBeNull()
    )
    expect(useOnlineStore.getState().online).toBe(true)
  })
})

describe("pending-ops badge (6.8)", () => {
  it("shows the pending queue depth and ignores terminal rows", async () => {
    const accountId = await seedMailbox()
    await enqueuePendingOperation(executor, {
      accountId,
      opType: "test.send",
      payload: {},
    })
    await enqueuePendingOperation(executor, {
      accountId,
      opType: "test.flag",
      payload: {},
    })
    const done = await enqueuePendingOperation(executor, {
      accountId,
      opType: "test.done",
      payload: {},
    })
    await markOperationDone(executor, done)
    const failed = await enqueuePendingOperation(executor, {
      accountId,
      opType: "test.fail",
      payload: {},
    })
    await markOperationFailed(executor, failed, "nope")

    const { container } = render(<MailShell />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    const badge = await screen.findByTestId("pending-ops-badge")
    expect(badge.textContent).toContain("2")
    expect(badge.getAttribute("aria-label")).toBe("2 pending changes")

    // Clicking the indicator is a no-op (informational only).
    fireEvent.click(badge)
    expect(useUiStore.getState().view).toEqual(DEFAULT_VIEW)
    expect(screen.getByTestId("pending-ops-badge")).not.toBeNull()
  })

  it("renders no badge when the queue is empty", async () => {
    await seedMailbox()
    const { container } = render(<MailShell />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    expect(screen.queryByTestId("pending-ops-badge")).toBeNull()
  })
})

describe("welcome state (6.9)", () => {
  it("offers Add Gmail / Add IMAP/SMTP when no accounts exist", async () => {
    render(<MailShell />)

    const welcome = await screen.findByTestId("welcome-panel")
    expect(welcome.textContent).toContain("Welcome to Emailer")
    expect(screen.getByRole("button", { name: "Add Gmail" })).not.toBeNull()
    expect(screen.getByRole("button", { name: "Add IMAP/SMTP" })).not.toBeNull()
    // The mailbox chrome is not required to proceed: no list is rendered.
    expect(screen.queryByTestId("thread-list-scroll")).toBeNull()

    // The actions open the shared add-account chooser (5.3/5.4 flows).
    fireEvent.click(screen.getByRole("button", { name: "Add Gmail" }))
    expect(await screen.findByText("Add an account")).not.toBeNull()
    expect(screen.getByText("Other email (IMAP/SMTP)")).not.toBeNull()
  })
})

describe("informative empty states (6.9)", () => {
  it("identifies an empty folder instead of a blank pane", async () => {
    await seedMailbox()
    const { container } = render(<MailShell />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    act(() => {
      useUiStore.getState().setView({
        kind: "folder",
        folder: { kind: "specialUse", specialUse: "trash" },
      })
    })
    const empty = await screen.findByTestId("empty-state")
    expect(empty.textContent).toContain("Nothing in Trash")
    expect(empty.textContent).toContain("synced into this folder")
  })

  it("identifies an empty search with the query", async () => {
    await seedMailbox()
    const { container } = render(<MailShell />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    act(() => {
      useUiStore.getState().setView({ kind: "search", query: "zzz-nothing" })
    })
    const empty = await screen.findByTestId("empty-state")
    expect(empty.textContent).toContain('No results for "zzz-nothing"')
    expect(empty.textContent).toContain("Try different keywords")
    // The query chip shows next to the input while searching.
    expect(screen.getByTestId("search-query-chip").textContent).toContain(
      "zzz-nothing"
    )
  })
})

describe("palette, composer and toaster mounts", () => {
  it("renders the palette dialog from the palette store, the composer from the shell flag, and the toaster", async () => {
    await seedMailbox()
    render(<MailShell />)

    // Toaster is mounted: with no toasts sonner renders only its wrapper
    // section, so fire one and assert it lands in the bottom-right host.
    expect(
      document.querySelector('section[aria-label*="Notifications"]')
    ).not.toBeNull()
    act(() => {
      toast("Shell smoke toast")
    })
    expect(await screen.findByText("Shell smoke toast")).not.toBeNull()
    const toasterHost = document.querySelector("[data-sonner-toaster]")
    expect(toasterHost).not.toBeNull()
    expect(toasterHost?.getAttribute("data-y-position")).toBe("bottom")
    expect(toasterHost?.getAttribute("data-x-position")).toBe("right")
    act(() => {
      toast.dismiss()
    })

    // Command palette: closed by default, opens via the palette store.
    expect(
      screen.queryByPlaceholderText(
        "Search mail or jump to a folder, label, account…"
      )
    ).toBeNull()
    act(() => {
      usePaletteStore.getState().setOpen(true)
    })
    expect(
      await screen.findByPlaceholderText(
        "Search mail or jump to a folder, label, account…"
      )
    ).not.toBeNull()
    act(() => {
      usePaletteStore.getState().setOpen(false)
    })
    await waitFor(() =>
      expect(
        screen.queryByPlaceholderText(
          "Search mail or jump to a folder, label, account…"
        )
      ).toBeNull()
    )

    // Composer: setting the shell flag (what the sidebar/palette do) opens
    // it through composer-store.openNew.
    act(() => {
      useUiStore.getState().setComposerOpen(true)
    })
    expect(await screen.findByTestId("composer-overlay")).not.toBeNull()
    // The composer surface is code-split (React.lazy in mail-shell), so
    // its first field arrives asynchronously inside the overlay.
    expect(await screen.findByLabelText("To")).not.toBeNull()
    expect(useComposerStore.getState().open).toBe(true)

    // A composer-initiated close syncs the shell flag back.
    act(() => {
      useComposerStore.getState().close()
    })
    await waitFor(() =>
      expect(screen.queryByTestId("composer-overlay")).toBeNull()
    )
    expect(useUiStore.getState().composerOpen).toBe(false)
  })

  it("minimize hides the centered overlay — `hidden` must win over the centering `flex`", async () => {
    await seedMailbox()
    render(<MailShell />)
    act(() => {
      useUiStore.getState().setComposerOpen(true)
      useUiStore.getState().setComposerMode("centered")
    })
    await screen.findByTestId("composer-overlay")
    // Regression (batch C2 follow-up): `flex` and `hidden` are both
    // display utilities — with both on the overlay the stylesheet order
    // decided, `flex` won, and the minimized card stayed on screen next
    // to the tray chip. The centering classes must drop out while
    // minimized so `hidden` is the only display class left.
    act(() => {
      useComposerStore.getState().minimize()
    })
    const overlay = await screen.findByTestId("composer-overlay")
    expect(overlay.className).toContain("hidden")
    expect(overlay.className).not.toContain("flex")
    // Restoring brings the centering layout back.
    act(() => {
      useComposerStore.getState().restore()
    })
    await waitFor(() => {
      const restored = screen.getByTestId("composer-overlay")
      expect(restored.className).toContain("flex")
      expect(restored.className).not.toContain("hidden")
    })
  })
})

describe("sidebar auto-rail (narrow windows)", () => {
  // jsdom defaults to a 1440px desktop window (vitest.setup.ts); the
  // narrow-window tests shrink it per test and always restore.
  function setWindowWidth(width: number): void {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: width,
    })
  }

  // The production path for a crossing is the browser firing matchMedia
  // "change" (which useNarrowViewport listens to); simulate it after
  // setWindowWidth moved the viewport across a threshold.
  function fireViewportCrossing(): void {
    for (const listener of matchMediaListeners) {
      listener(new Event("change"))
    }
  }

  it("a narrow window folds the sidebar to the rail at mount, without persisting it", async () => {
    await seedMailbox()
    setWindowWidth(1100)
    try {
      render(<MailShell />)
      // The transient auto-collapse writes no settings row — the stored
      // preference keeps whatever the user last chose explicitly.
      await waitFor(() =>
        expect(useUiStore.getState().sidebarCollapsed).toBe(true)
      )
      const rows = await executor.select<{ value: string }>(
        "SELECT value FROM settings WHERE key = $1",
        ["appearance.sidebarCollapsed"]
      )
      expect(rows).toHaveLength(0)
    } finally {
      setWindowWidth(1440)
    }
  })

  it("crossing down mid-session folds to the rail, without persisting it", async () => {
    await seedMailbox()
    render(<MailShell />)
    await waitFor(() => expect(useAccountStore.getState().loaded).toBe(true))
    expect(useUiStore.getState().sidebarCollapsed).toBe(false)
    try {
      setWindowWidth(1100)
      act(() => {
        fireViewportCrossing()
      })
      // The crossing itself must fold the sidebar — and being transient,
      // it must not write the preference either.
      expect(useUiStore.getState().sidebarCollapsed).toBe(true)
      const rows = await executor.select<{ value: string }>(
        "SELECT value FROM settings WHERE key = $1",
        ["appearance.sidebarCollapsed"]
      )
      expect(rows).toHaveLength(0)
    } finally {
      setWindowWidth(1440)
    }
  })

  it("crossing up never auto-expands; an explicit expand persists", async () => {
    await seedMailbox()
    setWindowWidth(1100)
    try {
      render(<MailShell />)
      await waitFor(() =>
        expect(useUiStore.getState().sidebarCollapsed).toBe(true)
      )
      // Widen past the threshold: no auto-expand (explicit gestures only).
      setWindowWidth(1440)
      act(() => {
        fireViewportCrossing()
      })
      expect(useUiStore.getState().sidebarCollapsed).toBe(true)
      // The rail button is the explicit gesture: it expands and writes.
      fireEvent.click(await screen.findByLabelText("Expand sidebar"))
      expect(useUiStore.getState().sidebarCollapsed).toBe(false)
      await waitFor(async () => {
        const rows = await executor.select<{ value: string }>(
          "SELECT value FROM settings WHERE key = $1",
          ["appearance.sidebarCollapsed"]
        )
        expect(JSON.parse(rows[0]?.value ?? "null")).toBe(false)
      })
    } finally {
      setWindowWidth(1440)
    }
  })

  it("a wide window boots expanded with no stored state", async () => {
    await seedMailbox()
    render(<MailShell />)
    await waitFor(() => expect(useAccountStore.getState().loaded).toBe(true))
    expect(useUiStore.getState().sidebarCollapsed).toBe(false)
    // The mount-time adoption must not have written a preference either.
    const rows = await executor.select<{ value: string }>(
      "SELECT value FROM settings WHERE key = $1",
      ["appearance.sidebarCollapsed"]
    )
    expect(rows).toHaveLength(0)
  })
})

describe("saved panel layouts (useDefaultLayout storage)", () => {
  const LAYOUT_KEY =
    "react-resizable-panels:mail-right:sidebar:list:reading"

  it("a corrupt localStorage entry does not crash the shell — defaults render", async () => {
    await seedMailbox()
    // Regression: useDefaultLayout's read path parses the stored value
    // without a guard; the storage wrapper must sanitize first.
    localStorage.setItem(LAYOUT_KEY, "NOT JSON{{{")
    render(<MailShell />)
    await waitFor(() => expect(useAccountStore.getState().loaded).toBe(true))
    // The shell mounted and the lib applied SOME layout to the sidebar
    // (in jsdom the zero-width group degrades to an equal split; the
    // point is the corrupt entry degraded to defaults, not a crash).
    const sidebar = document.getElementById("sidebar")
    expect(sidebar).not.toBeNull()
    expect(sidebar?.getAttribute("style")).toContain("flex")
    // The corrupt value must not have been interpreted as a layout.
    expect(sidebar?.getAttribute("style")).not.toContain("20")
  })

  it("a valid saved layout is restored instead of the defaults", async () => {
    await seedMailbox()
    localStorage.setItem(
      LAYOUT_KEY,
      JSON.stringify({ sidebar: 20, list: 30, reading: 50 })
    )
    render(<MailShell />)
    await waitFor(() => expect(useAccountStore.getState().loaded).toBe(true))
    const sidebar = document.getElementById("sidebar")
    expect(sidebar).not.toBeNull()
    expect(sidebar?.getAttribute("style")).toContain("20")
    const list = document.getElementById("list")
    expect(list?.getAttribute("style")).toContain("30")
  })
})
