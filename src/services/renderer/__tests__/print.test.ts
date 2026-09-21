import { describe, expect, it } from "vitest"

import {
  buildPrintHtml,
  formatPrintAddress,
  type PrintMessage,
} from "@/services/renderer/print"
import { sanitizeEmailHtml } from "@/services/renderer/sanitize"

/**
 * Print document tests (task 1.10, spec mail-reading "Print message or
 * thread"): conversation order, per-message headers, no app chrome, and
 * the blocked-remote-image contract — bodies sanitized with the display
 * policy keep their placeholder srcs in the print document (nothing is
 * fetched at print time).
 */

function message(overrides: Partial<PrintMessage> = {}): PrintMessage {
  return {
    fromName: "Jane Doe",
    fromAddress: "jane@example.com",
    to: ["me@example.com"],
    cc: [],
    date: 1758211200, // 2025-09-18 (UTC afternoon)
    bodyHtml: "<p>Hello</p>",
    ...overrides,
  }
}

describe("buildPrintHtml", () => {
  it("renders one section per message, in the given order", () => {
    const html = buildPrintHtml("Re: Plan", [
      message({ bodyHtml: "<p>first</p>" }),
      message({ bodyHtml: "<p>second</p>" }),
    ])
    const first = html.indexOf("first")
    const second = html.indexOf("second")
    expect(first).toBeGreaterThan(-1)
    expect(second).toBeGreaterThan(first)
  })

  it("includes from, to and date headers per message", () => {
    const html = buildPrintHtml("Re: Plan", [
      message({ cc: ["carol@example.com"] }),
    ])
    expect(html).toContain("Jane Doe &lt;jane@example.com&gt;")
    expect(html).toContain("me@example.com")
    expect(html).toContain("carol@example.com")
    expect(html).toContain(">From</th>")
    expect(html).toContain(">To</th>")
    expect(html).toContain(">Cc</th>")
    expect(html).toContain(">Date</th>")
  })

  it("carries the subject as the document heading", () => {
    const html = buildPrintHtml("Project Atlas", [message()])
    expect(html).toContain("<h1>Project Atlas</h1>")
    expect(html).toContain("<title>Project Atlas</title>")
  })

  it("keeps sanitized bodies verbatim in the section body", () => {
    const html = buildPrintHtml(null, [message({ bodyHtml: "<p>ok</p>" })])
    expect(html).toContain('<div class="body"><p>ok</p></div>')
  })

  it("escapes untrusted text (subject, names) — never bodies", () => {
    const html = buildPrintHtml('Chart <gain> & "loss"', [
      message({
        fromName: "Eve <evil@example.com>",
        bodyHtml: "<p>body stays raw</p>",
      }),
    ])
    expect(html).toContain("Chart &lt;gain&gt; &amp; &quot;loss&quot;")
    expect(html).toContain("Eve &lt;evil@example.com&gt;")
    expect(html).toContain("<p>body stays raw</p>")
  })
})

describe("print blocked-image policy", () => {
  it("blocked remote images print as placeholders, never sources", () => {
    const raw =
      '<p>see</p><img src="https://tracker.example.com/pixel.png" alt="x" />'
    const sanitized = sanitizeEmailHtml(raw, { blockRemoteImages: true })
    const html = buildPrintHtml(null, [message({ bodyHtml: sanitized })])
    // The remote URL survives only in the data-original-src bookkeeping
    // attribute (same as display) — never as a src nothing would fetch.
    // (The img's actual src is the inline placeholder data URI.)
    expect(html).toMatch(/<img [^>]*src="data:image/)
    expect(html).toContain('data-original-src="https://tracker.example.com')
  })

  it("allowed remote images keep their source (allowlisted sender)", () => {
    const raw =
      '<p>see</p><img src="https://images.example.com/photo.jpg" alt="y" />'
    const sanitized = sanitizeEmailHtml(raw, { blockRemoteImages: false })
    const html = buildPrintHtml(null, [message({ bodyHtml: sanitized })])
    expect(html).toContain("images.example.com/photo.jpg")
  })
})

describe("formatPrintAddress", () => {
  it("joins name and address, or falls back to whichever exists", () => {
    expect(formatPrintAddress("Jane", "jane@x.com")).toBe(
      "Jane <jane@x.com>"
    )
    expect(formatPrintAddress(null, "jane@x.com")).toBe("jane@x.com")
    expect(formatPrintAddress("Jane", null)).toBe("Jane")
    expect(formatPrintAddress("  ", null)).toBe("")
  })
})
