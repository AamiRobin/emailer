import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
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
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { recomputeThreadCaches } from "@/services/db/threads"
import { createSplit, listSplits } from "@/services/settings/splits"
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
import { setSplitsSectionExecutor, setSplitHiddenById } from "../use-splits"
import { SplitsTabBar } from "../splits-tab-bar"

/**
 * Splits tab bar (task 9.3). The bar runs its real settings-row and count
 * queries against a seeded node:sqlite database via the executor override
 * hooks; entering/leaving a split drives the REAL ui-store list-scope flow
 * (setListScope → thread-list-store refresh through the search pipeline).
 * The toast is mocked (sonner renders nothing under jsdom).
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

const toastMock = vi.mocked(toast)

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
  setSplitsSectionExecutor(executor)
  setAccountStoreExecutor(executor)
  setThreadListStoreExecutor(executor)
})

afterEach(async () => {
  cleanup()
  setSplitsSectionExecutor(null)
  setAccountStoreExecutor(null)
  setThreadListStoreExecutor(null)
  executor.close()
  resetStores()
})

/** Two active accounts: accountA with one unread thread + one boss thread,
 * accountB with one unread thread. The is:unread split counts 2, the boss
 * split counts 1. */
async function seedMailbox(): Promise<{
  accountA: string
  accountB: string
  unreadA: string
  unreadB: string
  bossA: string
}> {
  const accountA = await createAccount(executor, "gmail")
  const accountB = await createAccount(executor, "imap")

  async function seedThread(
    accountId: string,
    subject: string,
    fromAddress: string,
    unread: boolean
  ): Promise<string> {
    const threadId = await createThread(executor, accountId, { subject })
    await createMessage(executor, {
      threadId,
      accountId,
      date: Math.floor(Date.now() / 1000) - 60,
      subject,
      snippet: `${subject} snippet`,
      fromName: "Sender",
      fromAddress,
      isRead: !unread,
    })
    await recomputeThreadCaches(executor, threadId)
    return threadId
  }

  const unreadA = await seedThread(accountA, "Unread A", "a@x.com", true)
  const bossA = await seedThread(accountA, "Boss mail", "boss@work.com", false)
  const unreadB = await seedThread(accountB, "Unread B", "b@x.com", true)
  void unreadB

  useAccountStore.setState({
    accounts: [
      {
        id: accountA,
        type: "gmail",
        email: `${accountA}@example.com`,
        displayName: null,
        status: "active",
        unreadCount: 3,
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
  return { accountA, accountB, unreadA, unreadB, bossA }
}

async function openTabMenu(name: string): Promise<void> {
  fireEvent.click(
    await screen.findByRole("button", { name: `Options for split ${name}` })
  )
}

describe("splits tab bar (task 9.3)", () => {
  it("renders one tab per visible split with its live count", async () => {
    await seedMailbox()
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [
        "mail.splits",
        JSON.stringify([
          { id: "s-1", name: "Unread", query: "is:unread", position: 0 },
          {
            id: "s-2",
            name: "Boss",
            query: "from:boss@work.com",
            position: 1,
          },
        ]),
      ]
    )
    render(<SplitsTabBar />)

    const bar = await screen.findByTestId("splits-tab-bar")
    const tabs = within(bar).getAllByTestId("split-tab")
    expect(tabs).toHaveLength(2)
    expect(tabs[0]!.textContent).toContain("Unread")
    expect(tabs[1]!.textContent).toContain("Boss")
    // Counts come from the search pipeline over the active accounts.
    await waitFor(() => {
      expect(within(tabs[0]!).getByTestId("split-tab-count").textContent).toBe(
        "2"
      )
      expect(within(tabs[1]!).getByTestId("split-tab-count").textContent).toBe(
        "1"
      )
    })
  })

  it("clicking a tab enters its split scope and filters the list; clicking again leaves", async () => {
    const { accountA, unreadA, unreadB, bossA } = await seedMailbox()
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [
        "mail.splits",
        JSON.stringify([
          { id: "s-1", name: "Boss", query: "from:boss@work.com", position: 0 },
        ]),
      ]
    )
    render(<SplitsTabBar />)

    const tab = await screen.findByTestId("split-tab")
    expect(tab.getAttribute("aria-selected")).toBe("false")

    // Enter: the ui-store gains the split scope and the thread list
    // resolves ONLY the boss thread through the search pipeline.
    fireEvent.click(within(tab).getByText("Boss"))
    await waitFor(() =>
      expect(useUiStore.getState().listScope).toEqual({
        kind: "split",
        name: "Boss",
        query: "from:boss@work.com",
      })
    )
    await waitFor(() => {
      const state = useThreadListStore.getState()
      expect(state.loaded).toBe(true)
      expect(state.threads.map((thread) => thread.id)).toEqual([bossA])
    })
    expect(
      (await screen.findByTestId("split-tab")).getAttribute("aria-selected")
    ).toBe("true")

    // Leave: back to the underlying view (the default inbox view) — the
    // list shows the active account's inbox scope again.
    fireEvent.click(within(tab).getByText("Boss"))
    await waitFor(() => expect(useUiStore.getState().listScope).toBeNull())
    await waitFor(() => {
      const state = useThreadListStore.getState()
      expect(state.scope).toEqual({
        kind: "account",
        accountId: accountA,
        folder: { kind: "specialUse", specialUse: "inbox" },
      })
    })
    void unreadA
    void unreadB
  })

  it("the menu moves a tab within the bar (persisted order)", async () => {
    await seedMailbox()
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [
        "mail.splits",
        JSON.stringify([
          { id: "s-1", name: "Unread", query: "is:unread", position: 0 },
          { id: "s-2", name: "Boss", query: "from:boss", position: 1 },
        ]),
      ]
    )
    render(<SplitsTabBar />)
    await screen.findByTestId("splits-tab-bar")

    await openTabMenu("Unread")
    fireEvent.click(await screen.findByRole("menuitem", { name: /Move right/ }))

    await waitFor(() => {
      const tabs = screen.getAllByTestId("split-tab")
      expect(tabs[0]!.textContent).toContain("Boss")
      expect(tabs[1]!.textContent).toContain("Unread")
    })
    const stored = await listSplits(executor)
    expect(stored.map((split) => split.name)).toEqual(["Boss", "Unread"])
  })

  it("the menu hides a tab (persisted, bar drops it, active scope left)", async () => {
    await seedMailbox()
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [
        "mail.splits",
        JSON.stringify([
          {
            id: "s-1",
            name: "Boss",
            query: "from:boss@work.com",
            position: 0,
          },
        ]),
      ]
    )
    render(<SplitsTabBar />)
    const tab = await screen.findByTestId("split-tab")
    fireEvent.click(within(tab).getByText("Boss"))
    await waitFor(() => expect(useUiStore.getState().listScope).not.toBeNull())

    await openTabMenu("Boss")
    fireEvent.click(await screen.findByRole("menuitem", { name: "Hide" }))

    await waitFor(() => expect(screen.queryByTestId("split-tab")).toBeNull())
    const stored = await listSplits(executor)
    expect(stored).toHaveLength(1)
    expect(stored[0]!.hidden).toBe(true)
    // The active split scope is left behind with the tab.
    await waitFor(() => expect(useUiStore.getState().listScope).toBeNull())
  })

  it("the menu deletes a tab (persisted; mail untouched)", async () => {
    const { bossA } = await seedMailbox()
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [
        "mail.splits",
        JSON.stringify([
          {
            id: "s-1",
            name: "Boss",
            query: "from:boss@work.com",
            position: 0,
          },
        ]),
      ]
    )
    render(<SplitsTabBar />)
    await screen.findByTestId("split-tab")

    await openTabMenu("Boss")
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }))

    await waitFor(() => expect(screen.queryByTestId("split-tab")).toBeNull())
    expect(await listSplits(executor)).toEqual([])
    // The underlying mail is unaffected (splits are queries, not folders).
    const threads = await executor.select<{ count: number }>(
      "SELECT COUNT(*) AS count FROM threads"
    )
    expect(threads[0]!.count).toBe(3)
    void bossA
  })

  it("the + menu creates a split through the dialog (all accounts by default)", async () => {
    await seedMailbox()
    render(<SplitsTabBar />)

    fireEvent.click(screen.getByRole("button", { name: "Split options" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "New split…" }))

    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: "Starred" },
    })
    fireEvent.change(within(dialog).getByLabelText("Query"), {
      target: { value: "is:starred" },
    })
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create split" })
    )

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    const tab = await screen.findByTestId("split-tab")
    expect(tab.textContent).toContain("Starred")
    const stored = await listSplits(executor)
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({
      name: "Starred",
      query: "is:starred",
    })
    expect(stored[0]!.accountId ?? null).toBeNull()
    expect(toastMock.success).toHaveBeenCalledTimes(1)
  })

  it("a duplicate name keeps the dialog open with a form error", async () => {
    await seedMailbox()
    const created = await createSplitViaService()
    render(<SplitsTabBar />)
    await screen.findByTestId("split-tab")

    fireEvent.click(screen.getByRole("button", { name: "Split options" }))
    fireEvent.click(await screen.findByRole("menuitem", { name: "New split…" }))

    const dialog = await screen.findByRole("dialog")
    fireEvent.change(within(dialog).getByLabelText("Name"), {
      target: { value: created.name },
    })
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create split" })
    )

    expect(await screen.findByRole("alert")).toBeTruthy()
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(await listSplits(executor)).toHaveLength(1)
  })

  it("Manage splits lists hidden splits and unhides them back into the bar", async () => {
    await seedMailbox()
    const boss = await createSplitViaService()
    await hideBossViaFlow(boss.id)
    render(<SplitsTabBar />)
    expect(screen.queryByTestId("split-tab")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Split options" }))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Manage splits…" })
    )
    const dialog = await screen.findByRole("dialog")
    expect(
      within(dialog).getByTestId("hidden-split-row").textContent
    ).toContain("Boss")

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Unhide split Boss" })
    )
    // The unhide happens behind the open dialog: the tab returns to the
    // bar and the hidden list empties.
    await waitFor(() =>
      expect(screen.queryByTestId("split-tab")).not.toBeNull()
    )
    await waitFor(() =>
      expect(within(dialog).queryByTestId("hidden-split-row")).toBeNull()
    )
    expect(await listSplits(executor)).toHaveLength(1)
    expect((await listSplits(executor))[0]!.hidden).not.toBe(true)
  })

  it("counts refresh when the thread list reloads after mail changes", async () => {
    await seedMailbox()
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [
        "mail.splits",
        JSON.stringify([
          { id: "s-1", name: "Unread", query: "is:unread", position: 0 },
        ]),
      ]
    )
    render(<SplitsTabBar />)
    const count = () =>
      within(screen.getByTestId("split-tab")).getByTestId("split-tab-count")
        .textContent
    await waitFor(() => expect(count()).toBe("2"))

    // Mark everything read, then run the same post-change refresh the
    // thread actions use — the tab count catches up.
    await executor.execute("UPDATE threads SET unread_count = 0")
    await refreshThreadList()
    await waitFor(() => expect(count()).toBe("0"))
  })

  // -- helpers reusing the real flows --

  async function createSplitViaService(): Promise<{
    id: string
    name: string
  }> {
    const result = await createSplit(executor, {
      name: "Boss",
      query: "from:boss@work.com",
    })
    if (!result.ok) throw new Error("seed split failed")
    return result.split
  }

  async function hideBossViaFlow(splitId: string): Promise<void> {
    await setSplitHiddenById(splitId, true)
  }
})
