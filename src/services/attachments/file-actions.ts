import { save, ask } from "@tauri-apps/plugin-dialog"
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
import { attachmentRisk } from "./attachment-policy"
import {
  scanBeforeOpen,
  type MalwareLookupDeps,
  type ScanOutcome,
} from "./malware-lookup"

/**
 * Attachment file actions (task 7.5): "Save as…" through the system save
 * dialog, and "Open" with the OS default app. Both are thin wrappers —
 * the Tauri plugins are only touched through the injectable defaults, so
 * tests substitute plain fakes. Save targets picked in the dialog are
 * added to the fs plugin's runtime scope by the dialog plugin itself, so
 * writing to the chosen path needs no extra capability.
 *
 * Open-path security gates (tasks 18.8/18.9, designs D17/D18), in order:
 * 1. Static policy (attachment-policy.ts): a block/caution-tier filename
 *    requires explicit confirmation before the FIRST open — remembered
 *    per attachment for the session, so one "Open anyway" covers every
 *    later open of the same file (and its message re-renders). Safe
 *    documents and media skip straight through. The gate runs before
 *    anything else, so declining never touches the network or disk.
 * 2. Opt-in malware lookup (malware-lookup.ts): while enabled with an API
 *    key, the cached bytes' SHA-256 is looked up; malicious BLOCKS the
 *    open with the engine report (override = explicit re-confirm, asked
 *    on EVERY open — a flagged file never opens on a stale "remembered"
 *    yes) and suspicious warns. Off, offline, keyless or failed lookups
 *    fall back to gate 1 alone; no error is surfaced.
 *
 * Both gates reuse one confirmation seam (`deps.confirm`, defaulting to
 * the plugin-dialog native `ask`), so the open path stays testable.
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
  /**
   * The open-path confirmation dialogs (D17 static warning first-open +
   * D18 malicious/suspicious). Resolves true = proceed. Default:
   * plugin-dialog ask() with a message naming the risk.
   */
  confirm?: (confirmation: OpenConfirmation) => Promise<boolean>
  /** Malware lookup seams (settings/lookup/clock). Default: global
   * preferences + the VirusTotal-compatible hash lookup. */
  malwareScan?: MalwareLookupDeps
}

/** Why the open path is asking before proceeding. */
export type OpenConfirmationKind =
  | "block" // static policy: executable/script format (D17)
  | "caution" // static policy: macro-enabled Office document (D17)
  | "malicious" // hash lookup reported malicious (D18)
  | "suspicious" // hash lookup reported suspicious (D18)

/** One confirmation request: the filename plus the report counts for the
 * malware kinds (the "N of M engines" report). */
export interface OpenConfirmation {
  kind: OpenConfirmationKind
  filename: string
  maliciousCount?: number | null
  totalEngines?: number | null
}

/** The outcome of a completed open attempt. `opened` is false exactly
 * when the user declined the malware block/warn dialog (the scan verdict
 * is still reported so the UI can flag the row); a DECLINED STATIC
 * warning resolves null instead — nothing ran, nothing to report. */
export interface OpenAttachmentResult {
  localPath: string
  /** Malware scan outcome; null when the malware gate never ran (it
   * short-circuits while disabled). */
  scan: ScanOutcome | null
  opened: boolean
}

/**
 * Static-warning memory (D17): attachments already confirmed once this
 * session, keyed by attachment id (globally unique per message part), so
 * the confirm fires only on the first open. Session-scoped on purpose —
 * restarting the app resets to safe defaults.
 */
const confirmedFirstOpens = new Set<string>()

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
 * "Open": run the security gates (static policy first-open confirmation,
 * then the opt-in malware lookup), make sure the content is cached
 * (fetching from the server on first access — see cache.ts), then hand
 * the cached file to the OS default application. Resolves null when the
 * user declines the static first-open confirmation (nothing was
 * fetched/opened), otherwise the attempt's result with the cache-relative
 * path, the scan outcome and whether the file actually opened.
 */
export async function openAttachment(
  executor: SqlExecutor,
  account: EmailAccount,
  message: AttachmentMessageSource,
  attachment: AttachmentRow,
  deps: FileActionDeps = {}
): Promise<OpenAttachmentResult | null> {
  // ---- Gate 1 (D17): static policy, first open per attachment ----
  const risk = attachmentRisk(attachment.filename)
  if (risk !== "safe" && !confirmedFirstOpens.has(attachment.id)) {
    const confirm = deps.confirm ?? defaultConfirm
    const proceed = await confirm({
      kind: risk,
      filename: attachment.filename ?? "",
    })
    if (!proceed) return null
    confirmedFirstOpens.add(attachment.id)
  }

  const { localPath, bytes } = await ensureAttachmentCached(
    executor,
    account,
    message,
    attachment,
    deps
  )

  // ---- Gate 2 (D18): opt-in malware hash lookup ----
  const scan = await scanBeforeOpen(executor, bytes, deps.malwareScan ?? {})
  if (scan.verdict === "malicious" || scan.verdict === "suspicious") {
    const confirm = deps.confirm ?? defaultConfirm
    const proceed = await confirm({
      kind: scan.verdict,
      filename: attachment.filename ?? "",
      maliciousCount: scan.maliciousCount,
      totalEngines: scan.totalEngines,
    })
    if (!proceed) return { localPath, scan, opened: false }
  }

  const openWithDefaultApp = deps.openPath ?? openPath
  const absolute = await (deps.resolveAppPath ?? defaultResolveAppPath)(
    localPath
  )
  // Defense in depth: the opener capability is scoped to $APPDATA/**, and
  // a well-formed localPath is always `attachment_cache/<sha-256>.bin`.
  // Reject anything else (a tampered DB row) before it reaches the OS.
  if (!isCacheRelativePath(localPath)) {
    throw new Error(`attachment path escapes the cache directory: ${localPath}`)
  }
  await openWithDefaultApp(absolute)
  return { localPath, scan, opened: true }
}

/**
 * True when `relPath` is a cache-module-shaped relative path
 * (`attachment_cache/<name>.bin`): one path segment under the cache dir,
 * no separators or parent refs, so it cannot escape AppData even if the
 * DB row was tampered with.
 */
export function isCacheRelativePath(relPath: string): boolean {
  return /^attachment_cache\/[A-Za-z0-9._-]+\.bin$/.test(relPath)
}

// ---------------------------------------------------------------------------
// Confirmation copy (the dialogs name the risk)
// ---------------------------------------------------------------------------

/** Human-facing text for one confirmation, rendered by the default
 * native dialog (and usable by any injected UI). */
export function openConfirmationMessage(
  confirmation: OpenConfirmation
): string {
  const name = confirmation.filename || "This file"
  switch (confirmation.kind) {
    case "block":
      return `${name} is an executable or script file. Malicious email attachments commonly use this format to run code on your machine. Only open it if you trust the sender and expected this file.`
    case "caution":
      return `${name} is a macro-enabled Office document. Its macros can run code — only open it if you trust the sender and expected this file.`
    case "malicious": {
      const report = reportCounts(confirmation)
      return `Opening ${name} was BLOCKED: the malware lookup reports this file as malicious${report}. Opening it could harm this machine.`
    }
    case "suspicious": {
      const report = reportCounts(confirmation)
      return `The malware lookup flagged ${name} as suspicious${report}. Open it only if you trust the sender.`
    }
  }
}

/** The " (N of M engines flagged this file)" report fragment. */
function reportCounts(confirmation: OpenConfirmation): string {
  const { maliciousCount, totalEngines } = confirmation
  if (typeof maliciousCount !== "number" || typeof totalEngines !== "number") {
    return ""
  }
  return ` (${maliciousCount} of ${totalEngines} engines flagged this file)`
}

const CONFIRM_TITLES: Record<OpenConfirmationKind, string> = {
  block: "Dangerous attachment",
  caution: "Possible macro document",
  malicious: "Malware detected",
  suspicious: "Suspicious attachment",
}

async function defaultConfirm(
  confirmation: OpenConfirmation
): Promise<boolean> {
  return ask(openConfirmationMessage(confirmation), {
    title: CONFIRM_TITLES[confirmation.kind],
    kind: "warning",
    okLabel: "Open anyway",
    cancelLabel: "Cancel",
  })
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
