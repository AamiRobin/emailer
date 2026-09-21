import { describe, expect, it } from "vitest"

import { accentGlob, foldText, toFtsMatch } from "../fts"

/**
 * Unit tests for the search text helpers (task 1.3, design D7): the
 * accent fold (NFD diacritic-strip) and the FTS5 MATCH string builder's
 * AND/OR joins.
 */
describe("foldText", () => {
  it("strips Latin diacritics — the spec's Bé Dọn Dẹp case", () => {
    expect(foldText("Bé Dọn Dẹp")).toBe("Be Don Dep")
  })

  it("is idempotent — folding folded text changes nothing", () => {
    const once = foldText("Bé Dọn Dẹp Ångström café")
    expect(foldText(once)).toBe(once)
  })

  it("leaves already-unaccented ASCII text (and punctuation) unchanged", () => {
    expect(foldText("plain ASCII 123 !@# v2.0")).toBe("plain ASCII 123 !@# v2.0")
  })

  it("leaves CJK untouched — no decompositions, no transliteration", () => {
    expect(foldText("会議のお知らせ")).toBe("会議のお知らせ")
  })

  it("strips combining marks from already-decomposed input", () => {
    expect(foldText("Be\u0301 Do\u0323n De\u0323p")).toBe("Be Don Dep")
  })

  it("handles the empty string", () => {
    expect(foldText("")).toBe("")
  })
})

describe("toFtsMatch", () => {
  it("joins terms with FTS5's implicit AND by default", () => {
    expect(toFtsMatch(["be don dep", "roadmap"])).toBe(
      '"be don dep" "roadmap"'
    )
  })

  it("joins terms with explicit OR for the relaxed fallback", () => {
    expect(toFtsMatch(["alpha", "beta"], "or")).toBe('"alpha" OR "beta"')
  })

  it("doubles embedded quotes so input cannot inject MATCH syntax", () => {
    expect(toFtsMatch(['foo"bar'])).toBe('"foo""bar"')
    expect(toFtsMatch(['foo"bar'], "or")).toBe('"foo""bar"')
  })
})

describe("accentGlob", () => {
  /** Pull the bracket classes out of a pattern. */
  function classesOf(pattern: string): string[][] {
    return (
      pattern
        .slice(1, -1)
        .match(/\[([^\]]+)\]/g)
        ?.map((klass) => [...klass.slice(1, -1)]) ?? []
    )
  }

  it("builds one bracket class per character, both cases included", () => {
    const classes = classesOf(accentGlob("zz")!)
    expect(classes).toHaveLength(2)
    for (const klass of classes) {
      expect(klass).toContain("z")
      expect(klass).toContain("Z")
    }
    expect(accentGlob("zz")).toMatch(/^\*.*\*$/)
  })

  it("bridges the fold: 'be' matches 'Bé' through the e-class", () => {
    const classes = classesOf(accentGlob("be")!)
    expect(classes[0]).toContain("b")
    expect(classes[0]).toContain("B")
    expect(classes[1]).toContain("é")
    expect(classes[1]).toContain("É")
    expect(classes[1]).toContain("e")
    expect(classes[1]).toContain("E")
  })

  it("covers the Vietnamese block (the spec's Dọn vowels)", () => {
    expect(accentGlob("o")).toContain("ọ")
    expect(accentGlob("o")).toContain("Ọ")
    expect(accentGlob("e")).toContain("ẹ")
    expect(accentGlob("a")).toContain("ạ")
  })

  it("every class member folds back onto its position's base letter", () => {
    const classes = classesOf(accentGlob("on")!)
    classes.forEach((klass, index) => {
      const base = foldText("on"[index]!)
      for (const char of klass) {
        expect(foldText(char.toLowerCase()), `${char} in [${klass}]`).toBe(
          base
        )
      }
    })
  })

  it("gives non-accentable scripts a minimal class", () => {
    expect(classesOf(accentGlob("会")!)).toEqual([["会"]])
  })

  it("refuses GLOB metacharacters — the caller falls back to LIKE", () => {
    for (const term of ["a*b", "a?b", "a[b", "a]b", "^x"]) {
      expect(accentGlob(term)).toBeNull()
    }
    expect(accentGlob("a.b")).not.toBeNull()
  })

  it("refuses a term that folds to empty — its `**` pattern would match everything", () => {
    expect(accentGlob("")).toBeNull()
    // A lone combining mark (decomposed "é" without its base letter).
    expect(accentGlob("\u0301")).toBeNull()
  })
})
