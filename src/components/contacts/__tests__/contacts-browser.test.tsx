import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"

import {
  createAccount,
  createMessage,
  createThread,
  at,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { recordContactInteraction } from "@/services/db/contacts"
import { searchContactsRanked } from "@/services/db/contacts"
import {
  setAccountStoreExecutor,
  useAccountStore,
  type AccountInfo,
} from "@/stores/account-store"
import { useComposerStore } from "@/stores/composer-store"
import { DEFAULT_VIEW, useUiStore, type ViewSelection } from "@/stores/ui-store"
import { ContactsBrowser } from "../contacts-browser"
import {
  notifyContactsChanged,
  setContactsBrowserExecutor,
} from "../use-contacts"

/**
 * Contacts browser (task 20.2, contacts spec). The view runs its real
 * queries against a seeded node:sqlite database via the executor override
 * hook (the todos-section.test.tsx harness) and the flows run through the
 * REAL use-contacts seam — the notify is what reloads the list, the
 * exact interplay production uses.
 *
 * The scenarios are the spec's: search narrows the list, a rename shows
 * in the address book AND in recipient autocomplete (the composer's
 * suggestion query), compose-to opens the composer with the contact in
 * To, and deleting removes the entry only while every message stays.
 */

let executor: TestExecutor

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
    previousView: DEFAULT_VIEW,
    listScope: null,
  })
  useComposerStore.setState({
    open: false,
    mode: { kind: "new" },
    activeAccountId: null,
    to: [],
    cc: [],
    bcc: [],
    subject: "",
    html: "",
  })
}

beforeEach(() => {
  resetStores()
  executor = createTestExecutor()
  setContactsBrowserExecutor(executor)
  setAccountStoreExecutor(executor)
})

afterEach(() => {
  cleanup()
  setContactsBrowserExecutor(null)
  setAccountStoreExecutor(null)
  executor.close()
  resetStores()
})

/** Two accounts with contacts of differing recency; the browser lists
 * them across accounts, most recent correspondence first. */
async function seedAddressBook(): Promise<{
  accountA: string
  accountB: string
}> {
  const accountA = await createAccount(executor, "gmail")
  const accountB = await createAccount(executor, "imap")
  await recordContactInteraction(executor, accountA, [
    { email: "ada@x.com", name: "Ada Lovelace" },
  ])
  await recordContactInteraction(executor, accountB, [
    { email: "babbage@x.com", name: "Charles Babbage" },
  ])
  await recordContactInteraction(executor, accountA, [{ email: "never@x.com" }])
  // Make the recency deterministic (the interactions above share one
  // wall-clock second).
  await executor.execute(
    "UPDATE contacts SET last_interaction_at = $1 WHERE email = $2",
    [at(100), "ada@x.com"]
  )
  await executor.execute(
    "UPDATE contacts SET last_interaction_at = $1 WHERE email = $2",
    [at(50), "babbage@x.com"]
  )
  await executor.execute(
    "UPDATE contacts SET last_interaction_at = NULL WHERE email = $1",
    ["never@x.com"]
  )
  useAccountStore.setState({
    accounts: [accountInfo(accountA), accountInfo(accountB)],
    activeAccountId: accountA,
    loaded: true,
  })
  return { accountA, accountB }
}

const rowTexts = (): string[] =>
  screen.queryAllByTestId("contact-row").map((row) => row.textContent ?? "")

describe("contacts browser (task 20.2)", () => {
  it("lists contacts across TWO accounts by most recent correspondence with per-row account badges", async () => {
    const { accountA, accountB } = await seedAddressBook()
    render(<ContactsBrowser />)

    await waitFor(() => expect(rowTexts()).toHaveLength(3))
    // Most recent correspondence first; the never-contacted row last.
    expect(rowTexts()[0]).toContain("Ada Lovelace")
    expect(rowTexts()[1]).toContain("Charles Babbage")
    expect(rowTexts()[2]).toContain("never@x.com")
    // Cross-account identity travels with the row (the Todos pattern).
    const rows = screen.getAllByTestId("contact-row")
    expect(
      rows[0].querySelector(`[data-account-badge="${accountA}"]`)
    ).not.toBeNull()
    expect(
      rows[1].querySelector(`[data-account-badge="${accountB}"]`)
    ).not.toBeNull()
  })

  it("narrows the list immediately while typing a partial name or email", async () => {
    await seedAddressBook()
    render(<ContactsBrowser />)
    await waitFor(() => expect(rowTexts()).toHaveLength(3))

    const search = screen.getByRole("textbox", { name: "Search contacts" })
    fireEvent.change(search, { target: { value: "babb" } })
    await waitFor(() => expect(rowTexts()).toHaveLength(1))
    expect(rowTexts()[0]).toContain("Charles Babbage")

    // No matches narrows to the empty-search state.
    fireEvent.change(search, { target: { value: "zzz" } })
    expect(await screen.findByText("No contacts match “zzz”")).not.toBeNull()

    // Clearing restores the full list (and keeps it sorted).
    fireEvent.change(search, { target: { value: "" } })
    await waitFor(() => expect(rowTexts()).toHaveLength(3))
  })

  it("shows the detail with count, last-contacted date and related threads", async () => {
    const { accountA } = await seedAddressBook()
    const threadId = await createThread(executor, accountA, {
      subject: "Analytical engines",
    })
    await createMessage(executor, {
      threadId,
      accountId: accountA,
      date: at(90),
      fromAddress: "ada@x.com",
      subject: "Analytical engines",
    })

    render(<ContactsBrowser />)
    const rows = await screen.findAllByTestId("contact-row")
    fireEvent.click(rows[0])

    const detail = await screen.findByTestId("contact-detail")
    expect(within(detail).getByText("ada@x.com")).not.toBeNull()
    // Ada has one interaction — and it is NOT "Never".
    expect(within(detail).getByText("1 message")).not.toBeNull()
    expect(within(detail).queryByText("Never")).toBeNull()
    // The related thread from the contact's address is listed.
    const threadRow = await within(detail).findAllByTestId("related-thread-row")
    expect(threadRow).toHaveLength(1)
    expect(threadRow[0].textContent).toContain("Analytical engines")
  })

  it("renames from the detail — the new name shows in the book and in recipient autocomplete", async () => {
    const { accountA } = await seedAddressBook()
    render(<ContactsBrowser />)
    const rows = await screen.findAllByTestId("contact-row")
    fireEvent.click(rows[0])

    fireEvent.click(screen.getByRole("button", { name: "Rename Ada Lovelace" }))
    const input = screen.getByRole("textbox", { name: "Display name" })
    fireEvent.change(input, { target: { value: "Ada King" } })
    fireEvent.click(screen.getByRole("button", { name: "Save name" }))

    // The address book re-queries through the notify and shows the edit.
    await waitFor(() => expect(rowTexts()[0]).toContain("Ada King"))
    // Autocomplete (recipient-field.tsx suggests through
    // searchContactsRanked) sees the same stored row: the new name
    // matches, the old one is gone.
    const suggestions = await searchContactsRanked(executor, accountA, "ada")
    expect(suggestions.map((row) => row.name)).toEqual(["Ada King"])
    expect(await searchContactsRanked(executor, accountA, "lovelace")).toEqual(
      []
    )
  })

  it("saves free-form notes on the contact", async () => {
    await seedAddressBook()
    render(<ContactsBrowser />)
    const rows = await screen.findAllByTestId("contact-row")
    fireEvent.click(rows[0])

    fireEvent.change(screen.getByLabelText("Contact notes"), {
      target: { value: "Prefers email over calls" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save notes" }))

    await waitFor(async () => {
      const stored = await executor.select<{ notes: string | null }>(
        "SELECT notes FROM contacts WHERE email = 'ada@x.com'"
      )
      expect(stored[0]?.notes).toBe("Prefers email over calls")
    })
  })

  it("compose-to opens the composer with the contact in To, from the contact's own account", async () => {
    const { accountA, accountB } = await seedAddressBook()
    render(<ContactsBrowser />)
    // accountB is NOT the active account — the compose still goes out
    // from the account the correspondence belongs to, without switching.
    const rows = await screen.findAllByTestId("contact-row")
    fireEvent.click(rows[1])

    fireEvent.click(
      screen.getByRole("button", { name: "Compose to Charles Babbage" })
    )

    const composer = useComposerStore.getState()
    expect(composer.open).toBe(true)
    expect(composer.activeAccountId).toBe(accountB)
    expect(composer.to).toEqual([
      { name: "Charles Babbage", email: "babbage@x.com" },
    ])
    expect(useUiStore.getState().composerOpen).toBe(true)
    // No account switch happened.
    expect(useAccountStore.getState().activeAccountId).toBe(accountA)
  })

  it("deleting a contact removes the entry only — messages stay and the contact reappears on correspondence", async () => {
    const { accountA } = await seedAddressBook()
    const threadId = await createThread(executor, accountA, {
      subject: "Analytical engines",
    })
    await createMessage(executor, {
      threadId,
      accountId: accountA,
      date: at(90),
      fromAddress: "ada@x.com",
      subject: "Analytical engines",
    })
    render(<ContactsBrowser />)
    const rows = await screen.findAllByTestId("contact-row")
    fireEvent.click(rows[0])

    fireEvent.click(
      screen.getByRole("button", { name: "Delete contact Ada Lovelace" })
    )
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Confirm deleting Ada Lovelace",
      })
    )

    // The entry leaves the address book…
    await waitFor(() => expect(rowTexts()).toHaveLength(2))
    expect(rowTexts().join("\n")).not.toContain("Ada Lovelace")
    // …while every message and thread remain untouched.
    const messages = await executor.select("SELECT id FROM messages")
    const threads = await executor.select("SELECT id FROM threads")
    expect(messages).toHaveLength(1)
    expect(threads).toHaveLength(1)

    // Corresponding again re-inserts the contact automatically. The write
    // happens in the send flow (recordContactInteraction), which does not
    // notify the browser — the refresh comes from re-entering the view,
    // which the test simulates by firing the notify seam.
    await recordContactInteraction(executor, accountA, [
      { email: "ada@x.com", name: "Ada Lovelace" },
    ])
    notifyContactsChanged()
    await waitFor(() => expect(rowTexts()).toHaveLength(3))
    expect(rowTexts().join("\n")).toContain("Ada Lovelace")
  })

  it("the back control restores the mailbox view the user came from", async () => {
    await seedAddressBook()
    const inbox: ViewSelection = {
      kind: "folder",
      folder: { kind: "specialUse", specialUse: "inbox" },
    }
    useUiStore.setState({ view: inbox, previousView: inbox })
    render(<ContactsBrowser />)

    fireEvent.click(screen.getByRole("button", { name: "Back to mailbox" }))

    expect(useUiStore.getState().view).toEqual(inbox)
  })
})
