import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

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
  createSavedSearch,
  listSavedSearches,
} from "@/services/db/saved-searches"
import { recomputeThreadCaches, setThreadLabels } from "@/services/db/threads"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import { setFolderCountsStoreExecutor } from "@/stores/folder-counts-store"
import {
  refreshThreadList,
  setThreadListStoreExecutor,
  useThreadListStore,
} from "@/stores/thread-list-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { setSidebarDataExecutor } from "../use-sidebar-data"
import { setSnoozedSectionExecutor } from "../use-snoozed-threads"
import {
  deleteSavedSearchById,
  renameSavedSearch,
  setSavedSearchesSectionExecutor,
} from "../use-saved-searches"
import { SavedSearchesSection } from "../saved-searches-section"
import { Sidebar } from "../sidebar"

/**
 * Saved Searches sidebar section (task 7.1). The section runs its real
 * queries against a seeded node:sqlite database via the executor override
 * hooks, and the save→run→delete round-trip drives the REAL flows
 * production uses: createSavedSearch writes the row, the row click runs
 * runSavedSearch (the search-view navigation + thread-list refresh, the
 * same sequence as submitting the search field — the stored query goes
 * through the regular parse → query-builder pipeline), and the row's
 * delete button funnels through deleteSavedSearchById's notify.
 */

let executor: TestExecutor

function resetStores(): void {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    previousView: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
  })
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
}

beforeEach(() => {
  resetStores()
  executor = createTestExecutor()
  setSavedSearchesSectionExecutor(executor)
  setSnoozedSectionExecutor(executor)
  setAccountStoreExecutor(executor)
  setFolderCountsStoreExecutor(executor)
  setThreadListStoreExecutor(executor)
  setSidebarDataExecutor(executor)
})

afterEach(async () => {
  cleanup()
  setSavedSearchesSectionExecutor(null)
  setSnoozedSectionExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  setThreadListStoreExecutor(null)
  setSidebarDataExecutor(null)
  executor.close()
  resetStores()
})

/** One active account with one thread whose subject matches "planning". */
async function seedAccountWithThread(): Promise<{
  accountId: string
  threadId: string
}> {
  const accountId = await createAccount(executor, "gmail")
  const inbox = await createGmailLabel(
    executor,
    accountId,
    "INBOX",
    "INBOX",
    "inbox"
  )
  const threadId = await createThread(executor, accountId, {
    subject: "Quarterly planning doc",
  })
  await createMessage(executor, {
    threadId,
    accountId,
    date: Math.floor(Date.now() / 1000) - 60,
    subject: "Quarterly planning doc",
    isRead: false,
  })
  await recomputeThreadCaches(executor, threadId)
  await setThreadLabels(executor, threadId, [inbox])
  useAccountStore.setState({
    accounts: [
      {
        id: accountId,
        type: "gmail",
        email: `${accountId}@example.com`,
        displayName: null,
        status: "active",
        unreadCount: 1,
      },
    ],
    activeAccountId: accountId,
    loaded: true,
  })
  return { accountId, threadId }
}

describe("saved searches sidebar section (task 7.1)", () => {
  it("save→run→delete: the row navigates to the search view, resolves the query's results, and delete removes the entry", async () => {
    const { threadId } = await seedAccountWithThread()
    await createSavedSearch(executor, {
      name: "Planning",
      query: "planning",
    })
    render(<SavedSearchesSection />)

    // The saved search renders (name + stored query).
    const section = await screen.findByTestId("saved-searches-section")
    expect(section.textContent).toContain("Planning")
    expect(section.textContent).toContain("planning")

    // RUN: clicking the row runs the exact search-box flow — the ui-store
    // view becomes the search view carrying the stored query, and the
    // thread list resolves the query through the regular pipeline.
    fireEvent.click(screen.getByText("Planning").closest("button")!)
    await waitFor(() =>
      expect(useUiStore.getState().view).toEqual({
        kind: "search",
        query: "planning",
      })
    )
    await waitFor(() => {
      const state = useThreadListStore.getState()
      expect(state.loaded).toBe(true)
      expect(state.threads.map((thread) => thread.id)).toEqual([threadId])
    })

    // DELETE: the row's X removes the entry — the section empties and the
    // table row is gone; the seeded mail is unaffected.
    fireEvent.click(
      screen.getByRole("button", { name: "Delete saved search Planning" })
    )
    await waitFor(() =>
      expect(screen.queryByTestId("saved-searches-section")).toBeNull()
    )
    expect(await listSavedSearches(executor)).toEqual([])
    const threads = await executor.select<{ count: number }>(
      "SELECT COUNT(*) AS count FROM threads"
    )
    expect(threads[0]!.count).toBe(1)
  })

  it("starts empty, so nothing renders until a search is saved", async () => {
    await seedAccountWithThread()
    render(<SavedSearchesSection />)
    expect(screen.queryByTestId("saved-searches-section")).toBeNull()
  })

  it("renames an entry through the row's pencil dialog", async () => {
    await seedAccountWithThread()
    await createSavedSearch(executor, { name: "Planning", query: "planning" })
    render(<SavedSearchesSection />)
    await screen.findByTestId("saved-searches-section")

    fireEvent.click(
      screen.getByRole("button", { name: "Rename saved search Planning" })
    )
    const input = await screen.findByLabelText("Saved search name")
    fireEvent.change(input, { target: { value: "Quarterly docs" } })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await waitFor(() => expect(screen.getByText("Quarterly docs")).toBeTruthy())
    const rows = await listSavedSearches(executor)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: "Quarterly docs", query: "planning" })
  })

  it("renders inside the sidebar (expanded rail, between Snoozed and Labels)", async () => {
    await seedAccountWithThread()
    await createSavedSearch(executor, {
      name: "Unread client mail",
      query: "is:unread from:client.com",
    })

    render(
      <TooltipProvider delay={0}>
        <Sidebar isCollapsed={false} />
      </TooltipProvider>
    )

    const section = await screen.findByTestId("saved-searches-section")
    expect(section.textContent).toContain("Unread client mail")
    expect(section.textContent).toContain("is:unread from:client.com")
  })

  it("the section reloads when the notify seam fires after an external delete", async () => {
    await seedAccountWithThread()
    const id = await createSavedSearch(executor, {
      name: "Planning",
      query: "planning",
    })
    render(<SavedSearchesSection />)
    await screen.findByTestId("saved-searches-section")

    await deleteSavedSearchById(id)

    await waitFor(() =>
      expect(screen.queryByTestId("saved-searches-section")).toBeNull()
    )
  })

  it("refreshThreadList keeps resolving the search view results after the run (list stays a cache of the view)", async () => {
    const { threadId } = await seedAccountWithThread()
    await createSavedSearch(executor, { name: "Planning", query: "planning" })
    render(<SavedSearchesSection />)
    await screen.findByTestId("saved-searches-section")

    fireEvent.click(screen.getByText("Planning").closest("button")!)
    await waitFor(() =>
      expect(useThreadListStore.getState().threads).toHaveLength(1)
    )

    // An explicit no-op refresh of the same view re-resolves the query.
    await refreshThreadList()
    expect(useThreadListStore.getState().threads.map((t) => t.id)).toEqual([
      threadId,
    ])
  })

  it("renameSavedSearch via the flow notifies the section", async () => {
    await seedAccountWithThread()
    const id = await createSavedSearch(executor, { name: "Before", query: "q" })
    render(<SavedSearchesSection />)
    await screen.findByText("Before")

    expect(await renameSavedSearch(id, "After")).toBe(true)

    expect(await screen.findByText("After")).toBeTruthy()
  })
})
