import type { SqlExecutor } from "../db/executor"
import type { Category, ClassifyResult } from "./classify"
import { classifyWithTier } from "./classify"
import { classifySenderWithAi, isCategorizationAssistEnabled } from "./assist"
import type { SenderCategory } from "./sender-categories"
import { getSenderCategories } from "./sender-categories"
import type { IngestionEvent } from "../rules/ingestion"

/**
 * The categorization consumer of the ingestion-hook flow (task 3.3,
 * design D4): for every NEWLY INSERTED message the sync engines hand over,
 * resolve the thread's inbox category and write it to `threads.category`.
 *
 * Resolution per message follows D4's order —
 *
 *   user rules (existing engine) → list-header heuristics →
 *   sender override lookup (READ) → AI assist (task 4.9; only when
 *   enabled, sender-cached) → default Primary
 *
 * concretely:
 * - `ruleCategory`: a user rule that named a category. Since task 3.4 the
 *   rules vocabulary HAS a category action (`set_category`,
 *   rules/actions.ts): runIngestionRules stamps the first matching rule's
 *   category onto the event (rules/ingestion.ts — the engines pass the
 *   same event objects to the hook and then here, so the stamp rides
 *   along with zero engine changes) and categorizationInputFromEvent
 *   projects it. Rule matching itself is NEVER re-implemented here (the
 *   rules hook already ran by the time the engines call this).
 * - the header heuristics + sender ranking run in classifyWithTier (pure —
 *   see its module comment for the full precedence); the tier tag is what
 *   makes the AI slot routable: ONLY tier-"default" messages — nothing
 *   above decided — are eligible for a provider opinion, so rule results
 *   take precedence by construction (spec "Rule engine wins").
 * - the sender override is a READ from sender_categories; the ONE write
 *   this pass makes is task 4.9's assist decision (source 'ai', written
 *   by classifySenderWithAi together with its ai_cache entry) — task 3.4's
 *   override UI and the backfill own every other write.
 * - the AI assist itself (assist.ts) owns its gate: when AI is
 *   unconfigured or the categorizationAssist toggle is off (the default),
 *   classifySenderWithAi returns null WITHOUT any provider call — the
 *   zero-call guarantee — and the rule engine alone populates the tabs
 *   (spec "AI assist off"). The gate is re-evaluated on EVERY pass; it is
 *   never memoized.
 * - unmatched mail classifies as 'primary' and is STORED as 'primary' —
 *   the spec's default is a real value, not an absence.
 *
 * Write semantics (the NULL contract documented at migration v9): the
 * UPDATE carries `AND category IS NULL`, so
 * - brand-new threads (category NULL) are always categorized;
 * - a thread that already carries a category — from an earlier pass or a
 *   per-thread user override (task 3.4) — KEEPS it. Re-categorizing on
 *   every arrival would fight the user's manual move, which the spec
 *   requires to be overridable per thread; keep-first is enforced by the
 *   SQL itself, including within one batch (the first message of a thread
 *   to land wins).
 *
 * Ordering guarantee (the spec's "runs during ingestion before
 * notifications"): the engines call this AFTER runIngestionRules and the
 * apply/filing steps, and BEFORE the new-mail count is finalized — the
 * count is what the scheduler forwards to notifyNewMail — so every
 * category exists before any notification can fire.
 *
 * Isolation like every consumer in this flow: a failure is caught per
 * message, warned about, and never breaks the sync pass; the affected
 * thread simply stays NULL (uncategorized) until the task 3.4 backfill.
 * The assist inherits this: a provider failure downgrades that sender to
 * its local default instead of failing the pass.
 */

/** One newly inserted message, described for categorization. */
export interface IncomingCategorizationInput {
  /** messages.id of the inserted row (actionable isolation warnings). */
  messageRowId: string
  /** threads.id the category is written to. */
  threadId: string
  senderEmail: string | null
  subject: string | null
  /**
   * Header subset keyed by lowercase header name — exactly the capture
   * persisted to messages.headers (the engines' buildStoredHeaders:
   * list-unsubscribe/-post today; more when the provider surfaces expose
   * them, without a change here).
   */
  headers: Record<string, string>
  /** A user rule named a category (the hook's set_category stamp — see
   * the module comment; the classifier ranks it above everything). */
  ruleCategory?: Category | null
}

/**
 * Project an ingestion event into the categorization input (the engines
 * call this per new message so the mapping lives in one place). The
 * event's `headers` record is the parsed messages.headers capture (see
 * ingestionEventFromInput); `ruleCategory` is the hook's set_category
 * stamp when a user rule named a category (task 3.4).
 */
export function categorizationInputFromEvent(
  event: IngestionEvent
): IncomingCategorizationInput {
  return {
    messageRowId: event.messageRowId,
    threadId: event.threadId,
    senderEmail: event.fromAddress,
    subject: event.subject,
    headers: event.headers,
    ruleCategory: event.ruleCategory ?? null,
  }
}

/** Most subject hints the prompt for one sender carries (assist.ts caps
 * it too; this keeps the dedupe map bounded first). */
const MAX_HINTS_PER_SENDER = 5

/**
 * Categorize a batch of new messages: one sender_categories lookup for
 * the whole batch (getSenderCategories), one pure classifyWithTier per
 * message, the AI assist (task 4.9) for the nothing-decided ones — at
 * most ONE provider call per sender per pass, via classifySenderWithAi's
 * own sender cache — then one keep-first UPDATE per message. Resolves
 * when every write settled — the engines await this before finalizing
 * the new-mail count.
 */
export async function categorizeIncomingMessages(
  executor: SqlExecutor,
  messages: readonly IncomingCategorizationInput[]
): Promise<void> {
  if (messages.length === 0) return

  // The sender override lookup (D4 step three) — one batched read for the
  // pass; the assist may ADD a source-'ai' row later (task 4.9).
  let overrides = new Map<string, SenderCategory>()
  try {
    overrides = await getSenderCategories(
      executor,
      messages.map((message) => message.senderEmail)
    )
  } catch (error) {
    // A failed lookup degrades to header-only classification — the pass
    // continues, user overrides simply do not apply this once.
    console.warn(
      "[categorization] sender override lookup failed; classifying on " +
        "heuristics only",
      error
    )
  }

  // Pass 1 — local classification with provenance (pure, no I/O): the
  // tier tag tells decided from nothing-decided messages.
  const classified: { message: IncomingCategorizationInput; result: ClassifyResult }[] =
    []
  for (const message of messages) {
    try {
      const key = message.senderEmail?.trim().toLowerCase() ?? ""
      const senderOverride = key === "" ? undefined : overrides.get(key)
      classified.push({
        message,
        result: classifyWithTier({
          senderEmail: message.senderEmail,
          subject: message.subject,
          headers: message.headers,
          ruleCategory: message.ruleCategory,
          senderOverride: senderOverride ?? null,
        }),
      })
    } catch (error) {
      console.warn(
        `[categorization] failed on message ${message.messageRowId} ` +
          `(thread ${message.threadId}); leaving it uncategorized`,
        error
      )
    }
  }

  // Pass 2 — AI assist (task 4.9, design D4): only tier-"default"
  // messages are candidates (everything a rule, user decision, header
  // heuristic, learned sender row or subject tag decided is FINAL —
  // rule results take precedence, spec "Rule engine wins"). Candidates
  // dedupe per sender: one consultation per new sender per pass, the
  // triggering messages' subjects riding along as metadata-only hints.
  // The gate is re-read on every pass (never memoized); when closed —
  // AI unconfigured or the categorizationAssist toggle off, its default
  // — no sender is ever consulted and classifySenderWithAi would return
  // null without a provider call anyway (zero-call guarantee, spec
  // "AI assist off").
  let assistEnabled = false
  try {
    assistEnabled = await isCategorizationAssistEnabled(executor)
  } catch (error) {
    // A settings read failure fails toward off — no assist this pass.
    console.warn(
      "[categorization] assist gate read failed; skipping AI assist",
      error
    )
  }

  const aiCategories = new Map<string, Category>()
  if (assistEnabled) {
    const pending = new Map<string, { sender: string; hints: string[] }>()
    for (const { message, result } of classified) {
      if (result.tier !== "default") continue
      const senderKey = message.senderEmail?.trim().toLowerCase() ?? ""
      if (senderKey === "") continue // no sender to classify or cache by
      const hint = message.subject?.trim() ?? ""
      const entry = pending.get(senderKey)
      if (entry) {
        if (hint !== "" && entry.hints.length < MAX_HINTS_PER_SENDER) {
          entry.hints.push(hint)
        }
      } else {
        pending.set(senderKey, {
          sender: senderKey,
          hints: hint === "" ? [] : [hint],
        })
      }
    }

    for (const [senderKey, entry] of pending) {
      try {
        const category = await classifySenderWithAi(
          executor,
          entry.sender,
          entry.hints
        )
        // A non-null result overrides the default tier for this
        // message's sender; null (gate, failure, garbage) keeps primary.
        if (category) aiCategories.set(senderKey, category)
      } catch (error) {
        // classifySenderWithAi catches its own failures; this net keeps
        // the never-break-the-pass guarantee airtight.
        console.warn(
          `[categorization] AI assist failed for ${senderKey}; keeping ` +
            "the local default",
          error
        )
      }
    }
  }

  // Pass 3 — the keep-first writes (see the module comment): decided
  // tiers keep their category; a default-tier message takes its sender's
  // AI verdict when the consult produced one, primary otherwise.
  for (const { message, result } of classified) {
    try {
      const senderKey = message.senderEmail?.trim().toLowerCase() ?? ""
      const aiCategory =
        result.tier === "default" && senderKey !== ""
          ? aiCategories.get(senderKey)
          : undefined
      const category = aiCategory ?? result.category
      await executor.execute(
        "UPDATE threads SET category = $1 WHERE id = $2 AND category IS NULL",
        [category, message.threadId]
      )
    } catch (error) {
      console.warn(
        `[categorization] failed on message ${message.messageRowId} ` +
          `(thread ${message.threadId}); leaving it uncategorized`,
        error
      )
    }
  }
}
