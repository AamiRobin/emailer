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
  listOperationsByStatus,
  type PendingOperationRow,
} from "@/services/db/pending-operations"
import {
  operationFromRow,
  type QueueOperation,
} from "@/services/queue/operation"
import { recomputeThreadCaches, setThreadLabels } from "@/services/db/threads"
import { trashThread } from "@/services/email-actions/thread-actions"
import {
  setThreadListStoreExecutor,
  useThreadListStore,
} from "@/stores/thread-list-store"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import { useComposerStore } from "@/stores/composer-store"
import {
  setFolderCountsStoreExecutor,
  useFolderCountsStore,
} from "@/stores/folder-counts-store"
import { EMPTY_FOLDER_COUNTS } from "@/services/db/folder-counts"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import {
  installResizeObserverMock,
  setMockViewportHeight,
  uninstallResizeObserverMock,
} from "./resize-observer-mock"
import { ThreadList } from "../thread-list"

/**
 * Multi-select + context menu render tests (tasks 10.2/10.3). The
 * ResizeObserver mock gives the virtualizer a viewport; a real
 * node:sqlite executor backs every action so the queued pending_operations
 * rows double as the "same effect as the toolbar/keyboard" proof.
 */

let executor: TestExecutor

function secondsAgo(seconds: number): number {
  return Math.floor(Date.now() / 1000) - seconds
}

async function enqueuedOps(accountId: string): Promise<QueueOperation[]> {
  const rows: PendingOperationRow[] = await listOperationsByStatus(
    executor,
    "pending",
    accountId
  )
  return rows.map(operationFromRow)
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
  useFolderCountsStore.setState({
    accountId: null,
    counts: EMPTY_FOLDER_COUNTS,
  })
  useThreadListStore.setState({
    accountId: null,
    view: null,
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
})

afterEach(() => {
  cleanup()
  uninstallResizeObserverMock()
  setThreadListStoreExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  executor.close()
})

const SUBJECTS = ["Alpha", "Bravo", "Charlie", "Delta", "Echo"]

async function seedMailbox(): Promise<string> {
  const accountId = await createAccount(executor, "gmail")
  const inbox = await createGmailLabel(
    executor,
    accountId,
    "INBOX",
    "INBOX",
    "inbox"
  )
  // Trash role: gmail trashing adds this label's row to the membership.
  await createGmailLabel(executor, accountId, "TRASH", "TRASH", "trash")
  for (const [index, subject] of SUBJECTS.entries()) {
    const threadId = await createThread(executor, accountId, { subject })
    await createMessage(executor, {
      threadId,
      accountId,
      date: secondsAgo(60 + index * 60),
      subject,
      isRead: false,
      // gmail accounts need a provider identity for the queue-op refs.
      gmailMessageId: String(9000 + index),
    })
    await recomputeThreadCaches(executor, threadId)
    await setThreadLabels(executor, threadId, [inbox])
  }
  useAccountStore.setState({ activeAccountId: accountId, loaded: true })
  return accountId
}

function checkboxWrap(row: HTMLElement): HTMLElement {
  const id = row.getAttribute("data-thread-row")
  const wrap = row.querySelector<HTMLElement>(`[data-thread-checkbox="${id}"]`)
  if (!wrap) throw new Error(`checkbox for ${id} not found`)
  return wrap
}

async function openContextMenu(row: HTMLElement): Promise<void> {
  fireEvent.contextMenu(row, { clientX: 8, clientY: 8 })
  await waitFor(() =>
    expect(screen.queryByRole("menu", { hidden: true })).not.toBeNull()
  )
}

describe("multi-select checkboxes (task 10.3)", () => {
  it("checkbox toggles membership without opening the thread", async () => {
    await seedMailbox()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    const rows = container.querySelectorAll<HTMLElement>("[data-thread-row]")

    fireEvent.click(checkboxWrap(rows[0]))
    const firstId = rows[0].getAttribute("data-thread-row") ?? ""
    expect(useThreadListStore.getState().selectedIds.has(firstId)).toBe(true)
    expect(rows[0].getAttribute("data-selected")).toBe("true")
    // A checkbox click never moves the reading-pane cursor.
    expect(useUiStore.getState().activeThread).toBeNull()
    // The selection bar appeared.
    expect(screen.getByTestId("thread-selection-bar")).not.toBeNull()

    fireEvent.click(checkboxWrap(rows[0]))
    expect(useThreadListStore.getState().selectedIds.size).toBe(0)
    expect(rows[0].getAttribute("data-selected")).toBe("false")
  })

  it("shift-click on checkboxes range-selects from the anchor", async () => {
    await seedMailbox()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    const rows = container.querySelectorAll<HTMLElement>("[data-thread-row]")
    const idsAt = (index: number): string => {
      const id = rows[index].getAttribute("data-thread-row")
      if (id === null) throw new Error(`row ${index} has no id`)
      return id
    }

    fireEvent.click(checkboxWrap(rows[1])) // anchor
    fireEvent.click(checkboxWrap(rows[3]), { shiftKey: true })

    const selected = useThreadListStore.getState().selectedIds
    expect(selected.size).toBe(3)
    expect(selected.has(idsAt(1))).toBe(true)
    expect(selected.has(idsAt(2))).toBe(true)
    expect(selected.has(idsAt(3))).toBe(true)
    // Opening never happened.
    expect(useUiStore.getState().activeThread).toBeNull()
  })

  it("shift-click on a row range-selects without opening the thread", async () => {
    await seedMailbox()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    const rows = container.querySelectorAll<HTMLElement>("[data-thread-row]")
    const idsAt = (index: number): string => {
      const id = rows[index].getAttribute("data-thread-row")
      if (id === null) throw new Error(`row ${index} has no id`)
      return id
    }

    // Plain click opens AND anchors; shift-click extends from the anchor.
    fireEvent.click(rows[0])
    expect(useUiStore.getState().activeThread).toBe(idsAt(0))
    fireEvent.click(rows[2], { shiftKey: true })
    expect(useUiStore.getState().activeThread).toBe(idsAt(0))

    const selected = useThreadListStore.getState().selectedIds
    expect(selected.size).toBe(3)
    expect(selected.has(idsAt(0))).toBe(true)
    expect(selected.has(idsAt(1))).toBe(true)
    expect(selected.has(idsAt(2))).toBe(true)
  })
})

describe("selection bar bulk actions (task 10.3)", () => {
  it("select-all then Archive runs bulkApply for every id and clears", async () => {
    const accountId = await seedMailbox()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    const rows = container.querySelectorAll<HTMLElement>("[data-thread-row]")

    // One checkbox reveals the bar; its select-all control takes it to 5.
    fireEvent.click(checkboxWrap(rows[0]))
    fireEvent.click(screen.getByRole("checkbox", { name: "Select all" }))
    expect(useThreadListStore.getState().selectedIds.size).toBe(5)

    fireEvent.click(screen.getByRole("button", { name: "Archive" }))

    await waitFor(() => {
      expect(useThreadListStore.getState().selectedIds.size).toBe(0)
    })
    const ops = await enqueuedOps(accountId)
    expect(ops.map((op) => op.kind)).toEqual([
      "archive",
      "archive",
      "archive",
      "archive",
      "archive",
    ])
    // The archived rows left the inbox view, and the bar with them.
    await waitFor(() =>
      expect(screen.queryByTestId("thread-selection-bar")).toBeNull()
    )
  })

  it("Mark read applies read to the whole selection", async () => {
    const accountId = await seedMailbox()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    const rows = container.querySelectorAll<HTMLElement>("[data-thread-row]")
    fireEvent.click(checkboxWrap(rows[1]))
    fireEvent.click(checkboxWrap(rows[3]), { shiftKey: true }) // 3 rows

    fireEvent.click(screen.getByRole("button", { name: "Mark read" }))

    await waitFor(async () => {
      const ops = await enqueuedOps(accountId)
      expect(ops.map((op) => op.kind)).toEqual([
        "mark_read",
        "mark_read",
        "mark_read",
      ])
    })
    // A consumed bulk action clears the selection even though the rows
    // stayed in the view.
    await waitFor(() => {
      expect(useThreadListStore.getState().selectedIds.size).toBe(0)
    })
    expect(screen.queryByTestId("thread-selection-bar")).toBeNull()
  })
})

describe("thread context menu (task 10.2)", () => {
  it("offers the toolbar-parity items; delete forever only in Trash", async () => {
    await seedMailbox()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    const rows = container.querySelectorAll<HTMLElement>("[data-thread-row]")

    await openContextMenu(rows[0])
    expect(screen.getByRole("menuitem", { name: "Open" })).not.toBeNull()
    expect(screen.getByRole("menuitem", { name: "Reply" })).not.toBeNull()
    expect(screen.getByRole("menuitem", { name: "Archive" })).not.toBeNull()
    expect(screen.getByRole("menuitem", { name: "Trash" })).not.toBeNull()
    // Unread row → "Mark read"; the star flips the label too.
    expect(screen.getByRole("menuitem", { name: "Mark read" })).not.toBeNull()
    expect(screen.getByRole("menuitem", { name: "Star" })).not.toBeNull()
    expect(
      screen.queryByRole("menuitem", { name: "Delete forever" })
    ).toBeNull()
  })

  it("Trash queues a trash op exactly like the keyboard binding", async () => {
    const accountId = await seedMailbox()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    const rows = container.querySelectorAll<HTMLElement>("[data-thread-row]")
    const targetId = rows[0].getAttribute("data-thread-row")

    await openContextMenu(rows[0])
    fireEvent.click(screen.getByRole("menuitem", { name: "Trash" }))

    await waitFor(async () => {
      const ops = await enqueuedOps(accountId)
      expect(ops.map((op) => op.kind)).toEqual(["trash"])
    })
    // Local-first: the label membership flipped before the queue op
    // (gmail trash = the TRASH-role label row joins the thread).
    const memberships = await executor.select<{ label_id: string }>(
      "SELECT label_id FROM thread_labels WHERE thread_id = $1",
      [targetId]
    )
    const trash = await executor.select<{ id: string }>(
      "SELECT id FROM labels WHERE special_use = 'trash'"
    )
    expect(memberships.map((row) => row.label_id)).toContain(trash[0].id)
  })

  it("Open sets the active thread; Reply emits the callback", async () => {
    await seedMailbox()
    const replies: string[] = []
    const { container } = render(
      <ThreadList onReply={(threadId) => replies.push(threadId)} />
    )
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    const rows = container.querySelectorAll<HTMLElement>("[data-thread-row]")

    await openContextMenu(rows[1])
    fireEvent.click(screen.getByRole("menuitem", { name: "Reply" }))
    expect(replies).toEqual([rows[1].getAttribute("data-thread-row")])

    await openContextMenu(rows[1])
    fireEvent.click(screen.getByRole("menuitem", { name: "Open" }))
    expect(useUiStore.getState().activeThread).toBe(
      rows[1].getAttribute("data-thread-row")
    )
  })

  it("Reply runs the shared prefill path when no onReply prop is passed", async () => {
    await seedMailbox()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    const rows = container.querySelectorAll<HTMLElement>("[data-thread-row]")
    const targetId = rows[0].getAttribute("data-thread-row")

    await openContextMenu(rows[0])
    fireEvent.click(screen.getByRole("menuitem", { name: "Reply" }))

    // End-to-end through the real reply-opener against the seeded db
    // (executor via the thread-list store's seam): the composer store is
    // prefilled as a reply and the shell overlay flag flips.
    await waitFor(() => expect(useComposerStore.getState().open).toBe(true))
    const composer = useComposerStore.getState()
    expect(composer.mode).toMatchObject({
      kind: "reply",
      replyAll: false,
      sourceThreadId: targetId,
    })
    expect(composer.subject).toContain("Re:")
    expect(useUiStore.getState().composerOpen).toBe(true)
  })

  it("Delete forever appears in Trash and removes the thread", async () => {
    const accountId = await seedMailbox()
    useUiStore.setState({
      view: {
        kind: "folder",
        folder: { kind: "specialUse", specialUse: "trash" },
      },
    })
    const { container } = render(<ThreadList />)
    // Nothing in Trash yet.
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).toBeNull()
    )

    // Trash one thread through the service, then re-enter the view.
    const rows = await executor.select<{ id: string }>(
      "SELECT id FROM threads ORDER BY last_message_at DESC"
    )
    await trashThread(executor, accountId, rows[0].id)
    await useThreadListStore.getState().refresh()
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    const trashedRow = container.querySelector<HTMLElement>("[data-thread-row]")
    if (!trashedRow) throw new Error("trashed row not mounted")
    expect(trashedRow.getAttribute("data-thread-row")).toBe(rows[0].id)

    await openContextMenu(trashedRow)
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete forever" }))

    await waitFor(async () => {
      const ops = await enqueuedOps(accountId)
      expect(ops.map((op) => op.kind)).toEqual(["trash", "delete_forever"])
    })
    const remaining = await executor.select(
      "SELECT id FROM threads WHERE id = $1",
      [rows[0].id]
    )
    expect(remaining).toEqual([])
  })

  it("acts on the whole selection when the right-clicked row is selected", async () => {
    const accountId = await seedMailbox()
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    const rows = container.querySelectorAll<HTMLElement>("[data-thread-row]")
    fireEvent.click(checkboxWrap(rows[0]))
    fireEvent.click(checkboxWrap(rows[1]))

    await openContextMenu(rows[0])
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark read" }))

    await waitFor(async () => {
      const ops = await enqueuedOps(accountId)
      expect(ops.map((op) => op.kind)).toEqual(["mark_read", "mark_read"])
    })
  })

  it("labels submenu reflects membership and toggling queues the op", async () => {
    const accountId = await seedMailbox()
    const inbox = await executor
      .select<{ id: string }>(
        "SELECT id FROM labels WHERE special_use = 'inbox'"
      )
      .then((rows) => rows[0].id)
    const work = await createGmailLabel(
      executor,
      accountId,
      "Work",
      "Label_work",
      undefined,
      "user"
    )
    const personal = await createGmailLabel(
      executor,
      accountId,
      "Personal",
      "Label_personal",
      undefined,
      "user"
    )
    const threadRow = await executor.select<{ id: string }>(
      "SELECT id FROM threads ORDER BY last_message_at DESC LIMIT 1"
    )
    // Keep the inbox membership so the thread stays in the inbox view.
    await setThreadLabels(executor, threadRow[0].id, [inbox, work])

    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    const rows = container.querySelectorAll<HTMLElement>("[data-thread-row]")
    const target = Array.from(rows).find(
      (row) => row.getAttribute("data-thread-row") === threadRow[0].id
    )
    if (!target) throw new Error("labeled thread not mounted")

    await openContextMenu(target)
    fireEvent.click(screen.getByRole("menuitem", { name: "Labels" }))
    const workItem = await screen.findByRole("menuitemcheckbox", {
      name: "Work",
    })
    const personalItem = screen.getByRole("menuitemcheckbox", {
      name: "Personal",
    })
    expect(workItem.getAttribute("aria-checked")).toBe("true")
    expect(personalItem.getAttribute("aria-checked")).toBe("false")

    // Toggle Personal on: queues add_labels with the PROVIDER label id.
    fireEvent.click(personalItem)
    await waitFor(async () => {
      const ops = await enqueuedOps(accountId)
      expect(ops).toHaveLength(1)
      const [op] = ops
      if (op.kind !== "add_labels") {
        throw new Error(`expected add_labels, got ${op.kind}`)
      }
      expect(op.labelIds).toEqual(["Label_personal"])
    })
    const memberships = await executor.select<{ label_id: string }>(
      "SELECT label_id FROM thread_labels WHERE thread_id = $1",
      [threadRow[0].id]
    )
    expect(memberships.map((row) => row.label_id).sort()).toEqual(
      [inbox, work, personal].sort()
    )
  })
})
