import { save } from "@tauri-apps/plugin-dialog"
import { open as fsOpen, remove as fsRemove } from "@tauri-apps/plugin-fs"

import type { SqlExecutor } from "../db/executor"
import { listThreadsByFolder, type FolderSelection } from "../db/threads"
import { rebuildEml, sanitizeFileStem, type EmlDeps } from "./eml"

/**
 * mbox export (task 19.2, data-portability spec "Export to mbox") — one
 * RFC 4155 mbox file per folder/label selection, streamed through the fs
 * plugin's file handle so a large folder never holds more than one
 * message in memory: the folder's thread set comes from the SAME
 * listThreadsByFolder query the folder views use, messages are listed
 * per thread (ids only) up front — id+date strings, not bodies — and
 * each message's full MIME is rebuilt (see eml.ts) only at its turn.
 *
 * Framing (what Thunderbird's parser requires): the first byte is `From `
 * and every message separator sits at a line start; body lines starting
 * with `From ` are escaped to `>From ` (mboxrd-style `>*From ` so an
 * already-escaped line round-trips); every message is followed by a
 * blank line, so the file ends with a trailing blank line. The rebuilt
 * EML's CRLF lines are normalized to LF inside the mbox — the format's
 * native convention, and both Thunderbird and mailparse accept either.
 *
 * Progress is reported after every message; cancel is an abort flag
 * (an AbortSignal works) checked between messages — a cancelled export
 * closes the handle and removes the partial file, leaving nothing half
 * written. Export is read-only over the database.
 */

const LF = "\n"
/** Conventional envelope sender when a message has no From address. */
const UNKNOWN_SENDER = "MAILER-DAEMON"

/** Streaming write sink — one mbox file, opened/closed exactly once. */
export interface StreamWriter {
  open(path: string): Promise<void>
  /** Append one chunk (framed message or separator) to the file. */
  write(chunk: string): Promise<void>
  close(): Promise<void>
}

export interface MboxExportDeps extends EmlDeps {
  /**
   * System save dialog; receives the suggested filename and resolves the
   * chosen absolute path, or null when the user cancels. Default:
   * plugin-dialog save().
   */
  saveFileDialog?: (suggestedFilename: string) => Promise<string | null>
  /** Streaming sink for the mbox file. Default: plugin-fs open/write/
   * close file handle. */
  stream?: StreamWriter
  /** Remove a partial file after a mid-export cancel. Default: plugin-fs
   * remove. */
  removeFile?: (absolutePath: string) => Promise<void>
}

export interface MboxExportOptions {
  /** Check between messages (AbortSignal fits); aborts the export. */
  signal?: { aborted: boolean }
  /** Called once with (0, total) up front, then after each message. */
  onProgress?: (done: number, total: number) => void
}

export type MboxExportResult =
  | { status: "complete"; path: string; messages: number }
  | { status: "cancelled"; path: string; messages: number }

/** The `From <sender> <asctime>` separator line for one message. */
export function mboxFromLine(
  fromAddress: string | null,
  dateSeconds: number
): string {
  const sender = (fromAddress ?? "").replace(/\s+/g, "") || UNKNOWN_SENDER
  return `From ${sender} ${asctime(new Date(dateSeconds * 1000))}`
}

/** asctime: "Sat Sep 16 10:00:00 2000" (UTC, day space-padded) — the
 * date format the mbox separator convention expects. */
function asctime(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ]
  const pad = (value: number, size = 2): string =>
    String(value).padStart(size, "0")
  return (
    `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ` +
    `${String(date.getUTCDate()).padStart(2, " ")} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} ${date.getUTCFullYear()}`
  )
}

/**
 * Escape the message text for the mbox body: every line starting with
 * `From ` (with any leading `>`s, so escaping is idempotent and
 * reversible — mboxrd) gains one more `>`.
 */
export function escapeMboxBody(text: string): string {
  return text.replace(/^(>*From )/gm, ">$1")
}

/**
 * Stream one folder/label selection to a single mbox file. Resolves null
 * when the user cancels the save dialog; otherwise the outcome (complete
 * with the message count, or cancelled mid-write with the partial file
 * removed).
 */
export async function exportFolderAsMbox(
  executor: SqlExecutor,
  accountId: string,
  folder: FolderSelection,
  options: MboxExportOptions = {},
  deps: MboxExportDeps = {}
): Promise<MboxExportResult | null> {
  // Ids only — bodies stay in the database until each message's turn.
  const entries = await listFolderMessageEntries(executor, accountId, folder)
  const total = entries.length
  options.onProgress?.(0, total)

  const saveFileDialog = deps.saveFileDialog ?? defaultSaveFileDialog
  const target = await saveFileDialog(
    `${sanitizeFileStem(await folderDisplayName(executor, accountId, folder))}.mbox`
  )
  if (!target) return null

  const stream = deps.stream ?? createPluginStreamWriter()
  const removeFile = deps.removeFile ?? defaultRemoveFile
  let written = 0
  await stream.open(target)
  try {
    for (const entry of entries) {
      if (options.signal?.aborted) {
        await stream.close()
        await removeFile(target)
        return { status: "cancelled", path: target, messages: written }
      }
      const rebuilt = await rebuildEml(executor, entry.id, deps)
      if (!rebuilt) continue
      await stream.write(
        mboxFromLine(entry.fromAddress, entry.date) +
          LF +
          escapeMboxBody(rebuilt.eml.replace(/\r\n/g, LF)) +
          LF
      )
      written += 1
      options.onProgress?.(written, total)
    }
  } catch (error) {
    try {
      await stream.close()
    } catch {
      // The handle was already unusable — the write error is what surfaces.
    }
    throw error
  }
  await stream.close()
  return { status: "complete", path: target, messages: written }
}

/** Message identity in export order: `(id, date)` plus the sender for
 * the separator — everything the framing needs, no bodies held. */
interface MboxEntry {
  id: string
  date: number
  fromAddress: string | null
}

/**
 * The folder's message set, ordered chronologically: the folder's
 * threads via listThreadsByFolder (the folder views' own query, both
 * membership models included), then each thread's message ids in the
 * conversation order, re-sorted by (date, created_at) across threads.
 */
async function listFolderMessageEntries(
  executor: SqlExecutor,
  accountId: string,
  folder: FolderSelection
): Promise<MboxEntry[]> {
  const threads = await listThreadsByFolder(executor, { accountId, folder })
  const entries: MboxEntry[] = []
  for (const thread of threads) {
    const rows = await executor.select<{
      id: string
      date: number
      from_address: string | null
    }>(
      `SELECT id, date, from_address FROM messages
       WHERE thread_id = $1
       ORDER BY date ASC, created_at ASC`,
      [thread.id]
    )
    // Stable sort keeps the per-thread (date, created_at) order within a
    // date tie, so the export order is fully deterministic.
    entries.push(
      ...rows.map((row) => ({
        id: row.id,
        date: row.date,
        fromAddress: row.from_address,
      }))
    )
  }
  return entries.sort((a, b) => a.date - b.date)
}

/** Display name for the suggested filename: the label's name (a labelId
 * or specialUse selection resolves through the labels table), else the
 * preset name. */
async function folderDisplayName(
  executor: SqlExecutor,
  accountId: string,
  folder: FolderSelection
): Promise<string> {
  if (folder.kind === "labelId") {
    const rows = await executor.select<{ name: string }>(
      "SELECT name FROM labels WHERE id = $1 AND account_id = $2",
      [folder.labelId, accountId]
    )
    if (rows[0]?.name) return rows[0].name
  }
  if (folder.kind === "specialUse") {
    const rows = await executor.select<{ name: string }>(
      "SELECT name FROM labels WHERE special_use = $1 AND account_id = $2 ORDER BY rowid ASC LIMIT 1",
      [folder.specialUse, accountId]
    )
    return rows[0]?.name ?? folder.specialUse
  }
  // Only the preset selection remains here: the labelId variant falls
  // through when its label row is gone, so narrow before reading the name.
  return folder.kind === "preset" ? folder.preset : folder.labelId
}

// ---------------------------------------------------------------------------
// Plugin defaults
// ---------------------------------------------------------------------------

async function defaultSaveFileDialog(
  suggestedFilename: string
): Promise<string | null> {
  return save({ defaultPath: suggestedFilename })
}

async function defaultRemoveFile(absolutePath: string): Promise<void> {
  await fsRemove(absolutePath)
}

/**
 * plugin-fs file handle writer: open once (truncate — the save dialog
 * already confirmed overwriting), append per chunk, close at the end.
 * The dialog plugin has already widened the fs runtime scope to the
 * picked path; the `write` command rides the appdata-write capability's
 * write-all set, while `open` requires fs:allow-open — add that
 * permission when wiring the export UI (task 19.4).
 */
function createPluginStreamWriter(): StreamWriter {
  let handle: Awaited<ReturnType<typeof fsOpen>> | null = null
  const encoder = new TextEncoder()
  return {
    async open(path) {
      handle = await fsOpen(path, {
        write: true,
        create: true,
        truncate: true,
      })
    },
    async write(chunk) {
      if (!handle) throw new Error("mbox stream is not open")
      await handle.write(encoder.encode(chunk))
    },
    async close() {
      if (!handle) return
      await handle.close()
      handle = null
    },
  }
}
