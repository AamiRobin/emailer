import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"

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
import {
  setThreadListStoreExecutor,
  useThreadListStore,
} from "@/stores/thread-list-store"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import { setFolderCountsStoreExecutor } from "@/stores/folder-counts-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import {
  installResizeObserverMock,
  setMockViewportHeight,
  uninstallResizeObserverMock,
} from "./resize-observer-mock"
import { ThreadList } from "../thread-list"

/**
 * Relaxed-search UI (task 1.3, mail-search spec "Relaxed fallback" +
 * "Operators stay strict"): the list shows a visible "relaxed search"
 * badge when the search box's zero-result strict query was re-run in
 * any-term mode, and the operator-query empty state explains the query
 * instead. Runs the REAL store → search pipeline against node:sqlite.
 */

let executor: TestExecutor

function resetStores(): void {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    readingPane: "right",
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
    searchRelaxed: false,
    drafts: [],
    labelsByThreadId: {},
    loading: false,
    loaded: false,
    selectedIds: new Set<string>(),
    selectionAnchor: null,
    unreadOnly: false,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetStores()
  installResizeObserverMock()
  setMockViewportHeight(10_000)
  executor = createTestExecutor()
  setThreadListStoreExecutor(executor)
  setAccountStoreExecutor(executor)
  setFolderCountsStoreExecutor(executor)
})

afterEach(() => {
  cleanup()
  uninstallResizeObserverMock()
  setThreadListStoreExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  executor.close()
})

/** One thread whose snippet carries `text` — searchable free text. */
async function seedText(accountId: string, text: string): Promise<string> {
  const threadId = await createThread(executor, accountId, {
    subject: `${text} thread`,
  })
  await createMessage(executor, {
    threadId,
    accountId,
    date: Math.floor(Date.now() / 1000) - 60,
    subject: `${text} thread`,
    snippet: `${text} body preview`,
    bodyText: `${text} body preview`,
    fromName: "Biz",
    fromAddress: "biz@corp.example",
  })
  await recomputeThreadCaches(executor, threadId)
  return threadId
}

describe("relaxed search badge (task 1.3)", () => {
  it("shows the badge when the strict query fell back to any-term", async () => {
    const accountId = await createAccount(executor, "gmail")
    useAccountStore.setState({
      accounts: [
        {
          id: accountId,
          type: "gmail",
          email: `${accountId}@example.com`,
          displayName: null,
          status: "active",
          unreadCount: 0,
        },
      ],
      activeAccountId: accountId,
      loaded: true,
    })
    await seedText(accountId, "banking")
    await seedText(accountId, "roadmap")
    useUiStore.setState({
      view: { kind: "search", query: "banking roadmap" },
    })

    render(<ThreadList />)

    const badge = await screen.findByTestId("search-relaxed-badge")
    expect(badge.textContent).toContain("Relaxed search")
    // both single-term matches render as rows
    await screen.findByText(/banking thread/i)
    await screen.findByText(/roadmap thread/i)
  })

  it("hides the badge for strict hits and operator-query empty states", async () => {
    const accountId = await createAccount(executor, "gmail")
    useAccountStore.setState({
      accounts: [
        {
          id: accountId,
          type: "gmail",
          email: `${accountId}@example.com`,
          displayName: null,
          status: "active",
          unreadCount: 0,
        },
      ],
      activeAccountId: accountId,
      loaded: true,
    })
    await seedText(accountId, "banking")

    // strict hit: rows, no badge
    useUiStore.setState({ view: { kind: "search", query: "banking" } })
    render(<ThreadList />)
    await screen.findByText(/banking thread/i)
    expect(screen.queryByTestId("search-relaxed-badge")).toBeNull()

    // operator query with no matches: empty state explains the operators,
    // and no relaxed badge ever appears
    cleanup()
    useUiStore.setState({
      view: { kind: "search", query: "banking from:nobody@corp.example" },
    })
    render(<ThreadList />)
    const empty = await screen.findByTestId("empty-state")
    expect(empty.textContent).toContain("matched exactly")
    expect(screen.queryByTestId("search-relaxed-badge")).toBeNull()
  })
})
