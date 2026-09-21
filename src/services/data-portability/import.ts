import { open as pickFilesDialog } from "@tauri-apps/plugin-dialog"

import { decryptCredentials } from "../crypto/credentials"
import type { CacheFs } from "../attachments/cache"
import {
  attachmentCachePath,
  createPluginCacheFs,
  enforceCacheCap,
} from "../attachments/cache"
import { getAccount, toEmailAccount } from "../db/accounts"
import type { SqlExecutor } from "../db/executor"
import { getLabel } from "../db/labels"
import type { LabelRow } from "../db/labels"
import type { AttachmentInput, ContactRef, MessageInput } from "../db/messages"
import { insertMessage } from "../db/messages"
import { markCached } from "../db/attachments"
import {
  getThread,
  insertThread,
  recomputeThreadCaches,
  setThreadFolder,
} from "../db/threads"
import {
  parseEmlFile,
  parseMboxFile,
  type MboxEntryResult,
  type ParsedEml,
} from "../email/invoke"
import { base64ToBytes } from "../email/mime-builder"
import { getProvider } from "../email/provider-factory"
import type { AccountType, ProviderCredentials } from "../email/types"
import { createUserLabel } from "../labels/label-admin"
import {
  findThreadByMessageIdHeader,
  findThreadByReferenceChain,
} from "../sync/thread-lookup"
import type { ThreadableMessage } from "../sync/threading"
import {
  groupIntoThreads,
  messageIdVariants,
  parseReferences,
} from "../sync/threading"

/**
 * EML/mbox import (task 19.3, data-portability spec "Import EML and mbox"
 * + "Safe failure and integrity"). One call imports a batch of user-picked
 * `.eml` / `.mbox` files into a chosen account, specifying an existing
 * folder or a (created-if-missing) folder name:
 *
 * - Parsing lives in Rust (mail_import.rs): the TS side receives fully
 *   decoded messages plus each message's RAW RFC 822 source, so large
 *   files parse once outside the webview and optional server upload can
 *   transmit the original bytes verbatim (IMAP APPEND / Gmail insert).
 * - Destination: an existing labels row (folderId) or a folder name —
 *   created through createUserLabel when missing (the local-first label
 *   CRUD: canonical row id scheme + a queued server create op for both
 *   providers — no parallel folder table).
 * - Dedupe: a parsed message whose Message-ID already exists in the
 *   TARGET FOLDER is skipped and counted (spec: duplicate suppression).
 *   Messages without a Message-ID header have no identity and always
 *   insert. A Message-ID that exists in a DIFFERENT folder of the account
 *   is not a duplicate — the new copy joins that conversation's thread
 *   (the schema's (account_id, message_id_header) index is non-unique on
 *   purpose: cross-folder copies are a supported model).
 * - Threading mirrors the sync engines (imap-sync's three passes): own
 *   Message-ID, then the References/In-Reply-To chain (thread-lookup.ts),
 *   then pure grouping (threading.ts) for the rest, with the same
 *   deterministic thread-id hash — so an imported reply lands in the
 *   thread a synced ancestor created, and vice versa.
 * - Read state: imported messages are inserted READ and uploaded with
 *   \Seen. Restoring a backup must not flood unread counts or
 *   notifications; this is a deliberate, documented choice (the spec is
 *   silent).
 * - Upload (optional): DIRECT provider append at import time via the
 *   existing EmailProvider.appendMessage surface. There is no message-
 *   upload kind in the pending_operations vocabulary (send/send_mime are
 *   outgoing mail), and inventing one would change the queue contract —
 *   so an offline import simply leaves upload undone, reported per entry
 *   in uploadFailures. The local import always completes first; upload
 *   failure never fails the import. Uploaded copies are not linked back
 *   to the local rows (appendMessage returns no server id), so a later
 *   sync of the uploaded copy creates the server's own row.
 * - Safe failure: a corrupt/non-mail FILE (eml) or ENTRY (mbox) is
 *   reported per file in `failed` without aborting the batch; nothing
 *   existing is ever modified or deleted.
 *
 * All side effects sit behind injectable deps (the eml.ts/mbox.ts
 * pattern): Rust parse commands, provider upload, attachment-cache disk
 * and the file picker are substitutable, so the whole flow runs under
 * vitest with fakes.
 */

/** Per-entry failure: mbox entry index (or 0 for .eml files), the
 * subject when known, and the reason. */
export interface ImportEntryFailure {
  index: number
  subject?: string
  error: string
}

/** Outcome for one file of the batch. */
export interface ImportFileResult {
  file: string
  kind: "eml" | "mbox"
  /** Entries inserted locally. */
  imported: number
  /** Entries skipped: Message-ID already present in the target folder. */
  skippedDuplicates: number
  /** Entries appended to the server (only tracked when upload was on). */
  uploaded: number
  /** Parse/insert failures (file-level for .eml, per-entry for mbox). */
  failed: ImportEntryFailure[]
  /** Entries whose optional server upload failed (local insert kept). */
  uploadFailures: ImportEntryFailure[]
}

export interface ImportSummary {
  status: "complete" | "cancelled"
  /** The target folder's labels row (created when a new name was given). */
  folderLabelId: string
  folderName: string
  imported: number
  skippedDuplicates: number
  failed: number
  uploaded: number
  uploadFailures: number
  files: ImportFileResult[]
}

export type ImportDestination =
  { kind: "folderId"; folderId: string } | { kind: "folderName"; name: string }

export interface ImportOptions {
  accountId: string
  destination: ImportDestination
  /** Absolute paths of .eml / .mbox files (the picker's output). */
  filePaths: string[]
  /** Also append each imported message to the server (see module docs). */
  uploadToServer?: boolean
  /** Checked between entries (an AbortSignal fits); aborts the batch. */
  signal?: { aborted: boolean }
  /** Called once with (0, total) after parsing, then after each entry. */
  onProgress?: (done: number, total: number) => void
}

export interface ImportDeps {
  /** Parse one .eml file. Default: the parse_eml_file Rust command. */
  parseEml?: (path: string) => Promise<ParsedEml>
  /** Parse one mbox file into per-entry outcomes. Default: parse_mbox_file. */
  parseMbox?: (path: string) => Promise<MboxEntryResult[]>
  /**
   * Append one raw message to the folder (server copy). Default: the
   * account's provider appendMessage (IMAP APPEND / Gmail insert carrying
   * the folder's label), built from the stored credentials.
   */
  uploadMessage?: (folderName: string, raw: Uint8Array) => Promise<void>
  /** Attachment-cache disk seam. Default: createPluginCacheFs. */
  cacheFs?: CacheFs
  /** Unix-seconds clock for the cache LRU stamp. Default: wall clock. */
  now?: () => number
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Import a batch of .eml/.mbox files (see the module docs). Resolves with
 * the per-file + aggregate summary; only a user-cancelled dialog-level
 * abort (signal) short-circuits, reported as status "cancelled".
 */
export async function importFiles(
  executor: SqlExecutor,
  options: ImportOptions,
  deps: ImportDeps = {}
): Promise<ImportSummary> {
  const account = await getAccount(executor, options.accountId)
  if (!account) {
    throw new Error(`import: account ${options.accountId} does not exist`)
  }

  const folder = await resolveTargetFolder(
    executor,
    account,
    options.destination
  )
  const upload = options.uploadToServer
    ? (deps.uploadMessage ?? createDefaultUpload(executor, account.id))
    : null
  const cacheFs = deps.cacheFs ?? createPluginCacheFs()
  const parseEml = deps.parseEml ?? parseEmlFile
  const parseMbox = deps.parseMbox ?? parseMboxFile

  const summary: ImportSummary = {
    status: "complete",
    folderLabelId: folder.label.id,
    folderName: folder.folderName,
    imported: 0,
    skippedDuplicates: 0,
    failed: 0,
    uploaded: 0,
    uploadFailures: 0,
    files: [],
  }

  // Parse everything first (one Rust pass per file), so progress after
  // this point reflects real insert work. A file the parser cannot open
  // at all is one failed entry — the batch continues.
  const batches: {
    file: ImportFileResult
    entries: { parsed: ParsedEml; index: number }[]
  }[] = []
  for (const path of options.filePaths) {
    const file: ImportFileResult = {
      file: path,
      kind: path.toLowerCase().endsWith(".eml") ? "eml" : "mbox",
      imported: 0,
      skippedDuplicates: 0,
      uploaded: 0,
      failed: [],
      uploadFailures: [],
    }
    const entries: { parsed: ParsedEml; index: number }[] = []
    try {
      if (file.kind === "eml") {
        entries.push({ parsed: await parseEml(path), index: 0 })
      } else {
        for (const entry of await parseMbox(path)) {
          if (entry.error || !entry.message) {
            file.failed.push({
              index: entry.index,
              error: entry.error ?? "unknown mbox entry failure",
            })
          } else {
            entries.push({ parsed: entry.message, index: entry.index })
          }
        }
      }
    } catch (error) {
      file.failed.push({
        index: 0,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    batches.push({ file, entries })
  }

  const total = batches.reduce(
    (count, batch) => count + batch.entries.length,
    0
  )
  options.onProgress?.(0, total)
  let done = 0
  let cancelled = false

  for (const batch of batches) {
    if (cancelled || options.signal?.aborted) {
      cancelled = true
      break
    }
    // Phase A — dedupe + thread resolution (sync engines' pass 1).
    const unassigned: ThreadableMessage[] = []
    const threadIdByIndex = new Map<number, string>()
    for (const entry of batch.entries) {
      if (options.signal?.aborted) {
        cancelled = true
        break
      }
      const variants = messageIdVariants(entry.parsed.messageId ?? "")
      if (
        variants.length > 0 &&
        (await existsInFolder(executor, account, folder, variants))
      ) {
        batch.file.skippedDuplicates += 1
        continue
      }
      const resolved = await resolveThread(executor, account.id, entry.parsed)
      if (resolved) {
        threadIdByIndex.set(entry.index, resolved)
        continue
      }
      unassigned.push(toThreadable(entry.parsed, entry.index))
    }

    // Phase B — pure grouping for the rest; groups reuse an existing
    // thread of the same key or create one stamped with the folder.
    // Threadable ids are String(entry.index), so members map back to
    // entries directly.
    const entryByBatchId = new Map(
      batch.entries.map((entry) => [String(entry.index), entry])
    )
    const createdThreads = new Set<string>()
    for (const group of groupIntoThreads(unassigned)) {
      const threadId = threadIdForKey(account.id, group.key)
      if (!(await getThread(executor, threadId))) {
        // messageIds[0] is the oldest member (sorted by date) — its
        // subject seeds the thread row.
        const anchor = entryByBatchId.get(group.messageIds[0])
        await insertThread(executor, {
          id: threadId,
          accountId: account.id,
          subject: anchor?.parsed.subject ?? undefined,
        })
        await setThreadFolder(executor, threadId, folder.label.id)
        createdThreads.add(threadId)
      }
      for (const member of group.messageIds) {
        const entry = entryByBatchId.get(member)
        if (entry) threadIdByIndex.set(entry.index, threadId)
      }
    }

    // Phase C — persist locally (insert + attachment cache), then the
    // optional upload; caches recomputed after the inserts like sync.
    const touchedThreads = new Set<string>([
      ...threadIdByIndex.values(),
      ...createdThreads,
    ])
    for (const entry of batch.entries) {
      if (cancelled || options.signal?.aborted) {
        cancelled = true
        break
      }
      const threadId = threadIdByIndex.get(entry.index)
      if (!threadId) {
        // Skipped as a duplicate in Phase A — it still counts toward
        // progress.
        done += 1
        options.onProgress?.(done, total)
        continue
      }
      try {
        await insertImportedMessage(
          executor,
          account,
          folder,
          entry.parsed,
          threadId,
          { cacheFs, now: deps.now }
        )
        batch.file.imported += 1
      } catch (error) {
        batch.file.failed.push({
          index: entry.index,
          subject: entry.parsed.subject ?? undefined,
          error: error instanceof Error ? error.message : String(error),
        })
        continue
      }
      if (upload) {
        try {
          await upload(folder.folderName, base64ToBytes(entry.parsed.rawBase64))
          batch.file.uploaded += 1
        } catch (error) {
          batch.file.uploadFailures.push({
            index: entry.index,
            subject: entry.parsed.subject ?? undefined,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      done += 1
      options.onProgress?.(done, total)
    }
    for (const threadId of touchedThreads) {
      await recomputeThreadCaches(executor, threadId)
    }
  }

  for (const batch of batches) {
    const file = batch.file
    summary.files.push({
      file: file.file,
      kind: file.kind,
      imported: file.imported,
      skippedDuplicates: file.skippedDuplicates,
      uploaded: file.uploaded,
      failed: file.failed,
      uploadFailures: file.uploadFailures,
    })
    summary.imported += file.imported
    summary.skippedDuplicates += file.skippedDuplicates
    summary.failed += file.failed.length
    summary.uploaded += file.uploaded
    summary.uploadFailures += file.uploadFailures.length
  }
  if (cancelled) summary.status = "cancelled"
  return summary
}

// ---------------------------------------------------------------------------
// Destination folder
// ---------------------------------------------------------------------------

interface TargetFolder {
  label: LabelRow
  /** The provider folder path / label name uploads (and IMAP dedupe) use. */
  folderName: string
}

/**
 * Resolve the destination to a labels row. An id must belong to the
 * account; a name reuses the account's existing row (UNIQUE per account)
 * or creates one via createUserLabel — the local-first label CRUD, which
 * also queues the server-side folder/label create for both providers.
 */
async function resolveTargetFolder(
  executor: SqlExecutor,
  account: { id: string; type: AccountType },
  destination: ImportDestination
): Promise<TargetFolder> {
  if (destination.kind === "folderId") {
    const label = await getLabel(executor, destination.folderId)
    if (!label || label.account_id !== account.id) {
      throw new Error("import: destination folder not found in this account")
    }
    return { label, folderName: folderNameOf(label) }
  }
  const name = destination.name.trim()
  const rows = await executor.select<LabelRow>(
    "SELECT * FROM labels WHERE account_id = $1 AND name = $2",
    [account.id, name]
  )
  const existing = rows[0]
  if (existing) return { label: existing, folderName: folderNameOf(existing) }
  const created = await createUserLabel({
    executor,
    account: { id: account.id, type: account.type },
    name,
  })
  return { label: created, folderName: folderNameOf(created) }
}

/** The upload/dedupe folder path: the IMAP folder path (the labels row
 * keeps name == path in the ensureFolderLabels convention), else the
 * label name itself (gmail resolves it to a server label at upload). */
function folderNameOf(label: LabelRow): string {
  return label.imap_folder_name ?? label.name
}

// ---------------------------------------------------------------------------
// Dedupe + threading (the sync engines' semantics, folder-scoped)
// ---------------------------------------------------------------------------

/** True when the Message-ID already exists in the TARGET folder — imap:
 * the message's imap_folder; gmail: membership of the message's thread in
 * the folder label (thread_labels is gmail's folder model). */
async function existsInFolder(
  executor: SqlExecutor,
  account: { id: string; type: AccountType },
  folder: TargetFolder,
  variants: string[]
): Promise<boolean> {
  if (account.type === "imap") {
    const rows = await executor.select<{ one: number }>(
      `SELECT 1 AS one FROM messages
       WHERE account_id = $1 AND imap_folder = $2
         AND message_id_header IN ($3, $4)
       LIMIT 1`,
      [account.id, folder.folderName, variants[0], variants[1]]
    )
    return rows.length > 0
  }
  const rows = await executor.select<{ one: number }>(
    `SELECT 1 AS one FROM messages m
     JOIN thread_labels tl ON tl.thread_id = m.thread_id AND tl.label_id = $2
     WHERE m.account_id = $1 AND m.message_id_header IN ($3, $4)
     LIMIT 1`,
    [account.id, folder.label.id, variants[0], variants[1]]
  )
  return rows.length > 0
}

/** Thread of the first persisted ancestor: the message's own Message-ID
 * anywhere in the account, else the References/In-Reply-To chain
 * (imap-sync's resolveThreadFromDb order, shared thread-lookup). */
async function resolveThread(
  executor: SqlExecutor,
  accountId: string,
  parsed: ParsedEml
): Promise<string | null> {
  if (parsed.messageId) {
    const byOwnId = await findThreadByMessageIdHeader(
      executor,
      accountId,
      parsed.messageId
    )
    if (byOwnId) return byOwnId
  }
  // types.ts: References is oldest-first; walk newest→oldest so the
  // nearest existing ancestor decides.
  const chain = parseReferences(parsed.references).reverse()
  for (const inReplyTo of parseReferences(parsed.inReplyTo)) {
    if (!chain.includes(inReplyTo)) chain.unshift(inReplyTo)
  }
  if (chain.length === 0) return null
  return findThreadByReferenceChain(executor, accountId, chain)
}

/** The ThreadableMessage projection groupIntoThreads consumes. The id is
 * the entry's batch position — grouping only routes ids back to entries. */
function toThreadable(parsed: ParsedEml, index: number): ThreadableMessage {
  return {
    id: String(index),
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    subject: parsed.subject,
    date: parsed.date,
  }
}

/**
 * Deterministic thread id from a thread key and account — the SAME hash
 * scheme as imap-sync's private threadIdForKey, mirrored here (sync
 * engines are frozen territory) so a conversation grouped by import and
 * the same conversation grouped by sync converge on one thread id even
 * before the Message-ID lookups would reunite them.
 */
function stableHash(input: string): string {
  let first = 5381
  let second = 52711
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index)
    first = ((first << 5) + first + code) | 0
    second = ((second << 5) + second + code) | 0
  }
  return `${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}`
}

function threadIdForKey(accountId: string, key: string): string {
  return `th-${stableHash(`${accountId}\u0000${key}`)}`
}

// ---------------------------------------------------------------------------
// Message persistence
// ---------------------------------------------------------------------------

interface CacheDeps {
  cacheFs: CacheFs
  now?: () => number
}

/**
 * Insert one parsed message into the target folder (READ — see the module
 * docs) through the same insertMessage path sync uses: FTS triggers fire
 * on insert, attachment descriptors project into the attachments table,
 * and each attachment's decoded bytes are written into the D15 cache
 * (`attachment_cache/<sha-256>.bin` + local_path/cached_at/cache_size)
 * so imported attachments open without a server to fetch from.
 */
async function insertImportedMessage(
  executor: SqlExecutor,
  account: { id: string; type: AccountType },
  folder: TargetFolder,
  parsed: ParsedEml,
  threadId: string,
  cache: CacheDeps
): Promise<void> {
  const messageId = `imp-${randomHex(16)}`
  const attachments: AttachmentInput[] = parsed.attachments.map(
    (attachment, index) => ({
      id: `${messageId}-att-${index}`,
      filename: attachment.filename ?? undefined,
      mimeType: attachment.contentType,
      size: attachment.size,
      contentId: attachment.contentId ?? undefined,
      isInline: attachment.isInline,
      // No server part id exists for imported mail; the stable import
      // order doubles as the cache-identity part (attachmentCachePath).
      providerPartId: `import-${index}`,
    })
  )
  const input: MessageInput = {
    id: messageId,
    threadId,
    accountId: account.id,
    // gmail rows keep gmail_message_id NULL — the uploaded server copy
    // gets its own id (see the module docs on upload linkage).
    imapFolder: account.type === "imap" ? folder.folderName : undefined,
    messageIdHeader: parsed.messageId ?? undefined,
    inReplyTo: parsed.inReplyTo ?? undefined,
    referencesHeader: parsed.references ?? undefined,
    subject: parsed.subject ?? undefined,
    fromName: parsed.from[0]?.name ?? undefined,
    fromAddress: parsed.from[0]?.email ?? undefined,
    to: toContactRefs(parsed.to),
    cc: toContactRefs(parsed.cc),
    bcc: toContactRefs(parsed.bcc),
    date: parsed.date,
    snippet: buildSnippet(parsed),
    bodyHtml: parsed.htmlBody ?? undefined,
    bodyText: parsed.textBody ?? undefined,
    headers: buildStoredHeaders(parsed),
    sizeEstimate: parsed.size,
    // Imported backup mail never announces: READ (module docs).
    isRead: true,
    isFlagged: false,
    hasAttachments: attachments.length > 0,
    attachments,
  }
  await insertMessage(executor, input)

  const fs = cache.cacheFs
  for (const [index, attachment] of parsed.attachments.entries()) {
    if (!attachment.base64Bytes) continue
    const descriptor = attachments[index]
    try {
      const relPath = await attachmentCachePath(
        account.id,
        messageId,
        descriptor.providerPartId ?? String(index),
        descriptor.filename ?? "attachment"
      )
      const bytes = base64ToBytes(attachment.base64Bytes)
      await fs.ensureCacheDir()
      await fs.writeFile(relPath, bytes)
      await markCached(
        executor,
        descriptor.id,
        relPath,
        bytes.length,
        cache.now
      )
      // The D15 global cap applies to import-written bytes too; the
      // attachment just written is never the victim. No AttachmentDeps
      // overrides — the eviction pass only needs defaults (maxCacheBytes).
      await enforceCacheCap(executor, fs, {}, descriptor.id)
    } catch (error) {
      // Cache write failure must not fail the import: the descriptor
      // stays, the attachment just behaves like an uncached one.
      console.warn("[import] attachment cache write failed", error)
    }
  }
}

/** Drop address entries without an email; undefined stays undefined so
 * the column persists as NULL instead of "[]" (the sync engines' rule). */
function toContactRefs(addresses: ParsedEml["to"]): ContactRef[] | undefined {
  const refs: ContactRef[] = []
  for (const address of addresses) {
    if (!address.email) continue
    refs.push(
      address.name === undefined || address.name === null
        ? { email: address.email }
        : { name: address.name, email: address.email }
    )
  }
  return refs.length > 0 ? refs : undefined
}

/** Text preview: text body if present, else a crude tag-strip of the
 * HTML body; whitespace collapsed, capped at 200 chars (the sync
 * engines' buildSnippet). */
function buildSnippet(parsed: ParsedEml): string | undefined {
  const source = parsed.textBody ?? parsed.htmlBody
  if (!source) return undefined
  const text = parsed.textBody ? source : source.replace(/<[^>]*>/g, " ")
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed ? collapsed.slice(0, 200) : undefined
}

/**
 * The stored `headers` JSON (task 18.3, design D13): the list-unsubscribe
 * header pair, verbatim and keyed by lowercase header name — the only
 * headers this surface stores. Undefined when the message carries
 * neither, so the column stays NULL instead of "{}".
 */
function buildStoredHeaders(parsed: ParsedEml): string | undefined {
  const headers: Record<string, string> = {}
  if (parsed.listUnsubscribe !== undefined && parsed.listUnsubscribe !== null) {
    headers["list-unsubscribe"] = parsed.listUnsubscribe
  }
  if (
    parsed.listUnsubscribePost !== undefined &&
    parsed.listUnsubscribePost !== null
  ) {
    headers["list-unsubscribe-post"] = parsed.listUnsubscribePost
  }
  return Object.keys(headers).length > 0 ? JSON.stringify(headers) : undefined
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  )
}

// ---------------------------------------------------------------------------
// Upload default + file picker
// ---------------------------------------------------------------------------

/**
 * Production upload seam: the account's provider appendMessage — IMAP
 * APPEND into the folder, Gmail messages.insert with the folder's server
 * label resolved by name. \Seen keeps the server copy consistent with the
 * read-state choice above (Gmail arrives read via the absent UNREAD
 * label).
 */
function createDefaultUpload(
  executor: SqlExecutor,
  accountId: string
): (folderName: string, raw: Uint8Array) => Promise<void> {
  return async (folderName, raw) => {
    const row = await getAccount(executor, accountId)
    if (!row) throw new Error(`upload: account ${accountId} no longer exists`)
    if (row.status === "auth-error") {
      throw new Error("account is in auth-error state; upload paused")
    }
    const credentials = await decryptCredentials<ProviderCredentials>(
      row.credentials_json
    )
    if (!credentials) {
      throw new Error("account has no stored credentials; upload unavailable")
    }
    const provider = getProvider(toEmailAccount(row), credentials)
    await provider.appendMessage(folderName, raw, ["\\Seen"])
  }
}

/**
 * The settings UI's file picker: `.eml`/`.mbox` multi-select. Resolves the
 * picked absolute paths (null on cancel). The dialog plugin widens the fs
 * scope to the picked paths for the session; the Rust parser reads them
 * directly (mail_import.rs).
 */
export async function pickImportFiles(): Promise<string[] | null> {
  return pickFilesDialog({
    multiple: true,
    title: "Choose email files to import",
    filters: [{ name: "Email files", extensions: ["eml", "mbox"] }],
  })
}
