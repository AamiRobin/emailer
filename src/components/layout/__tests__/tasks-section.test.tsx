import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"

import { createThread } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { createTask } from "@/services/tasks/service"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  setAccountStoreExecutor,
  useAccountStore,
  type AccountInfo,
} from "@/stores/account-store"
import { setFolderCountsStoreExecutor } from "@/stores/folder-counts-store"
import { setThreadListStoreExecutor } from "@/stores/thread-list-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { setSidebarDataExecutor } from "../use-sidebar-data"
import { setTasksSectionExecutor } from "../use-tasks"
import { TasksSection } from "../tasks-section"
import { Sidebar } from "../sidebar"

/**
 * Tasks sidebar section (task 5.7, tasks spec "Tasks sidebar and views").
 * The section runs its real queries against a seeded node:sqlite database
 * via the executor override hook, and the flows (complete) run through
 * the REAL use-tasks seam — the notify is what re-queries the lists, the
 * exact interplay production uses (the todos-section.test.tsx harness).
 *
 * The cross-account scenario is the point of the list: the tasks table is
 * account-independent, so tasks created against TWO different accounts'
 * threads land in one section. Overdue/today windows are seeded relative
 * to the real clock (the service derives isOverdue from Date.now()).
 */

let executor: TestExecutor

const DAY = 86400

function now(): number {
  return Math.floor(Date.now() / 1000)
}

/** 22:00 TODAY local — always inside the current calendar day. */
function dueToday(): number {
  const base = new Date()
  return Math.floor(
    new Date(
      base.getFullYear(),
      base.getMonth(),
      base.getDate(),
      22,
      0,
      0
    ).getTime() / 1000
  )
}

function accountInfo(id: string): AccountInfo {
  return {
    id,
    type: "gmail",
    email: `${id}@example.com`,
    displayName: null,
    status: "active",
    unreadCount: 0,
  }
}

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
  setTasksSectionExecutor(executor)
  setAccountStoreExecutor(executor)
  setFolderCountsStoreExecutor(executor)
  setThreadListStoreExecutor(executor)
  setSidebarDataExecutor(executor)
})

afterEach(async () => {
  cleanup()
  setTasksSectionExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  setThreadListStoreExecutor(null)
  setSidebarDataExecutor(null)
  executor.close()
  resetStores()
})

async function createAccountId(
  type: "gmail" | "imap"
): Promise<string> {
  const id = `acc-${Math.random().toString(36).slice(2)}`
  await executor.execute(
    "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
    [id, type, `${id}@example.com`]
  )
  return id
}

/** Force created_at for deterministic creation-order assertions. */
async function forceCreatedAt(
  taskId: string,
  value: number
): Promise<void> {
  await executor.execute("UPDATE tasks SET created_at = $1 WHERE id = $2", [
    value,
    taskId,
  ])
}

function rowIds(): Array<string | null> {
  return screen
    .getAllByTestId("task-row")
    .map((row) => row.getAttribute("data-task-id"))
}

describe("tasks sidebar section (task 5.7)", () => {
  it("lists open tasks across accounts by due date with overdue flagged and due-less last", async () => {
    const accountA = await createAccountId("gmail")
    const accountB = await createAccountId("imap")
    const threadA = await createThread(executor, accountA, {
      subject: "from A",
    })
    const threadB = await createThread(executor, accountB, {
      subject: "from B",
    })
    const overdue = await createTask(executor, {
      title: "Overdue report",
      dueAt: now() - DAY,
      sourceThreadId: threadA,
      sourceAccountId: accountA,
    })
    const future = await createTask(executor, {
      title: "Future chore",
      dueAt: now() + 7 * DAY,
      sourceThreadId: threadB,
      sourceAccountId: accountB,
    })
    const dueless = await createTask(executor, { title: "Someday maybe" })

    render(<TasksSection />)

    const section = await screen.findByTestId("tasks-section")
    const rows = within(section).getAllByTestId("task-row")
    expect(rows).toHaveLength(3)
    // Due ascending, due-less last.
    expect(rowIds()).toEqual([overdue.id, future.id, dueless.id])
    // The overdue row carries the destructive visual state.
    expect(rows[0].getAttribute("data-overdue")).toBe("true")
    expect(
      within(rows[0]).getByTestId("task-due").textContent
    ).toContain("Overdue")
    expect(rows[1].getAttribute("data-overdue")).toBe("false")
    // Tasks from BOTH accounts list together (the service is
    // account-agnostic); the source links render for converted tasks.
    expect(
      within(rows[0]).getByTestId("task-source-link")
    ).not.toBeNull()
    expect(
      within(rows[2]).queryByTestId("task-source-link")
    ).toBeNull()
  })

  it("the header toggle switches to creation order", async () => {
    const laterDue = await createTask(executor, {
      title: "Created first, due later",
      dueAt: now() + 2 * DAY,
    })
    const soonerDue = await createTask(executor, {
      title: "Created second, due sooner",
      dueAt: now() + DAY,
    })
    await forceCreatedAt(laterDue.id, 1_000)
    await forceCreatedAt(soonerDue.id, 2_000)

    render(<TasksSection />)
    await screen.findByTestId("tasks-section")
    // Default sort (due): the sooner due date first…
    expect(rowIds()).toEqual([soonerDue.id, laterDue.id])

    fireEvent.click(screen.getByTestId("tasks-sort-toggle"))

    // …creation order puts the older row first.
    await waitFor(() =>
      expect(rowIds()).toEqual([laterDue.id, soonerDue.id])
    )
    expect(
      screen
        .getByTestId("tasks-sort-toggle")
        .getAttribute("aria-label")
    ).toBe("Sorted by creation order — switch to due date")
  })

  it("the Today & overdue toggle narrows the list in one action and counts the entry point", async () => {
    const overdue = await createTask(executor, {
      title: "Overdue report",
      dueAt: now() - DAY,
    })
    const today = await createTask(executor, {
      title: "Due tonight",
      dueAt: dueToday(),
    })
    await createTask(executor, {
      title: "Future chore",
      dueAt: now() + 7 * DAY,
    })
    await createTask(executor, { title: "Someday maybe" })

    render(<TasksSection />)
    await screen.findByTestId("tasks-section")
    expect(screen.getAllByTestId("task-row")).toHaveLength(4)
    // The entry point pill counts today's + overdue tasks.
    expect(screen.getByTestId("tasks-today-toggle").textContent).toContain("2")

    fireEvent.click(screen.getByTestId("tasks-today-toggle"))

    const remaining = screen.getAllByTestId("task-row")
    expect(remaining).toHaveLength(2)
    const ids = remaining.map((row) => row.getAttribute("data-task-id"))
    expect(ids).toContain(overdue.id)
    expect(ids).toContain(today.id)
    expect(
      (screen.getByTestId("tasks-today-toggle") as HTMLButtonElement)
        .ariaPressed
    ).toBe("true")
  })

  it("the Today & overdue toggle shows its empty state when nothing is due", async () => {
    await createTask(executor, {
      title: "Future chore",
      dueAt: now() + 7 * DAY,
    })
    render(<TasksSection />)
    await screen.findByTestId("tasks-section")

    fireEvent.click(screen.getByTestId("tasks-today-toggle"))

    expect(await screen.findByTestId("tasks-empty")).not.toBeNull()
    expect(screen.getByTestId("tasks-empty").textContent).toBe(
      "Nothing due today"
    )
    expect(screen.queryByTestId("task-row")).toBeNull()
  })

  it("completing hides the row optimistically and grows the completed view", async () => {
    const task = await createTask(executor, {
      title: "File the report",
      dueAt: now() + DAY,
    })
    render(<TasksSection />)
    await screen.findByTestId("tasks-section")

    fireEvent.click(screen.getByTestId("task-complete"))

    // The row leaves the open list (optimistic), the empty state shows…
    await waitFor(() =>
      expect(screen.queryByTestId("task-row")).toBeNull()
    )
    expect(screen.getByTestId("tasks-empty").textContent).toBe(
      "No open tasks"
    )
    // …and the write landed in the tasks table.
    await waitFor(async () => {
      const rows = await executor.select<{ completed_at: number | null }>(
        "SELECT completed_at FROM tasks WHERE id = $1",
        [task.id]
      )
      expect(rows[0]?.completed_at ?? 0).toBeGreaterThan(0)
    })
    // The completed disclosure grows and lists the instance with its
    // completion date.
    fireEvent.click(screen.getByTestId("tasks-completed-toggle"))
    const completedRow = screen.getByTestId("task-completed-row")
    expect(completedRow.getAttribute("data-task-id")).toBe(task.id)
    expect(completedRow.textContent).toContain("File the report")
  })

  it("the source link jumps to the source thread through the ui-store seam", async () => {
    const accountA = await createAccountId("gmail")
    const threadId = await createThread(executor, accountA, {
      subject: "Source thread",
    })
    await createTask(executor, {
      title: "Follow up",
      sourceThreadId: threadId,
      sourceMessageId: "msg-1",
      sourceAccountId: accountA,
    })
    // The user is on a full-pane page: the jump must first restore the
    // mailbox view (previousView), then open the thread (the
    // openAttachmentSourceMessage sequence).
    useUiStore.setState({ view: { kind: "settings" }, previousView: DEFAULT_VIEW })

    render(<TasksSection />)
    const section = await screen.findByTestId("tasks-section")

    fireEvent.click(within(section).getByTestId("task-source-link"))

    expect(useUiStore.getState().activeThread).toBe(threadId)
    expect(useUiStore.getState().view).toEqual(DEFAULT_VIEW)
  })
})

describe("tasks section inside the sidebar (task 5.7)", () => {
  it("renders with an empty state when expanded and yields to the icon rail", async () => {
    const accountA = await createAccountId("gmail")
    useAccountStore.setState({
      accounts: [accountInfo(accountA)],
      activeAccountId: accountA,
      loaded: true,
    })
    render(
      <TooltipProvider delay={0}>
        <Sidebar isCollapsed={false} />
      </TooltipProvider>
    )
    // No tasks yet — the section is still the task manager's home.
    const section = await screen.findByTestId("tasks-section")
    expect(screen.getByTestId("tasks-empty").textContent).toBe("No open tasks")
    expect(section.querySelectorAll('[data-testid="task-row"]')).toHaveLength(0)

    // With a task seeded before the mount, the row lists.
    cleanup()
    await createTask(executor, { title: "Sweep the porch" })
    render(
      <TooltipProvider delay={0}>
        <Sidebar isCollapsed={false} />
      </TooltipProvider>
    )
    expect(await screen.findByText("Sweep the porch")).not.toBeNull()

    // The collapsed rail yields the section entirely (like Todos/Snoozed).
    cleanup()
    render(
      <TooltipProvider delay={0}>
        <Sidebar isCollapsed={true} />
      </TooltipProvider>
    )
    expect(screen.queryByTestId("tasks-section")).toBeNull()
  })

  it("lists seeded tasks inside the sidebar", async () => {
    const accountA = await createAccountId("gmail")
    useAccountStore.setState({
      accounts: [accountInfo(accountA)],
      activeAccountId: accountA,
      loaded: true,
    })
    await createTask(executor, {
      title: "Inside the sidebar",
      dueAt: dueToday(),
    })
    render(
      <TooltipProvider delay={0}>
        <Sidebar isCollapsed={false} />
      </TooltipProvider>
    )
    const section = await screen.findByTestId("tasks-section")
    expect(section.textContent).toContain("Inside the sidebar")
  })
})
