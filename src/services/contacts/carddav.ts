import { invoke } from "@tauri-apps/api/core"

import { decryptCredentials, encryptCredentials } from "../crypto/credentials"
import type { SqlExecutor } from "../db/executor"
import {
  addCarddavBook,
  getCarddavBook,
  removeCarddavBook,
  updateCarddavBookSyncState,
} from "../db/carddav-books"
import type { CarddavBook } from "../db/carddav-books"
import { getContact, type ContactRow } from "../db/contacts"

/**
 * CardDAV sync service (parity-round-2 tasks 4.2/4.3, design D4) — the
 * TS half of the Rust CardDAV client, mapping server cards onto the
 * contacts table. Mirrors `services/calendar/caldav.ts`: a thin typed
 * wrapper over the `carddav_*` commands plus the persistence half.
 *
 * Credential flow (the enforced contract): the book's credentials
 * envelope is SEALED (`encryptCredentials`, AES-256-GCM — the accounts
 * pattern). For every command call this module unseals it and passes the
 * PLAINTEXT username + app password for THAT call. Plaintext credentials
 * are never persisted, never logged (nothing here logs arguments), and
 * the Rust side scrubs them from every error message. The sealed-password
 * note in the settings UI is exactly this contract.
 *
 * Sync flow (checklist): `carddav_sync_book` runs the whole server-side
 * pass — ctag short-circuit, sync-collection REPORT with the stored token
 * (empty token = initial state), `valid-sync-token` fallback to the
 * FN-filtered `addressbook-query` full pull, etag diff, and batched
 * `addressbook-multiget` fetches. This module stores the cursors, upserts
 * the mapped cards (server cards are keyed by (book, uid); a local row
 * with the same email is ADOPTED — one person one row), applies the
 * reported removals, and records the pass outcome for the status line.
 * Removals apply only after the pass succeeded, so a failed pass can
 * never delete a local contact.
 *
 * Write-back flow (spec "Edits … write back; last write wins"): an edit
 * pushes the RAW card with the new name/note swapped in (the Rust side
 * preserves every line the UI does not show) guarded by `If-Match` when
 * an ETag is stored. A 412 resolves as LAST-WRITE-WINS: the Rust side
 * refetches a fresh ETag and re-PUTs the local version, so the local edit
 * always converges onto the server. A 403 marks the book read-only (the
 * server refused the write; sync continues). Deletions push a DELETE
 * (404 tolerated) before the local row goes.
 */

/** The unsealed book credentials living inside the sealed envelope. */
export interface CarddavCredentials {
  /** The CardDAV server root the user entered (https except loopback). */
  serverUrl: string
  username: string
  appPassword: string
}

/** One discovered address book (wire shape: Rust snake_case). */
export interface CarddavDiscoveredBook {
  /** Absolute collection URL — stored as the book URL. */
  href: string
  displayName?: string
  readOnly?: boolean
  ctag?: string
}

interface CarddavDiscoveredBookWire {
  href: string
  display_name?: string
  read_only?: boolean
  ctag?: string
}

interface CarddavSyncCardWire {
  href: string
  etag: string
  vcard: string
  uid: string
  full_name: string
  email: string
  note?: string
}

interface CarddavSyncResponseWire {
  mode: "unchanged" | "full" | "delta"
  next_sync_token: string | null
  ctag?: string
  cards: CarddavSyncCardWire[]
  removed: string[]
  skipped: number
}

interface CarddavPutResponseWire {
  href: string
  etag: string
  vcard: string
}

/** The CardDAV command failure kinds (the Rust `CarddavCommandError`).
 * `auth` is the typed needs-reauth error (HTTP 401 anywhere in a flow). */
export type CarddavErrorKind = "network" | "status" | "auth" | "parse" | "config"

/**
 * A CardDAV command failure with its specific reason: `auth` → reconnect
 * the book (wrong credentials), `status` carries the HTTP status (403 →
 * the book is probably read-only, 3xx → fix the URL — redirects are not
 * followed). The message is the Rust-side, credential-redacted text.
 */
export class CarddavProviderError extends Error {
  readonly kind: CarddavErrorKind
  readonly status?: number

  constructor(kind: CarddavErrorKind, message: string, status?: number) {
    super(message)
    this.name = "CarddavProviderError"
    this.kind = kind
    if (status !== undefined) this.status = status
  }
}

function isCarddavErrorKind(value: string): value is CarddavErrorKind {
  return (
    value === "network" ||
    value === "status" ||
    value === "auth" ||
    value === "parse" ||
    value === "config"
  )
}

/** Normalize a `carddav_*` rejection into a `CarddavProviderError`. */
function normalizeCarddavError(thrown: unknown): CarddavProviderError {
  if (thrown instanceof CarddavProviderError) return thrown
  if (typeof thrown === "object" && thrown !== null) {
    const candidate = thrown as Record<string, unknown>
    if (
      typeof candidate.kind === "string" &&
      isCarddavErrorKind(candidate.kind) &&
      typeof candidate.message === "string"
    ) {
      return new CarddavProviderError(
        candidate.kind,
        candidate.message,
        typeof candidate.status === "number" ? candidate.status : undefined
      )
    }
  }
  // An IPC-level failure (non-Tauri runtime, …): transport did not
  // complete.
  return new CarddavProviderError(
    "network",
    thrown instanceof Error ? thrown.message : String(thrown)
  )
}

// ---------------------------------------------------------------------------
// Command wrappers (thin — the protocol lives Rust-side)
// ---------------------------------------------------------------------------

/** Discover the address books reachable from the server. */
export async function discoverCarddavBooks(
  credentials: CarddavCredentials
): Promise<CarddavDiscoveredBook[]> {
  let response: { books: CarddavDiscoveredBookWire[] }
  try {
    response = await invoke<{ books: CarddavDiscoveredBookWire[] }>(
      "carddav_discover_books",
      {
        serverUrl: credentials.serverUrl,
        username: credentials.username,
        appPassword: credentials.appPassword,
      }
    )
  } catch (thrown) {
    throw normalizeCarddavError(thrown)
  }
  return response.books.map((book) => ({
    href: book.href,
    displayName: book.display_name,
    readOnly: book.read_only,
    ctag: book.ctag,
  }))
}

/** The raw sync pass over one book (the `carddav_sync_book` command). */
export interface CarddavSyncPage {
  mode: "unchanged" | "full" | "delta"
  nextSyncToken: string | null
  ctag: string | null
  cards: {
    href: string
    etag: string
    vcard: string
    uid: string
    fullName: string
    email: string
    note: string | null
  }[]
  removed: string[]
  skipped: number
}

/** Run one sync pass for a book (a discovery href). */
export async function syncCarddavBookCommand(
  credentials: CarddavCredentials,
  input: {
    bookUrl: string
    syncToken: string | null
    ctag: string | null
    knownCards: { href: string; etag: string | null }[]
  }
): Promise<CarddavSyncPage> {
  let response: CarddavSyncResponseWire
  try {
    response = await invoke<CarddavSyncResponseWire>("carddav_sync_book", {
      serverUrl: credentials.serverUrl,
      username: credentials.username,
      appPassword: credentials.appPassword,
      bookUrl: input.bookUrl,
      syncToken: input.syncToken,
      ctag: input.ctag,
      knownCards: input.knownCards,
    })
  } catch (thrown) {
    throw normalizeCarddavError(thrown)
  }
  return {
    mode: response.mode,
    nextSyncToken: response.next_sync_token,
    ctag: response.ctag ?? null,
    cards: response.cards.map((card) => ({
      href: card.href,
      etag: card.etag,
      vcard: card.vcard,
      uid: card.uid,
      fullName: card.full_name,
      email: card.email,
      note: card.note ?? null,
    })),
    removed: response.removed,
    skipped: response.skipped,
  }
}

/** Create or update one card (the etag-disciplined PUT). */
export async function putCarddavCard(
  credentials: CarddavCredentials,
  input: {
    bookUrl: string
    /** CREATE: uid + email (serialized fresh as vCard 3.0,
     * `If-None-Match: *`). UPDATE: href + existing vcard (+ etag). */
    uid?: string
    email?: string
    href?: string
    existingVcard?: string
    existingEtag?: string | null
    name: string
    note: string | null
  }
): Promise<{ href: string; etag: string; vcard: string }> {
  let response: CarddavPutResponseWire
  try {
    response = await invoke<CarddavPutResponseWire>("carddav_put_card", {
      serverUrl: credentials.serverUrl,
      username: credentials.username,
      appPassword: credentials.appPassword,
      bookUrl: input.bookUrl,
      name: input.name,
      note: input.note,
      email: input.email ?? null,
      uid: input.uid ?? null,
      href: input.href ?? null,
      existingVcard: input.existingVcard ?? null,
      existingEtag: input.existingEtag ?? null,
    })
  } catch (thrown) {
    throw normalizeCarddavError(thrown)
  }
  return response
}

/** Delete one card. A 404 is tolerated Rust-side (already gone). */
export async function deleteCarddavCard(
  credentials: CarddavCredentials,
  input: { href: string; etag: string | null }
): Promise<void> {
  try {
    await invoke("carddav_delete_card", {
      serverUrl: credentials.serverUrl,
      username: credentials.username,
      appPassword: credentials.appPassword,
      href: input.href,
      etag: input.etag,
    })
  } catch (thrown) {
    throw normalizeCarddavError(thrown)
  }
}

/** Unseal a book's credentials envelope for one command call; null when
 * the envelope is missing or unreadable (the book needs re-connecting). */
export async function unsealCarddavConfig(
  book: Pick<CarddavBook, "baseUrl" | "username" | "credentialsJson">
): Promise<CarddavCredentials | null> {
  try {
    const envelope = await decryptCredentials<CarddavCredentials>(
      book.credentialsJson
    )
    if (envelope?.serverUrl && envelope.username && envelope.appPassword) {
      return envelope
    }
    return null
  } catch {
    return null
  }
}

async function requireCredentials(book: CarddavBook): Promise<CarddavCredentials> {
  const credentials = await unsealCarddavConfig(book)
  if (!credentials) {
    throw new CarddavProviderError(
      "auth",
      "No stored CardDAV connection details for this book; reconnect it"
    )
  }
  return credentials
}

// ---------------------------------------------------------------------------
// Connect / disconnect
// ---------------------------------------------------------------------------

export interface ConnectCarddavBookInput {
  serverUrl: string
  username: string
  appPassword: string
  /** The mail account the book syncs into (contacts rows are
   * account-scoped; autocomplete is per-account). */
  accountId: string
  /** The discovered book the user picked. */
  book: CarddavDiscoveredBook
  /** Overrides the book's display name (default: its discovered name). */
  name?: string
}

/**
 * Persist a new CardDAV book: the connection details are SEALED into the
 * credentials envelope (encryptCredentials — sealing point; plaintext
 * credentials exist only in memory before this call and only as
 * ciphertext afterwards). Nothing is persisted before the caller has
 * discovered — the UI drives that order.
 */
export async function connectCarddavBook(
  executor: SqlExecutor,
  input: ConnectCarddavBookInput
): Promise<CarddavBook> {
  const credentialsJson = await encryptCredentials({
    serverUrl: input.serverUrl,
    username: input.username,
    appPassword: input.appPassword,
  })
  const id = crypto.randomUUID()
  await addCarddavBook(executor, {
    id,
    accountId: input.accountId,
    baseUrl: input.serverUrl,
    bookUrl: input.book.href,
    username: input.username,
    credentialsJson,
    name: input.name ?? input.book.displayName ?? input.username,
    readOnly: input.book.readOnly === true,
    ctag: input.book.ctag ?? null,
  })
  const book = await getCarddavBook(executor, id)
  if (!book) {
    // addCarddavBook inserting then the row being unreadable cannot
    // happen short of a storage failure — fail loudly rather than return
    // a half-formed book.
    throw new Error("the connected CardDAV book could not be reloaded")
  }
  return book
}

/**
 * Disconnect one book after the UI's confirm: removes the book AND its
 * synced contacts (the mail account is never touched). Returns the
 * number of contacts removed.
 */
export async function disconnectCarddavBook(
  executor: SqlExecutor,
  bookId: string
): Promise<{ contactsDeleted: number }> {
  return removeCarddavBook(executor, bookId)
}

// ---------------------------------------------------------------------------
// Sync: server cards → contacts rows
// ---------------------------------------------------------------------------

/** One book's sync result for the status line. */
export interface CarddavBookSyncResult {
  mode: "unchanged" | "delta" | "full"
  stored: number
  removed: number
  skipped: number
}

function seconds(date: Date): number {
  return Math.floor(date.getTime() / 1000)
}

/**
 * Upsert one server card into the contacts table. Keyed by (book, uid);
 * when no row carries that uid yet, a LOCAL row with the same
 * (account, email) is ADOPTED — one person stays one row and the synced
 * card takes over its provenance. Adoption keeps the local notes if the
 * user had written any (data the card cannot know about); afterwards the
 * card's NOTE is canonical and round-trips through write-back.
 */
async function upsertSyncedCard(
  executor: SqlExecutor,
  book: CarddavBook,
  card: CarddavSyncPage["cards"][number]
): Promise<void> {
  const byUid = await executor.select<ContactRow>(
    "SELECT * FROM contacts WHERE book_id = $1 AND uid = $2 LIMIT 1",
    [book.id, card.uid]
  )
  if (byUid[0]) {
    await executor.execute(
      `UPDATE contacts SET
         email = $1, name = $2, notes = $3, href = $4, etag = $5,
         carddav_raw = $6
       WHERE id = $7`,
      [
        card.email,
        card.fullName,
        card.note,
        card.href,
        card.etag,
        card.vcard,
        byUid[0].id,
      ]
    )
    return
  }

  const byEmail = await executor.select<ContactRow>(
    "SELECT * FROM contacts WHERE account_id = $1 AND email = $2 LIMIT 1",
    [book.accountId, card.email]
  )
  if (byEmail[0]) {
    // Adopt the local row: the card's fields take over, but the user's
    // own notes survive (COALESCE keeps them when present — data the
    // card cannot know about; afterwards the card's NOTE round-trips).
    await executor.execute(
      `UPDATE contacts SET
         source = 'carddav', uid = $1, href = $2, etag = $3,
         carddav_raw = $4, name = $5,
         notes = COALESCE(notes, $6)
       WHERE id = $7`,
      [
        card.uid,
        card.href,
        card.etag,
        card.vcard,
        card.fullName,
        card.note,
        byEmail[0].id,
      ]
    )
    return
  }

  await executor.execute(
    `INSERT INTO contacts (
       id, account_id, email, name, notes, interaction_count,
       source, uid, href, etag, carddav_raw, book_id
     ) VALUES ($1, $2, $3, $4, $5, 0, 'carddav', $6, $7, $8, $9, $10)`,
    [
      crypto.randomUUID(),
      book.accountId,
      card.email,
      card.fullName,
      card.note,
      card.uid,
      card.href,
      card.etag,
      card.vcard,
      book.id,
    ]
  )
}

/**
 * Sync one stored book (the settings "Sync now" path and the connect
 * flow's initial pull): unseals the envelope (the per-call credential
 * contract — module comment), runs one `carddav_sync_book` pass with the
 * stored cursors and the locally known {href, etag} set, upserts the
 * returned cards, applies removals, and persists the fresh cursors +
 * outcome for the status line. Failures are recorded on the book row
 * (last_error) and rethrown so the UI can show the specific reason.
 */
export async function syncCarddavBook(
  executor: SqlExecutor,
  book: CarddavBook
): Promise<CarddavBookSyncResult> {
  const credentials = await requireCredentials(book)
  const known = await executor.select<{ href: string; etag: string | null }>(
    "SELECT href, etag FROM contacts WHERE book_id = $1 AND href IS NOT NULL",
    [book.id]
  )

  try {
    const page = await syncCarddavBookCommand(credentials, {
      bookUrl: book.bookUrl,
      syncToken: book.syncToken,
      ctag: book.ctag,
      knownCards: known.map((row) => ({
        href: row.href,
        etag: row.etag,
      })),
    })

    let stored = 0
    if (page.mode !== "unchanged") {
      for (const card of page.cards) {
        await upsertSyncedCard(executor, book, card)
        stored += 1
      }
      let removed = 0
      for (const href of page.removed) {
        removed += await executor
          .execute("DELETE FROM contacts WHERE book_id = $1 AND href = $2", [
            book.id,
            href,
          ])
          .then((result) => result.rowsAffected)
      }
      await updateCarddavBookSyncState(executor, book.id, {
        syncToken: page.nextSyncToken,
        ctag: page.ctag,
        lastSyncedAt: seconds(new Date()),
        lastError: null,
        lastSkipped: page.skipped,
      })
      return { mode: page.mode, stored, removed, skipped: page.skipped }
    }

    // ctag short-circuit: nothing changed server-side. Keep the stored
    // cursors and the previous skip count; only touch the timestamp.
    await updateCarddavBookSyncState(executor, book.id, {
      lastSyncedAt: seconds(new Date()),
      lastError: null,
    })
    return { mode: page.mode, stored: 0, removed: 0, skipped: 0 }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await updateCarddavBookSyncState(executor, book.id, {
      lastError: message,
    })
    throw error
  }
}

// ---------------------------------------------------------------------------
// Write-back: local edits push to the server (last write wins)
// ---------------------------------------------------------------------------

/** The contact's editable projection — exactly what the UI edits. */
export interface ContactEditInput {
  name: string
  notes: string | null
}

/**
 * Push one carddav-sourced contact's edit to the server and record the
 * outcome on the row. No-op for local contacts (the caller checks
 * `source` only for the error contract — this function is safe to call
 * with any contact id). Failures rethrow AFTER marking the book
 * read-only on a 403; the local edit stays applied either way (the next
 * successful sync converges — last write wins on both sides).
 */
export async function pushContactEdit(
  executor: SqlExecutor,
  contactId: string,
  patch: Partial<ContactEditInput>
): Promise<void> {
  const contact = await getContact(executor, contactId)
  if (!contact) return
  if (contact.source !== "carddav") return
  if (!contact.href || !contact.carddav_raw || !contact.book_id) return
  const book = await getCarddavBook(executor, contact.book_id)
  if (!book) return
  const credentials = await requireCredentials(book)

  const name = patch.name ?? contact.name ?? contact.email
  const note = patch.notes !== undefined ? patch.notes : contact.notes

  try {
    const response = await putCarddavCard(credentials, {
      bookUrl: book.bookUrl,
      href: contact.href,
      existingVcard: contact.carddav_raw,
      existingEtag: contact.etag,
      name,
      note,
    })
    await executor.execute(
      `UPDATE contacts SET name = $1, notes = $2, href = $3, etag = $4,
         carddav_raw = $5
       WHERE id = $6`,
      [name, note, response.href, response.etag, response.vcard, contact.id]
    )
  } catch (error) {
    if (error instanceof CarddavProviderError && error.status === 403) {
      // The server refuses writes on this book — record it so the
      // settings status line warns and future edits fail fast, but do
      // not fail the book itself.
      await updateCarddavBookSyncState(executor, book.id, {
        readOnly: true,
      })
    }
    throw error
  }
}

/**
 * Create a brand-new contact ON THE SERVER and store the synced row:
 * the card is serialized fresh as vCard 3.0 with a generated
 * `urn:uuid:` UID and PUT with `If-None-Match: *`. The local row lands
 * ONLY after the server write succeeded (online-write semantics — the
 * same posture as the CalDAV event writes).
 */
export async function pushNewContact(
  executor: SqlExecutor,
  bookId: string,
  input: ContactEditInput & { email: string }
): Promise<ContactRow> {
  const book = await getCarddavBook(executor, bookId)
  if (!book) {
    throw new CarddavProviderError("config", "the address book no longer exists")
  }
  const credentials = await requireCredentials(book)
  const email = input.email.trim().toLowerCase()
  const uid = `urn:uuid:${crypto.randomUUID()}`
  const response = await putCarddavCard(credentials, {
    bookUrl: book.bookUrl,
    uid,
    email,
    name: input.name,
    note: input.notes,
  })
  const id = crypto.randomUUID()
  await executor.execute(
    `INSERT INTO contacts (
       id, account_id, email, name, notes, interaction_count,
       source, uid, href, etag, carddav_raw, book_id
     ) VALUES ($1, $2, $3, $4, $5, 0, 'carddav', $6, $7, $8, $9, $10)`,
    [
      id,
      book.accountId,
      email,
      input.name,
      input.notes,
      uid,
      response.href,
      response.etag,
      response.vcard,
      book.id,
    ]
  )
  const stored = await getContact(executor, id)
  if (!stored) throw new Error("the created contact could not be reloaded")
  return stored
}

/**
 * Delete a carddav-sourced contact: the server DELETE goes first (404
 * counts as already-gone; a 403 marks the book read-only and rethrows),
 * and the local row is removed only after the server confirmed — a
 * failed delete keeps the row (a silent local-only delete would
 * resurrect on the next sync). Local contacts are a no-op here.
 */
export async function deleteCarddavContact(
  executor: SqlExecutor,
  contactId: string
): Promise<void> {
  const contact = await getContact(executor, contactId)
  if (!contact) return
  if (contact.source !== "carddav") return
  if (!contact.href || !contact.book_id) {
    // A partially-synced row: nothing (sane) to delete server-side —
    // drop the row.
    await executor.execute("DELETE FROM contacts WHERE id = $1", [contact.id])
    return
  }
  const book = await getCarddavBook(executor, contact.book_id)
  if (!book) {
    // The book is gone (or never finished connecting): the row is
    // orphaned — dropping it is the honest state.
    await executor.execute("DELETE FROM contacts WHERE id = $1", [contact.id])
    return
  }
  const credentials = await requireCredentials(book)
  try {
    await deleteCarddavCard(credentials, {
      href: contact.href,
      etag: contact.etag,
    })
  } catch (error) {
    if (error instanceof CarddavProviderError && error.status === 403) {
      await updateCarddavBookSyncState(executor, book.id, {
        readOnly: true,
      })
    }
    throw error
  }
  await executor.execute("DELETE FROM contacts WHERE id = $1", [contact.id])
}
