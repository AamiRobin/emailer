import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import { AddressBookSection } from "../address-book-section"
import { createInMemoryKeyStore } from "@/services/crypto/__tests__/in-memory-key-store"
import { setDefaultKeyStore } from "@/services/crypto/key-management"
import { encryptCredentials } from "@/services/crypto/credentials"
import { useAccountStore } from "@/stores/account-store"
import type { SqlExecutor } from "@/services/db/executor"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { syncCarddavBook } from "@/services/contacts/carddav"
import type { CarddavBook } from "@/services/db/carddav-books"

/**
 * Address-book settings-section tests (parity-round-2 task 4.3). The
 * executor module is mocked to hand the section a seeded node:sqlite
 * executor (the REAL books service runs against it); the CardDAV service
 * module is mocked only at its COMMAND boundaries (discovery + sync —
 * they have their own suite) while connect/disconnect run the real
 * sealing + SQL. Covers the connect flow (discover → choose → connect →
 * initial pull → status), the confirmed disconnect removing the book AND
 * its synced contacts, and the status line: read-only badge, the
 * skipped-card warning when nonzero, and the last error.
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

vi.mock("@/services/contacts/carddav", async () => {
  const actual = await vi.importActual<
    typeof import("@/services/contacts/carddav")
  >("@/services/contacts/carddav")
  return {
    ...actual,
    discoverCarddavBooks: vi.fn(),
    syncCarddavBook: vi.fn(),
  }
})

const discoverMock = vi.mocked(
  (await import("@/services/contacts/carddav")).discoverCarddavBooks
)
const syncMock = vi.mocked(syncCarddavBook)

const BOOK_HREF = "https://dav.example.com/dav/user/addresses/contacts/"

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
  executorHolder.current = executor
  setDefaultKeyStore(createInMemoryKeyStore())
})

afterEach(() => {
  cleanup()
  setDefaultKeyStore(null)
  executorHolder.current = null
  executor.close()
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: false,
  })
  vi.clearAllMocks()
})

function setAccounts(count = 1): string {
  const account = {
    id: "acc-1",
    type: "gmail" as const,
    email: "jane@example.com",
    displayName: null,
    status: "active" as const,
    unreadCount: 0,
  }
  const others = Array.from({ length: count - 1 }, (_, index) => ({
    id: `acc-${index + 2}`,
    type: "imap" as const,
    email: `other-${index + 1}@example.com`,
    displayName: null,
    status: "active" as const,
    unreadCount: 0,
  }))
  useAccountStore.setState({
    accounts: [account, ...others],
    activeAccountId: account.id,
    loaded: true,
  })
  return account.id
}

async function fillForm() {
  fireEvent.change(screen.getByLabelText("Server URL"), {
    target: { value: "https://dav.example.com/" },
  })
  fireEvent.change(screen.getByLabelText("Username"), {
    target: { value: "jane" },
  })
  fireEvent.change(screen.getByLabelText("App password"), {
    target: { value: "app-pass-1" },
  })
}

async function seedBook(overrides: Partial<CarddavBook> = {}): Promise<string> {
  const accountId = "acc-1"
  // The account row must exist in the DB (the store alone is not a row).
  await executor.execute(
    "INSERT OR IGNORE INTO accounts (id, type, email) VALUES ('acc-1', 'gmail', 'jane@example.com')"
  )
  const credentialsJson = await encryptCredentials({
    serverUrl: "https://dav.example.com/",
    username: "jane",
    appPassword: "sealed-away",
  })
  await executor.execute(
    `INSERT INTO carddav_books (
       id, account_id, base_url, book_url, username, credentials_json, name,
       read_only, last_synced_at, last_error, last_skipped
     ) VALUES ('book-1', $1, 'https://dav.example.com/', $2, 'jane', $3,
       $4, $5, $6, $7, $8)`,
    [
      accountId,
      overrides.bookUrl ?? BOOK_HREF,
      credentialsJson,
      overrides.name ?? "Contacts",
      overrides.readOnly === true ? 1 : 0,
      overrides.lastSyncedAt ?? null,
      overrides.lastError ?? null,
      overrides.lastSkipped ?? null,
    ]
  )
  return "book-1"
}

describe("AddressBookSection", () => {
  it("renders the connect form with the sealed-password note", () => {
    setAccounts()
    render(<AddressBookSection />)
    expect(
      screen.getByText(/password is sealed on this device and never leaves it/i)
    ).toBeTruthy()
    expect(screen.getByLabelText("Server URL")).toBeTruthy()
    expect(screen.getByLabelText("App password")).toBeTruthy()
  })

  it("requires a mail account before offering the form", () => {
    useAccountStore.setState({
      accounts: [],
      activeAccountId: null,
      loaded: true,
    })
    render(<AddressBookSection />)
    expect(
      screen.getByText(/connect a mail account first/i)
    ).toBeTruthy()
    expect(screen.queryByLabelText("Server URL")).toBeNull()
  })

  it("connects: discovery → book choice → connect runs the initial pull and lists the book", async () => {
    const accountId = setAccounts()
    // The account must exist as a row (carddav_books.account_id is a FK).
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, 'gmail', 'jane@example.com')",
      [accountId]
    )
    discoverMock.mockResolvedValue([
      { href: BOOK_HREF, displayName: "Contacts", readOnly: false },
      {
        href: "https://dav.example.com/dav/user/addresses/family/",
        displayName: "Family",
        readOnly: true,
      },
    ])
    syncMock.mockResolvedValue({
      mode: "full",
      stored: 42,
      removed: 0,
      skipped: 0,
    })

    render(<AddressBookSection />)
    await fillForm()
    fireEvent.click(screen.getByText("Discover address books"))

    const familyRadio = await waitFor(() =>
      screen.getByLabelText(/Family/) as HTMLInputElement
    )
    expect(familyRadio.type).toBe("radio")
    expect(discoverMock).toHaveBeenCalledWith({
      serverUrl: "https://dav.example.com/",
      username: "jane",
      appPassword: "app-pass-1",
    })
    // The read-only book is labelled in the choice list.
    expect(screen.getByText(/\(read-only\)/)).toBeTruthy()

    // "Contacts" is the default choice (first discovered book).
    fireEvent.click(screen.getByRole("button", { name: "Connect" }))
    await waitFor(
      () => expect(syncMock).toHaveBeenCalled(),
      { timeout: 5000 }
    )
    const [, syncedBook] = syncMock.mock.calls[0]
    expect(syncedBook.bookUrl).toBe(BOOK_HREF)
    expect(syncedBook.accountId).toBe(accountId)

    // The book is listed with the initial-pull summary.
    await waitFor(() => expect(screen.getAllByText(/Contacts/).length > 0))
    expect(screen.getByText(/Synced — 42 contacts/)).toBeTruthy()
    // The sealed-password note is gone from the reset form but the book
    // row carries no plaintext anywhere.
    const dumped = JSON.stringify(
      await executor.select<Record<string, unknown>>(
        "SELECT * FROM carddav_books"
      )
    )
    expect(dumped).not.toContain("app-pass-1")
  })

  it("shows a specific discovery failure", async () => {
    setAccounts()
    discoverMock.mockRejectedValue(
      new Error(
        "the server rejected the username or app password (HTTP 401); reconnect the address book"
      )
    )
    render(<AddressBookSection />)
    await fillForm()
    fireEvent.click(screen.getByText("Discover address books"))
    await waitFor(() =>
      expect(
        screen.getByText(/rejected the username or app password/)
      ).toBeTruthy()
    )
  })

  it("status line: read-only badge and skipped-card warning when nonzero", async () => {
    setAccounts()
    await seedBook({ readOnly: true, lastSkipped: 2, lastSyncedAt: 1_700_000_000 })
    render(<AddressBookSection />)
    await waitFor(() => expect(screen.getByTestId("carddav-book-row")))
    expect(screen.getByText("Read-only")).toBeTruthy()
    expect(
      screen.getByText(/2 cards could not be read and were skipped/)
    ).toBeTruthy()
  })

  it("status line: no skipped warning when zero, last error surfaced", async () => {
    setAccounts()
    await seedBook({
      lastError: "the CardDAV server returned HTTP 503",
    })
    render(<AddressBookSection />)
    await waitFor(() => expect(screen.getByTestId("carddav-book-row")))
    expect(screen.queryByText(/could not be read/)).toBeNull()
    expect(screen.getByText(/Last sync failed/)).toBeTruthy()
    expect(screen.getByText(/HTTP 503/)).toBeTruthy()
  })

  it("Sync now re-syncs and reports the result", async () => {
    setAccounts()
    await seedBook({})
    syncMock.mockResolvedValue({
      mode: "delta",
      stored: 3,
      removed: 1,
      skipped: 0,
    })
    render(<AddressBookSection />)
    await waitFor(() => expect(screen.getByTestId("carddav-book-row")))
    fireEvent.click(screen.getByRole("button", { name: "Sync Contacts" }))
    await waitFor(() =>
      expect(screen.getByText(/3 new or changed, 1 removed/)).toBeTruthy()
    )
  })

  it("disconnect removes the book AND its synced contacts after the confirm", async () => {
    setAccounts()
    await seedBook({})
    await executor.execute(
      `INSERT INTO contacts (
         id, account_id, email, name, interaction_count, source, uid, href,
         etag, carddav_raw, book_id
       ) VALUES ('c1', 'acc-1', 'ada@example.test', 'Ada', 0, 'carddav',
         'uid-ada', '${BOOK_HREF}ada.vcf', '"e"', 'BEGIN:VCARD', 'book-1')`
    )
    render(<AddressBookSection />)
    await waitFor(() => expect(screen.getByTestId("carddav-book-row")))

    fireEvent.click(
      screen.getByRole("button", { name: "Disconnect Contacts" })
    )
    // The confirm dialog names the consequences.
    expect(
      await screen.findByText(/Its synced contacts are removed from this device/)
    ).toBeTruthy()
    expect(screen.getByText(/the contacts on the CardDAV server are not affected/i))

    fireEvent.click(
      screen.getByRole("button", { name: "Confirm disconnecting Contacts" })
    )
    await waitFor(() =>
      expect(screen.queryByTestId("carddav-book-row")).toBeNull()
    )
    const contacts = await executor.select<unknown>(
      "SELECT * FROM contacts WHERE book_id = 'book-1'"
    )
    expect(contacts).toHaveLength(0)
  })
})
