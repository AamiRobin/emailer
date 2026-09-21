import type { SqlExecutor } from "./executor"

/**
 * CardDAV book CRUD (parity-round-2 task 4.2, design D4) — the
 * address-book counterpart of calendar/sources.ts. One row per connected
 * CardDAV address book, each connectable and removable independently.
 *
 * Secrets live ONLY in the AES-GCM sealed `credentials_json` envelope
 * (produced by crypto/credentials encryptCredentials — the
 * accounts.credentials_json / calendar-sources pattern). The envelope
 * carries the app password; plaintext is never persisted and never
 * logged. `sync_token` / `ctag` / `last_synced_at` / `last_error` /
 * `last_skipped` deliberately hold only sync bookkeeping — not secrets —
 * so the sync loop updates them without a decrypt/encrypt round-trip.
 *
 * `account_id` ties the book to the mail account whose address book it
 * syncs INTO: contacts rows are account-scoped (UNIQUE(account_id,
 * email)) and compose autocomplete is per-account, so synced contacts
 * must live under an account to behave identically to local ones.
 * Deleting the mail account cascades the book (and its synced contacts
 * through the contacts.book_id cascade). Disconnecting the book removes
 * the book AND its synced contacts with a confirm (see the settings
 * section) — the explicit two-step delete mirrors removeCalendarSource's
 * invariant-first ordering.
 */

/** carddav_books row as stored (snake_case columns). */
export interface CarddavBookRow {
  id: string
  account_id: string
  base_url: string
  book_url: string
  username: string
  /** SEALED envelope (encryptCredentials output) — opaque here. */
  credentials_json: string
  name: string
  sync_token: string | null
  ctag: string | null
  read_only: number
  last_synced_at: number | null
  last_error: string | null
  last_skipped: number | null
  created_at: number
}

/** Decoded book (camelCase; credentials kept sealed as ciphertext). */
export interface CarddavBook {
  id: string
  accountId: string
  /** The server root the user entered — every command takes it. */
  baseUrl: string
  /** The discovered address-book collection URL (the sync target). */
  bookUrl: string
  username: string
  /** The SEALED credentials envelope ciphertext — only
   * crypto/credentials may open this. */
  credentialsJson: string
  name: string
  syncToken: string | null
  ctag: string | null
  readOnly: boolean
  lastSyncedAt: number | null
  lastError: string | null
  /** Cards the last pass skipped (parse failures / over the cap). */
  lastSkipped: number | null
  createdAt: number
}

const COLUMNS =
  "id, account_id, base_url, book_url, username, credentials_json, name, " +
  "sync_token, ctag, read_only, last_synced_at, last_error, last_skipped, " +
  "created_at"

function toBook(row: CarddavBookRow): CarddavBook {
  return {
    id: row.id,
    accountId: row.account_id,
    baseUrl: row.base_url,
    bookUrl: row.book_url,
    username: row.username,
    credentialsJson: row.credentials_json,
    name: row.name,
    syncToken: row.sync_token,
    ctag: row.ctag,
    readOnly: row.read_only === 1,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
    lastSkipped: row.last_skipped,
    createdAt: row.created_at,
  }
}

export async function listCarddavBooks(executor: SqlExecutor): Promise<CarddavBook[]> {
  const rows = await executor.select<CarddavBookRow>(
    `SELECT ${COLUMNS} FROM carddav_books ORDER BY created_at ASC, id ASC`
  )
  return rows.map(toBook)
}

export async function listCarddavBooksForAccount(
  executor: SqlExecutor,
  accountId: string
): Promise<CarddavBook[]> {
  const rows = await executor.select<CarddavBookRow>(
    `SELECT ${COLUMNS} FROM carddav_books WHERE account_id = $1 ORDER BY created_at ASC, id ASC`,
    [accountId]
  )
  return rows.map(toBook)
}

export async function getCarddavBook(
  executor: SqlExecutor,
  id: string
): Promise<CarddavBook | null> {
  const rows = await executor.select<CarddavBookRow>(
    `SELECT ${COLUMNS} FROM carddav_books WHERE id = $1`,
    [id]
  )
  return rows[0] ? toBook(rows[0]) : null
}

export interface AddCarddavBookInput {
  id: string
  accountId: string
  baseUrl: string
  bookUrl: string
  username: string
  /** SEALED credentials envelope (encryptCredentials output). */
  credentialsJson: string
  name: string
  /** Discovered book state, stored at connect time. */
  readOnly?: boolean
  ctag?: string | null
}

/** Insert a new book. Callers must pass an already-sealed credentials
 * envelope — this module never builds or logs envelope contents. */
export async function addCarddavBook(
  executor: SqlExecutor,
  input: AddCarddavBookInput
): Promise<void> {
  await executor.execute(
    `INSERT INTO carddav_books (
       id, account_id, base_url, book_url, username, credentials_json,
       name, read_only, ctag
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      input.id,
      input.accountId,
      input.baseUrl,
      input.bookUrl,
      input.username,
      input.credentialsJson,
      input.name,
      input.readOnly ? 1 : 0,
      input.ctag ?? null,
    ]
  )
}

/** Persist one pass's outcome (cursor + bookkeeping) on the book row. */
export async function updateCarddavBookSyncState(
  executor: SqlExecutor,
  id: string,
  patch: {
    syncToken?: string | null
    ctag?: string | null
    lastSyncedAt?: number | null
    lastError?: string | null
    lastSkipped?: number | null
    readOnly?: boolean
  }
): Promise<void> {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.syncToken !== undefined) {
    params.push(patch.syncToken)
    sets.push(`sync_token = $${params.length}`)
  }
  if (patch.ctag !== undefined) {
    params.push(patch.ctag)
    sets.push(`ctag = $${params.length}`)
  }
  if (patch.lastSyncedAt !== undefined) {
    params.push(patch.lastSyncedAt)
    sets.push(`last_synced_at = $${params.length}`)
  }
  if (patch.lastError !== undefined) {
    params.push(patch.lastError)
    sets.push(`last_error = $${params.length}`)
  }
  if (patch.lastSkipped !== undefined) {
    params.push(patch.lastSkipped)
    sets.push(`last_skipped = $${params.length}`)
  }
  if (patch.readOnly !== undefined) {
    params.push(patch.readOnly ? 1 : 0)
    sets.push(`read_only = $${params.length}`)
  }
  if (!sets.length) return
  params.push(id)
  await executor.execute(
    `UPDATE carddav_books SET ${sets.join(", ")} WHERE id = $${params.length}`,
    params
  )
}

/**
 * Disconnect one book (the confirmed disconnect): removes its synced
 * contacts FIRST, then the book row — the removeCalendarSource ordering,
 * so a crash in between can only leave a book with zero synced contacts,
 * never orphaned carddav-sourced rows pointing at a missing book. (The
 * schema also carries ON DELETE CASCADE on contacts.book_id; the explicit
 * delete keeps the invariant visible and lets the reported count cover
 * exactly what this call removed.) The mail account is never touched.
 */
export async function removeCarddavBook(
  executor: SqlExecutor,
  id: string
): Promise<{ contactsDeleted: number }> {
  const contacts = await executor.execute(
    "DELETE FROM contacts WHERE book_id = $1",
    [id]
  )
  await executor.execute("DELETE FROM carddav_books WHERE id = $1", [id])
  return { contactsDeleted: contacts.rowsAffected }
}
