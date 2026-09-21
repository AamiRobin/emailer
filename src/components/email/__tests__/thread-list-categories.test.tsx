import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

/**
 * The thread list's category override wiring (task 3.5, design D4): the
 * context menu's "Move to category" / "Always categorize <sender> as"
 * items funnel through the list handlers into the REAL override services
 * (categorization/overrides.ts) against the shared seeded executor — the
 * DB rows and the toast double as the proof. Only rendered while the
 * `organization.categoriesEnabled` setting is on.
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

import { getSenderCategory } from "@/services/categorization/sender-categories"
import { getThread } from "@/services/db/threads"
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
  setCategoriesSectionExecutor,
  setCategoryTabsEnabled,
} from "@/components/layout/use-categories"
import {
  setThreadListStoreExecutor,
  useThreadListStore,
} from "@/stores/thread-list-store"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import {
  setFolderCountsStoreExecutor,
  useFolderCountsStore,
} from "@/stores/folder-counts-store"
import { EMPTY_FOLDER_COUNTS } from "@/services/db/folder-counts"
import { useComposerStore } from "@/stores/composer-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import {
  installResizeObserverMock,
  setMockViewportHeight,
  uninstallResizeObserverMock,
} from "./resize-observer-mock"
import { ThreadList } from "../thread-list"

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
  useComposerStore.getState().reset()
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: false,
  })
  useFolderCountsStore.setState({
    accountId: null,
    counts: EMPTY_FOLDER_COUNTS,
  })
  useThreadListStore.setState({
    accountId: null,
    view: null,
    scope: null,
    threads: [],
    drafts: [],
    labelsByThreadId: {},
    userLabels: [],
    loading: false,
    loaded: false,
    selectedIds: new Set<string>(),
    selectionAnchor: null,
    unreadOnly: false,
  })
}

beforeEach(() => {
  resetStores()
  installResizeObserverMock()
  setMockViewportHeight(10_000)
  executor = createTestExecutor()
  setThreadListStoreExecutor(executor)
  setAccountStoreExecutor(executor)
  setFolderCountsStoreExecutor(executor)
  setCategoriesSectionExecutor(executor)
})

afterEach(async () => {
  cleanup()
  uninstallResizeObserverMock()
  setThreadListStoreExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  setCategoriesSectionExecutor(null)
  executor.close()
  resetStores()
})

async function seedInboxThread(options: {
  subject: string
  fromAddress: string
}): Promise<string> {
  const accountId = await createAccount(executor, "gmail")
  const inbox = await createGmailLabel(
    executor,
    accountId,
    "INBOX",
    "INBOX",
    "inbox"
  )
  const threadId = await createThread(executor, accountId, {
    subject: options.subject,
  })
  await createMessage(executor, {
    threadId,
    accountId,
    date: Math.floor(Date.now() / 1000) - 60,
    subject: options.subject,
    fromAddress: options.fromAddress,
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
  return threadId
}

async function openRowMenu(row: HTMLElement): Promise<void> {
  fireEvent.contextMenu(row, { clientX: 8, clientY: 8 })
  await waitFor(() =>
    expect(screen.queryByRole("menu", { hidden: true })).not.toBeNull()
  )
}

describe("thread list category override wiring (task 3.5)", () => {
  it("Move to category writes threads.category through the override service", async () => {
    const threadId = await seedInboxThread({
      subject: "Moveable",
      fromAddress: "ada@x.com",
    })
    await setCategoryTabsEnabled(true)
    const { container } = render(<ThreadList />)
    const row = await waitFor(() => {
      const found = container.querySelector<HTMLElement>("[data-thread-row]")
      if (!found) throw new Error("no rows yet")
      return found
    })
    await openRowMenu(row)

    fireEvent.click(screen.getByRole("menuitem", { name: "Move to category" }))
    fireEvent.click(await screen.findByTestId("move-to-category-updates"))

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    const thread = await getThread(executor, threadId)
    expect(thread?.category).toBe("updates")
    // The per-sender store is untouched by a plain move.
    expect(await getSenderCategory(executor, "ada@x.com")).toBeNull()
  })

  it("Always categorize <sender> as writes the sender rule AND moves the thread", async () => {
    const threadId = await seedInboxThread({
      subject: "Sender rule",
      fromAddress: "news@x.com",
    })
    await setCategoryTabsEnabled(true)
    const { container } = render(<ThreadList />)
    const row = await waitFor(() => {
      const found = container.querySelector<HTMLElement>("[data-thread-row]")
      if (!found) throw new Error("no rows yet")
      return found
    })
    await openRowMenu(row)

    fireEvent.click(
      screen.getByRole("menuitem", { name: "Always categorize news@x.com as" })
    )
    fireEvent.click(await screen.findByTestId("always-from-sender-social"))

    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(await getSenderCategory(executor, "news@x.com")).toEqual({
      category: "social",
      source: "user",
    })
    const thread = await getThread(executor, threadId)
    expect(thread?.category).toBe("social")
  })

  it("renders no category entries while categorization is disabled", async () => {
    await seedInboxThread({ subject: "Plain", fromAddress: "a@x.com" })
    const { container } = render(<ThreadList />)
    const row = await waitFor(() => {
      const found = container.querySelector<HTMLElement>("[data-thread-row]")
      if (!found) throw new Error("no rows yet")
      return found
    })
    await openRowMenu(row)
    expect(
      screen.queryByRole("menuitem", { name: "Move to category" })
    ).toBeNull()
  })
})
