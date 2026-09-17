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
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { recomputeThreadCaches, setThreadLabels } from "@/services/db/threads"
import * as threadActions from "@/services/email-actions/thread-actions"
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

/**
 * Unified inbox view tests (task 9.2, mail-organization spec "Unified
 * inbox"): two seeded accounts, the ui-store list scope set to "unified" —
 * rows from both accounts render in one list, each carrying its owning
 * account's badge; account-scoped actions resolve the ROW's account (spied
 * AND run for real against node:sqlite, whose pending_operations rows
 * prove the owning account); leaving through setView clears the override
 * and restores the plain per-account view.
 */

let executor: TestExecutor

function secondsAgo(seconds: number): number {
  return Math.floor(Date.now() / 1000) - seconds
}

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
  useFolderCountsStore.setState({
    accountId: null,
    counts: EMPTY_FOLDER_COUNTS,
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  uninstallResizeObserverMock()
  setThreadListStoreExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  executor.close()
  resetStores()
})

interface SeededAccount {
  accountId: string
  threadId: string
}

async function seedAccountWithInboxThread(options: {
  email: string
  subject: string
  seconds: number
  gmailMessageId: string
}): Promise<SeededAccount> {
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
    date: secondsAgo(options.seconds),
    subject: options.subject,
    fromName: options.subject,
    fromAddress: options.email,
    isRead: false,
    // The real actions enqueue queue-ops, which need provider identities.
    gmailMessageId: options.gmailMessageId,
  })
  await recomputeThreadCaches(executor, threadId)
  await setThreadLabels(executor, threadId, [inbox])
  return { accountId, threadId }
}

interface UnifiedMailbox {
  accountA: string
  threadA: string
  accountB: string
  threadB: string
}

/** Two active accounts, one unread inbox thread each; B is the newer. */
async function setupUnifiedMailbox(): Promise<UnifiedMailbox> {
  const alpha = await seedAccountWithInboxThread({
    email: "alpha@example.com",
    subject: "Alpha thread",
    seconds: 120,
    gmailMessageId: "g-unified-a",
  })
  const beta = await seedAccountWithInboxThread({
    email: "beta@example.com",
    subject: "Beta thread",
    seconds: 60,
    gmailMessageId: "g-unified-b",
  })
  useAccountStore.setState({
    accounts: [
      {
        id: alpha.accountId,
        type: "gmail",
        email: "alpha@example.com",
        displayName: null,
        status: "active",
        unreadCount: 1,
      },
      {
        id: beta.accountId,
        type: "gmail",
        email: "beta@example.com",
        displayName: "Beta Corp",
        status: "active",
        unreadCount: 1,
      },
    ],
    activeAccountId: alpha.accountId,
    loaded: true,
  })
  return {
    accountA: alpha.accountId,
    threadA: alpha.threadId,
    accountB: beta.accountId,
    threadB: beta.threadId,
  }
}

async function rowIds(container: HTMLElement): Promise<(string | null)[]> {
  return Array.from(container.querySelectorAll("[data-thread-row]")).map(
    (row) => row.getAttribute("data-thread-row")
  )
}

describe("unified inbox view (task 9.2)", () => {
  it("aggregates rows from both accounts with per-row account identity", async () => {
    const { accountA, accountB, threadA, threadB } = await setupUnifiedMailbox()
    const { container } = render(<ThreadList />)

    // Before the scope: the plain per-account view — one row, no badges.
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    expect(await rowIds(container)).toEqual([threadA])
    expect(container.querySelector("[data-account-badge]")).toBeNull()

    // Enter the unified scope (what the sidebar entry does).
    useUiStore.getState().setListScope({ kind: "unified" })

    await waitFor(() =>
      expect(container.querySelectorAll("[data-thread-row]")).toHaveLength(2)
    )
    // The 9.1 scope router resolved the unified descriptor…
    expect(useThreadListStore.getState().scope).toEqual({ kind: "unified" })
    // …and the list merged both accounts, still respecting the active
    // sort (date_desc): B (60s) precedes A (120s).
    expect(await rowIds(container)).toEqual([threadB, threadA])

    // Per-row identity: a badge per owning account, tooltip = the address.
    const badgeA = container.querySelector(`[data-account-badge="${accountA}"]`)
    const badgeB = container.querySelector(`[data-account-badge="${accountB}"]`)
    expect(badgeA?.getAttribute("title")).toBe("alpha@example.com")
    expect(badgeB?.getAttribute("title")).toBe("Beta Corp · beta@example.com")
    // Data-derived identity hue (no per-account color in the data model);
    // jsdom serializes the hsl() to rgb, like the label-dot tests.
    expect(badgeA?.getAttribute("style")).toContain("background-color")
    expect(badgeB?.getAttribute("style")).toContain("background-color")
  })

  it("shows the unified empty state, not the underlying folder's", async () => {
    // Two accounts, but no mail at all.
    const first = await createAccount(executor, "gmail")
    const second = await createAccount(executor, "gmail")
    useAccountStore.setState({
      accounts: [
        {
          id: first,
          type: "gmail",
          email: "alpha@example.com",
          displayName: null,
          status: "active",
          unreadCount: 0,
        },
        {
          id: second,
          type: "gmail",
          email: "beta@example.com",
          displayName: null,
          status: "active",
          unreadCount: 0,
        },
      ],
      activeAccountId: first,
      loaded: true,
    })
    useUiStore.getState().setListScope({ kind: "unified" })

    render(<ThreadList />)
    expect(await screen.findByText("Unified inbox is empty")).not.toBeNull()
  })

  it("a row action targets the row's owning account", async () => {
    const { accountA, accountB, threadB } = await setupUnifiedMailbox()
    useUiStore.getState().setListScope({ kind: "unified" })
    // Spy WITH call-through: the assertion sees the resolution, the real
    // local-first action still runs so the database proves the effect.
    const spy = vi.spyOn(threadActions, "setThreadStarred")
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelectorAll("[data-thread-row]")).toHaveLength(2)
    )

    // Star B's row while the ACTIVE account is A.
    const rowB = container.querySelector(`[data-thread-row="${threadB}"]`)
    const star = rowB?.querySelector('[aria-label="Not starred"]')
    expect(star).not.toBeNull()
    fireEvent.click(star as Element)

    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(
        expect.anything(),
        accountB,
        threadB,
        true
      )
    })
    expect(spy).not.toHaveBeenCalledWith(
      expect.anything(),
      accountA,
      expect.anything(),
      expect.anything()
    )

    // The real action ran for the owning account: caches flipped…
    const threads = await executor.select<{ is_starred: number }>(
      "SELECT is_starred FROM threads WHERE id = $1",
      [threadB]
    )
    expect(threads[0]?.is_starred).toBe(1)
    // …and the queue op was enqueued under the OWNING account only.
    const ops = await executor.select<{
      account_id: string
      op_type: string
    }>("SELECT account_id, op_type FROM pending_operations")
    expect(ops).toContainEqual({ account_id: accountB, op_type: "star" })
    expect(ops.filter((op) => op.account_id === accountA)).toHaveLength(0)
  })

  it("a mixed-account selection bulk action runs once per owning account", async () => {
    const { accountA, accountB, threadA, threadB } = await setupUnifiedMailbox()
    useUiStore.getState().setListScope({ kind: "unified" })
    const spy = vi.spyOn(threadActions, "bulkApply")
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelectorAll("[data-thread-row]")).toHaveLength(2)
    )

    // Select both rows (one per account), then archive from the bar.
    for (const id of [threadB, threadA]) {
      const row = container.querySelector(`[data-thread-row="${id}"]`)
      const wrap = row?.querySelector(`[data-thread-checkbox="${id}"]`)
      expect(wrap).not.toBeNull()
      fireEvent.click(wrap as Element)
    }
    expect(screen.getByTestId("thread-selection-bar")).not.toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Archive" }))

    // Grouped by row account: one bulkApply per account, never a crossed
    // (accountId, threadId) pair.
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2))
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      accountB,
      [threadB],
      "archive"
    )
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      accountA,
      [threadA],
      "archive"
    )
    const ops = await executor.select<{
      account_id: string
      op_type: string
    }>("SELECT account_id, op_type FROM pending_operations")
    expect(ops.filter((op) => op.op_type === "archive")).toEqual([
      { account_id: accountB, op_type: "archive" },
      { account_id: accountA, op_type: "archive" },
    ])
    // The consumed bulk action cleared the selection; both rows left.
    await waitFor(() =>
      expect(useThreadListStore.getState().selectedIds.size).toBe(0)
    )
  })

  it("leaving via setView clears the scope and restores the account view", async () => {
    const { threadA, threadB } = await setupUnifiedMailbox()
    useUiStore.getState().setListScope({ kind: "unified" })
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelectorAll("[data-thread-row]")).toHaveLength(2)
    )

    // Any explicit view selection (sidebar folder click) exits: setView
    // clears the list-scope override (ui-store contract from 9.1).
    useUiStore.getState().setView(DEFAULT_VIEW)

    await waitFor(() => expect(useUiStore.getState().listScope).toBeNull())
    await waitFor(() =>
      expect(container.querySelectorAll("[data-thread-row]")).toHaveLength(1)
    )
    expect(await rowIds(container)).toEqual([threadA])
    expect(container.querySelector(`[data-thread-row="${threadB}"]`)).toBeNull()
    // And the per-account view renders no badges again.
    expect(container.querySelector("[data-account-badge]")).toBeNull()
  })
})
