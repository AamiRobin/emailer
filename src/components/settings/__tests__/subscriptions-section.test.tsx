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
 * Subscriptions settings section tests (task 3.6, design D13). Same
 * executor-injection pattern as the blocked-senders suite: the executor
 * module is mocked to hand every consumer the shared seeded node:sqlite
 * executor, the account store is seeded directly, and entries are seeded
 * through the REAL storage service. The bulk flow is mocked at the
 * service seam (subscription-bulk.bulkUnsubscribe) with an implementation
 * that performs the same transitions via the real storage functions, so
 * the per-sender results → toast + inline error rendering is exercised
 * end to end without a network POST. The toast is mocked (sonner renders
 * nothing under jsdom).
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

vi.mock("@/services/security/subscription-bulk", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/services/security/subscription-bulk")
    >()
  return { ...actual, bulkUnsubscribe: vi.fn() }
})

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
import { bulkUnsubscribe } from "@/services/security/subscription-bulk"
import type { BulkUnsubscribeResult } from "@/services/security/subscription-bulk"
import {
  listSubscriptions,
  markUnsubscribeFailed,
  markUnsubscribed,
  recordSenderSeen,
} from "@/services/settings/subscriptions"
import { useAccountStore } from "@/stores/account-store"
import { SubscriptionsSection } from "../subscriptions-section"

const bulkMock = vi.mocked(bulkUnsubscribe)

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

/** The section's bulk seam stand-in: real storage transitions per the
 * canned outcomes, so the reload reflects them like production. */
function stubBulk(
  outcomes: Record<string, { ok: boolean; error?: string; queued?: boolean }>
): void {
  bulkMock.mockImplementation(async (executorArg, accountIdArg, senders) => {
    const results: BulkUnsubscribeResult[] = []
    for (const sender of senders) {
      const outcome = outcomes[sender] ?? { ok: false, error: "unexpected" }
      if (outcome.ok) {
        await markUnsubscribed(executorArg, accountIdArg, sender)
        results.push({
          sender,
          ok: true,
          ...(outcome.queued ? { queued: true } : {}),
        })
      } else {
        const error = outcome.error ?? "the unsubscribe request failed"
        await markUnsubscribeFailed(executorArg, accountIdArg, sender, error)
        results.push({ sender, ok: false, error })
      }
    }
    return results
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

describe("SubscriptionsSection", () => {
  it("shows the detection empty state when the account has no entries", async () => {
    render(<SubscriptionsSection />)
    expect(
      await screen.findByText(/No subscriptions yet/)
    ).toBeTruthy()
    expect(screen.getByText(/detected automatically/i)).toBeTruthy()
  })

  it("lists entries with state badges, last-seen and per-entry actions", async () => {
    await recordSenderSeen(executor, accountId, {
      sender: "news@lists.dev",
      lastSeenAt: 1_700_000_000,
    })
    await recordSenderSeen(executor, accountId, {
      sender: "gone@lists.dev",
      lastSeenAt: 1_700_000_100,
    })
    await markUnsubscribed(executor, accountId, "gone@lists.dev", {
      at: 1_700_000_200,
    })
    await recordSenderSeen(executor, accountId, {
      sender: "resumed@lists.dev",
      lastSeenAt: 1_700_000_300,
    })
    await markUnsubscribed(executor, accountId, "resumed@lists.dev", {
      at: 1_700_000_400,
    })
    await recordSenderSeen(executor, accountId, {
      sender: "resumed@lists.dev",
      lastSeenAt: 1_700_000_500,
    })

    render(<SubscriptionsSection />)

    expect(await screen.findByText("news@lists.dev")).toBeTruthy()
    const rows = screen.getAllByTestId("subscription-row")
    expect(rows).toHaveLength(3)
    // The three spec states: still subscribed, unsubscribed, resumed.
    expect(
      screen.getAllByTestId("subscription-state-subscribed")
    ).toHaveLength(1)
    expect(
      screen.getAllByTestId("subscription-state-unsubscribed")
    ).toHaveLength(1)
    expect(screen.getAllByTestId("subscription-state-resumed")).toHaveLength(1)
    expect(screen.getByText("Still subscribed")).toBeTruthy()
    expect(screen.getByText("Unsubscribed")).toBeTruthy()
    expect(screen.getByText("Resumed")).toBeTruthy()
    for (const text of screen.getAllByText(/Last seen /)) {
      expect(text.textContent).toContain("Last seen")
    }

    // Per-entry actions: Unsubscribe for every non-unsubscribed row
    // (including resumed — the spec's "can be unsubscribed again"),
    // Remove for all; the unsubscribed row's checkbox is disabled.
    expect(
      screen.getByRole("button", { name: "Unsubscribe news@lists.dev" })
    ).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Unsubscribe resumed@lists.dev" })
    ).toBeTruthy()
    expect(
      screen.queryByRole("button", { name: "Unsubscribe gone@lists.dev" })
    ).toBeNull()
    expect(
      screen.getAllByRole("button", { name: /^Remove / })
    ).toHaveLength(3)
    const goneCheckbox = screen.getByRole("checkbox", {
      name: "Select gone@lists.dev",
    })
    // base-ui flags disabled checkboxes with aria-disabled (the control
    // stays focusable) rather than the native attribute.
    expect(goneCheckbox.getAttribute("aria-disabled")).toBe("true")
  })

  it("selects senders and bulk-unsubscribes them with per-sender results", async () => {
    await recordSenderSeen(executor, accountId, { sender: "a@x.com" })
    await recordSenderSeen(executor, accountId, { sender: "bad@x.com" })
    await recordSenderSeen(executor, accountId, { sender: "gone@x.com" })
    await markUnsubscribed(executor, accountId, "gone@x.com")
    stubBulk({
      "a@x.com": { ok: true },
      "bad@x.com": {
        ok: false,
        error: "the unsubscribe request failed with status 500",
      },
    })

    render(<SubscriptionsSection />)
    expect(await screen.findByText("a@x.com")).toBeTruthy()

    fireEvent.click(screen.getByRole("checkbox", { name: "Select a@x.com" }))
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select bad@x.com" })
    )
    expect(
      screen.getByRole("button", { name: /Unsubscribe selected \(2\)/ })
    ).toBeTruthy()

    fireEvent.click(
      screen.getByRole("button", { name: /Unsubscribe selected \(2\)/ })
    )

    expect(bulkMock).toHaveBeenCalledTimes(1)
    const [, , senders] = bulkMock.mock.calls[0]
    expect([...(senders ?? [])].sort()).toEqual(["a@x.com", "bad@x.com"])

    // Summary toast covers both outcomes; the failure also surfaces
    // inline on its row (the persisted lastError annotation).
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith("1 unsubscribed, 1 failed")
    })
    await waitFor(async () => {
      const [a] = await listSubscriptions(executor, accountId, "sender")
      expect(a?.sender).toBe("a@x.com")
      expect(a?.state).toBe("unsubscribed")
    })
    expect(
      await screen.findByTestId("subscription-row-error")
    ).toBeTruthy()
    expect(screen.getByTestId("subscription-row-error").textContent).toContain(
      "500"
    )
  })

  it("select-all selects only the unsubscribable rows", async () => {
    await recordSenderSeen(executor, accountId, { sender: "a@x.com" })
    await recordSenderSeen(executor, accountId, { sender: "b@x.com" })
    await recordSenderSeen(executor, accountId, { sender: "gone@x.com" })
    await markUnsubscribed(executor, accountId, "gone@x.com")

    render(<SubscriptionsSection />)
    expect(await screen.findByText("a@x.com")).toBeTruthy()

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all unsubscribable senders" })
    )
    expect(
      screen.getByRole("button", { name: "Unsubscribe selected (2)" })
    ).toBeTruthy()
  })

  it("per-entry Unsubscribe runs the same bulk seam for one sender", async () => {
    await recordSenderSeen(executor, accountId, { sender: "a@x.com" })
    stubBulk({ "a@x.com": { ok: true } })

    render(<SubscriptionsSection />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Unsubscribe a@x.com" })
    )

    expect(bulkMock).toHaveBeenCalledWith(
      executor,
      accountId,
      ["a@x.com"]
    )
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Unsubscribed a@x.com")
    })
    await waitFor(async () => {
      const [entry] = await listSubscriptions(executor, accountId)
      expect(entry?.state).toBe("unsubscribed")
    })
    expect(
      screen.queryByRole("button", { name: "Unsubscribe a@x.com" })
    ).toBeNull()
  })

  it("removing an entry drops it from the local list", async () => {
    await recordSenderSeen(executor, accountId, { sender: "a@x.com" })

    render(<SubscriptionsSection />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove a@x.com" })
    )

    await waitFor(async () => {
      expect(await listSubscriptions(executor, accountId)).toEqual([])
    })
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("Removed a@x.com")
    })
    expect(await screen.findByText(/No subscriptions yet/)).toBeTruthy()
  })

  it("shows the no-account state without an active account", async () => {
    useAccountStore.setState({ activeAccountId: null, loaded: true })
    render(<SubscriptionsSection />)
    expect(
      await screen.findByText(/Add an account to manage its subscriptions/)
    ).toBeTruthy()
  })
})
