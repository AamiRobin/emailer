import { invoke } from "@tauri-apps/api/core"

import { closeDatabase, initDatabase } from "../db/connection"

/**
 * Local storage usage + reset (tasks 1.6/1.7, settings spec "Local
 * storage usage and reset", design D11): typed client for the two Rust
 * commands in src-tauri/src/storage.rs plus the human formatting the
 * settings section renders.
 *
 * Breakdown model: the Rust command WALKS the app data/config dirs and
 * sums file sizes per kind — no SQL counting (D11). Message bodies, the
 * AI cache and calendar/task data live INSIDE the single SQLite database
 * (emailer.db), so they are reported as part of the "databases" kind;
 * DATABASES_DESCRIPTION says so explicitly. `unreadableEntries > 0`
 * means the walk hit entries it could not stat — every size is then a
 * lower bound, and the UI labels the total as approximate.
 */

export type StorageKind = "attachments" | "databases" | "keys" | "other"

export interface StorageKindUsage {
  kind: StorageKind
  bytes: number
}

export interface StorageUsage {
  kinds: StorageKindUsage[]
  total: number
  /** Files the walk could not stat — sizes are a lower bound when > 0. */
  unreadableEntries: number
}

/** UI copy per kind (fixed Rust-side order; unknown kinds fall through
 * to a raw label so an older UI never crashes on a newer command). */
export const KIND_LABELS: Record<StorageKind, string> = {
  attachments: "Attachments",
  databases: "Databases & indexes",
  keys: "Sealed credentials",
  other: "Other files",
}

export const KIND_DESCRIPTIONS: Record<StorageKind, string> = {
  attachments: "Downloaded attachment copies, cached by hash",
  databases:
    "The local mail database — message bodies, AI cache, calendar and task data, contacts, preferences",
  keys: "The key file that seals account credentials on this device",
  other: "Support files, such as logs",
}

function isStorageKind(value: string): value is StorageKind {
  return value in KIND_LABELS
}

/** Invoke `storage_usage`, validating the wire shape so a mismatched
 * backend version degrades to an error, not a broken render. */
export async function getStorageUsage(): Promise<StorageUsage> {
  const raw = await invoke<StorageUsage>("storage_usage")
  if (
    typeof raw?.total !== "number" ||
    !Array.isArray(raw?.kinds) ||
    typeof raw?.unreadableEntries !== "number"
  ) {
    throw new Error("storage_usage returned an unexpected shape")
  }
  return {
    total: raw.total,
    unreadableEntries: raw.unreadableEntries,
    kinds: raw.kinds
      .filter(
        (entry): entry is StorageKindUsage =>
          typeof entry?.bytes === "number" &&
          typeof entry?.kind === "string" &&
          isStorageKind(entry.kind)
      )
      .map((entry) => ({ kind: entry.kind, bytes: entry.bytes })),
  }
}

/**
 * "Delete all local data" (task 1.7): close the plugin's database
 * connections FIRST (an open SQLite file cannot be unlinked on Windows),
 * drop the webview's localStorage/sessionStorage (the accent and theme
 * mirrors), then invoke the Rust wipe — which deletes the app data/config
 * dir CONTENTS, clears the webviews' browsing data engine-side and
 * relaunches into first-run. On success this never resolves (the process
 * is gone); a failure RE-OPENS the database so the app keeps working and
 * the caller can surface the error. Note the local drops are partial by
 * nature once the command runs — the UI's failure toast says so.
 */
export async function deleteAllLocalData(): Promise<void> {
  try {
    await closeDatabase()
    localStorage.clear()
    sessionStorage.clear()
    await invoke<void>("delete_all_local_data")
  } catch (error) {
    // A step before the relaunch failed (the close, the storage drop or
    // the wipe itself): restore the session's DB so the app stays usable
    // and the error can be shown.
    try {
      await initDatabase()
    } catch {
      // Nothing more to do — the next boot path re-initializes anyway.
    }
    throw error
  }
}

/** Human-readable byte size ("4.0 KB", "1.2 GB") — one decimal below a
 * gigabyte, two above, matching the settings type scale. */
export function formatStorageSize(bytes: number): string {
  const KB = 1024
  const MB = KB * 1024
  const GB = MB * 1024
  const TB = GB * 1024
  if (bytes < KB) return `${bytes} B`
  if (bytes < MB) return `${(bytes / KB).toFixed(1)} KB`
  if (bytes < GB) return `${(bytes / MB).toFixed(1)} MB`
  if (bytes < TB) return `${(bytes / GB).toFixed(2)} GB`
  return `${(bytes / TB).toFixed(2)} TB`
}
