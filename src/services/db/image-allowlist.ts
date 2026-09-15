import type { SqlExecutor } from "./executor"

/**
 * Remote-image sender allowlist (task 7.3, design D7). The
 * `image_allowlist` table remembers the senders whose remote images render
 * automatically — the "always allow images from this sender" choice. Rows
 * are per account (sender identity is only meaningful within an account)
 * and keyed (account_id, sender_email).
 *
 * Local-only preference: no server sync, the row is removed when the
 * account is removed (FK cascade). Addresses are normalized to lowercase
 * on both write and read so lookup is case-insensitive — email local parts
 * are technically case-sensitive, but every mainstream provider treats the
 * address case-insensitively and the allowlist is a display preference,
 * not an identity check.
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(), tests pass the node:sqlite test executor.
 */

/** Lowercase normalization for allowlist lookups (see module comment). */
export function normalizeSenderEmail(senderEmail: string): string {
  return senderEmail.trim().toLowerCase()
}

export async function isSenderAllowed(
  executor: SqlExecutor,
  accountId: string,
  senderEmail: string
): Promise<boolean> {
  const rows = await executor.select<{ sender_email: string }>(
    "SELECT sender_email FROM image_allowlist WHERE account_id = $1 AND sender_email = $2 LIMIT 1",
    [accountId, normalizeSenderEmail(senderEmail)]
  )
  return rows.length > 0
}

/** Allow remote images from `senderEmail`; idempotent (INSERT OR IGNORE). */
export async function allowSender(
  executor: SqlExecutor,
  accountId: string,
  senderEmail: string
): Promise<void> {
  await executor.execute(
    "INSERT OR IGNORE INTO image_allowlist (account_id, sender_email) VALUES ($1, $2)",
    [accountId, normalizeSenderEmail(senderEmail)]
  )
}

/** Revoke a sender's allowlist entry (no-op when not present). */
export async function removeSender(
  executor: SqlExecutor,
  accountId: string,
  senderEmail: string
): Promise<void> {
  await executor.execute(
    "DELETE FROM image_allowlist WHERE account_id = $1 AND sender_email = $2",
    [accountId, normalizeSenderEmail(senderEmail)]
  )
}
