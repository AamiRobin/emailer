import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import type { SqlExecutor } from "@/services/db/executor"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { getJunkFilterEnabled } from "@/services/settings/preferences"
import { useAccountStore } from "@/stores/account-store"
import { JunkFilterSection } from "../junk-filter-section"

/**
 * Junk filter settings section tests (task 18.10, design D19). Same
 * executor-injection pattern as the other settings suites: the executor
 * module is mocked to hand the section a seeded node:sqlite executor (the
 * REAL preferences module runs against it, so the per-account
 * mail.junkFilterEnabled:<accountId> round-trip is exercised for real),
 * and the account store is seeded directly.
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

let executor: TestExecutor

const imapAccountId = "acc-imap"
const gmailAccountId = "acc-gmail"

function seedActiveAccount(type: "imap" | "gmail"): void {
  useAccountStore.setState({
    accounts: [
      {
        id: type === "imap" ? imapAccountId : gmailAccountId,
        type,
        email: "one@example.com",
        displayName: null,
        status: "active",
        unreadCount: 0,
        lastSyncAt: null,
      },
    ],
    activeAccountId: type === "imap" ? imapAccountId : gmailAccountId,
    loaded: true,
  })
}

beforeEach(() => {
  executor = createTestExecutor()
  executorHolder.current = executor
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
})

describe("JunkFilterSection", () => {
  it("renders the off state for an imap account (the default)", async () => {
    seedActiveAccount("imap")
    render(<JunkFilterSection />)

    const toggle = await screen.findByRole("switch", {
      name: "Adaptively filter junk mail",
    })
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    })
    expect(await getJunkFilterEnabled(executor, imapAccountId)).toBe(false)
  })

  it("persists the toggle per account", async () => {
    seedActiveAccount("imap")
    render(<JunkFilterSection />)

    const toggle = await screen.findByRole("switch", {
      name: "Adaptively filter junk mail",
    })
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    })
    fireEvent.click(toggle)

    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true")
    })
    expect(await getJunkFilterEnabled(executor, imapAccountId)).toBe(true)

    // Off again — the write lands each time.
    fireEvent.click(toggle)
    await waitFor(async () => {
      expect(await getJunkFilterEnabled(executor, imapAccountId)).toBe(false)
    })
  })

  it("renders a persisted opt-in as on at load", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["mail.junkFilterEnabled:" + imapAccountId, JSON.stringify(true)]
    )
    seedActiveAccount("imap")
    render(<JunkFilterSection />)

    const toggle = await screen.findByRole("switch", {
      name: "Adaptively filter junk mail",
    })
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("true")
    })
  })

  it("disables the switch for gmail accounts (D19 exemption is visible)", async () => {
    seedActiveAccount("gmail")
    render(<JunkFilterSection />)

    const toggle = await screen.findByRole("switch", {
      name: "Adaptively filter junk mail",
    })
    await waitFor(() => {
      expect(toggle.getAttribute("aria-checked")).toBe("false")
    })
    expect(
      screen.getByText(/Gmail accounts are filtered by Google/)
    ).toBeTruthy()

    // The exemption is enforced, not just painted: a click cannot switch
    // a gmail account on.
    fireEvent.click(toggle)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(toggle.getAttribute("aria-checked")).toBe("false")
    expect(await getJunkFilterEnabled(executor, gmailAccountId)).toBe(false)
  })

  it("shows the no-account state", async () => {
    useAccountStore.setState({ activeAccountId: null, loaded: true })
    render(<JunkFilterSection />)

    expect(
      await screen.findByText(/Add an account to manage its junk filtering/)
    ).toBeTruthy()
    expect(
      screen.queryByRole("switch", { name: "Adaptively filter junk mail" })
    ).toBeNull()
  })
})
