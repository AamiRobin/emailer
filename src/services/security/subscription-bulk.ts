import type { SqlExecutor } from "@/services/db/executor"
import {
  getSubscription,
  markUnsubscribeFailed,
  markUnsubscribed,
  subscriptionKey,
  type SubscriptionEntry,
} from "@/services/settings/subscriptions"
import {
  parseListUnsubscribe,
  performUnsubscribe,
  type UnsubscribePostFn,
} from "@/services/security/unsubscribe"

/**
 * Bulk unsubscribe for the subscription manager (task 3.6, design D13 —
 * the mail-security spec's "Bulk unsubscribe" scenario: select several
 * still-subscribed senders, each is unsubscribed with per-sender
 * success/failure reported).
 *
 * The mechanics are the SAME one-click flow as the message-level
 * affordance (security/unsubscribe.ts): the manager's entries persist the
 * LAST SEEN `List-Unsubscribe` / `-Post` header pair from the sender's
 * mail (recordSenderSeen stores them), and this module replays that pair
 * through parseListUnsubscribe — the exact parse the mail view runs on a
 * message row — then performUnsubscribe POSTs the RFC 8058 one-click
 * request live, or queues the `unsubscribe_post` op when offline (spec:
 * unsubscribing queues for replay). A successful request transitions the
 * entry to "unsubscribed"; a failed one is annotated (lastError) and
 * reported, leaving the state alone.
 *
 * A mailto-only sender (no one-click target) CANNOT run through a batch:
 * the message-level mailto fallback opens a pre-addressed composer, which
 * is inherently one-at-a-time and user-reviewed. Bulk reports it as that
 * sender's failure with an explanatory error — the batch itself never
 * fails (the spec's per-sender results contract).
 *
 * Senders run SEQUENTIALLY on purpose: every entry mutation rewrites the
 * account's whole settings row, and interleaved writes could lose an
 * update. One sender's failure never stops the rest.
 */

/** Injectable seams of the underlying one-click flow (tests; production
 * defaults to the plugin-http patched fetch + the online store). */
export interface BulkUnsubscribeDeps {
  post?: UnsubscribePostFn
  isOnline?: () => boolean
}

/** Per-sender outcome of a bulk run (the spec's reported results). */
export interface BulkUnsubscribeResult {
  sender: string
  ok: boolean
  /** Present when ok is false — the reason, for the inline error state. */
  error?: string
  /** True when the request was queued for replay (offline) instead of
   * posted live — the UI words its toast accordingly. */
  queued?: boolean
}

/** The actionable one-click target stored on an entry (empty when the
 * sender's last seen mail offered none, or only a mailto). */
export function oneClickTargetOf(entry: SubscriptionEntry): string | null {
  const targets = parseListUnsubscribe(
    entry.listUnsubscribe,
    entry.listUnsubscribePost
  )
  return targets.oneClickUrls[0] ?? null
}

/**
 * Unsubscribe ONE stored sender by replaying its stored headers: the
 * one-click POST (or offline queue), then the "unsubscribed" transition.
 * Throws on failure — bulkUnsubscribe turns that into the per-sender
 * result; the failure is also annotated on the entry (best-effort).
 */
export async function unsubscribeStoredSender(
  executor: SqlExecutor,
  accountId: string,
  sender: string,
  deps: BulkUnsubscribeDeps = {}
): Promise<{ queued: boolean }> {
  const key = subscriptionKey(sender)
  if (!key) {
    throw new Error("sender must be a non-empty address")
  }
  try {
    const entry = await getSubscription(executor, accountId, key)
    if (!entry) {
      throw new Error(`no subscription entry for ${key}`)
    }
    const url = oneClickTargetOf(entry)
    if (!url) {
      // Distinguish the two dead ends: a mailto-only list needs the
      // composer (the message-level affordance), no headers at all means
      // nothing actionable was ever seen for this sender.
      throw new Error(
        entry.listUnsubscribe
          ? "this sender only offers an email unsubscribe — use the Unsubscribe option on one of its messages"
          : "no unsubscribe target is stored for this sender"
      )
    }
    const outcome = await performUnsubscribe(executor, accountId, url, deps)
    await markUnsubscribed(executor, accountId, key)
    return { queued: outcome.kind === "queued" }
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "the unsubscribe request failed"
    try {
      await markUnsubscribeFailed(executor, accountId, key, message)
    } catch (annotationError) {
      console.warn(
        "[subscriptions] failed to record the unsubscribe error",
        annotationError
      )
    }
    throw error
  }
}

/**
 * Unsubscribe several stored senders, one result per UNIQUE sender
 * (duplicates collapse; order preserved). A sender's failure — unknown
 * entry, mailto-only, failed/queued POST — becomes that sender's
 * `ok: false` result and never breaks the batch.
 */
export async function bulkUnsubscribe(
  executor: SqlExecutor,
  accountId: string,
  senders: readonly string[],
  deps: BulkUnsubscribeDeps = {}
): Promise<BulkUnsubscribeResult[]> {
  const unique: string[] = []
  const seen = new Set<string>()
  for (const sender of senders) {
    const key = subscriptionKey(sender)
    if (!key || seen.has(key)) continue
    seen.add(key)
    unique.push(key)
  }

  const results: BulkUnsubscribeResult[] = []
  for (const sender of unique) {
    try {
      const { queued } = await unsubscribeStoredSender(
        executor,
        accountId,
        sender,
        deps
      )
      results.push({ sender, ok: true, ...(queued ? { queued } : {}) })
    } catch (error) {
      results.push({
        sender,
        ok: false,
        error:
          error instanceof Error
            ? error.message
            : "the unsubscribe request failed",
      })
    }
  }
  return results
}
