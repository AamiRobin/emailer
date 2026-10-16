import type { SqlExecutor } from "./executor"
import type { HistoryWindowSetting } from "../sync/history-window"
import { parseHistoryWindow } from "../sync/history-window"
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
  /**
   * First-sync download boundary (migration v20, design D6): the sync
   * layer's TEXT grammar ("1m"/"3m"/"6m"/"1y"), null = all history. The
   * three drivers' initial passes clamp to it; delta sync never does.
   */
  history_window: string | null
  /**
   * Meeting-reminder lead (migration v20, task 8.5, design D5): minutes
   * before a meeting start to raise one notification; NULL = OFF (the
   * default — no meeting reminders until the user opts in per account).
   */
  reminder_lead_minutes: number | null
  status: AccountStatus
  last_sync_at: number | null
  last_full_sync_at: number | null
  is_active: number
  is_pinned: number
  created_at: number
}

/** The row's stored window through the sync layer's grammar. */
export function accountHistoryWindow(
  row: Pick<AccountRow, "history_window">
): HistoryWindowSetting {
  return parseHistoryWindow(row.history_window)
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
  /**
   * First-sync download boundary (D6); omitted/null = all history — a new
   * account downloads everything unless the add flow carried a pick.
   */
  historyWindow?: HistoryWindowSetting
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
      credentials_json, oauth_scope, oauth_client_id, status, history_window
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
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
      input.historyWindow ?? null,
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
 * Flag EVERY account for re-authentication (task 5.4, restore side).
 *
 * A backup snapshot carries NO credentials by construction — the export
 * strip nulls the sealed envelopes (backup-snapshot.ts) — so after a
 * replace-mode restore every account row is credential-less. The
 * persisted flag is the accounts table's own `status` column (present
 * since the v15 rebuild): flipping each row to "auth-error" IS the
 * needs-reauth state, because the existing re-auth failure UX already
 * consumes that value end to end — the switcher badge and the
 * "Re-authenticate…" entry (account-switcher.tsx), the ReauthDialog
 * hosts, and the sync gate (listActiveAccounts picks up only status
 * "active"). A successful re-auth flips the row back to "active"
 * (reauth.ts finishReauth), which lifts the flag — no extra column, no
 * migration.
 *
 * Reading restored mail never consults account status, so restored mail
 * stays readable offline while the flag is set.
 */
export async function flagAllAccountsForReauth(
  executor: SqlExecutor
): Promise<number> {
  const result = await executor.execute(
    "UPDATE accounts SET status = 'auth-error' WHERE status != 'auth-error'"
  )
  return result.rowsAffected
}

/**
 * Persist the first-sync download boundary (D6, task 3.1). The accounts
 * editor writes the user's pick; widening callers additionally queue the
 * targeted backfill op (queue/operation.ts) — this write is deliberately
 * download-semantics-only and never touches stored messages (a narrower
 * window deletes nothing).
 */
export async function updateHistoryWindow(
  executor: SqlExecutor,
  accountId: string,
  window: HistoryWindowSetting
): Promise<void> {
  await executor.execute(
    "UPDATE accounts SET history_window = $1 WHERE id = $2",
    [window, accountId]
  )
}

/**
 * The account's meeting-reminder lead minutes (task 8.5): the stored
 * column through its only grammar — NULL (or a non-positive/garbage
 * value) reads as null = OFF, so a legacy/garbage value can never
 * produce a reminder storm.
 */
export async function getAccountReminderLeadMinutes(
  executor: SqlExecutor,
  accountId: string
): Promise<number | null> {
  const rows = await executor.select<{ reminder_lead_minutes: number | null }>(
    "SELECT reminder_lead_minutes FROM accounts WHERE id = $1",
    [accountId]
  )
  const stored = rows[0]?.reminder_lead_minutes
  return typeof stored === "number" && Number.isFinite(stored) && stored > 0
    ? stored
    : null
}

/** Persist the meeting-reminder lead; null turns reminders OFF. */
export async function setAccountReminderLeadMinutes(
  executor: SqlExecutor,
  accountId: string,
  minutes: number | null
): Promise<void> {
  const value =
    minutes !== null && Number.isFinite(minutes) && minutes > 0
      ? Math.floor(minutes)
      : null
  await executor.execute(
    "UPDATE accounts SET reminder_lead_minutes = $1 WHERE id = $2",
    [value, accountId]
  )
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
