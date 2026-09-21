import type { SqlExecutor } from "../db/executor"
import {
  categorizationInputFromEvent,
  categorizeIncomingMessages,
} from "../categorization/ingestion"
import { reconcileProvisionalSent } from "../composer/send"
import { getAccount } from "../db/accounts"
import type { AttachmentInput, ContactRef, MessageInput } from "../db/messages"
import { upsertMessageByProviderId } from "../db/messages"
import {
  listNotificationRules,
  resolveNotificationDecision,
} from "../db/notification-rules"
import type { ThreadInput } from "../db/threads"
import {
  getThread,
  insertThread,
  isThreadMuted,
  recomputeThreadCaches,
  setThreadFolder,
} from "../db/threads"
import { updateSyncState } from "../db/accounts"
import type {
  EmailAddress,
  EmailFolder,
  EmailProvider,
  NormalizedMessage,
} from "../email/types"
import { ProviderAuthError } from "../email/types"
import type { FolderDeltaResult } from "../email/microsoft-graph-provider"
import { parseGraphDeltaCursor } from "../email/microsoft-graph-provider"
import { listEnabledRules } from "../rules/db"
import {
  applyBlockedSenderFiling,
  applyDeliveryHolds,
  applyJunkFiling,
  ingestionEventFromInput,
  recordSenderStats,
  runIngestionRules,
  type IngestionEvent,
} from "../rules/ingestion"
import { listBlockedSenders } from "../db/blocked-senders"
import { listDeliverySchedules } from "../settings/delivery-schedules"
import { loadJunkFilterConfig } from "../security/junk-filter"
import { recordSubscriptionActivity } from "../security/subscription-detection"
import { ensureFolderLabels } from "./imap-sync"
import {
  findThreadByMessageIdHeader,
  findThreadByReferenceChain,
} from "./thread-lookup"
import type { ThreadableMessage } from "./threading"
import { groupIntoThreads, parseReferences } from "./threading"

/**
 * Microsoft Graph sync engine (parity-round-2 task 3.2, design D3):
 * folder list once per pass, then PER-FOLDER `/messages/delta` — an
 * initial pull (every message) when the folder has no stored deltaLink,
 * an incremental delta apply otherwise. Deletions land as `@removed`
 * tombstones and are applied locally; Graph has no labels, so label
 * operations stay local-only for these accounts (the folder mapper
 * resolves junk/archive/trash roles instead).
 *
 * Cursor persistence: each folder's deltaLink rides the account's
 * provider-private TEXT cursor column (accounts.gmail_history_id — the
 * same opaque-cursor channel the gmail engine stores its history id in,
 * types.ts: "an opaque provider-private string"), JSON-encoded as
 * {folderPath → deltaLink}. A folder missing from the map (new folder)
 * gets its initial pull; a REJECTED link (410 Gone / 400) marks the
 * folder needsFullSync and the engine re-pulls it as a silent backfill
 * (countNew false — a resync must not read as fresh mail), the gmail
 * history-expiry semantics.
 *
 * Threading per existing engine semantics (the imap engine's scheme):
 * new messages inherit threads from persisted ancestors via
 * message-id/references lookups, whatever is left groups purely
 * (threading.ts) into deterministic threads, inbox-role arrivals re-file
 * reused threads, and the ingestion hook (rules, delivery schedules,
 * blocked senders, sender stats, categorization, subscription detection)
 * runs before the new-mail count is finalized.
 *
 * Message identity: the Graph message id lives in the provider-id
 * channel (messages.gmail_message_id + the (account, gmail_message_id)
 * unique index); the folder path also lands in imap_folder so the
 * existing folder-scoped queries (import dedupe, UI) keep working.
 */

export interface MicrosoftSyncProgress {
  phase: "folders" | "messages" | "done"
  folderPath?: string
  foldersDone: number
  foldersTotal: number
  newMessages: number
}

export interface MicrosoftSyncOptions {
  executor: SqlExecutor
  /**
   * The factory's MicrosoftGraphProvider (type "microsoft"). Typed as
   * EmailProvider plus the syncFolderDelta seam; the engine narrows at
   * runtime so a mis-registered provider fails with a clear error.
   */
  provider: EmailProvider
  accountId: string
  onProgress?: (progress: MicrosoftSyncProgress) => void
}

export interface MicrosoftSyncSummary {
  /** Folders that completed without an error (empty folders included). */
  foldersSynced: number
  /** Messages newly inserted across all folders (gated, see above). */
  newMessages: number
  /** Distinct threads created or touched by this run. */
  threadsCreatedOrUpdated: number
  /** Local rows removed for server-deleted (@removed) messages. */
  removedMessages: number
  /** Per-folder failures ("path: message"); other folders still sync. */
  errors: string[]
}

interface FolderOutcome {
  newMessages: number
  threadsCreatedOrUpdated: number
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Sync every folder of one Microsoft account. Provider credential
 * failures (ProviderAuthError) propagate so the account layer can mark
 * the account; all other per-folder errors are collected and the
 * remaining folders still sync.
 */
export async function syncMicrosoftAccount(
  options: MicrosoftSyncOptions
): Promise<MicrosoftSyncSummary> {
  const { executor, provider: plainProvider, accountId } = options
  // Narrow the per-folder delta seam (the MicrosoftGraphProvider shape).
  if (!("syncFolderDelta" in plainProvider)) {
    throw new Error(
      `microsoft sync: the provider for account ${accountId} does not ` +
        "implement syncFolderDelta (register the MicrosoftGraphProvider)"
    )
  }
  const provider = plainProvider as EmailProvider & {
    syncFolderDelta(
      folderId: string,
      deltaLink: string | null
    ): Promise<FolderDeltaResult>
  }
  const onProgress = options.onProgress ?? ((): void => {})
  const account = await getAccount(executor, accountId)
  if (!account) {
    throw new Error(`microsoft sync: account ${accountId} not found`)
  }

  const folders = await provider.listFolders()
  const labelIdsByPath = await ensureFolderLabels(executor, accountId, folders)
  onProgress({
    phase: "folders",
    foldersDone: 0,
    foldersTotal: folders.length,
    newMessages: 0,
  })

  // The per-folder delta links ride the account's provider-private
  // cursor column (see the module comment).
  const cursorMap = parseGraphDeltaCursor(account.gmail_history_id)
  let anyFullPull = false

  const summary: MicrosoftSyncSummary = {
    foldersSynced: 0,
    newMessages: 0,
    threadsCreatedOrUpdated: 0,
    removedMessages: 0,
    errors: [],
  }

  let foldersDone = 0
  for (const folder of folders) {
    try {
      const labelId = labelIdsByPath.get(folder.path) ?? null
      const storedLink = cursorMap[folder.path] ?? null

      let result = await provider.syncFolderDelta(folder.id, storedLink)
      // A rejected/expired link (410/400): full re-pull as a silent
      // backfill (countNew false — a resync must not announce).
      let backfill = false
      if (result.needsFullSync) {
        backfill = true
        result = await provider.syncFolderDelta(folder.id, null)
      }
      // A folder with no stored link runs its initial pull — a seed
      // pass that files everything but announces nothing.
      const seed = storedLink === null
      anyFullPull = anyFullPull || seed || backfill

      const outcome = await storeFolderMessages(
        executor,
        accountId,
        folder,
        labelId,
        result.messages,
        account.email,
        {
          countNew: !seed && !backfill,
          arrivalIsInbox: folder.specialUse === "inbox",
        }
      )

      summary.removedMessages += await applyRemovals(
        executor,
        accountId,
        result.removedIds
      )

      summary.foldersSynced += 1
      summary.newMessages += outcome.newMessages
      summary.threadsCreatedOrUpdated += outcome.threadsCreatedOrUpdated

      if (result.nextDeltaLink) {
        cursorMap[folder.path] = result.nextDeltaLink
      }
      // A feed that ended WITHOUT a deltaLink (or a corrupted link) keeps
      // the previous cursor — the next pass replays it safely (delta
      // replay is idempotent upserts).
    } catch (error) {
      if (error instanceof ProviderAuthError) throw error
      summary.errors.push(`${folder.path}: ${errorMessage(error)}`)
    }
    foldersDone += 1
    onProgress({
      phase: "messages",
      folderPath: folder.path,
      foldersDone,
      foldersTotal: folders.length,
      newMessages: summary.newMessages,
    })
  }

  await updateSyncState(executor, accountId, {
    lastSyncAt: nowSeconds(),
    labelsSyncedAt: nowSeconds(),
    ...(anyFullPull ? { lastFullSyncAt: nowSeconds() } : {}),
    // An empty map would force initial pulls for every folder on the
    // next pass — only overwrite when at least one folder advanced.
    ...(Object.keys(cursorMap).length > 0
      ? { gmailHistoryId: JSON.stringify(cursorMap) }
      : {}),
  })

  onProgress({
    phase: "done",
    foldersDone,
    foldersTotal: folders.length,
    newMessages: summary.newMessages,
  })
  return summary
}

// ---------------------------------------------------------------------------
// Removals (@removed tombstones)
// ---------------------------------------------------------------------------

/** Delete the local rows for server-deleted messages; threads left empty
 * are dropped. Returns the number of removed message rows. */
async function applyRemovals(
  executor: SqlExecutor,
  accountId: string,
  removedIds: string[]
): Promise<number> {
  if (removedIds.length === 0) return 0
  let removed = 0
  const touchedThreads = new Set<string>()
  for (const batch of chunk(removedIds, 100)) {
    const placeholders = batch.map((_, index) => `$${index + 2}`).join(", ")
    const rows = await executor.select<{ id: string; thread_id: string }>(
      `SELECT id, thread_id FROM messages
       WHERE account_id = $1 AND gmail_message_id IN (${placeholders})`,
      [accountId, ...batch]
    )
    for (const row of rows) {
      await executor.execute("DELETE FROM messages WHERE id = $1", [row.id])
      touchedThreads.add(row.thread_id)
      removed += 1
    }
  }
  for (const threadId of touchedThreads) {
    // Threads left with no messages are dropped; survivors recompute
    // their caches (counts/snippet shrank).
    const remaining = await executor.select<{ one: number }>(
      "SELECT 1 AS one FROM messages WHERE thread_id = $1 LIMIT 1",
      [threadId]
    )
    if (remaining.length === 0) {
      await executor.execute("DELETE FROM threads WHERE id = $1", [threadId])
    } else {
      await recomputeThreadCaches(executor, threadId)
    }
  }
  return removed
}

/** Split into fixed-size batches (the executor binds each $n once). */
function chunk(values: string[], size: number): string[][] {
  const batches: string[][] = []
  for (let index = 0; index < values.length; index += size) {
    batches.push(values.slice(index, index + size))
  }
  return batches
}

// ---------------------------------------------------------------------------
// Message persistence + thread assignment (the imap engine's semantics)
// ---------------------------------------------------------------------------

/** Deterministic messages.id for one Graph provider key. */
function graphMessageRowId(accountId: string, graphId: string): string {
  return `mm-${accountId}-${graphId}`
}

/** Deterministic thread id from a thread key and account — the SAME hash
 * scheme as the imap engine's private threadIdForKey (sync engines share
 * the scheme so import/sync/engines converge on one thread id). */
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

/** Count/booking gates for one folder pass. */
interface FolderGates {
  /**
   * False on a seed pass (folder's initial pull) or a delta-link-expiry
   * backfill: the pass stores and files its messages but counts none of
   * them as new — a backfill must not announce.
   */
  countNew: boolean
  /** The arrival folder carries the inbox special-use role. */
  arrivalIsInbox: boolean
}

async function storeFolderMessages(
  executor: SqlExecutor,
  accountId: string,
  folder: EmailFolder,
  labelId: string | null,
  fetched: NormalizedMessage[],
  accountEmail: string,
  gates: FolderGates
): Promise<FolderOutcome> {
  if (fetched.length === 0) {
    return { newMessages: 0, threadsCreatedOrUpdated: 0 }
  }
  const folderPath = folder.path
  const ordered = [...fetched].sort(
    (a, b) => a.date - b.date || rowKey(a).localeCompare(rowKey(b))
  )
  const byRowId = new Map<string, NormalizedMessage>()
  for (const message of ordered) {
    byRowId.set(graphMessageRowId(accountId, rowKey(message)), message)
  }

  const threadIdByRowId = new Map<string, string>()
  const touchedThreads = new Set<string>()
  const createdThreads = new Set<string>()
  const unassigned: ThreadableMessage[] = []

  // Pass 1 — messages already stored under this provider key keep their
  // thread (the upsert below is a server-wins refresh), and brand-new
  // messages inherit a thread from persisted ancestors: first the same
  // Message-ID elsewhere, then the References / In-Reply-To chain.
  for (const message of ordered) {
    const rowId = graphMessageRowId(accountId, rowKey(message))
    const existing = await findExistingThread(
      executor,
      accountId,
      rowKey(message)
    )
    if (existing) {
      threadIdByRowId.set(rowId, existing)
      touchedThreads.add(existing)
      continue
    }
    const resolved = await resolveThreadFromDb(executor, accountId, message)
    if (resolved) {
      threadIdByRowId.set(rowId, resolved)
      touchedThreads.add(resolved)
      continue
    }
    unassigned.push({
      id: rowId,
      messageId: message.messageId,
      inReplyTo: message.inReplyTo,
      references: message.references,
      subject: message.subject,
      date: message.date,
    })
  }

  // Pass 2 — group whatever is left purely (references walk + subject
  // fallback). Groups whose deterministic thread id already exists (same
  // conversation seen in an earlier batch or folder) are reused.
  for (const group of groupIntoThreads(unassigned)) {
    const threadId = threadIdForKey(accountId, group.key)
    const existing = await getThread(executor, threadId)
    if (!existing) {
      const anchor = byRowId.get(group.messageIds[0] ?? "")
      const input: ThreadInput = {
        id: threadId,
        accountId,
        subject: anchor?.subject,
      }
      if (labelId !== null) input.folderLabelId = labelId
      await insertThread(executor, input)
      createdThreads.add(threadId)
    }
    for (const rowId of group.messageIds) {
      threadIdByRowId.set(rowId, threadId)
    }
    touchedThreads.add(threadId)
  }

  // Pass 3 — persist messages, then refresh thread caches; threads
  // created here are stamped with this folder (and its archive/trash/
  // spam caches), reused threads keep the folder they already live in.
  const mutedThreads = new Set<string>()
  for (const threadId of touchedThreads) {
    if (await isThreadMuted(executor, threadId)) mutedThreads.add(threadId)
  }
  const rules = await listNotificationRules(executor, accountId)
  const enabledRules = await listEnabledRules(executor, accountId)
  const deliverySchedules = await listDeliverySchedules(executor, accountId)
  const blockedSenders = await listBlockedSenders(executor, accountId)
  // The junk filter is IMAP-only by its own guard (D19): for a microsoft
  // account this resolves to null and the hook never classifies.
  const junkFilter = await loadJunkFilterConfig(executor, accountId)

  const newEvents: IngestionEvent[] = []
  for (const message of ordered) {
    const rowId = graphMessageRowId(accountId, rowKey(message))
    const threadId = threadIdByRowId.get(rowId)
    if (threadId === undefined) {
      throw new Error(
        `microsoft sync: message ${rowId} was not assigned a thread (internal error)`
      )
    }
    const input = toMessageInput(accountId, folderPath, message, threadId)
    const { created } = await upsertMessageByProviderId(executor, input)
    if (created) {
      // The folder label's row name IS the folder path
      // (ensureFolderLabels), so it doubles as the label name here.
      const event = ingestionEventFromInput(input, [folderPath])
      // List signal (D7): Graph surfaces List-Unsubscribe headers, a
      // stronger signal than the subject heuristic the imap engine uses.
      event.isMailingList = Boolean(
        message.listUnsubscribe ?? message.listUnsubscribePost
      )
      newEvents.push(event)
      // Task 8.7: when the server copy of a sent message first lands,
      // drop the composer's provisional Sent twin (same Message-ID).
      await reconcileProvisionalSent(executor, accountId, input)
    }
  }
  // Thread participation: one lookup per touched thread with new mail,
  // run AFTER the upserts so a user message from this same batch counts
  // too; stamped on that thread's new events only.
  const threadIdsWithNew = new Set(newEvents.map((event) => event.threadId))
  for (const threadId of threadIdsWithNew) {
    const own = await executor.select<{ one: number }>(
      "SELECT 1 AS one FROM messages WHERE thread_id = $1 AND from_address = $2 COLLATE NOCASE LIMIT 1",
      [threadId, accountEmail]
    )
    if (own.length === 0) continue
    for (const event of newEvents) {
      if (event.threadId === threadId) event.threadHasUserMessage = true
    }
  }

  for (const threadId of createdThreads) {
    await setThreadFolder(executor, threadId, labelId)
  }
  // Additive-INBOX re-entry (the imap/gmail model): a NEW message landing
  // in the inbox-role folder re-files a reused thread that currently
  // lives elsewhere — a reply to an archived thread re-enters the inbox.
  if (gates.arrivalIsInbox && labelId !== null) {
    for (const threadId of threadIdsWithNew) {
      if (createdThreads.has(threadId)) continue
      const current = await executor.select<{
        folder_label_id: string | null
      }>("SELECT folder_label_id FROM threads WHERE id = $1", [threadId])
      if ((current[0]?.folder_label_id ?? null) !== labelId) {
        await setThreadFolder(executor, threadId, labelId)
      }
    }
  }
  for (const threadId of touchedThreads) {
    await recomputeThreadCaches(executor, threadId)
  }

  // Ingestion hook — the imap engine's consumer chain, in the same
  // order, before the new-mail count is finalized (ruled-away mail and
  // filed/seeded messages never announce).
  const outcomes = await runIngestionRules(
    executor,
    accountId,
    newEvents,
    {
      rules: enabledRules,
      schedules: deliverySchedules,
      blockedSenders,
      ...(junkFilter ? { junk: junkFilter } : {}),
    }
  )
  await applyDeliveryHolds(executor, outcomes)
  await applyBlockedSenderFiling(executor, accountId, outcomes)
  await applyJunkFiling(executor, accountId, outcomes)
  await recordSenderStats(executor, accountId, accountEmail, newEvents)
  await categorizeIncomingMessages(
    executor,
    newEvents.map((event) => categorizationInputFromEvent(event))
  )
  await recordSubscriptionActivity(executor, accountId, newEvents)

  const outcomeByRowId = new Map(
    outcomes.map((outcome) => [outcome.messageRowId, outcome])
  )
  const filedThreads = new Map<string, boolean>()
  const isThreadFiled = async (threadId: string): Promise<boolean> => {
    const cached = filedThreads.get(threadId)
    if (cached !== undefined) return cached
    const rows = await executor.select<{
      is_trashed: number
      is_spam: number
    }>("SELECT is_trashed, is_spam FROM threads WHERE id = $1", [threadId])
    const filed =
      rows[0] !== undefined &&
      (rows[0].is_trashed === 1 || rows[0].is_spam === 1)
    filedThreads.set(threadId, filed)
    return filed
  }

  let newMessages = 0
  for (const event of newEvents) {
    if (
      gates.countNew &&
      !mutedThreads.has(event.threadId) &&
      !(await isThreadFiled(event.threadId)) &&
      resolveNotificationDecision(
        rules,
        event.fromAddress,
        event.labelNames
      ) === "notify" &&
      !(outcomeByRowId.get(event.messageRowId)?.suppressesNotification ?? false)
    ) {
      newMessages += 1
    }
  }

  return { newMessages, threadsCreatedOrUpdated: touchedThreads.size }
}

/** The provider identity of a fetched message (the Graph id). */
function rowKey(message: NormalizedMessage): string {
  return message.graphId ?? `uid-${message.uid}`
}

/** Thread of the first persisted ancestor of a new message, if any. */
async function resolveThreadFromDb(
  executor: SqlExecutor,
  accountId: string,
  message: NormalizedMessage
): Promise<string | null> {
  if (message.messageId) {
    const byOwnId = await findThreadByMessageIdHeader(
      executor,
      accountId,
      message.messageId
    )
    if (byOwnId) return byOwnId
  }
  // types.ts: References is oldest-first; walk newest→oldest so the
  // nearest existing ancestor decides.
  const chain = parseReferences(message.references).reverse()
  for (const inReplyTo of parseReferences(message.inReplyTo)) {
    if (!chain.includes(inReplyTo)) chain.unshift(inReplyTo)
  }
  if (chain.length === 0) return null
  return findThreadByReferenceChain(executor, accountId, chain)
}

/** Thread of the row already stored under this Graph provider key. */
async function findExistingThread(
  executor: SqlExecutor,
  accountId: string,
  graphId: string
): Promise<string | null> {
  const rows = await executor.select<{ threadId: string }>(
    `SELECT thread_id AS threadId FROM messages
     WHERE account_id = $1 AND gmail_message_id = $2
     LIMIT 1`,
    [accountId, graphId]
  )
  return rows[0]?.threadId ?? null
}

function toMessageInput(
  accountId: string,
  folderPath: string,
  message: NormalizedMessage,
  threadId: string
): MessageInput {
  const graphId = rowKey(message)
  const rowId = graphMessageRowId(accountId, graphId)
  const attachments: AttachmentInput[] = message.attachments.map(
    (attachment) => ({
      id: `${rowId}-${attachment.partId}`,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      size: attachment.size,
      contentId: attachment.contentId,
      isInline: attachment.isInline,
      providerPartId: attachment.partId,
    })
  )
  return {
    id: rowId,
    threadId,
    accountId,
    // The Graph id rides the provider-id channel (unique per account);
    // the folder path lands in the folder column so folder-scoped
    // queries keep working.
    gmailMessageId: graphId,
    imapFolder: folderPath,
    messageIdHeader: message.messageId,
    inReplyTo: message.inReplyTo,
    referencesHeader: message.references,
    subject: message.subject,
    fromName: message.from[0]?.name,
    fromAddress: message.from[0]?.email,
    to: toContactRefs(message.to),
    cc: toContactRefs(message.cc),
    bcc: toContactRefs(message.bcc),
    date: message.date,
    snippet: buildSnippet(message),
    bodyHtml: message.htmlBody,
    bodyText: message.textBody,
    sizeEstimate: message.size,
    authResults: message.authResults,
    // flagsForGraphMessage: read is the \Seen flag, starred \Flagged.
    isRead: message.flags.includes("\\Seen"),
    isFlagged: message.flags.includes("\\Flagged"),
    hasAttachments: message.attachments.length > 0,
    attachments,
    headers: buildStoredHeaders(message),
  }
}

/**
 * The stored `headers` JSON (task 18.3, design D13): the
 * list-unsubscribe header pair captured from the Graph message.
 * Undefined when the message carries neither header.
 */
function buildStoredHeaders(message: NormalizedMessage): string | undefined {
  const headers: Record<string, string> = {}
  if (message.listUnsubscribe !== undefined) {
    headers["list-unsubscribe"] = message.listUnsubscribe
  }
  if (message.listUnsubscribePost !== undefined) {
    headers["list-unsubscribe-post"] = message.listUnsubscribePost
  }
  return Object.keys(headers).length > 0 ? JSON.stringify(headers) : undefined
}

/** Drop address entries without an email; undefined stays undefined so
 * the column persists as NULL instead of "[]". */
function toContactRefs(addresses: EmailAddress[]): ContactRef[] | undefined {
  const refs: ContactRef[] = []
  for (const address of addresses) {
    if (!address.email) continue
    refs.push(
      address.name === undefined
        ? { email: address.email }
        : { name: address.name, email: address.email }
    )
  }
  return refs.length > 0 ? refs : undefined
}

/** Text preview: text body if present, else a crude tag-strip of the
 * HTML body; whitespace collapsed, capped at 200 chars. */
function buildSnippet(message: NormalizedMessage): string | undefined {
  const source = message.textBody ?? message.htmlBody
  if (!source) return undefined
  const text = message.textBody ? source : source.replace(/<[^>]*>/g, " ")
  const collapsed = text.replace(/\s+/g, " ").trim()
  return collapsed ? collapsed.slice(0, 200) : undefined
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
