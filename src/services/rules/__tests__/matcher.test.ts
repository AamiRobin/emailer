import { describe, expect, it } from "vitest"

import { messageMatchesCriteria, parseRuleCriteria } from "../criteria"
import type { IngestionEvent } from "../ingestion"

/**
 * Criteria matching for rules (task 11.2): the search parser's operator
 * language evaluated per message in JS (the ingestion substrate — see
 * criteria.ts). Covers each operator, the OR-within-operator /
 * AND-across-operators combination rule, label leaf matching and
 * case-insensitivity, plus the criteria_json parsing tolerance.
 */

/** A fully-populated arrival event; tests override the fields under test. */
function event(overrides: Partial<IngestionEvent> = {}): IngestionEvent {
  return {
    messageRowId: "m1",
    threadId: "t1",
    fromAddress: "sender@example.com",
    fromName: "Alice Sender",
    toJson: JSON.stringify([{ email: "me@example.com" }]),
    ccJson: JSON.stringify([{ name: "Bob", email: "bob@example.com" }]),
    bccJson: null,
    subject: "Quarterly report",
    snippet: "The numbers are in and attached",
    labelNames: ["INBOX", "Finance/Receipts"],
    isRead: false,
    isStarred: false,
    hasAttachments: false,
    sizeEstimate: null,
    date: 1_700_000_000,
    threadHasUserMessage: false,
    isMailingList: false,
    ...overrides,
  }
}

/** Parse a raw query through the stored-criteria path and match. */
function matches(query: string, message: IngestionEvent): boolean {
  const parsed = parseRuleCriteria(JSON.stringify({ query }))
  expect(parsed).not.toBeNull()
  return messageMatchesCriteria(message, parsed!)
}

describe("rule criteria parsing", () => {
  it("parses the canonical {query} wrapper", () => {
    const parsed = parseRuleCriteria(JSON.stringify({ query: "from:a@x" }))
    expect(parsed?.from).toEqual(["a@x"])
  })

  it("tolerates a bare JSON string", () => {
    const parsed = parseRuleCriteria(JSON.stringify("is:unread"))
    expect(parsed?.isUnread).toBe(true)
  })

  it("returns null (no match) for corrupt JSON, wrong shapes and empty queries", () => {
    expect(parseRuleCriteria("not json")).toBeNull()
    expect(parseRuleCriteria("42")).toBeNull()
    expect(parseRuleCriteria(JSON.stringify({ query: 5 }))).toBeNull()
    // A criteria-less rule must never fire on every message.
    expect(parseRuleCriteria(JSON.stringify({ query: "" }))).toBeNull()
    expect(parseRuleCriteria(JSON.stringify({ query: "from:" }))).toBeNull()
  })
})

describe("rule criteria matching", () => {
  it("from: matches the address substring case-insensitively", () => {
    expect(matches("from:example.com", event())).toBe(true)
    expect(matches("from:SENDER@Example.COM", event())).toBe(true)
    expect(matches("from:other@x.com", event())).toBe(false)
  })

  it("from: matches the display name too", () => {
    expect(matches("from:alice", event())).toBe(true)
    expect(matches('from:"Alice Sender"', event())).toBe(true)
    expect(matches("from:bob", event())).toBe(false)
  })

  it("multiple values of the same operator are OR-ed", () => {
    expect(matches("from:a@x.com from:sender@example.com", event())).toBe(true)
    expect(matches("from:a@x.com from:b@x.com", event())).toBe(false)
    expect(matches("subject:report subject:digest", event())).toBe(true)
  })

  it("different operators are AND-ed", () => {
    expect(matches("from:sender@example.com subject:report", event())).toBe(
      true
    )
    expect(matches("from:sender@example.com subject:digest", event())).toBe(
      false
    )
    expect(matches("from:other@x.com subject:report", event())).toBe(false)
  })

  it("to: matches to/cc/bcc recipient JSON (names and addresses)", () => {
    expect(matches("to:me@example.com", event())).toBe(true)
    expect(matches("to:bob@example.com", event())).toBe(true)
    expect(matches("to:Bob", event())).toBe(true)
    expect(matches("to:nobody@x.com", event())).toBe(false)
    // The recipient arrays, not the sender, are the searched columns.
    expect(matches("to:sender@example.com", event())).toBe(false)
  })

  it("subject: is a case-insensitive substring", () => {
    expect(matches("subject:QUARTERLY", event())).toBe(true)
    expect(matches("subject:rter", event())).toBe(true)
    expect(matches("subject:invoice", event())).toBe(false)
  })

  it("label: matches a full label name exactly, case-insensitively", () => {
    expect(matches("label:INBOX", event())).toBe(true)
    expect(matches("label:finance/receipts", event())).toBe(true)
    expect(matches("label:receipt", event())).toBe(false)
  })

  it("label: addresses the trailing leaf of a hierarchical label", () => {
    expect(matches("label:receipts", event())).toBe(true)
    // But not a mid-path or prefix segment.
    expect(matches("label:finance", event())).toBe(false)
    expect(matches("label:cipients", event())).toBe(false)
  })

  it("label: matches the imap folder path (the folder label's name)", () => {
    expect(
      matches("label:newsletters", event({ labelNames: ["Newsletters"] }))
    ).toBe(true)
    expect(
      matches("label:archive/2024", event({ labelNames: ["Archive/2024"] }))
    ).toBe(true)
  })

  it("has:attachment matches the inserted message's attachment flag", () => {
    expect(matches("has:attachment", event())).toBe(false)
    expect(matches("has:attachment", event({ hasAttachments: true }))).toBe(
      true
    )
  })

  it("is:unread matches an unread arrival, is:starred a flagged one", () => {
    expect(matches("is:unread", event())).toBe(true)
    expect(matches("is:unread", event({ isRead: true }))).toBe(false)
    expect(matches("is:starred", event())).toBe(false)
    expect(matches("is:starred", event({ isStarred: true }))).toBe(true)
  })

  it("free text matches the subject or the snippet, AND across terms", () => {
    expect(matches("numbers", event())).toBe(true)
    expect(matches("quarterly", event())).toBe(true)
    expect(matches('"numbers are in"', event())).toBe(true)
    expect(matches("quarterly numbers", event())).toBe(true)
    expect(matches("quarterly unicorns", event())).toBe(false)
  })
})

describe("rule criteria negation, size and dates", () => {
  it("a negated operator excludes matching messages", () => {
    expect(matches("-from:other@x.com", event())).toBe(true)
    expect(matches("-from:sender@example.com", event())).toBe(false)
    // negation composes inside a positive conjunction
    expect(matches("from:example.com -subject:invoice", event())).toBe(true)
    expect(matches("from:example.com -subject:report", event())).toBe(false)
  })

  it("negated values of one operator OR together", () => {
    expect(matches("-from:a@x.com -from:b@x.com", event())).toBe(true)
    expect(matches("-from:a@x.com -from:sender@example.com", event())).toBe(
      false
    )
  })

  it("negated flags and labels exclude like their positive forms", () => {
    expect(matches("-has:attachment", event())).toBe(true)
    expect(matches("-has:attachment", event({ hasAttachments: true }))).toBe(
      false
    )
    expect(matches("-is:starred", event())).toBe(true)
    expect(matches("-is:starred", event({ isStarred: true }))).toBe(false)
    expect(matches("-is:unread", event())).toBe(false)
    expect(matches("-label:receipts", event())).toBe(false)
    expect(matches("-label:newsletters", event())).toBe(true)
    // the leaf convention carries over: -label:receipts excludes
    // Finance/Receipts too
    expect(matches("-label:finance/receipts", event())).toBe(false)
  })

  it("negated free text excludes subject and snippet hits", () => {
    expect(matches("-unicorns", event())).toBe(true)
    expect(matches("-numbers", event())).toBe(false)
    expect(matches('-"numbers are in"', event())).toBe(false)
    expect(matches("-unicorns quarterly", event())).toBe(true)
    expect(matches("-numbers quarterly", event())).toBe(false)
  })

  it("larger:/smaller: compare the message's own size estimate", () => {
    expect(matches("larger:10m", event())).toBe(false)
    expect(
      matches("larger:10m", event({ sizeEstimate: 20 * 1024 * 1024 }))
    ).toBe(true)
    expect(matches("smaller:1m", event({ sizeEstimate: 500 }))).toBe(true)
    expect(
      matches("smaller:1m", event({ sizeEstimate: 20 * 1024 * 1024 }))
    ).toBe(false)
    // both bounds must hold
    expect(
      matches(
        "larger:1m smaller:100m",
        event({ sizeEstimate: 5 * 1024 * 1024 })
      )
    ).toBe(true)
    expect(
      matches("larger:1m smaller:2m", event({ sizeEstimate: 5 * 1024 * 1024 }))
    ).toBe(false)
    // an unsized message satisfies neither size operator
    expect(matches("smaller:1m", event({ sizeEstimate: null }))).toBe(false)
    // size composes with the rest of the conjunction
    expect(
      matches("from:example.com smaller:1m", event({ sizeEstimate: 4096 }))
    ).toBe(true)
  })

  it("before:/after: compare the message's date around UTC midnight", () => {
    expect(matches("before:2100-01-01", event())).toBe(true)
    expect(matches("after:2023-11-14", event())).toBe(true)
    expect(matches("before:2000-01-01", event())).toBe(false)
    // a message late on the boundary day is inside after: and inside
    // before:'s next-day boundary — the pair tiles time without gaps
    const lateOnDay = Date.UTC(2023, 10, 14, 23, 59) / 1000
    expect(matches("after:2023-11-14", event({ date: lateOnDay }))).toBe(true)
    expect(matches("before:2023-11-15", event({ date: lateOnDay }))).toBe(true)
    expect(matches("after:2023-11-15", event({ date: lateOnDay }))).toBe(false)
    expect(
      matches(
        "before:2023-11-15",
        event({ date: Date.UTC(2023, 10, 15) / 1000 })
      )
    ).toBe(false)
  })

  it("a negation-only criteria matches everything except the excluded set", () => {
    expect(matches("-from:other@x.com", event())).toBe(true)
    expect(matches("-from:sender@example.com", event())).toBe(false)
  })
})
