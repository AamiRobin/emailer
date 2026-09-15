import { beforeEach, describe, expect, it } from "vitest"

import {
  moveThreadSelection,
  selectNeighboringThread,
  useThreadListStore,
} from "../thread-list-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import type { ThreadRow } from "@/services/db/threads"

/**
 * The additive keyboard-selection helpers (task 6.6): selection lives in
 * uiStore.activeThread over the thread-list store's ordered rows.
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

function activeThread(): string | null {
  return useUiStore.getState().activeThread
}

beforeEach(() => {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    readingPane: "right",
  })
  useThreadListStore.setState({
    accountId: "acc1",
    view: DEFAULT_VIEW,
    threads: ["t1", "t2", "t3"].map(threadRow),
    labelsByThreadId: {},
    loading: false,
    loaded: true,
  })
})

describe("moveThreadSelection", () => {
  it("selects the first row when nothing is selected yet", () => {
    moveThreadSelection(1)
    expect(activeThread()).toBe("t1")
    moveThreadSelection(0)
    expect(activeThread()).toBe("t1")
  })

  it("moves by delta and clamps to both bounds", () => {
    moveThreadSelection(1) // t1
    moveThreadSelection(1) // t2
    moveThreadSelection(1) // t3
    moveThreadSelection(1) // clamp → t3
    expect(activeThread()).toBe("t3")
    moveThreadSelection(-5) // clamp → t1
    expect(activeThread()).toBe("t1")
  })

  it("is a no-op on an empty list", () => {
    useThreadListStore.setState({ threads: [] })
    moveThreadSelection(1)
    expect(activeThread()).toBeNull()
  })
})

describe("selectNeighboringThread", () => {
  it("selects the row after the removed one", () => {
    moveThreadSelection(1) // t1
    selectNeighboringThread("t1")
    expect(activeThread()).toBe("t2")
  })

  it("falls back to the previous row when removing the last one", () => {
    moveThreadSelection(1)
    moveThreadSelection(1)
    moveThreadSelection(1) // t3
    selectNeighboringThread("t3")
    expect(activeThread()).toBe("t2")
  })

  it("clears the selection when the last row is removed", () => {
    useThreadListStore.setState({ threads: [threadRow("only")] })
    moveThreadSelection(1)
    selectNeighboringThread("only")
    expect(activeThread()).toBeNull()
  })

  it("is a no-op for a thread that is not in the list", () => {
    moveThreadSelection(1) // t1
    selectNeighboringThread("absent")
    expect(activeThread()).toBe("t1")
  })
})
