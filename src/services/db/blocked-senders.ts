import type { SqlExecutor } from "./executor"
import { findLabelsBySpecialUse } from "./labels"
import { bulkApply } from "../email-actions/thread-actions"

/**
 * Sender blocklist (task 18.2, mail-security spec "Block sender"): CRUD
 * over the `blocked_senders` table (migration v3). Blocking is LOCAL and
 * PER ACCOUNT — no provider surface is touched; the ingestion hook
 * (rules/ingestion.ts, its FIFTH consumer) auto-files each account's new
 * mail from these senders per the stored `action`, and the settings
 * "Blocked senders" section lists/unblocks them.
 *
 * Matching semantics: EXACT ADDRESS, lowercased. Addresses are stored
 * lowercased (same normalization as sender_stats/aliases — SQLite's
 * UNIQUE(account_id, sender) is case-sensitive, so the index must not
 * admit case twins) and every lookup lowercases its argument, so
 * `Spam@X.com` mail is blocked by a `spam@x.com` row. Deliberately NOT
 * domain matching: the spec blocks "a sender" (the address the user saw);
 * a whole-domain block is a different, broader contract.
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor. The cleanup
 * helpers at the bottom (countBlockedExisting / applyBlockToExistingMail)
 * reach into the thread-actions service so a cleanup files threads through
 * the SAME bulk path (local effect + queue ops) as a user multi-select.
 */

/** What happens to future (and, on cleanup, existing) mail. */
export type BlockedSenderAction = "trash" | "archive"

/** Mirrors the `blocked_senders` table (migrations.ts v3). */
export interface BlockedSenderRow {
  id: string
  account_id: string
  /** Lowercased sender address (the canonical key — see module doc). */
  sender: string
  action: BlockedSenderAction
  created_at: number
}

/**
 * Canonical (lowercased) blocklist key for an address; empty addresses
 * never become rows.
 */
export function blockedSenderKey(sender: string): string | null {
  const key = sender.trim().toLowerCase()
  return key === "" ? null : key
}

/** Every blocked sender of one account, alphabetical (stable for settings). */
export async function listBlockedSenders(
  executor: SqlExecutor,
  accountId: string
): Promise<BlockedSenderRow[]> {
  return executor.select<BlockedSenderRow>(
    "SELECT * FROM blocked_senders WHERE account_id = $1 ORDER BY sender ASC",
    [accountId]
  )
}

/**
 * Block a sender with the action chosen at block time. Idempotent
 * upsert on UNIQUE(account_id, sender): re-blocking an already-blocked
 * address UPDATES the action (the user's newest choice wins) instead of
 * failing on the unique index.
 */
export async function blockSender(
  executor: SqlExecutor,
  accountId: string,
  input: { sender: string; action: BlockedSenderAction }
): Promise<void> {
  const key = blockedSenderKey(input.sender)
  if (!key) return
  await executor.execute(
    `INSERT INTO blocked_senders (id, account_id, sender, action)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT(account_id, sender) DO UPDATE SET action = excluded.action`,
    [crypto.randomUUID(), accountId, key, input.action]
  )
}

/** Remove a sender from the blocklist (settings "Unblock"). No-op when
 * the row is already gone. */
export async function unblockSender(
  executor: SqlExecutor,
  id: string
): Promise<void> {
  await executor.execute("DELETE FROM blocked_senders WHERE id = $1", [id])
}

/**
 * The block state of one address for one account: `{ action }` when
 * blocked (the action the ingestion hook applies), null otherwise. The
 * comparison is lowercased-exact (see the module doc).
 */
export async function isSenderBlocked(
  executor: SqlExecutor,
  accountId: string,
  senderAddress: string
): Promise<{ action: BlockedSenderAction } | null> {
  const key = blockedSenderKey(senderAddress)
  if (!key) return null
  const rows = await executor.select<Pick<BlockedSenderRow, "action">>(
    "SELECT action FROM blocked_senders WHERE account_id = $1 AND sender = $2",
    [accountId, key]
  )
  const row = rows[0]
  return row ? { action: row.action } : null
}

// ---- Cleanup option (task 18.2): apply the block to EXISTING mail ----

/**
 * The thread's newest-message sender, from the participants cache
 * (`threads.participants` — its first entry is the newest message's
 * from-contact, maintained by recomputeThreadCaches). This is the SAME
 * sender identity the rest of the codebase uses — the sender sort and the
 * group-by-sender bundles (bundles.ts bundleSenderOf) read exactly this
 * cache — so a cleanup catches every thread the user sees as "from" that
 * sender. Null when the row has no usable cached sender (no participants
 * JSON, or a from-contact without an address); senderless threads are
 * never cleaned up.
 */
function latestSenderOf(participantsJson: string | null): string | null {
  if (!participantsJson) return null
  try {
    const parsed: unknown = JSON.parse(participantsJson)
    if (!Array.isArray(parsed)) return null
    const first = parsed[0]
    if (
      typeof first !== "object" ||
      first === null ||
      typeof (first as { email?: unknown }).email !== "string"
    ) {
      return null
    }
    const email = (first as { email: string }).email.trim().toLowerCase()
    return email === "" ? null : email
  } catch {
    return null
  }
}

/**
 * Inbox-resident threads of one account, as the INBOX VIEW defines
 * residency: membership in an inbox-role label (either placement model —
 * gmail thread_labels rows or the imap folder cache), not trashed/spam,
 * and not hidden from the inbox by snooze/mute/Done/delivery-hold. The
 * cleanup and its count use the same selection, so the number the block
 * dialog offers is exactly what applying it moves.
 */
async function listInboxResidentThreadsFromSender(
  executor: SqlExecutor,
  accountId: string,
  senderKey: string
): Promise<{ id: string }[]> {
  const inboxLabels = await findLabelsBySpecialUse(executor, accountId, "inbox")
  if (inboxLabels.length === 0) return []
  const inboxIds = inboxLabels.map((label) => label.id)
  // Placeholders start at $2 ($1 is the account) and each list is bound
  // separately, ascending by occurrence (see executor.ts).
  const list = (firstIndex: number): string =>
    inboxIds.map((_, index) => `$${firstIndex + index}`).join(", ")
  const rows = await executor.select<{
    id: string
    participants: string | null
  }>(
    `SELECT threads.id, threads.participants FROM threads
     WHERE threads.account_id = $1
       AND threads.is_trashed = 0 AND threads.is_spam = 0
       AND threads.snoozed_until IS NULL AND threads.muted_at IS NULL
       AND threads.done_at IS NULL AND threads.held_until IS NULL
       AND (threads.folder_label_id IN (${list(2)}) OR EXISTS (
         SELECT 1 FROM thread_labels tl
         WHERE tl.thread_id = threads.id AND tl.label_id IN (${list(2 + inboxIds.length)}))
       )`,
    [accountId, ...inboxIds, ...inboxIds]
  )
  return rows.filter((row) => latestSenderOf(row.participants) === senderKey)
}

/**
 * How many inbox-resident conversations the sender currently has — the
 * block dialog's "Also move N existing conversations" offer, computed
 * BEFORE blocking (the blocklist row itself never changes the count).
 */
export async function countBlockedExisting(
  executor: SqlExecutor,
  accountId: string,
  sender: string
): Promise<number> {
  const key = blockedSenderKey(sender)
  if (!key) return 0
  const rows = await listInboxResidentThreadsFromSender(
    executor,
    accountId,
    key
  )
  return rows.length
}

/**
 * The block-time cleanup: file every inbox-resident conversation whose
 * newest-message sender matches through the BULK thread-actions path
 * (bulkApply — the same local effect + queue op sequence a user
 * multi-select runs). Returns how many threads were moved. Done AFTER
 * blockSender wrote the blocklist row, so the choice at block time is
 * already durable when the (per-thread, fail-fast) filing starts.
 */
export async function applyBlockToExistingMail(
  executor: SqlExecutor,
  accountId: string,
  sender: string,
  action: BlockedSenderAction
): Promise<number> {
  const key = blockedSenderKey(sender)
  if (!key) return 0
  const rows = await listInboxResidentThreadsFromSender(
    executor,
    accountId,
    key
  )
  if (rows.length === 0) return 0
  await bulkApply(
    executor,
    accountId,
    rows.map((row) => row.id),
    action
  )
  return rows.length
}
