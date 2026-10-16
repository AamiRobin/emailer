import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { installThreadSyncBridge } from "../thread-sync-bridge"
import { useAccountStore } from "@/stores/account-store"
import { useFolderCountsStore } from "@/stores/folder-counts-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"

/**
 * Cross-window thread sync (task 1.9, design D8). The bridge is the one
 * wire every pop-out interaction converges through: a remote
 * `thread-data-changed` event must refresh the list, the unread counts
 * and the folder badges, and remount the open reading pane when its
 * thread was touched — without remounting when the open thread was not
 * part of the event.
 */

type ChangeHandler = (event: { threadIds: string[] }) => void

let remoteHandler: ChangeHandler | null = null
const onRemoteThreadChangeMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/desktop/popout", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/desktop/popout")>()
  return {
    ...actual,
    // The bridge passes its handler straight through; the delegated call
    // keeps the real signature without restating it here.
    onRemoteThreadChange: ((handler: unknown) =>
      (
        onRemoteThreadChangeMock as unknown as (
          handler: unknown
        ) => Promise<() => void>
      )(handler)) as typeof actual.onRemoteThreadChange,
  }
})

const refreshThreadListMock = vi.hoisted(() => vi.fn(async () => {}))

vi.mock("@/stores/thread-list-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/thread-list-store")>()
  return {
    ...actual,
    refreshThreadList: refreshThreadListMock,
  }
})

beforeEach(() => {
  vi.clearAllMocks()
  remoteHandler = null
  onRemoteThreadChangeMock.mockImplementation(
    (handler: ChangeHandler) => {
      remoteHandler = handler
      return Promise.resolve(() => {
        remoteHandler = null
      })
    }
  )
  useUiStore.setState({
    view: DEFAULT_VIEW,
    activeThread: null,
  })
  useAccountStore.setState({
    accounts: [],
    activeAccountId: "acc1",
    loaded: true,
    refreshUnreadCounts: vi.fn(async () => {}),
  })
  useFolderCountsStore.setState({
    accountId: "acc1",
    refreshFolderCounts: vi.fn(async () => {}),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

function emitChange(threadIds: string[]): void {
  if (remoteHandler === null) {
    throw new Error("bridge never subscribed to remote thread changes")
  }
  remoteHandler({ threadIds })
}

describe("installThreadSyncBridge", () => {
  it("subscribes once on install and unsubscribes on teardown", async () => {
    const unsubscribe = installThreadSyncBridge()
    expect(onRemoteThreadChangeMock).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => expect(remoteHandler).not.toBeNull())

    unsubscribe()
    await vi.waitFor(() => expect(remoteHandler).toBeNull())
  })

  it("a remote change refreshes list, unread counts and folder badges", async () => {
    installThreadSyncBridge()
    await vi.waitFor(() => expect(remoteHandler).not.toBeNull())

    emitChange(["t1"])

    await vi.waitFor(() => expect(refreshThreadListMock).toHaveBeenCalled())
    await vi.waitFor(() =>
      expect(useAccountStore.getState().refreshUnreadCounts).toHaveBeenCalled()
    )
    await vi.waitFor(() =>
      expect(
        useFolderCountsStore.getState().refreshFolderCounts
      ).toHaveBeenCalled()
    )
  })

  it("remounts the open reading pane only when its thread was touched", async () => {
    useUiStore.setState({ activeThread: "t-open" })
    installThreadSyncBridge()
    await vi.waitFor(() => expect(remoteHandler).not.toBeNull())
    const revisionBefore = useUiStore.getState().activeThreadRevision

    emitChange(["t-other"])
    await vi.waitFor(() => expect(refreshThreadListMock).toHaveBeenCalled())
    expect(useUiStore.getState().activeThreadRevision).toBe(revisionBefore)

    emitChange(["t-open", "t-other"])
    await vi.waitFor(() =>
      expect(useUiStore.getState().activeThreadRevision).toBe(
        revisionBefore + 1
      )
    )
  })

  it("a failed list refresh does not kill the bridge for later events", async () => {
    refreshThreadListMock.mockRejectedValueOnce(new Error("db locked"))
    installThreadSyncBridge()
    await vi.waitFor(() => expect(remoteHandler).not.toBeNull())

    emitChange(["t1"])
    await vi.waitFor(() => expect(refreshThreadListMock).toHaveBeenCalled())

    emitChange(["t2"])
    await vi.waitFor(() => expect(refreshThreadListMock).toHaveBeenCalledTimes(2))
  })

  it("unsubscribing before the listen resolves leaves no live handler", async () => {
    // Hold the subscription promise open: the teardown must still win.
    let releaseSubscribe!: () => void
    onRemoteThreadChangeMock.mockImplementation(
      (handler: ChangeHandler) =>
        new Promise<() => void>((resolve) => {
          remoteHandler = handler
          releaseSubscribe = () => resolve(() => {
            remoteHandler = null
          })
        })
    )

    const unsubscribe = installThreadSyncBridge()
    unsubscribe()

    // Now the subscription resolves — the bridge must immediately off it.
    releaseSubscribe()
    await vi.waitFor(() => expect(remoteHandler).toBeNull())
  })
})
