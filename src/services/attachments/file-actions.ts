import { save } from "@tauri-apps/plugin-dialog"
import { openPath } from "@tauri-apps/plugin-opener"
import { writeFile as fsWriteFile } from "@tauri-apps/plugin-fs"
import { appDataDir, join } from "@tauri-apps/api/path"

import type { AttachmentRow } from "../db/messages"
import type { SqlExecutor } from "../db/executor"
import type { EmailAccount } from "../email/types"
import {
  ensureAttachmentCached,
  type AttachmentDeps,
  type AttachmentMessageSource,
} from "./cache"

/**
 * Attachment file actions (task 7.5): "Save as…" through the system save
 * dialog, and "Open" with the OS default app. Both are thin wrappers —
 * the Tauri plugins are only touched through the injectable defaults, so
 * tests substitute plain fakes. Save targets picked in the dialog are
 * added to the fs plugin's runtime scope by the dialog plugin itself, so
 * writing to the chosen path needs no extra capability.
 */

export interface FileActionDeps extends AttachmentDeps {
  /**
   * System save dialog; receives the suggested filename and resolves the
   * chosen absolute path, or null when the user cancels.
   * Default: @tauri-apps/plugin-dialog save().
   */
  saveDialog?: (suggestedFilename: string | null) => Promise<string | null>
  /** Write bytes to an absolute path. Default: plugin-fs writeFile. */
  writeFile?: (absolutePath: string, data: Uint8Array) => Promise<void>
  /** Open a file with the OS default app. Default: plugin-opener openPath. */
  openPath?: (absolutePath: string) => Promise<void>
  /** Resolve an AppData-relative cache path to an absolute one. */
  resolveAppPath?: (relPath: string) => Promise<string>
}

/**
 * "Save as…": show the system save dialog pre-filled with the
 * attachment's filename, write `content` to the chosen path. Resolves
 * null when the user cancels the dialog, otherwise the written path.
 */
export async function saveAttachmentAs(
  attachment: Pick<AttachmentRow, "filename">,
  content: Uint8Array,
  deps: FileActionDeps = {}
): Promise<string | null> {
  const saveDialog = deps.saveDialog ?? defaultSaveDialog
  const target = await saveDialog(attachment.filename ?? null)
  if (!target) return null
  const writeFile = deps.writeFile ?? defaultWriteFile
  await writeFile(target, content)
  return target
}

/**
 * "Open": make sure the content is cached (fetching from the server on
 * first access — see cache.ts), then hand the cached file to the OS
 * default application. Resolves with the cache-relative path that was
 * opened.
 */
export async function openAttachment(
  executor: SqlExecutor,
  account: EmailAccount,
  message: AttachmentMessageSource,
  attachment: AttachmentRow,
  deps: FileActionDeps = {}
): Promise<string> {
  const { localPath } = await ensureAttachmentCached(
    executor,
    account,
    message,
    attachment,
    deps
  )
  const openWithDefaultApp = deps.openPath ?? openPath
  const absolute = await (deps.resolveAppPath ?? defaultResolveAppPath)(
    localPath
  )
  await openWithDefaultApp(absolute)
  return localPath
}

// ---------------------------------------------------------------------------
// Plugin defaults
// ---------------------------------------------------------------------------

async function defaultSaveDialog(
  suggestedFilename: string | null
): Promise<string | null> {
  return save({ defaultPath: suggestedFilename ?? undefined })
}

async function defaultWriteFile(
  absolutePath: string,
  data: Uint8Array
): Promise<void> {
  // Absolute target: no baseDir. The dialog plugin has already widened
  // the fs runtime scope to include the picked path.
  await fsWriteFile(absolutePath, data)
}

async function defaultResolveAppPath(relPath: string): Promise<string> {
  return join(await appDataDir(), relPath)
}
