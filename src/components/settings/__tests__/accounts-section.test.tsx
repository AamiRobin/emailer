import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { within } from "@testing-library/dom"

/**
 * Accounts settings section — the per-row meeting-reminder lead pick
 * (parity-round-3 task 8.5, design D5). The db service is mocked at its
 * two write boundaries; the store is seeded with one account row so the
 * suite exercises exactly the row control's own behavior: persisting the
 * picked lead, the Off choice persisting null, and no write when the
 * value is unchanged.
 */

const accountsHolder = vi.hoisted(() => ({
  updateHistoryWindow: vi.fn(),
  setAccountReminderLeadMinutes: vi.fn(),
}))

vi.mock("@/services/db/accounts", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/services/db/accounts")
  >()
  return {
    ...actual,
    updateHistoryWindow: accountsHolder.updateHistoryWindow,
    setAccountReminderLeadMinutes:
      accountsHolder.setAccountReminderLeadMinutes,
  }
})

vi.mock("@/services/queue/operation", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/services/queue/operation")
  >()
  return {
    ...actual,
    enqueueHistoryBackfill: vi.fn(),
  }
})

// Handlers pass an executor placeholder through to the mocked writes; the
// real one needs an initialized database (ProfilesEditor's load attempt is
// also silenced by this).
vi.mock("@/services/db/executor", () => ({
  getExecutor: vi.fn(() => ({})),
}))

import { AccountsSection } from "../accounts-section"
import { useAccountStore } from "@/stores/account-store"

const ACCOUNT = {
  id: "acc-1",
  type: "gmail" as const,
  email: "user@example.com",
  displayName: null,
  status: "active" as const,
  unreadCount: 0,
  lastSyncAt: 1_700_000_000,
  historyWindow: null,
  reminderLeadMinutes: null as number | null,
}

function seedStore(overrides: Partial<typeof ACCOUNT> = {}): void {
  useAccountStore.setState({
    accounts: [{ ...ACCOUNT, ...overrides }],
    activeAccountId: ACCOUNT.id,
    loaded: true,
  })
  vi.spyOn(useAccountStore.getState(), "reload").mockResolvedValue()
}

beforeEach(() => {
  accountsHolder.updateHistoryWindow.mockReset()
  accountsHolder.setAccountReminderLeadMinutes.mockReset()
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

/** Open the row's reminder select and scope queries to its listbox. */
async function openLeadOptions(accountId: string) {
  fireEvent.click(screen.getByTestId(`reminder-lead-${accountId}`))
  const listbox = (await screen.findAllByRole("listbox")).at(-1)
  if (!listbox) throw new Error("select listbox did not open")
  return within(listbox)
}

function chooseOption(option: HTMLElement): void {
  fireEvent.pointerDown(option)
  fireEvent.click(option)
}

describe("AccountsSection reminder lead (task 8.5)", () => {
  it("persists the picked lead through the service and reloads", async () => {
    seedStore({ reminderLeadMinutes: null })
    accountsHolder.setAccountReminderLeadMinutes.mockResolvedValue(undefined)

    render(<AccountsSection />)
    const options = await openLeadOptions(ACCOUNT.id)
    chooseOption(options.getByRole("option", { name: "10 min before" }))

    await waitFor(() => {
      expect(accountsHolder.setAccountReminderLeadMinutes).toHaveBeenCalledWith(
        expect.anything(),
        ACCOUNT.id,
        10
      )
    })
  })

  it("persists Off as null", async () => {
    seedStore({ reminderLeadMinutes: 15 })
    accountsHolder.setAccountReminderLeadMinutes.mockResolvedValue(undefined)

    render(<AccountsSection />)
    const options = await openLeadOptions(ACCOUNT.id)
    chooseOption(options.getByRole("option", { name: "Off" }))

    await waitFor(() => {
      expect(accountsHolder.setAccountReminderLeadMinutes).toHaveBeenCalledWith(
        expect.anything(),
        ACCOUNT.id,
        null
      )
    })
  })

  it("shows the stored lead and does not write when unchanged", async () => {
    seedStore({ reminderLeadMinutes: 5 })

    render(<AccountsSection />)
    const trigger = screen.getByTestId(`reminder-lead-${ACCOUNT.id}`)
    expect(trigger.textContent).toContain("5 min before")

    const options = await openLeadOptions(ACCOUNT.id)
    chooseOption(options.getByRole("option", { name: "5 min before" }))

    await waitFor(() => {
      expect(
        accountsHolder.setAccountReminderLeadMinutes
      ).not.toHaveBeenCalled()
    })
  })
})
