import type { SqlExecutor } from "../db/executor"
import { getExecutor } from "../db/executor"
import { deleteAccount } from "../db/accounts"
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
 * After the delete, the account store reload re-applies the active-restore
 * chain: if the removed account was active, another connected account
 * becomes active — with no accounts left the switcher shows its empty
 * state and the shell can offer "Add account".
 */

export async function removeAccount(
  accountId: string,
  options?: { executor?: SqlExecutor }
): Promise<void> {
  await deleteAccount(options?.executor ?? getExecutor(), accountId)
  await useAccountStore.getState().reload()
}
