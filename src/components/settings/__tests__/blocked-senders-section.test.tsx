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
 * Blocked senders settings section tests (task 18.2). Same
 * executor-injection pattern as the rules-section suite: the executor
 * module is mocked to hand every consumer the shared seeded node:sqlite
 * executor, the account store is seeded directly (the section scopes
 * itself to the ACTIVE account), and the unblock assertions read back
 * through the real CRUD. The toast is mocked (sonner renders nothing
 * under jsdom).
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

import { createAccount } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { blockSender, listBlockedSenders } from "@/services/db/blocked-senders"
import { useAccountStore } from "@/stores/account-store"
import { BlockedSendersSection } from "../blocked-senders-section"

let executor: TestExecutor
let accountId: string

function seedActiveAccount(): void {
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

beforeEach(async () => {
  executor = createTestExecutor()
  executorHolder.current = executor
  accountId = await createAccount(executor, "gmail")
  seedActiveAccount()
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
  vi.clearAllMocks()
})

describe("BlockedSendersSection", () => {
  it("shows the empty state when the account has no blocked senders", async () => {
    render(<BlockedSendersSection />)
    expect(await screen.findByText(/No blocked senders/)).toBeTruthy()
  })

  it("lists blocked senders with their action chips", async () => {
    await blockSender(executor, accountId, {
      sender: "spam@x.com",
      action: "trash",
    })
    await blockSender(executor, accountId, {
      sender: "news@lists.dev",
      action: "archive",
    })

    render(<BlockedSendersSection />)

    expect(await screen.findByText("spam@x.com")).toBeTruthy()
    expect(screen.getByText("news@lists.dev")).toBeTruthy()
    const rows = screen.getAllByTestId("blocked-sender-row")
    expect(rows).toHaveLength(2)
    // Action chips reflect the choice made at block time.
    expect(screen.getByText("Auto-trash")).toBeTruthy()
    expect(screen.getByText("Auto-archive")).toBeTruthy()
    // Alphabetical by address, like listBlockedSenders.
    expect(rows[0]!.textContent).toContain("news@lists.dev")
  })

  it("unblocking removes the row so future mail arrives normally", async () => {
    await blockSender(executor, accountId, {
      sender: "spam@x.com",
      action: "trash",
    })

    render(<BlockedSendersSection />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Unblock spam@x.com" })
    )

    await waitFor(async () => {
      expect(await listBlockedSenders(executor, accountId)).toEqual([])
    })
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Unblocked spam@x.com")
    })
    expect(screen.getByText(/No blocked senders/)).toBeTruthy()
  })

  it("shows the no-account state without an active account", async () => {
    useAccountStore.setState({ activeAccountId: null, loaded: true })
    render(<BlockedSendersSection />)
    expect(
      await screen.findByText(/Add an account to manage its blocked senders/)
    ).toBeTruthy()
  })
})
