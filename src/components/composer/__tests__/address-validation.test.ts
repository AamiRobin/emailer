import { describe, expect, it } from "vitest"

import {
  hasInvalidRecipient,
  isValidEmail,
  parseAddressInput,
  parseRecipient,
  parseRecipients,
  recipientLabel,
} from "../address-validation"

/**
 * Unit coverage for the composer's address validation (task 8.1). The
 * regex is pragmatic RFC-5322 (see module docstring) — these cases pin
 * down its deliberate edges: dot-atom local parts with + tags, domains
 * that need a dotted alphabetic TLD, and the display-name form.
 */

describe("isValidEmail", () => {
  it("accepts ordinary sendable addresses", () => {
    const valid = [
      "ada@example.com",
      "ada.lovelace@mail.example.com",
      "USER@EXAMPLE.COM",
      "user+tag@example.co",
      "o'hara@example.com",
      "a@b.co",
      "user@example.museum",
      " x@example.com ",
    ]
    for (const address of valid) {
      expect(isValidEmail(address), address).toBe(true)
    }
  })

  it("rejects malformed or non-sendable addresses", () => {
    const invalid = [
      "",
      "   ",
      "not-an-email",
      "missing-at.example.com",
      "two@at@example.com",
      "user@",
      "@example.com",
      "user @example.com",
      "us er@example.com",
      ".dot@example.com",
      "dot.@example.com",
      "dou..ble@example.com",
      "user@localhost",
      "user@hostless",
      "user@example.",
      "user@.example.com",
      "user@exam_ple.com",
      "user@-example.com",
      "user@example-.com",
      "user@example.c",
      "user@example..com",
      "user@192.168.0.1",
      '"quoted local"@example.com',
    ]
    for (const address of invalid) {
      expect(isValidEmail(address), address).toBe(false)
    }
  })
})

describe("parseAddressInput", () => {
  it("splits on commas, semicolons and whitespace", () => {
    expect(parseAddressInput("a@x.com, b@x.com; c@x.com d@x.com")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
      "d@x.com",
    ])
  })

  it("drops empty segments from trailing separators", () => {
    expect(parseAddressInput("  a@x.com, , ;\t")).toEqual(["a@x.com"])
    expect(parseAddressInput("")).toEqual([])
  })
})

describe("parseRecipient", () => {
  it("parses the display-name form", () => {
    expect(parseRecipient("Ada Lovelace <ada@example.com>")).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
    })
  })

  it("strips quotes around the display name", () => {
    expect(parseRecipient('"Ada, Lovelace" <ada@example.com>')).toEqual({
      name: "Ada, Lovelace",
      email: "ada@example.com",
    })
  })

  it("parses a bare address and keeps invalid text verbatim", () => {
    expect(parseRecipient("ada@example.com")).toEqual({
      email: "ada@example.com",
    })
    expect(parseRecipient("not an email")).toEqual({ email: "not an email" })
  })

  it("treats an empty display name as bare address", () => {
    expect(parseRecipient("<ada@example.com>")).toEqual({
      email: "ada@example.com",
    })
  })
})

describe("parseRecipients", () => {
  it("parses a mixed input line", () => {
    expect(
      parseRecipients("ada@example.com, Ada L <ada@lovelace.dev>, junk")
    ).toEqual([
      { email: "ada@example.com" },
      { name: "Ada L", email: "ada@lovelace.dev" },
      { email: "junk" },
    ])
  })
})

describe("recipientLabel", () => {
  it("prefers the display name and falls back to the address", () => {
    expect(recipientLabel({ name: "Ada", email: "ada@example.com" })).toBe(
      "Ada"
    )
    expect(recipientLabel({ email: "ada@example.com" })).toBe("ada@example.com")
  })
})

describe("hasInvalidRecipient", () => {
  it("flags lists containing any invalid address", () => {
    expect(
      hasInvalidRecipient([{ email: "ada@example.com" }, { email: "junk" }])
    ).toBe(true)
    expect(hasInvalidRecipient([{ email: "ada@example.com" }])).toBe(false)
    expect(hasInvalidRecipient([])).toBe(false)
  })
})
