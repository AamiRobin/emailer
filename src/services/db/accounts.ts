import type { SqlExecutor } from "./executor"
import type {
  AccountStatus,
  AccountType,
  EmailAccount,
  SecurityKind,
} from "../email/types"

/**
 * Accounts query module (task 4.4, write side added by 5.3/5.4). The
 * scheduler lists accounts, reads one, and refreshes the sync
 * cursors/timestamps after a run; the account flows insert new rows,
 * rotate the credentials envelope, flip the status (5.6) and delete an
 * account with all of its local data (5.5).
 *
 * All timestamps are unix epoch seconds, matching the rest of the schema.
 */

export interface AccountRow {
  id: string
  type: AccountType
  email: string
  display_name: string | null
  imap_host: string | null
  imap_port: number | null
  imap_security: SecurityKind | null
  smtp_host: string | null
  smtp_port: number | null
  smtp_security: SecurityKind | null
  credentials_json: string | null
  oauth_scope: string | null
  oauth_client_id: string | null
  /** Delta-sync cursor: the gmail history id (null until the first sync). */
  gmail_history_id: string | null
  labels_synced_at: number | null
  status: AccountStatus
  last_sync_at: number | null
  last_full_sync_at: number | null
  is_active: number
  is_pinned: number
  created_at: number
}

export async function listAccounts(
  executor: SqlExecutor
): Promise<AccountRow[]> {
  return executor.select<AccountRow>(
    "SELECT * FROM accounts ORDER BY created_at ASC, id ASC"
  )
}

/**
 * Accounts eligible for background sync AND for the cross-account
 * aggregations (unified/priority/nudges/split scopes, split-tab counts,
 * nudge badge): status "active" (5.6 marks failing accounts "auth-error",
 * which pauses only that account). Deliberately NOT filtered on
 * `is_active` — that column is the account switcher's "last selected"
 * persistence flag (account-store.ts persistActiveAccount), not an
 * enable/disable switch: switching to account B must never stop account A
 * syncing or vanish it from the unified inbox.
 */
export async function listActiveAccounts(
  executor: SqlExecutor
): Promise<AccountRow[]> {
  return executor.select<AccountRow>(
    "SELECT * FROM accounts WHERE status = $1 ORDER BY created_at ASC, id ASC",
    ["active"]
  )
}

export async function getAccount(
  executor: SqlExecutor,
  accountId: string
): Promise<AccountRow | null> {
  const rows = await executor.select<AccountRow>(
    "SELECT * FROM accounts WHERE id = $1",
    [accountId]
  )
  return rows[0] ?? null
}

/**
 * The unread-badge exclusion for thread-local states, shared by
 * getTotalUnreadCount() and the per-account switcher counts
 * (account-store.ts) so every badge agrees: unread messages in SNOOZED
 * threads (snoozed_until — the same query-level predicate the inbox list
 * and inbox badge use, see email-actions/snooze.ts), MUTED threads
 * (muted_at — spec: muted is excluded from unread counts, see
 * email-actions/thread-states.ts) and HELD threads (held_until — a
 * delivery-schedule hold; the spec excludes held mail from unread counts
 * until its window opens, see email-actions/holds.ts) do not count. Read
 * state itself is never mutated by those states, so the messages simply
 * reappear in the counts when the flag is cleared. Correlated: the
 * surrounding query's FROM must be `messages`.
 */
export const UNREAD_BADGE_THREAD_EXCLUSION = `NOT EXISTS (
  SELECT 1 FROM threads
  WHERE threads.id = messages.thread_id
    AND (threads.snoozed_until IS NOT NULL OR threads.muted_at IS NOT NULL
         OR threads.held_until IS NOT NULL)
)`

/**
 * Total unread messages across every account — the number the OS unread
 * badge shows (task 4.6). Deliberately a fresh COUNT on every call so the
 * badge reflects mark-read changes that happened outside the sync pass
 * too; per-account counts for the switcher live in account-store's
 * refreshUnreadCounts() and share UNREAD_BADGE_THREAD_EXCLUSION above.
 */
export async function getTotalUnreadCount(
  executor: SqlExecutor
): Promise<number> {
  const rows = await executor.select<{ total: number }>(
    `SELECT COUNT(*) AS total FROM messages
     WHERE is_read = 0
       AND ${UNREAD_BADGE_THREAD_EXCLUSION}`
  )
  return rows[0]?.total ?? 0
}

/** Mutable sync bookkeeping; omitted keys are left unchanged. */
export interface AccountSyncPatch {
  /** Gmail history id delta-sync cursor. */
  gmailHistoryId?: string
  /** Unix seconds — last time labels/folders were synced. */
  labelsSyncedAt?: number
  /** Unix seconds — last successful sync of any kind. */
  lastSyncAt?: number
  /** Unix seconds — last full (non-delta) sync. */
  lastFullSyncAt?: number
}

/** Persist sync cursors/timestamps after a sync run. */
export async function updateSyncState(
  executor: SqlExecutor,
  accountId: string,
  patch: AccountSyncPatch
): Promise<void> {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.gmailHistoryId !== undefined) {
    params.push(patch.gmailHistoryId)
    sets.push(`gmail_history_id = $${params.length}`)
  }
  if (patch.labelsSyncedAt !== undefined) {
    params.push(patch.labelsSyncedAt)
    sets.push(`labels_synced_at = $${params.length}`)
  }
  if (patch.lastSyncAt !== undefined) {
    params.push(patch.lastSyncAt)
    sets.push(`last_sync_at = $${params.length}`)
  }
  if (patch.lastFullSyncAt !== undefined) {
    params.push(patch.lastFullSyncAt)
    sets.push(`last_full_sync_at = $${params.length}`)
  }
  if (!sets.length) return
  // placeholder numbers ascend by occurrence in the SQL text (see executor.ts)
  params.push(accountId)
  await executor.execute(
    `UPDATE accounts SET ${sets.join(", ")} WHERE id = $${params.length}`,
    params
  )
}

/** Row → the provider-facing DTO consumed by the factory (getProvider). */
export function toEmailAccount(row: AccountRow): EmailAccount {
  return {
    id: row.id,
    type: row.type,
    email: row.email,
    displayName: row.display_name ?? undefined,
    imapHost: row.imap_host ?? undefined,
    imapPort: row.imap_port ?? undefined,
    imapSecurity: row.imap_security ?? undefined,
    smtpHost: row.smtp_host ?? undefined,
    smtpPort: row.smtp_port ?? undefined,
    smtpSecurity: row.smtp_security ?? undefined,
    credentialsJson: row.credentials_json ?? undefined,
    oauthScope: row.oauth_scope ?? undefined,
    oauthClientId: row.oauth_client_id ?? undefined,
    gmailHistoryId: row.gmail_history_id ?? undefined,
    labelsSyncedAt: row.labels_synced_at ?? undefined,
    status: row.status,
    lastSyncAt: row.last_sync_at ?? undefined,
    lastFullSyncAt: row.last_full_sync_at ?? undefined,
    isActive: row.is_active === 1,
    isPinned: row.is_pinned === 1,
    createdAt: row.created_at,
  }
}

// ---------------------------------------------------------------------------
// Write side (tasks 5.3–5.6: account add/save flows, status flips, removal)
// ---------------------------------------------------------------------------

/** Columns for a new account row; omitted optional columns store null. */
export interface NewAccountInput {
  type: AccountType
  email: string
  displayName?: string
  imapHost?: string
  imapPort?: number
  imapSecurity?: SecurityKind
  smtpHost?: string
  smtpPort?: number
  smtpSecurity?: SecurityKind
  /** The AES-GCM envelope from encryptCredentials() — never plaintext. */
  credentialsJson?: string
  oauthScope?: string
  oauthClientId?: string
  /** Defaults to "active". */
  status?: AccountStatus
}

/**
 * Insert a new account and return the stored row. The id is an
 * app-generated UUID; the email column is UNIQUE so a duplicate connect
 * surfaces as a constraint error for the flow to report.
 */
export async function insertAccount(
  executor: SqlExecutor,
  input: NewAccountInput
): Promise<AccountRow> {
  const id = crypto.randomUUID()
  const rows = await executor.select<AccountRow>(
    `INSERT INTO accounts (
      id, type, email, display_name,
      imap_host, imap_port, imap_security,
      smtp_host, smtp_port, smtp_security,
      credentials_json, oauth_scope, oauth_client_id, status
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING *`,
    [
      id,
      input.type,
      input.email,
      input.displayName ?? null,
      input.imapHost ?? null,
      input.imapPort ?? null,
      input.imapSecurity ?? null,
      input.smtpHost ?? null,
      input.smtpPort ?? null,
      input.smtpSecurity ?? null,
      input.credentialsJson ?? null,
      input.oauthScope ?? null,
      input.oauthClientId ?? null,
      input.status ?? "active",
    ]
  )
  return rows[0]
}

/** Persist a new encrypted credentials envelope (add flow, 5.6 re-auth). */
export async function updateCredentials(
  executor: SqlExecutor,
  accountId: string,
  credentialsJson: string
): Promise<void> {
  await executor.execute(
    "UPDATE accounts SET credentials_json = $1 WHERE id = $2",
    [credentialsJson, accountId]
  )
}

/** Flip an account between "active" and "auth-error" (task 5.6). */
export async function updateStatus(
  executor: SqlExecutor,
  accountId: string,
  status: AccountStatus
): Promise<void> {
  await executor.execute("UPDATE accounts SET status = $1 WHERE id = $2", [
    status,
    accountId,
  ])
}

/**
 * Remove an account row; the schema's ON DELETE CASCADE removes its
 * messages, threads, labels, attachments and related rows (task 5.5).
 */
export async function deleteAccount(
  executor: SqlExecutor,
  accountId: string
): Promise<void> {
  await executor.execute("DELETE FROM accounts WHERE id = $1", [accountId])
}
