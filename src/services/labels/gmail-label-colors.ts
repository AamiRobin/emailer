import { decryptCredentials } from "../crypto/credentials"
import { toEmailAccount } from "../db/accounts"
import type { SqlExecutor } from "../db/executor"
import type { AccountRow } from "../db/accounts"
import { createGmailClient } from "../email/gmail-api"
import type { EmailAccount } from "../email/types"
import type { GmailTokenEnvelope } from "../email/token-manager"
import { createTokenSource } from "../email/token-manager"
// The task-4.2 color mappers: encode normalizes the API's color object,
// decode unpacks the encoded form. Importing (not duplicating) keeps the
// wire mapping in one place; gmail-provider.ts itself is untouched.
import { decodeGmailColor, encodeGmailColor } from "../email/gmail-provider"

/**
 * Gmail server-side label color import (task 10.4, mail-organization spec
 * "Gmail label color import"): WHEN a Gmail label has a color on the
 * server, Emailer displays that color.
 *
 * The sync engines see colors only through the raw label listing — the
 * frozen EmailFolder DTO (types.ts) carries no color — so the gmail-sync
 * label pass calls fetchGmailLabelColorMap() and persists each label's
 * BACKGROUND hex onto its labels.color row. The sidebar renders the hex
 * directly (its data-color exception); when the server has no color the
 * locally chosen one stays (spec: "otherwise the locally chosen color
 * applies").
 *
 * Transport mirrors the label-admin service: decrypt the account's token
 * envelope, token-manager silent refresh, gmail-api REST client. Best
 * effort by contract — the sync engine wraps the call and any failure
 * (offline token refresh, missing client id, decrypt error) just means
 * colors are not refreshed this pass.
 */

/**
 * gmail label name → the server background color hex, or null when the
 * label carries no color. Includes system labels (INBOX…) — syncing them
 * is harmless; the sidebar only shows user labels.
 */
export async function fetchGmailLabelColorMap(
  account: EmailAccount,
  deps: {
    fetchImpl?: typeof fetch
    /** Pre-decrypted token envelope (tests); skips credential decryption. */
    tokenEnvelope?: GmailTokenEnvelope
  } = {}
): Promise<Map<string, string | null>> {
  let envelope: GmailTokenEnvelope | null
  if (deps.tokenEnvelope) {
    envelope = deps.tokenEnvelope
  } else {
    try {
      envelope = await decryptCredentials<GmailTokenEnvelope>(
        account.credentialsJson ?? null
      )
    } catch (error) {
      throw new Error(
        "gmail label colors: stored credentials could not be decrypted",
        { cause: error }
      )
    }
  }
  if (!envelope?.refreshToken) {
    throw new Error("gmail label colors: account has no stored token envelope")
  }
  const tokenSource = createTokenSource(
    { id: account.id, oauthClientId: account.oauthClientId },
    envelope,
    deps.fetchImpl
  )
  const client = createGmailClient({
    accountId: account.id,
    getToken: (force) => tokenSource.getToken(force),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  })
  const labels = await client.listLabels()
  const colorByName = new Map<string, string | null>()
  for (const label of labels) {
    const decoded = decodeGmailColor(encodeGmailColor(label.color))
    colorByName.set(label.name, decoded?.backgroundColor ?? null)
  }
  return colorByName
}

/** Convenience wrapper used by the sync engine: loads the account row and
 * builds the color map. Test seams bypass this entirely. */
export async function fetchGmailLabelColorMapForAccount(
  executor: SqlExecutor,
  accountId: string
): Promise<Map<string, string | null>> {
  const rows = await executor.select<AccountRow>(
    "SELECT * FROM accounts WHERE id = $1",
    [accountId]
  )
  const row = rows[0]
  if (!row)
    throw new Error(`gmail label colors: account ${accountId} not found`)
  return fetchGmailLabelColorMap(toEmailAccount(row))
}

/** Production binding for syncGmailAccount's `listLabelColors` option. */
export function gmailLabelColorImporter(
  executor: SqlExecutor,
  accountId: string
): () => Promise<Map<string, string | null>> {
  return () => fetchGmailLabelColorMapForAccount(executor, accountId)
}
