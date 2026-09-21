import {
  HELP_CARDS,
  HELP_CATEGORIES,
  type HelpCard,
  type HelpCategory,
} from "./content"

/**
 * The help center's local search (task 2.9, design D14): a pure,
 * in-memory scorer over the bundled catalog — no storage, no network,
 * no dependencies. A query is split into whitespace-separated terms; a
 * card matches only when EVERY term hits it somewhere (AND semantics,
 * so extra words narrow instead of flooding), and cards are ranked by
 * where the terms hit, strongest signal first:
 *
 *   keyword exact > keyword prefix > keyword substring
 *     > title substring > category substring > body substring
 *
 * All comparisons are case-insensitive. An empty (or whitespace-only)
 * query matches everything, returning the full catalog in its bundled
 * order — which is already grouped by category — so the component can
 * treat "browse" as the degenerate case of "search".
 */

/** One category's slice of a (grouped) result set. */
export interface HelpCardGroup {
  category: HelpCategory
  cards: HelpCard[]
}

/** Score buckets, strongest first; a term's card score is its best hit. */
const KEYWORD_EXACT_SCORE = 100
const KEYWORD_PREFIX_SCORE = 60
const KEYWORD_SUBSTRING_SCORE = 40
const TITLE_SCORE = 30
const CATEGORY_SCORE = 15
const BODY_SCORE = 10

/** Pre-lowercased search text for one card (computed once per call). */
interface IndexedCard {
  card: HelpCard
  title: string
  category: string
  body: string
}

function indexCard(card: HelpCard): IndexedCard {
  return {
    card,
    title: card.title.toLowerCase(),
    category: card.category.toLowerCase(),
    body: card.body.join(" ").toLowerCase(),
  }
}

/** Best score one query term earns on one card, or 0 when it misses. */
function termScore(term: string, indexed: IndexedCard): number {
  let best = 0
  for (const keyword of indexed.card.keywords) {
    const kw = keyword.toLowerCase()
    if (kw === term) best = Math.max(best, KEYWORD_EXACT_SCORE)
    else if (kw.startsWith(term)) best = Math.max(best, KEYWORD_PREFIX_SCORE)
    else if (kw.includes(term)) best = Math.max(best, KEYWORD_SUBSTRING_SCORE)
  }
  if (indexed.title.includes(term)) {
    best = Math.max(best, TITLE_SCORE)
  }
  if (indexed.category.includes(term)) {
    best = Math.max(best, CATEGORY_SCORE)
  }
  if (indexed.body.includes(term)) {
    best = Math.max(best, BODY_SCORE)
  }
  return best
}

/** The query's terms, lowercased; empty for an empty/whitespace query. */
function queryTerms(query: string): string[] {
  return query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0)
}

/**
 * Search the catalog. Ranked matches for a non-empty query (every term
 * must hit; ties keep the catalog order); the whole catalog, in its
 * bundled category-grouped order, for an empty query.
 */
export function searchHelpCards(query: string): HelpCard[] {
  const terms = queryTerms(query)
  if (terms.length === 0) return [...HELP_CARDS]

  const indexed = HELP_CARDS.map(indexCard)
  const scored: { card: HelpCard; index: number; score: number }[] = []
  indexed.forEach((entry, index) => {
    let total = 0
    for (const term of terms) {
      const score = termScore(term, entry)
      if (score === 0) return // AND semantics: one miss drops the card
      total += score
    }
    scored.push({ card: entry.card, index, score: total })
  })
  // Stable rank: score first, catalog order for ties.
  return scored
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.card)
}

/**
 * Group cards by the fixed category order (HELP_CATEGORIES). Cards keep
 * the order they arrive in within their group; categories with no cards
 * are omitted.
 */
export function groupHelpCards(cards: ReadonlyArray<HelpCard>): HelpCardGroup[] {
  const byCategory = new Map<HelpCategory, HelpCard[]>()
  for (const card of cards) {
    const list = byCategory.get(card.category)
    if (list) {
      list.push(card)
    } else {
      byCategory.set(card.category, [card])
    }
  }
  return HELP_CATEGORIES.filter((category) => byCategory.has(category)).map(
    (category) => ({
      category,
      cards: byCategory.get(category) as HelpCard[],
    })
  )
}

/**
 * Search plus grouping in one call — the help-center component's entry
 * point. Empty query → every card, grouped by category; a query → the
 * ranked matches, grouped the same way.
 */
export function searchHelpGrouped(query: string): HelpCardGroup[] {
  return groupHelpCards(searchHelpCards(query))
}
