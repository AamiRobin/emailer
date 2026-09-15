import { invoke } from "@tauri-apps/api/core"

import type { SqlExecutor } from "../db/executor"
import { placeholders } from "../db/executor"
import { recomputeThreadCaches } from "../db/threads"
import type { EmailFolder, EmailProvider, MessageFlags } from "../email/types"
import { ProviderAuthError } from "../email/types"
import type { ImapParams } from "../email/invoke"
import {
  getFolderSyncState,
  upsertFolderSyncState,
  type FolderSyncStateRow,
} from "./folder-sync-state"

/**
 * IMAP flag consistency (task 4.7, design D14): pick up read/flagged
 * changes made in other clients for already-synced messages without
 * re-downloading bodies. Runs after the per-folder delta pass inside
 * `syncImapAccount`; only messages at or below the folder's synced
 * `lastSeenUid` are touched — anything newer belongs to delta sync.
 *
 * Two strategies per folder:
 * - CONDSTORE (RFC 7162): when the caller wires a `fetchFlagsChanged`
 *   hook (the account layer binds the `imap_fetch_flags_changed` Rust
 *   command to the account's connection params — the EmailProvider
 *   surface itself cannot express it), the persisted
 *   `folder_sync_state.highest_modseq` cursor drives a
 *   `UID FETCH 1:* (FLAGS) (CHANGEDSINCE <modseq>)` query. A missing
 *   cursor bootstraps with CHANGEDSINCE 1 (still flags-only), and the
 *   fresh HIGHESTMODSEQ returned by the command is persisted for the
 *   next cycle. Errors (e.g. a server without CONDSTORE) fall back.
 * - Window re-scan: a flags-only `fetchFlags(folder, {last: WINDOW})`
 *   over the most recent FLAG_SCAN_WINDOW UIDs, diffed against the
 *   local rows; server flags win over local state.
 *
 * Local updates write only `is_read` ("\Seen") and `is_flagged`
 * ("\Flagged") and recompute the affected thread caches; bodies, headers
 * and threading are never touched.
 */

// ---------------------------------------------------------------------------
// Wire seam: the CONDSTORE changed-since command (mirrors imap::types)
// ---------------------------------------------------------------------------

/** Mirrors imap::types::UidFlags (same shape as invoke.ts ImapUidFlags). */
export interface CondstoreUidFlags {
  uid: number
  flags: string[]
}

/**
 * Mirrors imap::types::FolderStatus plus the CONDSTORE cursor: the Rust
 * command SELECTs with (CONDSTORE), so highestModseq is always present on
 * success (null only when absent on the wire, e.g. older builds).
 */
export interface CondstoreFolderStatus {
  uidValidity: number
  uidNext: number
  exists: number
  unseen: number
  highestModseq?: number | null
}

/** Mirrors imap::types::FlagsChangedResult. */
export interface ImapFlagsChangedResult {
  flags: CondstoreUidFlags[]
  folderStatus: CondstoreFolderStatus
}

/**
 * Raw Tauri invoke for `imap_fetch_flags_changed` (kept next to the sync
 * code that owns its semantics). invoke.ts now mirrors highestModseq on
 * its ImapFolderStatus too, so these local wire types could later be
 * replaced by the shared ones — not done here to keep the flag-sync
 * surface untouched. The account layer binds this with the account's
 * ImapParams to produce the `FetchFlagsChangedFn` hook below.
 */
export function imapFetchFlagsChanged(
  params: ImapParams,
  folder: string,
  sinceModseq: number
): Promise<ImapFlagsChangedResult> {
  return invoke("imap_fetch_flags_changed", { params, folder, sinceModseq })
}

/**
 * Account-agnostic CONDSTORE hook: fetch the flags of every message in
 * `folder` whose server mod-sequence changed after `sinceModseq`, plus
 * the folder status carrying the new HIGHESTMODSEQ. Implementations must
 * not download bodies.
 */
export type FetchFlagsChangedFn = (
  folder: string,
  sinceModseq: number
) => Promise<ImapFlagsChangedResult>

// ---------------------------------------------------------------------------
// Options / summaries
// ---------------------------------------------------------------------------

/**
 * Most recent UIDs re-scanned by the fallback path. Bounds the work per
 * folder: older messages reconcile only when the changed-since cursor
 * (CONDSTORE) is available. 500 matches the sync batch scale with headroom.
 */
export const FLAG_SCAN_WINDOW = 500

/** Parameters per IN-list chunk (executor binds each `$n` exactly once). */
const FLAG_UID_BATCH = 200

/** Rust error text when `last` is used on a folder with no messages. */
const NO_MESSAGES_MARKER =
  "no messages to fetch: provide a non-empty uidSet, or a non-zero `last` on a non-empty folder"

/** Mod-sequence that selects every message (bootstrap changed-since). */
const BOOTSTRAP_MODSEQ = 1

export type FlagReconcileMode =
  | "condstore"
  /** Server lacks CONDSTORE (or no hook wired): flags-only window scan. */
  | "window"
  /** Nothing to do (never synced, empty cursor or UIDVALIDITY mismatch). */
  | "skipped"

export interface FolderFlagOutcome {
  folder: string
  /** Messages whose is_read/is_flagged were corrected to server state. */
  changes: number
  mode: FlagReconcileMode
}

export interface ReconcileFolderFlagsOptions {
  executor: SqlExecutor
  provider: EmailProvider
  accountId: string
  /** Full IMAP folder path. */
  folder: string
  /**
   * Highest UID already stored by delta sync for this folder; messages
   * above it are new-message territory and are skipped here.
   */
  lastSeenUid: number
  /** CONDSTORE changed-since hook; absent → window re-scan fallback. */
  fetchFlagsChanged?: FetchFlagsChangedFn
}

export interface ReconcileAllFolderFlagsOptions {
  executor: SqlExecutor
  provider: EmailProvider
  accountId: string
  folders: EmailFolder[]
  /** CONDSTORE changed-since hook; absent → window re-scan fallback. */
  fetchFlagsChanged?: FetchFlagsChangedFn
}

export interface FlagReconcileSummary {
  /** Folders attempted (skipped ones included). */
  foldersChecked: number
  /** Total messages corrected across all folders. */
  changes: number
  outcomes: FolderFlagOutcome[]
  /** Per-folder failures ("path: message"); other folders still reconcile. */
  errors: string[]
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/**
 * Reconcile one folder's flags for already-synced messages. Reads the
 * folder's `folder_sync_state` cursor: without a completed sync (no row,
 * no UIDVALIDITY) or with lastSeenUid <= 0 there is nothing to reconcile.
 */
export async function reconcileFolderFlags(
  options: ReconcileFolderFlagsOptions
): Promise<FolderFlagOutcome> {
  const { executor, provider, accountId, folder, lastSeenUid } = options
  const state = await getFolderSyncState(executor, accountId, folder)
  if (state === null || state.uidvalidity === null || lastSeenUid <= 0) {
    return { folder, changes: 0, mode: "skipped" }
  }

  if (options.fetchFlagsChanged) {
    try {
      return await reconcileWithCondstore(
        executor,
        accountId,
        folder,
        state,
        lastSeenUid,
        options.fetchFlagsChanged
      )
    } catch (error) {
      // Credential failures stay typed for the account layer; a server
      // without CONDSTORE (clear command error) falls through to the
      // window re-scan.
      if (error instanceof ProviderAuthError) throw error
    }
  }

  const changes = await reconcileByWindowScan(
    executor,
    provider,
    accountId,
    folder,
    lastSeenUid
  )
  return { folder, changes, mode: "window" }
}

/**
 * Reconcile every folder after a delta sync. Per-folder errors are
 * collected; credential failures (ProviderAuthError) propagate so the
 * account layer can mark the account, exactly as in delta sync.
 */
export async function reconcileAllFolderFlags(
  options: ReconcileAllFolderFlagsOptions
): Promise<FlagReconcileSummary> {
  const { executor, provider, accountId, folders } = options
  const summary: FlagReconcileSummary = {
    foldersChecked: 0,
    changes: 0,
    outcomes: [],
    errors: [],
  }

  for (const folder of folders) {
    summary.foldersChecked += 1
    try {
      const state = await getFolderSyncState(executor, accountId, folder.path)
      const outcome = await reconcileFolderFlags({
        executor,
        provider,
        accountId,
        folder: folder.path,
        lastSeenUid: state?.last_seen_uid ?? 0,
        ...(options.fetchFlagsChanged
          ? { fetchFlagsChanged: options.fetchFlagsChanged }
          : {}),
      })
      summary.changes += outcome.changes
      summary.outcomes.push(outcome)
    } catch (error) {
      if (error instanceof ProviderAuthError) throw error
      summary.errors.push(`${folder.path}: flag sync: ${errorMessage(error)}`)
    }
  }
  return summary
}

// ---------------------------------------------------------------------------
// CONDSTORE path (RFC 7162)
// ---------------------------------------------------------------------------

async function reconcileWithCondstore(
  executor: SqlExecutor,
  accountId: string,
  folder: string,
  state: FolderSyncStateRow,
  lastSeenUid: number,
  fetchFlagsChanged: FetchFlagsChangedFn
): Promise<FolderFlagOutcome> {
  // A missing cursor bootstraps: CHANGEDSINCE 1 returns every message's
  // flags (still bodies-free) and — more importantly — the folder's
  // current HIGHESTMODSEQ, which is stored below for the next cycle.
  const sinceModseq = state.highest_modseq ?? BOOTSTRAP_MODSEQ
  const result = await fetchFlagsChanged(folder, sinceModseq)

  // A UIDVALIDITY change invalidates every stored UID: delta sync owns the
  // full re-sync; touching rows here would mix UID spaces.
  if (result.folderStatus.uidValidity !== state.uidvalidity) {
    return { folder, changes: 0, mode: "skipped" }
  }

  const changes = await applyFlagUpdates(
    executor,
    accountId,
    folder,
    lastSeenUid,
    result.flags
  )

  // Always advance the cursor, even with zero changes — that is the point
  // of the mod-sequence: everything before it is known-consistent.
  const highestModseq = result.folderStatus.highestModseq ?? null
  await upsertFolderSyncState(executor, {
    accountId,
    folderName: folder,
    uidvalidity: state.uidvalidity,
    lastSeenUid: state.last_seen_uid,
    highestModseq,
  })

  return { folder, changes, mode: "condstore" }
}

// ---------------------------------------------------------------------------
// Fallback path: flags-only window re-scan
// ---------------------------------------------------------------------------

async function reconcileByWindowScan(
  executor: SqlExecutor,
  provider: EmailProvider,
  accountId: string,
  folder: string,
  lastSeenUid: number
): Promise<number> {
  let flags: MessageFlags[]
  try {
    flags = await provider.fetchFlags(folder, { last: FLAG_SCAN_WINDOW })
  } catch (error) {
    // Empty folder: the Rust layer refuses `last` with no messages — a
    // clean skip, not an error (same contract as the delta sync).
    if (errorMessage(error).includes(NO_MESSAGES_MARKER)) return 0
    throw error
  }
  return applyFlagUpdates(executor, accountId, folder, lastSeenUid, flags)
}

// ---------------------------------------------------------------------------
// Shared diff/apply (server-wins)
// ---------------------------------------------------------------------------

interface LocalFlagRow {
  imap_uid: number
  is_read: number
  is_flagged: number
  thread_id: string
}

async function localFlagRows(
  executor: SqlExecutor,
  accountId: string,
  folder: string,
  uids: number[]
): Promise<Map<number, LocalFlagRow>> {
  const rows = new Map<number, LocalFlagRow>()
  for (let start = 0; start < uids.length; start += FLAG_UID_BATCH) {
    const chunk = uids.slice(start, start + FLAG_UID_BATCH)
    const sql = `SELECT imap_uid, is_read, is_flagged, thread_id FROM messages
       WHERE account_id = $1 AND imap_folder = $2 AND imap_uid IN (${placeholders(chunk.length, 3)})`
    const chunkRows = await executor.select<LocalFlagRow>(sql, [
      accountId,
      folder,
      ...chunk,
    ])
    for (const row of chunkRows) rows.set(row.imap_uid, row)
  }
  return rows
}

/**
 * Server-wins reconciliation of a flags-only fetch: for already-synced
 * messages (uid <= lastSeenUid) whose local is_read/is_flagged differ from
 * the server flags, update the message rows and recompute the affected
 * thread caches. Messages above lastSeenUid belong to delta sync — skipped.
 */
async function applyFlagUpdates(
  executor: SqlExecutor,
  accountId: string,
  folder: string,
  lastSeenUid: number,
  flags: MessageFlags[]
): Promise<number> {
  const inSync = flags.filter((entry) => entry.uid <= lastSeenUid)
  if (inSync.length === 0) return 0

  const local = await localFlagRows(
    executor,
    accountId,
    folder,
    inSync.map((entry) => entry.uid)
  )

  const changedThreads = new Set<string>()
  let changes = 0
  for (const entry of inSync) {
    const row = local.get(entry.uid)
    if (row === undefined) continue
    const isRead = entry.flags.includes("\\Seen") ? 1 : 0
    const isFlagged = entry.flags.includes("\\Flagged") ? 1 : 0
    if (row.is_read === isRead && row.is_flagged === isFlagged) continue

    await executor.execute(
      `UPDATE messages SET is_read = $1, is_flagged = $2
       WHERE account_id = $3 AND imap_folder = $4 AND imap_uid = $5`,
      [isRead, isFlagged, accountId, folder, entry.uid]
    )
    changedThreads.add(row.thread_id)
    changes += 1
  }

  for (const threadId of changedThreads) {
    await recomputeThreadCaches(executor, threadId)
  }
  return changes
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
