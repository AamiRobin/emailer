import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import type { ReactElement } from "react"

import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  initAccountStore,
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import type { AccountInfo } from "@/stores/account-store"
import { AccountSwitcher } from "../account-switcher"

/**
 * Render tests drive the real store against a seeded node:sqlite database
 * (injected via setAccountStoreExecutor). jsdom + Base UI Select render the
 * popup in a portal, so options are queried from document.body.
 *
 * The re-auth dialog is stubbed: the switcher tests assert the per-account
 * wiring (which account opens which dialog), the dialogs' behavior has its
 * own suites in components/accounts/__tests__.
 */

vi.mock("@/components/accounts/reauth-dialog", () => ({
  ReauthDialog: (props: {
    account: AccountInfo | null
    open: boolean
  }): ReactElement | null =>
    props.open && props.account ? (
      <div data-testid="reauth-dialog">reauth:{props.account.email}</div>
    ) : null,
}))

let executor: TestExecutor
let idSequence = 0

function resetStore(): void {
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: false,
  })
}

async function seedAccount(options: {
  email: string
  displayName?: string
  status?: "active" | "auth-error"
  isActive?: boolean
}): Promise<string> {
  idSequence += 1
  const id = `acc-${idSequence}`
  await executor.execute(
    `INSERT INTO accounts (id, type, email, display_name, status, is_active)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      "gmail",
      options.email,
      options.displayName ?? null,
      options.status ?? "active",
      options.isActive ? 1 : 0,
    ]
  )
  return id
}

async function seedUnread(accountId: string, unread: number): Promise<void> {
  for (let index = 0; index < unread; index += 1) {
    idSequence += 1
    const threadId = `th-${idSequence}`
    await executor.execute(
      "INSERT INTO threads (id, account_id) VALUES ($1, $2)",
      [threadId, accountId]
    )
    await executor.execute(
      `INSERT INTO messages (id, thread_id, account_id, date, is_read)
       VALUES ($1, $2, $3, $4, 0)`,
      [`msg-${idSequence}`, threadId, accountId, 1_700_000_000 + index]
    )
  }
}

async function openDropdown(): Promise<void> {
  fireEvent.click(screen.getByRole("combobox", { name: "Select account" }))
}

/** Base UI Select ignores synthetic clicks that did not start with a
 * pointerdown on the item (drag-select guard), so send both. */
function chooseOption(option: HTMLElement): void {
  fireEvent.pointerDown(option)
  fireEvent.click(option)
}

beforeEach(() => {
  executor = createTestExecutor()
  setAccountStoreExecutor(executor)
  idSequence = 0
  resetStore()
})

afterEach(() => {
  cleanup()
  setAccountStoreExecutor(null)
  executor.close()
  resetStore()
})

function renderSwitcher(isCollapsed = false, onAddAccount?: () => void) {
  return render(
    <TooltipProvider delay={0}>
      <AccountSwitcher isCollapsed={isCollapsed} onAddAccount={onAddAccount} />
    </TooltipProvider>
  )
}

describe("account switcher", () => {
  it("renders the active account in the trigger and unread badges per account", async () => {
    await seedAccount({
      email: "one@example.com",
      displayName: "One Person",
      isActive: true,
    })
    const secondId = await seedAccount({ email: "two@example.com" })
    await seedUnread(secondId, 3)
    await initAccountStore()

    renderSwitcher()

    expect(
      screen.getByRole("combobox", { name: "Select account" })
    ).toBeTruthy()
    expect(screen.getByText("One Person")).toBeTruthy()

    await openDropdown()
    const secondOption = await screen.findByRole("option", {
      name: /two@example.com/,
    })
    expect(within(secondOption).getByText("3")).toBeTruthy()
    const firstOption = screen.getByRole("option", {
      name: /one@example.com/,
    })
    expect(within(firstOption).queryByText("3")).toBeNull()
  })

  it("marks the active account and switches instantly on select", async () => {
    const firstId = await seedAccount({
      email: "one@example.com",
      displayName: "One Person",
      isActive: true,
    })
    const secondId = await seedAccount({
      email: "two@example.com",
      displayName: "Two Person",
    })
    await initAccountStore()

    renderSwitcher()

    await openDropdown()
    const secondOption = await screen.findByRole("option", {
      name: /two@example.com/,
    })
    expect(
      screen
        .getByRole("option", { name: /one@example.com/ })
        .getAttribute("aria-selected")
    ).toBe("true")

    chooseOption(secondOption)

    // instant in-memory switch, then the is_active flag persisted
    await waitFor(() => {
      expect(useAccountStore.getState().activeAccountId).toBe(secondId)
    })
    expect(useAccountStore.getState().activeAccountId).not.toBe(firstId)
    const flagged = await executor.select<{ id: string }>(
      "SELECT id FROM accounts WHERE is_active = 1"
    )
    expect(flagged.map((row) => row.id)).toEqual([secondId])
    // trigger now shows the newly active account
    expect(await screen.findByText("Two Person")).toBeTruthy()
  })

  it("shows a warning glyph for auth-error accounts", async () => {
    await seedAccount({
      email: "broken@example.com",
      status: "auth-error",
      isActive: true,
    })
    await initAccountStore()

    renderSwitcher()

    await openDropdown()
    const brokenOption = await screen.findByRole("option", {
      name: /broken@example.com/,
    })
    expect(
      within(brokenOption).getByRole("img", {
        name: "Account sign-in error",
      })
    ).toBeTruthy()
  })

  it("renders a muted no-accounts state on an empty database", async () => {
    await initAccountStore()

    renderSwitcher()

    await openDropdown()
    const emptyOption = await screen.findByRole("option", {
      name: "No accounts",
    })
    expect(emptyOption.getAttribute("aria-disabled")).toBe("true")
    const state = useAccountStore.getState()
    expect(state.accounts).toEqual([])
    expect(state.activeAccountId).toBeNull()
  })

  it("collapsed mode renders only the active avatar with a tooltip", async () => {
    await seedAccount({
      email: "one@example.com",
      displayName: "One Person",
      isActive: true,
    })
    await initAccountStore()

    renderSwitcher(true)

    expect(
      screen.getByRole("combobox", { name: "Select account" })
    ).toBeTruthy()
    expect(screen.queryByText("One Person")).toBeNull()
  })

  it("offers an Add account entry that signals upward without switching", async () => {
    await seedAccount({
      email: "one@example.com",
      displayName: "One Person",
      isActive: true,
    })
    await initAccountStore()
    const onAddAccount = vi.fn()
    renderSwitcher(false, onAddAccount)

    await openDropdown()
    const addOption = await screen.findByRole("option", {
      name: /Add account/,
    })
    chooseOption(addOption)

    expect(onAddAccount).toHaveBeenCalledTimes(1)
    // The selection is untouched — choosing to add is not a switch.
    await waitFor(() => {
      expect(useAccountStore.getState().activeAccountId).not.toBe("add-account")
    })
  })

  it("offers Re-authenticate… for auth-error accounts and opens the re-auth dialog", async () => {
    await seedAccount({
      email: "healthy@example.com",
      isActive: true,
    })
    await seedAccount({
      email: "broken@example.com",
      status: "auth-error",
    })
    await initAccountStore()

    renderSwitcher()

    await openDropdown()
    // Only the paused account gets the re-auth entry.
    const options = await screen.findAllByRole("option", {
      name: /Re-authenticate/,
    })
    expect(options).toHaveLength(1)

    chooseOption(options[0] as HTMLElement)

    const dialog = screen.getByTestId("reauth-dialog")
    expect(dialog.textContent).toBe("reauth:broken@example.com")
  })

  it("active-status accounts have no Re-authenticate entry", async () => {
    await seedAccount({ email: "one@example.com", isActive: true })
    await initAccountStore()

    renderSwitcher()

    await openDropdown()
    expect(
      await screen.findByRole("option", { name: /one@example.com/ })
    ).toBeTruthy()
    expect(screen.queryByRole("option", { name: /Re-authenticate/ })).toBeNull()
  })
})
