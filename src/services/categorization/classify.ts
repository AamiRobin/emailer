/**
 * The local rule-engine classifier for inbox categories (task 3.3, design
 * D4, mail-organization spec "Automatic categorization").
 *
 * PURE — no database, no I/O. The ingestion caller
 * (categorization/ingestion.ts) resolves the DB-backed inputs (user-rule
 * category, sender override row) and passes them in; the heuristics here
 * read only the plain input struct, so every rule is unit-testable in
 * isolation and the backfill job (task 3.4) reuses the exact same
 * classification.
 *
 * Precedence (D4's ingestion order, adapted where the spec demands it):
 *
 *   1. `ruleCategory` — a USER RULE that named a category (the caller
 *      resolves it through the existing rules engine; this module never
 *      re-implements rule matching).
 *   2. `senderOverride` with source "user" — an explicit "always from
 *      sender" choice (task 3.4 writes these). The spec says user
 *      overrides "feed back as the rule for that sender", so they rank
 *      WITH the user rules, above the heuristics — overriding a
 *      List-Id-carrying newsletter sender to Promotions must stick.
 *   3. List headers: `List-Id` or `List-Unsubscribe` → newsletters.
 *   4. Auto-generated markers: `Auto-Submitted` (any value but "no",
 *      RFC 5064) or `Precedence: bulk|list|bulk_mail` → updates. A
 *      no-reply local part ("noreply@", "donotreply@", …) joins this
 *      tier — the same deterministic machine-sender signal.
 *   5. `senderOverride` with source "heuristic"/"ai" — learned rows are
 *      fallbacks BELOW the direct header evidence (D4 puts the sender
 *      override lookup after the header heuristics).
 *   6. A bracketed "[list-tag]" subject prefix → newsletters — the
 *      documented IMAP-surface approximation of the list check (the same
 *      regex IngestionEvent.isMailingList uses; the Rust ImapMessage wire
 *      exposes no list headers beyond List-Unsubscribe today).
 *   7. Default: primary ("unmatched mail defaults to Primary").
 *
 * promotions / social have no deterministic local heuristic in scope (the
 * spec names only list/auto-generated markers); they are reachable through
 * user rules (1), user overrides (2), or learned overrides (5) and
 * otherwise fall through to primary.
 *
 * Task 4.9 (design D4) slots the AI assist between the local tiers and
 * the default: only messages `classifyWithTier` reports as tier
 * "default" — nothing above decided — are eligible for a provider
 * opinion. `classifyMessage` remains the total category-only view so
 * every existing caller and test keeps its pinned signature.
 */

/** The five inbox categories, in the storage/tab order (task 3.5). */
export type Category =
  | "primary"
  | "updates"
  | "promotions"
  | "social"
  | "newsletters"

export const CATEGORIES: readonly Category[] = [
  "primary",
  "updates",
  "promotions",
  "social",
  "newsletters",
]

/** Who decided a sender_categories row (migration v9 CHECK set). */
export type SenderCategorySource = "user" | "heuristic" | "ai"

/**
 * WHICH precedence tier decided a message (task 4.9): the tags the
 * classifier hands back alongside the category so callers can tell a
 * real decision from the fall-through. The AI assist consumes exactly
 * one of these — "default", the nothing-decided tier — and must never
 * fire on any other (rule results take precedence; spec "Rule engine
 * wins"). A learned row that says 'primary' is still tier
 * "learned-override", not "default": somebody decided, so no re-ask.
 */
export type ClassifyTier =
  | "rule" // 1. a user rule named the category
  | "user-override" // 2. the user's "always from sender" choice
  | "list-header" // 3. List-Id / List-Unsubscribe
  | "auto-generated" // 4. Auto-Submitted / bulk Precedence / no-reply
  | "learned-override" // 5. a heuristic/ai sender_categories row
  | "subject-tag" // 6. the "[list-tag]" subject approximation
  | "default" // 7. nothing decided — the AI-assist-eligible slot

/** The classifier's verdict with its provenance (see ClassifyTier). */
export interface ClassifyResult {
  category: Category
  tier: ClassifyTier
}

/**
 * Tolerant parse of a stored category value (threads.category or a
 * sender_categories.category read back); anything outside the closed set
 * — NULL included — parses to null so callers fall through to their own
 * default instead of propagating a corrupt value.
 */
export function parseCategory(value: string | null | undefined): Category | null {
  return (CATEGORIES as readonly string[]).includes(value ?? "")
    ? (value as Category)
    : null
}

/** Classifier input — plain data the caller gathered for one message. */
export interface ClassifyMessageInput {
  /** The From address (unused by today's heuristics beyond the no-reply
   * local part; the parameter keeps the input shape stable for future
   * deterministic sender rules). */
  senderEmail?: string | null
  subject?: string | null
  /**
   * Header subset keyed by LOWERCASE header name (the stored
   * messages.headers convention — see the engines' buildStoredHeaders).
   * Unknown names are ignored, so passing a broader capture later never
   * changes today's verdicts.
   */
  headers?: Record<string, string>
  /** A user rule named a category for this message (caller-resolved —
   * see the module comment; the `set_category` rules action feeds this
   * through the hook's event stamp, task 3.4). */
  ruleCategory?: Category | null
  /** The sender's sender_categories row, if any (the caller does the DB
   * read — the classifier stays pure). */
  senderOverride?: { category: Category; source: SenderCategorySource } | null
}

/** Case-insensitive first-value header lookup over the lowercase-keyed
 * record (tolerates a caller that did not normalize its keys). */
function headerValue(
  headers: Record<string, string>,
  name: string
): string | null {
  const exact = headers[name]
  if (exact !== undefined) return exact
  const lowered = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowered) return value
  }
  return null
}

/** The local part of an address, lowercased ("NoReply@x.com" → "noreply"). */
function localPart(senderEmail: string | null | undefined): string {
  const address = (senderEmail ?? "").trim().toLowerCase()
  const at = address.indexOf("@")
  return at === -1 ? address : address.slice(0, at)
}

/** Deterministic no-reply local parts, compared with the separators
 * (dots/underscores/hyphens) stripped so "no-reply", "no.reply" and
 * "no_reply" all collapse to "noreply". */
const NO_REPLY_LOCAL_PARTS: readonly string[] = [
  "noreply",
  "donotreply",
  "donotreplyhere",
  "donotreplytothisemail",
]

function isNoReplySender(senderEmail: string | null | undefined): boolean {
  const stripped = localPart(senderEmail).replace(/[._-]/g, "")
  return NO_REPLY_LOCAL_PARTS.includes(stripped)
}

/** Precedence values that mark bulk/list mail (the classic mailing-list
 * trio; "junk"/"first-class"/"special-delivery" etc. are left alone). */
const BULK_PRECEDENCE: readonly string[] = ["bulk", "list", "bulk_mail"]

/**
 * Classify one message, reporting WHICH tier decided (task 4.9). Same
 * total, synchronous precedence as `classifyMessage` — every branch ends
 * in a concrete category — plus the provenance tag the ingestion pass
 * needs to route only nothing-decided messages to the AI assist.
 */
export function classifyWithTier(input: ClassifyMessageInput): ClassifyResult {
  // 1. A user rule named the category — nothing overrides it.
  if (input.ruleCategory) {
    return { category: input.ruleCategory, tier: "rule" }
  }
  // 2. The user's "always from sender" override ranks with the user
  // rules (see the module comment — the spec's "feed back as the rule").
  if (input.senderOverride?.source === "user") {
    return { category: input.senderOverride.category, tier: "user-override" }
  }

  const headers = input.headers ?? {}
  // 3. List headers → newsletters (List-Id first: it beats the bulk
  // markers below — a digest carrying both stays a newsletter).
  const listId = headerValue(headers, "list-id")
  if (listId !== null && listId.trim() !== "") {
    return { category: "newsletters", tier: "list-header" }
  }
  const listUnsubscribe = headerValue(headers, "list-unsubscribe")
  if (listUnsubscribe !== null && listUnsubscribe.trim() !== "") {
    return { category: "newsletters", tier: "list-header" }
  }
  // 4. Auto-generated markers → updates. Auto-Submitted: any value other
  // than "no" (RFC 5064 — "no" is the explicit user-generated mark; an
  // empty value carries no verdict). Precedence: the bulk/list trio.
  const autoSubmitted = headerValue(headers, "auto-submitted")
  if (autoSubmitted !== null) {
    const value = autoSubmitted.trim().toLowerCase()
    if (value !== "" && value !== "no") {
      return { category: "updates", tier: "auto-generated" }
    }
  }
  const precedence = headerValue(headers, "precedence")
  if (precedence !== null) {
    if (BULK_PRECEDENCE.includes(precedence.trim().toLowerCase())) {
      return { category: "updates", tier: "auto-generated" }
    }
  }
  if (isNoReplySender(input.senderEmail)) {
    return { category: "updates", tier: "auto-generated" }
  }
  // 5. Learned (heuristic/ai) sender rows: fallbacks below the direct
  // evidence — D4 puts the sender override lookup after the heuristics.
  // A learned 'primary' still counts as decided (no AI re-ask).
  if (input.senderOverride) {
    return { category: input.senderOverride.category, tier: "learned-override" }
  }
  // 6. The IMAP surface's subject-tag approximation of the list check
  // (same regex the engines stamp isMailingList from — a documented
  // approximation; see IngestionEvent.isMailingList).
  if (/^\[[^\]]+\]/.test(input.subject ?? "")) {
    return { category: "newsletters", tier: "subject-tag" }
  }
  // 7. Default — the only tier the AI assist may override (task 4.9).
  return { category: "primary", tier: "default" }
}

/**
 * Classify one message. Total and synchronous — every branch ends in a
 * concrete category, `primary` being the default (the spec's "unmatched
 * mail defaults to Primary"). The category-only view of
 * `classifyWithTier` (signature pinned — existing callers and tests).
 */
export function classifyMessage(input: ClassifyMessageInput): Category {
  return classifyWithTier(input).category
}
