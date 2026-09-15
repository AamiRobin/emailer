/**
 * Gmail-style search query parser (pure — no SQL, no I/O).
 *
 * Grammar:
 * - Input is split into whitespace-separated tokens. Double quotes group a
 *   run containing spaces into a single token value (`from:"Alice Smith"`,
 *   `"annual report"`); the quotes themselves are dropped. There is no
 *   escape character — an unmatched quote simply runs to the end of input.
 * - A token shaped `key:value` (first colon splits; the key is matched
 *   case-insensitively) is an operator:
 *   - `from:` / `to:` / `subject:` / `label:` — value operators; the token's
 *     remaining text (quotes stripped) is the value. Repeated occurrences
 *     accumulate and are AND-ed.
 *   - `has:attachment` — flag, value recognized case-insensitively.
 *   - `is:unread` / `is:starred` — flags, values recognized
 *     case-insensitively. No other `is:`/`has:` values exist.
 *   - An operator with an empty value (`from:`, `from:""`) is dropped: the
 *     user clearly attempted an operator, and an empty needle would either
 *     match everything (LIKE) or be FTS5 syntax noise.
 * - Anything else is a free-text term — including tokens with a colon that
 *   do not resolve to a known operator or value (`foo:bar`, `is:read`,
 *   `has:file` are searched as the literal text they spell). Keeping them
 *   (rather than silently discarding) preserves the user's input in the
 *   result set instead of broadening the query to the remaining terms.
 * - Every operator and every free-text term is AND-ed with the others.
 */

export interface ParsedQuery {
  /** `from:<value>` values; each matches from_address OR from_name. */
  from: string[]
  /** `to:<value>` values; each is matched against to/cc/bcc recipients. */
  to: string[]
  /** `subject:<value>` values; each is matched against message subjects. */
  subject: string[]
  /** `label:<name>` values; each names a label of the account. */
  labels: string[]
  /** `has:attachment` present. */
  hasAttachment: boolean
  /** `is:unread` present. */
  isUnread: boolean
  /** `is:starred` present. */
  isStarred: boolean
  /** Free-text terms (quoted phrases kept as one term), all AND-ed. */
  freeText: string[]
}

/** True when the query contributes no predicate at all. */
export function isEmptyQuery(parsed: ParsedQuery): boolean {
  return (
    !parsed.from.length &&
    !parsed.to.length &&
    !parsed.subject.length &&
    !parsed.labels.length &&
    !parsed.hasAttachment &&
    !parsed.isUnread &&
    !parsed.isStarred &&
    !parsed.freeText.length
  )
}

/** Parse a raw search input into structured, AND-combinable predicates. */
export function parseSearchQuery(input: string): ParsedQuery {
  const parsed: ParsedQuery = {
    from: [],
    to: [],
    subject: [],
    labels: [],
    hasAttachment: false,
    isUnread: false,
    isStarred: false,
    freeText: [],
  }

  for (const token of tokenize(input)) {
    const colon = token.indexOf(":")
    if (colon < 0) {
      parsed.freeText.push(token)
      continue
    }
    const key = token.slice(0, colon).toLowerCase()
    const value = token.slice(colon + 1)
    if (!value.length) continue // bare `key:` — dropped (see module docs)
    switch (key) {
      case "from":
        parsed.from.push(value)
        break
      case "to":
        parsed.to.push(value)
        break
      case "subject":
        parsed.subject.push(value)
        break
      case "label":
        parsed.labels.push(value)
        break
      case "has":
        if (value.toLowerCase() === "attachment") parsed.hasAttachment = true
        else parsed.freeText.push(token)
        break
      case "is":
        if (value.toLowerCase() === "unread") parsed.isUnread = true
        else if (value.toLowerCase() === "starred") parsed.isStarred = true
        else parsed.freeText.push(token)
        break
      default:
        // Unknown operator — kept verbatim as a free-text term.
        parsed.freeText.push(token)
    }
  }
  return parsed
}

/**
 * Split input into token values: whitespace-delimited, except that
 * whitespace inside double quotes is literal. Quote characters are removed
 * from the returned values (`"A B" c` → `["A B", "c"]`).
 */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let index = 0
  while (index < input.length) {
    while (index < input.length && /\s/.test(input[index]!)) index += 1
    if (index >= input.length) break
    let value = ""
    let inQuotes = false
    while (index < input.length) {
      const char = input[index]!
      if (char === '"') {
        inQuotes = !inQuotes
        index += 1
        continue
      }
      if (!inQuotes && /\s/.test(char)) break
      value += char
      index += 1
    }
    if (value.length) tokens.push(value)
  }
  return tokens
}
