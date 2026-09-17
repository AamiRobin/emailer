import {
  isEmptyQuery,
  parseSearchQuery,
  type ParsedQuery,
} from "../search/parser"
import type { IngestionEvent } from "./ingestion"

/**
 * Rule criteria matching (task 11.2, design D5).
 *
 * Criteria reuse the SEARCH OPERATOR LANGUAGE — the same grammar the
 * search box takes, parsed by the same parseSearchQuery (search/parser.ts)
 * so there is one source of truth for the syntax. At INGESTION the
 * predicates are evaluated per message, in JS, against the freshly
 * inserted message (the event the sync engines hand the hook); task 11.4's
 * "apply now" runs the same language over stored messages through the SQL
 * query-builder instead. The two substrates share the parser, so a rule's
 * criteria read exactly like the search that would find the mail.
 *
 * Per-operator semantics (mirrors query-builder.ts, narrowed to ONE
 * message instead of "some message in the thread"):
 * - `from:` — substring (case-insensitive) of the From address OR the From
 *   display name.
 * - `to:` — substring of the serialized to/cc/bcc contact JSON (the same
 *   arrays query-builder LIKEs), so names and addresses both match.
 * - `subject:` — substring of the subject.
 * - `label:` — matches a label NAME exactly (case-insensitive) or as its
 *   trailing "/segment" leaf: `label:receipts` matches "Receipts" and
 *   "Finance/Receipts", not "Receipts/2024". Gmail: the message's label
 *   names resolved through the labels table; imap: the folder path (the
 *   folder label's name — one label per folder).
 * - `has:attachment` — the inserted message has attachment parts.
 * - `is:unread` — the inserted message is unread; `is:starred` — it is
 *   flagged.
 * - free text — each term is a substring of the subject OR the snippet.
 *
 * Combination semantics — the ONE deliberate divergence from search-box
 * behavior, kept rule-friendly and documented here: multiple values of the
 * SAME operator are OR-ed ("from:a@x from:b@x" = mail from either sender —
 * under search AND-semantics a single From can never satisfy both, which
 * would silently make such a rule dead), while DIFFERENT operators (and
 * each free-text term) are AND-ed. Criteria that parse to no predicate at
 * all (empty/bare `key:` tokens) match NOTHING — parseRuleCriteria returns
 * null so a criteria-less rule can never fire on every message.
 *
 * Criteria are evaluated against the message AS IT ARRIVED, before any
 * rule action runs — deterministic and order-independent (a mark_read rule
 * does not stop a later `is:unread` rule from matching the same message);
 * the notification suppression, by contrast, derives from the FINAL state
 * after all matching rules ran (see rules/ingestion.ts).
 */

/**
 * Parse a stored criteria_json value into the shared ParsedQuery AST.
 * Canonical storage is `{"query": "<raw query>"}` (rules/db.ts); a bare
 * JSON string is tolerated. Returns null (never throws) for anything
 * unusable — corrupt or criteria-less rules are skipped with a warning
 * rather than breaking ingestion.
 */
export function parseRuleCriteria(criteriaJson: string): ParsedQuery | null {
  let stored: unknown
  try {
    stored = JSON.parse(criteriaJson)
  } catch (error) {
    console.warn("[rules] criteria_json is not valid JSON; rule skipped", error)
    return null
  }
  const raw =
    typeof stored === "string"
      ? stored
      : typeof stored === "object" &&
          stored !== null &&
          typeof (stored as { query?: unknown }).query === "string"
        ? (stored as { query: string }).query
        : null
  if (raw === null) {
    console.warn('[rules] criteria_json must be {"query": "…"}; rule skipped')
    return null
  }
  const parsed = parseSearchQuery(raw)
  // No predicate at all → matches nothing (see the module comment): a
  // criteria-less rule must not fire on every message.
  return isEmptyQuery(parsed) ? null : parsed
}

/** Case-insensitive substring; null/undefined never matches. */
function containsIgnoreCase(
  haystack: string | null | undefined,
  needle: string
): boolean {
  if (!haystack) return false
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

/** Label leaf match — the exact convention of the search label: operator
 * (query-builder.ts) and the notification rules' matchesLabel. */
function matchesLabelName(ruleValue: string, labelName: string): boolean {
  const value = ruleValue.toLowerCase()
  const name = labelName.toLowerCase()
  return name === value || name.endsWith(`/${value}`)
}

/** An operator with no values is satisfied vacuously; otherwise ANY value
 * matching counts (the OR-within-operator rule). */
function anyOf(
  values: readonly string[],
  test: (value: string) => boolean
): boolean {
  return values.length === 0 || values.some(test)
}

/**
 * Evaluate one arrival event against parsed criteria. Same-operator values
 * OR, different operators AND (see the module comment). Pure — the hook
 * calls it per message × rule with no I/O.
 */
export function messageMatchesCriteria(
  event: IngestionEvent,
  parsed: ParsedQuery
): boolean {
  const fromHit = anyOf(
    parsed.from,
    (value) =>
      containsIgnoreCase(event.fromAddress, value) ||
      containsIgnoreCase(event.fromName, value)
  )
  if (!fromHit) return false
  const toHit = anyOf(
    parsed.to,
    (value) =>
      containsIgnoreCase(event.toJson, value) ||
      containsIgnoreCase(event.ccJson, value) ||
      containsIgnoreCase(event.bccJson, value)
  )
  if (!toHit) return false
  if (
    !anyOf(parsed.subject, (value) => containsIgnoreCase(event.subject, value))
  ) {
    return false
  }
  if (
    !anyOf(parsed.labels, (value) =>
      event.labelNames.some((name) => matchesLabelName(value, name))
    )
  ) {
    return false
  }
  if (parsed.hasAttachment && !event.hasAttachments) return false
  if (parsed.isUnread && event.isRead) return false
  if (parsed.isStarred && !event.isStarred) return false
  // Free-text terms are separate predicates: every term (AND) must appear
  // in the subject or the snippet.
  return parsed.freeText.every(
    (term) =>
      containsIgnoreCase(event.subject, term) ||
      containsIgnoreCase(event.snippet, term)
  )
}
