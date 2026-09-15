import { describe, expect, it } from "vitest"

import { isEmptyQuery, parseSearchQuery } from "../parser"

describe("parseSearchQuery", () => {
  it("returns an all-empty query for empty and whitespace-only input", () => {
    for (const input of ["", "   ", "\t\n  "]) {
      const parsed = parseSearchQuery(input)
      expect(parsed).toEqual({
        from: [],
        to: [],
        subject: [],
        labels: [],
        hasAttachment: false,
        isUnread: false,
        isStarred: false,
        freeText: [],
      })
      expect(isEmptyQuery(parsed)).toBe(true)
    }
  })

  it("splits free text into whitespace-separated AND-ed terms", () => {
    expect(parseSearchQuery("hello   world")).toMatchObject({
      freeText: ["hello", "world"],
    })
  })

  it("keeps a quoted phrase as one free-text term", () => {
    expect(parseSearchQuery('"annual report" q3')).toMatchObject({
      freeText: ["annual report", "q3"],
    })
  })

  it("parses value operators, keys case-insensitively", () => {
    expect(parseSearchQuery("from:alice")).toMatchObject({ from: ["alice"] })
    expect(parseSearchQuery("FROM:Alice@Corp.example")).toMatchObject({
      from: ["Alice@Corp.example"],
    })
    expect(parseSearchQuery("to:bob@corp.example")).toMatchObject({
      to: ["bob@corp.example"],
    })
    expect(parseSearchQuery("subject:invoice")).toMatchObject({
      subject: ["invoice"],
    })
    expect(parseSearchQuery("label:receipts")).toMatchObject({
      labels: ["receipts"],
    })
    // value keeps its own case; matching is the builder's concern
    expect(parseSearchQuery("SUBJECT:Q3")).toMatchObject({
      subject: ["Q3"],
    })
    // spaces need quotes: "Report" is a separate free-text term here
    expect(parseSearchQuery("subject:Q3 Report")).toMatchObject({
      subject: ["Q3"],
      freeText: ["Report"],
    })
  })

  it("respects quoted values, including around the value only", () => {
    expect(parseSearchQuery('from:"Alice Smith"')).toMatchObject({
      from: ["Alice Smith"],
    })
    expect(
      parseSearchQuery('to:"Bob Sample" subject:"annual report"')
    ).toMatchObject({
      to: ["Bob Sample"],
      subject: ["annual report"],
    })
    expect(parseSearchQuery('label:"Finance/Receipts"')).toMatchObject({
      labels: ["Finance/Receipts"],
    })
  })

  it("treats an unmatched quote as running to the end of input", () => {
    expect(parseSearchQuery('from:"Alice Smith')).toMatchObject({
      from: ["Alice Smith"],
    })
  })

  it("parses flag operators, keys and values case-insensitively", () => {
    expect(parseSearchQuery("has:attachment")).toMatchObject({
      hasAttachment: true,
    })
    expect(parseSearchQuery("HAS:Attachment")).toMatchObject({
      hasAttachment: true,
    })
    expect(parseSearchQuery("is:unread")).toMatchObject({ isUnread: true })
    expect(parseSearchQuery("is:starred")).toMatchObject({ isStarred: true })
    expect(parseSearchQuery("IS:Starred")).toMatchObject({ isStarred: true })
  })

  it("ANDs duplicated value operators by accumulating their values", () => {
    expect(parseSearchQuery("from:alice from:bob")).toMatchObject({
      from: ["alice", "bob"],
    })
    expect(parseSearchQuery("label:a subject:x subject:y")).toMatchObject({
      labels: ["a"],
      subject: ["x", "y"],
    })
  })

  it("collapses duplicated flags (AND with itself is idempotent)", () => {
    expect(parseSearchQuery("is:unread is:unread")).toMatchObject({
      isUnread: true,
    })
  })

  it("keeps unknown operator tokens as literal free text", () => {
    expect(parseSearchQuery("foo:bar")).toMatchObject({
      freeText: ["foo:bar"],
    })
    // known keys with unrecognized values stay literal too
    expect(parseSearchQuery("is:read has:file")).toMatchObject({
      isUnread: false,
      isStarred: false,
      hasAttachment: false,
      freeText: ["is:read", "has:file"],
    })
    // URLs are not mistaken for operators
    expect(parseSearchQuery("https://example.com")).toMatchObject({
      freeText: ["https://example.com"],
    })
  })

  it("drops bare operator keys with an empty value", () => {
    expect(parseSearchQuery("from: has:attachment")).toMatchObject({
      from: [],
      hasAttachment: true,
      freeText: [],
    })
    expect(parseSearchQuery('from:""')).toEqual({
      from: [],
      to: [],
      subject: [],
      labels: [],
      hasAttachment: false,
      isUnread: false,
      isStarred: false,
      freeText: [],
    })
  })

  it("parses the spec's combined-operators scenario", () => {
    expect(
      parseSearchQuery("from:alice has:attachment is:unread")
    ).toMatchObject({
      from: ["alice"],
      hasAttachment: true,
      isUnread: true,
      freeText: [],
    })
  })

  it("parses the spec's label scenario with mixed free text", () => {
    expect(parseSearchQuery("label:receipts invoice")).toMatchObject({
      labels: ["receipts"],
      freeText: ["invoice"],
    })
  })

  it("parses a fully mixed query", () => {
    expect(
      parseSearchQuery(
        'from:"Alice Smith" to:bob subject:report has:attachment ' +
          "is:starred label:Finance/receipts pizzazz"
      )
    ).toEqual({
      from: ["Alice Smith"],
      to: ["bob"],
      subject: ["report"],
      labels: ["Finance/receipts"],
      hasAttachment: true,
      isUnread: false,
      isStarred: true,
      freeText: ["pizzazz"],
    })
  })

  it("reports emptiness only when nothing usable remains", () => {
    expect(isEmptyQuery(parseSearchQuery("from:"))).toBe(true)
    expect(isEmptyQuery(parseSearchQuery("from:alice"))).toBe(false)
    expect(isEmptyQuery(parseSearchQuery("has:attachment"))).toBe(false)
    expect(isEmptyQuery(parseSearchQuery("zz"))).toBe(false)
  })
})
