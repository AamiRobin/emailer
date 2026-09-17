import type { SqlExecutor } from "./executor"
import { placeholders } from "./executor"

/**
 * Per-sender statistics and priority overrides (task 13, design D5/D7).
 *
 * `sender_stats` accumulates, per (account, sender), the raw signals the
 * priority-inbox heuristic scores (classify.ts): reply counts, direct-to-me
 * counts, the latest message time and a mailing-list marker. Rows are
 * written ONLY from the ingestion hook (rules/ingestion.ts
 * recordSenderStats — "one ingestion hook" consumers, D5) and grow lazily
 * as mail arrives; nothing backfills existing mailboxes.
 *
 * `user_class` (migration v4) is the user's per-sender Important/Other
 * override. It lives beside the stats it overrides and DOMINATES the
 * score when set (see priority/classify.ts); NULL means the sender
 * classifies purely on its accumulated signals.
 *
 * Sender identity: addresses are stored LOWERCASED and every lookup
 * lowercases its argument, so `Alice@X.com` mail and `alice@x.com` mail
 * accumulate on one row and the thread-list join (participants cache →
 * stat) is a plain string match.
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor.
 */

/** The user's per-sender override (migration v4); null = heuristic only. */
export type UserSenderClass = "important" | "other"

export interface SenderStatRow {
  id: string
  account_id: string
  /** Lowercased sender address (the canonical key — see module doc). */
  sender: string
  reply_count: number
  direct_to_me_count: number
  last_message_at: number | null
  is_mailing_list: number
  user_class: UserSenderClass | null
  created_at: number
}

/** One arriving message's contribution to a sender's row. */
export interface SenderStatPatch {
  /** The thread is an ongoing conversation (Re: subject or the thread
   * already carries a message from the account's own address). */
  isReply?: boolean
  /** The account's own address is among the message's to/cc contacts. */
  isDirectToMe?: boolean
  /** Provider-side bulk/list signal (gmail tab labels, IMAP subject tag). */
  isMailingList?: boolean
  /** The message's date (unix seconds); keeps last_message_at at MAX. */
  date: number
}

/**
 * Canonical (lowercased) stat key for an address; empty addresses never
 * become rows.
 */
export function senderStatKey(sender: string): string | null {
  const key = sender.trim().toLowerCase()
  return key === "" ? null : key
}

/**
 * Accumulate one message's signals into the sender's row, creating it on
 * first sight. The counts ADD, `last_message_at` keeps the MAX (a late
 * backfill must not rewind recency) and `is_mailing_list` ORs — once a
 * list, always penalized. `user_class` is never touched here: overrides
 * belong to setUserSenderClass only. A single upsert keeps concurrent
 * pass groups from read-modify-write races.
 */
export async function upsertSenderStat(
  executor: SqlExecutor,
  accountId: string,
  sender: string,
  patch: SenderStatPatch
): Promise<void> {
  const key = senderStatKey(sender)
  if (!key) return
  await executor.execute(
    `INSERT INTO sender_stats (
      id, account_id, sender, reply_count, direct_to_me_count,
      last_message_at, is_mailing_list
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT(account_id, sender) DO UPDATE SET
      reply_count = reply_count + excluded.reply_count,
      direct_to_me_count = direct_to_me_count + excluded.direct_to_me_count,
      last_message_at = MAX(
        COALESCE(last_message_at, excluded.last_message_at),
        excluded.last_message_at
      ),
      is_mailing_list = MAX(is_mailing_list, excluded.is_mailing_list)`,
    [
      crypto.randomUUID(),
      accountId,
      key,
      patch.isReply ? 1 : 0,
      patch.isDirectToMe ? 1 : 0,
      patch.date,
      patch.isMailingList ? 1 : 0,
    ]
  )
}

/** The sender's accumulated row, or null when nothing arrived yet. */
export async function getSenderStat(
  executor: SqlExecutor,
  accountId: string,
  sender: string
): Promise<SenderStatRow | null> {
  const key = senderStatKey(sender)
  if (!key) return null
  const rows = await executor.select<SenderStatRow>(
    "SELECT * FROM sender_stats WHERE account_id = $1 AND sender = $2",
    [accountId, key]
  )
  return rows[0] ?? null
}

/**
 * Every stat row in scope, sender-ordered. `accountIds` null/empty = every
 * account (the priority view resolves one account set's rows in a single
 * query — the table is small by construction: one row per distinct sender).
 */
export async function listSenderStats(
  executor: SqlExecutor,
  accountIds: string[] | null
): Promise<SenderStatRow[]> {
  if (accountIds !== null && accountIds.length > 0) {
    return executor.select<SenderStatRow>(
      `SELECT * FROM sender_stats
       WHERE account_id IN (${placeholders(accountIds.length)})
       ORDER BY sender ASC`,
      accountIds
    )
  }
  return executor.select<SenderStatRow>(
    "SELECT * FROM sender_stats ORDER BY sender ASC"
  )
}

/**
 * Store (or clear) the user's per-sender override. Creating a row for a
 * sender with no stats yet is deliberate — the user may classify a sender
 * before any of its mail arrives, and the override must survive until the
 * first message lands. `null` clears back to the pure heuristic.
 */
export async function setUserSenderClass(
  executor: SqlExecutor,
  accountId: string,
  sender: string,
  userClass: UserSenderClass | null
): Promise<void> {
  const key = senderStatKey(sender)
  if (!key) return
  await executor.execute(
    `INSERT INTO sender_stats (
      id, account_id, sender, reply_count, direct_to_me_count,
      last_message_at, is_mailing_list, user_class
    ) VALUES ($1, $2, $3, 0, 0, NULL, 0, $4)
    ON CONFLICT(account_id, sender) DO UPDATE SET user_class = excluded.user_class`,
    [crypto.randomUUID(), accountId, key, userClass]
  )
}
