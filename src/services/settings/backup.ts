import { invoke } from "@tauri-apps/api/core"
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog"
import { remove as fsRemove } from "@tauri-apps/plugin-fs"
import { join as joinPath, tempDir } from "@tauri-apps/api/path"
import Database from "@tauri-apps/plugin-sql"

import { flagAllAccountsForReauth } from "../db/accounts"
import { createStrippedSnapshot, type SnapshotStripSummary } from "../db/backup-snapshot"
import { closeDatabase, initDatabase } from "../db/connection"
import { createTauriExecutor, getExecutor, type SqlExecutor } from "../db/executor"
import { mergeSnapshotInto, RestoreCancelledError, type MergeSummary } from "./backup-merge"
import { useAccountStore } from "../../stores/account-store"

/**
 * Backup export/restore orchestration (parity-round-3 tasks 5.1–5.3,
 * design D4). The Rust side (src-tauri/src/backup) only ever moves and
 * hashes file bytes; every SQL statement — the VACUUM INTO snapshot, the
 * secret strip, the merge writes, the post-swap re-auth flags — runs
 * here, through tauri-plugin-sql.
 *
 * Export (task 5.1):
 *   1. a save dialog picks the `.emailer-backup` destination;
 *   2. createStrippedSnapshot writes a SECRET-FREE `VACUUM INTO` copy of
 *      the live database to a fresh temp path (the spike-proven second
 *      connection does the stripping — see backup-snapshot.ts);
 *   3. `export_backup` tars the snapshot with a manifest whose checksums
 *      it computes itself, staging as `<dest>.part` and renaming only on
 *      success — a failed export leaves no archive that could pass for
 *      valid (spec "Export failure");
 *   4. the temp snapshot is removed either way.
 *
 * Restore (tasks 5.2/5.3): `verify_backup_archive` checksums every entry
 * and returns the manifest, whose `version` is gated HERE — an unknown or
 * newer format refuses with a typed error before anything is extracted.
 * `extract_backup_snapshot` then re-verifies while streaming the snapshot
 * into a scratch dir. Replace mode swaps files (close plugin pool →
 * `replace_database_with_snapshot` → re-open → re-auth flag → commit);
 * merge mode imports metadata rows inside one transaction. Every failure
 * before the swap, and the rollback command after it, leaves the
 * pre-restore data intact (spec "Cancel during restore").
 */

/** Bump only with a migration-style format change; older app versions
 * refuse newer archives with a typed error (design "Migration Plan"). */
export const BACKUP_MANIFEST_VERSION = 1

/** The archive extension the save/open dialogs filter on. */
export const BACKUP_FILE_EXTENSION = "emailer-backup"

/** The manifest shape this app writes (parsed back by Rust). */
export interface BackupManifest {
  version: number
  /** ISO timestamp of the export. */
  createdAt: string
  /** The exporting app's version (__APP_VERSION__). */
  appVersion: string
  /** The strip summary, so the archive self-describes its redactions. */
  summary: SnapshotStripSummary
}

/** The manifest facts the restore UI shows before asking for a mode. */
export interface BackupManifestInfo {
  version: number
  createdAt?: string
  appVersion?: string
  summary?: Partial<SnapshotStripSummary>
}

// ---- Typed errors (the UI maps these to copy; kinds are stable) ----

/** A failed export/restore step. `kind` mirrors the Rust BackupError's
 * discriminating string (`checksum_mismatch`, `corrupt_archive`, `io`,
 * `bad_manifest`, `missing_entry`) plus `unknown` for non-Rust causes. */
export class BackupError extends Error {
  readonly kind: string

  constructor(kind: string, message: string) {
    super(message)
    this.name = "BackupError"
    this.kind = kind
  }
}

/** The archive's manifest version is newer than this build understands
 * (or malformed) — the typed refusal the settings UI renders. */
export class UnsupportedManifestVersionError extends BackupError {
  readonly manifestVersion: number

  constructor(manifestVersion: number) {
    super(
      "unsupported_version",
      manifestVersion > BACKUP_MANIFEST_VERSION
        ? `This backup was made by a newer version of Emailer (format v${manifestVersion}). Update this app and try again.`
        : `This file is not a readable Emailer backup (format v${manifestVersion}).`
    )
    this.name = "UnsupportedManifestVersionError"
    this.manifestVersion = manifestVersion
  }
}

/** Map a rejected Rust command (a serialized BackupError object) or any
 * other thrown value into the typed error. */
function toBackupError(raw: unknown): BackupError {
  if (raw instanceof BackupError) return raw
  const candidate = raw as { kind?: unknown; message?: unknown } | null
  if (candidate && typeof candidate.kind === "string") {
    return new BackupError(
      candidate.kind,
      typeof candidate.message === "string"
        ? candidate.message
        : "The backup operation failed."
    )
  }
  return new BackupError(
    "unknown",
    raw instanceof Error ? raw.message : String(raw)
  )
}

// ---- Export (task 5.1) ----

export interface ExportedArchive {
  path: string
  bytes: number
}

export interface ExportBackupDeps {
  /** Destination picker; null = user cancelled. Default: plugin-dialog
   * save() with a dated `.emailer-backup` suggestion. */
  pickDestination?: (suggestedName: string) => Promise<string | null>
  /** Snapshot builder. Default: createStrippedSnapshot (VACUUM INTO +
   * strip). */
  createSnapshot?: (tempPath: string) => Promise<SnapshotStripSummary>
  /** The Rust archive writer. Default: the export_backup command. */
  exportArchive?: (input: {
    snapshotPath: string
    manifestJson: string
    destPath: string
  }) => Promise<ExportedArchive>
  /** Absolute temp path maker. Default: OS temp dir + join. */
  makeTempPath?: (filename: string) => Promise<string>
  /** Temp-file cleanup. Default: plugin-fs remove. */
  removeFile?: (path: string) => Promise<void>
  nowIso?: () => string
}

export interface ExportBackupResult {
  path: string
  bytes: number
  /** How many sealed envelopes the strip redacted, per carrier. */
  summary: SnapshotStripSummary
}

function suggestedBackupName(nowIso: () => string): string {
  return `emailer-backup-${nowIso().slice(0, 10)}.${BACKUP_FILE_EXTENSION}`
}

async function defaultPickDestination(
  suggestedName: string
): Promise<string | null> {
  return saveFileDialog({
    title: "Choose where to save your backup",
    defaultPath: suggestedName,
    filters: [{ name: "Emailer backups", extensions: [BACKUP_FILE_EXTENSION] }],
  })
}

async function defaultExportArchive(input: {
  snapshotPath: string
  manifestJson: string
  destPath: string
}): Promise<ExportedArchive> {
  try {
    const raw = await invoke<{ path: string; bytes: number }>("export_backup", {
      snapshotPath: input.snapshotPath,
      manifestJson: input.manifestJson,
      destPath: input.destPath,
    })
    return { path: raw.path, bytes: raw.bytes }
  } catch (error) {
    throw toBackupError(error)
  }
}

/**
 * Export a backup (task 5.1). Resolves null when the user cancels the
 * destination dialog. The live database is only ever read (VACUUM INTO);
 * a failure of any step removes the temp snapshot, and the Rust writer
 * guarantees no partial archive at the destination.
 */
export async function exportBackup(
  deps: ExportBackupDeps = {}
): Promise<ExportBackupResult | null> {
  const nowIso = deps.nowIso ?? ((): string => new Date().toISOString())
  const destination = await (deps.pickDestination ?? defaultPickDestination)(
    suggestedBackupName(nowIso)
  )
  if (!destination) return null

  const tempPath = await (deps.makeTempPath ?? defaultMakeTempPath)(
    `emailer-export-${crypto.randomUUID()}.db`
  )
  try {
    const summary = await (deps.createSnapshot ?? createStrippedSnapshot)(
      tempPath
    )
    const manifest: BackupManifest = {
      version: BACKUP_MANIFEST_VERSION,
      createdAt: nowIso(),
      appVersion: __APP_VERSION__,
      summary,
    }
    const archive = await (deps.exportArchive ?? defaultExportArchive)({
      snapshotPath: tempPath,
      manifestJson: JSON.stringify(manifest),
      destPath: destination,
    })
    return { path: archive.path, bytes: archive.bytes, summary }
  } finally {
    // The temp snapshot never outlives the export attempt (best-effort —
    // the file may never have been created).
    await (deps.removeFile ?? defaultRemoveFile)(tempPath).catch(() => {})
  }
}

async function defaultRemoveFile(path: string): Promise<void> {
  await fsRemove(path)
}

async function defaultMakeTempPath(filename: string): Promise<string> {
  return joinPath(await tempDir(), filename)
}

// ---- Restore inspection (task 5.2, UI version gate) ----

/** Rust's verify result. */
interface VerifiedArchive {
  manifest: BackupManifestInfo
  bytes: number
}

function manifestInfo(raw: BackupManifestInfo): BackupManifestInfo {
  return {
    version: raw.version,
    ...(raw.createdAt !== undefined ? { createdAt: raw.createdAt } : {}),
    ...(raw.appVersion !== undefined ? { appVersion: raw.appVersion } : {}),
    ...(raw.summary !== undefined ? { summary: raw.summary } : {}),
  }
}

/** Refuse anything this build cannot restore, BEFORE any extraction or
 * live-data contact (task 5.5's typed refusal). */
function assertSupportedVersion(version: number): void {
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version !== BACKUP_MANIFEST_VERSION
  ) {
    throw new UnsupportedManifestVersionError(
      typeof version === "number" ? version : 0
    )
  }
}

/**
 * Verify an archive and return its manifest facts — the pre-restore
 * display (format version, exporting app version, export date) the mode
 * dialog is built from. Throws the typed errors: UnsupportedManifest
 * VersionError for foreign versions, BackupError (corrupt_archive /
 * checksum_mismatch / …) for anything the verifier rejects.
 */
export async function inspectBackupArchive(
  archivePath: string,
  deps: Pick<RestoreBackupDeps, "verifyArchive"> = {}
): Promise<BackupManifestInfo> {
  const verify = deps.verifyArchive ?? defaultVerifyArchive
  const verified = await verify(archivePath)
  assertSupportedVersion(verified.manifest.version)
  return manifestInfo(verified.manifest)
}

async function defaultVerifyArchive(archivePath: string): Promise<VerifiedArchive> {
  try {
    return await invoke<VerifiedArchive>("verify_backup_archive", {
      archivePath,
    })
  } catch (error) {
    throw toBackupError(error)
  }
}

// ---- Restore (tasks 5.2/5.3) ----

export type RestoreMode = "replace" | "merge"

export type RestoreResult =
  | {
      mode: "replace"
      /** Every restored account landed in the needs-reauth state. */
      accountsRequiringReauth: number
    }
  | { mode: "merge"; summary: MergeSummary }

export interface RestoreBackupDeps {
  verifyArchive?: (archivePath: string) => Promise<VerifiedArchive>
  extractArchive?: (
    archivePath: string,
    destDir: string
  ) => Promise<{ snapshotPath: string }>
  /** Scratch-dir maker. Default: OS temp dir + a fresh name. */
  makeScratchDir?: () => Promise<string>
  /** Scratch cleanup. Default: plugin-fs remove (recursive). */
  removeDir?: (path: string) => Promise<void>
  /** Live-database handle seams (replace mode). */
  closeDb?: () => Promise<void>
  openDb?: () => Promise<void>
  /** The live executor (both modes). Default: getExecutor(). */
  executor?: SqlExecutor
  /** The Rust file swap + its finalize (replace mode). */
  replaceDatabase?: (snapshotPath: string) => Promise<void>
  finalizeReplace?: (rollback: boolean) => Promise<void>
  /** Snapshot loader (merge mode): a second plugin connection to the
   * extracted file, with its own close (Windows cannot delete an open
   * SQLite file). */
  loadSnapshot?: (
    snapshotPath: string
  ) => Promise<{ executor: SqlExecutor; close: () => Promise<void> }>
  /** Cancel flag checked between merge steps (merge mode). */
  signal?: { aborted: boolean }
}

async function defaultExtractArchive(
  archivePath: string,
  destDir: string
): Promise<{ snapshotPath: string }> {
  try {
    const raw = await invoke<{ snapshotPath: string }>(
      "extract_backup_snapshot",
      { archivePath, destDir }
    )
    return { snapshotPath: raw.snapshotPath }
  } catch (error) {
    throw toBackupError(error)
  }
}

async function defaultReplaceDatabase(snapshotPath: string): Promise<void> {
  try {
    await invoke("replace_database_with_snapshot", { snapshotPath })
  } catch (error) {
    throw toBackupError(error)
  }
}

async function defaultFinalizeReplace(rollback: boolean): Promise<void> {
  try {
    await invoke("finalize_replaced_database", { rollback })
  } catch (error) {
    throw toBackupError(error)
  }
}

async function defaultLoadSnapshot(
  snapshotPath: string
): Promise<{ executor: SqlExecutor; close: () => Promise<void> }> {
  // Absolute path lands exactly where extraction wrote the file (the
  // plugin's path_mapper passes absolute paths through — the export
  // strip's precedent).
  const database = await Database.load(`sqlite:${snapshotPath}`)
  return {
    executor: createTauriExecutor(database),
    // plugin-sql's close() resolves boolean; the seam contract is void.
    close: async () => {
      await database.close()
    },
  }
}

/**
 * Restore from a verified archive (tasks 5.2/5.3). Verification and the
 * manifest version gate run first; the snapshot extracts into a scratch
 * dir; then:
 *
 * - replace — the plugin pool closes, the Rust command swaps the
 *   verified snapshot in (moving the old database aside under fixed
 *   names), the app re-opens + migrates it, every account is flagged for
 *   re-auth, the device-local offline queue is cleared (its ops belong
 *   to the PRE-restore context; replaying them against restored accounts
 *   could duplicate sends), and the swap commits. Any failure after the
 *   swap rolls the old database back before the error surfaces.
 * - merge — non-conflicting metadata rows import inside ONE transaction
 *   (backup-merge.ts); a cancel or failure rolls back to byte-identical.
 *
 * The scratch dir is removed either way; the message database is NOT
 * merged in merge mode (the UI copy says so).
 */
export async function restoreBackup(
  archivePath: string,
  mode: RestoreMode,
  deps: RestoreBackupDeps = {}
): Promise<RestoreResult> {
  // Gate on the manifest version before a single byte is extracted.
  await inspectBackupArchive(archivePath, deps)

  const scratch = await (deps.makeScratchDir ?? defaultMakeScratchDir)()
  try {
    const extracted = await (deps.extractArchive ?? defaultExtractArchive)(
      archivePath,
      scratch
    )
    if (mode === "replace") {
      return await restoreReplace(extracted.snapshotPath, deps)
    }
    return await restoreMerge(extracted.snapshotPath, deps)
  } finally {
    await (deps.removeDir ?? defaultRemoveDir)(scratch).catch((error) => {
      console.warn("[backup] failed to remove the restore scratch dir", error)
    })
  }
}

async function defaultMakeScratchDir(): Promise<string> {
  return joinPath(
    await tempDir(),
    `emailer-restore-${crypto.randomUUID()}`
  )
}

async function defaultRemoveDir(path: string): Promise<void> {
  await fsRemove(path, { recursive: true })
}

async function restoreReplace(
  snapshotPath: string,
  deps: RestoreBackupDeps
): Promise<RestoreResult> {
  const closeDb = deps.closeDb ?? closeDatabase
  const openDb = deps.openDb ?? initDatabase
  const replace = deps.replaceDatabase ?? defaultReplaceDatabase
  const finalize = deps.finalizeReplace ?? defaultFinalizeReplace

  // The plugin's pool must be closed before the files move (an open
  // SQLite file cannot be renamed on Windows — the delete-all flow's
  // ordering, reused here).
  await closeDb()
  try {
    await replace(snapshotPath)
  } catch (cause) {
    // The swap failed before promoting the snapshot (locked file, IO
    // error — the Rust side restored the pre-swap files best-effort).
    // The session must come back up: leaving the pool closed turns a
    // failed restore into "every database call dead until relaunch".
    await openDb().catch((error) => {
      console.error("[backup] reopening after failed swap failed", error)
    })
    throw cause
  }
  try {
    await openDb()
    const executor = deps.executor ?? getExecutor()
    const accountsRequiringReauth = await flagAllAccountsForReauth(executor)
    await executor.execute("DELETE FROM pending_operations")
    await useAccountStore.getState().reload()
    // The restored database migrated, read and flagged cleanly: the
    // pre-restore copy is no longer needed.
    await finalize(false)
    return { mode: "replace", accountsRequiringReauth }
  } catch (cause) {
    // The swap happened but the restore failed afterwards (migration,
    // read or write error): put the pre-restore database back verbatim,
    // re-open it so the session keeps working, and surface the failure.
    await finalize(true).catch((error) => {
      console.error("[backup] rollback after failed replace failed", error)
    })
    await openDb().catch((error) => {
      console.error("[backup] reopening the rolled-back database failed", error)
    })
    throw cause
  }
}

async function restoreMerge(
  snapshotPath: string,
  deps: RestoreBackupDeps
): Promise<RestoreResult> {
  const executor = deps.executor ?? getExecutor()
  const snapshot = await (deps.loadSnapshot ?? defaultLoadSnapshot)(snapshotPath)
  try {
    // One transaction inside — a cancel or failure leaves the live data
    // byte-identical (RestoreCancelledError included).
    const summary = await mergeSnapshotInto(executor, snapshot.executor, {
      signal: deps.signal,
    })
    await useAccountStore.getState().reload()
    return { mode: "merge", summary }
  } finally {
    await snapshot.close().catch((error) => {
      console.warn("[backup] failed to close the snapshot connection", error)
    })
  }
}

// ---- File picker (task 5.5) ----

/** Pick a backup archive; null = user cancelled. */
export async function pickBackupArchive(): Promise<string | null> {
  return openFileDialog({
    multiple: false,
    title: "Choose a backup file",
    filters: [{ name: "Emailer backups", extensions: [BACKUP_FILE_EXTENSION] }],
  })
}

export { RestoreCancelledError }
export type { MergeSummary }
