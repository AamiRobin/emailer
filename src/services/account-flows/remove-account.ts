import type { SqlExecutor } from "../db/executor"
import { getExecutor } from "../db/executor"
import { deleteAccount } from "../db/accounts"
import { purgeAiCacheForAccount } from "../ai/cache"
import { useAccountStore } from "../../stores/account-store"

/**
 * Remove-account orchestrator (task 5.5, accounts spec "Remove with
 * confirmation").
 *
 * One DELETE on the account row — the schema's ON DELETE CASCADE removes
 * the account's credentials envelope, messages, threads, labels,
 * attachments and every other account-scoped row. Other accounts and their
 * data are untouched. The confirmation step lives in the UI
 * (RemoveAccountDialog); by the time this runs the user has confirmed.
 *
 * The AI stores are the one non-cascaded cleanup (task 4.3, design D2):
 * ai_cache rows and the writing-style profile carry the account as plain
 * provenance attribution, not an FK, so they are purged explicitly by
 * account_id here (ai-assistance spec scenario "Account removal clears
 * cache").
 *
 * After the delete, the account store reload re-applies the active-restore
 * chain: if the removed account was active, another connected account
 * becomes active — with no accounts left the switcher shows its empty
 * state and the shell can offer "Add account".
 */

export async function removeAccount(
  accountId: string,
  options?: { executor?: SqlExecutor }
): Promise<void> {
  const executor = options?.executor ?? getExecutor()
  await purgeAiCacheForAccount(executor, accountId)
  await deleteAccount(executor, accountId)
  await useAccountStore.getState().reload()
}
