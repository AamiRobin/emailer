import type { SqlExecutor } from "../db/executor"
import type { ThreadSortOption } from "../db/thread-sort"
import { listSenderStats } from "../db/sender-stats"
import type { ThreadRow } from "../db/threads"
import { listThreadsAcrossAccounts } from "../db/threads"
import { classifySender } from "./classify"

/**
 * The priority inbox view (task 13.2, design D7): the inbox threads whose
 * NEWEST sender classifies "important".
 *
 * Scoping decision — the view is the IMPORTANT side only. The full
 * Important/Other split would mean rendering two sections in one list
 * (thread-list UI work D4's scope model doesn't cover cleanly); instead
 * "Priority" is a list scope ({kind:"priority"}) listing the important
 * threads, and Other is simply everything else, reachable through the
 * ordinary inbox — matching the task's lean alternative.
 *
 * Implementation choice — classify in JS, not SQL. The thread selection
 * reuses listThreadsAcrossAccounts with the PRESET inbox (exactly the
 * unified inbox's predicates: trash/spam caches out, snoozed/muted/done/
 * held exclusions in, pinned-first ordering) and the senders are then
 * classified against the (small, one-row-per-sender) stats table in
 * memory. A SQL JOIN over json_extract(participants, …) would re-implement
 * the classification threshold in SQL for no measurable gain.
 *
 * Sender match: sender_stats rows are keyed by the lowercased From
 * address; a thread's newest sender comes from the participants cache
 * (migration v2 — participants[0] is the newest message's From), so the
 * join key is lowercased too. A thread with no usable participants cache
 * or no stat row classifies "other" (no evidence) and stays out.
 *
 * `accountIds` restricts the accounts (the thread-list store passes the
 * ACTIVE accounts); null or empty means every account, like
 * listThreadsAcrossAccounts — the store guards the empty-active-set case
 * itself (an empty set must not silently widen to "every account").
 */
export async function listPriorityImportant(
  executor: SqlExecutor,
  accountIds: string[] | null,
  sort?: ThreadSortOption
): Promise<ThreadRow[]> {
  const threads = await listThreadsAcrossAccounts(executor, {
    ...(accountIds !== null && accountIds.length > 0 ? { accountIds } : {}),
    folder: { kind: "preset", preset: "inbox" },
    ...(sort ? { sort } : {}),
  })
  if (threads.length === 0) return []

  const stats = await listSenderStats(executor, accountIds)
  const statByAccountSender = new Map(
    stats.map((stat) => [`${stat.account_id}\u0000${stat.sender}`, stat])
  )
  const now = Math.floor(Date.now() / 1000)
  return threads.filter((thread) => {
    const sender = newestSenderAddress(thread.participants)
    if (!sender) return false
    const stat =
      statByAccountSender.get(`${thread.account_id}\u0000${sender}`) ?? null
    return classifySender(stat, now) === "important"
  })
}

/**
 * The newest message's sender address from the participants display cache
 * (JSON `[{name?, email}, …]` — from first). Tolerant: corrupt JSON, a
 * non-object head or a blank address yields null (→ the thread is Other).
 */
function newestSenderAddress(participants: string | null): string | null {
  if (!participants) return null
  try {
    const parsed: unknown = JSON.parse(participants)
    if (!Array.isArray(parsed)) return null
    const head = parsed[0]
    if (typeof head !== "object" || head === null) return null
    const email = (head as { email?: unknown }).email
    if (typeof email !== "string") return null
    const key = email.trim().toLowerCase()
    return key === "" ? null : key
  } catch {
    return null
  }
}
