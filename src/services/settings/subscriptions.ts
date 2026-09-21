import type { SqlExecutor } from "@/services/db/executor"
import { getSetting, setSetting } from "@/services/db/settings"

/**
 * Subscription manager storage (task 3.6, design D13 — the mail-security
 * spec's "Subscription manager"). One LOCAL list per account of senders
 * that were unsubscribed from or detected as newsletters (mail carrying
 * `List-Unsubscribe` headers), with each entry's state, last interaction
 * date and the last-seen unsubscribe headers.
 *
 * Storage model — NO subscriptions table: like the delivery schedules
 * (settings/delivery-schedules.ts) the list persists as ONE JSON row in
 * the settings table per account, here under
 * `security.subscriptions:<accountId>`. The row holds an array of
 * SubscriptionEntry keyed by the lowercased sender address (the
 * blocked-senders normalization — no case twins). Every mutation reads
 * the whole array and writes it back, so no read-modify-write races exist
 * within a user action. Structural guards on read drop invalid entries
 * (a hand-edited or older-build row degrades, never crashes); mutation
 * input is validated on WRITE and throws (a UI that produced an empty
 * sender or a non-finite timestamp is a programming error).
 *
 * State machine (the spec's unsubscribed / still subscribed / unknown,
 * plus the spec's "sender resumed"):
 * - recordSenderSeen — the ingestion hook's entry (the wiring itself is a
 *   later task; the ingestion side calls this thin function). Creates the
 *   entry ("subscribed" — the sender demonstrably still mails the user),
 *   refreshes the LAST SEEN List-Unsubscribe / -Post header values, bumps
 *   lastSeenAt monotonically (a backfilled older message never moves
 *   last-seen backward), and implements the spec's resumed flip: mail
 *   recorded for an "unsubscribed" sender transitions it to "resumed".
 * - markUnsubscribed — a successful unsubscribe (live POST resolved or
 *   queued for replay). Clears any previous failure annotation.
 * - markUnsubscribeFailed — best-effort annotation of a failed attempt;
 *   the state is untouched (the user may still be subscribed). A no-op
 *   when the entry vanished mid-flight, so annotating can never break the
 *   batch that reports it.
 * - markSenderResumed — the explicit resumed flip (recordSenderSeen is
 *   its automatic twin). Only "unsubscribed" becomes "resumed"; other
 *   states keep their state (a still-subscribed sender never "resumed")
 *   while lastSeenAt still refreshes.
 * - removeEntry — the spec's removal; no-op for unknown senders (the
 *   deleteDeliverySchedule convention).
 *
 * The stored header values are what the bulk unsubscribe replays (see
 * security/subscription-bulk.ts): unsubscribe mechanics act on
 * List-Unsubscribe TARGETS, not bare addresses, so each entry persists
 * the last header pair seen on the sender's mail.
 */

/** Settings key holding one account's subscription entries (JSON array). */
export function subscriptionsSettingKey(accountId: string): string {
  return `security.subscriptions:${accountId}`
}

/** The subscription lifecycle states (module doc's state machine). */
export type SubscriptionState =
  | "subscribed"
  | "unsubscribed"
  | "unknown"
  | "resumed"

const SUBSCRIPTION_STATES: readonly SubscriptionState[] = [
  "subscribed",
  "unsubscribed",
  "unknown",
  "resumed",
]

/** One stored subscription entry, keyed by the lowercased sender address. */
export interface SubscriptionEntry {
  /** Lowercased sender address (the canonical key — blocked-senders rule). */
  sender: string
  state: SubscriptionState
  /** Last interaction (mail seen from this sender), unix seconds. */
  lastSeenAt: number
  /** When an unsubscribe succeeded, unix seconds. */
  unsubscribedAt?: number
  /** The last failed unsubscribe attempt's message (cleared on success). */
  lastError?: string
  /** The last `List-Unsubscribe` header value seen on this sender's mail
   * (RFC 2369) — what the bulk unsubscribe replays. */
  listUnsubscribe?: string
  /** The matching `List-Unsubscribe-Post` value (the RFC 8058 one-click
   * advertisement) — without it the stored URLs are not one-clickable. */
  listUnsubscribePost?: string
}

/** Canonical (lowercased) entry key for an address; null when empty. */
export function subscriptionKey(sender: string): string | null {
  const key = sender.trim().toLowerCase()
  return key === "" ? null : key
}

// ---------------------------------------------------------------------------
// Validation (write-time throw / read-time drop)
// ---------------------------------------------------------------------------

/** Structural guard for a stored entry — invalid entries are dropped on
 * read so one bad record cannot take down the settings list. */
function isSubscriptionEntry(value: unknown): value is SubscriptionEntry {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  if (typeof entry.sender !== "string" || entry.sender.trim().length === 0) {
    return false
  }
  if (!SUBSCRIPTION_STATES.includes(entry.state as SubscriptionState)) {
    return false
  }
  if (typeof entry.lastSeenAt !== "number" || !Number.isFinite(entry.lastSeenAt)) {
    return false
  }
  if (
    entry.unsubscribedAt !== undefined &&
    (typeof entry.unsubscribedAt !== "number" ||
      !Number.isFinite(entry.unsubscribedAt))
  ) {
    return false
  }
  if (entry.lastError !== undefined && typeof entry.lastError !== "string") {
    return false
  }
  for (const header of ["listUnsubscribe", "listUnsubscribePost"] as const) {
    if (
      entry[header] !== undefined &&
      (typeof entry[header] !== "string" || entry[header].length === 0)
    ) {
      return false
    }
  }
  return true
}

/** Write-time sender validation (see the module doc: throws). */
function assertValidSender(sender: string, label: string): string {
  const key = subscriptionKey(sender)
  if (!key) {
    throw new Error(`${label}: sender must be a non-empty address`)
  }
  return key
}

/** Write-time timestamp validation (see the module doc: throws). */
function assertValidTimestamp(
  value: number | undefined,
  label: string,
  field: string
): number {
  // Every caller coalesces "absent" to now before this check, so an
  // undefined here is a caller bug — throw rather than leak `undefined`
  // into the stored entries (the fields are required `number`s).
  if (value === undefined) {
    throw new Error(`${label}: ${field} is required`)
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label}: ${field} must be a finite unix-seconds number`)
  }
  return value
}

// ---------------------------------------------------------------------------
// Read + persist over the per-account settings row (the splits pattern)
// ---------------------------------------------------------------------------

/** The account's valid entries, in stored order (callers sort). Corrupt
 * stored shapes are dropped, never thrown; a missing or unparseable row
 * means "none yet". */
async function loadEntries(
  executor: SqlExecutor,
  accountId: string
): Promise<SubscriptionEntry[]> {
  const stored = await getSetting<unknown>(
    executor,
    subscriptionsSettingKey(accountId),
    []
  )
  if (!Array.isArray(stored)) return []
  return stored.filter(isSubscriptionEntry)
}

/** Persist the whole array (internal). */
async function persistEntries(
  executor: SqlExecutor,
  accountId: string,
  entries: SubscriptionEntry[]
): Promise<void> {
  await setSetting(executor, subscriptionsSettingKey(accountId), entries)
}

export type SubscriptionSort = "lastSeen" | "sender"

/** The account's entries, newest interaction first by default (the
 * manager's review order); `sort: "sender"` is alphabetical. */
export async function listSubscriptions(
  executor: SqlExecutor,
  accountId: string,
  sort: SubscriptionSort = "lastSeen"
): Promise<SubscriptionEntry[]> {
  const entries = await loadEntries(executor, accountId)
  const sorted = [...entries]
  if (sort === "sender") {
    sorted.sort((a, b) => a.sender.localeCompare(b.sender))
  } else {
    sorted.sort(
      (a, b) => b.lastSeenAt - a.lastSeenAt || a.sender.localeCompare(b.sender)
    )
  }
  return sorted
}

/** One entry by sender address, or null when the sender is untracked. */
export async function getSubscription(
  executor: SqlExecutor,
  accountId: string,
  sender: string
): Promise<SubscriptionEntry | null> {
  const key = subscriptionKey(sender)
  if (!key) return null
  const entries = await loadEntries(executor, accountId)
  return entries.find((entry) => entry.sender === key) ?? null
}

// ---------------------------------------------------------------------------
// Transitions (the thin surface the ingestion hook and the bulk flow call)
// ---------------------------------------------------------------------------

/** The facts one newly seen message contributes to the sender's entry. */
export interface SenderSeenInput {
  sender: string
  /** Arrival of the just-seen mail, unix seconds (default: now). */
  lastSeenAt?: number
  /** The message's `List-Unsubscribe` header value, when it carried one. */
  listUnsubscribe?: string
  /** The message's `List-Unsubscribe-Post` header value, when present. */
  listUnsubscribePost?: string
}

/** The stored entry after the write. */
export async function recordSenderSeen(
  executor: SqlExecutor,
  accountId: string,
  input: SenderSeenInput
): Promise<SubscriptionEntry> {
  const key = assertValidSender(input.sender, "recordSenderSeen")
  const seenAt = assertValidTimestamp(
    input.lastSeenAt ?? Math.floor(Date.now() / 1000),
    "recordSenderSeen",
    "lastSeenAt"
  )
  const headerOf = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim()
    return trimmed ? trimmed : undefined
  }
  const listUnsubscribe = headerOf(input.listUnsubscribe)
  const listUnsubscribePost = headerOf(input.listUnsubscribePost)

  const entries = await loadEntries(executor, accountId)
  const index = entries.findIndex((entry) => entry.sender === key)
  if (index === -1) {
    const created: SubscriptionEntry = {
      sender: key,
      state: "subscribed",
      lastSeenAt: seenAt,
      ...(listUnsubscribe ? { listUnsubscribe } : {}),
      ...(listUnsubscribePost ? { listUnsubscribePost } : {}),
    }
    await persistEntries(executor, accountId, [...entries, created])
    return created
  }
  const previous = entries[index]!
  // The spec's resumed flip: mail from an unsubscribed sender means the
  // unsubscribe did not hold — surface it (lastSeenAt still refreshes).
  const next: SubscriptionEntry = {
    ...previous,
    lastSeenAt: Math.max(previous.lastSeenAt, seenAt),
    ...(previous.state === "unsubscribed" ? { state: "resumed" } : {}),
    ...(listUnsubscribe ? { listUnsubscribe } : {}),
    ...(listUnsubscribePost ? { listUnsubscribePost } : {}),
  }
  await persistEntries(
    executor,
    accountId,
    entries.map((entry, i) => (i === index ? next : entry))
  )
  return next
}

/** Transition to "unsubscribed" after a successful unsubscribe (live POST
 * resolved, or the replay op was queued — the queue owns a failed replay).
 * Clears any previous failure annotation. Unknown senders throw (the UI
 * can only act on listed rows — a stale-UI/programming error). */
export async function markUnsubscribed(
  executor: SqlExecutor,
  accountId: string,
  sender: string,
  options?: { at?: number }
): Promise<void> {
  const key = assertValidSender(sender, "markUnsubscribed")
  const at = assertValidTimestamp(
    options?.at ?? Math.floor(Date.now() / 1000),
    "markUnsubscribed",
    "at"
  )
  const entries = await loadEntries(executor, accountId)
  const index = entries.findIndex((entry) => entry.sender === key)
  if (index === -1) {
    throw new Error(`markUnsubscribed: sender ${key} is not tracked`)
  }
  const previous = entries[index]!
  const { lastError: _dropped, ...rest } = previous
  void _dropped
  await persistEntries(executor, accountId, [
    ...entries.slice(0, index),
    { ...rest, state: "unsubscribed", unsubscribedAt: at },
    ...entries.slice(index + 1),
  ])
}

/** Annotate a failed unsubscribe attempt (the bulk flow's inline
 * per-sender error state). The state is untouched — a failed request
 * leaves the user subscribed. Best-effort: a sender that vanished
 * mid-flight is a no-op so annotating never breaks the batch. */
export async function markUnsubscribeFailed(
  executor: SqlExecutor,
  accountId: string,
  sender: string,
  error: string
): Promise<void> {
  const key = assertValidSender(sender, "markUnsubscribeFailed")
  const entries = await loadEntries(executor, accountId)
  const index = entries.findIndex((entry) => entry.sender === key)
  if (index === -1) return
  await persistEntries(executor, accountId, [
    ...entries.slice(0, index),
    { ...entries[index]!, lastError: error },
    ...entries.slice(index + 1),
  ])
}

/** The explicit "sender resumed" flip (recordSenderSeen applies it
 * automatically on newly seen mail; this is for direct callers). Only an
 * "unsubscribed" entry becomes "resumed"; other states keep theirs (the
 * mail still refreshes lastSeenAt). Unknown senders throw. */
export async function markSenderResumed(
  executor: SqlExecutor,
  accountId: string,
  sender: string,
  options?: { at?: number }
): Promise<void> {
  const key = assertValidSender(sender, "markSenderResumed")
  const at = assertValidTimestamp(
    options?.at ?? Math.floor(Date.now() / 1000),
    "markSenderResumed",
    "at"
  )
  const entries = await loadEntries(executor, accountId)
  const index = entries.findIndex((entry) => entry.sender === key)
  if (index === -1) {
    throw new Error(`markSenderResumed: sender ${key} is not tracked`)
  }
  const previous = entries[index]!
  await persistEntries(executor, accountId, [
    ...entries.slice(0, index),
    {
      ...previous,
      lastSeenAt: Math.max(previous.lastSeenAt, at),
      ...(previous.state === "unsubscribed" ? { state: "resumed" } : {}),
    },
    ...entries.slice(index + 1),
  ])
}

/** Remove an entry (the spec's removal of entries). No-op when unknown. */
export async function removeEntry(
  executor: SqlExecutor,
  accountId: string,
  sender: string
): Promise<void> {
  const key = assertValidSender(sender, "removeEntry")
  const entries = await loadEntries(executor, accountId)
  await persistEntries(
    executor,
    accountId,
    entries.filter((entry) => entry.sender !== key)
  )
}
