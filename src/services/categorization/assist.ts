import type { SqlExecutor } from "../db/executor"

import type { Category } from "./classify"
import { CATEGORIES, parseCategory } from "./classify"
import { senderCategoryKey, setSenderCategory } from "./sender-categories"
import { getAiCache, putAiCache } from "../ai/cache"
import { aiChat, resolveSurfaceRuntime } from "../ai/client"
import { isAiConfigured, isSurfaceEnabled } from "../ai/settings"

/**
 * AI categorization assist (task 4.9, design D4, ai-assistance spec
 * "Categorization assist"): the SENDER-level classifier the ingestion
 * pass consults for messages its rule engine could not confidently
 * categorize — the slot `classifyWithTier` reports as tier "default"
 * (after every local tier, before the fall-through to primary).
 *
 * Contract:
 * - Opt-in and re-checked EVERY time: the gate below reads the live
 *   settings row (`categorizationAssist` toggle, default OFF — task 4.2)
 *   and is never memoized across calls or passes, so flipping the toggle
 *   takes effect on the next arriving message.
 * - ZERO provider calls when the gate is closed (spec "AI assist off"):
 *   the early return happens BEFORE any `aiChat` invocation — a disabled
 *   or unconfigured assist makes provably no request.
 * - Sender-cached (design D2): results persist under ai_cache kind
 *   "categorize-sender" with input = the sender address, AND in
 *   `sender_categories` with source 'ai' — the row the classifier's
 *   learned-override tier already reads, so the decision keeps applying
 *   to future mail even if assist is later disabled.
 * - Consent boundary (spec "AI consent and data boundaries"): the prompt
 *   carries ONLY "the metadata needed to classify an arriving message" —
 *   the sender address plus a few subject lines. Message bodies never
 *   enter this module: there is no parameter, read, or prompt path for
 *   them.
 * - Never breaks ingestion: every failure (provider error, unavailable,
 *   unparseable reply, cache trouble) degrades to null — the caller keeps
 *   its local default (primary) and the sync pass completes.
 */

/** The AI surface id this feature runs under — the settings toggle key;
 * client.ts maps it to the wire name "categorization-assist", which the
 * Rust rate limiter buckets at 30/min. */
const ASSIST_SURFACE = "categorizationAssist"

/** The ai_cache kind for sender classifications (task 4.3 conventions —
 * the key hashes provider|model|kind|input with input = the sender). */
const CACHE_KIND = "categorize-sender"

/** A bare-id reply fits in a handful of tokens; the tight cap keeps a
 * confused provider from burning context (a truncated reply parses as
 * garbage → null, which is the safe direction). */
const MAX_REPLY_TOKENS = 16

/** Subject lines carried into one prompt (metadata-only hints; capped to
 * keep the request small no matter how many messages triggered it). */
const MAX_HINTS = 5

/**
 * The strict system prompt: exactly one category id out, nothing else.
 * The category definitions mirror the heuristics' intent (updates for
 * machine/transactional mail, newsletters for lists) so the model and
 * the local rules agree on vocabulary.
 */
const SYSTEM_PROMPT = [
  "You classify an email sender into one inbox category.",
  "Reply with EXACTLY one word — the category id — and nothing else:",
  "no quotes, no punctuation, no explanation.",
  "The category ids and what they mean:",
  ...CATEGORIES.map((id) => `- ${id}`),
  "",
  "Meanings:",
  "- primary: personal or conversational mail from a real person",
  "- updates: transactional or automated notices (receipts, confirmations, alerts, statements)",
  "- promotions: marketing, advertising, deals, offers",
  "- social: social-network or community notifications and activity",
  "- newsletters: mailing lists, subscriptions, and recurring publications",
].join("\n")

/** The user turn: the sender plus the triggering messages' subjects —
 * metadata only (see the module comment's consent boundary). */
function buildSenderPrompt(
  sender: string,
  subjectHints: readonly string[]
): string {
  const hints = [
    ...new Set(
      subjectHints
        .map((hint) => hint.trim())
        .filter((hint) => hint !== "")
    ),
  ].slice(0, MAX_HINTS)
  const lines = [`Sender address: ${sender}`]
  if (hints.length > 0) {
    lines.push("Recent subject lines from this sender:")
    for (const hint of hints) lines.push(`- ${hint}`)
  }
  lines.push("Which category id? Reply with the bare id.")
  return lines.join("\n")
}

/**
 * Tolerant read of the model's reply: the first non-empty line, trimmed,
 * lowercased, stripped of wrapping quotes and any trailing run of quotes
 * or periods (`"Newsletters".` → newsletters) — then validated against
 * the category union by parseCategory. Anything else is garbage and
 * becomes null.
 */
function parseReply(reply: string): Category | null {
  const firstLine =
    reply
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? ""
  const cleaned = firstLine
    .replace(/^["'`]+/, "")
    .replace(/(?:["'`]|\.)+$/, "")
    .trim()
    .toLowerCase()
  return parseCategory(cleaned)
}

/**
 * Whether the assist may run at all: AI configured (master switch + an
 * eligible active provider) AND the categorizationAssist toggle on. Read
 * fresh on every call — the ingestion pass re-evaluates this each time
 * so a mid-session toggle flip is honored on the next pass (never
 * memoized). Exported so the ingestion pass can skip its per-sender loop
 * entirely when closed; `classifySenderWithAi` re-checks it anyway, so
 * direct callers are gated too.
 */
export async function isCategorizationAssistEnabled(
  executor: SqlExecutor
): Promise<boolean> {
  return (
    (await isAiConfigured(executor)) &&
    (await isSurfaceEnabled(executor, ASSIST_SURFACE))
  )
}

/**
 * The gate + surface-runtime resolution in one fail-toward-off step:
 * null means "no assist" — gate closed (the zero-call guarantee: the
 * caller must not invoke the provider) OR a failed settings read (never
 * an error out of here). `runtime.model` is the tier-resolved id
 * (task 2.2): the cache identity and the request below both use it.
 */
async function resolveAssistRuntime(executor: SqlExecutor) {
  try {
    if (!(await isCategorizationAssistEnabled(executor))) return null
    // Unreachable when the gate passed (isAiConfigured reads the same
    // state); kept as the fail-toward-off guard.
    return await resolveSurfaceRuntime(executor, ASSIST_SURFACE)
  } catch (error) {
    console.warn(
      "[categorization] assist gate read failed; treating assist as disabled",
      error
    )
    return null
  }
}

/**
 * Classify one SENDER with the active AI provider (task 4.9): cache read
 * → provider call → validate → cache + sender_categories write. Returns
 * the category, or null when the gate is closed (no call made), the
 * sender is empty, the provider fails or replies garbage — null always
 * means "no AI opinion; keep the local default".
 *
 * `subjectHints` are the triggering messages' subject lines (optional;
 * metadata-only prompt material — never bodies).
 */
export async function classifySenderWithAi(
  executor: SqlExecutor,
  senderEmail: string,
  subjectHints: readonly string[] = []
): Promise<Category | null> {
  // Canonical key (trimmed/lowercased) — the same identity the
  // sender_categories row and the cache input use. Empty → no sender to
  // classify by or cache under.
  const sender = senderCategoryKey(senderEmail)
  if (!sender) return null

  // (a) The gate — the zero-call guarantee. When this is closed the
  // function returns without ANY aiChat invocation: a disabled assist
  // provably makes zero provider calls (spec "AI assist off"; the
  // assertion in assist.test.ts pins the client mock untouched).
  const runtime = await resolveAssistRuntime(executor)
  if (!runtime) return null

  // The model is the tier-resolved id (task 2.2), so a tier-model
  // switch invalidates cached classifications like any other key part.
  const cacheIdentity = {
    provider: runtime.provider,
    model: runtime.model,
    kind: CACHE_KIND,
    input: sender,
  }

  // (b) The sender cache (design D2): repeat mail from the same sender
  // is never re-classified. A stored value that no longer parses is
  // treated as a miss (corrupt rows must not poison the category), and
  // the fresh decision below overwrites the row.
  let cached: string | null = null
  try {
    cached = await getAiCache(executor, cacheIdentity)
  } catch (error) {
    // A failed cache read is a miss, not an error — the pass continues.
    console.warn(
      `[categorization] AI cache read failed for ${sender}; treating as a miss`,
      error
    )
  }
  const cachedCategory = parseCategory(cached)
  if (cachedCategory) return cachedCategory

  // (c) The provider call — strict prompt, metadata only (module
  // comment). AiProviderError / AiUnavailableError and anything
  // unexpected land in the same net: warn + null, the ingestion pass
  // must complete.
  let reply: string
  try {
    reply = await aiChat({
      // The exact model the cache identity above was built from (one
      // resolution for identity and request, task 2.2).
      model: runtime.model,
      system: SYSTEM_PROMPT,
      messages: [
        { role: "user", content: buildSenderPrompt(sender, subjectHints) },
      ],
      maxTokens: MAX_REPLY_TOKENS,
      surface: ASSIST_SURFACE,
    })
  } catch (error) {
    console.warn(
      `[categorization] AI assist failed for ${sender}; keeping the local default`,
      error
    )
    return null
  }

  // (d) Parse + validate against the category union — garbage → null
  // (and nothing is cached, so a later attempt can re-ask).
  const category = parseReply(reply)
  if (!category) {
    console.warn(
      `[categorization] AI assist returned no valid category for ${sender} ` +
        `(got ${JSON.stringify(reply.slice(0, 80))}); keeping the local default`
    )
    return null
  }

  // (e) Persist BOTH caches: the ai_cache row (per model/provider, the
  // reuse cache) and the sender_categories row with source 'ai' — the
  // classifier's learned-override tier reads that row on every future
  // arrival, with or without assist enabled. Best-effort: a persistence
  // failure warns; the decision already paid for still applies to the
  // triggering message.
  try {
    await putAiCache(executor, { ...cacheIdentity, output: category })
    await setSenderCategory(executor, sender, category, "ai")
  } catch (error) {
    console.warn(
      `[categorization] caching the AI category for ${sender} failed; ` +
        "this message still uses it",
      error
    )
  }
  return category
}
