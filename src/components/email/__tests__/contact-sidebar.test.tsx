import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"

import type { SqlExecutor } from "@/services/db/executor"
import { createMessage, createThread } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { recomputeThreadCaches } from "@/services/db/threads"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import { setFolderCountsStoreExecutor } from "@/stores/folder-counts-store"
import { setThreadListStoreExecutor } from "@/stores/thread-list-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { useComposerStore } from "@/stores/composer-store"
import { ContactSidebar } from "../contact-sidebar"
import { ThreadView } from "../thread-view"

/**
 * Contact-sidebar tests (task 2.7, contacts spec "Contact sidebar"). The
 * db executor module is mocked to hand back the test executor (the
 * thread-view.test.tsx seam) so both the sidebar and the whole ThreadView
 * run against a real seeded node:sqlite database; the sidebar's query and
 * the compose bridge then run for real.
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

let executor: TestExecutor
let accountId: string

function setSelection(threadId: string | null): void {
  useUiStore.setState({ activeThread: threadId })
}

function resetStores(): void {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    readingPane: "right",
  })
  useComposerStore.getState().reset()
  useAccountStore.setState({
    accounts: [
      {
        id: "acc-1",
        type: "gmail",
        email: "acc-1@example.com",
        displayName: null,
        status: "active",
        unreadCount: 0,
      },
    ],
    activeAccountId: null,
    loaded: true,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetStores()
  executor = createTestExecutor()
  executorHolder.current = executor
  setThreadListStoreExecutor(executor)
  setAccountStoreExecutor(executor)
  setFolderCountsStoreExecutor(executor)
})

afterEach(async () => {
  // Let in-flight promise chains settle against the live executor before
  // it is closed (the thread-view.test.tsx rule).
  await new Promise((resolve) => setTimeout(resolve, 0))
  cleanup()
  setThreadListStoreExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  executorHolder.current = null
  executor.close()
})

/** Two unread threads from the same sender; the participants caches are
 * populated exactly like ingestion does. */
async function seedAdaThreads(): Promise<{
  openId: string
  olderId: string
}> {
  accountId = "acc-1"
  await executor.execute(
    "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
    [accountId, "gmail", "me@example.com"]
  )
  const openId = await createThread(executor, accountId, {
    subject: "Open thread",
  })
  await createMessage(executor, {
    threadId: openId,
    accountId,
    date: 1_700_000_300,
    fromName: "Ada Lovelace",
    fromAddress: "ada@example.com",
    isRead: false,
  })
  const olderId = await createThread(executor, accountId, {
    subject: "Older thread",
  })
  await createMessage(executor, {
    threadId: olderId,
    accountId,
    date: 1_700_000_100,
    fromName: "Ada Lovelace",
    fromAddress: "ada@example.com",
    isRead: false,
  })
  await recomputeThreadCaches(executor, openId)
  await recomputeThreadCaches(executor, olderId)
  return { openId, olderId }
}

describe("ContactSidebar (task 2.7)", () => {
  it("renders the contact identity, the initials avatar and the recent threads (open thread excluded)", async () => {
    const { openId, olderId } = await seedAdaThreads()
    render(
      <ContactSidebar
        email="ada@example.com"
        name="Ada Lovelace"
        accountId={accountId}
        excludeThreadId={openId}
        onOpenThread={vi.fn()}
      />
    )

    const sidebar = await screen.findByTestId("contact-sidebar")
    expect(within(sidebar).getByText("Ada Lovelace")).not.toBeNull()
    expect(within(sidebar).getByText("ada@example.com")).not.toBeNull()
    // Gravatar loading is off in tests → the deterministic initials.
    const fallback = sidebar.querySelector('[data-slot="avatar-fallback"]')
    expect(fallback?.textContent).toBe("AL")

    const rows = await within(sidebar).findAllByTestId("contact-thread-row")
    expect(rows).toHaveLength(1)
    expect(rows[0].getAttribute("data-thread-id")).toBe(olderId)
    expect(within(sidebar).getByText("Older thread")).not.toBeNull()
    // The seeded thread is unread → the row carries the unread dot.
    expect(within(rows[0]).getByTestId("contact-thread-unread")).not.toBeNull()
  })

  it("activates onOpenThread with the clicked row's thread id", async () => {
    const { openId, olderId } = await seedAdaThreads()
    const onOpenThread = vi.fn()
    render(
      <ContactSidebar
        email="ada@example.com"
        name="Ada Lovelace"
        accountId={accountId}
        excludeThreadId={openId}
        onOpenThread={onOpenThread}
      />
    )

    fireEvent.click(await screen.findByTestId("contact-thread-row"))
    expect(onOpenThread).toHaveBeenCalledWith(olderId)
  })

  it("compose opens the composer store addressed to the contact as the owning account", async () => {
    const { openId } = await seedAdaThreads()
    render(
      <ContactSidebar
        email="ada@example.com"
        name="Ada Lovelace"
        accountId={accountId}
        excludeThreadId={openId}
        onOpenThread={vi.fn()}
      />
    )
    await screen.findByTestId("contact-sidebar")

    fireEvent.click(screen.getByTestId("contact-compose"))

    // The composeToContact bridge contract: composer store configured
    // FIRST (openNew opens it), then the shell flag flips.
    await waitFor(() => expect(useComposerStore.getState().open).toBe(true))
    const composer = useComposerStore.getState()
    expect(composer.mode).toMatchObject({ kind: "new" })
    expect(composer.activeAccountId).toBe(accountId)
    expect(composer.to).toEqual([
      { name: "Ada Lovelace", email: "ada@example.com" },
    ])
    expect(useUiStore.getState().composerOpen).toBe(true)
  })

  it("compose is disabled without an owning account", async () => {
    await seedAdaThreads()
    render(
      <ContactSidebar
        email="ada@example.com"
        name="Ada Lovelace"
        onOpenThread={vi.fn()}
      />
    )
    await screen.findByTestId("contact-sidebar")

    const button = screen.getByTestId("contact-compose") as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(useComposerStore.getState().open).toBe(false)
    expect(useUiStore.getState().composerOpen).toBe(false)
  })
})

describe("thread-view contact sidebar toggle (task 2.7)", () => {
  it("is hidden by default; the toolbar toggle reveals the sender beside the body", async () => {
    const { openId, olderId } = await seedAdaThreads()
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    setSelection(openId)
    await screen.findByTestId("thread-subject")

    // Default CLOSED: the body is not displaced.
    expect(screen.queryByTestId("contact-sidebar")).toBeNull()

    const toggle = screen.getByTestId("toolbar-contact-sidebar")
    expect(toggle.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(toggle)

    const sidebar = await screen.findByTestId("contact-sidebar")
    expect(toggle.getAttribute("aria-pressed")).toBe("true")
    // The sidebar shows the thread's original sender…
    expect(within(sidebar).getByText("Ada Lovelace")).not.toBeNull()
    expect(within(sidebar).getByText("ada@example.com")).not.toBeNull()
    // …and offers the other thread — the open one is excluded.
    const row = await within(sidebar).findByTestId("contact-thread-row")
    expect(row.getAttribute("data-thread-id")).toBe(olderId)
    // The body is still rendered beside the sidebar.
    expect(screen.getByTestId("thread-subject")).not.toBeNull()
  })

  it("row activation opens that thread; the toggle persists across the switch", async () => {
    const { openId, olderId } = await seedAdaThreads()
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    setSelection(openId)
    await screen.findByTestId("thread-subject")
    fireEvent.click(screen.getByTestId("toolbar-contact-sidebar"))
    fireEvent.click(await screen.findByTestId("contact-thread-row"))

    // The selection changed and the pane reloaded with the other thread.
    await waitFor(() =>
      expect(useUiStore.getState().activeThread).toBe(olderId)
    )
    await waitFor(() =>
      expect(screen.getByTestId("thread-subject").textContent).toContain(
        "Older thread"
      )
    )
    // The sidebar stayed open (the toggle lives in ThreadView, above the
    // per-thread remount) and now excludes the NEW open thread instead.
    const sidebar = await screen.findByTestId("contact-sidebar")
    await waitFor(() => {
      const rows = within(sidebar).getAllByTestId("contact-thread-row")
      expect(rows).toHaveLength(1)
      expect(rows[0].getAttribute("data-thread-id")).toBe(openId)
    })
  })

  it("toggling again hides the sidebar", async () => {
    const { openId } = await seedAdaThreads()
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    setSelection(openId)
    await screen.findByTestId("thread-subject")

    fireEvent.click(screen.getByTestId("toolbar-contact-sidebar"))
    await screen.findByTestId("contact-sidebar")
    fireEvent.click(screen.getByTestId("toolbar-contact-sidebar"))
    await waitFor(() =>
      expect(screen.queryByTestId("contact-sidebar")).toBeNull()
    )
  })
})
