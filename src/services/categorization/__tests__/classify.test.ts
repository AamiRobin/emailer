import { describe, expect, it } from "vitest"

import {
  CATEGORIES,
  classifyMessage,
  classifyWithTier,
  parseCategory,
  type Category,
  type ClassifyMessageInput,
} from "../classify"

/**
 * The pure rule-engine classifier (task 3.3, design D4): one test per
 * heuristic (list headers, auto-generated markers, the no-reply sender
 * signal, the IMAP subject-tag approximation) plus the precedence-order
 * tests the task calls for (List-Id beats Auto-Submitted, user decisions
 * beat heuristics, header evidence beats learned sender rows).
 */

function classify(overrides: Partial<ClassifyMessageInput>): Category {
  return classifyMessage({
    senderEmail: "ada@example.com",
    subject: "Hello",
    headers: {},
    ...overrides,
  })
}

describe("per-heuristic classification", () => {
  it("defaults a personal message to primary", () => {
    expect(classify({})).toBe("primary")
    expect(classifyMessage({})).toBe("primary")
  })

  it("classifies List-Id mail as newsletters", () => {
    expect(
      classify({
        headers: { "list-id": "<sqlite-dev.digest.example>" },
      })
    ).toBe("newsletters")
  })

  it("classifies List-Unsubscribe mail as newsletters", () => {
    expect(
      classify({
        headers: {
          "list-unsubscribe":
            "<https://list.example/unsub>, <mailto:unsub@list.example>",
        },
      })
    ).toBe("newsletters")
  })

  it("treats List-Unsubscribe-Post ALONE as not a list signal", () => {
    // Documented decision (task 3.3): the task names List-Id/List-
    // Unsubscribe as the newsletter markers; the one-click companion
    // header without either does not classify on its own.
    expect(
      classify({
        headers: { "list-unsubscribe-post": "List-Unsubscribe=One-Click" },
      })
    ).toBe("primary")
  })

  it("ignores blank list header values", () => {
    expect(classify({ headers: { "list-id": "   " } })).toBe("primary")
  })

  it("classifies Auto-Submitted auto-generated/auto-replied as updates", () => {
    expect(
      classify({ headers: { "auto-submitted": "auto-generated" } })
    ).toBe("updates")
    expect(
      classify({ headers: { "auto-submitted": "auto-replied (bounced)" } })
    ).toBe("updates")
  })

  it("treats Auto-Submitted: no (explicit user-generated) as no signal", () => {
    expect(classify({ headers: { "auto-submitted": "no" } })).toBe("primary")
    expect(classify({ headers: { "auto-submitted": "NO" } })).toBe("primary")
    // An empty value carries no verdict either.
    expect(classify({ headers: { "auto-submitted": "" } })).toBe("primary")
  })

  it("classifies the bulk Precedence values as updates", () => {
    for (const value of ["bulk", "list", "bulk_mail", "BULK"]) {
      expect(classify({ headers: { precedence: value } })).toBe("updates")
    }
  })

  it("leaves other Precedence values alone", () => {
    expect(
      classify({ headers: { precedence: "first-class" } })
    ).toBe("primary")
    expect(classify({ headers: { precedence: "special-delivery" } })).toBe(
      "primary"
    )
  })

  it("classifies no-reply senders as updates across separator styles", () => {
    for (const sender of [
      "noreply@github.com",
      "no-reply@service.example",
      "no.reply@service.example",
      "Donotreply@News.example",
      "do_not_reply@x.example",
    ]) {
      expect(classify({ senderEmail: sender })).toBe("updates")
    }
  })

  it("does not treat ordinary senders as machine senders", () => {
    expect(classify({ senderEmail: "news@x.example" })).toBe("primary")
    expect(classify({ senderEmail: "reply+i-123@x.example" })).toBe("primary")
    expect(classify({ senderEmail: null })).toBe("primary")
  })

  it("matches headers case-insensitively (tolerant of unnormalized keys)", () => {
    expect(
      classify({ headers: { "List-Id": "<x.example>" } })
    ).toBe("newsletters")
    expect(classify({ headers: { "Precedence": "bulk" } })).toBe("updates")
  })

  it("classifies the IMAP [list-tag] subject prefix as newsletters", () => {
    // The same approximation IngestionEvent.isMailingList uses — the IMAP
    // wire surface exposes no List-Id/Precedence (see rules/ingestion.ts).
    expect(classify({ subject: "[rust-announce] 1.70 released" })).toBe(
      "newsletters"
    )
    // A tag deeper in the subject is not a prefix signal.
    expect(classify({ subject: "Re: [rust-announce] 1.70 released" })).toBe(
      "primary"
    )
  })
})

describe("precedence order", () => {
  it("List-Id beats the bulk markers (a digest stays a newsletter)", () => {
    expect(
      classify({
        headers: {
          "list-id": "<dev.example>",
          "auto-submitted": "auto-generated",
          precedence: "bulk",
        },
      })
    ).toBe("newsletters")
  })

  it("List-Unsubscribe beats a no-reply sender", () => {
    expect(
      classify({
        senderEmail: "noreply@list.example",
        headers: { "list-unsubscribe": "<https://list.example/u>" },
      })
    ).toBe("newsletters")
  })

  it("a user rule naming a category beats every header heuristic", () => {
    expect(
      classify({
        ruleCategory: "social",
        headers: {
          "list-id": "<x.example>",
          "auto-submitted": "auto-generated",
        },
      })
    ).toBe("social")
  })

  it("a user-rule category beats a user sender override", () => {
    expect(
      classify({
        ruleCategory: "promotions",
        senderOverride: { category: "updates", source: "user" },
      })
    ).toBe("promotions")
  })

  it("a user 'always from sender' override beats the header heuristics", () => {
    // The spec's override scenario: moving a List-Id sender's mail to
    // Promotions with "always" must make future mail Promotions — so the
    // 'user'-source row ranks with the user rules, above the headers.
    expect(
      classify({
        senderOverride: { category: "promotions", source: "user" },
        headers: { "list-id": "<deals.example>" },
      })
    ).toBe("promotions")
  })

  it("header evidence beats a learned (heuristic/ai) sender row", () => {
    // D4 puts the sender-override lookup after the header heuristics —
    // only learned rows rank there; direct header evidence wins.
    expect(
      classify({
        senderOverride: { category: "promotions", source: "heuristic" },
        headers: { "list-id": "<x.example>" },
      })
    ).toBe("newsletters")
    expect(
      classify({
        senderOverride: { category: "social", source: "ai" },
        headers: { "auto-submitted": "auto-generated" },
      })
    ).toBe("updates")
  })

  it("a learned sender row beats the weak subject-tag approximation", () => {
    expect(
      classify({
        senderOverride: { category: "updates", source: "heuristic" },
        subject: "[list-tag] digest",
      })
    ).toBe("updates")
    // No override: the tag still resolves to newsletters.
    expect(classify({ subject: "[list-tag] digest" })).toBe("newsletters")
  })

  it("promotions/social are reachable only through user decisions", () => {
    // No deterministic local heuristic targets them (the spec names only
    // list/auto-generated markers) — rules and overrides are the path.
    expect(classify({ ruleCategory: "promotions" })).toBe("promotions")
    expect(classify({ ruleCategory: "social" })).toBe("social")
    expect(
      classify({ senderOverride: { category: "promotions", source: "user" } })
    ).toBe("promotions")
  })
})

describe("category values", () => {
  it("exposes the five spec categories in storage order", () => {
    expect(CATEGORIES).toEqual([
      "primary",
      "updates",
      "promotions",
      "social",
      "newsletters",
    ])
  })

  it("parseCategory passes the closed set and nulls everything else", () => {
    for (const category of CATEGORIES) {
      expect(parseCategory(category)).toBe(category)
    }
    expect(parseCategory(null)).toBeNull()
    expect(parseCategory(undefined)).toBeNull()
    expect(parseCategory("")).toBeNull()
    expect(parseCategory("Primary")).toBeNull()
    expect(parseCategory("inbox")).toBeNull()
  })
})

describe("classifyWithTier (task 4.9: the AI-assist routing tag)", () => {
  /**
   * The assist may consult the provider ONLY for tier "default" — the
   * nothing-decided slot after every local tier. These tests pin each
   * tier's tag so the ingestion wiring cannot silently widen that slot.
   */
  it("tags every tier the precedence produces", () => {
    expect(
      classifyWithTier({ ruleCategory: "updates" })
    ).toEqual({ category: "updates", tier: "rule" })
    expect(
      classifyWithTier({
        senderOverride: { category: "promotions", source: "user" },
      })
    ).toEqual({ category: "promotions", tier: "user-override" })
    expect(
      classifyWithTier({ headers: { "list-id": "<x.example>" } })
    ).toEqual({ category: "newsletters", tier: "list-header" })
    expect(
      classifyWithTier({ headers: { "list-unsubscribe": "<u>" } })
    ).toEqual({ category: "newsletters", tier: "list-header" })
    expect(
      classifyWithTier({ headers: { "auto-submitted": "auto-generated" } })
    ).toEqual({ category: "updates", tier: "auto-generated" })
    expect(classifyWithTier({ headers: { precedence: "bulk" } })).toEqual({
      category: "updates",
      tier: "auto-generated",
    })
    expect(classifyWithTier({ senderEmail: "noreply@x.example" })).toEqual({
      category: "updates",
      tier: "auto-generated",
    })
    expect(
      classifyWithTier({
        senderOverride: { category: "social", source: "ai" },
      })
    ).toEqual({ category: "social", tier: "learned-override" })
    expect(classifyWithTier({ subject: "[tag] digest" })).toEqual({
      category: "newsletters",
      tier: "subject-tag",
    })
    expect(classifyWithTier({})).toEqual({ category: "primary", tier: "default" })
  })

  it("a learned row that says 'primary' is decided, not default", () => {
    // Somebody (the backfill or a previous AI call) decided primary for
    // this sender — the assist must NOT re-ask over the row.
    expect(
      classifyWithTier({
        senderOverride: { category: "primary", source: "heuristic" },
      })
    ).toEqual({ category: "primary", tier: "learned-override" })
  })

  it("classifyMessage stays the category-only view (pinned signature)", () => {
    expect(classifyMessage({})).toBe("primary")
    expect(
      classifyMessage({
        ruleCategory: "promotions",
        headers: { "list-id": "<x.example>" },
      })
    ).toBe("promotions")
  })
})
