import type { SqlExecutor } from "../db/executor"

/**
 * Merge-mode restore (task 5.3, data-portability spec "merge behaviors"):
 * import the SNAPSHOT's metadata into the LIVE database without touching
 * anything that already exists.
 *
 * What merges (the task's table list, mapped onto the real schema):
 * - settings — whose rows carry MORE than the settings section: quick
 *   steps are the `organization.quickSteps` JSON row and signatures are
 *   the `signature:<accountId>` rows (services/settings/quick-steps.ts,
 *   composer/signatures.ts), so one settings merge covers both;
 * - account_profiles ("profiles");
 * - rules, snippets, saved searches — their own tables;
 * - category overrides — the sender_categories store;
 * - accounts — matched by EMAIL ADDRESS (the natural key; row ids are
 *   machine-local UUIDs and must not be trusted for identity).
 *
 * What deliberately does NOT merge: the message database. Merge restores
 * metadata only — restored mail bodies/threads/messages stay on the
 * server and come down with the first sync of each account. That is why
 * a NEWLY INSERTED account is reset to a clean sync state: its delta
 * cursors (gmail_history_id, labels_synced_at, last_sync timestamps) are
 * dropped, so the first pass is a FULL initial download rather than a
 * delta from another machine's history. (Replace mode does not have this
 * problem — its snapshot brings the whole message DB the cursors
 * describe.)
 *
 * Semantics per row: the NATURAL KEY decides. A row whose natural key
 * already exists locally is SKIPPED (local wins — a merge never
 * overwrites); otherwise it is inserted, with a FRESH id when its
 * original id is already taken (ids are app-generated UUIDs, so a
 * collision across machines is unlikely but must not fail the restore).
 *
 * Sealed envelopes are never read here: the account insert projects an
 * explicit column list WITHOUT credentials_json, so even a hand-crafted
 * snapshot cannot smuggle a credentials envelope back in — merged
 * accounts always land in `status: "auth-error"` (the needs-reauth flag,
 * task 5.4) and re-seal through the normal re-auth flow.
 *
 * Atomicity/cancel (spec: "a failed or cancelled restore MUST leave the
 * existing local data intact"): every write runs inside ONE transaction
 * — any thrown error (including a mid-merge cancel via `options.signal`)
 * rolls the whole merge back, leaving the live database byte-identical.
 */

/** Row counts per merged table, for the restore summary UI. */
export interface MergeSummary {
  accountsAdded: number
  accountsKept: number
  profilesAdded: number
  settingsAdded: number
  rulesAdded: number
  snippetsAdded: number
  savedSearchesAdded: number
  senderCategoriesAdded: number
}

/** A mid-merge cancel: the transaction rolls back, nothing was merged. */
export class RestoreCancelledError extends Error {
  constructor() {
    super("Restore cancelled — your existing data is unchanged.")
    this.name = "RestoreCancelledError"
  }
}

export interface MergeOptions {
  /** Checked between tables and rows; `{ aborted: true }` cancels. */
  signal?: { aborted: boolean }
}

/** The snapshot accounts table's columns the merge projects. Sealed
 * credentials and THIS device's sync cursors are deliberately absent. */
interface SnapshotAccountRow {
  id: string
  type: "gmail" | "imap" | "microsoft"
  email: string
  display_name: string | null
  imap_host: string | null
  imap_port: number | null
  imap_security: string | null
  smtp_host: string | null
  smtp_port: number | null
  smtp_security: string | null
  oauth_scope: string | null
  oauth_client_id: string | null
  history_window: string | null
  reminder_lead_minutes: number | null
  color_override: string | null
  profile_id: string | null
  created_at: number
}

function checkAbort(signal?: { aborted: boolean }): void {
  if (signal?.aborted) throw new RestoreCancelledError()
}

/** `wanted` when free, a fresh UUID when already taken (see module
 * comment: "new ids on collision"). */
async function freeId(
  executor: SqlExecutor,
  table: string,
  wanted: string
): Promise<string> {
  const rows = await executor.select<{ id: string }>(
    `SELECT id FROM ${table} WHERE id = $1`,
    [wanted]
  )
  return rows.length > 0 ? crypto.randomUUID() : wanted
}

/**
 * Merge the snapshot database (opened as a second executor, exactly like
 * the export strip's second connection) into the live one. Returns the
 * per-table counts the settings UI reports.
 */
export async function mergeSnapshotInto(
  live: SqlExecutor,
  snapshot: SqlExecutor,
  options: MergeOptions = {}
): Promise<MergeSummary> {
  const summary: MergeSummary = {
    accountsAdded: 0,
    accountsKept: 0,
    profilesAdded: 0,
    settingsAdded: 0,
    rulesAdded: 0,
    snippetsAdded: 0,
    savedSearchesAdded: 0,
    senderCategoriesAdded: 0,
  }

  await live.execute("BEGIN")
  try {
    // Snapshot account id → live account id. Total over every snapshot
    // account: matched emails map to the existing row, the rest are
    // inserted below and map to their (possibly regenerated) new id.
    const accountMap = new Map<string, string>()
    const profileMap = new Map<string, string>()

    // 1. Profiles first: the account insert's profile_id FK points here.
    checkAbort(options.signal)
    const profiles = await snapshot.select<{
      id: string
      name: string
      color: string
      created_at: number
    }>("SELECT id, name, color, created_at FROM account_profiles ORDER BY created_at ASC, id ASC")
    for (const profile of profiles) {
      checkAbort(options.signal)
      const existing = await live.select<{ id: string }>(
        "SELECT id FROM account_profiles WHERE name = $1 LIMIT 1",
        [profile.name]
      )
      if (existing.length > 0) {
        profileMap.set(profile.id, existing[0].id)
        continue
      }
      const id = await freeId(live, "account_profiles", profile.id)
      await live.execute(
        `INSERT INTO account_profiles (id, name, color, created_at)
         VALUES ($1, $2, $3, $4)`,
        [id, profile.name, profile.color, profile.created_at]
      )
      profileMap.set(profile.id, id)
      summary.profilesAdded += 1
    }

    // 2. Accounts by email. Inserted ones keep the snapshot's server
    // settings and history-window preference, drop the other machine's
    // sync cursors (full re-download — see module comment), and land in
    // "auth-error": the strip guarantees there is nothing to sign in with.
    checkAbort(options.signal)
    const accounts = await snapshot.select<SnapshotAccountRow>(
      `SELECT id, type, email, display_name,
              imap_host, imap_port, imap_security,
              smtp_host, smtp_port, smtp_security,
              oauth_scope, oauth_client_id, history_window,
              reminder_lead_minutes,
              color_override, profile_id, created_at
       FROM accounts ORDER BY created_at ASC, id ASC`
    )
    for (const account of accounts) {
      checkAbort(options.signal)
      const existing = await live.select<{ id: string }>(
        "SELECT id FROM accounts WHERE lower(email) = lower($1) LIMIT 1",
        [account.email]
      )
      if (existing.length > 0) {
        accountMap.set(account.id, existing[0].id)
        summary.accountsKept += 1
        continue
      }
      const id = await freeId(live, "accounts", account.id)
      // A profile that merged under a new identity keeps its color link;
      // one that matched by name points at the LOCAL profile row.
      const profileId = account.profile_id
        ? (profileMap.get(account.profile_id) ?? null)
        : null
      await live.execute(
        `INSERT INTO accounts (
           id, type, email, display_name,
           imap_host, imap_port, imap_security,
           smtp_host, smtp_port, smtp_security,
           oauth_scope, oauth_client_id,
           history_window, reminder_lead_minutes,
           status, profile_id, color_override, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                   $14, 'auth-error', $15, $16, $17)`,
        [
          id,
          account.type,
          account.email,
          account.display_name,
          account.imap_host,
          account.imap_port,
          account.imap_security,
          account.smtp_host,
          account.smtp_port,
          account.smtp_security,
          account.oauth_scope,
          account.oauth_client_id,
          account.history_window,
          account.reminder_lead_minutes,
          profileId,
          account.color_override,
          account.created_at,
        ]
      )
      accountMap.set(account.id, id)
      summary.accountsAdded += 1
    }

    // 3. Settings — quick steps and signatures included (module comment).
    // `signature:<accountId>` keys are rewritten onto the LIVE account id
    // so a matched account with a different id keeps its signature; keys
    // naming an account outside the snapshot are orphans and skipped.
    checkAbort(options.signal)
    const settings = await snapshot.select<{
      key: string
      value: string
      updated_at: number
    }>("SELECT key, value, updated_at FROM settings ORDER BY key ASC")
    for (const setting of settings) {
      checkAbort(options.signal)
      const signatureMatch = /^signature:(.+)$/.exec(setting.key)
      let key = setting.key
      if (signatureMatch) {
        const mapped = accountMap.get(signatureMatch[1])
        if (!mapped) continue
        key = `signature:${mapped}`
      }
      const existing = await live.select<{ key: string }>(
        "SELECT key FROM settings WHERE key = $1 LIMIT 1",
        [key]
      )
      if (existing.length > 0) continue
      await live.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)",
        [key, setting.value, setting.updated_at]
      )
      summary.settingsAdded += 1
    }

    // 4. Rules — account-scoped, so both the FK and the (account, name)
    // natural key resolve through the account map.
    checkAbort(options.signal)
    const rules = await snapshot.select<{
      id: string
      account_id: string
      name: string
      criteria_json: string
      actions_json: string
      enabled: number
      position: number
      created_at: number
    }>(
      "SELECT id, account_id, name, criteria_json, actions_json, enabled, position, created_at FROM rules ORDER BY position ASC, id ASC"
    )
    for (const rule of rules) {
      checkAbort(options.signal)
      const accountId = accountMap.get(rule.account_id)
      if (!accountId) continue
      const existing = await live.select<{ id: string }>(
        "SELECT id FROM rules WHERE account_id = $1 AND name = $2 LIMIT 1",
        [accountId, rule.name]
      )
      if (existing.length > 0) continue
      const id = await freeId(live, "rules", rule.id)
      await live.execute(
        `INSERT INTO rules (
           id, account_id, name, criteria_json, actions_json, enabled,
           position, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          accountId,
          rule.name,
          rule.criteria_json,
          rule.actions_json,
          rule.enabled,
          rule.position,
          rule.created_at,
        ]
      )
      summary.rulesAdded += 1
    }

    // 5. Snippets — global composer templates, natural key = name.
    checkAbort(options.signal)
    const snippets = await snapshot.select<{
      id: string
      name: string
      body: string
      shortcut: string | null
      created_at: number
    }>(
      "SELECT id, name, body, shortcut, created_at FROM snippets ORDER BY created_at ASC, id ASC"
    )
    for (const snippet of snippets) {
      checkAbort(options.signal)
      const existing = await live.select<{ id: string }>(
        "SELECT id FROM snippets WHERE name = $1 LIMIT 1",
        [snippet.name]
      )
      if (existing.length > 0) continue
      const id = await freeId(live, "snippets", snippet.id)
      await live.execute(
        "INSERT INTO snippets (id, name, body, shortcut, created_at) VALUES ($1, $2, $3, $4, $5)",
        [id, snippet.name, snippet.body, snippet.shortcut, snippet.created_at]
      )
      summary.snippetsAdded += 1
    }

    // 6. Saved searches — global, natural key = name.
    checkAbort(options.signal)
    const savedSearches = await snapshot.select<{
      id: string
      name: string
      query: string
      position: number
      created_at: number
    }>(
      "SELECT id, name, query, position, created_at FROM saved_searches ORDER BY position ASC, id ASC"
    )
    for (const search of savedSearches) {
      checkAbort(options.signal)
      const existing = await live.select<{ id: string }>(
        "SELECT id FROM saved_searches WHERE name = $1 LIMIT 1",
        [search.name]
      )
      if (existing.length > 0) continue
      const id = await freeId(live, "saved_searches", search.id)
      await live.execute(
        "INSERT INTO saved_searches (id, name, query, position, created_at) VALUES ($1, $2, $3, $4, $5)",
        [id, search.name, search.query, search.position, search.created_at]
      )
      summary.savedSearchesAdded += 1
    }

    // 7. Category overrides — sender_categories, whose PRIMARY KEY is the
    // natural key (sender_key): a collision IS the skip case, so there is
    // no id regeneration here.
    checkAbort(options.signal)
    const overrides = await snapshot.select<{
      sender_key: string
      category: string
      source: string
      updated_at: number
    }>(
      "SELECT sender_key, category, source, updated_at FROM sender_categories ORDER BY sender_key ASC"
    )
    for (const override of overrides) {
      checkAbort(options.signal)
      const existing = await live.select<{ sender_key: string }>(
        "SELECT sender_key FROM sender_categories WHERE sender_key = $1 LIMIT 1",
        [override.sender_key]
      )
      if (existing.length > 0) continue
      await live.execute(
        "INSERT INTO sender_categories (sender_key, category, source, updated_at) VALUES ($1, $2, $3, $4)",
        [
          override.sender_key,
          override.category,
          override.source,
          override.updated_at,
        ]
      )
      summary.senderCategoriesAdded += 1
    }

    await live.execute("COMMIT")
    return summary
  } catch (error) {
    // Failure OR cancel: the transaction rolls back and the live database
    // keeps exactly its pre-merge state (spec scenario "Cancel during
    // restore"). A broken connection may have lost the transaction
    // already — the rollback is guarded like the migration runner's.
    await live.execute("ROLLBACK").catch(() => {})
    throw error
  }
}
