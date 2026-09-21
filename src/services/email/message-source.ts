import { decryptCredentials } from "../crypto/credentials"
import type { MessageRow } from "../db/messages"
import { getProvider } from "./provider-factory"
import type { EmailAccount, MessageRef, ProviderCredentials } from "./types"
import { ProviderAuthError } from "./types"

/**
 * Raw message source for the reading UI (task 1.2, design D6): resolves
 * the stored message row's provider identity, builds the account's
 * provider through the factory and calls its getMessageSource — Gmail
 * format=raw, IMAP the imap_fetch_source command (BODY.PEEK[], the same
 * full-message fetch the sync uses, so read state is untouched). One
 * fetch per call: no cache, nothing persisted (D6).
 *
 * The fetch is injectable (tests stub it; the jsdom realm stays
 * network-free and credential-free — decrypted passwords never appear in
 * logs or errors, the providers own their error mapping).
 */

/** The message fields the source fetch needs (mirrors MessageRow). */
export type MessageSourceRow = Pick<
  MessageRow,
  "gmail_message_id" | "imap_folder" | "imap_uid"
>

export interface MessageSourceDeps {
  /** Overrides the provider round-trip (tests). */
  fetchSource?: (
    account: EmailAccount,
    message: MessageSourceRow
  ) => Promise<string>
}

/** Stored row → the provider seam's message handle (gmail id / imap
 * folder+uid; a row lacking location data fails downstream with a clear
 * provider error rather than silently returning the wrong message). */
export function messageSourceRef(message: MessageSourceRow): MessageRef {
  return {
    folder: message.imap_folder ?? "",
    uid: message.imap_uid ?? 0,
    providerMessageId: message.gmail_message_id ?? undefined,
  }
}

async function defaultFetchSource(
  account: EmailAccount,
  message: MessageSourceRow
): Promise<string> {
  let credentials: ProviderCredentials = { password: "" }
  if (account.type === "imap") {
    const decrypted = await decryptCredentials<ProviderCredentials>(
      account.credentialsJson ?? null
    )
    if (!decrypted?.password) {
      throw new ProviderAuthError(
        account.id,
        "imap",
        "no stored password for imap account; re-authentication is required"
      )
    }
    credentials = decrypted
  }
  const provider = getProvider(account, credentials)
  return provider.getMessageSource(messageSourceRef(message))
}

/**
 * Fetch the raw RFC 822 source of a stored message. Throws when the
 * account is unknown, the row has no provider location, or the provider
 * call fails — the dialog renders the error, never a partial source.
 */
export async function getMessageSource(
  account: EmailAccount,
  message: MessageSourceRow,
  deps: MessageSourceDeps = {}
): Promise<string> {
  const fetch = deps.fetchSource ?? defaultFetchSource
  return fetch(account, message)
}
