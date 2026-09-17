import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"

import { createAccount, createThread } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { addTodo } from "@/services/db/todos"
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
import { addThreadToTodos, setTodosSectionExecutor } from "../use-todos"
import { TodosSection } from "../todos-section"
import { Sidebar } from "../sidebar"

/**
 * Todos sidebar section (task 15.2). The section runs its real queries
 * against a seeded node:sqlite database via the executor override hooks,
 * and the flows (add/complete/remove/move/open) run through the REAL
 * use-todos seam — the notify is what makes the section reload, the exact
 * interplay production uses (the snoozed-section.test.tsx harness).
 *
 * The cross-account scenario is the point: TWO accounts seed todos, and
 * one section lists them all with each row carrying its owning account's
 * badge (task 9.2's AccountBadge reused).
 */

let executor: TestExecutor
let accountA: string
let accountB: string

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
  setTodosSectionExecutor(executor)
  setAccountStoreExecutor(executor)
  setFolderCountsStoreExecutor(executor)
  setThreadListStoreExecutor(executor)
  setSidebarDataExecutor(executor)
})

afterEach(async () => {
  cleanup()
  setTodosSectionExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  setThreadListStoreExecutor(null)
  setSidebarDataExecutor(null)
  executor.close()
  resetStores()
})

/** Two accounts with one thread each; thread B is on the second account —
 * the section must aggregate them regardless of the active account. */
async function seedTwoAccountTodos(): Promise<{
  threadA: string
  threadB: string
}> {
  accountA = await createAccount(executor, "gmail")
  accountB = await createAccount(executor, "imap")
  const threadA = await createThread(executor, accountA, {
    subject: "Reply to Ada",
  })
  const threadB = await createThread(executor, accountB, {
    subject: "File the report",
  })
  useAccountStore.setState({
    accounts: [accountInfo(accountA), accountInfo(accountB)],
    activeAccountId: accountA,
    loaded: true,
  })
  return { threadA, threadB }
}

describe("todos sidebar section (task 15.2)", () => {
  it("is hidden without pending todos and appears after the add flow notifies", async () => {
    await seedTwoAccountTodos()
    render(<TodosSection />)
    expect(screen.queryByTestId("todos-section")).toBeNull()

    const threadA = await createThread(executor, accountA, { subject: "New" })
    await addThreadToTodos(accountA, threadA)

    expect(await screen.findByTestId("todos-section")).not.toBeNull()
    expect(screen.getByText("New")).not.toBeNull()
  })

  it("lists pending todos across TWO accounts with per-row account badges", async () => {
    const { threadA, threadB } = await seedTwoAccountTodos()
    await addTodo(executor, accountA, threadA)
    await addTodo(executor, accountB, threadB)

    render(<TodosSection />)

    const section = await screen.findByTestId("todos-section")
    const rows = within(section).getAllByTestId("todo-row")
    expect(rows).toHaveLength(2)
    // One cross-account list in insertion order…
    expect(within(rows[0]).getByText("Reply to Ada")).not.toBeNull()
    expect(within(rows[1]).getByText("File the report")).not.toBeNull()
    // …with each row carrying its OWNING account's badge (task 9.2).
    expect(
      rows[0].querySelector(`[data-account-badge="${accountA}"]`)
    ).not.toBeNull()
    expect(
      rows[1].querySelector(`[data-account-badge="${accountB}"]`)
    ).not.toBeNull()
  })

  it("the check button completes the todo — the thread itself is untouched", async () => {
    const { threadA } = await seedTwoAccountTodos()
    await addTodo(executor, accountA, threadA)
    render(<TodosSection />)
    await screen.findByTestId("todos-section")

    fireEvent.click(
      screen.getByRole("button", { name: "Complete todo Reply to Ada" })
    )

    await waitFor(() =>
      expect(screen.queryByTestId("todos-section")).toBeNull()
    )
    const rows = await executor.select<{
      completed_at: number | null
    }>("SELECT completed_at FROM todos")
    expect(rows[0]?.completed_at).toBeGreaterThan(0)
    const thread = await executor.select<{ done_at: number | null }>(
      "SELECT done_at FROM threads WHERE id = $1",
      [threadA]
    )
    // Plain completion deliberately does NOT mark the thread done.
    expect(thread[0]?.done_at).toBeNull()
  })

  it("the row menu completes with the optional done-marking", async () => {
    const { threadB } = await seedTwoAccountTodos()
    await addTodo(executor, accountB, threadB)
    render(<TodosSection />)
    await screen.findByTestId("todos-section")

    fireEvent.click(
      screen.getByRole("button", { name: "More actions for File the report" })
    )
    fireEvent.click(
      await screen.findByRole("menuitem", {
        name: "Complete and mark thread done",
      })
    )

    await waitFor(() =>
      expect(screen.queryByTestId("todos-section")).toBeNull()
    )
    const rows = await executor.select<{ completed_at: number | null }>(
      "SELECT completed_at FROM todos"
    )
    expect(rows[0]?.completed_at).toBeGreaterThan(0)
    const thread = await executor.select<{ done_at: number | null }>(
      "SELECT done_at FROM threads WHERE id = $1",
      [threadB]
    )
    expect(thread[0]?.done_at).toBeGreaterThan(0)
  })

  it("the X button removes the todo and keeps the thread", async () => {
    const { threadA } = await seedTwoAccountTodos()
    await addTodo(executor, accountA, threadA)
    render(<TodosSection />)
    await screen.findByTestId("todos-section")

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Reply to Ada from Todos" })
    )

    await waitFor(() =>
      expect(screen.queryByTestId("todos-section")).toBeNull()
    )
    expect(await executor.select("SELECT id FROM todos")).toHaveLength(0)
    const thread = await executor.select(
      "SELECT id FROM threads WHERE id = $1",
      [threadA]
    )
    expect(thread).toHaveLength(1)
  })

  it("the reorder arrows swap rows within the list", async () => {
    const { threadA, threadB } = await seedTwoAccountTodos()
    await addTodo(executor, accountA, threadA)
    await addTodo(executor, accountB, threadB)
    render(<TodosSection />)
    const section = await screen.findByTestId("todos-section")
    const subjects = () =>
      within(section)
        .getAllByTestId("todo-row")
        .map((row) => row.textContent)
    expect(subjects()[0]).toContain("Reply to Ada")

    fireEvent.click(
      screen.getByRole("button", { name: "Move File the report up" })
    )

    await waitFor(() => expect(subjects()[0]).toContain("File the report"))
    expect(subjects()[1]).toContain("Reply to Ada")
  })

  it("clicking a row opens the thread in the reading pane (no account switch)", async () => {
    const { threadB } = await seedTwoAccountTodos()
    await addTodo(executor, accountB, threadB)
    render(<TodosSection />)
    const section = await screen.findByTestId("todos-section")

    // The cross-account todo belongs to accountB while accountA is active;
    // opening is one ui-store write — the reading pane resolves the
    // owning account itself (task 9.2 semantics).
    fireEvent.click(within(section).getByText("File the report"))

    expect(useUiStore.getState().activeThread).toBe(threadB)
    expect(useAccountStore.getState().activeAccountId).toBe(accountA)
  })

  it("renders inside the sidebar whenever pending todos exist", async () => {
    const { threadA } = await seedTwoAccountTodos()
    await addTodo(executor, accountA, threadA)

    render(
      <TooltipProvider delay={0}>
        <Sidebar isCollapsed={false} />
      </TooltipProvider>
    )

    const section = await screen.findByTestId("todos-section")
    expect(section.textContent).toContain("Reply to Ada")
    // Hidden when the rail is collapsed (yields to the icon rail, like
    // the Snoozed/Saved Searches sections).
    cleanup()
    render(
      <TooltipProvider delay={0}>
        <Sidebar isCollapsed={true} />
      </TooltipProvider>
    )
    expect(screen.queryByTestId("todos-section")).toBeNull()
  })
})
