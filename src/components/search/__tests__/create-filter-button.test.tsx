import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * "Create filter with this search" (mail-organization spec, Rules for
 * automatic actions): the affordance rides along with the query chip in
 * the search field, opens the shared rule dialog with the active query
 * prefilled as criteria, and saving writes a real rules row for the
 * ACTIVE account through the CRUD layer (read back through the same
 * executor). Toast mocked (sonner renders nothing under jsdom).
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

import { createAccount } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { listRules } from "@/services/rules"
import { useAccountStore } from "@/stores/account-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { SearchField } from "../search-field"

const QUERY = "from:news@x.com -subject:digest"

function resetUiStore(): void {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    previousView: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
  })
}

function seedActiveAccount(accountId: string): void {
  useAccountStore.setState({
    accounts: [
      {
        id: accountId,
        type: "gmail",
        email: `${accountId}@example.com`,
        displayName: null,
        status: "active",
        unreadCount: 0,
        lastSyncAt: null,
      },
    ],
    activeAccountId: accountId,
    loaded: true,
  })
}

let executor: TestExecutor
let accountId: string

beforeEach(async () => {
  executor = createTestExecutor()
  executorHolder.current = executor
  accountId = await createAccount(executor, "gmail")
  seedActiveAccount(accountId)
  resetUiStore()
})

afterEach(() => {
  cleanup()
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: true,
  })
  executorHolder.current = null
  executor.close()
  resetUiStore()
  vi.clearAllMocks()
})

describe("CreateFilterButton", () => {
  it("shows no affordance outside a search view", () => {
    render(<SearchField />)
    expect(screen.queryByTestId("create-filter-button")).toBeNull()
  })

  it("shows no affordance without an active account", async () => {
    useAccountStore.setState({ accounts: [], activeAccountId: null })
    useUiStore.getState().setView({ kind: "search", query: QUERY })
    render(<SearchField />)

    expect(await screen.findByTestId("search-query-chip")).toBeTruthy()
    expect(screen.queryByTestId("create-filter-button")).toBeNull()
  })

  it("opens the rule dialog with the active query prefilled", async () => {
    useUiStore.getState().setView({ kind: "search", query: QUERY })
    render(<SearchField />)

    fireEvent.click(await screen.findByTestId("create-filter-button"))
    const dialog = await screen.findByRole("dialog")
    expect(
      (screen.getByLabelText("When a message matches") as HTMLInputElement)
        .value
    ).toBe(QUERY)
    expect(dialog.textContent).toContain("Add Rule")
  })

  it("creates the rule for the active account through the CRUD layer", async () => {
    useUiStore.getState().setView({ kind: "search", query: QUERY })
    render(<SearchField />)

    fireEvent.click(await screen.findByTestId("create-filter-button"))
    await screen.findByRole("dialog")
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "File newsletters" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Create Rule" }))

    // Dialog closes on success and the toast confirms.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(toastMock.success).toHaveBeenCalledTimes(1)
    const rows = await listRules(executor, accountId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      name: "File newsletters",
      account_id: accountId,
      criteria_json: JSON.stringify({ query: QUERY }),
      actions_json: JSON.stringify([{ type: "archive" }]),
    })
  })
})
