import type { SqlExecutor } from "../db/executor"
import { getAccount } from "../db/accounts"
import type { EmailProvider } from "../email/types"
import { backfillGmailHistory } from "../sync/gmail-sync"
import { backfillImapHistory } from "../sync/imap-sync"
import { backfillMicrosoftHistory } from "../sync/microsoft-sync"
import type { HistoryBackfillOperation } from "./operation"

/**
 * The `history_backfill` replay executor (parity-round-3 task 3.3, design
 * D6): dispatches the frozen range to the account type's sync driver, the
 * same engines the scheduler runs. Lives beside the processor (not inside
 * it) so the driver imports stay out of operation.ts's type-only module.
 *
 * Failure semantics are the queue's own: any rejection is retried with
 * backoff up to the cap — the drivers' upserts are idempotent, so a
 * partially applied range converges on replay. Auth failures surface as
 * ProviderAuthError from the drivers and pause the account like any op.
 */
export async function executeHistoryBackfill(
  executor: SqlExecutor,
  accountId: string,
  provider: EmailProvider,
  op: HistoryBackfillOperation
): Promise<void> {
  const row = await getAccount(executor, accountId)
  if (!row) {
    // Account deleted while the op sat queued: nothing to backfill.
    return
  }
  const range = { since: op.since, until: op.until }
  const options = { executor, provider, accountId }
  switch (row.type) {
    case "gmail":
      await backfillGmailHistory(options, range)
      return
    case "microsoft":
      await backfillMicrosoftHistory(options, range)
      return
    case "imap":
      await backfillImapHistory(options, range)
      return
  }
}
