import type { SqlExecutor } from "../db/executor"
import { getAccount } from "../db/accounts"
import type { LabelRow } from "../db/labels"
import { findLabelsBySpecialUse } from "../db/labels"
import type { MessageRow } from "../db/messages"
import {
  markMessagesFlagged,
  markMessagesRead,
  updateMessage,
} from "../db/messages"
import type { ThreadRow } from "../db/threads"
import {
  getThreadWithMessages,
  recomputeThreadCaches,
  setThreadFolder,
  setThreadLabels,
  // aliased: the public setThreadStarred below is the action wrapper
  setThreadStarred as setThreadStarredCache,
} from "../db/threads"
import type { MessageRef } from "../email/types"
import {
  enqueueAddLabels,
  enqueueArchive,
  enqueueDeleteForever,
  enqueueMarkRead,
  enqueueMarkUnread,
  enqueueMove,
  enqueueNotSpam,
  enqueueRemoveLabels,
  enqueueStar,
  enqueueTrash,
  enqueueUnstar,
} from "../queue/operation"
import { useAccountStore } from "../../stores/account-store"
import { useFolderCountsStore } from "../../stores/folder-counts-store"
import { buildMessageRefs } from "./message-refs"

/**
 * Centralized thread actions (task 10.1, design D10) — the single service
 * layer behind the toolbar, keyboard shortcuts and context menu (tasks
 * 10.2/10.3 and the shortcuts hook import THESE functions, never the db
 * or queue modules directly).
 *
 * Every action follows the D10 local-first ordering:
 * 1. Load the thread + its messages, resolve the account type.
 * 2. Mutate the local database FIRST (the UI reads only SQLite, so the
 *    change is visible at once, online or offline).
 * 3. THEN enqueue the server mutation into pending_operations; the queue
 *    processor replays it when connectivity allows. No provider is ever
 *    constructed or called on this path.
 * 4. Fire onThreadListChanged and refresh the cached unread indicators
 *    (account switcher badges + sidebar folder badges).
 *
 * Per-provider local model (mirrors migrations.ts comments):
 * - gmail: placement IS thread_labels membership. archive = remove the
 *   inbox-role label rows; trash/spam = add the trash/spam-role label
 *   rows; not-spam = remove spam + add inbox. setThreadLabels rebuilds
 *   the is_archived/is_trashed/is_spam caches from the roles.
 * - imap: placement IS messages.imap_folder. archive/trash/spam/not-spam
 *   move the messages to the special-use folder's path and point
 *   threads.folder_label_id at its label row (setThreadFolder rebuilds
 *   the caches). If the account has no archive/trash-role folder the
 *   local move is skipped and the queued op still applies server-side
 *   (the provider resolves the folder by role at replay); for spam/
 *   not-spam there is no provider method, so the destination path must
 *   exist locally or the action throws MissingSpecialFolderError.
 *
 * Read/star mutate messages.is_read/is_flagged plus the thread caches
 * (unread_count via recompute, is_starred directly) for both provider
 * models — flags are not folder-shaped.
 *
 * Actions are idempotent-ish by construction: double-archive removes an
 * already-absent label, moving an already-moved message rewrites the same
 * value, and a repeated flag set converges — safe per D10.
 */

/** Discriminant shared by the single-thread actions and bulkApply. */
export type ThreadActionKind =
  | "archive"
  | "trash"
  | "spam"
  | "not_spam"
  | "delete_forever"
  | "read"
  | "unread"
  | "star"
  | "unstar"

/**
 * Event discriminants for thread-label membership changes (task 10.2's
 * context-menu Labels submenu + 10.3's selection-bar label dropdown).
 * Label apply/remove is NOT a ThreadActionKind: bulkApply does not accept
 * it (it carries label ids, so it has its own entry point below), but the
 * change event shares the shape so list caches refresh uniformly.
 */
export type ThreadLabelEventKind = "labels_add" | "labels_remove"

// ---- Typed errors (the UI layer maps these to toasts/disabled states) ----

/** The thread id does not exist, or belongs to a different account. */
export class ThreadNotFoundError extends Error {
  constructor(threadId: string) {
    super(`thread ${threadId} not found for this account`)
    this.name = "ThreadNotFoundError"
  }
}

/** The account id has no row (deleted mid-flight or a bad caller arg). */
export class AccountNotFoundError extends Error {
  constructor(accountId: string) {
    super(`account ${accountId} not found`)
    this.name = "AccountNotFoundError"
  }
}

/** deleteForeverThread on a thread that is not in Trash (spec: the action
 * is only offered there; the service still guards it). */
export class NotInTrashError extends Error {
  constructor(threadId: string) {
    super(`thread ${threadId} is not in Trash; delete forever refused`)
    this.name = "NotInTrashError"
  }
}

/** An imap action that must name a destination folder (spam / not-spam)
 * found no label row carrying the required special-use role. */
export class MissingSpecialFolderError extends Error {
  constructor(accountId: string, role: string) {
    super(`account ${accountId} has no ${role} folder; cannot apply the action`)
    this.name = "MissingSpecialFolderError"
  }
}

// ---- Change notification for the list/pane caches ----

export interface ThreadListChangeEvent {
  action: ThreadActionKind | ThreadLabelEventKind
  accountId: string
  /** Threads whose local placement/state changed (one per single action;
   * the full batch for bulkApply). Deleted ids are included. */
  threadIds: string[]
}

export type ThreadListChangedListener = (event: ThreadListChangeEvent) => void

const threadListListeners = new Set<ThreadListChangedListener>()

/**
 * Subscribe to local thread changes — the hook the thread-list store (and
 * anything else caching list state) subscribes to instead of this module
 * importing it (the store may not exist yet at 10.1 time). Returns the
 * unsubscribe function. Listeners run synchronously AFTER the local
 * mutation, the enqueue and the indicator refresh; a throwing listener is
 * isolated (logged) so one bad subscriber cannot break actions.
 */
export function onThreadListChanged(
  listener: ThreadListChangedListener
): () => void {
  threadListListeners.add(listener)
  return () => {
    threadListListeners.delete(listener)
  }
}

function emitThreadListChanged(event: ThreadListChangeEvent): void {
  for (const listener of threadListListeners) {
    try {
      listener(event)
    } catch (error) {
      console.error(
        "[email-actions] onThreadListChanged listener failed",
        error
      )
    }
  }
}

/**
 * Refresh the cached unread indicators after local mutations (the
 * scheduler's D5 layering: services may import the zustand stores whose
 * state is a re-read of the same SQLite rows). Best-effort — outside
 * Tauri (plain vite/tests without a DB) getExecutor() throws and the
 * badges simply stay stale; an action must never fail on cosmetics.
 */
async function refreshUnreadIndicators(): Promise<void> {
  try {
    await useAccountStore.getState().refreshUnreadCounts()
    await useFolderCountsStore.getState().refreshFolderCounts()
  } catch {
    // Cosmetic only.
  }
}

// ---- Single-thread actions (the public surface) ----

/**
 * Archive a thread: out of Inbox, kept in Archive.
 * - gmail: remove the inbox-role label rows from thread_labels.
 * - imap: move the messages to the archive-role folder's path.
 * Queues `archive` either way (gmail drops INBOX; imap moves by role).
 */
export function archiveThread(
  executor: SqlExecutor,
  accountId: string,
  threadId: string
): Promise<void> {
  return runThreadAction(executor, accountId, threadId, "archive")
}

/** Trash a thread (gmail adds TRASH / messages.trash; imap moves to the
 * trash-role folder). Reversible from Trash via not-spam's sibling flows. */
export function trashThread(
  executor: SqlExecutor,
  accountId: string,
  threadId: string
): Promise<void> {
  return runThreadAction(executor, accountId, threadId, "trash")
}

/** Mark a thread as spam (gmail adds SPAM; imap moves to the junk folder). */
export function markSpam(
  executor: SqlExecutor,
  accountId: string,
  threadId: string
): Promise<void> {
  return runThreadAction(executor, accountId, threadId, "spam")
}

/**
 * Not spam: return the thread from Spam to the Inbox (spec scenario).
 * - gmail: remove SPAM + add INBOX locally, queue `not_spam` (the
 *   processor replays it as removeLabels ["SPAM"] + addLabels ["INBOX"]).
 * - imap: move the messages back to the inbox-role folder's path and
 *   queue `move` (the processor's not_spam dispatch would translate to
 *   label no-ops on imap, so the move op carries the real semantics).
 */
export function markNotSpam(
  executor: SqlExecutor,
  accountId: string,
  threadId: string
): Promise<void> {
  return runThreadAction(executor, accountId, threadId, "not_spam")
}

/**
 * Delete forever — only from Trash (NotInTrashError otherwise; the UI
 * confirms first). Removes the messages + thread rows locally (FK
 * cascades take thread_labels and attachments; the FTS trigger unindexes
 * the bodies) and queues `delete_forever` (gmail messages.delete / imap
 * EXPUNGE) with the refs captured BEFORE the rows were removed.
 */
export function deleteForeverThread(
  executor: SqlExecutor,
  accountId: string,
  threadId: string
): Promise<void> {
  return runThreadAction(executor, accountId, threadId, "delete_forever")
}

/** Mark a whole thread read (true) or unread (false): every message row's
 * is_read plus the thread's unread_count cache; queues mark_read/unread. */
export function setThreadRead(
  executor: SqlExecutor,
  accountId: string,
  threadId: string,
  read: boolean
): Promise<void> {
  return runThreadAction(
    executor,
    accountId,
    threadId,
    read ? "read" : "unread"
  )
}

/** Star/unstar a whole thread: every message row's is_flagged plus the
 * thread's is_starred cache; queues star/unstar (gmail STARRED label). */
export function setThreadStarred(
  executor: SqlExecutor,
  accountId: string,
  threadId: string,
  starred: boolean
): Promise<void> {
  return runThreadAction(
    executor,
    accountId,
    threadId,
    starred ? "star" : "unstar"
  )
}

/**
 * Apply one action to many threads sequentially (multi-select, task
 * 10.3 calls this). Local-first still holds per thread: each thread is
 * fully (mutate → enqueue) applied before the next starts, so a failure
 * leaves the earlier threads durably applied — the loop is fail-fast and
 * rethrows after emitting the event for the threads that were applied.
 */
export async function bulkApply(
  executor: SqlExecutor,
  accountId: string,
  threadIds: string[],
  action: ThreadActionKind
): Promise<void> {
  const applied: string[] = []
  for (const threadId of threadIds) {
    await applyThreadAction(executor, accountId, threadId, action)
    applied.push(threadId)
  }
  if (applied.length > 0) {
    await finishAction({ action, accountId, threadIds: applied })
  }
}

/**
 * Add or remove user labels on a thread (task 10.2's context-menu Labels
 * submenu; the selection bar loops it per thread). The `labelIds` are the
 * app's internal label ids — the same ids thread_labels rows and the UI
 * carry. Same D10 ordering as every action:
 *
 * 1. gmail: rewrite thread_labels membership via setThreadLabels (the
 *    folder caches rebuild from the roles); imap: labels are folders, so
 *    there is no label membership to mutate and no server label surface —
 *    the call returns without effect (labels UI surfaces gmail chips only).
 * 2. Enqueue `add_labels` / `remove_labels` with the PROVIDER-facing
 *    label ids (labels.gmail_label_id) — the gmail provider passes them
 *    straight to the API.
 * 3. Emit one onThreadListChanged event (labels_add / labels_remove).
 *
 * No-op (no writes, no op, no event) when nothing changes: unknown or
 * other-account label ids, membership already in the target state, or an
 * imap account.
 */
export async function applyLabelsToThread(
  executor: SqlExecutor,
  accountId: string,
  threadId: string,
  labelIds: string[],
  add: boolean
): Promise<void> {
  if (labelIds.length === 0) return
  const context = await resolveContext(executor, accountId, threadId)
  if (context.accountType !== "gmail") return
  const placeholders = labelIds.map((_, index) => `$${index + 2}`).join(", ")
  const rows = await executor.select<LabelRow>(
    `SELECT * FROM labels WHERE account_id = $1 AND id IN (${placeholders})`,
    [accountId, ...labelIds]
  )
  if (rows.length === 0) return

  const current = await currentLabelIds(executor, threadId)
  const next = add
    ? [
        ...current,
        ...rows.map((row) => row.id).filter((id) => !current.includes(id)),
      ]
    : current.filter((id) => !rows.some((row) => row.id === id))
  if (next.length === current.length) {
    return
  }

  const action: ThreadLabelEventKind = add ? "labels_add" : "labels_remove"
  await setThreadLabels(executor, threadId, next)
  // Provider-facing ids only: rows carry gmail_label_id for gmail accounts.
  const providerIds = rows
    .map((row) => row.gmail_label_id)
    .filter((id): id is string => id !== null)
  if (providerIds.length > 0) {
    if (add) {
      await enqueueAddLabels(executor, accountId, context.refs, providerIds)
    } else {
      await enqueueRemoveLabels(executor, accountId, context.refs, providerIds)
    }
  }
  await finishAction({ action, accountId, threadIds: [threadId] })
}

// ---- Core: one action against one thread ----

/** Resolved inputs shared by every action branch. */
interface ActionContext {
  accountType: "gmail" | "imap"
  thread: ThreadRow
  messages: MessageRow[]
  refs: MessageRef[]
}

/** One thread's full D10 sequence: local mutation, then enqueue. No
 * notification — the public wrappers own that (bulkApply coalesces). */
async function runThreadAction(
  executor: SqlExecutor,
  accountId: string,
  threadId: string,
  action: ThreadActionKind
): Promise<void> {
  await applyThreadAction(executor, accountId, threadId, action)
  await finishAction({ action, accountId, threadIds: [threadId] })
}

/** Resolve the context, apply the local mutation branch, then enqueue
 * the matching provider op(s) — in that order (D10). */
async function applyThreadAction(
  executor: SqlExecutor,
  accountId: string,
  threadId: string,
  action: ThreadActionKind
): Promise<void> {
  const context = await resolveContext(executor, accountId, threadId)
  switch (action) {
    case "archive":
      await applyArchive(executor, context)
      await enqueueArchive(executor, accountId, context.refs)
      break
    case "trash":
      await applyTrash(executor, context)
      await enqueueTrash(executor, accountId, context.refs)
      break
    case "spam":
      await applySpam(executor, context)
      break
    case "not_spam":
      await applyNotSpam(executor, context)
      break
    case "delete_forever":
      await applyDeleteForever(executor, context)
      await enqueueDeleteForever(executor, accountId, context.refs)
      break
    case "read":
    case "unread":
      await applyRead(executor, context, action === "read")
      if (action === "read") {
        await enqueueMarkRead(executor, accountId, context.refs)
      } else {
        await enqueueMarkUnread(executor, accountId, context.refs)
      }
      break
    case "star":
    case "unstar":
      await applyStar(executor, context, action === "star")
      if (action === "star") {
        await enqueueStar(executor, accountId, context.refs)
      } else {
        await enqueueUnstar(executor, accountId, context.refs)
      }
      break
  }
}

/**
 * Shared tail: refresh the cached unread indicators, then notify list
 * subscribers. Called once per single action / once per bulkApply batch.
 */
async function finishAction(event: ThreadListChangeEvent): Promise<void> {
  await refreshUnreadIndicators()
  emitThreadListChanged(event)
}

/** Load + validate everything the action branches need, BEFORE mutating:
 * refs are built here too so delete_forever can enqueue after the rows
 * are gone. Throws the typed lookup errors, never mutates. */
async function resolveContext(
  executor: SqlExecutor,
  accountId: string,
  threadId: string
): Promise<ActionContext> {
  const account = await getAccount(executor, accountId)
  if (!account) throw new AccountNotFoundError(accountId)
  const loaded = await getThreadWithMessages(executor, threadId)
  if (!loaded || loaded.thread.account_id !== accountId) {
    throw new ThreadNotFoundError(threadId)
  }
  return {
    accountType: account.type,
    thread: loaded.thread,
    messages: loaded.messages,
    refs: buildMessageRefs(account.type, loaded.messages),
  }
}

// ---- Local mutation branches (queue enqueue happens in runThreadAction) ----

/** The account's first label row carrying `role`, or null. */
async function findSpecialLabel(
  executor: SqlExecutor,
  accountId: string,
  role: "inbox" | "trash" | "spam" | "archive"
): Promise<LabelRow | null> {
  const labels = await findLabelsBySpecialUse(executor, accountId, role)
  return labels[0] ?? null
}

/** imap move semantics: rewrite every message's imap_folder, repoint the
 * thread's folder cache, rebuild the archive/trash/spam flags. */
async function moveThreadToFolder(
  executor: SqlExecutor,
  threadId: string,
  messages: MessageRow[],
  destination: LabelRow
): Promise<void> {
  for (const message of messages) {
    await updateMessage(executor, message.id, {
      imapFolder: destination.imap_folder_name,
    })
  }
  await setThreadFolder(executor, threadId, destination.id)
  await recomputeThreadCaches(executor, threadId)
}

async function applyArchive(
  executor: SqlExecutor,
  context: ActionContext
): Promise<void> {
  if (context.accountType === "gmail") {
    const inbox = await findSpecialLabel(
      executor,
      context.thread.account_id,
      "inbox"
    )
    const removals = inbox ? [inbox.id] : []
    const next = await currentLabelsMinus(executor, context.thread.id, removals)
    await setThreadLabels(executor, context.thread.id, next)
    return
  }
  const archive = await findSpecialLabel(
    executor,
    context.thread.account_id,
    "archive"
  )
  // No archive-role folder locally: the queued op still moves the
  // messages server-side (the provider resolves the role); the local
  // folder catches up at the next sync.
  if (archive) {
    await moveThreadToFolder(
      executor,
      context.thread.id,
      context.messages,
      archive
    )
  }
}

/** gmail trash/spam: add the role's label row to the thread's membership
 * (setThreadLabels rebuilds the trashed/spammed caches; the absent-inbox
 * archive rule is suppressed while trash/spam is set). */
async function addSpecialLabel(
  executor: SqlExecutor,
  threadId: string,
  label: LabelRow | null
): Promise<void> {
  if (!label) return
  const current = await currentLabelIds(executor, threadId)
  if (current.includes(label.id)) return
  await setThreadLabels(executor, threadId, [...current, label.id])
}

async function applyTrash(
  executor: SqlExecutor,
  context: ActionContext
): Promise<void> {
  if (context.accountType === "gmail") {
    const trash = await findSpecialLabel(
      executor,
      context.thread.account_id,
      "trash"
    )
    await addSpecialLabel(executor, context.thread.id, trash)
    return
  }
  const trash = await findSpecialLabel(
    executor,
    context.thread.account_id,
    "trash"
  )
  // Same degradation as archive: no local trash folder → the queued op
  // still applies server-side by role.
  if (trash) {
    await moveThreadToFolder(
      executor,
      context.thread.id,
      context.messages,
      trash
    )
  }
}

/** Queue-op resolution happens here (not in runThreadAction) because spam
 * needs the destination folder: gmail queues add_labels ["SPAM"]; imap
 * queues move to the junk folder path. */
async function applySpam(
  executor: SqlExecutor,
  context: ActionContext
): Promise<void> {
  const accountId = context.thread.account_id
  if (context.accountType === "gmail") {
    const spam = await findSpecialLabel(executor, accountId, "spam")
    await addSpecialLabel(executor, context.thread.id, spam)
    await enqueueAddLabels(executor, accountId, context.refs, ["SPAM"])
    return
  }
  const spam = await findSpecialLabel(executor, accountId, "spam")
  if (!spam || spam.imap_folder_name === null) {
    throw new MissingSpecialFolderError(accountId, "spam")
  }
  await moveThreadToFolder(executor, context.thread.id, context.messages, spam)
  await enqueueMove(executor, accountId, context.refs, spam.imap_folder_name)
}

async function applyNotSpam(
  executor: SqlExecutor,
  context: ActionContext
): Promise<void> {
  const accountId = context.thread.account_id
  if (context.accountType === "gmail") {
    const spam = await findSpecialLabel(executor, accountId, "spam")
    const inbox = await findSpecialLabel(executor, accountId, "inbox")
    const removals = spam ? [spam.id] : []
    const current = await currentLabelsMinus(
      executor,
      context.thread.id,
      removals
    )
    const next =
      inbox && !current.includes(inbox.id) ? [...current, inbox.id] : current
    await setThreadLabels(executor, context.thread.id, next)
    await enqueueNotSpam(executor, accountId, context.refs)
    return
  }
  const inbox = await findSpecialLabel(executor, accountId, "inbox")
  if (!inbox || inbox.imap_folder_name === null) {
    throw new MissingSpecialFolderError(accountId, "inbox")
  }
  await moveThreadToFolder(executor, context.thread.id, context.messages, inbox)
  await enqueueMove(executor, accountId, context.refs, inbox.imap_folder_name)
}

async function applyDeleteForever(
  executor: SqlExecutor,
  context: ActionContext
): Promise<void> {
  if (context.thread.is_trashed !== 1) {
    throw new NotInTrashError(context.thread.id)
  }
  // Children cascade (thread_labels, attachments); the messages_fts_ad
  // trigger unindexes the deleted bodies.
  await executor.execute("DELETE FROM messages WHERE thread_id = $1", [
    context.thread.id,
  ])
  await executor.execute("DELETE FROM threads WHERE id = $1", [
    context.thread.id,
  ])
}

async function applyRead(
  executor: SqlExecutor,
  context: ActionContext,
  read: boolean
): Promise<void> {
  await markMessagesRead(
    executor,
    context.messages.map((message) => message.id),
    read
  )
  await recomputeThreadCaches(executor, context.thread.id)
}

async function applyStar(
  executor: SqlExecutor,
  context: ActionContext,
  starred: boolean
): Promise<void> {
  await markMessagesFlagged(
    executor,
    context.messages.map((message) => message.id),
    starred
  )
  await setThreadStarredCache(executor, context.thread.id, starred)
}

// ---- thread_labels membership helpers (gmail model) ----

async function currentLabelIds(
  executor: SqlExecutor,
  threadId: string
): Promise<string[]> {
  const rows = await executor.select<{ label_id: string }>(
    "SELECT label_id FROM thread_labels WHERE thread_id = $1",
    [threadId]
  )
  return rows.map((row) => row.label_id)
}

/** Current membership minus the given label ids (archive/not-spam removals). */
async function currentLabelsMinus(
  executor: SqlExecutor,
  threadId: string,
  removeLabelIds: string[]
): Promise<string[]> {
  const current = await currentLabelIds(executor, threadId)
  return current.filter((labelId) => !removeLabelIds.includes(labelId))
}
