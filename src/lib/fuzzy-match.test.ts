import { describe, expect, it } from "vitest"

import { filterByFuzzy, fuzzyMatch, fuzzyMatchAny } from "./fuzzy-match"

describe("fuzzyMatch", () => {
  it("matches everything with score 0 for an empty query", () => {
    expect(fuzzyMatch("", "Inbox")).toEqual({ score: 0, indices: [] })
    expect(fuzzyMatch("   ", "Inbox")?.score).toBe(0)
  })

  it("is case-insensitive", () => {
    expect(fuzzyMatch("TR", "Trash")?.score).toBeGreaterThan(0)
    expect(fuzzyMatch("trash", "TRASH")?.score).toBeGreaterThan(0)
  })

  it("returns null when the query is not a subsequence", () => {
    expect(fuzzyMatch("xyz", "Inbox")).toBeNull()
    expect(fuzzyMatch("inbozx", "Inbox")).toBeNull()
  })

  it("ranks prefix above word-boundary above mid-string contiguous above subsequence", () => {
    const prefix = fuzzyMatch("sent", "Sent items")?.score ?? 0
    const wordStart = fuzzyMatch("sent", "Later sent items")?.score ?? 0
    const contiguous = fuzzyMatch("ent", "Sent items")?.score ?? 0
    const subsequence = fuzzyMatch("stis", "Sent items")?.score ?? 0
    expect(fuzzyMatch("sent", "Sent items")?.indices).toEqual([0, 1, 2, 3])
    expect(prefix).toBeGreaterThan(wordStart)
    expect(wordStart).toBeGreaterThan(contiguous)
    expect(contiguous).toBeGreaterThan(subsequence)
    expect(subsequence).toBeGreaterThan(0)
  })

  it("caps subsequence scores so a long query never outranks a contiguous match", () => {
    // scattered pairs: contiguous runs push the raw score past the cap
    const subsequence = fuzzyMatch(
      "abcdefghijklmnopqrstuvwxyz",
      "ab cd ef gh ij kl mn op qr st uv wx yz"
    )
    expect(subsequence).not.toBeNull()
    expect(subsequence?.score ?? 0).toBe(500)
    // word-boundary match right after a hierarchy separator
    expect(fuzzyMatch("invoices", "Work/Invoices")?.score).toBe(800)
  })

  it("rewards contiguity within subsequence matches", () => {
    const contiguous = fuzzyMatch("nb", "Inbox")?.score ?? 0
    const scattered = fuzzyMatch("nx", "Inbox")?.score ?? 0
    expect(contiguous).toBeGreaterThan(scattered)
  })
})

describe("fuzzyMatchAny", () => {
  it("returns the best score across label and keywords", () => {
    const score = fuzzyMatchAny("mail", ["Search mail", "search", "find"])
    expect(score).toBe(800)
    expect(fuzzyMatchAny("zzz", ["Search mail", "find"])).toBeNull()
  })
})

describe("filterByFuzzy", () => {
  interface Item {
    id: string
    label: string
    keywords: string[]
  }

  const items: Item[] = [
    { id: "a", label: "Compose new message", keywords: ["compose"] },
    { id: "b", label: "Trash", keywords: ["trash"] },
    { id: "c", label: "Starred", keywords: ["starred", "flag"] },
    { id: "d", label: "Search mail", keywords: ["search", "find"] },
  ]

  it("returns every item in original order for an empty query", () => {
    expect(
      filterByFuzzy(items, "", (item) => [item.label, ...item.keywords])
    ).toEqual(items)
    expect(
      filterByFuzzy(items, "  ", (item) => [item.label, ...item.keywords]).map(
        (item) => item.id
      )
    ).toEqual(["a", "b", "c", "d"])
  })

  it("drops items that do not match and sorts the rest best-first", () => {
    const results = filterByFuzzy(items, "star", (item) => [
      item.label,
      ...item.keywords,
    ])
    expect(results.map((item) => item.id)).toEqual(["c"])
  })

  it("ranks a prefix match ahead of a keyword match on the same query", () => {
    const trashFirst: Item[] = [
      { id: "search", label: "Search mail", keywords: ["star search"] },
      { id: "starred", label: "Starred", keywords: ["starred"] },
    ]
    const results = filterByFuzzy(trashFirst, "star", (item) => [
      item.label,
      ...item.keywords,
    ])
    // "Starred" is a prefix match (1000); "Search mail" only matches the
    // keyword at a word boundary (800).
    expect(results.map((item) => item.id)).toEqual(["starred", "search"])
  })

  it("keeps the original order for equal scores", () => {
    const ties: Item[] = [
      { id: "first", label: "Beta", keywords: [] },
      { id: "second", label: "Bell", keywords: [] },
    ]
    const results = filterByFuzzy(ties, "be", (item) => [
      item.label,
      ...item.keywords,
    ])
    expect(results.map((item) => item.id)).toEqual(["first", "second"])
  })
})
