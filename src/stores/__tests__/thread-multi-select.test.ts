import { afterEach, beforeEach, describe, expect, it } from "vitest"

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
import {
  clearThreadSelection,
  selectAllThreads,
  selectRangeTo,
  setThreadListStoreExecutor,
  toggleThreadSelection,
  useThreadListStore,
} from "../thread-list-store"
import { setAccountStoreExecutor, useAccountStore } from "../account-store"
import { DEFAULT_VIEW, useUiStore } from "../ui-store"
import type { ThreadRow } from "@/services/db/threads"

/**
 * Multi-selection store tests (task 10.3). Membership lives in
 * thread-list-store.selectedIds over the ordered rows; the shift-range
 * anchor is the index of the last plain click. The reading-pane cursor
 * (uiStore.activeThread) is deliberately untouched — the keyboard
 * shortcuts keep acting on it alone.
 */

function threadRow(id: string): ThreadRow {
  return {
    id,
    account_id: "acc1",
    subject: `Subject ${id}`,
    snippet: null,
    first_message_at: 1_700_000_000,
    last_message_at: 1_700_000_000,
    message_count: 1,
    unread_count: 1,
    has_attachments: 0,
    is_starred: 0,
    participants: null,
    gmail_thread_id: null,
    folder_label_id: null,
    is_archived: 0,
    is_trashed: 0,
    is_spam: 0,
    created_at: 1_700_000_000,
  }
}

function selected(): string[] {
  return [...useThreadListStore.getState().selectedIds].sort()
}

function anchor(): number | null {
  return useThreadListStore.getState().selectionAnchor
}

function setThreads(ids: string[]): void {
  useThreadListStore.setState({ threads: ids.map(threadRow) })
}

let executor: TestExecutor

beforeEach(() => {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    readingPane: "right",
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
    userLabels: [],
    loading: false,
    loaded: false,
    selectedIds: new Set<string>(),
    selectionAnchor: null,
  })
  setThreads(["t1", "t2", "t3", "t4"])
  useThreadListStore.setState({
    accountId: "acc1",
    view: DEFAULT_VIEW,
    loaded: true,
  })
  executor = createTestExecutor()
  setThreadListStoreExecutor(executor)
  setAccountStoreExecutor(executor)
})

afterEach(() => {
  setThreadListStoreExecutor(null)
  setAccountStoreExecutor(null)
  executor.close()
})

describe("toggleThreadSelection", () => {
  it("plain toggle adds and removes membership, moving the anchor", () => {
    toggleThreadSelection("t2")
    expect(selected()).toEqual(["t2"])
    expect(anchor()).toBe(1)

    toggleThreadSelection("t3")
    expect(selected()).toEqual(["t2", "t3"])
    expect(anchor()).toBe(2)

    toggleThreadSelection("t2")
    expect(selected()).toEqual(["t3"])
  })

  it("shift toggle range-selects from the anchor and keeps it", () => {
    toggleThreadSelection("t2") // anchor = 1
    toggleThreadSelection("t4", true) // range 1..3 joins
    expect(selected()).toEqual(["t2", "t3", "t4"])
    expect(anchor()).toBe(1)

    // Upward ranges work the same way; already-selected rows stay.
    toggleThreadSelection("t1", true)
    expect(selected()).toEqual(["t1", "t2", "t3", "t4"])
    expect(anchor()).toBe(1)
  })

  it("shift toggle without an anchor selects the single row", () => {
    toggleThreadSelection("t3", true)
    expect(selected()).toEqual(["t3"])
  })

  it("ignores ids that are not in the list", () => {
    toggleThreadSelection("absent")
    expect(selected()).toEqual([])
    expect(anchor()).toBeNull()
  })
})

describe("selectRangeTo", () => {
  it("adds the anchor→target run without moving the anchor", () => {
    toggleThreadSelection("t2") // anchor = 1
    selectRangeTo("t4")
    expect(selected()).toEqual(["t2", "t3", "t4"])
    expect(anchor()).toBe(1)

    // The shift-arrow seam keeps extending from the same anchor.
    selectRangeTo("t1")
    expect(selected()).toEqual(["t1", "t2", "t3", "t4"])
    expect(anchor()).toBe(1)
  })

  it("selects the single row when there is no anchor yet", () => {
    selectRangeTo("t3")
    expect(selected()).toEqual(["t3"])
    expect(anchor()).toBeNull()
  })
})

describe("selectAllThreads / clearThreadSelection", () => {
  it("select-all covers exactly the current rows; clear empties", () => {
    selectAllThreads()
    expect(selected()).toEqual(["t1", "t2", "t3", "t4"])
    clearThreadSelection()
    expect(selected()).toEqual([])
    expect(anchor()).toBeNull()
  })
})

describe("selection across refreshes", () => {
  async function seedInbox(): Promise<{ accountId: string; ids: string[] }> {
    const accountId = await createAccount(executor, "gmail")
    const inbox = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const ids: string[] = []
    for (const subject of ["one", "two", "three"]) {
      const threadId = await createThread(executor, accountId, { subject })
      await createMessage(executor, {
        threadId,
        accountId,
        date: Math.floor(Date.now() / 1000) - ids.length * 60,
        subject,
      })
      await recomputeThreadCaches(executor, threadId)
      await executor.execute(
        "INSERT INTO thread_labels (thread_id, label_id, account_id) VALUES ($1, $2, $3)",
        [threadId, inbox, accountId]
      )
      ids.push(threadId)
    }
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    return { accountId, ids }
  }

  it("clears the selection when the view changes", async () => {
    const { ids } = await seedInbox()
    await useThreadListStore.getState().refresh()
    toggleThreadSelection(ids[0])
    expect(selected()).toHaveLength(1)

    useUiStore.setState({
      view: {
        kind: "folder",
        folder: { kind: "specialUse", specialUse: "archive" },
      },
    })
    await useThreadListStore.getState().refresh()
    expect(selected()).toEqual([])
    expect(anchor()).toBeNull()
  })

  it("keeps the selection across a same-view refresh but prunes removed rows", async () => {
    const { ids } = await seedInbox()
    await useThreadListStore.getState().refresh()
    toggleThreadSelection(ids[0])
    toggleThreadSelection(ids[2])
    selectRangeTo(ids[1])
    expect(selected()).toHaveLength(3)

    // Simulate an action removing a row, then the post-action refresh.
    await executor.execute("DELETE FROM threads WHERE id = $1", [ids[1]])
    await useThreadListStore.getState().refresh()
    expect(selected()).toEqual([ids[0], ids[2]].sort())
  })

  it("drops the anchor when it falls off the refreshed list", async () => {
    const { ids } = await seedInbox()
    await useThreadListStore.getState().refresh()
    toggleThreadSelection(ids[2])
    expect(anchor()).toBe(2)

    await executor.execute("DELETE FROM threads WHERE id = $1", [ids[2]])
    await useThreadListStore.getState().refresh()
    expect(anchor()).toBeNull()
    expect(selected()).toEqual([])
  })
})
