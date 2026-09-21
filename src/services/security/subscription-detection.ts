import type { SqlExecutor } from "@/services/db/executor"
import { recordSenderSeen } from "@/services/settings/subscriptions"

/**
 * The ingestion side of the subscription manager (task 3.6, design D13 —
 * the mail-security spec's "Subscription manager"). The sync engines call
 * `recordSubscriptionActivity` for every NEWLY INSERTED message, at the
 * same seam as the categorization pass (categorization/ingestion.ts):
 * after persistence, BEFORE the new-mail count is finalized — the count is
 * what the scheduler forwards to notifyNewMail, so a detected sender is
 * listed and an unsubscribed sender's resume is recorded before any
 * notification can fire.
 *
 * Detection is header-shaped ONLY (the spec's "senders detected as
 * newsletters"): a message counts when it carries a `List-Unsubscribe`
 * header (RFC 2369) or the `List-Unsubscribe-Post` one-click
 * advertisement (RFC 8058) — the header pair the stored messages.headers
 * JSON already captures (the engines' buildStoredHeaders) and the
 * IngestionEvent carries parsed. Each detected message is recorded through
 * recordSenderSeen, which owns the whole entry contract: creating the
 * sender as "subscribed", refreshing the last-seen header pair and
 * lastSeenAt (monotonic), and the spec's "sender resumed" flip when mail
 * arrives for an "unsubscribed" sender. Plain correspondence never enters
 * the list.
 *
 * Isolation like every consumer in this flow: one message's failure is
 * warned about and never breaks the pass (the sender is simply not
 * recorded this once — the next mail from it retries); the pass itself
 * never throws, so it can sit bare next to the categorization call.
 */

/** The message facts detection needs — a structural subset of the sync
 * engines' IngestionEvent, so the engines hand their new events over
 * directly (the same call shape as the stats consumer). */
export interface SubscriptionActivityInput {
  /** messages.id of the inserted row (actionable isolation warnings). */
  messageRowId: string
  /** The sender address; null when the message carried none. */
  fromAddress: string | null
  /** Arrival of the just-seen mail, unix seconds (the entry's lastSeenAt —
   * recordSenderSeen keeps it monotonic against the stored value). */
  date: number
  /** The stored headers keyed by lowercase header name — exactly the
   * messages.headers capture (list-unsubscribe / -post today). */
  headers: Record<string, string>
}

/**
 * Record one pass's new mail on the subscription list: every message with
 * a sender AND an unsubscribe header is written through recordSenderSeen.
 * Resolves when every write settled (or was warned about) — the engines
 * await this before finalizing the new-mail count, like categorization.
 */
export async function recordSubscriptionActivity(
  executor: SqlExecutor,
  accountId: string,
  messages: readonly SubscriptionActivityInput[]
): Promise<void> {
  for (const message of messages) {
    // Only DETECTED newsletters are recorded: mail carrying either
    // unsubscribe header. An empty (or whitespace-only) header value
    // carries no target and no information — recordSenderSeen would drop
    // it, so treat it as absent here.
    const listUnsubscribe = message.headers["list-unsubscribe"]?.trim()
    const listUnsubscribePost = message.headers["list-unsubscribe-post"]?.trim()
    if (!listUnsubscribe && !listUnsubscribePost) continue
    const sender = message.fromAddress?.trim() ?? ""
    if (sender === "") continue
    try {
      await recordSenderSeen(executor, accountId, {
        sender,
        lastSeenAt: message.date,
        ...(listUnsubscribe ? { listUnsubscribe } : {}),
        ...(listUnsubscribePost ? { listUnsubscribePost } : {}),
      })
    } catch (error) {
      console.warn(
        `[subscriptions] failed to record mail from ${sender} ` +
          `(message ${message.messageRowId}); skipping it this pass`,
        error
      )
    }
  }
}
