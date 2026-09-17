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
import { recomputeThreadCaches, setThreadLabels } from "@/services/db/threads"
import { getSnoozePresets, snoozeThread } from "@/services/email-actions/snooze"
import { snoozeThreadsWithRefresh } from "@/components/email/snooze-flow"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import { setFolderCountsStoreExecutor } from "@/stores/folder-counts-store"
import { setThreadListStoreExecutor } from "@/stores/thread-list-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { setSidebarDataExecutor } from "../use-sidebar-data"
import {
  formatSnoozedUntil,
  setSnoozedSectionExecutor,
} from "../use-snoozed-threads"
import { SnoozedSection } from "../snoozed-section"
import { Sidebar } from "../sidebar"

/**
 * Snoozed sidebar section (task 2.4). The section runs its real queries
 * against a seeded node:sqlite database via the executor override hooks,
 * and the "after snoozing" scenario drives the REAL snooze flow
 * (snoozeThreadsWithRefresh), whose notify is what makes the section
 * reload — the exact interplay production uses.
 */

let executor: TestExecutor

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
  })
}

beforeEach(() => {
  resetStores()
  executor = createTestExecutor()
  setSnoozedSectionExecutor(executor)
  setAccountStoreExecutor(executor)
  setFolderCountsStoreExecutor(executor)
  setThreadListStoreExecutor(executor)
  setSidebarDataExecutor(executor)
})

afterEach(async () => {
  cleanup()
  setSnoozedSectionExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  setThreadListStoreExecutor(null)
  setSidebarDataExecutor(null)
  executor.close()
  resetStores()
})

/** One active account with one inbox thread — the snooze target. */
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
    subject: "Snooze target",
  })
  await createMessage(executor, {
    threadId,
    accountId,
    date: Math.floor(Date.now() / 1000) - 60,
    subject: "Snooze target",
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

describe("snoozed sidebar section (task 2.4)", () => {
  it("shows the thread with its wake-up time after the snooze flow runs", async () => {
    const { threadId } = await seedAccountWithThread()
    render(<SnoozedSection />)
    // Nothing snoozed → no section.
    expect(screen.queryByTestId("snoozed-section")).toBeNull()

    // The real snooze flow: service write + notify → the section reloads.
    const tomorrow = getSnoozePresets().presets.find(
      (preset) => preset.id === "tomorrow"
    )
    if (!tomorrow) throw new Error("tomorrow preset missing")
    await snoozeThreadsWithRefresh(
      executor,
      [threadId],
      tomorrow.until,
      tomorrow.label
    )

    expect(await screen.findByTestId("snoozed-section")).not.toBeNull()
    expect(screen.getByText("Snooze target")).not.toBeNull()
    // The wake-up time renders as formatted text, not a raw timestamp.
    expect(screen.getByText(formatSnoozedUntil(tomorrow.until))).not.toBeNull()
  })

  it("the row's cancel button unsnoozes the thread and the row disappears", async () => {
    const { threadId } = await seedAccountWithThread()
    const tomorrow = getSnoozePresets().presets.find(
      (preset) => preset.id === "tomorrow"
    )
    if (!tomorrow) throw new Error("tomorrow preset missing")
    await snoozeThreadsWithRefresh(
      executor,
      [threadId],
      tomorrow.until,
      tomorrow.label
    )
    render(<SnoozedSection />)
    expect(await screen.findByTestId("snoozed-section")).not.toBeNull()

    fireEvent.click(
      screen.getByRole("button", { name: "Cancel snooze for Snooze target" })
    )

    await waitFor(() =>
      expect(screen.queryByTestId("snoozed-section")).toBeNull()
    )
    const rows = await executor.select<{ snoozed_until: number | null }>(
      "SELECT snoozed_until FROM threads WHERE id = $1",
      [threadId]
    )
    expect(rows[0]?.snoozed_until).toBeNull()
  })

  it("renders inside the sidebar whenever the active account holds snoozed threads", async () => {
    const { threadId } = await seedAccountWithThread()
    const tomorrow = getSnoozePresets().presets.find(
      (preset) => preset.id === "tomorrow"
    )
    if (!tomorrow) throw new Error("tomorrow preset missing")
    // Snooze straight through the service (the section's mount load picks
    // the row up), then mount the section via the real sidebar.
    await snoozeThread(executor, threadId, tomorrow.until)

    render(
      <TooltipProvider delay={0}>
        <Sidebar isCollapsed={false} />
      </TooltipProvider>
    )

    const section = await screen.findByTestId("snoozed-section")
    expect(section.textContent).toContain("Snooze target")
    expect(section.textContent).toContain(formatSnoozedUntil(tomorrow.until))
  })
})
