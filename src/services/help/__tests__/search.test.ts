import { describe, expect, it } from "vitest"

import {
  HELP_CARDS,
  HELP_CATEGORIES,
  SHORTCUTS_CARD_ID,
} from "../content"
import { groupHelpCards, searchHelpCards, searchHelpGrouped } from "../search"

/**
 * Help-center search tests (task 2.9, design D14). The scorer is pure,
 * so these run against the bundled catalog directly: keyword hits must
 * rank keyword exact > prefix > substring, title/category/body hits fall
 * below, every term must match (AND), and an empty query reaches the
 * whole catalog grouped by category.
 */

/** Lowercased haystack of everything a card is findable by. */
function cardText(card: (typeof HELP_CARDS)[number]): string {
  return [
    card.title,
    card.category,
    ...card.keywords,
    ...card.body,
  ]
    .join(" ")
    .toLowerCase()
}

describe("help catalog integrity", () => {
  it("has unique ids across the catalog", () => {
    const ids = HELP_CARDS.map((card) => card.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("uses only declared categories and never ships an empty card", () => {
    const declared = new Set<string>(HELP_CATEGORIES)
    for (const card of HELP_CARDS) {
      expect(declared.has(card.category)).toBe(true)
      expect(card.title.length).toBeGreaterThan(0)
      expect(card.body.length).toBeGreaterThan(0)
      for (const paragraph of card.body) {
        expect(paragraph.length).toBeGreaterThan(0)
      }
    }
  })

  it("ships 18–38 cards across every category, including the shortcuts card", () => {
    // The upper bound keeps the catalog from bloating; parity-round-2
    // (task 5.1) raised it from 30 to 38 when the new surfaces —
    // find-in-message, source view, storage/reset, sounds, mark-as-read,
    // AI tiers/usage/quick replies/NL rules, Microsoft 365, profiles,
    // CardDAV — each earned a card or joined an existing one.
    expect(HELP_CARDS.length).toBeGreaterThanOrEqual(18)
    expect(HELP_CARDS.length).toBeLessThanOrEqual(38)
    const categories = new Set<string>(HELP_CARDS.map((card) => card.category))
    for (const category of HELP_CATEGORIES) {
      expect(categories.has(category)).toBe(true)
    }
    expect(
      HELP_CARDS.some((card) => card.id === SHORTCUTS_CARD_ID)
    ).toBe(true)
  })

  it("every parity-round-2 surface is reachable by its keywords, best hit first", () => {
    // One representative keyword per new surface (task 5.1): the card
    // covering that surface must own the top result. Exact hits that tie
    // (e.g. "microsoft" on both the connect-account and Microsoft 365
    // cards) fall back to catalog order, so these use terms that rank
    // the surface's own card first.
    const expectations: Array<[string, string]> = [
      ["find", "find-in-message"],
      ["source", "message-source"],
      ["mark read", "reading-preferences"],
      ["wipe", "storage-reset"],
      ["chime", "notifications"],
      ["instant", "ai-assistance"],
      ["chips", "ai-quick-replies-and-rules"],
      ["entra", "microsoft-365"],
      ["carddav", "carddav-contacts"],
      ["profiles", "profiles-colors"],
      ["relaxed", "search-operators"],
    ]
    for (const [term, expectedId] of expectations) {
      expect(searchHelpCards(term)[0]?.id).toBe(expectedId)
    }
  })

  it("multi-word queries reach the new entries too (“quick replies”, “mark as read”)", () => {
    // AND semantics across the query's terms still land on the new
    // cards — the natural phrasing a user would type.
    expect(searchHelpCards("quick replies")[0]?.id).toBe(
      "ai-quick-replies-and-rules"
    )
    expect(searchHelpCards("mark as read")[0]?.id).toBe("reading-preferences")
    expect(searchHelpCards("find in message")[0]?.id).toBe("find-in-message")
  })
})

describe("searchHelpCards", () => {
  it("an empty query reaches every card, in bundled (category-grouped) order", () => {
    const results = searchHelpCards("")
    expect(results).toHaveLength(HELP_CARDS.length)
    expect(results.map((card) => card.id)).toEqual(
      HELP_CARDS.map((card) => card.id)
    )
    // Whitespace-only behaves the same way.
    expect(searchHelpCards("   ")).toHaveLength(HELP_CARDS.length)
  })

  it("“snooze” surfaces the snooze cards, exact-keyword card first", () => {
    const results = searchHelpCards("snooze")
    expect(results.length).toBeGreaterThanOrEqual(2)
    expect(results[0]?.id).toBe("snooze")
    // The shortcuts card documents the b binding, so it must surface too.
    expect(results.some((card) => card.id === SHORTCUTS_CARD_ID)).toBe(true)
    // Nothing irrelevant leaks in: every hit actually talks about snoozing.
    for (const card of results) {
      expect(cardText(card)).toContain("snooze")
    }
  })

  it("matches case-insensitively", () => {
    const lower = searchHelpCards("snooze").map((card) => card.id)
    const upper = searchHelpCards("SNOOZE").map((card) => card.id)
    expect(upper).toEqual(lower)
  })

  it("keyword prefixes rank and match like the spec's keyword search", () => {
    const results = searchHelpCards("snoo")
    expect(results[0]?.id).toBe("snooze")
    expect(results.some((card) => card.id === SHORTCUTS_CARD_ID)).toBe(true)
    // Prefix hits (keyword "snooze" starts with "sno") must outrank the
    // body-substring-only hits.
    const bodyOnlyIndex = results.findIndex(
      (card) => card.id === SHORTCUTS_CARD_ID
    )
    expect(bodyOnlyIndex).toBeGreaterThan(0)
  })

  it("an exact keyword beats a body-phrase match", () => {
    // "compose" is an exact keyword of the composing card but only a
    // passing phrase in the palette and global-shortcut cards.
    const results = searchHelpCards("compose")
    expect(results[0]?.id).toBe("compose")
  })

  it("extra terms narrow with AND semantics", () => {
    // Both terms must hit: the snooze card owns "snooze"+"shortcut"
    // keywords, and the shortcuts card mentions snoozing in its body.
    const results = searchHelpCards("snooze shortcut")
    expect(results.map((card) => card.id)).toEqual([
      "snooze",
      SHORTCUTS_CARD_ID,
    ])
  })

  it("returns nothing for a query no card matches", () => {
    expect(searchHelpCards("zzzzzz")).toEqual([])
  })
})

describe("groupHelpCards / searchHelpGrouped", () => {
  it("groups the full catalog under every category, in declared order", () => {
    const groups = searchHelpGrouped("")
    expect(groups.map((group) => group.category)).toEqual(HELP_CATEGORIES)
    const total = groups.reduce((sum, group) => sum + group.cards.length, 0)
    expect(total).toBe(HELP_CARDS.length)
    // Every card lands in the group matching its own category.
    for (const group of groups) {
      for (const card of group.cards) {
        expect(card.category).toBe(group.category)
      }
    }
  })

  it("grouping keeps declared order even for a hand-picked card list", () => {
    const scrambled = [...HELP_CARDS].reverse()
    const groups = groupHelpCards(scrambled)
    expect(groups.map((group) => group.category)).toEqual(HELP_CATEGORIES)
    // Within a group, the caller's order is preserved.
    for (const group of groups) {
      const inGroup = scrambled.filter(
        (card) => card.category === group.category
      )
      expect(group.cards.map((card) => card.id)).toEqual(
        inGroup.map((card) => card.id)
      )
    }
  })

  it("a keyword search returns only the groups with matches", () => {
    const groups = searchHelpGrouped("snooze")
    // The snooze card (Reading & organizing) and the shortcuts card
    // (Getting started — it documents the b binding) both match, so both
    // of their categories appear, in declared order.
    expect(groups.map((group) => group.category)).toEqual([
      "Getting started",
      "Reading & organizing",
    ])
    const reading = groups.find(
      (group) => group.category === "Reading & organizing"
    )
    expect(reading?.cards[0]?.id).toBe("snooze")
  })
})
