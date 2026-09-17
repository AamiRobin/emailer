import type { SqlExecutor } from "../db/executor"
import { reconcileProvisionalSent } from "../composer/send"
import { getAccount } from "../db/accounts"
import { findLabelByImapFolder, getLabel, insertLabel } from "../db/labels"
import type { SpecialUse } from "../db/labels"
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
import {
  systemLabelForSpecialUse,
  userFolderLabelId,
} from "../email/folder-mapper"
import type {
  EmailAddress,
  EmailFolder,
  EmailProvider,
  FetchMessagesResult,
  NormalizedMessage,
} from "../email/types"
import { ProviderAuthError } from "../email/types"
import { getFolderSyncState, upsertFolderSyncState } from "./folder-sync-state"
import type { FetchFlagsChangedFn } from "./flag-sync"
import { reconcileAllFolderFlags } from "./flag-sync"
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
import {
  findMessageByImapUid,
  findThreadByMessageIdHeader,
  findThreadByReferenceChain,
} from "./thread-lookup"
import type { ThreadableMessage } from "./threading"
import { groupIntoThreads, parseReferences } from "./threading"

/**
 * IMAP delta sync (task 4.3, design D9/D14). Drives the EmailProvider
 * fetch surface directly per folder — the provider's deltaSync stays
 * unimplemented for IMAP; the cursor state lives in `folder_sync_state`
 * (UIDVALIDITY + last seen UID) instead of an opaque string.
 *
 * Per selectable folder:
 * - first sync or no stored UIDVALIDITY → full sync: the leading
 *   {last: batch} window plus explicit UID-range pages down to UID 1,
 *   replacing any local folder state.
 * - UIDVALIDITY mismatch → the stored UIDs are meaningless: local
 *   messages of that folder are dropped (empty threads cleaned up) and
 *   the full sync runs again.
 * - otherwise delta: fetch the most recent {last: batch} window and
 *   treat UIDs above lastSeenUid as new; if the window is saturated
 *   with new messages, explicit UID-range pages fetch the rest. The
 *   IMAP "n:*" quirk (the range always includes the newest message even
 *   when n exceeds every UID) is neutralized by filtering uid > lastSeenUid.
 *   Re-fetched older messages upsert as a server-wins refresh (flags,
 *   bodies) without counting as new. Flag consistency for already-synced
 *   messages (other-client read/star changes) is the separate pass
 *   reconcileAllFolderFlags (task 4.7, D14) — run after the delta loop
 *   when `reconcileFlags` is on (default).
 *
 * Deletion detection (messages expunged server-side without a
 * UIDVALIDITY change) is OUT OF SCOPE here — needs deeper provider
 * support; the flag-consistency task (4.7) and a later pass revisit it.
 *
 * Threading: new messages are matched against persisted ancestors via
 * message-id/references lookups (thread-lookup.ts); whatever is left is
 * grouped purely (threading.ts) into deterministic threads keyed by the
 * root Message-ID (subject fallback configurable there, on by default).
 */

const DEFAULT_BATCH_SIZE = 200

/** Rust error text when `last` is used on a folder with no messages. */
const NO_MESSAGES_MARKER = "no messages to fetch"

export interface ImapSyncProgress {
  phase: "folders" | "messages" | "done"
  folderPath?: string
  foldersDone: number
  foldersTotal: number
  newMessages: number
}

export interface ImapSyncOptions {
  executor: SqlExecutor
  provider: EmailProvider
  accountId: string
  onProgress?: (progress: ImapSyncProgress) => void
  /**
   * Messages fetched per provider call (default 200). The delta query is
   * always {last: batchSize}; full syncs page explicit UID ranges of the
   * same size. Exposed mainly for tests.
   */
  batchSize?: number
  /**
   * Run the flag-consistency pass (task 4.7, D14) after the per-folder
   * delta loop (default true).
   */
  reconcileFlags?: boolean
  /**
   * CONDSTORE changed-since hook (RFC 7162) for the flag-consistency pass;
   * when absent the pass falls back to a flags-only window re-scan.
   */
  fetchFlagsChanged?: FetchFlagsChangedFn
}

export interface ImapSyncSummary {
  /** Folders that completed without an error (empty folders included). */
  foldersSynced: number
  /** Messages newly inserted across all folders. */
  newMessages: number
  /** Distinct threads created or touched by this run. */
  threadsCreatedOrUpdated: number
  /** Messages whose is_read/is_flagged were corrected by the flag pass. */
  flagChanges: number
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
 * Sync every selectable folder of one IMAP account. Provider credential
 * failures (ProviderAuthError) propagate so the account layer (5.6) can
 * mark the account; all other per-folder errors are collected and the
 * remaining folders still sync.
 */
export async function syncImapAccount(
  options: ImapSyncOptions
): Promise<ImapSyncSummary> {
  const { executor, provider, accountId } = options
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const onProgress = options.onProgress ?? ((): void => {})
  // The account's own address anchors the sender-stats flags (task 13.1,
  // D7: direct-to-me + thread participation). Aliases (task 16) will
  // widen this to the alias set.
  const account = await getAccount(executor, accountId)
  if (!account) {
    throw new Error(`imap sync: account ${accountId} not found`)
  }

  const folders = await provider.listFolders()
  const labelIdsByPath = await ensureFolderLabels(executor, accountId, folders)
  onProgress({
    phase: "folders",
    foldersDone: 0,
    foldersTotal: folders.length,
    newMessages: 0,
  })

  const summary: ImapSyncSummary = {
    foldersSynced: 0,
    newMessages: 0,
    threadsCreatedOrUpdated: 0,
    flagChanges: 0,
    errors: [],
  }

  let foldersDone = 0
  for (const folder of folders) {
    try {
      const labelId = labelIdsByPath.get(folder.path) ?? null
      const outcome = await syncFolder(
        executor,
        provider,
        accountId,
        folder,
        labelId,
        batchSize,
        account.email
      )
      summary.foldersSynced += 1
      summary.newMessages += outcome.newMessages
      summary.threadsCreatedOrUpdated += outcome.threadsCreatedOrUpdated
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

  // Flag consistency pass (task 4.7, D14): reconcile read/flagged changes
  // made in other clients for already-synced messages. Per-folder flag
  // failures are collected; credential failures propagate like delta sync.
  if (options.reconcileFlags ?? true) {
    try {
      const flagSummary = await reconcileAllFolderFlags({
        executor,
        provider,
        accountId,
        folders,
        ...(options.fetchFlagsChanged
          ? { fetchFlagsChanged: options.fetchFlagsChanged }
          : {}),
      })
      summary.flagChanges = flagSummary.changes
      summary.errors.push(...flagSummary.errors)
    } catch (error) {
      if (error instanceof ProviderAuthError) throw error
      summary.errors.push(`flag sync: ${errorMessage(error)}`)
    }
  }

  onProgress({
    phase: "done",
    foldersDone,
    foldersTotal: folders.length,
    newMessages: summary.newMessages,
  })
  return summary
}

// ---------------------------------------------------------------------------
// Folder labels
// ---------------------------------------------------------------------------

/**
 * Labels-table id for a folder, reusing the folder-mapper identity scheme
 * (systemLabelForSpecialUse / userFolderLabelId — EmailFolder.id). The
 * scheme is only unique per account while labels.id is a global primary
 * key, so rows are namespaced with the account id.
 */
function folderLabelIdentity(
  accountId: string,
  folder: EmailFolder
): {
  id: string
  name: string
  type: "system" | "user"
  specialUse: SpecialUse | null
} {
  if (folder.specialUse) {
    const system = systemLabelForSpecialUse(folder.specialUse)
    return {
      id: `${accountId}:${system.id}`,
      name: folder.path,
      type: system.type,
      specialUse: folder.specialUse,
    }
  }
  return {
    id: `${accountId}:${userFolderLabelId(folder.path)}`,
    name: folder.path,
    type: "user",
    specialUse: null,
  }
}

/**
 * Idempotently create the labels row for every listed folder (the IMAP
 * folder model: one label per folder, imapFolderName = folder path).
 * Returns folder path → labels.id for thread folder stamping.
 */
export async function ensureFolderLabels(
  executor: SqlExecutor,
  accountId: string,
  folders: EmailFolder[]
): Promise<Map<string, string>> {
  const labelIdsByPath = new Map<string, string>()
  for (const folder of folders) {
    const identity = folderLabelIdentity(accountId, folder)

    const existing =
      (await getLabel(executor, identity.id)) ??
      (await findLabelByImapFolder(executor, accountId, folder.path))
    if (existing) {
      labelIdsByPath.set(folder.path, existing.id)
      continue
    }

    await insertLabel(executor, {
      id: identity.id,
      accountId,
      name: identity.name,
      imapFolderName: folder.path,
      specialUse: identity.specialUse ?? undefined,
      type: identity.type,
    })
    labelIdsByPath.set(folder.path, identity.id)
  }
  return labelIdsByPath
}

// ---------------------------------------------------------------------------
// Per-folder sync
// ---------------------------------------------------------------------------

async function syncFolder(
  executor: SqlExecutor,
  provider: EmailProvider,
  accountId: string,
  folder: EmailFolder,
  labelId: string | null,
  batchSize: number,
  accountEmail: string
): Promise<FolderOutcome> {
  const state = await getFolderSyncState(executor, accountId, folder.path)

  let first: FetchMessagesResult
  try {
    first = await provider.fetchMessages(folder.path, { last: batchSize })
  } catch (error) {
    if (!isNoMessagesError(error)) throw error
    // Empty folder (the Rust layer refuses `last` with no messages):
    // nothing to fetch — keep any stored cursor, refresh the timestamp.
    await upsertFolderSyncState(executor, {
      accountId,
      folderName: folder.path,
      uidvalidity: state?.uidvalidity ?? null,
      lastSeenUid: state?.last_seen_uid ?? 0,
      highestModseq: state?.highest_modseq ?? null,
    })
    return { newMessages: 0, threadsCreatedOrUpdated: 0 }
  }

  const status = first.folderStatus
  const invalidated =
    state !== null &&
    state.uidvalidity !== null &&
    state.uidvalidity !== status.uidValidity

  let fetched: NormalizedMessage[]
  if (state === null || state.uidvalidity === null) {
    fetched = await collectFullFolder(provider, folder.path, first, batchSize)
  } else if (invalidated) {
    await replaceFolderLocalState(executor, accountId, folder.path)
    fetched = await collectFullFolder(provider, folder.path, first, batchSize)
  } else {
    fetched = await collectDeltaFolder(
      provider,
      folder.path,
      state.last_seen_uid,
      first,
      batchSize
    )
  }

  const invalidatedCursor =
    state === null || state.uidvalidity === null || invalidated
  const previousLastSeenUid = invalidatedCursor ? 0 : state.last_seen_uid

  const outcome = await storeFolderMessages(
    executor,
    accountId,
    folder.path,
    labelId,
    fetched,
    previousLastSeenUid,
    accountEmail,
    {
      // Seed pass (first sync of this folder, or its UIDVALIDITY reset):
      // the whole folder is a backfill — store and file everything, but
      // the count is capped to 0 so a seed never reads as fresh mail. A
      // folder synced while EMPTY is not a seed: its state row exists (with
      // a null uidvalidity — the server never reported one) but saw no
      // messages, so its first real arrival must still announce (the row's
      // last_seen_uid is 0 and the uid gate below counts it).
      countNew: !(state === null || invalidated),
      // Additive-INBOX rule (the gmail model): only an inbox-role arrival
      // folder may re-file a reused thread into the inbox.
      arrivalIsInbox: folder.specialUse === "inbox",
    }
  )

  const maxSeenUid = fetched.reduce(
    (max, message) => Math.max(max, message.uid),
    previousLastSeenUid
  )
  await upsertFolderSyncState(executor, {
    accountId,
    folderName: folder.path,
    uidvalidity: status.uidValidity,
    lastSeenUid: maxSeenUid,
    // Preserve the CONDSTORE cursor the flag pass (4.7) maintains; a
    // mod-sequence is only valid within one UIDVALIDITY space, so a fresh
    // or invalidated folder starts over without one.
    highestModseq: invalidatedCursor ? null : (state.highest_modseq ?? null),
  })

  return outcome
}

/**
 * Full folder fetch: the leading {last: batch} window followed by
 * explicit UID-range pages down to UID 1, so folders larger than one
 * batch sync completely while each provider call stays bounded.
 */
async function collectFullFolder(
  provider: EmailProvider,
  folderPath: string,
  first: FetchMessagesResult,
  batchSize: number
): Promise<NormalizedMessage[]> {
  const collected = [...first.messages]
  const oldestFetched = collected.reduce(
    (min, message) => Math.min(min, message.uid),
    Number.POSITIVE_INFINITY
  )
  if (!Number.isFinite(oldestFetched)) return collected

  let upper = oldestFetched - 1
  while (upper >= 1) {
    const lower = Math.max(1, upper - batchSize + 1)
    const page = await provider.fetchMessages(folderPath, {
      uidSet: `${lower}:${upper}`,
    })
    collected.push(...page.messages)
    upper = lower - 1
  }
  return collected
}

/**
 * Delta fetch: keep the whole {last: batch} window (older re-fetched
 * messages refresh server-wins state on upsert) and, when the window is
 * saturated with new messages, page explicit UID ranges down to
 * lastSeenUid + 1 so bursts larger than one batch are not truncated.
 */
async function collectDeltaFolder(
  provider: EmailProvider,
  folderPath: string,
  lastSeenUid: number,
  first: FetchMessagesResult,
  batchSize: number
): Promise<NormalizedMessage[]> {
  const collected = [...first.messages]
  if (first.messages.length < batchSize) return collected

  const oldestInWindow = collected.reduce(
    (min, message) => Math.min(min, message.uid),
    Number.POSITIVE_INFINITY
  )
  let upper = oldestInWindow - 1
  while (upper > lastSeenUid) {
    const lower = Math.max(lastSeenUid + 1, upper - batchSize + 1)
    const page = await provider.fetchMessages(folderPath, {
      uidSet: `${lower}:${upper}`,
    })
    for (const message of page.messages) {
      if (message.uid > lastSeenUid) collected.push(message)
    }
    upper = lower - 1
  }
  return collected
}

/**
 * UIDVALIDITY invalidation: every stored UID for the folder refers to
 * the old UID space, so drop the folder's messages and the account's
 * threads left empty by the drop. (Server-side expunges without a
 * UIDVALIDITY change are out of scope — see the module comment.)
 */
async function replaceFolderLocalState(
  executor: SqlExecutor,
  accountId: string,
  folderPath: string
): Promise<void> {
  await executor.execute(
    "DELETE FROM messages WHERE account_id = $1 AND imap_folder = $2",
    [accountId, folderPath]
  )
  await executor.execute(
    `DELETE FROM threads WHERE account_id = $1 AND NOT EXISTS (
      SELECT 1 FROM messages WHERE messages.thread_id = threads.id
    )`,
    [accountId]
  )
}

// ---------------------------------------------------------------------------
// Message persistence + thread assignment
// ---------------------------------------------------------------------------

/** Deterministic messages.id for one provider key (folder + UID). */
function imapMessageRowId(
  accountId: string,
  folderPath: string,
  uid: number
): string {
  return `im-${accountId}-${folderPath}-${uid}`
}

/**
 * Deterministic thread id from a thread key and account. Two hash seeds
 * widen the space beyond plain djb2; the key already includes the root
 * Message-ID, so the same conversation maps to one thread across syncs.
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

/** Count/booking gates for one folder pass. */
interface FolderGates {
  /**
   * False on a seed pass (first sync of the folder / UIDVALIDITY reset):
   * the pass stores and files its messages but counts none of them as
   * new — a backfill must not announce.
   */
  countNew: boolean
  /** The arrival folder carries the inbox special-use role. */
  arrivalIsInbox: boolean
}

async function storeFolderMessages(
  executor: SqlExecutor,
  accountId: string,
  folderPath: string,
  labelId: string | null,
  fetched: NormalizedMessage[],
  previousLastSeenUid: number,
  accountEmail: string,
  gates: FolderGates
): Promise<FolderOutcome> {
  if (fetched.length === 0) {
    return { newMessages: 0, threadsCreatedOrUpdated: 0 }
  }
  const ordered = [...fetched].sort((a, b) => a.uid - b.uid)
  const byRowId = new Map<string, NormalizedMessage>()
  for (const message of ordered) {
    byRowId.set(imapMessageRowId(accountId, folderPath, message.uid), message)
  }

  const threadIdByRowId = new Map<string, string>()
  const touchedThreads = new Set<string>()
  const createdThreads = new Set<string>()
  const unassigned: ThreadableMessage[] = []

  // Pass 1 — messages already stored under this provider key keep their
  // thread (the upsert below is a server-wins refresh), and brand-new
  // messages inherit a thread from persisted ancestors: first the same
  // Message-ID elsewhere (cross-folder copy), then the References /
  // In-Reply-To chain, nearest ancestor first.
  for (const message of ordered) {
    const rowId = imapMessageRowId(accountId, folderPath, message.uid)
    const existing = await findMessageByImapUid(
      executor,
      accountId,
      folderPath,
      message.uid
    )
    if (existing) {
      threadIdByRowId.set(rowId, existing.threadId)
      touchedThreads.add(existing.threadId)
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
      // messageIds[0] is the oldest member (sorted by date) — its subject
      // seeds the thread row; caches are recomputed after the upserts.
      const anchor = byRowId.get(group.messageIds[0])
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
  // Ingestion rules load once per folder pass (one criteria/actions parse
  // per rule) and are handed to the hook call below; delivery schedules
  // (task 12.1, D6) load once per pass the same way — the hook consults
  // them per event and applyDeliveryHolds writes the held threads'
  // held_until right after the hook.
  const enabledRules = await listEnabledRules(executor, accountId)
  const deliverySchedules = await listDeliverySchedules(executor, accountId)
  // Sender blocklist (task 18.2, the hook's FIFTH consumer): preloaded
  // once per folder pass like the rules and schedules; a blocked sender's
  // new message reports blockedAction and applyBlockedSenderFiling files
  // its thread right after the hook's holds.
  const blockedSenders = await listBlockedSenders(executor, accountId)
  // Local junk filter (task 18.10, D19, the hook's SIXTH consumer):
  // preloaded once per folder pass like the blocklist — IMAP account +
  // per-account toggle on, else null and the hook never classifies. The
  // gmail engine passes no config at all, which is the structural half of
  // the D19 gmail exemption (the guard inside loadJunkFilterConfig is the
  // other half).
  const junkFilter = await loadJunkFilterConfig(executor, accountId)

  // Newly inserted messages: rule-hook events (uid kept for the count's
  // delta gate) + the provisional-sent twin drop (task 8.7).
  const newEvents: { event: IngestionEvent; uid: number }[] = []
  for (const message of ordered) {
    const rowId = imapMessageRowId(accountId, folderPath, message.uid)
    const threadId = threadIdByRowId.get(rowId)
    if (threadId === undefined) {
      throw new Error(
        `imap sync: message ${rowId} was not assigned a thread (internal error)`
      )
    }
    const input = toMessageInput(accountId, folderPath, message, threadId)
    const { created } = await upsertMessageByProviderId(executor, input)
    if (created) {
      // The folder label's row name IS the folder path
      // (ensureFolderLabels), so it doubles as the label name here.
      const event = ingestionEventFromInput(input, [folderPath])
      // List signal (task 13.1, D7): the IMAP surface (Rust ImapMessage)
      // exposes no List-Id/Precedence headers, so the bracketed subject
      // prefix many lists carry stands in — a documented approximation
      // (see IngestionEvent.isMailingList).
      event.isMailingList = /^\[[^\]]+\]/.test(message.subject ?? "")
      newEvents.push({ event, uid: message.uid })
      // Task 8.7: when the server copy of a sent message first lands, drop
      // the composer's provisional Sent twin (same Message-ID header).
      await reconcileProvisionalSent(executor, accountId, input)
    }
  }
  // Thread participation (task 13.1, D7): one lookup per touched thread,
  // run AFTER the upserts so a user message from this same batch counts
  // too; stamped on that thread's new events only.
  const threadIdsWithNew = new Set(
    newEvents.map((entry) => entry.event.threadId)
  )
  for (const threadId of threadIdsWithNew) {
    const own = await executor.select<{ one: number }>(
      "SELECT 1 AS one FROM messages WHERE thread_id = $1 AND from_address = $2 COLLATE NOCASE LIMIT 1",
      [threadId, accountEmail]
    )
    if (own.length === 0) continue
    for (const entry of newEvents) {
      if (entry.event.threadId === threadId)
        entry.event.threadHasUserMessage = true
    }
  }

  for (const threadId of createdThreads) {
    await setThreadFolder(executor, threadId, labelId)
  }
  // Additive-INBOX re-entry (the gmail model): a NEW message landing in
  // the inbox-role folder re-files a reused thread that currently lives
  // elsewhere — a reply to an archived thread re-enters the inbox (and
  // setThreadFolder clears is_archived). Only inbox-role arrivals re-file
  // (a reply landing in Archive must not), and only threads that actually
  // received newly created mail — a server-wins re-fetch of an old
  // message never yanks the thread back.
  if (gates.arrivalIsInbox && labelId !== null) {
    const threadsWithNewMail = new Set(
      newEvents.map((entry) => entry.event.threadId)
    )
    for (const threadId of threadsWithNewMail) {
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

  // Ingestion hook (task 11.1/11.2, design D5): the newly created messages
  // run through the account's enabled rules in deterministic order — after
  // the folder stamping + cache recompute above, so a ruled move/archive
  // sticks, and through the thread-actions service (local effect + queue
  // op). The new-mail count is finalized only AFTER the hook, from the
  // post-rule state: a message ruled away (archive/trash/move/mark_read/
  // mark_as_spam — see SUPPRESSES_NOTIFICATION in rules/actions.ts) is not
  // counted, so
  // the count the scheduler forwards to notifyNewMail never announces
  // ruled mail. The mute gate and the notification rules (task 8.1,
  // design D16) still gate the count around the hook outcome — mute stays
  // stronger than everything, rules never ADD to the count, and "always"
  // notification rules stay inert here. Like those gates, rules touch only
  // the announcement count, never the badge total. Delivery schedules run
  // in the same hook call: matched messages report heldUntil and the hold
  // lands on the thread right after (a held message counts like a
  // ruled-away one — it never announces). Two more gates bracket the final
  // count: a seed pass (`countNew: false` — first sync of the folder or
  // its UIDVALIDITY reset) stores and files but announces nothing, and a
  // message whose thread is trashed/spammed never announces.
  const outcomes = await runIngestionRules(
    executor,
    accountId,
    newEvents.map((entry) => entry.event),
    {
      rules: enabledRules,
      schedules: deliverySchedules,
      blockedSenders,
      ...(junkFilter ? { junk: junkFilter } : {}),
    }
  )
  await applyDeliveryHolds(executor, outcomes)
  // Blocked senders (task 18.2): mark read + trash/archive the blocked
  // senders' threads per the outcomes' blockedAction (FIFTH hook
  // consumer — see rules/ingestion.ts). The count gate below already
  // excludes them via suppressesNotification.
  await applyBlockedSenderFiling(executor, accountId, outcomes)
  // Local junk filter (task 18.10): apply the auto-move the outcomes'
  // junkVerdicts computed — markSpam placement WITHOUT training (D19) —
  // right after the blocked filing; the count gate below already excludes
  // junked mail via suppressesNotification.
  await applyJunkFiling(executor, accountId, outcomes)
  // Sender stats (task 13.1, D7): the hook flow's third consumer — every
  // new message's sender accumulates its row; classification itself is
  // lazy, at view time (priority/classify.ts). Stats never touch the
  // outcomes or the notification count.
  await recordSenderStats(
    executor,
    accountId,
    accountEmail,
    newEvents.map((entry) => entry.event)
  )
  const outcomeByRowId = new Map(
    outcomes.map((outcome) => [outcome.messageRowId, outcome])
  )
  // Placement gate (same predicate style as the other count gates): a
  // message whose THREAD is trashed or spammed never announces — read
  // from the caches recomputed above, memoized per thread.
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
  for (const { event, uid } of newEvents) {
    if (
      gates.countNew &&
      uid > previousLastSeenUid &&
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

function toMessageInput(
  accountId: string,
  folderPath: string,
  message: NormalizedMessage,
  threadId: string
): MessageInput {
  const rowId = imapMessageRowId(accountId, folderPath, message.uid)
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
    imapUid: message.uid,
    imapFolder: message.folder ?? folderPath,
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
    isRead: message.flags.includes("\\Seen"),
    isFlagged: message.flags.includes("\\Flagged"),
    hasAttachments: message.attachments.length > 0,
    attachments,
    headers: buildStoredHeaders(message),
  }
}

/**
 * The stored `headers` JSON (task 18.3, design D13): the list-unsubscribe
 * header pair, captured verbatim from the normalized message and keyed by
 * lowercase header name — the only headers this surface stores (the mail
 * view parses them per displayed message; security/unsubscribe.ts owns the
 * grammar). Undefined when the message carries neither header, so the
 * column stays NULL instead of "{}".
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

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The EmailProvider surface has no standalone status/SELECT command, so
 * an empty folder is observed only through the Rust fetch refusing
 * `last` ("no messages to fetch: …"). That specific failure is a clean
 * skip, not a sync error.
 */
function isNoMessagesError(error: unknown): boolean {
  return errorMessage(error).includes(NO_MESSAGES_MARKER)
}
