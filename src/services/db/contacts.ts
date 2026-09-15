import type { SqlExecutor } from "./executor"

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
 * an explicit edit (no contact editing exists yet).
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
  interaction_count: number
  last_interaction_at: number | null
  created_at: number
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
