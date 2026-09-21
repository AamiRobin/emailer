/**
 * FTS5/LIKE text helpers shared by the search query builder. Moved here
 * from src/services/db/search.ts when it became a thin delegate to the
 * operator-aware search module (src/services/search/index.ts).
 */

/**
 * Fold text for accent-insensitive matching (task 1.3, design D7):
 * NFD-decompose, then strip the combining diacritic marks. Unaccented and
 * already-ASCII text is returned unchanged (the fold is idempotent), CJK
 * and other scripts without decompositions pass through untouched, and no
 * transliteration happens — Latin diacritics only ("Bé Dọn Dẹp" → "Be Don
 * Dep"). Case is deliberately NOT folded here: the trigram tokenizer and
 * the COLLATE NOCASE LIKE comparisons already handle it, and folding it
 * twice would blur which layer owns what.
 */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "")
}

/**
 * Join terms as quoted FTS5 strings. Doubling embedded quotes keeps the
 * term inside one quoted string, so input like `foo"bar` can neither
 * terminate the string early nor inject syntax. The trigram tokenizer makes
 * quoted strings match substrings, case-insensitively.
 *
 * `join` picks the boolean combinator: `"and"` (default) joins with
 * whitespace — FTS5's implicit AND, so every term must match; `"or"`
 * produces the explicit OR form the relaxed fallback runs (task 1.3).
 */
export function toFtsMatch(terms: string[], join: "and" | "or" = "and"): string {
  const separator = join === "or" ? " OR " : " "
  return terms
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(separator)
}

/**
 * Accent-bridged GLOB pattern for a FOLDED sub-trigram term (task 1.3,
 * design D7). A term shorter than 3 characters can never become a trigram
 * token, so it falls back to a raw-text scan — which folds ASCII case but
 * not diacritics, and SQLite has no expression that NFD-strips a stored
 * column. The bridge: every character of the term becomes a GLOB bracket
 * class holding the base letter in both cases PLUS every precomposed Latin
 * letter that folds back onto it ("e" → [eEèéêë…ÈÉÊË…] from Latin-1,
 * Latin Extended-A/B and the Vietnamese Extended-Additional block), so the
 * folded query still matches raw stored text ("be" finds "Bé"). GLOB is
 * case-sensitive, which is exactly why both cases go into each class.
 *
 * One GLOB per column keeps the SQL's expression depth constant — the
 * equivalent per-variant LIKE enumeration would blow past SQLite's 1000
 * node expression-tree limit — and there is no cross product: each
 * position is independent. Returns null when the term contains GLOB
 * metacharacters (* ? [ ] ^ at class level) that a bracket class cannot
 * express safely, and for a term that FOLDS to empty (a lone combining
 * mark) — its pattern would be `**`, which matches everything. The caller
 * falls back to the plain escaped LIKE in both cases.
 */
export function accentGlob(term: string): string | null {
  if (/[*?[\]^]/.test(term)) return null
  if (foldText(term) === "") return null
  let pattern = "*"
  for (const char of term) {
    const set = new Set<string>([char])
    for (const alternate of accentVariantsByBase().get(char) ?? []) {
      set.add(alternate)
    }
    // GLOB is case-sensitive: pair every entry with its other case
    for (const entry of [...set]) {
      set.add(entry.toLocaleUpperCase("en"))
      set.add(entry.toLocaleLowerCase("en"))
    }
    pattern += `[${[...set].sort().join("")}]`
  }
  return pattern + "*"
}

let accentVariantsByBaseCache: Map<string, string[]> | null = null

/** base letter → precomposed letters that NFD-fold onto it. Built once
 * from the Latin accent blocks; everything else is absent by design. */
function accentVariantsByBase(): Map<string, string[]> {
  accentVariantsByBaseCache ??= (() => {
    const map = new Map<string, string[]>()
    for (let code = 0x00c0; code <= 0x024f; code += 1) {
      pushVariant(map, code)
    }
    // Latin Extended-Additional — the Vietnamese vowels (Ọ ẹ ị ợ …)
    for (let code = 0x1e00; code <= 0x1eff; code += 1) {
      pushVariant(map, code)
    }
    return map
  })()
  return accentVariantsByBaseCache
}

function pushVariant(map: Map<string, string[]>, code: number): void {
  const char = String.fromCodePoint(code)
  const base = foldText(char)
  if (base === char || base.length !== 1) return
  const variants = map.get(base)
  if (variants) variants.push(char)
  else map.set(base, [char])
}

/** Escape LIKE wildcards; pairs with ESCAPE '\' in the pattern. */
export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (char) => `\\${char}`)
}
