import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { ReactNode } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import { DndContext, PointerSensor, useSensor, useSensors } from "@dnd-kit/core"

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
import {
  setThreadListStoreExecutor,
  useThreadListStore,
} from "@/stores/thread-list-store"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import {
  installResizeObserverMock,
  setMockViewportHeight,
  uninstallResizeObserverMock,
} from "./resize-observer-mock"
import { ThreadList } from "../thread-list"

/**
 * Thread rows as drag sources inside the shell's DndContext (task 10.5).
 * jsdom cannot drive dnd-kit's pointer sensors, so these tests pin the
 * interaction contract around the drag handle instead: with the exact
 * sensor config mail-shell mounts (PointerSensor, distance 8), rows keep
 * their button semantics plus the draggable affordance, and plain
 * clicks, shift-click ranges and the context menu all still work — the
 * click-vs-drag resolution the task requires verified.
 */

/** The shell's sensor config (mirrors mail-shell.tsx). */
function DndShell({ children }: { children: ReactNode }) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  )
  return <DndContext sensors={sensors}>{children}</DndContext>
}

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
  installResizeObserverMock()
  setMockViewportHeight(10_000)
  executor = createTestExecutor()
  setThreadListStoreExecutor(executor)
  setAccountStoreExecutor(executor)
})

afterEach(() => {
  cleanup()
  uninstallResizeObserverMock()
  setThreadListStoreExecutor(null)
  setAccountStoreExecutor(null)
  executor.close()
  resetStores()
})

async function seedMailbox(): Promise<void> {
  const accountId = await createAccount(executor, "gmail")
  const inbox = await createGmailLabel(
    executor,
    accountId,
    "INBOX",
    "INBOX",
    "inbox"
  )
  for (const [index, subject] of ["Alpha", "Bravo", "Charlie"].entries()) {
    const threadId = await createThread(executor, accountId, { subject })
    await createMessage(executor, {
      threadId,
      accountId,
      date: Math.floor(Date.now() / 1000) - 60 * (index + 1),
      subject,
      isRead: true,
    })
    await recomputeThreadCaches(executor, threadId)
    await setThreadLabels(executor, threadId, [inbox])
  }
  useAccountStore.setState({ activeAccountId: accountId, loaded: true })
}

async function renderList() {
  await seedMailbox()
  const { container } = render(
    <DndShell>
      <ThreadList />
    </DndShell>
  )
  await waitFor(() =>
    expect(container.querySelector("[data-thread-row]")).not.toBeNull()
  )
  return container
}

describe("thread rows as drag sources (task 10.5)", () => {
  it("marks rows draggable without losing button semantics", async () => {
    const container = await renderList()
    const row = container.querySelector<HTMLElement>("[data-thread-row]")
    if (!row) throw new Error("row not mounted")
    // dnd-kit's drag affordance…
    expect(row.getAttribute("aria-roledescription")).toBe("draggable")
    expect(row.getAttribute("data-dragging")).toBe("false")
    // …on top of the unchanged row semantics.
    expect(row.getAttribute("role")).toBe("button")
    expect(row.getAttribute("tabindex")).toBe("0")
  })

  it("a plain click still opens the thread (no drag interference)", async () => {
    const container = await renderList()
    const rows = container.querySelectorAll<HTMLElement>("[data-thread-row]")
    fireEvent.click(rows[1])
    expect(useUiStore.getState().activeThread).toBe(
      rows[1].getAttribute("data-thread-row")
    )
  })

  it("shift-click still range-selects without opening a thread", async () => {
    const container = await renderList()
    const rows = container.querySelectorAll<HTMLElement>("[data-thread-row]")
    fireEvent.click(rows[0])
    fireEvent.click(rows[2], { shiftKey: true })
    const selected = useThreadListStore.getState().selectedIds
    expect(selected.size).toBe(3)
    expect(useUiStore.getState().activeThread).toBe(
      rows[0].getAttribute("data-thread-row")
    )
  })

  it("the context menu still opens on a right-click", async () => {
    const container = await renderList()
    const row = container.querySelector<HTMLElement>("[data-thread-row]")
    if (!row) throw new Error("row not mounted")
    fireEvent.contextMenu(row, { clientX: 8, clientY: 8 })
    await waitFor(() =>
      expect(screen.queryByRole("menu", { hidden: true })).not.toBeNull()
    )
  })
})
