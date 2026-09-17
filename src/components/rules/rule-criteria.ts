import { parseSearchQuery } from "@/services/search/parser"

/**
 * The rule dialog's structured criteria form (design D10): a pure model
 * between Gmail's labeled field rows and the query string the rules store
 * in criteria_json. The parser (services/search/parser.ts) stays the
 * single source of truth — composeCriteriaQuery COMPILES fields into that
 * language, and criteriaFieldsFromQuery maps a stored query back, reporting
 * `unrepresentable` when anything in it has no form field (labels, is:
 * flags, negated operators, multiple bounds) or when a value would not
 * survive the form's recompose (quoted phrases — the word lists split on
 * whitespace — and commas inside from:/to:/subject: values), so the
 * dialog falls back to the raw advanced input and a stored rule never
 * changes meaning just by being opened.
 */

export interface CriteriaFields {
  /** Comma-separated addresses/names → repeated `from:` tokens. */
  from: string
  /** Comma-separated recipients → repeated `to:` tokens. */
  to: string
  subject: string
  /** Whitespace-separated free-text terms. */
  hasWords: string
  /** Whitespace-separated excluded terms → `-term` tokens. */
  doesntHave: string
  sizeDirection: "larger" | "smaller"
  /** Non-empty only alongside a parsed numeric value. */
  sizeValue: string
  sizeUnit: "kb" | "mb"
  dateDirection: "before" | "after"
  /** ISO YYYY-MM-DD (the value `<input type="date">` yields). */
  dateValue: string
  hasAttachment: boolean
}

export function emptyCriteriaFields(): CriteriaFields {
  return {
    from: "",
    to: "",
    subject: "",
    hasWords: "",
    doesntHave: "",
    sizeDirection: "larger",
    sizeValue: "",
    sizeUnit: "mb",
    dateDirection: "before",
    dateValue: "",
    hasAttachment: false,
  }
}

/** The parser's tokenizer strips double quotes wherever they appear
 * (parser.ts), so composing strips them up front: the stored query then
 * parses back to exactly what the form composed. */
function stripQuotes(text: string): string {
  return text.replace(/"/g, "")
}

/** `from:"Alice Smith"` when the value contains whitespace; a comma list
 * becomes repeated same-operator tokens (OR within the operator). */
function pushValueTokens(
  tokens: string[],
  key: "from" | "to" | "subject",
  raw: string
): void {
  for (const part of raw.split(",").map((value) => stripQuotes(value.trim()))) {
    if (!part) continue
    tokens.push(/\s/.test(part) ? `${key}:"${part}"` : `${key}:${part}`)
  }
}

/** Fields → the stored query string, or null when no field contributes a
 * criterion (a criteria-less rule can never be saved — same rule as the
 * raw input's emptiness check). */
export function composeCriteriaQuery(fields: CriteriaFields): string | null {
  const tokens: string[] = []
  pushValueTokens(tokens, "from", fields.from)
  pushValueTokens(tokens, "to", fields.to)
  pushValueTokens(tokens, "subject", fields.subject)
  tokens.push(...fields.hasWords.split(/\s+/).map(stripQuotes).filter(Boolean))
  for (const term of fields.doesntHave
    .split(/\s+/)
    .map(stripQuotes)
    .filter(Boolean)) {
    tokens.push(term.startsWith("-") ? term : `-${term}`)
  }
  const size = Number(fields.sizeValue)
  if (fields.sizeValue.trim() !== "" && Number.isFinite(size) && size > 0) {
    tokens.push(`${fields.sizeDirection}:${fields.sizeValue}${fields.sizeUnit}`)
  }
  if (fields.dateValue) {
    tokens.push(`${fields.dateDirection}:${fields.dateValue}`)
  }
  if (fields.hasAttachment) tokens.push("has:attachment")
  return tokens.length > 0 ? tokens.join(" ") : null
}

/** Parse an existing query into form fields. `unrepresentable` is true when
 * any parsed predicate has no form field (labels, is:/is-flag negations,
 * negated operators — including negated size/date bounds — or more than one
 * size/date bound) or would be altered by recomposition (quoted phrases,
 * comma-bearing from:/to:/subject: values, a negated literal dash) — the
 * caller falls back to the raw advanced input with the query verbatim. */
export function criteriaFieldsFromQuery(query: string): {
  fields: CriteriaFields
  unrepresentable: boolean
} {
  const parsed = parseSearchQuery(query)
  const fields = emptyCriteriaFields()
  let unrepresentable = false

  if (
    parsed.negatedFrom.length ||
    parsed.negatedTo.length ||
    parsed.negatedSubject.length ||
    parsed.negatedLabels.length ||
    parsed.negatedFlags.hasAttachment ||
    parsed.negatedFlags.isUnread ||
    parsed.negatedFlags.isStarred ||
    parsed.labels.length ||
    parsed.isUnread ||
    parsed.isStarred ||
    parsed.larger.length > 1 ||
    parsed.smaller.length > 1 ||
    parsed.larger.length + parsed.smaller.length > 1 ||
    parsed.before.length + parsed.after.length > 1 ||
    parsed.larger.some((bytes) => !sizeFormable(bytes)) ||
    parsed.smaller.some((bytes) => !sizeFormable(bytes)) ||
    // negated size/date bounds have no form row (doesn't-have words are
    // free text only) — compose would silently drop them
    parsed.negatedLarger.length ||
    parsed.negatedSmaller.length ||
    parsed.negatedBefore.length ||
    parsed.negatedAfter.length
  ) {
    unrepresentable = true
  }

  // Value-level round-trip hazards: the form recomposes from fields, so a
  // predicate the compose pass would ALTER marks the query unrepresentable —
  // whitespace inside a term (a quoted phrase would split into independent
  // words), a negated literal dash (`--a` would recompose as `-a`), and
  // commas inside a from:/to:/subject: value (the fields join/split on them).
  if (
    parsed.freeText.some((term) => /\s/.test(term)) ||
    parsed.negatedFreeText.some(
      (term) => /\s/.test(term) || term.startsWith("-")
    ) ||
    [...parsed.from, ...parsed.to, ...parsed.subject].some((value) =>
      value.includes(",")
    )
  ) {
    unrepresentable = true
  }

  fields.from = parsed.from.join(", ")
  fields.to = parsed.to.join(", ")
  fields.subject = parsed.subject.join(", ")
  fields.hasWords = parsed.freeText.join(" ")
  // bare terms — composeCriteriaQuery re-adds the exclusion dash
  fields.doesntHave = parsed.negatedFreeText
    .map((term) => term.replace(/^-/, ""))
    .join(" ")
  if (parsed.larger.length === 1) {
    fields.sizeDirection = "larger"
    const { value, unit } = sizeToValueUnit(parsed.larger[0]!)
    fields.sizeValue = value
    fields.sizeUnit = unit
  } else if (parsed.smaller.length === 1) {
    fields.sizeDirection = "smaller"
    const { value, unit } = sizeToValueUnit(parsed.smaller[0]!)
    fields.sizeValue = value
    fields.sizeUnit = unit
  }
  if (parsed.before.length === 1) {
    fields.dateDirection = "before"
    fields.dateValue = dateToIso(parsed.before[0]!)
  } else if (parsed.after.length === 1) {
    fields.dateDirection = "after"
    fields.dateValue = dateToIso(parsed.after[0]!)
  }
  fields.hasAttachment = parsed.hasAttachment

  return { fields, unrepresentable }
}

/** A size bound the form can edit without changing its meaning: a positive
 * whole number of KB (which includes whole MB). Anything else — zero, or a
 * byte count that is not a KB multiple — would round-trip to a different
 * threshold (0 drops the token, 1500 bytes would re-compose as 1500kb),
 * so criteriaFieldsFromQuery marks such queries unrepresentable. */
function sizeFormable(bytes: number): boolean {
  return bytes > 0 && bytes % 1024 === 0
}

/** Bytes → the round number + unit the form edits. The caller's
 * sizeFormable gate guarantees a KB or MB multiple; the KB fallback below
 * is the defensive tail of that contract. */
function sizeToValueUnit(bytes: number): { value: string; unit: "kb" | "mb" } {
  if (bytes !== 0 && bytes % (1024 * 1024) === 0) {
    return { value: String(bytes / (1024 * 1024)), unit: "mb" }
  }
  return { value: String(bytes / 1024), unit: "kb" }
}

/** Unix seconds (the parser's UTC-midnight anchor) → the <input type=date>
 * ISO value; an out-of-range date leaves the field empty (advanced mode
 * still carries the query verbatim). */
function dateToIso(seconds: number): string {
  const date = new Date(seconds * 1000)
  const iso = date.toISOString().slice(0, 10)
  const roundTrip = Date.UTC(
    Number(iso.slice(0, 4)),
    Number(iso.slice(5, 7)) - 1,
    Number(iso.slice(8, 10))
  )
  return roundTrip === seconds * 1000 ? iso : ""
}
