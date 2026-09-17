import {
  afterEach,
  beforeEach,
  beforeAll,
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
 * The reading pane (task 7.x) resolves the shared executor directly; hand
 * it the same seeded test executor the stores get via their overrides.
 */
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
import { recomputeThreadCaches, setThreadLabels } from "@/services/db/threads"
import {
  installResizeObserverMock,
  setMockViewportHeight,
  uninstallResizeObserverMock,
} from "@/components/email/__tests__/resize-observer-mock"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import { setFolderCountsStoreExecutor } from "@/stores/folder-counts-store"
import {
  setThreadListStoreExecutor,
  useThreadListStore,
} from "@/stores/thread-list-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { setSidebarDataExecutor } from "../use-sidebar-data"
import { MailShell } from "../mail-shell"

/**
 * Reading-pane position tests (task 6.5, mailbox-ui spec "Three-pane app
 * shell"): the shell renders three panes (right), a vertical split
 * (bottom) or two panes (hidden), and the hidden position swaps the list
 * for the full-width reading view with a working back control.
 *
 * The three positions are exercised in one mounted shell via the position
 * switcher — the exact user flow — against the real stores backed by a
 * seeded node:sqlite database (executor injection like the other suites).
 */

let executor: TestExecutor

// jsdom lacks matchMedia, which the mounted sonner Toaster queries.
beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
})

function resetStores(): void {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    readingPane: "right",
    previousView: DEFAULT_VIEW,
    listScope: null,
  })
  useThreadListStore.setState({
    accountId: null,
    view: null,
    threads: [],
    labelsByThreadId: {},
    loading: false,
    loaded: false,
  })
  // Fresh per-test database: force the next shell mount to re-init the
  // account store against the new executor (init short-circuits on
  // loaded=true — a stale active id would break the thread list).
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: false,
  })
  localStorage.clear()
}

async function seedMailbox(): Promise<void> {
  const accountId = await createAccount(executor, "gmail")
  const inbox = await createGmailLabel(
    executor,
    accountId,
    "INBOX",
    "INBOX",
    "inbox"
  )
  for (const [subject, seconds, unread] of [
    ["First thread", 60, true],
    ["Second thread", 120, false],
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
      isRead: !unread,
    })
    await recomputeThreadCaches(executor, threadId)
    await setThreadLabels(executor, threadId, [inbox])
  }
}

beforeEach(async () => {
  resetStores()
  installResizeObserverMock()
  setMockViewportHeight(4000)
  executor = createTestExecutor()
  executorHolder.current = executor
  setThreadListStoreExecutor(executor)
  setAccountStoreExecutor(executor)
  setFolderCountsStoreExecutor(executor)
  setSidebarDataExecutor(executor)
  await seedMailbox()
})

afterEach(() => {
  cleanup()
  uninstallResizeObserverMock()
  setThreadListStoreExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  setSidebarDataExecutor(null)
  executorHolder.current = null
  executor.close()
})

function panelCount(container: HTMLElement): number {
  return container.querySelectorAll('[data-slot="resizable-panel"]').length
}

// The header no longer carries pane-position buttons (the tweakcn
// reference keeps them in settings); tests drive the ui-store directly,
// the same entry point Settings → Reading uses after persisting.
function switchTo(position: "right" | "bottom" | "hidden"): void {
  act(() => {
    useUiStore.getState().setReadingPane(position)
  })
}

describe("reading pane positions", () => {
  it("moves the display pane between right, bottom and hidden", async () => {
    const { container } = render(<MailShell />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )

    // Right (default): three panes — sidebar | list | display — with the
    // display pane showing its empty state until a thread is selected.
    expect(useUiStore.getState().readingPane).toBe("right")
    expect(panelCount(container)).toBe(3)
    expect(screen.getByText("No message selected")).not.toBeNull()

    // Bottom: sidebar | list-over-display — the nested vertical group's
    // separators run horizontally (the library inverts the aria value).
    switchTo("bottom")
    await waitFor(() => expect(panelCount(container)).toBe(4))
    expect(
      container.querySelector(
        '[data-slot="resizable-handle"][aria-orientation="horizontal"]'
      )
    ).not.toBeNull()
    expect(
      container.querySelector('[data-testid="thread-list-scroll"]')
    ).not.toBeNull()
    expect(screen.getByText("No message selected")).not.toBeNull()

    // Hidden: two panes; the display pane is gone until a thread opens.
    switchTo("hidden")
    await waitFor(() => expect(panelCount(container)).toBe(2))
    expect(
      container.querySelector(
        '[data-slot="resizable-handle"][aria-orientation="horizontal"]'
      )
    ).toBeNull()
    expect(
      container.querySelector('[data-testid="thread-list-scroll"]')
    ).not.toBeNull()
    expect(screen.queryByText("No message selected")).toBeNull()

    // Opening a thread replaces the list with the full-width reading view.
    const firstRow = container.querySelector("[data-thread-row]") as Element
    const threadId = firstRow.getAttribute("data-thread-row")
    fireEvent.click(firstRow)
    const backButton = await screen.findByRole("button", {
      name: /Back to list/,
    })
    expect(
      container.querySelector('[data-testid="thread-list-scroll"]')
    ).toBeNull()
    expect(useUiStore.getState().activeThread).toBe(threadId)
    // The display mounts the real reader (task 7.x) with the thread loaded.
    await screen.findByText("First thread")

    // Back returns to the list and clears the selection.
    fireEvent.click(backButton)
    await waitFor(() =>
      expect(
        container.querySelector('[data-testid="thread-list-scroll"]')
      ).not.toBeNull()
    )
    expect(useUiStore.getState().activeThread).toBeNull()
    expect(screen.queryByText(/Back to list/)).toBeNull()
  })
})

describe("settings view (task 11.1)", () => {
  it("replaces the mailbox panes with the settings page; back restores the view", async () => {
    const { container } = render(<MailShell />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )

    // The sidebar's settings entry navigates to the settings page, which
    // replaces the mailbox panes.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }))
    expect(
      await screen.findByRole("heading", { name: "Settings" })
    ).toBeTruthy()
    expect(
      screen.getByRole("navigation", { name: "Settings sections" })
    ).toBeTruthy()
    expect(container.querySelector("[data-thread-row]")).toBeNull()

    // The boot preferences hook ran against the seeded executor: with no
    // stored rows it applies the defaults (density token 1).
    expect(document.documentElement.style.getPropertyValue("--density")).toBe(
      "1"
    )

    // Back returns to the previous mailbox view (the default inbox).
    fireEvent.click(screen.getByRole("button", { name: "Back to mailbox" }))
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    expect(useUiStore.getState().view).toEqual(DEFAULT_VIEW)
  })
})

describe("active split tab title (task 9.3)", () => {
  it("retitles the pane with the split's name instead of the folder's", async () => {
    const { container } = render(<MailShell />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    // The underlying view is the inbox…
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeTruthy()

    // …entering the split scope retitles the pane to the split's name —
    // the list is the split's query, not the folder.
    act(() => {
      useUiStore
        .getState()
        .setListScope({ kind: "split", name: "Receipts", query: "receipt" })
    })
    expect(
      await screen.findByRole("heading", { name: "Receipts" })
    ).toBeTruthy()

    // Leaving the scope restores the folder title.
    act(() => {
      useUiStore.getState().setListScope(null)
    })
    await screen.findByRole("heading", { name: "Inbox" })
  })
})
