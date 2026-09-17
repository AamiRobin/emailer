import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

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
import { recomputeThreadCaches } from "@/services/db/threads"
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
 * Nudges entry tests (task 14.1, design D8): the sidebar entry renders
 * with 1+ ACTIVE accounts (like Priority, unlike unified's 2+ rule),
 * enters the ui-store list scope without touching the view selection,
 * highlights while active, and carries the inbox marker — a count pill
 * that appears only while the detection (db/nudges.countNudges, across
 * the active accounts) finds awaiting-reply threads.
 */

let executor: TestExecutor

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

/** A thread the nudges detection really flags: addressed to the account,
 * latest message someone else's, older than the 3-day default. */
async function seedNudge(accountId: string): Promise<void> {
  const email = `${accountId}@example.com`
  const threadId = await createThread(executor, accountId, {
    subject: "Quick question",
  })
  await createMessage(executor, {
    threadId,
    accountId,
    date: Math.floor(Date.now() / 1000) - 10 * 24 * 60 * 60,
    fromAddress: "alice@example.com",
    to: [{ email }],
    bodyText: "Did you ever answer this?",
  })
  await recomputeThreadCaches(executor, threadId)
}

describe("sidebar nudges entry (task 14.1)", () => {
  it("stays hidden with no active accounts", async () => {
    await seedAccounts(0)
    renderSidebar()
    expect(screen.queryByRole("button", { name: /Nudges/ })).toBeNull()
  })

  it("renders with a SINGLE active account, after Priority and before the folders", async () => {
    await seedAccounts(1)
    renderSidebar()

    const entry = await screen.findByRole("button", { name: "Nudges" })
    const priority = screen.getByRole("button", { name: "Priority" })
    const inboxButton = screen.getByRole("button", { name: "Inbox" })
    expect(
      priority.compareDocumentPosition(entry) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      entry.compareDocumentPosition(inboxButton) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    // No marker while nothing awaits a reply (the count settled at 0).
    await vi.waitFor(() => {
      expect(entry.textContent).toBe("Nudges")
    })
  })

  it("the marker pill appears while nudges exist, with the active-accounts count", async () => {
    const [accountA] = await seedAccounts(1)
    await seedNudge(accountA)
    renderSidebar()

    await vi.waitFor(() => {
      const entry = screen.getByRole("button", { name: /Nudges/ })
      // textContent joins the label and the pill without whitespace.
      expect(entry.textContent?.replace(/\s+/g, "")).toBe("Nudges1")
    })
  })

  it("enters the nudges list scope without changing the view", async () => {
    const [accountA] = await seedAccounts(1)
    renderSidebar()

    const entry = await screen.findByRole("button", { name: "Nudges" })
    fireEvent.click(entry)
    expect(useUiStore.getState().listScope).toEqual({ kind: "nudges" })
    expect(useUiStore.getState().view).toEqual(DEFAULT_VIEW)
    expect(useAccountStore.getState().activeAccountId).toBe(accountA)
    await vi.waitFor(() => {
      expect(entry.getAttribute("aria-current")).toBe("true")
    })
  })

  it("exits when another view is selected (setView clears the scope)", async () => {
    await seedAccounts(1)
    useUiStore.getState().setListScope({ kind: "nudges" })
    renderSidebar()

    const entry = await screen.findByRole("button", { name: "Nudges" })
    expect(entry.getAttribute("aria-current")).toBe("true")

    fireEvent.click(screen.getByRole("button", { name: "Trash" }))
    expect(useUiStore.getState().listScope).toBeNull()
    expect(entry.getAttribute("aria-current")).toBeNull()
  })

  it("the collapsed icon rail keeps the entry (tooltip carries the name)", async () => {
    await seedAccounts(1)
    renderSidebar(true)

    const entry = await screen.findByRole("button", { name: "Nudges" })
    fireEvent.click(entry)
    expect(useUiStore.getState().listScope).toEqual({ kind: "nudges" })
    expect(screen.queryByText("Nudges")).toBeNull()
  })
})
