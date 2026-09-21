import { describe, expect, it } from "vitest"

import { isEmptyQuery, parseSearchQuery, usesOperators } from "../parser"

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
        larger: [],
        smaller: [],
        before: [],
        after: [],
        negatedLarger: [],
        negatedSmaller: [],
        negatedBefore: [],
        negatedAfter: [],
        negatedFrom: [],
        negatedTo: [],
        negatedSubject: [],
        negatedLabels: [],
        negatedFreeText: [],
        negatedFlags: {
          hasAttachment: false,
          isUnread: false,
          isStarred: false,
        },
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
      larger: [],
      smaller: [],
      before: [],
      after: [],
      negatedLarger: [],
      negatedSmaller: [],
      negatedBefore: [],
      negatedAfter: [],
      negatedFrom: [],
      negatedTo: [],
      negatedSubject: [],
      negatedLabels: [],
      negatedFreeText: [],
      negatedFlags: { hasAttachment: false, isUnread: false, isStarred: false },
    })
  })

  it("parses negated value operators and flags", () => {
    expect(parseSearchQuery("-from:a@x -to:b@y -subject:z -label:l")).toEqual(
      expect.objectContaining({
        negatedFrom: ["a@x"],
        negatedTo: ["b@y"],
        negatedSubject: ["z"],
        negatedLabels: ["l"],
        from: [],
      })
    )
    expect(parseSearchQuery("-has:attachment -is:unread -IS:Starred")).toEqual(
      expect.objectContaining({
        negatedFlags: { hasAttachment: true, isUnread: true, isStarred: true },
      })
    )
    // the minus is syntax, not content: values keep their own text
    expect(parseSearchQuery("-from:Alice")).toMatchObject({
      negatedFrom: ["Alice"],
    })
  })

  it("parses negated free text, including quoted phrases", () => {
    expect(parseSearchQuery('-term -"annual report" word')).toMatchObject({
      negatedFreeText: ["term", "annual report"],
      freeText: ["word"],
    })
  })

  it("keeps degenerate negation tokens as literal positive text", () => {
    // a bare `-` carries no literal text to keep
    expect(parseSearchQuery("- word")).toMatchObject({ freeText: ["word"] })
    expect(parseSearchQuery("-")).toMatchObject({ freeText: [] })
    // no double negation: `--a` excludes the literal text `-a`
    expect(parseSearchQuery("--a")).toMatchObject({
      negatedFreeText: ["-a"],
    })
  })

  it("degrades unknown negated operators to negated literal text", () => {
    expect(parseSearchQuery("-is:read -foo:bar")).toMatchObject({
      negatedFreeText: ["is:read", "foo:bar"],
    })
  })

  it("parses size operators with k/m suffixes, bytes bare", () => {
    expect(parseSearchQuery("larger:10m smaller:500k larger:42")).toEqual(
      expect.objectContaining({
        larger: [10 * 1024 * 1024, 42],
        smaller: [500 * 1024],
      })
    )
    // the -b spellings the rules form composes parse the same way
    expect(parseSearchQuery("larger:10mb smaller:500kb")).toEqual(
      expect.objectContaining({
        larger: [10 * 1024 * 1024],
        smaller: [500 * 1024],
      })
    )
    // case-insensitive suffix, fractional counts allowed
    expect(parseSearchQuery("smaller:1.5M")).toMatchObject({
      smaller: [Math.round(1.5 * 1024 * 1024)],
    })
    // unparseable values degrade to free text
    expect(parseSearchQuery("larger:abc smaller:")).toMatchObject({
      larger: [],
      smaller: [],
      freeText: ["larger:abc"],
    })
  })

  it("parses date operators in both calendar formats, UTC-anchored", () => {
    expect(parseSearchQuery("before:2026-01-01 after:2025/06/15")).toEqual(
      expect.objectContaining({
        before: [Date.UTC(2026, 0, 1) / 1000],
        after: [Date.UTC(2025, 5, 15) / 1000],
      })
    )
    // unparseable or impossible dates degrade to free text (no rollover)
    expect(
      parseSearchQuery("before:2026-02-31 before:junk after:")
    ).toMatchObject({
      before: [],
      after: [],
      freeText: ["before:2026-02-31", "before:junk"],
    })
  })

  it("parses negated size and date operators", () => {
    expect(
      parseSearchQuery(
        "-larger:10m -smaller:500k -before:2026-01-01 -after:2025/06/15"
      )
    ).toMatchObject({
      negatedLarger: [10 * 1024 * 1024],
      negatedSmaller: [500 * 1024],
      negatedBefore: [Date.UTC(2026, 0, 1) / 1000],
      negatedAfter: [Date.UTC(2025, 5, 15) / 1000],
      negatedFreeText: [],
    })
    // unparseable negated values degrade to negated literal text, like
    // every other operator
    expect(parseSearchQuery("-larger:abc -before:junk")).toMatchObject({
      negatedLarger: [],
      negatedBefore: [],
      negatedFreeText: ["larger:abc", "before:junk"],
    })
    // negation-only size/date queries are NOT empty
    expect(isEmptyQuery(parseSearchQuery("-larger:5m"))).toBe(false)
    expect(isEmptyQuery(parseSearchQuery("-before:2026-01-01"))).toBe(false)
  })

  it("treats negation-only queries as non-empty predicates", () => {
    expect(isEmptyQuery(parseSearchQuery("-from:a@x"))).toBe(false)
    expect(isEmptyQuery(parseSearchQuery("-is:unread"))).toBe(false)
    expect(isEmptyQuery(parseSearchQuery("-zz"))).toBe(false)
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
      larger: [],
      smaller: [],
      before: [],
      after: [],
      negatedLarger: [],
      negatedSmaller: [],
      negatedBefore: [],
      negatedAfter: [],
      negatedFrom: [],
      negatedTo: [],
      negatedSubject: [],
      negatedLabels: [],
      negatedFreeText: [],
      negatedFlags: { hasAttachment: false, isUnread: false, isStarred: false },
    })
  })

  it("reports emptiness only when nothing usable remains", () => {
    expect(isEmptyQuery(parseSearchQuery("from:"))).toBe(true)
    expect(isEmptyQuery(parseSearchQuery("from:alice"))).toBe(false)
    expect(isEmptyQuery(parseSearchQuery("has:attachment"))).toBe(false)
    expect(isEmptyQuery(parseSearchQuery("zz"))).toBe(false)
  })
})

describe("usesOperators (task 1.3: the relaxed fallback's rewrite gate)", () => {
  it("is false for pure free text, quoted or not", () => {
    expect(usesOperators(parseSearchQuery("banking report"))).toBe(false)
    expect(usesOperators(parseSearchQuery('"annual report" budget'))).toBe(
      false
    )
    // accented input does not make an operator
    expect(usesOperators(parseSearchQuery("bé dọn dẹp"))).toBe(false)
  })

  it("is false for a negation-only free-text query", () => {
    expect(usesOperators(parseSearchQuery("-spam"))).toBe(false)
  })

  it("sees every positive operator", () => {
    for (const query of [
      "from:maria banking",
      "to:bob",
      "subject:invoice",
      "label:receipts",
      "has:attachment",
      "is:unread",
      "is:starred",
      "larger:10m",
      "smaller:500k",
      "before:2026-01-01",
      "after:2025-01-01",
    ]) {
      expect(usesOperators(parseSearchQuery(query)), query).toBe(true)
    }
  })

  it("sees negated operators too — they are operators", () => {
    for (const query of [
      "-from:maria",
      "-is:unread report",
      "-has:attachment",
      "-before:2026-01-01",
    ]) {
      expect(usesOperators(parseSearchQuery(query)), query).toBe(true)
    }
  })

  it("is false when an unknown key degrades to free text", () => {
    // `foo:bar` is searched as the literal text it spells — no operator
    // predicate, so an otherwise-term-free query may still fall back.
    expect(usesOperators(parseSearchQuery("foo:bar"))).toBe(false)
  })
})
