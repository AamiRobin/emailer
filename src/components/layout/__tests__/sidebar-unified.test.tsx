import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  initAccountStore,
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import {
  setFolderCountsStoreExecutor,
  useFolderCountsStore,
} from "@/stores/folder-counts-store"
import { setSidebarDataExecutor } from "../use-sidebar-data"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { Sidebar } from "../sidebar"

/**
 * Unified-inbox entry tests (task 9.2): the sidebar entry renders only
 * with 2+ ACTIVE accounts (below that it would duplicate the single
 * account's inbox), enters the ui-store list scope without touching the
 * view selection, highlights while the scope is active, and every other
 * navigation (setView) clears the scope again — the built-in way out.
 */

let executor: TestExecutor

// The sidebar's side hooks (snoozed threads, saved searches) resolve the
// shared executor through getExecutor(); bind it to the current test
// database like the main sidebar suite does (read at call time).
vi.mock("@/services/db/executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/services/db/executor")>()
  return {
    ...actual,
    getExecutor: () => executor,
  }
})

function resetStores(): void {
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: false,
  })
  useUiStore.setState({
    view: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    listScope: null,
  })
  useFolderCountsStore.setState({
    accountId: null,
    counts: {
      inbox: 0,
      starred: 0,
      sent: 0,
      drafts: 0,
      archive: 0,
      spam: 0,
      trash: 0,
    },
  })
}

beforeEach(() => {
  executor = createTestExecutor()
  setAccountStoreExecutor(executor)
  setFolderCountsStoreExecutor(executor)
  setSidebarDataExecutor(executor)
  resetStores()
})

afterEach(() => {
  cleanup()
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  setSidebarDataExecutor(null)
  executor.close()
  resetStores()
})

function renderSidebar(isCollapsed = false) {
  return render(
    <TooltipProvider delay={0}>
      <Sidebar isCollapsed={isCollapsed} />
    </TooltipProvider>
  )
}

async function seedAccounts(count: number): Promise<string[]> {
  const ids: string[] = []
  for (let index = 0; index < count; index += 1) {
    const accountId = await createAccount(executor, "gmail")
    if (index === 0) {
      await executor.execute(
        "UPDATE accounts SET is_active = 1 WHERE id = $1",
        [accountId]
      )
    }
    await createGmailLabel(executor, accountId, "INBOX", "INBOX", "inbox")
    ids.push(accountId)
  }
  await initAccountStore()
  return ids
}

describe("sidebar unified-inbox entry (task 9.2)", () => {
  it("stays hidden with fewer than two active accounts", async () => {
    await seedAccounts(1)
    renderSidebar()
    expect(screen.queryByRole("button", { name: "Unified inbox" })).toBeNull()
  })

  it("appears above the folders with two active accounts and enters the scope", async () => {
    const [accountA] = await seedAccounts(2)
    renderSidebar()

    const entry = await screen.findByRole("button", { name: "Unified inbox" })
    // Above the per-account folders: it precedes the Inbox row (the
    // FOLLOWING bit on the other node means it comes after this one).
    const inboxButton = screen.getByRole("button", { name: "Inbox" })
    expect(
      entry.compareDocumentPosition(inboxButton) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()

    // The account load has settled by now (initAccountStore), so the
    // entry click enters the list scope WITHOUT changing the view.
    fireEvent.click(entry)
    expect(useUiStore.getState().listScope).toEqual({ kind: "unified" })
    expect(useUiStore.getState().view).toEqual(DEFAULT_VIEW)
    expect(useAccountStore.getState().activeAccountId).toBe(accountA)
    // And the entry highlights as the active destination.
    await waitFor(() => {
      expect(entry.getAttribute("aria-current")).toBe("true")
    })
  })

  it("exits when another view is selected (setView clears the scope)", async () => {
    await seedAccounts(2)
    useUiStore.getState().setListScope({ kind: "unified" })
    renderSidebar()

    const entry = await screen.findByRole("button", { name: "Unified inbox" })
    expect(entry.getAttribute("aria-current")).toBe("true")

    fireEvent.click(screen.getByRole("button", { name: "Trash" }))
    expect(useUiStore.getState().listScope).toBeNull()
    expect(entry.getAttribute("aria-current")).toBeNull()
  })

  it("the collapsed icon rail keeps the entry (tooltip carries the name)", async () => {
    await seedAccounts(2)
    renderSidebar(true)

    const entry = await screen.findByRole("button", {
      name: "Unified inbox",
    })
    fireEvent.click(entry)
    expect(useUiStore.getState().listScope).toEqual({ kind: "unified" })
    // No visible label on the rail.
    expect(screen.queryByText("Unified inbox")).toBeNull()
  })
})
