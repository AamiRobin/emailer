import type { SqlExecutor } from "../db/executor"
import { getAccount } from "../db/accounts"
import type { Category } from "../categorization/classify"
import type { ContactRef, MessageInput } from "../db/messages"
import { parseContacts, serializeContacts } from "../db/messages"
import type { SenderStatPatch } from "../db/sender-stats"
import { upsertSenderStat } from "../db/sender-stats"
import type { ParsedQuery } from "../search/parser"
import { messageMatchesCriteria, parseRuleCriteria } from "./criteria"
import {
  applyRuleActions,
  parseActionsJson,
  SUPPRESSES_NOTIFICATION,
  type RuleAction,
  type RuleActionType,
} from "./actions"
import { cancelFollowUpsOnArrivals } from "../email-actions/followups"
import {
  archiveThread,
  markSpam,
  setThreadRead,
  trashThread,
} from "../email-actions/thread-actions"
import type {
  BlockedSenderAction,
  BlockedSenderRow,
} from "../db/blocked-senders"
import { listBlockedSenders } from "../db/blocked-senders"
import {
  listDeliverySchedules,
  resolveHoldFromSchedules,
  type DeliverySchedule,
} from "../settings/delivery-schedules"
import {
  classifyJunkText,
  shouldAutoMove,
  type JunkFilterConfig,
  type JunkVerdict,
} from "../security/junk-filter"
import { listEnabledRules, type RuleRow } from "./db"

/**
 * The post-insert ingestion hook (task 11.1/11.2, design D5).
 *
 * The sync engines persist messages, resolve threads, refresh thread
 * caches — then hand every NEWLY INSERTED message to runIngestionRules
 * BEFORE the summary's newMessages count is finalized. The hook runs the
 * account's enabled rules, in deterministic order, per message; each rule's
 * actions apply through the thread-actions service (local effect + queue
 * op — see rules/actions.ts) and the per-message outcome tells the engine
 * whether the message was RULED AWAY from the new-mail announcement
 * (archived / trashed / moved / marked read / marked spam). Because rules
 * run first, a
 * filter-ruled message never notifies: the scheduler forwards the count to
 * notifyNewMail only after the hook settles it. Additive actions (labels,
 * star) keep the message counted, and the engine's mute gate and
 * notification rules (task 8.1, D16) still apply around the outcome — mute
 * stays stronger than everything.
 *
 * ALL matching rules apply in order (Gmail filter semantics) — a later
 * rule can act on an already-ruled message (label then archive), and
 * suppression is derived from the FINAL applied set. An action failure is
 * isolated to its rule (warned, later rules still run) so one broken rule
 * cannot break a sync pass or the mail that follows it.
 *
 * The hook itself is provider-agnostic: the engines describe each arrival
 * as an IngestionEvent (below) and count from the returned outcomes.
 *
 * Delivery schedules (task 12.1, design D6) are the hook's SECOND consumer
 * ("one ingestion hook, two consumers", D5): after the rules loop, each
 * event is consulted against the account's delivery schedules
 * (settings/delivery-schedules.ts) and a match reports `heldUntil` — the
 * next window opening, in unix seconds. The engines apply it to the
 * event's thread via applyDeliveryHolds below; a held message is also
 * announcement-suppressed (held mail must not notify, consistent with
 * mute — the spec excludes held mail from the inbox and unread counts, and
 * a notification would defeat the hold). Like rules, schedules are
 * optional: with neither configured the hook returns untouched outcomes.
 *
 * Sender stats (task 13.1, design D7) are the THIRD consumer, riding the
 * same flow as a sibling step: the engines call recordSenderStats with the
 * account's own address after the hook, and every event with a sender
 * accumulates its sender_stats row (reply/direct/list signals + recency)
 * for the priority-inbox classifier (priority/classify.ts). Stats are
 * independent of rules and schedules — they record what arrived, never
 * what a rule did to it — so they run unconditionally and never touch the
 * outcomes.
 *
 * Follow-up reminders (task 14.2, design D8) are the FOURTH consumer, run
 * inside the hook itself (the engines' call sites stay untouched): before
 * the rules loop, every event whose sender is NOT the account's own
 * address cancels the pending followup_reminders on its thread — a
 * threaded reply arrived, so there is nothing left to chase. The
 * own-address skip protects the reminder a send just created from the
 * user's own sent-copy echo syncing back (the same rule recordSenderStats
 * applies; see email-actions/followups.ts).
 *
 * Blocked senders (task 18.2, mail-security "Block sender") are the FIFTH
 * consumer: each event's From address is checked against the account's
 * blocklist (db/blocked-senders.ts, lowercased-exact matching) and a hit
 * reports `blockedAction` on its outcome. Like the schedules, the hook
 * only COMPUTES — the engines call applyBlockedSenderFiling below, once
 * per hook run, which marks the thread read and trashes/archives it
 * through the SAME thread-actions path the rule actions use (local effect
 * + queue op), one filing per thread per run. A blocked message is
 * announcement-suppressed by its blockedAction alone (a blocked message
 * must not announce itself — like mute and the ruled-away/held cases), so
 * the engines' existing !suppressesNotification count gate already
 * excludes it; the mute and notification-rule gates around the outcome
 * keep applying unchanged.
 *
 * The local junk filter (task 18.10, design D19) is the SIXTH consumer:
 * when the caller passes a JunkFilterConfig (imap-sync preloads it once
 * per pass via loadJunkFilterConfig — IMAP account, per-account toggle
 * on; gmail-sync never passes one, which is the structural half of the
 * gmail exemption), every event that was NOT already ruled away /
 * blocked / held is classified against the preloaded token store, and an
 * event whose posterior clears the auto-move gate (high threshold AND a
 * sufficient training sample — see security/junk-filter.ts) reports
 * `junkVerdict`. As with the blocked senders, the hook only COMPUTES:
 * applyJunkFiling below performs the markSpam placement (imap junk-folder
 * move + queue op) once per thread per run, WITHOUT training — training
 * comes exclusively from the user's own mark-spam/not-spam actions (D19).
 * A junk verdict is announcement-suppressive (spammed mail never
 * notifies, same as a mark_as_spam rule). Lower posteriors deliver
 * normally, an untrained or opted-out account never sees a verdict, and
 * the classification is recoverable: the spam-placed thread shows the
 * mail-display "Not spam" affordance, whose action retrains the filter.
 *
 * Automatic categorization (task 3.3, design D4) is the SEVENTH consumer,
 * riding the same flow like sender stats: after runIngestionRules and the
 * apply/filing steps, the engines call categorizeIncomingMessages
 * (categorization/ingestion.ts) with one input per new event, which
 * classifies (user-rule category → list-header heuristics → sender
 * override read → default Primary) and writes threads.category KEEP-FIRST.
 * It must land BEFORE the engines finalize the new-mail count — that count
 * is what the scheduler forwards to notifyNewMail, so every category
 * exists before any notification fires. Like the stats it never touches
 * the outcomes or the count.
 */

/** One newly inserted message, described for rule matching. */
export interface IngestionEvent {
  /** messages.id of the inserted row. */
  messageRowId: string
  /** threads.id the message resolved to (rules act on the thread). */
  threadId: string
  fromAddress: string | null
  fromName: string | null
  /** Serialized to/cc/bcc contact JSON (the *_json columns' format). */
  toJson: string | null
  ccJson: string | null
  bccJson: string | null
  subject: string | null
  /** The message's date (unix seconds) — the stats' recency anchor. */
  date: number
  snippet: string | null
  /**
   * Label NAMES for label: matching — gmail: the message's label names
   * resolved through the labels table (state labels without a row are
   * skipped); imap: the folder path (the folder label's name).
   */
  labelNames: string[]
  /** The inserted message's read flag (`is:unread`). */
  isRead: boolean
  /** The inserted message's flagged flag (`is:starred`). */
  isStarred: boolean
  hasAttachments: boolean
  /**
   * The inserted message's size estimate in bytes (`larger:`/`smaller:`
   * criteria); null when the provider did not report one — a null
   * satisfies neither size operator.
   */
  sizeEstimate: number | null
  /**
   * Sender-stats flags (task 13.1, design D7) that only the engine can
   * know — both default false here and are stamped engine-side:
   * - threadHasUserMessage: the thread already carries a message from the
   *   account's own address (the user participates in the conversation —
   *   the D7 reply signal alongside a Re: subject). Computed by the
   *   engines AFTER the group's upserts, so a user message in the same
   *   batch counts too.
   * - isMailingList: the provider-side bulk signal. Gmail has no
   *   List-Id/Precedence on this surface, so it is the raw gmail tab
   *   labels (any CATEGORY_* except PERSONAL); the IMAP surface (Rust
   *   ImapMessage) exposes no headers either, so there it is the
   *   bracketed "[list-tag]" subject prefix many lists carry — a
   *   documented approximation of the header check D7 names.
   */
  threadHasUserMessage: boolean
  isMailingList: boolean
  /**
   * Categorization header subset (task 3.3, design D4), keyed by
   * lowercase header name — the parsed form of the stored messages.headers
   * JSON the MessageInput already carries (the engines' buildStoredHeaders:
   * list-unsubscribe/-post today; more when the provider surfaces expose
   * them). The categorization pass (categorization/ingestion.ts) classifies
   * from this record, so the classifier sees exactly the headers that were
   * persisted. Empty when the message carried none of the captured
   * headers.
   */
  headers: Record<string, string>
  /**
   * A user rule named a category for this message (task 3.4, design D4 —
   * the `set_category` action). NOT an engine input and not set by
   * ingestionEventFromInput: runIngestionRules STAMPS it when a matching
   * enabled rule carries a set_category action (first matching rule wins —
   * position order is the priority). The transport works because the
   * engines hand the SAME event objects to runIngestionRules and then to
   * categorizationInputFromEvent, so the stamp rides the objects into
   * categorizeIncomingMessages' classify call with zero engine changes.
   * Leave undefined otherwise (the header heuristics decide).
   */
  ruleCategory?: Category | null
}

/**
 * Build the event from the MessageInput the engine is about to store —
 * pure projection, so the engines add one call per created message.
 * `labelNames` is provider-resolved by the caller (see IngestionEvent);
 * the engine-only stats flags start false and are stamped by the engines;
 * `headers` is the MessageInput's stored headers JSON parsed back to its
 * record form (the categorization input — task 3.3, design D4).
 */
export function ingestionEventFromInput(
  input: MessageInput,
  labelNames: string[]
): IngestionEvent {
  const contacts = (refs: ContactRef[] | undefined): string | null =>
    serializeContacts(refs)
  return {
    messageRowId: input.id,
    threadId: input.threadId,
    fromAddress: input.fromAddress ?? null,
    fromName: input.fromName ?? null,
    toJson: contacts(input.to),
    ccJson: contacts(input.cc),
    bccJson: contacts(input.bcc),
    subject: input.subject ?? null,
    date: input.date,
    snippet: input.snippet ?? null,
    labelNames,
    isRead: input.isRead === true,
    isStarred: input.isFlagged === true,
    hasAttachments: input.hasAttachments === true,
    sizeEstimate: input.sizeEstimate ?? null,
    threadHasUserMessage: false,
    isMailingList: false,
    headers: storedHeadersRecord(input.headers),
  }
}

/**
 * Parse the MessageInput's stored headers JSON (the engines'
 * buildStoredHeaders output — a lowercase-keyed record) back into the
 * event's header record. Corrupt or unexpected shapes degrade to {} —
 * an unparseable capture must never break a sync pass. Exported for the
 * task 3.4 backfill, which reads the same stored capture for the thread's
 * newest message (categorization/backfill.ts).
 */
export function storedHeadersRecord(
  json: string | undefined
): Record<string, string> {
  if (!json) return {}
  try {
    const parsed: unknown = JSON.parse(json)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {}
    }
    const record: Record<string, string> = {}
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") record[name] = value
    }
    return record
  } catch {
    return {}
  }
}

/** What the hook reports per event; the engines count from this. */
export interface IngestionRuleOutcome {
  messageRowId: string
  threadId: string
  /** Action types applied by matching rules, in rule/action order. */
  appliedActions: RuleActionType[]
  /**
   * True when the applied actions rule the message away from the new-mail
   * count (archive/trash/move/mark_read/mark_as_spam — see
   * SUPPRESSES_NOTIFICATION), or when a delivery schedule HELD the message
   * (a held message must not notify — see the module comment).
   */
  suppressesNotification: boolean
  /**
   * Delivery-schedule hold (task 12.1, design D6): when a schedule matched
   * the message, the next window opening in unix seconds — the value the
   * engines write to threads.held_until via applyDeliveryHolds. Null when
   * no schedule matched (the common case; the hook stays free until the
   * engines actually apply a hold).
   */
  heldUntil: number | null
  /**
   * Sender-blocklist hit (task 18.2, the hook's FIFTH consumer): the
   * action chosen at block time for the message's From address — the
   * engines apply it via applyBlockedSenderFiling (mark read + trash/
   * archive the thread). Null when the sender is not blocked.
   */
  blockedAction: BlockedSenderAction | null
  /**
   * Junk-filter verdict (task 18.10, the hook's SIXTH consumer): the
   * posterior + training count when the message cleared the auto-move
   * gate — the engines apply it via applyJunkFiling (markSpam placement
   * WITHOUT training). Null when no config was passed (gmail, or an
   * engine that opted out), the filter is off/untrained, the message was
   * already ruled away/blocked/held, or the posterior stayed below the
   * gate (delivered normally).
   */
  junkVerdict: JunkVerdict | null
}

/**
 * Run the account's enabled rules over the pass's new messages, then
 * consult the delivery schedules per event. Returns one outcome per event,
 * in event order (empty appliedActions / null heldUntil when nothing
 * matched). `options` lets a caller that invokes the hook repeatedly
 * within one pass (the gmail engine, once per thread group) preload the
 * enabled rules, the account's delivery schedules and its sender
 * blocklist once — by default all three load here — and pin `now` for the
 * hold computation (tests; production uses the current clock, like the
 * other due-time services). `junk` (task 18.10) is the junk filter's
 * preloaded config: only imap-sync builds and passes one, so the hook
 * never classifies on the gmail path (D19's exemption is structural).
 */
export async function runIngestionRules(
  executor: SqlExecutor,
  accountId: string,
  events: readonly IngestionEvent[],
  options?: {
    rules?: RuleRow[]
    schedules?: DeliverySchedule[]
    /** Preloaded blocklist (the engines load it once per pass, like the
     * rules and schedules); loaded here when omitted. */
    blockedSenders?: BlockedSenderRow[]
    /** Preloaded junk-filter config (task 18.10, D19); absent = the
     * filter never runs (the gmail path — it must stay that way). */
    junk?: JunkFilterConfig
    now?: number
  }
): Promise<IngestionRuleOutcome[]> {
  const outcomes: IngestionRuleOutcome[] = events.map((event) => ({
    messageRowId: event.messageRowId,
    threadId: event.threadId,
    appliedActions: [],
    suppressesNotification: false,
    heldUntil: null,
    blockedAction: null,
    junkVerdict: null,
  }))
  if (events.length === 0) return outcomes
  const now = options?.now ?? Math.floor(Date.now() / 1000)

  // Follow-up reminders (task 14.2, D8): the hook's fourth consumer (see
  // the module comment). Runs BEFORE the rules/schedules early-return so
  // an account with neither configured still cancels reminders when a
  // threaded reply lands, and isolated like everything else here — a
  // cancellation failure must not break the sync pass.
  try {
    const account = await getAccount(executor, accountId)
    await cancelFollowUpsOnArrivals(
      executor,
      account?.email ?? null,
      events,
      now
    )
  } catch (error) {
    console.warn(
      "[rules] follow-up reminder cancellation failed; continuing",
      error
    )
  }

  const rules = options?.rules ?? (await listEnabledRules(executor, accountId))
  // The delivery-schedules consumer is independent of the rules consumer:
  // an account with zero rules still holds mail when it has schedules.
  const schedules =
    options?.schedules ?? (await listDeliverySchedules(executor, accountId))
  // The blocklist consumer is independent of both: an account with no
  // rules and no schedules still files mail from blocked senders.
  const blocked = new Map<string, BlockedSenderAction>()
  for (const row of options?.blockedSenders ??
    (await listBlockedSenders(executor, accountId))) {
    blocked.set(row.sender, row.action)
  }

  // Parsed criteria/actions cache per rule for the whole batch — the
  // per-message evaluation stays pure.
  const criteriaByRuleId = new Map<string, ParsedQuery | null>()
  const actionsByRuleId = new Map<string, RuleAction[]>()
  const byRowId = new Map(
    outcomes.map((outcome) => [outcome.messageRowId, outcome])
  )

  if (
    rules.length === 0 &&
    schedules.length === 0 &&
    blocked.size === 0 &&
    // The junk consumer (task 18.10) is independent of all three: an
    // account with no rules/schedules/blocklist still auto-junks when
    // its config was passed (and skipping the hook entirely is also how
    // the gmail path — no config — stays free).
    !options?.junk
  ) {
    return outcomes
  }

  // Junk filter (task 18.10, the SIXTH consumer — see the module
  // comment): with a config present, the batch's stored body texts load
  // once — classification reads subject + body_text and the event itself
  // carries only the snippet. Without a config (gmail path, toggle off,
  // or an opted-out engine) nothing is loaded and nothing classifies.
  const junk = options?.junk
  const bodyTextByRowId = new Map<string, string | null>()
  if (junk) {
    const ids = events.map((event) => event.messageRowId)
    const placeholders = ids.map((_, index) => `$${index + 1}`).join(", ")
    const rows = await executor.select<{
      id: string
      body_text: string | null
    }>(`SELECT id, body_text FROM messages WHERE id IN (${placeholders})`, [
      ...ids,
    ])
    for (const row of rows) bodyTextByRowId.set(row.id, row.body_text)
  }

  for (const event of events) {
    const outcome = byRowId.get(event.messageRowId)
    if (!outcome) continue // unreachable — outcomes were built from events
    // Blocked senders (task 18.2, the FIFTH consumer — see the module
    // comment): the hit only STAMPS the outcome here; the filing (mark
    // read + trash/archive through thread-actions) happens batched, once
    // per hook run, in applyBlockedSenderFiling below.
    if (event.fromAddress) {
      const hit = blocked.get(event.fromAddress.trim().toLowerCase())
      if (hit) outcome.blockedAction = hit
    }
    for (const rule of rules) {
      if (!criteriaByRuleId.has(rule.id)) {
        criteriaByRuleId.set(rule.id, parseRuleCriteria(rule.criteria_json))
        actionsByRuleId.set(rule.id, parseActionsJson(rule.actions_json))
      }
      const parsed = criteriaByRuleId.get(rule.id)
      if (!parsed || !messageMatchesCriteria(event, parsed)) continue
      const actions = actionsByRuleId.get(rule.id) ?? []
      // The set_category seam (task 3.4, design D4): a matching rule that
      // names a category stamps it on the event for the categorization
      // pass (see IngestionEvent.ruleCategory). FIRST matching rule wins —
      // position order is the priority, and the stamp is not overwritten
      // by later rules. Stamped BEFORE applyRuleActions so the category
      // survives even when one of the rule's delivery actions throws (the
      // hook isolates that failure per rule).
      if (event.ruleCategory == null) {
        const named = actions.find(
          (action) => action.type === "set_category" && action.category
        )
        if (named?.category) event.ruleCategory = named.category
      }
      try {
        const applied = await applyRuleActions(
          executor,
          accountId,
          event.threadId,
          actions
        )
        outcome.appliedActions.push(...applied)
      } catch (error) {
        // Isolated per rule (see the module comment): the sync pass and the
        // remaining rules continue; the partial local effects of the failed
        // rule stay applied (thread-actions mutates before enqueueing).
        console.warn(
          `[rules] rule "${rule.name}" (${rule.id}) failed on message ` +
            `${event.messageRowId}; continuing`,
          error
        )
      }
    }
    // Delivery schedules (D6): the FIRST matching schedule (position
    // order) sets the hold — computed after the rules loop so the outcome
    // reflects the message's final announced state either way. Held mail
    // is announcement-suppressed like ruled-away mail.
    if (schedules.length > 0) {
      outcome.heldUntil = resolveHoldFromSchedules(
        schedules,
        { senderAddress: event.fromAddress, labelNames: event.labelNames },
        now
      )
    }
    const ruledAway =
      outcome.blockedAction !== null ||
      outcome.heldUntil !== null ||
      outcome.appliedActions.some((type) =>
        SUPPRESSES_NOTIFICATION.includes(type)
      )
    // Local junk filter (task 18.10, the SIXTH consumer): only mail that
    // would otherwise DELIVER is classified — the filter arbitrates
    // deliveries, it never piles a spam placement on top of another
    // consumer's decision (a blocked/held/ruled message stays as ruled).
    // Isolated like the rules loop: a classification failure warns and
    // the message delivers normally.
    if (junk && !ruledAway) {
      try {
        const posterior = classifyJunkText(
          event.subject,
          bodyTextByRowId.get(event.messageRowId) ?? null,
          junk
        )
        if (shouldAutoMove(posterior, junk.spamDocuments)) {
          outcome.junkVerdict = {
            posterior,
            spamDocuments: junk.spamDocuments,
          }
        }
      } catch (error) {
        console.warn(
          `[rules] junk classification failed on message ` +
            `${event.messageRowId}; delivering normally`,
          error
        )
      }
    }
    outcome.suppressesNotification = ruledAway || outcome.junkVerdict !== null
  }
  return outcomes
}

/**
 * Apply the blocked-sender filings a hook run computed (task 18.2): per
 * blocked outcome, the thread is marked read and trashed/archived through
 * the SAME thread-actions functions the rule actions use (local effect +
 * queue op — a blocked message is filed exactly as if the user had acted
 * on it). One filing per thread per run (a thread receiving several
 * blocked messages, or blocked messages from two senders with different
 * actions, files once — the first outcome's action wins). Isolated per
 * thread like the rules loop: a filing failure warns and the sync pass
 * continues; the partial local effects stay applied (thread-actions
 * mutates before enqueueing). Engines call this once per hook run, right
 * after applyDeliveryHolds.
 */
export async function applyBlockedSenderFiling(
  executor: SqlExecutor,
  accountId: string,
  outcomes: readonly IngestionRuleOutcome[]
): Promise<void> {
  const filed = new Set<string>()
  for (const outcome of outcomes) {
    if (outcome.blockedAction === null) continue
    if (filed.has(outcome.threadId)) continue
    filed.add(outcome.threadId)
    try {
      // Spec: blocked mail is marked as read AND moved to Trash (or
      // archived per the block-time choice) — never announced.
      await setThreadRead(executor, accountId, outcome.threadId, true)
      if (outcome.blockedAction === "trash") {
        await trashThread(executor, accountId, outcome.threadId)
      } else {
        await archiveThread(executor, accountId, outcome.threadId)
      }
    } catch (error) {
      console.warn(
        `[rules] blocked-sender filing failed on thread ` +
          `${outcome.threadId}; continuing`,
        error
      )
    }
  }
}

/**
 * Apply the junk verdicts a hook run computed (task 18.10): per junked
 * outcome, the thread receives the markSpam placement — imap: the
 * messages move to the spam-role folder and the `move` op is queued;
 * exactly what a user mark-spam does, MINUS training (D19: training comes
 * exclusively from explicit user actions, so the filing passes
 * trainJunkFilter: false — an auto-move must never feed the model it
 * came from). One filing per thread per run (a thread receiving several
 * junked messages files once). Isolated per thread like the blocked
 * filing: a MissingSpecialFolderError (no spam-role folder) or any other
 * failure warns and the sync pass continues; the mail stays where it
 * arrived. Engines call this once per hook run, right after
 * applyBlockedSenderFiling.
 */
export async function applyJunkFiling(
  executor: SqlExecutor,
  accountId: string,
  outcomes: readonly IngestionRuleOutcome[]
): Promise<void> {
  const filed = new Set<string>()
  for (const outcome of outcomes) {
    if (outcome.junkVerdict === null) continue
    if (filed.has(outcome.threadId)) continue
    filed.add(outcome.threadId)
    try {
      await markSpam(executor, accountId, outcome.threadId, {
        trainJunkFilter: false,
      })
    } catch (error) {
      console.warn(
        `[rules] junk filing failed on thread ${outcome.threadId}; ` +
          "delivering in place",
        error
      )
    }
  }
}

/**
 * Apply the holds a hook run computed (task 12.1): one UPDATE per held
 * outcome setting threads.held_until. `AND held_until IS NULL` implements
 * the KEEP-FIRST-HOLD rule — a thread that is already held (an earlier
 * message in the batch, or an earlier sync) keeps its original window and
 * a new matching message neither moves it nor extends it; release is
 * exclusively the due pass's job (email-actions/holds.ts), which stamps
 * delivered_at so the whole batch tops the inbox together. Engines call
 * this once per hook run with the outcomes it returned.
 */
export async function applyDeliveryHolds(
  executor: SqlExecutor,
  outcomes: readonly IngestionRuleOutcome[]
): Promise<void> {
  for (const outcome of outcomes) {
    if (outcome.heldUntil === null) continue
    await executor.execute(
      "UPDATE threads SET held_until = $1 WHERE id = $2 AND held_until IS NULL",
      [outcome.heldUntil, outcome.threadId]
    )
  }
}

// ---------------------------------------------------------------------------
// Sender stats (task 13.1, design D7) — the hook flow's third consumer
// ---------------------------------------------------------------------------

/**
 * Derive one event's stat contribution (task 13.1, design D7). The
 * reply signal is "Re: subject OR the thread carries a message from the
 * account's own address" (the participation flag the engines stamped);
 * direct-to-me is the account's own address among the to/cc contacts;
 * the list flag arrives engine-side (see IngestionEvent.isMailingList).
 * The user's own addresses are the ACCOUNT's email for now — aliases
 * (task 16, design D10) will widen this to the account's alias set.
 */
function senderStatPatchFromEvent(
  event: IngestionEvent,
  accountEmail: string
): SenderStatPatch {
  const own = accountEmail.trim().toLowerCase()
  const includesOwn = (json: string | null): boolean =>
    own !== "" &&
    parseContacts(json).some(
      (contact) => (contact.email ?? "").toLowerCase() === own
    )
  return {
    isReply: /^re:/i.test(event.subject ?? "") || event.threadHasUserMessage,
    isDirectToMe: includesOwn(event.toJson) || includesOwn(event.ccJson),
    isMailingList: event.isMailingList,
    date: event.date,
  }
}

/**
 * Accumulate every event's sender into sender_stats — the priority
 * inbox's raw signal capture (task 13.1, D7). The engines call this in
 * the hook flow right after applyDeliveryHolds; it runs for every newly
 * inserted message with a From address regardless of rules/schedules
 * (stats describe what ARRIVED, not what a rule did to it) and never
 * touches the outcomes. Events without a From address are skipped, and
 * so are the account's OWN messages (synced Sent copies — the user is
 * not a "sender writing to them"; the stats table is an inbound-sender
 * model, so self rows would be pure noise).
 */
export async function recordSenderStats(
  executor: SqlExecutor,
  accountId: string,
  accountEmail: string,
  events: readonly IngestionEvent[]
): Promise<void> {
  const own = accountEmail.trim().toLowerCase()
  for (const event of events) {
    if (!event.fromAddress) continue
    if (event.fromAddress.trim().toLowerCase() === own) continue
    await upsertSenderStat(
      executor,
      accountId,
      event.fromAddress,
      senderStatPatchFromEvent(event, accountEmail)
    )
  }
}
