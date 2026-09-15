/**
 * FTS5/LIKE text helpers shared by the search query builder. Moved here
 * from src/services/db/search.ts when it became a thin delegate to the
 * operator-aware search module (src/services/search/index.ts).
 */

/**
 * Join terms with implicit AND, each as a quoted FTS5 string. Doubling
 * embedded quotes keeps the term inside one quoted string, so input like
 * `foo"bar` can neither terminate the string early nor inject syntax. The
 * trigram tokenizer makes quoted strings match substrings, case-insensitively.
 */
export function toFtsMatch(terms: string[]): string {
  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" ")
}

/** Escape LIKE wildcards; pairs with ESCAPE '\' in the pattern. */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`)
}
