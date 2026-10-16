import { describe, expect, it } from "vitest"

import {
  buildPrintHtml,
  buildPrintPayload,
  formatPrintAddress,
  printHtml,
  type PrintMessage,
} from "@/services/renderer/print"
import { sanitizeEmailHtml } from "@/services/renderer/sanitize"
import {
  createAccount,
  createMessage,
  createThread,
  at,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { allowSender } from "@/services/db/image-allowlist"
import { updateMessage } from "@/services/db/messages"
import { getThreadWithMessages } from "@/services/db/threads"

/**
 * Print document tests (task 1.10, spec mail-reading "Print message or
 * thread"; payload builder parity-round-3 task 4.3): conversation order,
 * per-message headers, no app chrome, the blocked-remote-image contract —
 * bodies sanitized with the display policy keep their placeholder srcs in
 * the print document (nothing is fetched at print time) — and the
 * sanitizer handoff: scripts never reach the print document.
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

describe("printHtml", () => {
  it("renders the document into a sandboxed iframe — printable, but never scripted", () => {
    printHtml("<p>print me</p>")
    const iframe = document.body.querySelector("iframe")
    expect(iframe).not.toBeNull()
    expect(iframe?.getAttribute("srcdoc")).toContain("print me")
    // The frame must never run scripts: a srcdoc iframe without a
    // sandbox attribute inherits the app origin. allow-same-origin keeps
    // contentWindow printable; allow-modals is required on top — Chromium
    // ignores print() inside a sandboxed frame without it (regression:
    // the browser print fallback silently did nothing). allow-scripts
    // stays OUT: with no scripts in the frame, allow-modals exposes
    // nothing beyond the host's own contentWindow.print() call.
    // jsdom cannot exercise the WKWebView print() path, so the attribute
    // itself is the contract.
    expect(iframe?.getAttribute("sandbox")).toBe(
      "allow-same-origin allow-modals"
    )
    document.body.innerHTML = ""
  })
})

// ---- buildPrintPayload: the sanitizer handoff (task 4.3) ----

/**
 * Seed one thread with one html message (body patched in — the fixture
 * helper seeds text bodies) and return the loaded thread plus ids.
 */
async function seedHtmlMessage(
  executor: TestExecutor,
  options: {
    fromAddress: string
    fromName?: string
    bodyHtml: string
    date?: number
  }
): Promise<{ threadId: string; messageId: string }> {
  const accountId = await createAccount(executor)
  const threadId = await createThread(executor, accountId, {
    subject: "Payload thread",
  })
  const messageId = await createMessage(executor, {
    threadId,
    accountId,
    date: options.date ?? at(0),
    fromName: options.fromName ?? "Eve",
    fromAddress: options.fromAddress,
    to: [{ email: "me@example.com" }],
    bodyText: "fallback text",
  })
  await updateMessage(executor, messageId, { bodyHtml: options.bodyHtml })
  return { threadId, messageId }
}

describe("buildPrintPayload sanitizer handoff", () => {
  it("remote images placeholder and scripts vanish — exactly the reading pane's output", async () => {
    const executor = createTestExecutor()
    const { threadId, messageId } = await seedHtmlMessage(executor, {
      fromAddress: "eve@example.com",
      bodyHtml:
        '<p>see</p><script>window.alert("pwned")</script>' +
        '<img src="https://tracker.example.com/pixel.png" alt="t" />',
    })
    const loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded).not.toBeNull()
    const payload = await buildPrintPayload(executor, loaded!, {
      kind: "message",
      messageId,
    })
    expect(payload).not.toBeNull()
    const body = payload!.messages[0]!.bodyHtml
    // Script gone entirely — tag AND body text (DOMPurify's default
    // FORBID_CONTENTS), so nothing survives to execute or leak.
    expect(body).not.toContain("<script")
    expect(body).not.toContain("alert")
    // Blocked remote image: placeholder src, original kept only in the
    // data-original-src bookkeeping attribute — same as on screen.
    expect(body).toMatch(/<img [^>]*src="data:image\/gif/)
    expect(body).toContain(
      'data-original-src="https://tracker.example.com/pixel.png"'
    )
    // The document built from the payload keeps the script out too.
    const html = buildPrintHtml(payload!.subject, payload!.messages)
    expect(html).not.toContain("<script")
    executor.close()
  })

  it("allowlisted senders keep remote image sources (display decision carried over)", async () => {
    const executor = createTestExecutor()
    const accountId = await createAccount(executor)
    const threadId = await createThread(executor, accountId)
    const messageId = await createMessage(executor, {
      threadId,
      accountId,
      date: at(0),
      fromName: "Trusted",
      fromAddress: "trusted@example.com",
    })
    await updateMessage(executor, messageId, {
      bodyHtml: '<img src="https://images.example.com/photo.jpg" alt="y" />',
    })
    await allowSender(executor, accountId, "trusted@example.com")
    const loaded = await getThreadWithMessages(executor, threadId)
    const payload = await buildPrintPayload(executor, loaded!, {
      kind: "message",
      messageId,
    })
    expect(payload!.messages[0]!.bodyHtml).toContain(
      'src="https://images.example.com/photo.jpg"'
    )
    executor.close()
  })

  it("message scope prints exactly the selected message; thread scope prints all, in order", async () => {
    const executor = createTestExecutor()
    const accountId = await createAccount(executor)
    const threadId = await createThread(executor, accountId)
    const firstId = await createMessage(executor, {
      threadId,
      accountId,
      date: at(0),
      fromAddress: "a@example.com",
      bodyText: "first",
    })
    const secondId = await createMessage(executor, {
      threadId,
      accountId,
      date: at(60),
      fromAddress: "b@example.com",
      bodyText: "second",
    })
    const loaded = await getThreadWithMessages(executor, threadId)

    const wholeThread = await buildPrintPayload(executor, loaded!, {
      kind: "thread",
    })
    expect(wholeThread!.messages.map((entry) => entry.bodyHtml)).toEqual([
      "<pre style=\"font: inherit; white-space: pre-wrap; margin: 0;\">first</pre>",
      "<pre style=\"font: inherit; white-space: pre-wrap; margin: 0;\">second</pre>",
    ])

    const one = await buildPrintPayload(executor, loaded!, {
      kind: "message",
      messageId: secondId,
    })
    expect(one!.messages).toHaveLength(1)
    expect(one!.messages[0]!.bodyHtml).toContain("second")
    expect(firstId).not.toBe(secondId)
    executor.close()
  })

  it("returns null when the scope selects no message (unknown id)", async () => {
    const executor = createTestExecutor()
    const { threadId } = await seedHtmlMessage(executor, {
      fromAddress: "eve@example.com",
      bodyHtml: "<p>x</p>",
    })
    const loaded = await getThreadWithMessages(executor, threadId)
    await expect(
      buildPrintPayload(executor, loaded!, {
        kind: "message",
        messageId: "missing",
      })
    ).resolves.toBeNull()
    executor.close()
  })
})
