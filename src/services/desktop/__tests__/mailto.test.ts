import { describe, expect, it } from "vitest"

import {
  mailtoBodyToHtml,
  parseMailto,
} from "@/services/desktop/mailto"

/**
 * Mailto parsing tests (task 1.4): RFC 6068 shape, lenient decoding, and
 * the non-mailto passthrough the composer prefill leans on.
 */

describe("parseMailto", () => {
  it("returns null for non-mailto URLs", () => {
    expect(parseMailto("https://example.com")).toBeNull()
    expect(parseMailto("not a url at all")).toBeNull()
  })

  it("parses a bare recipient", () => {
    expect(parseMailto("mailto:jane@example.com")).toEqual({
      to: [{ email: "jane@example.com" }],
      cc: [],
      bcc: [],
      subject: null,
      body: null,
    })
  })

  it("parses subject and body with percent-encoded characters", () => {
    const draft = parseMailto(
      "mailto:jane@example.com?subject=Hi%20there&body=Line%201%0ALine%202%20%26%20%3Cdone%3E"
    )
    expect(draft?.subject).toBe("Hi there")
    expect(draft?.body).toBe("Line 1\nLine 2 & <done>")
  })

  it("keeps + literal per RFC 6068 (no form decoding)", () => {
    expect(parseMailto("mailto:jane@example.com?subject=a+b")?.subject).toBe(
      "a+b"
    )
  })

  it("parses cc and bcc with multiple comma-separated addresses", () => {
    const draft = parseMailto(
      "mailto:to@example.com?cc=c1@example.com,c2@example.com&bcc=hidden@example.com"
    )
    expect(draft?.to).toEqual([{ email: "to@example.com" }])
    expect(draft?.cc).toEqual([
      { email: "c1@example.com" },
      { email: "c2@example.com" },
    ])
    expect(draft?.bcc).toEqual([{ email: "hidden@example.com" }])
  })

  it("fills to from the ?to= header too (lenient)", () => {
    const draft = parseMailto("mailto:?to=a@example.com&subject=x")
    expect(draft?.to).toEqual([{ email: "a@example.com" }])
    expect(draft?.subject).toBe("x")
  })

  it("matches header names case-insensitively", () => {
    const draft = parseMailto("mailto:a@example.com?SUBJECT=Caps&BODY=Body")
    expect(draft?.subject).toBe("Caps")
    expect(draft?.body).toBe("Body")
  })

  it("drops address segments that do not name a mailbox", () => {
    const draft = parseMailto("mailto:jane@example.com,not-an-address")
    expect(draft?.to).toEqual([{ email: "jane@example.com" }])
  })

  it("parses a bare mailto: to an empty draft", () => {
    expect(parseMailto("mailto:")).toEqual({
      to: [],
      cc: [],
      bcc: [],
      subject: null,
      body: null,
    })
  })

  it("ignores unknown headers instead of failing", () => {
    const draft = parseMailto(
      "mailto:a@example.com?subject=s&in-reply-to=%3Cabc%3E"
    )
    expect(draft?.subject).toBe("s")
  })

  it("keeps a literal % when the escape is invalid (WHATWG fallback)", () => {
    expect(parseMailto("mailto:a@example.com?subject=100% done")?.subject).toBe(
      "100% done"
    )
  })
})

describe("mailtoBodyToHtml", () => {
  it("escapes HTML and converts newlines to <br>", () => {
    expect(mailtoBodyToHtml("Hi <b>there</b>\nBye")).toBe(
      "Hi &lt;b&gt;there&lt;/b&gt;<br>Bye"
    )
  })

  it("normalizes CRLF to a single <br>", () => {
    expect(mailtoBodyToHtml("a\r\nb")).toBe("a<br>b")
  })
})
