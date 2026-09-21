import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import { createAccount } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { listAllContacts, searchContactsRanked } from "@/services/db/contacts"
import { recordContactInteraction } from "@/services/db/contacts"
import {
  setAccountStoreExecutor,
  useAccountStore,
  type AccountInfo,
} from "@/stores/account-store"
import { ContactsBrowser } from "../contacts-browser"
import {
  notifyContactsChanged,
  setContactsBrowserExecutor,
} from "../use-contacts"

/**
 * Synced-contact parity (parity-round-2 task 4.3, spec contacts "CardDAV
 * sync"): a CardDAV-sourced contact must render in the contacts browser
 * and rank in compose autocomplete EXACTLY like a local one — no
 * source-specific branching may leak into those surfaces. The rows here
 * are seeded straight into the v17 schema (the sync service's own suite
 * covers how they get there); the components under test are the
 * production ones with their real queries.
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

beforeEach(() => {
  executor = createTestExecutor()
  setContactsBrowserExecutor(executor)
  setAccountStoreExecutor(executor)
})

afterEach(() => {
  cleanup()
  setContactsBrowserExecutor(null)
  setAccountStoreExecutor(null)
  executor.close()
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: false,
  })
})

/** One local contact (from exchanged mail) and one CardDAV-sourced one,
 * in the same account. */
async function seedMixedAddressBook(): Promise<void> {
  const accountId = await createAccount(executor)
  useAccountStore.setState({
    accounts: [accountInfo(accountId)],
    activeAccountId: accountId,
    loaded: true,
  })
  await recordContactInteraction(executor, accountId, [
    { email: "local@x.com", name: "Local Person" },
  ])
  await executor.execute(
    `INSERT INTO carddav_books (id, account_id, base_url, book_url, username,
       credentials_json, name)
     VALUES ('book-1', $1, 'https://dav.example.com/',
       'https://dav.example.com/book/', 'jane', 'sealed', 'Contacts')`,
    [accountId]
  )
  await executor.execute(
    `INSERT INTO contacts (
       id, account_id, email, name, notes, interaction_count,
       source, uid, href, etag, carddav_raw, book_id
     ) VALUES ('c-carddav', $1, 'synced@x.com', 'Synced Person', NULL, 0,
       'carddav', 'urn:uuid:synced-1',
       'https://dav.example.com/book/synced.vcf', '"e1"',
       'BEGIN:VCARD', 'book-1')`,
    [accountId]
  )
}

const rowTexts = (): string[] =>
  screen.queryAllByTestId("contact-row").map((row) => row.textContent ?? "")

describe("synced-contact parity in the contacts surfaces", () => {
  it("renders the synced contact like a local one (same row structure, avatar included)", async () => {
    await seedMixedAddressBook()
    render(<ContactsBrowser />)
    await waitFor(() => expect(rowTexts()).toHaveLength(2))
    // Both rows carry exactly the same pieces: avatar, name, email — the
    // synced row is not labelled, filtered, or styled differently.
    expect(rowTexts()[0]).toContain("Local Person")
    expect(rowTexts()[0]).toContain("local@x.com")
    expect(rowTexts()[1]).toContain("Synced Person")
    expect(rowTexts()[1]).toContain("synced@x.com")
    // Same avatar slots on both rows (initials while the Gravatar setting
    // is off — the avatar component does not branch on source either).
    const rows = screen.getAllByTestId("contact-row")
    for (const row of rows) {
      expect(row.querySelector("img, span")).not.toBeNull()
    }
  })

  it("search narrows local and synced contacts identically", async () => {
    await seedMixedAddressBook()
    render(<ContactsBrowser />)
    await waitFor(() => expect(rowTexts()).toHaveLength(2))
    fireEvent.change(screen.getByTestId("contacts-search"), {
      target: { value: "synced" },
    })
    await waitFor(() => expect(rowTexts()).toHaveLength(1))
    expect(rowTexts()[0]).toContain("Synced Person")
    fireEvent.change(screen.getByTestId("contacts-search"), {
      target: { value: "local@" },
    })
    await waitFor(() => expect(rowTexts()).toHaveLength(1))
    expect(rowTexts()[0]).toContain("Local Person")
  })

  it("ranks in compose autocomplete without source branching", async () => {
    await seedMixedAddressBook()
    const { account_id: accountId } = (
      await executor.select<{ account_id: string }>(
        "SELECT account_id FROM contacts WHERE id = 'c-carddav'"
      )
    )[0]
    // The exact query the composer's recipient field runs (the browser
    // tests' autocomplete verification path).
    const suggestions = await searchContactsRanked(executor, accountId, "sync")
    expect(suggestions.map((contact) => contact.email)).toEqual([
      "synced@x.com",
    ])
    const emptyQuery = await listAllContacts(executor, { query: "" })
    expect(emptyQuery.map((contact) => contact.email).sort()).toEqual([
      "local@x.com",
      "synced@x.com",
    ])
    // A prefix on the display name matches both sources alike.
    const byName = await searchContactsRanked(executor, accountId, "son")
    expect(byName.map((contact) => contact.email).sort()).toEqual([
      "local@x.com",
      "synced@x.com",
    ])
  })

  it("a refreshed browser (the sync notify) shows newly synced contacts", async () => {
    await seedMixedAddressBook()
    render(<ContactsBrowser />)
    await waitFor(() => expect(rowTexts()).toHaveLength(2))

    // A sync lands another card and notifies — the same interplay
    // production uses after syncCarddavBook.
    const accountId = (
      await executor.select<{ account_id: string }>(
        "SELECT account_id FROM contacts WHERE id = 'c-carddav'"
      )
    )[0].account_id
    await executor.execute(
      `INSERT INTO contacts (
         id, account_id, email, name, interaction_count,
         source, uid, href, etag, carddav_raw, book_id
       ) VALUES ('c-new', $1, 'new@x.com', 'Newly Synced', 0,
         'carddav', 'urn:uuid:new-1',
         'https://dav.example.com/book/new.vcf', '"e2"', 'BEGIN:VCARD',
         'book-1')`,
      [accountId]
    )
    notifyContactsChanged()
    await waitFor(() => expect(rowTexts()).toHaveLength(3))
    expect(rowTexts().some((text) => text.includes("Newly Synced"))).toBe(true)
  })
})
