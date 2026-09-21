import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"

import {
  connectCarddavBook,
  deleteCarddavContact,
  disconnectCarddavBook,
  pushContactEdit,
  pushNewContact,
  syncCarddavBook,
} from "../carddav"
import {
  decryptCredentials,
  encryptCredentials,
} from "../../crypto/credentials"
import { createInMemoryKeyStore } from "../../crypto/__tests__/in-memory-key-store"
import { setDefaultKeyStore } from "../../crypto/key-management"
import { createTestExecutor, type TestExecutor } from "../../db/__tests__/test-executor"
import { createAccount } from "../../db/__tests__/fixtures"
import { getCarddavBook, listCarddavBooks } from "../../db/carddav-books"
import { getContact, listAllContacts } from "../../db/contacts"

/**
 * CardDAV sync service tests (parity-round-2 task 4.2). The command
 * wrappers are exercised against a mocked `invoke` (the Rust side has
 * its own loopback mock-server cargo tests); the sync/persistence half
 * runs against the REAL v17 schema in node:sqlite — the initial pull,
 * incremental deltas with removals, the ctag "unchanged" short-circuit,
 * local-row adoption, the sealed credentials handling, and the
 * write-back (push/edit/delete) flows.
 */

vi.mock("@tauri-apps/api/core")

const invokeMock = vi.mocked(invoke)

const SERVER_URL = "https://dav.example.com/"
const USERNAME = "secret-user"
const APP_PASSWORD = "app-pass-99"
const BOOK_HREF = "https://dav.example.com/dav/user/addresses/contacts/"

function cardVcard(uid: string, name: string, email: string): string {
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `UID:${uid}`,
    `FN:${name}`,
    `EMAIL:${email}`,
    "END:VCARD",
    "",
  ].join("\r\n")
}

function syncResponse(input: {
  mode?: "unchanged" | "full" | "delta"
  token?: string | null
  ctag?: string | null
  cards?: {
    href: string
    etag: string
    vcard: string
    uid: string
    fullName: string
    email: string
    note?: string
  }[]
  removed?: string[]
  skipped?: number
}) {
  return {
    mode: input.mode ?? "full",
    next_sync_token: input.token ?? null,
    ctag: input.ctag ?? null,
    cards:
      input.cards?.map((card) => ({
        href: card.href,
        etag: card.etag,
        vcard: card.vcard,
        uid: card.uid,
        full_name: card.fullName,
        email: card.email,
        note: card.note,
      })) ?? [],
    removed: input.removed ?? [],
    skipped: input.skipped ?? 0,
  }
}

/** Route invoke by command name. */
function routeInvoke(
  handler: (command: string, args: Record<string, unknown>) => unknown
): void {
  invokeMock.mockImplementation(((command: string, args?: unknown) => {
    return Promise.resolve(
      handler(command, (args ?? {}) as Record<string, unknown>)
    )
  }) as typeof invoke)
}

function rejectInvokeWith(error: unknown): void {
  invokeMock.mockImplementation(() => Promise.reject(error))
}

/** Seed a connected book whose sealed envelope carries these credentials
 * (the connect-service path itself is covered in its own test). */
async function seedBook(executor: TestExecutor, id = "book-1"): Promise<string> {
  const accountId = await createAccount(executor)
  const credentialsJson = await encryptCredentials({
    serverUrl: SERVER_URL,
    username: USERNAME,
    appPassword: APP_PASSWORD,
  })
  await executor.execute(
    `INSERT INTO carddav_books (
       id, account_id, base_url, book_url, username, credentials_json, name
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      accountId,
      SERVER_URL,
      BOOK_HREF,
      USERNAME,
      credentialsJson,
      "Contacts",
    ]
  )
  return accountId
}

async function seedSyncedContact(
  executor: TestExecutor,
  accountId: string,
  bookId: string,
  overrides: Partial<{
    email: string
    name: string
    notes: string
    uid: string
    href: string
    etag: string
    carddavRaw: string
  }> = {}
): Promise<string> {
  const id = `contact-${overrides.uid ?? "x"}-${Math.floor(Math.random() * 1e9)}`
  await executor.execute(
    `INSERT INTO contacts (
       id, account_id, email, name, notes, interaction_count,
       source, uid, href, etag, carddav_raw, book_id
     ) VALUES ($1, $2, $3, $4, $5, 0, 'carddav', $6, $7, $8, $9, $10)`,
    [
      id,
      accountId,
      overrides.email ?? "seeded@example.test",
      overrides.name ?? "Seeded",
      overrides.notes ?? null,
      overrides.uid ?? "seeded-uid",
      overrides.href ?? `${BOOK_HREF}seeded.vcf`,
      overrides.etag ?? '"seeded"',
      overrides.carddavRaw ??
        cardVcard(overrides.uid ?? "seeded-uid", overrides.name ?? "Seeded", overrides.email ?? "seeded@example.test"),
      bookId,
    ]
  )
  return id
}

describe("migration v17 (CardDAV stores)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("creates carddav_books and the contacts provenance columns", async () => {
    const accountId = await createAccount(executor)
    await executor.execute(
      `INSERT INTO carddav_books (
         id, account_id, base_url, book_url, username, credentials_json, name
       ) VALUES ('b1', $1, 'https://x/', 'https://x/book/', 'u', 'sealed', 'B')`,
      [accountId]
    )
    // Existing contacts default to 'local' with NULL sync columns — the
    // additive promise.
    await executor.execute(
      "INSERT INTO contacts (id, account_id, email) VALUES ('c1', $1, 'local@example.test')",
      [accountId]
    )
    const rows = await executor.select<Record<string, unknown>>(
      "SELECT * FROM contacts WHERE id = 'c1'"
    )
    expect(rows[0]?.source).toBe("local")
    expect(rows[0]?.uid).toBeNull()
    expect(rows[0]?.href).toBeNull()
    expect(rows[0]?.etag).toBeNull()
    expect(rows[0]?.carddav_raw).toBeNull()
    expect(rows[0]?.book_id).toBeNull()
  })

  it("enforces the source CHECK and cascades disconnect to synced contacts", async () => {
    const accountId = await createAccount(executor)
    await executor.execute(
      `INSERT INTO carddav_books (
         id, account_id, base_url, book_url, username, credentials_json, name
       ) VALUES ('b1', $1, 'https://x/', 'https://x/book/', 'u', 'sealed', 'B')`,
      [accountId]
    )
    await expect(
      executor.execute(
        "INSERT INTO contacts (id, account_id, email, source) VALUES ('c2', $1, 'x@y.z', 'imap')",
        [accountId]
      )
    ).rejects.toThrow()
    await seedSyncedContact(executor, accountId, "b1", { uid: "u1" })
    // The disconnect cascade removes the book's synced contacts.
    await executor.execute("DELETE FROM carddav_books WHERE id = 'b1'")
    const remaining = await executor.select<unknown>(
      "SELECT * FROM contacts WHERE book_id = 'b1'"
    )
    expect(remaining).toHaveLength(0)
  })
})

describe("carddav connect", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
    setDefaultKeyStore(createInMemoryKeyStore())
  })

  afterEach(() => {
    executor.close()
    vi.resetAllMocks()
  })

  it("seals the credentials into the book envelope and never stores plaintext", async () => {
    const accountId = await createAccount(executor)
    const book = await connectCarddavBook(executor, {
      serverUrl: SERVER_URL,
      username: USERNAME,
      appPassword: APP_PASSWORD,
      accountId,
      book: { href: BOOK_HREF, displayName: "Contacts", readOnly: false },
    })
    expect(book.bookUrl).toBe(BOOK_HREF)
    expect(book.name).toBe("Contacts")
    // The stored row carries only ciphertext: no plaintext password
    // anywhere in the row (the spec's "credentials stay sealed").
    const rows = await executor.select<Record<string, string>>(
      "SELECT * FROM carddav_books WHERE id = $1",
      [book.id]
    )
    const dumped = JSON.stringify(rows)
    expect(dumped).not.toContain(APP_PASSWORD)
    // And the envelope still opens to exactly the connection details.
    const envelope = await decryptCredentials<{
        serverUrl: string
        username: string
        appPassword: string
      }>(
      rows[0]?.credentials_json ?? ""
    )
    expect(envelope?.appPassword).toBe(APP_PASSWORD)
    expect(envelope?.serverUrl).toBe(SERVER_URL)
  })
})

describe("carddav sync", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    setDefaultKeyStore(createInMemoryKeyStore())
    accountId = await seedBook(executor)
  })

  afterEach(() => {
    executor.close()
    vi.resetAllMocks()
  })

  it("initial full pull upserts the server's cards and stores the cursors", async () => {
    routeInvoke((command, args) => {
      expect(command).toBe("carddav_sync_book")
      expect(args.serverUrl).toBe(SERVER_URL)
      expect(args.username).toBe(USERNAME)
      expect(args.appPassword).toBe(APP_PASSWORD)
      expect(args.bookUrl).toBe(BOOK_HREF)
      expect(args.syncToken).toBeNull()
      expect(args.knownCards).toEqual([])
      return syncResponse({
        mode: "full",
        token: "urn:sync:1",
        ctag: "CTAG-1",
        cards: [
          {
            href: `${BOOK_HREF}ada.vcf`,
            etag: '"a1"',
            vcard: cardVcard("uid-ada", "Ada Lovelace", "ada@example.test"),
            uid: "uid-ada",
            fullName: "Ada Lovelace",
            email: "ada@example.test",
          },
          {
            href: `${BOOK_HREF}bob.vcf`,
            etag: '"b1"',
            vcard: cardVcard("uid-bob", "Bob", "bob@example.test"),
            uid: "uid-bob",
            fullName: "Bob",
            email: "bob@example.test",
            note: "from the server",
          },
        ],
      })
    })

    const books = await listCarddavBooks(executor)
    const result = await syncCarddavBook(executor, books[0])
    expect(result).toEqual({
      mode: "full",
      stored: 2,
      removed: 0,
      skipped: 0,
    })

    const contacts = await listAllContacts(executor)
    expect(contacts).toHaveLength(2)
    const ada = contacts.find((contact) => contact.email === "ada@example.test")
    expect(ada?.source).toBe("carddav")
    expect(ada?.uid).toBe("uid-ada")
    expect(ada?.href).toBe(`${BOOK_HREF}ada.vcf`)
    expect(ada?.etag).toBe('"a1"')
    expect(ada?.name).toBe("Ada Lovelace")
    expect(ada?.carddav_raw).toContain("UID:uid-ada")
    expect(ada?.book_id).toBe(books[0].id)

    const book = await getCarddavBook(executor, books[0].id)
    expect(book?.syncToken).toBe("urn:sync:1")
    expect(book?.ctag).toBe("CTAG-1")
    expect(book?.lastSyncedAt).not.toBeNull()
    expect(book?.lastError).toBeNull()
  })

  it("adopts a local row with the same email instead of duplicating it", async () => {
    await executor.execute(
      `INSERT INTO contacts (id, account_id, email, name, notes)
       VALUES ('local-1', $1, 'ada@example.test', 'Ada', 'my own notes')`,
      [accountId]
    )
    routeInvoke(() =>
      syncResponse({
        mode: "full",
        token: "urn:sync:2",
        cards: [
          {
            href: `${BOOK_HREF}ada.vcf`,
            etag: '"a2"',
            vcard: cardVcard("uid-ada", "Ada Lovelace", "ada@example.test"),
            uid: "uid-ada",
            fullName: "Ada Lovelace",
            email: "ada@example.test",
            note: "server note",
          },
        ],
      })
    )

    const books = await listCarddavBooks(executor)
    await syncCarddavBook(executor, books[0])

    const contacts = await listAllContacts(executor)
    expect(contacts).toHaveLength(1)
    expect(contacts[0].id).toBe("local-1")
    expect(contacts[0].source).toBe("carddav")
    expect(contacts[0].uid).toBe("uid-ada")
    expect(contacts[0].name).toBe("Ada Lovelace")
    // The user's own notes survive adoption (data the card cannot know).
    expect(contacts[0].notes).toBe("my own notes")
  })

  it("incremental sync passes the stored cursors and known etags, applies changes and removals", async () => {
    const seededId = await seedSyncedContact(executor, accountId, "book-1", {
      email: "keep@example.test",
      uid: "uid-keep",
      href: `${BOOK_HREF}keep.vcf`,
      etag: '"same"',
    })
    await seedSyncedContact(executor, accountId, "book-1", {
      email: "gone@example.test",
      uid: "uid-gone",
      href: `${BOOK_HREF}gone.vcf`,
      etag: '"old"',
    })

    routeInvoke((_command, args) => {
      expect(args.syncToken).toBe("urn:sync:1")
      expect(args.ctag).toBe("CTAG-1")
      const known = args.knownCards as { href: string; etag: string }[]
      expect(known).toHaveLength(2)
      expect(known.map((entry) => entry.href).sort()).toEqual([
        `${BOOK_HREF}gone.vcf`,
        `${BOOK_HREF}keep.vcf`,
      ])
      return syncResponse({
        mode: "delta",
        token: "urn:sync:2",
        ctag: "CTAG-2",
        cards: [
          {
            href: `${BOOK_HREF}keep.vcf`,
            etag: '"new"',
            vcard: cardVcard("uid-keep", "Keep Renamed", "keep@example.test"),
            uid: "uid-keep",
            fullName: "Keep Renamed",
            email: "keep@example.test",
          },
        ],
        removed: [`${BOOK_HREF}gone.vcf`],
      })
    })

    // Give the book stored cursors (an earlier sync happened).
    await executor.execute(
      "UPDATE carddav_books SET sync_token = 'urn:sync:1', ctag = 'CTAG-1' WHERE id = 'book-1'"
    )
    const books = await listCarddavBooks(executor)
    const result = await syncCarddavBook(executor, books[0])
    expect(result.mode).toBe("delta")
    expect(result.stored).toBe(1)
    expect(result.removed).toBe(1)

    const updated = await getContact(executor, seededId)
    expect(updated?.name).toBe("Keep Renamed")
    expect(updated?.etag).toBe('"new"')
    const gone = await executor.select<unknown>(
      "SELECT * FROM contacts WHERE uid = 'uid-gone'"
    )
    expect(gone).toHaveLength(0)
  })

  it("ctag short-circuit ('unchanged') keeps contacts and skip counts untouched", async () => {
    await seedSyncedContact(executor, accountId, "book-1", { uid: "uid-1" })
    await executor.execute(
      "UPDATE carddav_books SET sync_token = 't', ctag = 'CTAG-1', last_skipped = 2 WHERE id = 'book-1'"
    )
    routeInvoke(() =>
      syncResponse({ mode: "unchanged", token: "t", ctag: "CTAG-1" })
    )
    const books = await listCarddavBooks(executor)
    const result = await syncCarddavBook(executor, books[0])
    expect(result.mode).toBe("unchanged")
    const contacts = await executor.select<unknown>(
      "SELECT * FROM contacts WHERE book_id = 'book-1'"
    )
    expect(contacts).toHaveLength(1)
    const book = await getCarddavBook(executor, "book-1")
    expect(book?.lastSkipped).toBe(2)
    expect(book?.lastSyncedAt).not.toBeNull()
  })

  it("records the skipped count from the pass", async () => {
    routeInvoke(() =>
      syncResponse({
        mode: "full",
        token: "t",
        cards: [
          {
            href: `${BOOK_HREF}ok.vcf`,
            etag: '"ok"',
            vcard: cardVcard("uid-ok", "Ok", "ok@example.test"),
            uid: "uid-ok",
            fullName: "Ok",
            email: "ok@example.test",
          },
        ],
        skipped: 3,
      })
    )
    const books = await listCarddavBooks(executor)
    const result = await syncCarddavBook(executor, books[0])
    expect(result.skipped).toBe(3)
    const book = await getCarddavBook(executor, "book-1")
    expect(book?.lastSkipped).toBe(3)
  })

  it("a failed pass records the error and NEVER deletes the local contacts", async () => {
    await seedSyncedContact(executor, accountId, "book-1", { uid: "uid-1" })
    rejectInvokeWith({
      kind: "status",
      message: "the CardDAV server returned HTTP 500",
      status: 500,
    })
    const books = await listCarddavBooks(executor)
    await expect(syncCarddavBook(executor, books[0])).rejects.toThrow(
      /HTTP 500/
    )
    const book = await getCarddavBook(executor, "book-1")
    expect(book?.lastError).toContain("HTTP 500")
    expect(book?.lastSyncedAt).toBeNull()
    const contacts = await executor.select<unknown>(
      "SELECT * FROM contacts WHERE book_id = 'book-1'"
    )
    expect(contacts).toHaveLength(1)
  })
})

describe("carddav write-back", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    setDefaultKeyStore(createInMemoryKeyStore())
    accountId = await seedBook(executor)
  })

  afterEach(() => {
    executor.close()
    vi.resetAllMocks()
  })

  it("pushes an edit with the stored etag + raw card and records the fresh state", async () => {
    const contactId = await seedSyncedContact(executor, accountId, "book-1", {
      email: "ada@example.test",
      name: "Ada",
      uid: "uid-ada",
      etag: '"old"',
    })

    routeInvoke((command, args) => {
      expect(command).toBe("carddav_put_card")
      expect(args.href).toBe(`${BOOK_HREF}seeded.vcf`)
      // The If-Match precondition rides on the STORED etag; the raw card
      // is what the server holds (unknown lines preserved Rust-side).
      expect(args.existingEtag).toBe('"old"')
      expect(args.existingVcard).toContain("UID:uid-ada")
      expect(args.name).toBe("Ada Lovelace")
      expect(args.note).toBe("updated note")
      return {
        href: `${BOOK_HREF}seeded.vcf`,
        etag: '"new"',
        vcard: cardVcard("uid-ada", "Ada Lovelace", "ada@example.test"),
      }
    })

    await pushContactEdit(executor, contactId, {
      name: "Ada Lovelace",
      notes: "updated note",
    })
    const updated = await getContact(executor, contactId)
    expect(updated?.name).toBe("Ada Lovelace")
    expect(updated?.notes).toBe("updated note")
    expect(updated?.etag).toBe('"new"')
  })

  it("is a no-op for local contacts (no server push)", async () => {
    await executor.execute(
      "INSERT INTO contacts (id, account_id, email) VALUES ('local-1', $1, 'x@y.z')",
      [accountId]
    )
    let called = 0
    routeInvoke(() => {
      called += 1
      return {}
    })
    await pushContactEdit(executor, "local-1", { name: "X" })
    expect(called).toBe(0)
  })

  it("marks the book read-only on a 403 write rejection and rethrows", async () => {
    const contactId = await seedSyncedContact(executor, accountId, "book-1", {
      uid: "uid-ada",
    })
    rejectInvokeWith({
      kind: "status",
      message: "the server refused the change (HTTP 403)",
      status: 403,
    })
    await expect(
      pushContactEdit(executor, contactId, { name: "X" })
    ).rejects.toThrow(/403/)
    const book = await getCarddavBook(executor, "book-1")
    expect(book?.readOnly).toBe(true)
    // The local edit stays applied (converges on the next sync).
    const contact = await getContact(executor, contactId)
    expect(contact).not.toBeNull()
  })

  it("creates a new contact server-side first (v3 card, urn:uuid uid), then locally", async () => {
    routeInvoke((command, args) => {
      expect(command).toBe("carddav_put_card")
      expect(args.uid).toMatch(/^urn:uuid:/)
      expect(args.email).toBe("new@example.test")
      expect(args.href).toBeNull()
      expect(args.existingVcard).toBeNull()
      expect(args.name).toBe("New Person")
      return {
        href: `${BOOK_HREF}urn-uuid-new.vcf`,
        etag: '"created"',
        vcard: cardVcard(args.uid as string, "New Person", "new@example.test"),
      }
    })
    const created = await pushNewContact(executor, "book-1", {
      email: "New@Example.test",
      name: "New Person",
      notes: null,
    })
    expect(created.source).toBe("carddav")
    expect(created.email).toBe("new@example.test")
    expect(created.etag).toBe('"created"')
    expect(created.uid).toMatch(/^urn:uuid:/)
  })

  it("deletes server-side then locally; a failed push keeps the row", async () => {
    const contactId = await seedSyncedContact(executor, accountId, "book-1", {
      uid: "uid-ada",
      etag: '"etag"',
    })
    routeInvoke((command, args) => {
      expect(command).toBe("carddav_delete_card")
      expect(args.href).toBe(`${BOOK_HREF}seeded.vcf`)
      expect(args.etag).toBe('"etag"')
      return null
    })
    await deleteCarddavContact(executor, contactId)
    expect(await getContact(executor, contactId)).toBeNull()

    // A failed server delete keeps the local row (no silent resurrection
    // on the next sync).
    const secondId = await seedSyncedContact(executor, accountId, "book-1", {
      uid: "uid-b",
      href: `${BOOK_HREF}b.vcf`,
    })
    rejectInvokeWith({
      kind: "status",
      message: "the CardDAV server returned HTTP 500",
      status: 500,
    })
    await expect(deleteCarddavContact(executor, secondId)).rejects.toThrow()
    expect(await getContact(executor, secondId)).not.toBeNull()
  })

  it("disconnect removes the book and its synced contacts", async () => {
    await seedSyncedContact(executor, accountId, "book-1", { uid: "uid-1" })
    const result = await disconnectCarddavBook(executor, "book-1")
    expect(result.contactsDeleted).toBe(1)
    expect(await getCarddavBook(executor, "book-1")).toBeNull()
    const contacts = await executor.select<unknown>(
      "SELECT * FROM contacts WHERE book_id = 'book-1'"
    )
    expect(contacts).toHaveLength(0)
  })
})
