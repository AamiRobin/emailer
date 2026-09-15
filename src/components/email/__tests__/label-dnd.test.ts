import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { DragEndEvent, UniqueIdentifier } from "@dnd-kit/core"

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
import { applyLabelsToThread } from "@/services/email-actions/thread-actions"
import type { SqlExecutor } from "@/services/db/executor"
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
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { applyDroppedLabels, dragPayloadFor } from "../label-dnd"

/**
 * Label drag-and-drop logic (task 10.5, mail-organization spec "Drag a
 * thread onto a label"): the pure pieces jsdom can drive without a real
 * drag — payload construction (Gmail whole-selection semantics) and the
 * onDragEnd dispatch (per-thread apply, ONE refresh after the batch) —
 * plus a DB-backed run of the production deps shape proving the drop
 * queues add_labels and the store refresh loads the chips.
 */

// ---- Pure: dragPayloadFor ----

describe("dragPayloadFor", () => {
  it("carries the whole selection when the dragged row is in it", () => {
    const payload = dragPayloadFor("t2", ["t1", "t2", "t3"])
    expect(payload).toEqual({ threadIds: ["t1", "t2", "t3"] })
  })

  it("carries the row alone when it is outside the selection", () => {
    const payload = dragPayloadFor("t9", ["t1", "t2"])
    expect(payload).toEqual({ threadIds: ["t9"] })
  })

  it("carries the row alone with no selection active", () => {
    expect(dragPayloadFor("t1", [])).toEqual({ threadIds: ["t1"] })
  })

  it("copies the selection so later mutation cannot leak into the drag", () => {
    const selection = ["t1", "t2"]
    const payload = dragPayloadFor("t1", selection)
    selection.push("t3")
    expect(payload.threadIds).toEqual(["t1", "t2"])
  })
})

// ---- Pure: applyDroppedLabels with injected services ----

interface DepsCalls {
  log: string[]
  errors: unknown[]
}

function mockDeps(accountId: string | null, calls: DepsCalls) {
  return {
    getAccountId: () => accountId,
    getExecutor: () => ({}) as SqlExecutor,
    applyLabels: async (
      _executor: SqlExecutor,
      _accountId: string,
      threadId: string,
      labelIds: string[],
      add: boolean
    ) => {
      calls.log.push(`apply:${threadId}:${labelIds.join(",")}:${add}`)
    },
    refresh: async () => {
      calls.log.push("refresh")
    },
    onError: (error: unknown) => {
      calls.errors.push(error)
    },
  }
}

function dragEndEvent(
  payload: unknown,
  overId: UniqueIdentifier | null
): DragEndEvent {
  return {
    active: { id: "t1", data: { current: payload } },
    over: overId === null ? null : { id: overId },
  } as unknown as DragEndEvent
}

describe("applyDroppedLabels", () => {
  it("applies the label to every carried thread, then refreshes once", async () => {
    const calls: DepsCalls = { log: [], errors: [] }
    await applyDroppedLabels(
      dragEndEvent({ threadIds: ["t1", "t2", "t3"] }, "label-1"),
      mockDeps("acct-1", calls)
    )
    expect(calls.log).toEqual([
      "apply:t1:label-1:true",
      "apply:t2:label-1:true",
      "apply:t3:label-1:true",
      "refresh",
    ])
    expect(calls.errors).toEqual([])
  })

  it("ignores a drop that missed every target", async () => {
    const calls: DepsCalls = { log: [], errors: [] }
    await applyDroppedLabels(
      dragEndEvent({ threadIds: ["t1"] }, null),
      mockDeps("acct-1", calls)
    )
    expect(calls.log).toEqual([])
  })

  it("ignores a drop on a non-string target id", async () => {
    const calls: DepsCalls = { log: [], errors: [] }
    await applyDroppedLabels(
      dragEndEvent({ threadIds: ["t1"] }, 42),
      mockDeps("acct-1", calls)
    )
    expect(calls.log).toEqual([])
  })

  it("ignores a drag without a payload (foreign source)", async () => {
    const calls: DepsCalls = { log: [], errors: [] }
    await applyDroppedLabels(
      dragEndEvent(undefined, "label-1"),
      mockDeps("acct-1", calls)
    )
    expect(calls.log).toEqual([])
  })

  it("ignores a payload without usable thread ids", async () => {
    const calls: DepsCalls = { log: [], errors: [] }
    await applyDroppedLabels(
      dragEndEvent({ threadIds: "not-an-array" }, "label-1"),
      mockDeps("acct-1", calls)
    )
    await applyDroppedLabels(
      dragEndEvent({ threadIds: [7, null] }, "label-1"),
      mockDeps("acct-1", calls)
    )
    expect(calls.log).toEqual([])
  })

  it("ignores a drop when no account is active", async () => {
    const calls: DepsCalls = { log: [], errors: [] }
    await applyDroppedLabels(
      dragEndEvent({ threadIds: ["t1"] }, "label-1"),
      mockDeps(null, calls)
    )
    expect(calls.log).toEqual([])
  })

  it("isolates a per-thread failure: the rest still apply, refresh still runs", async () => {
    const calls: DepsCalls = { log: [], errors: [] }
    const deps = mockDeps("acct-1", calls)
    const original = deps.applyLabels
    deps.applyLabels = async (executor, accountId, threadId, labelIds, add) => {
      if (threadId === "t2") throw new Error("boom")
      await original(executor, accountId, threadId, labelIds, add)
    }
    await applyDroppedLabels(
      dragEndEvent({ threadIds: ["t1", "t2", "t3"] }, "label-1"),
      deps
    )
    expect(calls.log).toEqual([
      "apply:t1:label-1:true",
      "apply:t3:label-1:true",
      "refresh",
    ])
    expect(calls.errors).toEqual([new Error("boom")])
  })
})

// ---- Integration: the production deps shape against a seeded mailbox ----

/**
 * Runs the real thread-actions applyLabelsToThread through the same deps
 * label-dnd builds for the shell (only `refresh` is wrapped to count and
 * delegate to refreshThreadList), then asserts the spec scenario: the
 * threads gain the label (chip source in the store) and the server change
 * is queued.
 */
describe("applyDroppedLabels on a seeded gmail mailbox", () => {
  let executor: TestExecutor

  function resetStores(): void {
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
    useFolderCountsStore.setState({
      accountId: null,
      counts: EMPTY_FOLDER_COUNTS,
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
  }

  beforeEach(() => {
    resetStores()
    executor = createTestExecutor()
    setThreadListStoreExecutor(executor)
    setAccountStoreExecutor(executor)
    setFolderCountsStoreExecutor(executor)
  })

  afterEach(() => {
    setThreadListStoreExecutor(null)
    setAccountStoreExecutor(null)
    setFolderCountsStoreExecutor(null)
    executor.close()
    resetStores()
  })

  async function seedMailbox(): Promise<{
    accountId: string
    threadIds: string[]
  }> {
    const accountId = await createAccount(executor, "gmail")
    const inbox = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const threadIds: string[] = []
    for (const [index, subject] of ["Alpha", "Bravo"].entries()) {
      const threadId = await createThread(executor, accountId, { subject })
      await createMessage(executor, {
        threadId,
        accountId,
        date: Math.floor(Date.now() / 1000) - 60 * (index + 1),
        subject,
        isRead: false,
        // gmail accounts need a provider identity for the queue-op refs.
        gmailMessageId: String(7000 + index),
      })
      await recomputeThreadCaches(executor, threadId)
      await setThreadLabels(executor, threadId, [inbox])
      threadIds.push(threadId)
    }
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    return { accountId, threadIds }
  }

  async function enqueuedOps(accountId: string): Promise<QueueOperation[]> {
    const rows: PendingOperationRow[] = await listOperationsByStatus(
      executor,
      "pending",
      accountId
    )
    return rows.map(operationFromRow)
  }

  it("adds the label locally, queues add_labels per thread, refreshes once", async () => {
    const { accountId, threadIds } = await seedMailbox()
    const work = await createGmailLabel(
      executor,
      accountId,
      "Work",
      "Label_work",
      undefined,
      "user"
    )
    await useThreadListStore.getState().refresh()

    let refreshes = 0
    await applyDroppedLabels(dragEndEvent({ threadIds }, work), {
      getAccountId: () => useAccountStore.getState().activeAccountId,
      getExecutor: () => executor,
      applyLabels: (exec, acct, threadId, labelIds, add) =>
        applyLabelsToThread(exec, acct, threadId, labelIds, add),
      refresh: async () => {
        refreshes += 1
        await useThreadListStore.getState().refresh()
      },
      onError: (error) => {
        throw error
      },
    })

    expect(refreshes).toBe(1)

    // The label chip source: the store's labelsByThreadId now carries the
    // Work label for both threads.
    const chips = useThreadListStore.getState().labelsByThreadId
    for (const threadId of threadIds) {
      expect(chips[threadId]?.some((chip) => chip.id === work)).toBe(true)
    }

    // The server change is queued: one add_labels per thread with the
    // PROVIDER label id.
    const ops = await enqueuedOps(accountId)
    expect(ops.map((op) => op.kind)).toEqual(["add_labels", "add_labels"])
    expect(
      ops.every(
        (op) => op.kind !== "add_labels" || op.labelIds.join() === "Label_work"
      )
    ).toBe(true)
  })
})
