import type { SqlExecutor } from "../db/executor"
import { messageIdVariants } from "./threading"

/**
 * DB-side thread resolution for the IMAP sync engine: before pure
 * grouping runs (threading.ts), a fetched message is matched against
 * messages already persisted for the account so replies land in the
 * thread their ancestors created — even when the ancestor synced in an
 * earlier batch or lives in a different folder (e.g. the Sent copy of a
 * conversation). All lookups return the thread id of the first match or
 * null; callers own thread creation and cache recomputation.
 */

export interface FoundMessage {
  id: string
  threadId: string
}

/** Existing local row for one (account, folder, uid) provider key. */
export async function findMessageByImapUid(
  executor: SqlExecutor,
  accountId: string,
  imapFolder: string,
  imapUid: number
): Promise<FoundMessage | null> {
  const rows = await executor.select<FoundMessage>(
    `SELECT id, thread_id AS threadId FROM messages
     WHERE account_id = $1 AND imap_folder = $2 AND imap_uid = $3
     LIMIT 1`,
    [accountId, imapFolder, imapUid]
  )
  return rows[0] ?? null
}

/** Thread of the message carrying exactly this Message-ID header. */
export async function findThreadByMessageIdHeader(
  executor: SqlExecutor,
  accountId: string,
  messageId: string
): Promise<string | null> {
  const variants = messageIdVariants(messageId)
  if (variants.length === 0) return null
  const rows = await executor.select<{ threadId: string }>(
    `SELECT thread_id AS threadId FROM messages
     WHERE account_id = $1 AND message_id_header IN ($2, $3)
     ORDER BY date ASC, created_at ASC LIMIT 1`,
    [accountId, variants[0], variants[1]]
  )
  return rows[0]?.threadId ?? null
}

/**
 * Walk a References/In-Reply-To chain newest→oldest and return the
 * thread of the first ancestor already present in the account. The
 * chain order decides precedence: the direct parent wins over older
 * ancestors, matching real conversations where only part of the
 * history is on the server.
 */
export async function findThreadByReferenceChain(
  executor: SqlExecutor,
  accountId: string,
  referenceIds: string[]
): Promise<string | null> {
  for (const referenceId of referenceIds) {
    const threadId = await findThreadByMessageIdHeader(
      executor,
      accountId,
      referenceId
    )
    if (threadId) return threadId
  }
  return null
}
