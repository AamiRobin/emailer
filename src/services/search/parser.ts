/**
 * Gmail-style search query parser (pure — no SQL, no I/O).
 *
 * Grammar:
 * - Input is split into whitespace-separated tokens. Double quotes group a
 *   run containing spaces into a single token value (`from:"Alice Smith"`,
 *   `"annual report"`); the quotes themselves are dropped. There is no
 *   escape character — an unmatched quote simply runs to the end of input.
 * - A token may carry ONE leading `-` to negate it: the rest of the token is
 *   parsed exactly as below, and the result EXCLUDES instead of includes
 *   (`-term`, `-"exact phrase"`, `-from:x`, `-has:attachment`, `-larger:5m`,
 *   `-before:2026-01-01`). A bare `-` (nothing after the minus) is dropped,
 *   and `--a` negates the literal text `-a` — there is no double negation
 *   and no escape character.
 * - A token shaped `key:value` (first colon splits; the key is matched
 *   case-insensitively) is an operator:
 *   - `from:` / `to:` / `subject:` / `label:` — value operators; the token's
 *     remaining text (quotes stripped) is the value. Repeated occurrences
 *     accumulate and are AND-ed.
 *   - `has:attachment` — flag, value recognized case-insensitively.
 *   - `is:unread` / `is:starred` — flags, values recognized
 *     case-insensitively. No other `is:`/`has:` values exist.
 *   - `larger:<N>` / `smaller:<N>` — size thresholds in bytes, with an
 *     optional case-insensitive `k`/`kb`/`m`/`mb` suffix (`larger:10m`,
 *     `larger:10mb`, `smaller:500k`).
 *     A value that does not parse stays as free text — the same degradation
 *     as an unrecognized flag value (`larger:abc` is searched as text).
 *   - `before:<date>` / `after:<date>` — date boundaries in `YYYY-MM-DD` or
 *     `YYYY/MM/DD`, anchored to UTC midnight (`before:` exclusive, `after:`
 *     inclusive). An unparseable value stays as free text.
 *   - An operator with an empty value (`from:`, `from:""`) is dropped: the
 *     user clearly attempted an operator, and an empty needle would either
 *     match everything (LIKE) or be FTS5 syntax noise.
 * - Anything else is a free-text term — including tokens with a colon that
 *   do not resolve to a known operator or value (`foo:bar`, `is:read`,
 *   `has:file` are searched as the literal text they spell; negated, they
 *   are excluded as that literal text). Keeping them (rather than silently
 *   discarding) preserves the user's input in the result set instead of
 *   broadening the query to the remaining terms.
 * - Every positive operator and every positive free-text term is AND-ed with
 *   the others; every negated one is a further exclusion on top.
 */

export interface NegatedFlags {
  hasAttachment: boolean
  isUnread: boolean
  isStarred: boolean
}

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
  /** `larger:<N>` thresholds in bytes; each must be exceeded. */
  larger: number[]
  /** `smaller:<N>` thresholds in bytes; each must hold. */
  smaller: number[]
  /** `before:<date>` boundaries (unix seconds); each must hold exclusively. */
  before: number[]
  /** `after:<date>` boundaries (unix seconds); each must hold inclusively. */
  after: number[]
  /** `-larger:<N>` thresholds in bytes — a message past ANY excludes. */
  negatedLarger: number[]
  /** `-smaller:<N>` thresholds in bytes — a message under ANY excludes. */
  negatedSmaller: number[]
  /** `-before:<date>` boundaries (unix seconds) — a message dated before ANY excludes. */
  negatedBefore: number[]
  /** `-after:<date>` boundaries (unix seconds) — a message dated on/after ANY excludes. */
  negatedAfter: number[]
  /** `-from:<value>` values — a match on ANY of these excludes. */
  negatedFrom: string[]
  /** `-to:<value>` values — a match on ANY of these excludes. */
  negatedTo: string[]
  /** `-subject:<value>` values — a match on ANY of these excludes. */
  negatedSubject: string[]
  /** `-label:<name>` values — a match on ANY of these excludes. */
  negatedLabels: string[]
  /** `-term` / `-"phrase"` terms — a match on ANY of these excludes. */
  negatedFreeText: string[]
  /** Negated flag operators — any match excludes. */
  negatedFlags: NegatedFlags
}

/** True when the query contributes no predicate at all — positive or
 * negated. A negation-only query is NOT empty: it excludes from everything. */
export function isEmptyQuery(parsed: ParsedQuery): boolean {
  return (
    !parsed.from.length &&
    !parsed.to.length &&
    !parsed.subject.length &&
    !parsed.labels.length &&
    !parsed.hasAttachment &&
    !parsed.isUnread &&
    !parsed.isStarred &&
    !parsed.freeText.length &&
    !parsed.larger.length &&
    !parsed.smaller.length &&
    !parsed.before.length &&
    !parsed.after.length &&
    !parsed.negatedLarger.length &&
    !parsed.negatedSmaller.length &&
    !parsed.negatedBefore.length &&
    !parsed.negatedAfter.length &&
    !parsed.negatedFrom.length &&
    !parsed.negatedTo.length &&
    !parsed.negatedSubject.length &&
    !parsed.negatedLabels.length &&
    !parsed.negatedFreeText.length &&
    !parsed.negatedFlags.hasAttachment &&
    !parsed.negatedFlags.isUnread &&
    !parsed.negatedFlags.isStarred
  )
}

/**
 * True when the query uses at least one OPERATOR — positive or negated
 * (from/to/subject/label, the flag, size and date operators). Free-text
 * terms, quoted or not, are not operators. The relaxed fallback (task 1.3,
 * design D7) keys off this: a query that scopes with operators is never
 * rewritten into its any-term form, because silently dropping the operator
 * scope would show the user mail they explicitly filtered out.
 */
export function usesOperators(parsed: ParsedQuery): boolean {
  return (
    parsed.from.length > 0 ||
    parsed.to.length > 0 ||
    parsed.subject.length > 0 ||
    parsed.labels.length > 0 ||
    parsed.hasAttachment ||
    parsed.isUnread ||
    parsed.isStarred ||
    parsed.larger.length > 0 ||
    parsed.smaller.length > 0 ||
    parsed.before.length > 0 ||
    parsed.after.length > 0 ||
    parsed.negatedFrom.length > 0 ||
    parsed.negatedTo.length > 0 ||
    parsed.negatedSubject.length > 0 ||
    parsed.negatedLabels.length > 0 ||
    parsed.negatedLarger.length > 0 ||
    parsed.negatedSmaller.length > 0 ||
    parsed.negatedBefore.length > 0 ||
    parsed.negatedAfter.length > 0 ||
    parsed.negatedFlags.hasAttachment ||
    parsed.negatedFlags.isUnread ||
    parsed.negatedFlags.isStarred
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
    larger: [],
    smaller: [],
    before: [],
    after: [],
    negatedLarger: [],
    negatedSmaller: [],
    negatedBefore: [],
    negatedAfter: [],
    negatedFrom: [],
    negatedTo: [],
    negatedSubject: [],
    negatedLabels: [],
    negatedFreeText: [],
    negatedFlags: { hasAttachment: false, isUnread: false, isStarred: false },
  }

  for (const token of tokenize(input)) {
    // One leading `-` flips the token's polarity; the rest parses normally.
    const negated = token.startsWith("-")
    const body = negated ? token.slice(1) : token
    if (!body.length) continue // bare `-` — no literal text to keep
    const colon = body.indexOf(":")
    if (colon < 0) {
      ;(negated ? parsed.negatedFreeText : parsed.freeText).push(body)
      continue
    }
    const key = body.slice(0, colon).toLowerCase()
    const value = body.slice(colon + 1)
    if (!value.length) continue // bare `key:` — dropped (see module docs)
    // Unknown keys/values degrade to (negated) free text, keeping the
    // user's literal input in the result set rather than dropping it.
    if (negated) {
      switch (key) {
        case "from":
          parsed.negatedFrom.push(value)
          break
        case "to":
          parsed.negatedTo.push(value)
          break
        case "subject":
          parsed.negatedSubject.push(value)
          break
        case "label":
          parsed.negatedLabels.push(value)
          break
        case "has":
          if (value.toLowerCase() === "attachment") {
            parsed.negatedFlags.hasAttachment = true
          } else parsed.negatedFreeText.push(body)
          break
        case "is":
          if (value.toLowerCase() === "unread")
            parsed.negatedFlags.isUnread = true
          else if (value.toLowerCase() === "starred") {
            parsed.negatedFlags.isStarred = true
          } else parsed.negatedFreeText.push(body)
          break
        case "larger": {
          const bytes = parseByteSize(value)
          if (bytes === null) parsed.negatedFreeText.push(body)
          else parsed.negatedLarger.push(bytes)
          break
        }
        case "smaller": {
          const bytes = parseByteSize(value)
          if (bytes === null) parsed.negatedFreeText.push(body)
          else parsed.negatedSmaller.push(bytes)
          break
        }
        case "before": {
          const seconds = parseUtcDate(value)
          if (seconds === null) parsed.negatedFreeText.push(body)
          else parsed.negatedBefore.push(seconds)
          break
        }
        case "after": {
          const seconds = parseUtcDate(value)
          if (seconds === null) parsed.negatedFreeText.push(body)
          else parsed.negatedAfter.push(seconds)
          break
        }
        default:
          parsed.negatedFreeText.push(body)
      }
      continue
    }
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
        else parsed.freeText.push(body)
        break
      case "is":
        if (value.toLowerCase() === "unread") parsed.isUnread = true
        else if (value.toLowerCase() === "starred") parsed.isStarred = true
        else parsed.freeText.push(body)
        break
      case "larger": {
        const bytes = parseByteSize(value)
        if (bytes === null) parsed.freeText.push(body)
        else parsed.larger.push(bytes)
        break
      }
      case "smaller": {
        const bytes = parseByteSize(value)
        if (bytes === null) parsed.freeText.push(body)
        else parsed.smaller.push(bytes)
        break
      }
      case "before": {
        const seconds = parseUtcDate(value)
        if (seconds === null) parsed.freeText.push(body)
        else parsed.before.push(seconds)
        break
      }
      case "after": {
        const seconds = parseUtcDate(value)
        if (seconds === null) parsed.freeText.push(body)
        else parsed.after.push(seconds)
        break
      }
      default:
        // Unknown operator — kept verbatim as a free-text term.
        parsed.freeText.push(body)
    }
  }
  return parsed
}

/** `10` → 10 bytes, `500k`/`500kb` → 512000, `1.5m`/`1.5mb` → 1572864;
 * null when the value is not a byte count (the token degrades to free
 * text). Both the single-letter and -b-suffixed unit spellings are
 * accepted — the rules form composes the -b forms (KB/MB as Gmail shows
 * them), the search box grew the single-letter ones. */
function parseByteSize(value: string): number | null {
  const match = /^(\d+(?:\.\d+)?)(kb|mb|k|m)?$/i.exec(value)
  if (!match) return null
  const count = Number(match[1])
  const suffix = match[2]?.toLowerCase()
  if (suffix === "k" || suffix === "kb") return Math.round(count * 1024)
  if (suffix === "m" || suffix === "mb") {
    return Math.round(count * 1024 * 1024)
  }
  return Math.round(count)
}

/** `2026-01-31` / `2026/1/31` → unix seconds at UTC midnight; null when the
 * value is not a real calendar date (rollover like 2026-02-31 is rejected,
 * not normalized). */
function parseUtcDate(value: string): number | null {
  const match = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(value)
  if (!match) return null
  const [year, month, day] = match.slice(1).map(Number) as [
    number,
    number,
    number,
  ]
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null
  }
  return Math.floor(date.getTime() / 1000)
}

/**
 * Split input into token values: whitespace-delimited, except that
 * whitespace inside double quotes is literal. Quote characters are removed
 * from the returned values (`"A B" c` → `["A B", "c"]`). A leading `-` is
 * part of the token value — polarity is the caller's concern.
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
