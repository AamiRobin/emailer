import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { toast } from "sonner"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Snooze entry points (task 2.3). Everything runs REAL — the snooze
 * service writes through the same seeded node:sqlite database the stores
 * read (executor module mocked to hand out the test executor, store
 * overrides set alongside), so every assertion lands on the actual
 * threads.snoozed_until column and the post-snooze list refresh. Only
 * sonner is mocked, for the "Snoozed until …" toast assertion (same
 * boundary as composer.test.tsx).
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
import { getSnoozePresets } from "@/services/email-actions/snooze"
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
import { useComposerStore } from "@/stores/composer-store"
import {
  installResizeObserverMock,
  setMockViewportHeight,
  uninstallResizeObserverMock,
} from "./resize-observer-mock"
import { ThreadList } from "../thread-list"
import { ThreadView } from "../thread-view"

let executor: TestExecutor
let accountId: string
let threadId: string

function tomorrowPreset(): { until: number; label: string } {
  const preset = getSnoozePresets().presets.find(
    (entry) => entry.id === "tomorrow"
  )
  if (!preset) throw new Error("tomorrow preset missing")
  return preset
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
    accounts: [],
    activeAccountId: null,
    loaded: false,
  })
  useThreadListStore.setState({
    accountId: null,
    view: null,
    threads: [],
    drafts: [],
    labelsByThreadId: {},
    loading: false,
    loaded: false,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetStores()
  installResizeObserverMock()
  setMockViewportHeight(10_000)
  executor = createTestExecutor()
  executorHolder.current = executor
  setThreadListStoreExecutor(executor)
  setAccountStoreExecutor(executor)
  setFolderCountsStoreExecutor(executor)
})

afterEach(async () => {
  cleanup()
  uninstallResizeObserverMock()
  setThreadListStoreExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  executorHolder.current = null
  executor.close()
  resetStores()
})

/** One account with one inbox thread — the snooze target. The message
 * carries a gmail id so the mark-read-on-open enqueue (reading pane
 * tests) can run for real. */
async function seedInboxThread(): Promise<string> {
  accountId = await createAccount(executor, "gmail")
  const inbox = await createGmailLabel(
    executor,
    accountId,
    "INBOX",
    "INBOX",
    "inbox"
  )
  threadId = await createThread(executor, accountId, {
    subject: "Snooze target",
  })
  await createMessage(executor, {
    threadId,
    accountId,
    date: Math.floor(Date.now() / 1000) - 60,
    subject: "Snooze target",
    fromName: "Alice",
    fromAddress: "alice@example.com",
    isRead: false,
    gmailMessageId: "g-snooze-1",
  })
  await recomputeThreadCaches(executor, threadId)
  await setThreadLabels(executor, threadId, [inbox])
  useAccountStore.setState({ activeAccountId: accountId, loaded: true })
  return threadId
}

async function storedSnoozedUntil(id: string): Promise<number | null> {
  const rows = await executor.select<{ snoozed_until: number | null }>(
    "SELECT snoozed_until FROM threads WHERE id = $1",
    [id]
  )
  return rows[0]?.snoozed_until ?? null
}

describe("snooze from the thread list (task 2.3)", () => {
  it("the row's hover affordance opens the snooze menu; a preset snoozes through the service", async () => {
    const targetId = await seedInboxThread()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )

    const row = container.querySelector("[data-thread-row]")
    const trigger = row?.querySelector('[aria-label="Snooze"]')
    expect(trigger).not.toBeNull()
    fireEvent.click(trigger as Element)

    const tomorrow = tomorrowPreset()
    fireEvent.click(
      await screen.findByRole("menuitem", { name: tomorrow.label })
    )

    // The shared flow: toast, then the refreshes (list + badges).
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        `Snoozed until ${tomorrow.label}`
      )
    )
    expect(await storedSnoozedUntil(targetId)).toBe(tomorrow.until)
    // The post-snooze list refresh drops the thread from the inbox view.
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).toBeNull()
    )
  })

  it("the context menu snoozes through its submenu preset", async () => {
    const targetId = await seedInboxThread()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    fireEvent.contextMenu(
      container.querySelector("[data-thread-row]") as Element
    )
    await screen.findByTestId("thread-context-menu")

    // The Snooze submenu carries the same presets as the dropdown menu.
    fireEvent.click(screen.getByRole("menuitem", { name: "Snooze" }))
    const tomorrow = tomorrowPreset()
    fireEvent.click(
      await screen.findByRole("menuitem", { name: tomorrow.label })
    )

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        `Snoozed until ${tomorrow.label}`
      )
    )
    expect(await storedSnoozedUntil(targetId)).toBe(tomorrow.until)
  })

  it("the custom date/time entry snoozes at the picked time", async () => {
    const targetId = await seedInboxThread()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    fireEvent.click(container.querySelector('[aria-label="Snooze"]') as Element)
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Pick date & time…" })
    )

    const picker = await screen.findByTestId("snooze-custom-picker")
    fireEvent.change(screen.getByTestId("snooze-custom-input"), {
      target: { value: "2026-09-17T10:30" },
    })
    fireEvent.click(within(picker).getByRole("button", { name: "Snooze" }))

    await waitFor(() => expect(toastMock.success).toHaveBeenCalled())
    // datetime-local values parse as LOCAL time.
    expect(await storedSnoozedUntil(targetId)).toBe(
      Math.floor(new Date("2026-09-17T10:30").getTime() / 1000)
    )
  })
})

describe("snooze from the reading pane (task 2.3)", () => {
  it("the toolbar snooze menu snoozes the open thread", async () => {
    const targetId = await seedInboxThread()
    useUiStore.setState({ activeThread: targetId })
    render(<ThreadView />)
    await screen.findByTestId("thread-subject")

    fireEvent.click(screen.getByTestId("toolbar-snooze"))
    const tomorrow = tomorrowPreset()
    fireEvent.click(
      await screen.findByRole("menuitem", { name: tomorrow.label })
    )

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith(
        `Snoozed until ${tomorrow.label}`
      )
    )
    expect(await storedSnoozedUntil(targetId)).toBe(tomorrow.until)
  })
})
