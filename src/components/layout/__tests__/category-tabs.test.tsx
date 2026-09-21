import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"

import {
  createAccount,
  createGmailLabel,
  createImapFolderLabel,
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { moveThreadToCategory } from "@/services/categorization/overrides"
import { recomputeThreadCaches } from "@/services/db/threads"
import { createSplit, listSplits } from "@/services/settings/splits"
import { getCategoriesEnabled } from "@/services/settings/categories"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import {
  refreshThreadList,
  setThreadListStoreExecutor,
  useThreadListStore,
} from "@/stores/thread-list-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import {
  setCategoriesSectionExecutor,
  setCategoryTabsEnabled,
} from "../use-categories"
import { setSplitsSectionExecutor } from "../use-splits"
import { SplitsTabBar } from "../splits-tab-bar"

/**
 * The category tabs (task 3.5, mailbox-ui spec "Category tab
 * presentation"): hidden by default (opt-in), five tabs ordered FIRST in
 * the bar when enabled, unread counts per tab with NULL ≡ Primary,
 * Primary active by default, clicking enters/filters the list through the
 * REAL ui-store list-scope flow, and disabling returns the bar to
 * splits-only and leaves an active category scope. The queries run
 * against a seeded node:sqlite database via the executor override hooks;
 * the toast is mocked (sonner renders nothing under jsdom).
 */

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

let executor: TestExecutor

function resetStores(): void {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    previousView: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    listScope: null,
  })
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: false,
  })
  useThreadListStore.setState({
    accountId: null,
    view: null,
    scope: null,
    threads: [],
    labelsByThreadId: {},
    loading: false,
    loaded: false,
  })
}

beforeEach(() => {
  resetStores()
  vi.clearAllMocks()
  executor = createTestExecutor()
  setCategoriesSectionExecutor(executor)
  setSplitsSectionExecutor(executor)
  setAccountStoreExecutor(executor)
  setThreadListStoreExecutor(executor)
})

afterEach(async () => {
  cleanup()
  setCategoriesSectionExecutor(null)
  setSplitsSectionExecutor(null)
  setAccountStoreExecutor(null)
  setThreadListStoreExecutor(null)
  executor.close()
  resetStores()
})

async function seedInboxThread(
  accountId: string,
  inboxLabelId: string,
  options: { subject: string; unread?: boolean }
): Promise<string> {
  const threadId = await createThread(executor, accountId, {
    subject: options.subject,
  })
  await createMessage(executor, {
    threadId,
    accountId,
    date: Math.floor(Date.now() / 1000) - 60,
    subject: options.subject,
    snippet: `${options.subject} snippet`,
    fromName: "Sender",
    fromAddress: `${options.subject.replace(/\W+/g, "").toLowerCase()}@x.com`,
    isRead: !options.unread,
  })
  await recomputeThreadCaches(executor, threadId)
  await executor.execute(
    "UPDATE threads SET folder_label_id = $1 WHERE id = $2",
    [inboxLabelId, threadId]
  )
  return threadId
}

/** Two active accounts, each with an inbox label, and five threads spread
 * over the categories (one left NULL). */
async function seedMailbox(): Promise<{
  accountA: string
  promo: string
  neverCategorized: string
}> {
  const accountA = await createAccount(executor, "gmail")
  const inboxA = await createGmailLabel(
    executor,
    accountA,
    "INBOX",
    "INBOX",
    "inbox"
  )
  const accountB = await createAccount(executor, "imap")
  const inboxB = await createImapFolderLabel(
    executor,
    accountB,
    "INBOX",
    "inbox"
  )

  const promo = await seedInboxThread(accountA, inboxA, {
    subject: "Promo mail",
  })
  await moveThreadToCategory(executor, promo, "promotions")
  const updatesUnread = await seedInboxThread(accountA, inboxA, {
    subject: "Updates mail",
    unread: true,
  })
  await moveThreadToCategory(executor, updatesUnread, "updates")
  const neverCategorized = await seedInboxThread(accountB, inboxB, {
    subject: "Null mail",
    unread: true,
  })

  useAccountStore.setState({
    accounts: [
      {
        id: accountA,
        type: "gmail",
        email: `${accountA}@example.com`,
        displayName: null,
        status: "active",
        unreadCount: 2,
      },
      {
        id: accountB,
        type: "imap",
        email: `${accountB}@example.com`,
        displayName: null,
        status: "active",
        unreadCount: 1,
      },
    ],
    activeAccountId: accountA,
    loaded: true,
  })
  return { accountA, promo, neverCategorized }
}

function categoryTab(category: string): HTMLElement | undefined {
  return screen
    .getAllByTestId("category-tab")
    .find((tab) => tab.getAttribute("data-category") === category)
}

async function tabByCategory(category: string): Promise<HTMLElement> {
  await waitFor(() => expect(categoryTab(category)).toBeTruthy())
  return categoryTab(category)!
}

describe("category tabs (task 3.5)", () => {
  it("renders no category tabs while disabled; the split tabs stay", async () => {
    await seedMailbox()
    await createSplit(executor, { name: "Boss", query: "from:boss@work.com" })
    render(<SplitsTabBar />)

    expect(screen.queryByTestId("category-tab")).toBeNull()
    const splitTab = await screen.findByTestId("split-tab")
    expect(splitTab.textContent).toContain("Boss")
  })

  it("enabling shows the five tabs ordered first with unread counts (NULL ≡ Primary)", async () => {
    const { accountA } = await seedMailbox()
    void accountA
    render(<SplitsTabBar />)
    await screen.findByTestId("splits-tab-bar")

    await setCategoryTabsEnabled(true)

    // Categories ordered FIRST: Primary … Newsletters, before any splits
    // (none here); the row carries both labels.
    await waitFor(() =>
      expect(screen.getAllByTestId("category-tab")).toHaveLength(5)
    )
    const order = screen
      .getAllByTestId("category-tab")
      .map((tab) => tab.getAttribute("data-category"))
    expect(order).toEqual([
      "primary",
      "updates",
      "promotions",
      "social",
      "newsletters",
    ])

    // Unread counts: Updates 1 (its unread thread), Promotions 0 (read),
    // Primary 1 (the NULL row), Social/Newsletters 0.
    const unreadFor = (category: string): string | null =>
      screen
        .getAllByTestId("category-tab")
        .find((tab) => tab.getAttribute("data-category") === category)
        ?.querySelector("[data-testid='category-tab-count']")?.textContent ??
      null
    await waitFor(() => expect(unreadFor("updates")).toBe("1"))
    expect(unreadFor("promotions")).toBe("0")
    expect(unreadFor("primary")).toBe("1")
    expect(unreadFor("social")).toBe("0")
    expect(unreadFor("newsletters")).toBe("0")

    // The setting persisted.
    expect(await getCategoriesEnabled(executor)).toBe(true)
  })

  it("Primary is the default active tab; clicking Promotions filters the list with the scope", async () => {
    const { accountA, promo, neverCategorized } = await seedMailbox()
    void neverCategorized
    render(<SplitsTabBar />)
    await setCategoryTabsEnabled(true)
    const primary = await tabByCategory("primary")
    const promotions = await tabByCategory("promotions")

    // Default state: Primary reads active, no scope override is set.
    expect(primary.getAttribute("aria-selected")).toBe("true")
    expect(promotions.getAttribute("aria-selected")).toBe("false")
    expect(useUiStore.getState().listScope).toBeNull()

    // Click Promotions: the ui-store gains the category scope and the
    // thread list resolves ONLY the promotions thread (across accounts).
    fireEvent.click(within(promotions).getByText("Promotions"))
    await waitFor(() =>
      expect(useUiStore.getState().listScope).toEqual({
        kind: "category",
        category: "promotions",
      })
    )
    await waitFor(() => {
      const state = useThreadListStore.getState()
      expect(state.loaded).toBe(true)
      expect(state.threads.map((thread) => thread.id)).toEqual([promo])
    })
    expect(promotions.getAttribute("aria-selected")).toBe("true")
    expect(primary.getAttribute("aria-selected")).toBe("false")
    void accountA
  })

  it("counts refresh when the thread list reloads after mail changes", async () => {
    await seedMailbox()
    render(<SplitsTabBar />)
    await setCategoryTabsEnabled(true)
    await tabByCategory("primary")
    const unreadFor = (): string | null =>
      screen
        .getAllByTestId("category-tab")
        .find((tab) => tab.getAttribute("data-category") === "updates")
        ?.querySelector("[data-testid='category-tab-count']")?.textContent ??
      null
    await waitFor(() => expect(unreadFor()).toBe("1"))

    await executor.execute("UPDATE threads SET unread_count = 0")
    await refreshThreadList()
    await waitFor(() => expect(unreadFor()).toBe("0"))
  })

  it("clicking the active tab again leaves the scope; a split tab click replaces the category scope", async () => {
    await seedMailbox()
    await createSplit(executor, { name: "Boss", query: "from:boss@work.com" })
    render(<SplitsTabBar />)
    await setCategoryTabsEnabled(true)
    const promotions = await tabByCategory("promotions")
    const splitTab = await screen.findByTestId("split-tab")
    fireEvent.click(within(promotions).getByText("Promotions"))
    await waitFor(() =>
      expect(useUiStore.getState().listScope).toEqual({
        kind: "category",
        category: "promotions",
      })
    )

    // Active tab again → back to the underlying view.
    fireEvent.click(within(promotions).getByText("Promotions"))
    await waitFor(() => expect(useUiStore.getState().listScope).toBeNull())

    // Entering a split replaces the scope (the machinery is shared).
    fireEvent.click(within(splitTab).getByText("Boss"))
    await waitFor(() =>
      expect(useUiStore.getState().listScope).toEqual({
        kind: "split",
        name: "Boss",
        query: "from:boss@work.com",
      })
    )
    expect(promotions.getAttribute("aria-selected")).toBe("false")
  })

  it("disabling hides the tabs, leaves an active category scope, keeps splits", async () => {
    await seedMailbox()
    await createSplit(executor, { name: "Boss", query: "from:boss" })
    render(<SplitsTabBar />)
    await setCategoryTabsEnabled(true)
    const splitTab = await screen.findByTestId("split-tab")
    const promotions = await tabByCategory("promotions")
    fireEvent.click(within(promotions).getByText("Promotions"))
    await waitFor(() =>
      expect(useUiStore.getState().listScope).toEqual({
        kind: "category",
        category: "promotions",
      })
    )

    await setCategoryTabsEnabled(false)

    await waitFor(() => expect(screen.queryByTestId("category-tab")).toBeNull())
    // The active category scope was left with its tab; the list fell back
    // to the underlying inbox view — unaffected by the toggle.
    await waitFor(() => expect(useUiStore.getState().listScope).toBeNull())
    await waitFor(() => {
      const state = useThreadListStore.getState()
      expect(state.loaded).toBe(true)
      expect(state.threads.length).toBeGreaterThan(0)
    })
    expect(splitTab.textContent).toContain("Boss")
    expect(await listSplits(executor)).toHaveLength(1)
  })

  it("the category menu hides the tabs", async () => {
    await seedMailbox()
    render(<SplitsTabBar />)
    await setCategoryTabsEnabled(true)
    await tabByCategory("primary")

    fireEvent.click(screen.getByRole("button", { name: "Category options" }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Hide category tabs" })
    )
    await waitFor(() => expect(screen.queryByTestId("category-tab")).toBeNull())
  })
})
