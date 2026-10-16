import Database from "@tauri-apps/plugin-sql"

import { getDb } from "./connection"
import { createTauriExecutor, type SqlExecutor } from "./executor"

/**
 * The backup snapshot builder (parity-round-3 design D4, task 1.2 spike).
 *
 * Export flow, all frontend-side (Rust never executes app SQL):
 *   1. `VACUUM INTO` writes a compact, fully independent copy of the live
 *      database to `destPath` (schema, data and the FTS5 index included —
 *      proven in the spike: the copy MATCHes just like the original);
 *   2. the snapshot file is opened as a SECOND tauri-plugin-sql database
 *      and the credential/sealed-envelope columns are nulled/emptied in
 *      it, leaving the live database untouched;
 *   3. the caller hands `destPath` to the Rust tar+gz writer (Wave B).
 *
 * Why a second connection instead of design D4's ATTACH: the plugin keeps
 * a sqlx POOL (default 10 connections) per loaded database, and ATTACH is
 * per-connection state — an ATTACH executed through one `execute()` call
 * is invisible to the next statement. Loading the snapshot by its
 * absolute path (`sqlite:/abs/path`) passes through the plugin's
 * path_mapper untouched (PathBuf::push with an absolute path replaces the
 * base), so every strip statement is a self-contained UPDATE on its own
 * pool. Spike-verified equivalent to the ATTACH route (see design.md
 * "Spike results (1.2)").
 */

/**
 * The strip statements, applied to the SNAPSHOT only. Shape notes:
 * - `accounts.credentials_json` is the nullable sealed AES-GCM envelope
 *   (oauth tokens / IMAP password) — nulled outright.
 * - `calendar_sources.config_json` and `carddav_books.credentials_json`
 *   are sealed envelopes too, but NOT NULL — emptied to '' (the row must
 *   survive; restore routes the source/book through its connect flow for
 *   re-sealing, like the accounts re-auth UX).
 * Deliberately NOT stripped (not secrets, per their migration comments):
 * sync cursors (`gmail_history_id`, `sync_state_json`, `sync_token`),
 * `oauth_scope`, `oauth_client_id`.
 */
export const SNAPSHOT_STRIP_STATEMENTS = [
  "UPDATE accounts SET credentials_json = NULL",
  "UPDATE calendar_sources SET config_json = ''",
  "UPDATE carddav_books SET credentials_json = ''",
] as const

/** Per-table count of rows whose sealed column the strip touched. */
export interface SnapshotStripSummary {
  accounts: number
  calendarSources: number
  carddavBooks: number
}

/**
 * Run the strip statements against an open SNAPSHOT database. Exposed
 * over a plain SqlExecutor so tests run the exact shipped SQL against
 * node:sqlite (the production caller adapts the plugin handle with
 * createTauriExecutor).
 */
export async function stripSnapshotDatabase(
  snapshot: SqlExecutor
): Promise<SnapshotStripSummary> {
  const accounts = await snapshot.execute(SNAPSHOT_STRIP_STATEMENTS[0])
  const calendarSources = await snapshot.execute(SNAPSHOT_STRIP_STATEMENTS[1])
  const carddavBooks = await snapshot.execute(SNAPSHOT_STRIP_STATEMENTS[2])
  return {
    accounts: accounts.rowsAffected,
    calendarSources: calendarSources.rowsAffected,
    carddavBooks: carddavBooks.rowsAffected,
  }
}

/**
 * Write a secret-free snapshot of the app database to `destPath` (an
 * ABSOLUTE path — the dialog-picked export target) and return the strip
 * summary. The live database is never modified.
 *
 * Quirks enforced here (spike-proven):
 * - `VACUUM INTO` refuses an existing target file — the caller picks a
 *   fresh temp path (the statement fails loudly otherwise, which is the
 *   safe direction).
 * - `VACUUM INTO` cannot run inside a transaction; it goes through a
 *   single autocommit `execute()`, never inside the migration runner.
 * - The snapshot handle is CLOSED before returning: Wave B's Rust tar
 *   step needs the file unlocked (Windows cannot rename/remove an open
 *   SQLite file).
 */
export async function createStrippedSnapshot(
  destPath: string
): Promise<SnapshotStripSummary> {
  // Absolute POSIX path, Windows drive letter, or UNC share — a relative
  // path would be resolved against the process cwd by VACUUM INTO.
  const absolute =
    destPath.startsWith("/") ||
    destPath.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/.test(destPath)
  if (!absolute) {
    throw new Error(
      "createStrippedSnapshot needs an absolute destination path; " +
        "VACUUM INTO would otherwise resolve it against the process cwd."
    )
  }
  // Single-quoted SQL literal: double the embedded quotes.
  const literal = destPath.replace(/'/g, "''")
  await getDb().execute(`VACUUM INTO '${literal}'`)

  // The plugin maps `sqlite:<rest>` paths through app_config_dir UNLESS
  // the rest is absolute — an absolute path lands exactly where VACUUM
  // INTO wrote the file.
  const snapshotDb = await Database.load(`sqlite:${destPath}`)
  try {
    return await stripSnapshotDatabase(createTauriExecutor(snapshotDb))
  } finally {
    await snapshotDb.close()
  }
}
