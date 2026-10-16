import { describe, expect, it } from "vitest"

import {
  parseAuthResults,
  parseStoredAuthResults,
} from "../auth-results"

/**
 * Authentication-Results parsing contract (task 2.1/2.2, design D10).
 * parseAuthResults is the Gmail ingestion-side parser (Rust owns the same
 * grammar for IMAP/Graph in src-tauri/src/imap/auth_results.rs — the two
 * MUST stay in sync); parseStoredAuthResults is the single display-side
 * accessor the SPF/DKIM/DMARC badge reads through. The assertions below
 * pin the storage grammar (compact `spf=…;dkim=…;dmarc=…`, fixed order,
 * worst-wins consolidation) and the tri-state display folding.
 */
describe("parseAuthResults — ingestion consolidation", () => {
  it("emits the compact string in fixed spf→dkim→dmarc order", () => {
    expect(
      parseAuthResults(["dkim=pass header.d=example.com; dmarc=pass"])
    ).toBe("dkim=pass;dmarc=pass")
    expect(parseAuthResults(["dmarc=fail (p=quarantine)"])).toBe("dmarc=fail")
  })

  it("ignores unknown methods, per-method properties and comments", () => {
    expect(
      parseAuthResults([
        "example.com; auth=pass; spf=pass smtp.mailfrom=bounce@example.com",
      ])
    ).toBe("spf=pass")
  })

  it("returns undefined with no header at all", () => {
    expect(parseAuthResults([])).toBeUndefined()
    expect(parseAuthResults([undefined, undefined])).toBeUndefined()
  })

  it("returns undefined when a header evaluates none of the three mechanisms", () => {
    expect(parseAuthResults(["iprev=pass; arc=none"])).toBeUndefined()
  })

  it("folds unknown result tokens into none — never fabricates a verdict", () => {
    expect(parseAuthResults(["spf=frobnicated"])).toBe("spf=none")
  })

  it("consolidates multiple headers worst-wins, ties keep the first", () => {
    // A later hop downgrading an earlier pass must not be lost.
    expect(parseAuthResults(["spf=pass", "spf=fail"])).toBe("spf=fail")
    // An earlier fail is not overwritten by a later pass.
    expect(parseAuthResults(["spf=fail", "spf=pass"])).toBe("spf=fail")
    // Same verdict twice → first observation kept (identical string).
    expect(parseAuthResults(["dkim=pass", "dkin=pass", "dkim=pass"])).toBe(
      "dkim=pass"
    )
  })

  it("ranks the quasi-fail family between pass and fail, worst-wins", () => {
    expect(parseAuthResults(["spf=softfail", "spf=neutral"])).toBe(
      "spf=softfail"
    )
    expect(parseAuthResults(["spf=pass", "spf=softfail"])).toBe("spf=softfail")
    expect(parseAuthResults(["dmarc=temperror", "dmarc=fail"])).toBe(
      "dmarc=fail"
    )
  })

  it("is case-insensitive on both methods and results", () => {
    expect(
      parseAuthResults(["SPF=PASS smtp.mailfrom=x; DKIM=Fail header.d=y"])
    ).toBe("spf=pass;dkim=fail")
  })
})

describe("parseStoredAuthResults — display accessor", () => {
  it("parses the stored string into only the mechanisms present", () => {
    expect(parseStoredAuthResults("spf=pass;dkim=fail;dmarc=none")).toEqual({
      spf: "pass",
      dkim: "fail",
      dmarc: "none",
    })
    expect(parseStoredAuthResults("dmarc=pass")).toEqual({ dmarc: "pass" })
  })

  it("folds the quasi-fail family and unknown tokens into the neutral state", () => {
    expect(parseStoredAuthResults("spf=softfail")).toEqual({ spf: "none" })
    expect(parseStoredAuthResults("dkim=policy")).toEqual({ dkim: "none" })
  })

  it("returns null for null/empty/unparseable input", () => {
    expect(parseStoredAuthResults(null)).toBeNull()
    expect(parseStoredAuthResults(undefined)).toBeNull()
    expect(parseStoredAuthResults("")).toBeNull()
    expect(parseStoredAuthResults("garbage")).toBeNull()
    expect(parseStoredAuthResults("iprev=pass")).toBeNull()
  })

  it("tolerates whitespace and keeps the first duplicate mechanism", () => {
    expect(parseStoredAuthResults(" spf=pass ;\nspf=fail ")).toEqual({
      spf: "pass",
    })
  })

  it("round-trips the ingestion output", () => {
    const stored = parseAuthResults([
      "dkim=temperror header.d=example.org",
      "spf=fail",
    ])
    expect(stored).toBe("spf=fail;dkim=temperror")
    expect(parseStoredAuthResults(stored!)).toEqual({
      spf: "fail",
      dkim: "none",
    })
  })
})
