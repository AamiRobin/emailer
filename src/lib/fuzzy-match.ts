/**
 * Pure fuzzy scorer for the command palette (task 6.7): case-insensitive
 * subsequence matching with a ranking that separates prefix matches from
 * in-string contiguous matches from scattered subsequence matches. No
 * dependencies, no state — a plain function so it is trivially testable
 * and reusable outside the palette.
 *
 * Ranking bands (mutually exclusive by construction):
 * - 1000  query is a prefix of the text ("tr" → "Trash")
 * - 800   query starts at a word boundary inside the text ("mail" →
 *         "Search mail"; separators: space / - _ . @ ( ) [ ] + & #)
 * - 600   query appears contiguously elsewhere ("ail" → "Search mail")
 * - ≤ 500 scattered subsequence with contiguity/word-start bonuses,
 *         capped so it can never outrank a contiguous match
 * An empty (or whitespace-only) query matches everything with score 0.
 */

export interface FuzzyScore {
  /** Higher matches better; 0 for an empty query. */
  score: number
  /** Indices of the matched characters in the text (for highlighting). */
  indices: number[]
}

const PREFIX_SCORE = 1000
const WORD_START_SCORE = 800
const CONTIGUOUS_SCORE = 600
/** Ceiling for scattered subsequence matches — below every band above. */
const SUBSEQUENCE_CAP = 500
const SUBSEQUENCE_BASE_PER_CHAR = 10
const SUBSEQUENCE_CONTIGUITY_BONUS = 5
const SUBSEQUENCE_WORD_START_BONUS = 20
const SUBSEQUENCE_STRING_START_BONUS = 30

const WORD_SEPARATORS = new Set([
  " ",
  "/",
  "-",
  "_",
  ".",
  "@",
  "(",
  ")",
  "[",
  "]",
  "+",
  "&",
  "#",
])

function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true
  return WORD_SEPARATORS.has(text[index - 1])
}

/**
 * Greedy left-to-right subsequence alignment of `query` onto `text`,
 * starting the first match exactly at `start`. Greediness favors
 * contiguity (matched characters are packed as early as possible), which
 * is the dominant signal after prefix matching.
 */
function scoreSubsequenceFrom(
  query: string,
  text: string,
  start: number
): FuzzyScore | null {
  const indices: number[] = []
  let score = 0
  let queryIndex = 0
  for (let index = start; index < text.length; index += 1) {
    if (queryIndex >= query.length) break
    if (text[index] !== query[queryIndex]) continue
    if (index === 0) {
      score += SUBSEQUENCE_STRING_START_BONUS
    } else if (isWordStart(text, index)) {
      score += SUBSEQUENCE_WORD_START_BONUS
    }
    const previous = indices[indices.length - 1]
    if (previous !== undefined && index === previous + 1) {
      score += SUBSEQUENCE_CONTIGUITY_BONUS
    }
    score += SUBSEQUENCE_BASE_PER_CHAR
    indices.push(index)
    queryIndex += 1
  }
  if (queryIndex < query.length) return null
  return { score: Math.min(score, SUBSEQUENCE_CAP), indices }
}

/**
 * Score `query` against `text`, or null when the query is not a
 * subsequence of the text. Case-insensitive; leading/trailing whitespace
 * in the query is ignored.
 */
export function fuzzyMatch(
  rawQuery: string,
  rawText: string
): FuzzyScore | null {
  const query = rawQuery.trim().toLowerCase()
  const text = rawText.toLowerCase()
  if (query.length === 0) return { score: 0, indices: [] }

  // Exact substring beats any scattered alignment: check it first.
  const substringAt = text.indexOf(query)
  if (substringAt !== -1) {
    const score =
      substringAt === 0
        ? PREFIX_SCORE
        : isWordStart(text, substringAt)
          ? WORD_START_SCORE
          : CONTIGUOUS_SCORE
    const indices = Array.from(
      { length: query.length },
      (_, offset) => substringAt + offset
    )
    return { score, indices }
  }

  // Scattered subsequence: try every position of the first query
  // character and keep the best-scoring alignment.
  const first = query[0]
  if (first === undefined) return null
  let best: FuzzyScore | null = null
  for (
    let start = text.indexOf(first);
    start !== -1;
    start = text.indexOf(first, start + 1)
  ) {
    const candidate = scoreSubsequenceFrom(query, text, start)
    if (candidate && (!best || candidate.score > best.score)) {
      best = candidate
    }
  }
  return best
}

/**
 * Best score of `query` across an item's match targets (label + keywords),
 * or null when no target matches. An empty query scores 0.
 */
export function fuzzyMatchAny(
  query: string,
  targets: readonly string[]
): number | null {
  let best: number | null = null
  for (const target of targets) {
    const result = fuzzyMatch(query, target)
    if (result && (best === null || result.score > best)) {
      best = result.score
    }
  }
  return best
}

/**
 * Filter + rank items for the palette: keeps items whose label or
 * keywords fuzzy-match the query and sorts them best-first (score desc,
 * then shorter primary label, then original order). An empty query
 * returns every item in its original order.
 */
export function filterByFuzzy<T>(
  items: readonly T[],
  query: string,
  getTargets: (item: T) => string | readonly string[]
): T[] {
  if (query.trim().length === 0) return [...items]
  const scored: Array<{
    item: T
    score: number
    labelLength: number
    order: number
  }> = []
  items.forEach((item, order) => {
    const raw = getTargets(item)
    const targets = typeof raw === "string" ? [raw] : raw
    const score = fuzzyMatchAny(query, targets)
    if (score !== null) {
      scored.push({ item, score, labelLength: targets[0]?.length ?? 0, order })
    }
  })
  scored.sort(
    (a, b) =>
      b.score - a.score || a.labelLength - b.labelLength || a.order - b.order
  )
  return scored.map((entry) => entry.item)
}
