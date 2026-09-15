import { describe, expect, it } from "vitest"

import { renderPlainTextAsHtml } from "../plain-text"

describe("renderPlainTextAsHtml", () => {
  it("escapes HTML special characters so payloads render inert", () => {
    const out = renderPlainTextAsHtml(
      '<script>alert("x")</script> & <b>bold</b>'
    )
    expect(out).not.toContain("<script")
    expect(out).not.toContain("<b>")
    expect(out).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;")
    expect(out).toContain("&amp; &lt;b&gt;bold&lt;/b&gt;")
  })

  it("wraps the body in a pre-wrap marker div that survives sanitization", () => {
    const out = renderPlainTextAsHtml("line1\nline2\n\nline4")
    expect(out).toBe("<div data-emailer-plaintext>line1\nline2\n\nline4</div>")
  })

  it("linkifies http and https URLs with external-open attributes", () => {
    const out = renderPlainTextAsHtml("see https://example.com/a?b=1 today")
    expect(out).toBe(
      '<div data-emailer-plaintext>see <a href="https://example.com/a?b=1" ' +
        'target="_blank" rel="noopener noreferrer">https://example.com/a?b=1</a> today</div>'
    )
  })

  it("linkifies bare www hosts with an absolute https href", () => {
    const out = renderPlainTextAsHtml("go to www.example.com/path ok")
    expect(out).toContain('href="https://www.example.com/path"')
    expect(out).toContain(">www.example.com/path</a> ok")
  })

  it("does not swallow trailing punctuation into the link", () => {
    const out = renderPlainTextAsHtml("call (see https://example.com/x.) done")
    expect(out).toContain('href="https://example.com/x"')
    expect(out).toContain("https://example.com/x</a>.")
  })

  it("keeps ampersands in querystrings (escaped for the href attribute)", () => {
    const out = renderPlainTextAsHtml("https://x.com/?a=1&b=2")
    expect(out).toContain('href="https://x.com/?a=1&amp;b=2"')
  })

  it("linkifies multiple URLs in one body", () => {
    const out = renderPlainTextAsHtml("https://one.example and www.two.example")
    expect(out.match(/<a /g)).toHaveLength(2)
  })

  it("handles empty and whitespace-only bodies", () => {
    expect(renderPlainTextAsHtml("")).toBe("<div data-emailer-plaintext></div>")
    expect(renderPlainTextAsHtml("  \n  ")).toContain("  \n  ")
  })
})
