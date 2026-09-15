import type { SqlExecutor } from "../db/executor"

/**
 * Query layer for `folder_sync_state` (migrations.ts v1): the IMAP
 * per-folder incremental sync cursor — UIDVALIDITY plus the last seen
 * UID. A UIDVALIDITY mismatch between the stored row and the server's
 * SELECT response invalidates every stored UID for that folder and
 * forces a full re-sync (see imap-sync.ts). Executor-first style, same
 * as the src/services/db modules.
 */

export interface FolderSyncStateRow {
  id: string
  account_id: string
  /** Full IMAP folder path (matches messages.imap_folder). */
  folder_name: string
  uidvalidity: number | null
  last_seen_uid: number
  /** CONDSTORE cursor — reserved for flag-only deltas (task 4.7). */
  highest_modseq: number | null
  /** unix epoch seconds, or null before the first completed sync. */
  last_sync_at: number | null
}

export interface FolderSyncStateInput {
  accountId: string
  /** Full IMAP folder path (matches messages.imap_folder). */
  folderName: string
  uidvalidity?: number | null
  lastSeenUid: number
  highestModseq?: number | null
  /** unix epoch seconds; defaults to now. */
  lastSyncAt?: number
}

export async function getFolderSyncState(
  executor: SqlExecutor,
  accountId: string,
  folderName: string
): Promise<FolderSyncStateRow | null> {
  const rows = await executor.select<FolderSyncStateRow>(
    "SELECT * FROM folder_sync_state WHERE account_id = $1 AND folder_name = $2",
    [accountId, folderName]
  )
  return rows[0] ?? null
}

export async function listFolderSyncStates(
  executor: SqlExecutor,
  accountId: string
): Promise<FolderSyncStateRow[]> {
  return executor.select<FolderSyncStateRow>(
    "SELECT * FROM folder_sync_state WHERE account_id = $1 ORDER BY folder_name ASC",
    [accountId]
  )
}

/**
 * Insert-or-update the cursor for one (account, folder) pair against the
 * UNIQUE(account_id, folder_name) constraint. Parameters bind twice
 * (VALUES + UPDATE SET) because the executor convention requires each
 * placeholder to be bound exactly once with numbers ascending by first
 * occurrence (see executor.ts).
 */
export async function upsertFolderSyncState(
  executor: SqlExecutor,
  input: FolderSyncStateInput
): Promise<void> {
  const uidvalidity = input.uidvalidity ?? null
  const highestModseq = input.highestModseq ?? null
  const lastSyncAt = input.lastSyncAt ?? Math.floor(Date.now() / 1000)
  await executor.execute(
    `INSERT INTO folder_sync_state (
      id, account_id, folder_name, uidvalidity, last_seen_uid,
      highest_modseq, last_sync_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (account_id, folder_name) DO UPDATE SET
      uidvalidity = $8,
      last_seen_uid = $9,
      highest_modseq = $10,
      last_sync_at = $11`,
    [
      crypto.randomUUID(),
      input.accountId,
      input.folderName,
      uidvalidity,
      input.lastSeenUid,
      highestModseq,
      lastSyncAt,
      uidvalidity,
      input.lastSeenUid,
      highestModseq,
      lastSyncAt,
    ]
  )
}

export async function deleteFolderSyncState(
  executor: SqlExecutor,
  accountId: string,
  folderName: string
): Promise<void> {
  await executor.execute(
    "DELETE FROM folder_sync_state WHERE account_id = $1 AND folder_name = $2",
    [accountId, folderName]
  )
}
