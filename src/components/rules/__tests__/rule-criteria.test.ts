import { describe, expect, it } from "vitest"

import {
  composeCriteriaQuery,
  criteriaFieldsFromQuery,
  emptyCriteriaFields,
  type CriteriaFields,
} from "../rule-criteria"

/** A form prefilled the way tests need; everything else stays empty. */
function fields(overrides: Partial<CriteriaFields> = {}): CriteriaFields {
  return { ...emptyCriteriaFields(), ...overrides }
}

describe("composeCriteriaQuery", () => {
  it("returns null when no field contributes a criterion", () => {
    expect(composeCriteriaQuery(emptyCriteriaFields())).toBeNull()
  })

  it("composes single-value operator rows", () => {
    expect(
      composeCriteriaQuery(fields({ from: "news@x.com", subject: "digest" }))
    ).toBe("from:news@x.com subject:digest")
  })

  it("splits comma values into repeated same-operator tokens", () => {
    expect(composeCriteriaQuery(fields({ from: "a@x.com, b@x.com" }))).toBe(
      "from:a@x.com from:b@x.com"
    )
  })

  it("quotes values containing whitespace", () => {
    expect(composeCriteriaQuery(fields({ from: "Alice Smith" }))).toBe(
      'from:"Alice Smith"'
    )
  })

  it("composes free text and prefixed doesn't-have terms", () => {
    expect(
      composeCriteriaQuery(
        fields({ hasWords: "invoice total", doesntHave: "unsubscribe" })
      )
    ).toBe("invoice total -unsubscribe")
  })

  it("composes size with the unit suffix and dates in ISO form", () => {
    expect(
      composeCriteriaQuery(
        fields({ sizeDirection: "larger", sizeValue: "25", sizeUnit: "mb" })
      )
    ).toBe("larger:25mb")
    expect(
      composeCriteriaQuery(
        fields({ sizeDirection: "smaller", sizeValue: "500", sizeUnit: "kb" })
      )
    ).toBe("smaller:500kb")
    expect(
      composeCriteriaQuery(
        fields({ dateDirection: "before", dateValue: "2026-01-31" })
      )
    ).toBe("before:2026-01-31")
    // an incomplete or non-positive size contributes nothing
    expect(composeCriteriaQuery(fields({ sizeValue: "abc" }))).toBeNull()
    expect(composeCriteriaQuery(fields({ sizeValue: "0" }))).toBeNull()
  })

  it("composes the has-attachment checkbox", () => {
    expect(composeCriteriaQuery(fields({ hasAttachment: true }))).toBe(
      "has:attachment"
    )
  })

  it("composes a full Gmail-dialog row set in field order", () => {
    expect(
      composeCriteriaQuery(
        fields({
          from: "boss@work.com",
          hasWords: "quarterly report",
          doesntHave: "fyi",
          sizeDirection: "larger",
          sizeValue: "10",
          sizeUnit: "mb",
          dateDirection: "after",
          dateValue: "2026-01-01",
          hasAttachment: true,
        })
      )
    ).toBe(
      "from:boss@work.com quarterly report -fyi larger:10mb after:2026-01-01 has:attachment"
    )
  })
})

describe("criteriaFieldsFromQuery", () => {
  it("round-trips simple operator queries into the form fields", () => {
    const { fields: mapped, unrepresentable } = criteriaFieldsFromQuery(
      "from:news@x.com to:me@x.com subject:digest invoice -unsubscribe has:attachment"
    )
    expect(unrepresentable).toBe(false)
    expect(mapped.from).toBe("news@x.com")
    expect(mapped.to).toBe("me@x.com")
    expect(mapped.subject).toBe("digest")
    expect(mapped.hasWords).toBe("invoice")
    expect(mapped.doesntHave).toBe("unsubscribe")
    expect(mapped.hasAttachment).toBe(true)
  })

  it("maps a single size and date bound with a friendly unit", () => {
    const size = criteriaFieldsFromQuery("larger:26214400") // 25 MB
    expect(size.unrepresentable).toBe(false)
    expect(size.fields.sizeDirection).toBe("larger")
    expect(size.fields.sizeValue).toBe("25")
    expect(size.fields.sizeUnit).toBe("mb")

    const kb = criteriaFieldsFromQuery("smaller:51200") // 50 KB
    expect(kb.fields.sizeDirection).toBe("smaller")
    expect(kb.fields.sizeValue).toBe("50")
    expect(kb.fields.sizeUnit).toBe("kb")

    const date = criteriaFieldsFromQuery("before:2026-01-31")
    expect(date.fields.dateDirection).toBe("before")
    expect(date.fields.dateValue).toBe("2026-01-31")
  })

  it("flags queries with no form representation verbatim", () => {
    for (const query of [
      "label:receipts",
      "is:unread",
      "-from:boss@x.com",
      "-is:starred",
      "from:a@x.com larger:1m smaller:2m",
      "before:2026-01-01 after:2026-02-01",
      "label:news from:a@x.com",
      // byte counts that are not whole KB would change value on re-compose
      "larger:1500",
      "smaller:1025",
      // zero drops the size token entirely on re-compose
      "larger:0",
    ]) {
      expect(criteriaFieldsFromQuery(query).unrepresentable).toBe(true)
    }
  })

  it("round-trips a whole-KB size bound exactly", () => {
    const { fields: mapped, unrepresentable } =
      criteriaFieldsFromQuery("smaller:1024")
    expect(unrepresentable).toBe(false)
    expect(mapped.sizeDirection).toBe("smaller")
    expect(mapped.sizeValue).toBe("1")
    expect(mapped.sizeUnit).toBe("kb")
    // the composed spelling is canonical; it parses to the same 1024 bytes
    expect(composeCriteriaQuery(mapped)).toBe("smaller:1kb")
  })

  it("still maps representable rows of a partially-mappable query", () => {
    const { fields: mapped } = criteriaFieldsFromQuery(
      "from:news@x.com label:receipts"
    )
    expect(mapped.from).toBe("news@x.com")
  })

  it("composes back to an equivalent query (compose ∘ parse round-trip)", () => {
    const query = "from:news@x.com subject:weekly digest -spam larger:5mb"
    const { fields: mapped } = criteriaFieldsFromQuery(query)
    expect(composeCriteriaQuery(mapped)).toBe(
      "from:news@x.com subject:weekly digest -spam larger:5mb"
    )
  })
})
