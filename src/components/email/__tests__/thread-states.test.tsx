import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { toast } from "sonner"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Thread-state entry points (task 3.3): context menu Mute/Pin/Done, the
 * row state indicators and the selection-bar bulk actions. Everything
 * runs REAL — mute/pin/done are local-only SQL writes, so the services
 * write through the same seeded node:sqlite database the stores read
 * (executor module mocked to hand out the test executor, store overrides
 * set alongside) and every assertion lands on the actual threads
 * muted_at/pinned_at/done_at columns. Only sonner is mocked, for the
 * toast assertions (same boundary as snooze.test.tsx).
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
import { setThreadNote } from "@/services/email-actions/notes"
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

let executor: TestExecutor
let accountId: string

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
    userLabels: [],
    loading: false,
    loaded: false,
    selectedIds: new Set<string>(),
    selectionAnchor: null,
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

/** One account + one INBOX thread per subject, newest first. */
async function seedInboxThreads(subjects: string[]): Promise<string[]> {
  accountId = await createAccount(executor, "gmail")
  const inbox = await createGmailLabel(
    executor,
    accountId,
    "INBOX",
    "INBOX",
    "inbox"
  )
  const ids: string[] = []
  for (const [index, subject] of subjects.entries()) {
    const threadId = await createThread(executor, accountId, { subject })
    await createMessage(executor, {
      threadId,
      accountId,
      date: Math.floor(Date.now() / 1000) - 60 - index * 60,
      subject,
      snippet: `${subject} body preview`,
      fromName: "Alice",
      fromAddress: "alice@example.com",
      isRead: false,
    })
    await recomputeThreadCaches(executor, threadId)
    await setThreadLabels(executor, threadId, [inbox])
    ids.push(threadId)
  }
  useAccountStore.setState({ activeAccountId: accountId, loaded: true })
  return ids
}

/** Also file every given thread under the Work user label, KEEPING the
 * INBOX membership (setThreadLabels replaces the whole set) — the label
 * view is where muted and done threads remain listed. */
async function labelThreadsAlsoWithWork(threadIds: string[]): Promise<string> {
  const work = await createGmailLabel(
    executor,
    accountId,
    "Work",
    "Label_work",
    undefined,
    "user"
  )
  const inbox = await executor
    .select<{ id: string }>(
      "SELECT id FROM labels WHERE account_id = $1 AND special_use = 'inbox'",
      [accountId]
    )
    .then((rows) => rows[0].id)
  for (const threadId of threadIds) {
    await setThreadLabels(executor, threadId, [inbox, work])
  }
  return work
}

interface StateColumns {
  muted_at: number | null
  pinned_at: number | null
  done_at: number | null
}

async function stateColumns(id: string): Promise<StateColumns> {
  const rows = await executor.select<StateColumns>(
    "SELECT muted_at, pinned_at, done_at FROM threads WHERE id = $1",
    [id]
  )
  return rows[0]
}

async function openContextMenu(row: Element): Promise<void> {
  fireEvent.contextMenu(row, { clientX: 8, clientY: 8 })
  await screen.findByTestId("thread-context-menu")
}

function rowFor(container: HTMLElement, id: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`[data-thread-row="${id}"]`)
  if (!row) throw new Error(`row for ${id} not mounted`)
  return row
}

describe("context menu state items (task 3.3)", () => {
  it("Mute writes muted_at for the acted-on thread and drops it from the inbox", async () => {
    const [mutedId, otherId] = await seedInboxThreads(["Alpha", "Bravo"])
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )

    await openContextMenu(rowFor(container, mutedId))
    fireEvent.click(screen.getByRole("menuitem", { name: "Mute" }))

    // The shared flow: one toast, then the refreshes.
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith("Muted"))
    expect((await stateColumns(mutedId)).muted_at).not.toBeNull()
    // Only the acted-on thread is muted.
    expect((await stateColumns(otherId)).muted_at).toBeNull()
    // The post-action list refresh drops the muted row from the inbox.
    await waitFor(() =>
      expect(
        container.querySelector(`[data-thread-row="${mutedId}"]`)
      ).toBeNull()
    )
    expect(
      container.querySelector(`[data-thread-row="${otherId}"]`)
    ).not.toBeNull()
  })

  it("Mark done writes done_at and drops the row from the inbox", async () => {
    const [doneId] = await seedInboxThreads(["Alpha", "Bravo"])
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )

    await openContextMenu(rowFor(container, doneId))
    fireEvent.click(screen.getByRole("menuitem", { name: "Mark done" }))

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Marked done")
    )
    expect((await stateColumns(doneId)).done_at).not.toBeNull()
    // The done row leaves the inbox; the untouched thread stays.
    await waitFor(() =>
      expect(
        container.querySelector(`[data-thread-row="${doneId}"]`)
      ).toBeNull()
    )
    expect(container.querySelector("[data-thread-row]")).not.toBeNull()
  })

  it("Pin writes pinned_at, keeps the row and pins it to the top", async () => {
    const ids = await seedInboxThreads(["Alpha", "Bravo", "Charlie"])
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )

    // Pin the OLDEST thread — the pinned-first ordering must lift it to
    // the top of the view.
    await openContextMenu(rowFor(container, ids[2]))
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin" }))

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Pinned")
    )
    expect((await stateColumns(ids[2])).pinned_at).not.toBeNull()
    await waitFor(() => {
      const firstRow = container.querySelector("[data-thread-row]")
      expect(firstRow?.getAttribute("data-thread-row")).toBe(ids[2])
    })
    // Pin is ordering-only: every row stays in the view.
    expect(container.querySelectorAll("[data-thread-row]").length).toBe(3)
  })

  it("labels flip with the state; Unmute re-enters the thread into the inbox", async () => {
    const ids = await seedInboxThreads(["Alpha", "Bravo"])
    const work = await labelThreadsAlsoWithWork(ids)
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )

    // Mute via the menu; the row leaves the inbox…
    await openContextMenu(rowFor(container, ids[0]))
    fireEvent.click(screen.getByRole("menuitem", { name: "Mute" }))
    await waitFor(() =>
      expect(
        container.querySelector(`[data-thread-row="${ids[0]}"]`)
      ).toBeNull()
    )

    // …but stays listed under its label, where the menu offers inverses.
    useUiStore.setState({
      view: { kind: "label", labelId: work, name: "Work" },
    })
    await waitFor(() =>
      expect(container.querySelectorAll("[data-thread-row]").length).toBe(2)
    )
    const mutedRow = rowFor(container, ids[0])
    expect(mutedRow.getAttribute("data-muted")).toBe("true")
    await openContextMenu(mutedRow)
    // The muted thread's menu flips Mute → Unmute; its other states are
    // inactive, so those entries stay positive.
    expect(screen.getByRole("menuitem", { name: "Unmute" })).not.toBeNull()
    expect(screen.queryByRole("menuitem", { name: "Mute" })).toBeNull()
    expect(screen.getByRole("menuitem", { name: "Pin" })).not.toBeNull()
    expect(screen.getByRole("menuitem", { name: "Mark done" })).not.toBeNull()
    fireEvent.click(screen.getByRole("menuitem", { name: "Unmute" }))

    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Unmuted")
    )
    expect((await stateColumns(ids[0])).muted_at).toBeNull()
    await waitFor(() =>
      expect(rowFor(container, ids[0]).getAttribute("data-muted")).toBe("false")
    )

    // The un-muted thread re-enters the inbox through the same refresh.
    useUiStore.setState({ view: DEFAULT_VIEW })
    await waitFor(() =>
      expect(
        container.querySelector(`[data-thread-row="${ids[0]}"]`)
      ).not.toBeNull()
    )
  })
})

describe("row state indicators (task 3.3)", () => {
  it("render for a muted/pinned/done thread and not otherwise", async () => {
    const ids = await seedInboxThreads(["Plain", "Muted", "Pinned", "Done"])
    const work = await labelThreadsAlsoWithWork(ids)
    const now = Math.floor(Date.now() / 1000)
    await executor.execute("UPDATE threads SET muted_at = $1 WHERE id = $2", [
      now,
      ids[1],
    ])
    await executor.execute("UPDATE threads SET pinned_at = $1 WHERE id = $2", [
      now,
      ids[2],
    ])
    await executor.execute("UPDATE threads SET done_at = $1 WHERE id = $2", [
      now,
      ids[3],
    ])

    // The inbox hides muted/done threads — the label view lists them all.
    // Pinned threads lead the sort.
    useUiStore.setState({
      view: { kind: "label", labelId: work, name: "Work" },
    })
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelectorAll("[data-thread-row]").length).toBe(4)
    )

    const plain = rowFor(container, ids[0])
    expect(plain.getAttribute("data-muted")).toBe("false")
    expect(plain.getAttribute("data-pinned")).toBe("false")
    expect(plain.getAttribute("data-done")).toBe("false")
    expect(plain.querySelector('[aria-label="Muted"]')).toBeNull()
    expect(plain.querySelector('[aria-label="Pinned"]')).toBeNull()
    expect(plain.querySelector('[aria-label="Done"]')).toBeNull()

    const muted = rowFor(container, ids[1])
    expect(muted.getAttribute("data-muted")).toBe("true")
    expect(muted.querySelector('[aria-label="Muted"]')).not.toBeNull()
    expect(muted.querySelector('[aria-label="Pinned"]')).toBeNull()
    expect(muted.querySelector('[aria-label="Done"]')).toBeNull()

    const pinned = rowFor(container, ids[2])
    expect(pinned.getAttribute("data-pinned")).toBe("true")
    expect(pinned.querySelector('[aria-label="Pinned"]')).not.toBeNull()
    expect(pinned.querySelector('[aria-label="Muted"]')).toBeNull()

    const done = rowFor(container, ids[3])
    expect(done.getAttribute("data-done")).toBe("true")
    expect(done.querySelector('[aria-label="Done"]')).not.toBeNull()
    expect(done.querySelector('[aria-label="Muted"]')).toBeNull()
  })
})

describe("row note indicator (task 15.1)", () => {
  it("renders for a thread with a stored note and not otherwise", async () => {
    const ids = await seedInboxThreads(["Plain", "Noted"])
    const work = await labelThreadsAlsoWithWork(ids)
    // Write the note through the real service, then view the rows in the
    // label view (the inbox would hide nothing here — note is not a
    // filter — but the label view keeps the assertion independent of the
    // inbox predicates).
    await setThreadNote(executor, ids[1], "Approved by legal")

    useUiStore.setState({
      view: { kind: "label", labelId: work, name: "Work" },
    })
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelectorAll("[data-thread-row]").length).toBe(2)
    )

    const plain = rowFor(container, ids[0])
    expect(plain.getAttribute("data-has-note")).toBe("false")
    expect(plain.querySelector('[aria-label="Has note"]')).toBeNull()

    const noted = rowFor(container, ids[1])
    expect(noted.getAttribute("data-has-note")).toBe("true")
    expect(noted.querySelector('[aria-label="Has note"]')).not.toBeNull()
  })
})

describe("selection-bar bulk state actions (task 3.3)", () => {
  it("Done applies to the whole selection, clears it and empties the inbox", async () => {
    const ids = await seedInboxThreads(["Alpha", "Bravo", "Charlie"])
    const { container } = render(<ThreadList />)
    await waitFor(() =>
      expect(container.querySelector("[data-thread-row]")).not.toBeNull()
    )
    const rows = container.querySelectorAll<HTMLElement>("[data-thread-row]")

    const checkboxWrap = (row: HTMLElement): HTMLElement => {
      const id = row.getAttribute("data-thread-row") ?? ""
      const wrap = row.querySelector<HTMLElement>(
        `[data-thread-checkbox="${id}"]`
      )
      if (!wrap) throw new Error(`checkbox for ${id} not found`)
      return wrap
    }
    fireEvent.click(checkboxWrap(rows[0]))
    fireEvent.click(checkboxWrap(rows[1]))
    expect(useThreadListStore.getState().selectedIds.size).toBe(2)

    fireEvent.click(screen.getByRole("button", { name: "Done" }))

    // One toast for the run; both selected threads done, the third not.
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Marked done")
    )
    expect((await stateColumns(ids[0])).done_at).not.toBeNull()
    expect((await stateColumns(ids[1])).done_at).not.toBeNull()
    expect((await stateColumns(ids[2])).done_at).toBeNull()
    // A consumed bulk action clears the selection; the done rows left
    // the inbox view with the bar (the untouched third stays).
    await waitFor(() => {
      expect(useThreadListStore.getState().selectedIds.size).toBe(0)
      expect(
        container.querySelector(`[data-thread-row="${ids[0]}"]`)
      ).toBeNull()
      expect(
        container.querySelector(`[data-thread-row="${ids[1]}"]`)
      ).toBeNull()
    })
    expect(
      container.querySelector(`[data-thread-row="${ids[2]}"]`)
    ).not.toBeNull()
  })
})
