import type { SqlExecutor } from "./executor"
import type { ThreadRow } from "./threads"

/**
 * Contacts query module (task 8.3): the local address book accumulated
 * from exchanged mail, powering recipient autocomplete.
 *
 * Every contact row belongs to one account (UNIQUE(account_id, email) in
 * the schema), so per-account isolation is enforced by filtering every
 * query on account_id. `email` is the identity key and is normalized
 * (trimmed, lowercased) before any write or lookup — message headers
 * routinely vary casing ("Bob@Example.com"), and the UNIQUE index is
 * case-sensitive, so normalization is what keeps one person one row.
 *
 * Interaction bookkeeping: `recordContactInteraction` is the single
 * writer for interaction_count / last_interaction_at. Task 8.7 (send
 * flow) calls it once per successful send with all addresses on the
 * message; reading a thread may bump counts later via the same helper.
 * Name update policy everywhere in this module: an existing non-null
 * name always wins, a null name is filled from the incoming value — the
 * first name we learned about a person is kept until it is replaced by
 * an explicit edit (updateContact, task 20.2's Contacts browser).
 *
 * ── Browser listing and lifecycle (task 20.2, contacts spec) ──
 * The Contacts browser lists across ALL accounts (like the Todos
 * sidebar section): listAllContacts is the only unscoped contact query.
 * Every row still belongs to one account, so cross-account people are
 * distinct rows and the UI carries the account identity alongside.
 * Edits (display name, notes) are explicit user writes that never touch
 * mail history; deleteContact removes ONLY the contacts row — no
 * message references it (the schema has no FK from messages), and the
 * next correspondence with the same address simply upserts a fresh row.
 *
 * ── Integration recipe for the composer autocomplete UI (8.3 UI half) ──
 * The query layer deliberately ships no component. To wire suggestions
 * into a recipient field:
 *
 *   1. On each keystroke (debounced ~150ms), call
 *      `searchContactsRanked(getExecutor(), accountId, typedText, { limit: 8 })`
 *      — returns ContactRow[] best-first, ready to render in a popover.
 *   2. Empty text (or before the first keystroke) — the same function
 *      with query "" returns the top contacts by frequency for a quick
 *      pick list.
 *   3. Selecting a suggestion yields `{ name?, email }` — exactly the
 *      ContactRef shape the composer store and serializeContacts use, so
 *      it can be pushed into the recipient list as-is.
 *   4. Matching is SQLite LIKE: case-insensitive for ASCII, with `%`/`_`
 *      in the query escaped, so user input can never act as a wildcard.
 *
 * Executor-first like the other query modules: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor.
 */

export interface ContactRow {
  id: string
  account_id: string
  email: string
  name: string | null
  /** Free-form user notes (migration v7, task 20.2); NULL = none yet. */
  notes: string | null
  interaction_count: number
  last_interaction_at: number | null
  created_at: number
  /** Provenance (migration v17, parity-round-2 task 4.2): 'local' rows
   * come from exchanged mail; 'carddav' rows mirror a server card and
   * carry the columns below. Every reader (browser, autocomplete,
   * avatars) treats both sources identically — these fields exist for the
   * sync service and the write-back path only. */
  source: "local" | "carddav"
  /** The vCard UID — the per-book upsert identity. */
  uid: string | null
  /** The card's resource URL on the CardDAV server. */
  href: string | null
  /** The stored ETag — the If-Match precondition for the next write. */
  etag: string | null
  /** The RAW vCard as the server holds it: unknown-property preservation.
   * Edits re-serialize from this, so PHOTO / X- extensions / extra TEL
   * lines the UI does not show survive a write-back. */
  carddav_raw: string | null
  /** The owning carddav_books row; NULL for local contacts. */
  book_id: string | null
}

/** Address + optional display name, as gathered from a message header. */
export interface ContactAddress {
  email: string
  name?: string
}

/** Trim + lowercase; the canonical contact identity within an account. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** All contacts for an account, alphabetical for picker-style listings. */
export async function listContactsByAccount(
  executor: SqlExecutor,
  accountId: string
): Promise<ContactRow[]> {
  return executor.select<ContactRow>(
    `SELECT * FROM contacts WHERE account_id = $1
     ORDER BY COALESCE(name, email) COLLATE NOCASE ASC, email ASC`,
    [accountId]
  )
}

/**
 * Insert the contact if missing, otherwise keep the existing row
 * (idempotent) and apply the name fill policy: existing non-null name is
 * kept, null is filled from the input. Never touches interaction_count —
 * that is recordContactInteraction's job.
 */
export async function upsertContact(
  executor: SqlExecutor,
  accountId: string,
  address: ContactAddress
): Promise<void> {
  await executor.execute(
    `INSERT INTO contacts (id, account_id, email, name, interaction_count)
     VALUES ($1, $2, $3, $4, 0)
     ON CONFLICT(account_id, email) DO UPDATE SET
       name = COALESCE(contacts.name, excluded.name)`,
    [
      crypto.randomUUID(),
      accountId,
      normalizeEmail(address.email),
      address.name ?? null,
    ]
  )
}

/**
 * Bump interaction counters for every address on one user action (one
 * send). New contacts start at 1; existing ones get count + 1 and
 * last_interaction_at = now. Addresses are deduplicated by normalized
 * email so the same person on To and Cc counts once per send. The name
 * fill policy matches upsertContact.
 *
 * Batched per distinct address (one statement each) so the UNIQUE
 * conflict target drives the upsert; count increments must not collapse
 * across different people.
 */
export async function recordContactInteraction(
  executor: SqlExecutor,
  accountId: string,
  addresses: ContactAddress[]
): Promise<void> {
  const seen = new Set<string>()
  for (const address of addresses) {
    const email = normalizeEmail(address.email)
    if (!email || seen.has(email)) continue
    seen.add(email)
    await executor.execute(
      `INSERT INTO contacts (id, account_id, email, name, interaction_count,
         last_interaction_at)
       VALUES ($1, $2, $3, $4, 1, unixepoch())
       ON CONFLICT(account_id, email) DO UPDATE SET
         interaction_count = contacts.interaction_count + 1,
         last_interaction_at = unixepoch(),
         name = COALESCE(contacts.name, excluded.name)`,
      [crypto.randomUUID(), accountId, email, address.name ?? null]
    )
  }
}

export interface SearchContactsOptions {
  /** Maximum suggestions returned; default 8. */
  limit?: number
}

/**
 * Escape SQL LIKE wildcards so the literal query text matches literally;
 * pairs with the ESCAPE '\' clause in the patterns below.
 */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`)
}

/**
 * Ranked recipient suggestions (task 8.3). Matching runs against email
 * and name with LIKE (case-insensitive for ASCII; `%`/`_` in the query
 * are escaped). Ranking is decided entirely in SQL, ordered by:
 *
 *   1. interaction_count DESC  — most-contacted people first
 *   2. prefix match DESC       — a contact whose email OR name *starts
 *                                with* the query outranks one that only
 *                                contains it (type-ahead expectation)
 *   3. last_interaction_at DESC — recency breaks remaining ties
 *   4. email ASC               — deterministic order for equal rows
 *
 * An empty (or whitespace-only) query skips matching and returns the top
 * contacts purely by frequency, then recency — the quick-pick list shown
 * when the recipient field gains focus.
 */
export async function searchContactsRanked(
  executor: SqlExecutor,
  accountId: string,
  query: string,
  options: SearchContactsOptions = {}
): Promise<ContactRow[]> {
  const limit = options.limit ?? 8
  const trimmed = query.trim()
  if (!trimmed) {
    return executor.select<ContactRow>(
      `SELECT * FROM contacts WHERE account_id = $1
       ORDER BY interaction_count DESC,
                last_interaction_at DESC,
                email ASC
       LIMIT $2`,
      [accountId, limit]
    )
  }
  const escaped = escapeLike(trimmed)
  // Each placeholder occurs exactly once (see executor.ts: both drivers
  // bind by occurrence, so repeated patterns get their own number).
  // '\\' renders the single backslash the SQL ESCAPE clause requires.
  return executor.select<ContactRow>(
    `SELECT * FROM contacts
     WHERE account_id = $1
       AND (email LIKE $2 ESCAPE '\\' OR name LIKE $3 ESCAPE '\\')
     ORDER BY interaction_count DESC,
              CASE
                WHEN email LIKE $4 ESCAPE '\\' OR name LIKE $5 ESCAPE '\\'
                THEN 0 ELSE 1
              END ASC,
              last_interaction_at DESC,
              email ASC
     LIMIT $6`,
    [
      accountId,
      `%${escaped}%`,
      `%${escaped}%`,
      `${escaped}%`,
      `${escaped}%`,
      limit,
    ]
  )
}

export interface ListAllContactsOptions {
  /** Non-empty text narrows the address book to contacts whose email OR
   * name matches (LIKE, wildcards escaped); empty/whitespace lists all. */
  query?: string
}

/**
 * The Contacts browser's rows (task 20.2, contacts spec "Address book
 * list and search"): every known contact across ALL accounts — the one
 * deliberately unscoped contact query — sorted by most recent
 * correspondence first (last_interaction_at DESC puts never-contacted
 * rows last), then frequency, then the alphabetical picker order.
 * Search narrows by partial name or email; the ordering is unchanged so
 * typing never re-ranks the visible list.
 */
export async function listAllContacts(
  executor: SqlExecutor,
  options: ListAllContactsOptions = {}
): Promise<ContactRow[]> {
  const trimmed = (options.query ?? "").trim()
  if (!trimmed) {
    return executor.select<ContactRow>(
      `SELECT * FROM contacts
       ORDER BY last_interaction_at DESC,
                interaction_count DESC,
                COALESCE(name, email) COLLATE NOCASE ASC,
                email ASC`
    )
  }
  const escaped = escapeLike(trimmed)
  return executor.select<ContactRow>(
    `SELECT * FROM contacts
     WHERE email LIKE $1 ESCAPE '\\' OR name LIKE $2 ESCAPE '\\'
     ORDER BY last_interaction_at DESC,
              interaction_count DESC,
              COALESCE(name, email) COLLATE NOCASE ASC,
              email ASC`,
    [`%${escaped}%`, `%${escaped}%`]
  )
}

/** One contact by row id; null when the row is gone (deleted). */
export async function getContact(
  executor: SqlExecutor,
  contactId: string
): Promise<ContactRow | null> {
  const rows = await executor.select<ContactRow>(
    "SELECT * FROM contacts WHERE id = $1",
    [contactId]
  )
  return rows[0] ?? null
}

export interface ContactEditPatch {
  /** Explicit display-name edit (the Contacts browser's rename). Trimmed;
   * an empty value clears the name back to NULL. Unlike the upsert fill
   * policy this OVERWRITES the stored name — it is the user's explicit
   * edit, and the COALESCE upserts keep it afterwards. */
  name?: string
  /** Free-form notes text, stored verbatim; empty clears back to NULL. */
  notes?: string
}

/**
 * Apply an explicit edit to one contact (task 20.2, contacts spec
 * "Contact detail and editing"): display name and/or free-form notes.
 * Local-only by definition — mail history is never touched. A no-op
 * patch (neither field) writes nothing.
 */
export async function updateContact(
  executor: SqlExecutor,
  contactId: string,
  patch: ContactEditPatch
): Promise<void> {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.name !== undefined) {
    params.push(patch.name.trim() === "" ? null : patch.name.trim())
    sets.push(`name = $${params.length}`)
  }
  if (patch.notes !== undefined) {
    params.push(patch.notes.trim() === "" ? null : patch.notes)
    sets.push(`notes = $${params.length}`)
  }
  if (!sets.length) return
  // placeholder numbers ascend by occurrence in the SQL text (see executor.ts)
  params.push(contactId)
  await executor.execute(
    `UPDATE contacts SET ${sets.join(", ")} WHERE id = $${params.length}`,
    params
  )
}

/**
 * Delete one contact (task 20.2, contacts spec "Contact lifecycle"):
 * removes ONLY the address-book row. Messages are never touched — the
 * schema has no reference from messages to contacts — and the next
 * correspondence with the same address re-inserts a fresh row via the
 * normal upsert/interaction paths.
 */
export async function deleteContact(
  executor: SqlExecutor,
  contactId: string
): Promise<void> {
  await executor.execute("DELETE FROM contacts WHERE id = $1", [contactId])
}

export interface ContactThreadsOptions {
  /** Maximum related threads returned; default 5. */
  limit?: number
}

/**
 * The contact's related recent threads (task 20.2, contacts spec
 * "related recent threads"): threads on the contact's OWN account where
 * any message is from the contact's address or addresses them in
 * To/Cc — the same `"email":"…"` JSON match the nudges detection uses
 * (serializeContacts' exact spelling, lowercased on both sides), with
 * the LIKE wildcards in the address escaped. Trashed/spam threads are
 * excluded (deliberate placements are not correspondence worth
 * surfacing, mirroring the nudges exclusion set), most recent first.
 */
export async function listContactThreads(
  executor: SqlExecutor,
  accountId: string,
  email: string,
  options: ContactThreadsOptions = {}
): Promise<ThreadRow[]> {
  const normalized = normalizeEmail(email)
  if (!normalized) return []
  const escaped = escapeLike(normalized)
  const addressPattern = `%"email":"${escaped}"%`
  return executor.select<ThreadRow>(
    `SELECT threads.* FROM threads
     WHERE threads.account_id = $1
       AND threads.is_trashed = 0
       AND threads.is_spam = 0
       AND EXISTS (
         SELECT 1 FROM messages m
         WHERE m.thread_id = threads.id
           AND (
             lower(COALESCE(m.from_address, '')) = $2
             OR lower(COALESCE(m.to_json, '')) LIKE $3 ESCAPE '\\'
             OR lower(COALESCE(m.cc_json, '')) LIKE $4 ESCAPE '\\'
           )
       )
     ORDER BY threads.last_message_at DESC, threads.id ASC
     LIMIT $5`,
    [accountId, normalized, addressPattern, addressPattern, options.limit ?? 5]
  )
}
