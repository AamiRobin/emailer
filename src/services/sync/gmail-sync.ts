import type { SqlExecutor } from "../db/executor"
import {
  categorizationInputFromEvent,
  categorizeIncomingMessages,
} from "../categorization/ingestion"
import { syncGmailAliases } from "../aliases/sync"
import { reconcileProvisionalSent } from "../composer/send"
import { getAccount, toEmailAccount, updateSyncState } from "../db/accounts"
import {
  findLabelByGmailId,
  getLabel,
  insertLabel,
  updateLabel,
} from "../db/labels"
import type { AttachmentInput, ContactRef, MessageInput } from "../db/messages"
import { upsertMessageByProviderId } from "../db/messages"
import {
  listNotificationRules,
  resolveNotificationDecision,
} from "../db/notification-rules"
import type { ThreadInput } from "../db/threads"
import {
  isThreadMuted,
  recomputeThreadCaches,
  setThreadLabels,
  upsertThreadByGmailId,
} from "../db/threads"
import { systemLabelForSpecialUse } from "../email/folder-mapper"
import { createGmailClient } from "../email/gmail-api"
import type { GmailSendAs } from "../email/gmail-api"
import { decryptCredentials } from "../crypto/credentials"
import type { GmailTokenEnvelope } from "../email/token-manager"
import { createTokenSource } from "../email/token-manager"
import type {
  EmailAddress,
  EmailProvider,
  NormalizedMessage,
} from "../email/types"
import { gmailLabelColorImporter } from "../labels/gmail-label-colors"
import { listEnabledRules } from "../rules/db"
import {
  applyBlockedSenderFiling,
  applyDeliveryHolds,
  ingestionEventFromInput,
  recordSenderStats,
  runIngestionRules,
  type IngestionEvent,
} from "../rules/ingestion"
import { listBlockedSenders } from "../db/blocked-senders"
import { listDeliverySchedules } from "../settings/delivery-schedules"
import { recordSubscriptionActivity } from "../security/subscription-detection"

/**
 * Gmail sync engine (task 4.4). Persists provider results into SQLite:
 * labels (from listFolders), threads (server thread ids), messages
 * (bodies + flags), and the delta-sync cursor (accounts.gmail_history_id).
 *
 * Full vs delta:
 * - First sync (no stored history id) or a `needsFullSync` delta (stale /
 *   pruned history): enumerate messages through fetchMessages, upsert
 *   everything, then capture the current history id via deltaSync(null)
 *   as the cursor for the next delta pass.
 * - Otherwise: delta — provider.deltaSync(cursor) returns added messages,
 *   which are upserted (deduplicated by gmail_message_id); the cursor
 *   advances to result.nextCursor and last_sync_at is refreshed.
 *
 * Known interface gap (DeltaSyncResult, types.ts): the delta result has
 * no channel for deletions or label-only changes — the provider computes
 * them (mapHistoryDelta) but the interface drops them. Deferred here:
 * - Deletions: messages removed server-side stay locally until a full
 *   sync happens to re-enumerate their scope. A destructive reconcile is
 *   also unsafe on the full path today, because the only enumeration the
 *   EmailProvider surface offers gmail is the {last: n} recent window
 *   (see collectFullSync) — older local rows are legitimately absent from
 *   that window and must not be deleted as "vanished".
 * - Flag/label drift on existing messages: read/star state goes stale
 *   until the message is re-fetched. A periodic fetchFlags-based
 *   reconciliation sweep (re-read a recent window flags-only and upsert
 *   is_read/is_flagged + thread_labels) is the task 4.7 pattern and will
 *   close both gaps.
 *
 * Label model: listFolders returns system labels (INBOX/SENT/DRAFT/SPAM/
 * TRASH via special-use) and user labels mapped to "folder-<name>" ids.
 * Labels rows use the account-namespaced identity of the imap engine
 * (`<accountId>:<label identity>`) so both providers share one scheme.
 * thread_labels membership comes from message labelIds resolved through
 * those rows; state labels without a labels row (UNREAD, STARRED,
 * IMPORTANT, CATEGORY_*) are read/star signals only and never joined.
 * Limitation: EmailFolder does not carry the raw gmail label id of user
 * labels ("Label_…"), so membership resolution matches system ids and
 * user label names; raw id-only references resolve once the label task
 * (10.x) exposes raw labels.
 */

/**
 * Full-sync enumeration window. The EmailProvider interface has no gmail
 * pagination seam: FetchQuery offers {last} (one recent window — the
 * provider's listMessages is a single page) or {uidSet} (unusable for
 * enumeration because gmail ids are int64 decimals beyond numeric
 * precision, and uidSet ranges expand to concrete ids). Full syncs
 * therefore cover the most recent `batchSize` messages; deeper history
 * needs a provider seam (listMessages pageToken) and is out of scope.
 */
const DEFAULT_BATCH_SIZE = 500

/** fetchMessages ignores the folder arg for gmail (placement is labels). */
const FULL_SYNC_SCOPE = ""

export interface GmailSyncProgress {
  phase: "labels" | "messages" | "done"
  mode: "full" | "delta"
  messagesDone: number
  messagesTotal: number
  newMessages: number
}

export interface GmailSyncOptions {
  executor: SqlExecutor
  provider: EmailProvider
  accountId: string
  onProgress?: (progress: GmailSyncProgress) => void
  /**
   * Full-sync enumeration window size (default 500 — see DEFAULT_BATCH_SIZE).
   * Exposed mainly for tests.
   */
  batchSize?: number
  /**
   * Gmail server-side label color import (task 10.4): raw label name →
   * background color hex (or null when the label carries no color).
   * Defaults to the production importer (gmail-label-colors.ts); tests
   * inject fakes. Best effort — a failure skips the color pass for this
   * sync and leaves the locally chosen colors in place.
   */
  listLabelColors?: () => Promise<Map<string, string | null>>
  /**
   * SendAs source for the alias reconcile (task 16.2, design D10): rides
   * every sync so the From picker's aliases track Gmail's settings/sendAs.
   * Defaults to the production reader (the settings/sendAs endpoint built
   * from the account's stored OAuth envelope, see gmailSendAsSource);
   * tests inject fakes or rely on the default failing fast on
   * credential-less fixture accounts. Best effort — a failure is warned
   * about and never affects the sync result.
   */
  listSendAs?: () => Promise<GmailSendAs[]>
}

export interface GmailSyncSummary {
  mode: "full" | "delta"
  /** Labels rows ensured this run (system + user). */
  labelsSynced: number
  /** Messages newly inserted (re-fetched ones upsert, not counted). */
  newMessages: number
  /** Distinct threads created or touched by this run. */
  threadsCreatedOrUpdated: number
}

/** Unix epoch seconds. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Sync one Gmail account. Credential failures (ProviderAuthError)
 * propagate so the scheduler can surface the typed auth-error marker for
 * task 5.6; everything else throws to the caller as-is. After the message
 * sync (either mode) the alias reconcile rides along best-effort (task
 * 16.2) — a failed alias pass never fails the sync itself.
 */
export async function syncGmailAccount(
  options: GmailSyncOptions
): Promise<GmailSyncSummary> {
  const { executor, provider, accountId } = options
  if (provider.type !== "gmail") {
    throw new Error(
      `syncGmailAccount requires a gmail provider, got "${provider.type}"`
    )
  }
  const account = await getAccount(executor, accountId)
  if (!account) {
    throw new Error(`gmail sync: account ${accountId} not found`)
  }

  const cursor = account.gmail_history_id
  let summary: GmailSyncSummary
  if (!cursor) {
    summary = await runFullSync(options, null)
  } else {
    const delta = await provider.deltaSync(cursor)
    if (delta.needsFullSync) {
      // History expired/pruned server-side; the provider already captured
      // the fresh profile history id — no second deltaSync(null) needed.
      // The pass re-enumerates the account's recent window (a backfill),
      // so it must not announce its newly stored mail: cap the count to 0.
      summary = await runFullSync(options, delta.nextCursor, {
        countNew: false,
      })
    } else {
      summary = await applyDelta(options, delta.messages, delta.nextCursor)
    }
  }

  // Task 16.2, design D10: alias reconcile rides the normal sync cadence
  // (connect's first sync is a full one, so aliases are there right after
  // connect too). Best effort by contract — see below.
  await reconcileAliasesBestEffort(options)
  return summary
}

// ---------------------------------------------------------------------------
// Alias reconcile tail (task 16.2, design D10)
// ---------------------------------------------------------------------------

/**
 * Production SendAs source: the settings/sendAs reader built like the
 * label-color importer's transport — decrypt the account's token envelope,
 * token-manager silent refresh, gmail-api REST client. Fails fast (before
 * any network) when the account has no usable stored envelope, so sync
 * tests over bare fixture accounts skip the alias pass untouched.
 */
async function gmailSendAsSource(
  executor: SqlExecutor,
  accountId: string
): Promise<GmailSendAs[]> {
  const row = await getAccount(executor, accountId)
  if (!row) {
    throw new Error(`gmail aliases: account ${accountId} not found`)
  }
  const account = toEmailAccount(row)
  let envelope: GmailTokenEnvelope | null
  try {
    envelope = await decryptCredentials<GmailTokenEnvelope>(
      account.credentialsJson ?? null
    )
  } catch (error) {
    throw new Error(
      "gmail aliases: stored credentials could not be decrypted",
      {
        cause: error,
      }
    )
  }
  if (!envelope?.refreshToken) {
    throw new Error("gmail aliases: account has no stored token envelope")
  }
  const tokenSource = createTokenSource(
    { id: account.id, oauthClientId: account.oauthClientId },
    envelope
  )
  const client = createGmailClient({
    accountId: account.id,
    getToken: (force) => tokenSource.getToken(force),
  })
  return client.listSendAs()
}

/**
 * One alias reconcile pass, best effort: runs after the message sync on
 * EVERY sync (full and delta). Uses the injected SendAs source when the
 * option carries one (tests), else the production settings/sendAs reader.
 * A failure — offline token refresh, missing client id, decrypt error,
 * endpoint error — is warned about and never affects the sync result,
 * exactly like the label-color import.
 */
async function reconcileAliasesBestEffort(
  options: GmailSyncOptions
): Promise<void> {
  const { executor, accountId, listSendAs } = options
  try {
    const source = listSendAs ?? (() => gmailSendAsSource(executor, accountId))
    await syncGmailAliases(executor, accountId, { listSendAs: source })
  } catch (error) {
    console.warn("[gmail-sync] alias sync failed; skipping this pass", error)
  }
}

// ---------------------------------------------------------------------------
// Full sync
// ---------------------------------------------------------------------------

async function runFullSync(
  options: GmailSyncOptions,
  /** Fresh cursor already in hand (needsFullSync path); null = capture. */
  cursorOverride: string | null,
  /** Count controls: a history-expiry re-enumeration is a backfill pass
   * and announces nothing (`countNew: false`). A plain first sync keeps
   * counting so a fresh connect still surfaces its recent window. */
  counts?: { countNew?: boolean }
): Promise<GmailSyncSummary> {
  const { executor, provider, accountId } = options
  const onProgress = options.onProgress ?? ((): void => {})
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const countNew = counts?.countNew ?? true

  const labels = await ensureLabelsWithColors(options)
  onProgress({
    phase: "labels",
    mode: "full",
    messagesDone: 0,
    messagesTotal: 0,
    newMessages: 0,
  })

  // Auth/connectivity check plus cursor capture happen BEFORE enumeration:
  // messages arriving during enumeration have a newer history id and are
  // picked up by the next delta pass.
  const cursor =
    cursorOverride && cursorOverride !== ""
      ? cursorOverride
      : (await provider.deltaSync(null)).nextCursor

  const fetched = await collectFullSync(provider, batchSize)
  const stored = await storeMessages(
    executor,
    accountId,
    fetched,
    labels.rowIdByKey,
    { onProgress, mode: "full", countNew }
  )

  const now = nowSeconds()
  const patch = {
    lastSyncAt: now,
    lastFullSyncAt: now,
    labelsSyncedAt: now,
  }
  await updateSyncState(executor, accountId, {
    ...patch,
    // An empty cursor would force a full sync on every run anyway (falsy
    // check above); keep the previous one rather than storing "".
    ...(cursor ? { gmailHistoryId: cursor } : {}),
  })

  onProgress({
    phase: "done",
    mode: "full",
    messagesDone: fetched.length,
    messagesTotal: fetched.length,
    newMessages: stored.newMessages,
  })
  return {
    mode: "full",
    labelsSynced: labels.count,
    newMessages: stored.newMessages,
    threadsCreatedOrUpdated: stored.threadIds.size,
  }
}

async function collectFullSync(
  provider: EmailProvider,
  batchSize: number
): Promise<NormalizedMessage[]> {
  // Single bounded recent window — see the module comment and the
  // DEFAULT_BATCH_SIZE note for why deeper paging is not possible through
  // the current EmailProvider surface.
  const page = await provider.fetchMessages(FULL_SYNC_SCOPE, {
    last: batchSize,
  })
  return page.messages
}

// ---------------------------------------------------------------------------
// Delta sync
// ---------------------------------------------------------------------------

async function applyDelta(
  options: GmailSyncOptions,
  messages: NormalizedMessage[],
  nextCursor: string
): Promise<GmailSyncSummary> {
  const { executor, accountId } = options
  const onProgress = options.onProgress ?? ((): void => {})

  // Labels are refreshed on every pass (one listFolders call) so new user
  // labels become resolvable for thread_labels membership right away.
  const labels = await ensureLabelsWithColors(options)
  onProgress({
    phase: "labels",
    mode: "delta",
    messagesDone: 0,
    messagesTotal: messages.length,
    newMessages: 0,
  })

  const stored = await storeMessages(
    executor,
    accountId,
    messages,
    labels.rowIdByKey,
    { onProgress, mode: "delta", countNew: true }
  )

  await updateSyncState(executor, accountId, {
    lastSyncAt: nowSeconds(),
    labelsSyncedAt: nowSeconds(),
    ...(nextCursor ? { gmailHistoryId: nextCursor } : {}),
  })

  onProgress({
    phase: "done",
    mode: "delta",
    messagesDone: messages.length,
    messagesTotal: messages.length,
    newMessages: stored.newMessages,
  })
  return {
    mode: "delta",
    labelsSynced: labels.count,
    newMessages: stored.newMessages,
    threadsCreatedOrUpdated: stored.threadIds.size,
  }
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/**
 * Resolve the raw server color map (production importer by default, test
 * seam when injected) and ensure the labels rows — the color import is
 * best effort: a failure keeps this pass color-neutral.
 */
async function ensureLabelsWithColors(
  options: GmailSyncOptions
): Promise<EnsuredLabels> {
  const { executor, provider, accountId } = options
  const listLabelColors =
    options.listLabelColors ??
    (provider.type === "gmail"
      ? gmailLabelColorImporter(executor, accountId)
      : undefined)
  let labelColors: Map<string, string | null> | undefined
  if (listLabelColors) {
    try {
      labelColors = await listLabelColors()
    } catch (error) {
      console.warn(
        "[gmail-sync] label color import failed; keeping local colors",
        error
      )
    }
  }
  return ensureGmailLabels(executor, accountId, provider, labelColors)
}

/**
 * Idempotently ensure a labels row per folder (gmail: folders ARE labels)
 * and return the membership resolution map — gmail label id / label name
 * → labels.id. System labels carry their special-use role; user labels
 * resolve by name (see the module comment on raw "Label_…" ids).
 *
 * `labelColors` (task 10.4) carries the raw server background colors by
 * label name; when a labeled row's color differs it is persisted onto
 * labels.color. Absent/null server colors leave the local value alone —
 * the locally chosen color applies (see gmail-label-colors.ts).
 */
export interface EnsuredLabels {
  /** Membership resolution: gmail label id / label name → labels.id. */
  rowIdByKey: Map<string, string>
  /** Labels rows ensured this run (one per listed folder). */
  count: number
}

/**
 * Idempotently ensure a labels row per folder (gmail: folders ARE labels)
 * and return the membership resolution map — gmail label id / label name
 * → labels.id. System labels carry their special-use role; user labels
 * resolve by name (see the module comment on raw "Label_…" ids).
 */
export async function ensureGmailLabels(
  executor: SqlExecutor,
  accountId: string,
  provider: EmailProvider,
  labelColors?: Map<string, string | null>
): Promise<EnsuredLabels> {
  const folders = await provider.listFolders()
  const rowIdByKey = new Map<string, string>()

  for (const folder of folders) {
    const system = folder.specialUse
      ? systemLabelForSpecialUse(folder.specialUse)
      : null
    // Same namespacing scheme as the imap engine's folder labels.
    const rowId = `${accountId}:${system?.id ?? folder.id}`
    const name = folder.path // gmail label name, including "/" hierarchy

    const existing =
      (await getLabel(executor, rowId)) ??
      (await findLabelByGmailId(executor, accountId, name))
    if (!existing) {
      await insertLabel(executor, {
        id: rowId,
        accountId,
        name,
        gmailLabelId: name,
        specialUse: folder.specialUse ?? undefined,
        type: system ? "system" : "user",
      })
      rowIdByKey.set(name, rowId)
    } else {
      // Existing row (possibly from the label task under another id):
      // keep its row id for membership and refresh the mutable name.
      if (existing.name !== name) {
        await updateLabel(executor, existing.id, { name })
      }
      rowIdByKey.set(name, existing.id)
    }
    // When a raw gmail id ever differs from the name (future label task),
    // both keys resolve to the same row.
    const resolvedId = existing?.id ?? rowId
    if (folder.id !== name) rowIdByKey.set(folder.id, resolvedId)
  }

  // Server-side color import (task 10.4): persist the background hex onto
  // the row. A null/absent server color never overwrites a local choice.
  for (const [name, color] of labelColors ?? []) {
    if (!color) continue
    const rowId = rowIdByKey.get(name)
    if (!rowId) continue
    const row = await getLabel(executor, rowId)
    if (row && row.color !== color) {
      await updateLabel(executor, rowId, { color })
    }
  }

  return { rowIdByKey, count: folders.length }
}

// ---------------------------------------------------------------------------
// Message persistence + thread assignment
// ---------------------------------------------------------------------------

/** Deterministic messages.id for one gmail provider key. */
function gmailMessageRowId(accountId: string, gmailId: string): string {
  return `gm-${accountId}-${gmailId}`
}

/** Deterministic threads.id for a server thread id (or synthetic solo key). */
function gmailThreadRowId(accountId: string, threadKey: string): string {
  return `gt-${accountId}-${threadKey}`
}

interface StoreOutcome {
  newMessages: number
  threadIds: Set<string>
}

interface StoreContext {
  onProgress: (progress: GmailSyncProgress) => void
  mode: "full" | "delta"
  /**
   * Whether this pass may announce its newly stored mail as new
   * (false for a history-expiry re-enumeration — a backfill pass stores
   * but never notifies).
   */
  countNew: boolean
}

/**
 * Upsert messages (server-wins via upsertMessageByProviderId, keyed by
 * the account's gmail_message_id unique index), group them into threads
 * by the server thread id, refresh thread_labels membership from message
 * labelIds, and recompute the thread caches (message/unread counts,
 * snippet, dates).
 *
 * Ingestion hook (task 11.1/11.2, design D5): after a thread group is
 * stored and its caches refreshed, its newly created messages run through
 * runIngestionRules — the account's enabled rules in deterministic order,
 * acting through the thread-actions service (local effect + queue op). The
 * new-mail count is finalized only AFTER the hook returns, from the
 * post-rule state: a message ruled away (archive/trash/mark_read —
 * see SUPPRESSES_NOTIFICATION in rules/actions.ts) is not counted, so the
 * count the scheduler forwards to notifyNewMail never announces ruled
 * mail. The mute gate and the notification rules (task 8.1, design D16)
 * still gate the count around the hook outcome — mute stays stronger than
 * everything, rules never ADD to the count, and "always" notification
 * rules stay inert here. Like those gates, rules touch only the
 * announcement count, never the badge total. Two more gates bracket the
 * count: messages whose thread is trashed/spammed never announce, and a
 * history-expiry re-enumeration (`countNew: false`) stores its backfill
 * silently — a resync or backfill must not read as fresh mail.
 */
async function storeMessages(
  executor: SqlExecutor,
  accountId: string,
  fetched: NormalizedMessage[],
  labelIdByGmailKey: Map<string, string>,
  context: StoreContext
): Promise<StoreOutcome> {
  // Notification rules and the label-name map load once per pass: the
  // evaluation per message (resolveNotificationDecision) is pure. Message
  // labelIds are raw gmail label keys; they resolve to labels rows through
  // labelIdByGmailKey and to names through the account's label rows.
  const rules = await listNotificationRules(executor, accountId)
  // Ingestion rules load once per pass and are handed to every per-group
  // hook call below (one criteria/actions parse per rule for the pass).
  const enabledRules = await listEnabledRules(executor, accountId)
  // Delivery schedules (task 12.1, D6) load once per pass the same way;
  // the hook consults them per event and applyDeliveryHolds writes the
  // held threads.held_until after each group's hook call.
  const deliverySchedules = await listDeliverySchedules(executor, accountId)
  // Sender blocklist (task 18.2, the hook's FIFTH consumer): preloaded
  // once per pass like the rules and schedules; a blocked sender's new
  // message reports blockedAction and applyBlockedSenderFiling files its
  // thread (mark read + trash/archive) right after each group's holds.
  const blockedSenders = await listBlockedSenders(executor, accountId)
  // The account's own address anchors the sender-stats flags (task 13.1,
  // D7): direct-to-me and thread-participation matching. Aliases (task 16)
  // will widen this to the alias set.
  const account = await getAccount(executor, accountId)
  if (!account) {
    throw new Error(`gmail sync: account ${accountId} not found`)
  }
  const accountEmail = account.email
  const labelRows = await executor.select<{ id: string; name: string }>(
    "SELECT id, name FROM labels WHERE account_id = $1",
    [accountId]
  )
  const nameByRowId = new Map(labelRows.map((row) => [row.id, row.name]))
  const nameByLabelKey = new Map<string, string>()
  for (const [key, rowId] of labelIdByGmailKey) {
    const name = nameByRowId.get(rowId)
    if (name !== undefined) nameByLabelKey.set(key, name)
  }

  // Oldest first so a thread's subject anchors on its first message.
  const ordered = [...fetched].sort((a, b) => a.date - b.date || a.uid - b.uid)

  const byThreadKey = new Map<string, NormalizedMessage[]>()
  for (const message of ordered) {
    const key = message.gmailThreadId ?? `solo-${providerKey(message)}`
    const group = byThreadKey.get(key)
    if (group) group.push(message)
    else byThreadKey.set(key, [message])
  }

  let newMessages = 0
  const threadIds = new Set<string>()
  let done = 0

  for (const [threadKey, group] of byThreadKey) {
    const threadRowId = gmailThreadRowId(accountId, threadKey)
    const anchor = group[0]
    const input: ThreadInput & { gmailThreadId: string } = {
      id: threadRowId,
      accountId,
      subject: anchor?.subject,
      gmailThreadId: threadKey,
    }
    await upsertThreadByGmailId(executor, input)
    // After the upsert the thread row exists (a brand-new one is never
    // muted), so one check covers the whole group.
    const muted = await isThreadMuted(executor, threadRowId)

    const newEvents: IngestionEvent[] = []
    for (const message of group) {
      const input = toMessageInput(accountId, message, threadRowId)
      const { created } = await upsertMessageByProviderId(executor, input)
      if (created) {
        const event = ingestionEventFromInput(
          input,
          labelNamesFor(message, nameByLabelKey)
        )
        // Bulk-tab signal (task 13.1, D7): no List-Id/Precedence reaches
        // this surface, so the raw gmail tab labels stand in — any
        // CATEGORY_* except PERSONAL marks bulk/list mail (see
        // IngestionEvent.isMailingList).
        event.isMailingList = (message.labelIds ?? []).some(
          (key) => key.startsWith("CATEGORY_") && key !== "CATEGORY_PERSONAL"
        )
        newEvents.push(event)
        // Task 8.7: when the server copy of a sent message first lands, drop
        // the composer's provisional Sent twin (same Message-ID header).
        await reconcileProvisionalSent(executor, accountId, input)
      }
    }
    // Thread participation (task 13.1, D7): one lookup per group, run
    // AFTER the group's upserts so a user message that arrived in this
    // same batch counts as participation too. Stamped on every new event
    // of the thread — the conversation is participated in or not.
    if (newEvents.length > 0) {
      const own = await executor.select<{ one: number }>(
        "SELECT 1 AS one FROM messages WHERE thread_id = $1 AND from_address = $2 COLLATE NOCASE LIMIT 1",
        [threadRowId, accountEmail]
      )
      if (own.length > 0) {
        for (const event of newEvents) event.threadHasUserMessage = true
      }
    }

    await setThreadLabels(
      executor,
      threadRowId,
      await resolveThreadLabels(executor, threadRowId, group, labelIdByGmailKey)
    )
    await recomputeThreadCaches(executor, threadRowId)

    // Ingestion hook — rules run after the group's membership + caches are
    // written (a later membership write would resurrect pre-rule labels,
    // so a ruled archive/trash must come last) and before the count is
    // finalized, so ruled-away mail never notifies. Delivery schedules run
    // in the same hook call: matched messages report heldUntil and the
    // hold lands on the thread right after (a held message counts like a
    // ruled-away one — it never announces).
    const outcomes = await runIngestionRules(executor, accountId, newEvents, {
      rules: enabledRules,
      schedules: deliverySchedules,
      blockedSenders,
    })
    await applyDeliveryHolds(executor, outcomes)
    // Blocked senders (task 18.2): mark read + trash/archive the blocked
    // senders' threads per the outcomes' blockedAction (FIFTH hook
    // consumer — see rules/ingestion.ts). The count gate below already
    // excludes them via suppressesNotification.
    await applyBlockedSenderFiling(executor, accountId, outcomes)
    // Sender stats (task 13.1, D7): the hook flow's third consumer — every
    // new message's sender accumulates its row; classification itself is
    // lazy, at view time (priority/classify.ts). Stats never touch the
    // outcomes or the notification count.
    await recordSenderStats(executor, accountId, accountEmail, newEvents)
    // Automatic categorization (task 3.3, design D4, the hook flow's
    // SEVENTH consumer): user-rule category → list-header heuristics →
    // sender override read → default Primary, written to threads.category
    // keep-first. MUST run before the new-mail count below is finalized —
    // that count is what the scheduler forwards to notifyNewMail, so the
    // categories exist before any notification fires. Never touches the
    // outcomes or the count.
    await categorizeIncomingMessages(
      executor,
      newEvents.map((event) => categorizationInputFromEvent(event))
    )
    // Subscription detection (task 3.6, design D13, the hook flow's EIGHTH
    // consumer): mail carrying List-Unsubscribe headers marks its sender as
    // a detected newsletter — the manager's entry is created/refreshed and
    // an unsubscribed sender's new mail flips it to "resumed" (the spec's
    // sender-resumed scenario). Same seam as categorization: after the
    // group's persistence + filing above, before the new-mail count below
    // is finalized; it writes only the subscriptions settings row, never
    // the outcomes or the count.
    await recordSubscriptionActivity(executor, accountId, newEvents)
    const ruledAway = new Set(
      outcomes
        .filter((outcome) => outcome.suppressesNotification)
        .map((outcome) => outcome.messageRowId)
    )
    // Placement gate (same predicate style as the other count gates): a
    // message whose THREAD landed in trash or spam never announces —
    // read from the caches this group just recomputed.
    const threadState = await executor.select<{
      is_trashed: number
      is_spam: number
    }>("SELECT is_trashed, is_spam FROM threads WHERE id = $1", [threadRowId])
    const filed =
      threadState[0] !== undefined &&
      (threadState[0].is_trashed === 1 || threadState[0].is_spam === 1)
    for (const event of newEvents) {
      if (
        context.countNew &&
        !muted &&
        !filed &&
        !ruledAway.has(event.messageRowId) &&
        resolveNotificationDecision(
          rules,
          event.fromAddress,
          event.labelNames
        ) === "notify"
      ) {
        newMessages += 1
      }
    }

    threadIds.add(threadRowId)
    done += group.length
    context.onProgress({
      phase: "messages",
      mode: context.mode,
      messagesDone: done,
      messagesTotal: ordered.length,
      newMessages,
    })
  }

  return { newMessages, threadIds }
}

function providerKey(message: NormalizedMessage): string {
  return message.gmailId ?? String(message.uid)
}

/**
 * The message's label NAMES for rule/notification matching (task 8.1
 * notification rules, task 11 rule criteria): raw label keys resolved
 * through the pass's key → row map and the row → name map. Keys without a
 * labels row (state labels like UNREAD/CATEGORY_*) are skipped — they are
 * not matchable labels.
 */
function labelNamesFor(
  message: NormalizedMessage,
  nameByLabelKey: Map<string, string>
): string[] {
  const names = new Set<string>()
  for (const key of message.labelIds ?? []) {
    const name = nameByLabelKey.get(key)
    if (name !== undefined) names.add(name)
  }
  return [...names]
}

/**
 * thread_labels membership for one thread: the union of the labels
 * already stored (earlier passes may have seen other members of the
 * thread) with the rows resolved from THIS pass's message labelIds.
 * Membership is deliberately additive — a delta pass only sees part of a
 * thread, so replacing would wipe full-sync knowledge, and label
 * REMOVALS on the server are deferred to the same 4.7 flag/label
 * reconciliation as read/star drift.
 */
async function resolveThreadLabels(
  executor: SqlExecutor,
  threadRowId: string,
  group: NormalizedMessage[],
  labelIdByGmailKey: Map<string, string>
): Promise<string[]> {
  const merged = new Set<string>()
  const existing = await executor.select<{ label_id: string }>(
    "SELECT label_id FROM thread_labels WHERE thread_id = $1",
    [threadRowId]
  )
  for (const row of existing) merged.add(row.label_id)
  for (const message of group) {
    for (const labelId of message.labelIds ?? []) {
      const rowId = labelIdByGmailKey.get(labelId)
      if (rowId) merged.add(rowId)
    }
  }
  return [...merged]
}

function toMessageInput(
  accountId: string,
  message: NormalizedMessage,
  threadId: string
): MessageInput {
  const gmailId = providerKey(message)
  const rowId = gmailMessageRowId(accountId, gmailId)
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
    gmailMessageId: gmailId,
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
    // Task 2.1 (design D10): compact SPF/DKIM/DMARC verdicts parsed at
    // ingestion (TS-side for Gmail, see email/auth-results.ts), stored
    // for the auth badge.
    authResults: message.authResults,
    // flagsForLabelIds: read is the ABSENCE of the UNREAD label.
    isRead: message.flags.includes("\\Seen"),
    isFlagged: message.flags.includes("\\Flagged"),
    hasAttachments: message.attachments.length > 0,
    attachments,
    headers: buildStoredHeaders(message),
  }
}

/**
 * The stored `headers` JSON (task 18.3, design D13): the list-unsubscribe
 * header pair captured by mapGmailMessage (the only headers this surface
 * stores — the mail view parses them per displayed message;
 * security/unsubscribe.ts owns the grammar). Undefined when the message
 * carries neither header, so the column stays NULL instead of "{}".
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
