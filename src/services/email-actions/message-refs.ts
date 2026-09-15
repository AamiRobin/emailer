import type { AccountType, MessageRef } from "../email/types"
import type { MessageRow } from "../db/messages"

/**
 * MessageRef construction for thread actions (task 10.1, design D10).
 *
 * The offline queue addresses server mutations per MESSAGE (MessageRef),
 * while the actions operate per THREAD — this module projects a thread's
 * messages rows onto the provider's addressing scheme:
 * - imap: (folder, uid) = (messages.imap_folder, messages.imap_uid).
 * - gmail: providerMessageId = messages.gmail_message_id (the exact
 *   string id the Gmail API accepts); `folder` carries no meaning and is
 *   "". uid is a legacy numeric fallback (0 for non-numeric ids — real
 *   Gmail ids are opaque strings that must not go through Number()).
 */

/** A message row lacks the provider key a ref would be built from. */
export class MissingProviderRefError extends Error {
  constructor(messageId: string, accountType: AccountType) {
    super(
      `message ${messageId} has no ${accountType} provider identity ` +
        (accountType === "gmail"
          ? "(gmail_message_id is null)"
          : "(imap_uid/imap_folder is null)")
    )
    this.name = "MissingProviderRefError"
  }
}

/** Numeric string → uid; non-numeric (real Gmail ids) → 0, with the
 * exact string carried in providerMessageId instead. */
function uidFallback(id: string): number {
  const parsed = Number(id)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Build the MessageRef[] a thread action queues for its provider op, one
 * ref per message row, in the thread's chronological order. A row missing
 * its provider key throws: silently dropping a ref could strand a server
 * mutation (dangerous for delete_forever) — such rows cannot exist for
 * synced messages anyway (the provider key is the sync upsert key).
 */
export function buildMessageRefs(
  accountType: AccountType,
  messages: MessageRow[]
): MessageRef[] {
  return messages.map((message) => {
    if (accountType === "gmail") {
      if (message.gmail_message_id === null) {
        throw new MissingProviderRefError(message.id, accountType)
      }
      return {
        folder: "",
        uid: uidFallback(message.gmail_message_id),
        providerMessageId: message.gmail_message_id,
      }
    }
    if (message.imap_uid === null || message.imap_folder === null) {
      throw new MissingProviderRefError(message.id, accountType)
    }
    return { folder: message.imap_folder, uid: message.imap_uid }
  })
}
