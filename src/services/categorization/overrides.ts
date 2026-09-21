import type { SqlExecutor } from "../db/executor"
import type { Category } from "./classify"
import { setSenderCategory } from "./sender-categories"

/**
 * User overrides of the automatic categorization (task 3.4, design D4,
 * mail-organization spec "Automatic categorization": categorization "SHALL
 * be overridable per thread by the user (move to category,
 * always-from-sender), and user overrides SHALL feed back as the rule for
 * that sender").
 *
 * These two functions are the service layer the task 3.5 menu affordance
 * ("Move to category" items on the thread context menu) will call — they
 * are deliberately built now, menu-less, so the semantics land with tests
 * first.
 *
 * Two distinct override scopes, matching the two user choices:
 * - moveThreadToCategory — PER THREAD: an unconditional write to
 *   threads.category. Unconditional is the point: the ingestion pass's
 *   keep-first UPDATE (`AND category IS NULL`,
 *   categorization/ingestion.ts) protects exactly this value once set, so
 *   a user move beats every later heuristic and stays put as more mail
 *   arrives on the thread. Local-only column — no queue op, no provider
 *   mutation (categories do not exist on gmail/imap).
 * - alwaysFromSender — PER SENDER: derives the thread's sender (the
 *   newest message's From address, same recency rule as the thread-cache
 *   snippet: `ORDER BY date DESC, rowid DESC`, db/threads.ts) and upserts
 *   a `sender_categories` row with source 'user' — which
 *   classify.ts ranks WITH the user rules, ABOVE the header heuristics
 *   (the spec's "feed back as the rule for that sender"; verified there).
 *   Deliberately NOT a rules-table row (D4: keeps the rules UI clean).
 *   The thread itself is moved too, so the visible thread reflects the
 *   choice immediately.
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor.
 */

/**
 * Move one thread to a category, overriding whatever is there (a
 * heuristic category, a previous move, even NULL). The future task 3.5
 * menu's plain "move to category" call.
 */
export async function moveThreadToCategory(
  executor: SqlExecutor,
  threadId: string,
  category: Category
): Promise<void> {
  // No `AND category IS NULL` guard on purpose — a user move beats the
  // keep-first contract (see the module comment).
  await executor.execute("UPDATE threads SET category = $1 WHERE id = $2", [
    category,
    threadId,
  ])
}

/**
 * "Always from this sender": store the sender's category decision with
 * source 'user' (the per-sender rule future arrivals resolve through
 * getSenderCategory/getSenderCategories) AND move the thread. The sender
 * is the thread's newest message's From address; a thread without any
 * message (or whose newest From rows are all NULL) still moves, but no
 * sender rule can be derived — there is nothing to pin the decision to.
 */
export async function alwaysFromSender(
  executor: SqlExecutor,
  threadId: string,
  category: Category
): Promise<void> {
  // Newest message's From address (db/threads.ts's recency convention).
  const rows = await executor.select<{ from_address: string | null }>(
    `SELECT from_address FROM messages
     WHERE thread_id = $1 AND from_address IS NOT NULL
     ORDER BY date DESC, rowid DESC
     LIMIT 1`,
    [threadId]
  )
  const sender = rows[0]?.from_address ?? null
  if (sender) {
    await setSenderCategory(executor, sender, category, "user")
  }
  await moveThreadToCategory(executor, threadId, category)
}
