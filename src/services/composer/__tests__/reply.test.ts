import { describe, expect, it } from "vitest"

import type { MessageRow } from "@/services/db/messages"
import {
  buildForward,
  buildReply,
  ensureSubjectPrefix,
  formatQuoteDate,
} from "../reply"
import { BASE_TIME } from "@/services/db/__tests__/fixtures"

/** A MessageRow from alice@example.com to the user (me@example.com). */
function makeMessage(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "msg-1",
    thread_id: "thread-1",
    account_id: "acc-1",
    gmail_message_id: null,
    imap_uid: null,
    imap_folder: null,
    message_id_header: "<orig@example.com>",
    in_reply_to: null,
    references_header: null,
    subject: "Lunch plans",
    from_name: "Alice",
    from_address: "alice@example.com",
    to_json: JSON.stringify([{ name: "Me", email: "me@example.com" }]),
    cc_json: null,
    bcc_json: null,
    date: BASE_TIME,
    snippet: null,
    body_html: "<p>Original message text</p>",
    body_text: null,
    headers: null,
    size_estimate: null,
    is_read: 0,
    is_flagged: 0,
    has_attachments: 0,
    parts_json: null,
    created_at: 0,
    auth_results: null,
    ...overrides,
  }
}

const ACCOUNT = { id: "acc-1", email: "me@example.com" }
const THREAD = { id: "thread-1" }

describe("formatQuoteDate", () => {
  it("formats epoch seconds as a UTC date", () => {
    // BASE_TIME = 2023-11-14T22:13:20Z
    expect(formatQuoteDate(BASE_TIME)).toBe("Nov 14, 2023, 10:13 PM")
  })

  it("handles midnight and noon without a zero hour", () => {
    expect(formatQuoteDate(0)).toBe("Jan 1, 1970, 12:00 AM")
  })
})

describe("ensureSubjectPrefix", () => {
  it("prepends the prefix to a plain subject", () => {
    expect(ensureSubjectPrefix("Lunch plans", "Re:")).toBe("Re: Lunch plans")
    expect(ensureSubjectPrefix("Lunch plans", "Fwd:")).toBe("Fwd: Lunch plans")
  })

  it("does not stack the same prefix", () => {
    expect(ensureSubjectPrefix("Re: Re: Lunch plans", "Re:")).toBe(
      "Re: Lunch plans"
    )
    expect(ensureSubjectPrefix("RE: re:Lunch plans", "Re:")).toBe(
      "Re: Lunch plans"
    )
    expect(ensureSubjectPrefix("Fwd: Fw: Lunch plans", "Fwd:")).toBe(
      "Fwd: Lunch plans"
    )
  })

  it("leaves look-alike subjects and mid-subject prefixes alone", () => {
    expect(ensureSubjectPrefix("Reply: Lunch plans", "Re:")).toBe(
      "Re: Reply: Lunch plans"
    )
    expect(ensureSubjectPrefix("Re: lunch Re: again", "Re:")).toBe(
      "Re: lunch Re: again"
    )
  })

  it("handles an empty subject", () => {
    expect(ensureSubjectPrefix("", "Re:")).toBe("Re:")
  })
})

describe("buildReply", () => {
  it("addresses the sender only for a plain reply", () => {
    const prefill = buildReply({
      message: makeMessage(),
      thread: THREAD,
      account: ACCOUNT,
      replyAll: false,
    })
    expect(prefill.to).toEqual([{ name: "Alice", email: "alice@example.com" }])
    expect(prefill.cc).toEqual([])
    expect(prefill.subject).toBe("Re: Lunch plans")
  })

  it("keeps an unnamed sender unnamed", () => {
    const prefill = buildReply({
      message: makeMessage({ from_name: null }),
      thread: THREAD,
      account: ACCOUNT,
      replyAll: false,
    })
    expect(prefill.to).toEqual([{ email: "alice@example.com" }])
  })

  it("reply-all expands to sender + To + Cc excluding self, deduped", () => {
    const prefill = buildReply({
      message: makeMessage({
        to_json: JSON.stringify([
          { name: "Me", email: "ME@example.com" },
          { name: "Bob", email: "bob@example.com" },
          { email: "bob@example.com" }, // duplicate of Bob
        ]),
        cc_json: JSON.stringify([
          { email: "carol@example.com" },
          { name: "Me Again", email: "me@example.com" }, // self, name variant
        ]),
      }),
      thread: THREAD,
      account: ACCOUNT,
      replyAll: true,
    })
    expect(prefill.to).toEqual([
      { name: "Alice", email: "alice@example.com" },
      { name: "Bob", email: "bob@example.com" },
    ])
    expect(prefill.cc).toEqual([{ email: "carol@example.com" }])
  })

  it("reply-all fills a missing display name from a later duplicate", () => {
    const prefill = buildReply({
      message: makeMessage({
        to_json: JSON.stringify([
          { email: "bob@example.com" },
          { name: "Bob", email: "bob@example.com" }, // named duplicate
        ]),
      }),
      thread: THREAD,
      account: ACCOUNT,
      replyAll: true,
    })
    expect(prefill.to).toContainEqual({
      name: "Bob",
      email: "bob@example.com",
    })
    expect(prefill.to).toHaveLength(2) // alice + one Bob
  })

  it("reply-all moves a Cc'd sender into the To list once", () => {
    const prefill = buildReply({
      message: makeMessage({
        from_name: "Carol",
        from_address: "carol@example.com",
        cc_json: JSON.stringify([
          { name: "Carol", email: "carol@example.com" },
        ]),
      }),
      thread: THREAD,
      account: ACCOUNT,
      replyAll: true,
    })
    // self is excluded, so only the (deduped) sender remains in To
    expect(prefill.to).toEqual([{ name: "Carol", email: "carol@example.com" }])
    expect(prefill.cc).toEqual([])
  })

  it("reply to a message from self goes to the original To list", () => {
    const prefill = buildReply({
      message: makeMessage({
        from_name: "Me",
        from_address: "me@example.com",
        to_json: JSON.stringify([{ email: "bob@example.com" }]),
      }),
      thread: THREAD,
      account: ACCOUNT,
      replyAll: false,
    })
    expect(prefill.to).toEqual([{ email: "bob@example.com" }])
  })

  it("reply-all on a message from self keeps To→To and Cc→Cc", () => {
    const prefill = buildReply({
      message: makeMessage({
        from_name: "Me",
        from_address: "me@example.com",
        to_json: JSON.stringify([{ email: "bob@example.com" }]),
        cc_json: JSON.stringify([{ email: "carol@example.com" }]),
      }),
      thread: THREAD,
      account: ACCOUNT,
      replyAll: true,
    })
    expect(prefill.to).toEqual([{ email: "bob@example.com" }])
    expect(prefill.cc).toEqual([{ email: "carol@example.com" }])
  })

  it("drops recipients with empty addresses and tolerates corrupt JSON", () => {
    const prefill = buildReply({
      message: makeMessage({
        to_json: JSON.stringify([{ email: "" }, { email: "bob@example.com" }]),
        cc_json: "not json",
      }),
      thread: THREAD,
      account: ACCOUNT,
      replyAll: true,
    })
    expect(prefill.to).toEqual([
      { name: "Alice", email: "alice@example.com" },
      { email: "bob@example.com" },
    ])
    expect(prefill.cc).toEqual([])
  })

  it("carries the exact reply mode payload", () => {
    const message = makeMessage({
      id: "msg-9",
      thread_id: "thread-9",
      message_id_header: "<tip@example.com>",
      references_header: "<a@example.com> <b@example.com>",
    })
    const prefill = buildReply({
      message,
      thread: { id: "thread-9" },
      account: ACCOUNT,
      replyAll: true,
    })
    expect(prefill.mode).toEqual({
      kind: "reply",
      replyAll: true,
      inReplyTo: "<tip@example.com>",
      references: "<a@example.com> <b@example.com> <tip@example.com>",
      sourceMessageId: "msg-9",
      sourceThreadId: "thread-9",
      quotedHtml: expect.stringContaining("wrote:"),
    })
  })

  it("builds the references chain from the stored header plus own id", () => {
    const chained = buildReply({
      message: makeMessage({
        references_header:
          "<a@example.com> <b@example.com> <a@example.com> extra",
      }),
      thread: THREAD,
      account: ACCOUNT,
      replyAll: false,
    })
    // parseReferences takes bracketed ids (deduped); the non-bracketed
    // trailing token is ignored while bracketed ids exist.
    expect(chained.mode.kind === "reply" && chained.mode.references).toBe(
      "<a@example.com> <b@example.com> <orig@example.com>"
    )

    // a header with no brackets at all falls back to bare tokens
    const bare = buildReply({
      message: makeMessage({
        references_header: "bare-id@c.example",
      }),
      thread: THREAD,
      account: ACCOUNT,
      replyAll: false,
    })
    expect(bare.mode.kind === "reply" && bare.mode.references).toBe(
      "<bare-id@c.example> <orig@example.com>"
    )
  })

  it("references falls back to the own message id, or absent", () => {
    const ownOnly = buildReply({
      message: makeMessage({ references_header: null }),
      thread: THREAD,
      account: ACCOUNT,
      replyAll: false,
    })
    expect(ownOnly.mode.kind === "reply" && ownOnly.mode.references).toBe(
      "<orig@example.com>"
    )

    const none = buildReply({
      message: makeMessage({
        references_header: null,
        message_id_header: null,
      }),
      thread: THREAD,
      account: ACCOUNT,
      replyAll: false,
    })
    expect(none.mode.kind === "reply" && none.mode.references).toBeUndefined()
    expect(none.mode.kind === "reply" && none.mode.inReplyTo).toBeUndefined()
  })

  it("collapses an already-prefixed subject once", () => {
    const prefill = buildReply({
      message: makeMessage({ subject: "Re: Re: Lunch plans" }),
      thread: THREAD,
      account: ACCOUNT,
      replyAll: false,
    })
    expect(prefill.subject).toBe("Re: Lunch plans")
  })

  it("renders the quoted history with header, blockquote and original html", () => {
    const prefill = buildReply({
      message: makeMessage(),
      thread: THREAD,
      account: ACCOUNT,
      replyAll: false,
    })
    expect(prefill.mode.kind).toBe("reply")
    const quote =
      prefill.mode.kind === "reply" ? (prefill.mode.quotedHtml ?? "") : ""
    expect(quote).toContain(
      "On Nov 14, 2023, 10:13 PM, Alice &lt;alice@example.com&gt; wrote:"
    )
    expect(quote).toContain(
      "<blockquote><p>Original message text</p></blockquote>"
    )
    // The body is the caret line, one blank separator, then the quote.
    expect(prefill.html).toBe(`<p></p><p><br></p>${quote}`)
  })

  it("quotes a plain-text original escaped and pre-wrap marked", () => {
    const prefill = buildReply({
      message: makeMessage({
        body_html: null,
        body_text: "Line 1 <with> markup & stuff\nLine 2",
      }),
      thread: THREAD,
      account: ACCOUNT,
      replyAll: false,
    })
    expect(prefill.html).toContain(
      "<blockquote><div data-emailer-plaintext>Line 1 &lt;with&gt; markup &amp; stuff\nLine 2</div></blockquote>"
    )
  })

  it("quotes an empty body as an empty paragraph", () => {
    const prefill = buildReply({
      message: makeMessage({ body_html: null, body_text: null }),
      thread: THREAD,
      account: ACCOUNT,
      replyAll: false,
    })
    expect(prefill.html).toContain("<blockquote><p></p></blockquote>")
  })

  it("places the signature above the quoted history", () => {
    const prefill = buildReply({
      message: makeMessage(),
      thread: THREAD,
      account: ACCOUNT,
      replyAll: false,
      signatureHtml: "<p>Best, Me</p>",
    })
    const signatureIndex = prefill.html.indexOf("emailer-signature")
    const quoteIndex = prefill.html.indexOf("<blockquote")
    expect(signatureIndex).toBeGreaterThan(-1)
    expect(signatureIndex).toBeLessThan(quoteIndex)
    // fresh reply: only the caret line sits before the signature — the
    // empty paragraph the composer drops the selection into on open.
    expect(prefill.html.startsWith("<p></p>")).toBe(true)
    expect(prefill.html.indexOf("emailer-signature")).toBeGreaterThan(
      "<p></p>".length
    )
    expect(prefill.html).toContain("Best, Me")
  })

  it("omits signature markup when no signature is given", () => {
    const prefill = buildReply({
      message: makeMessage(),
      thread: THREAD,
      account: ACCOUNT,
      replyAll: false,
      signatureHtml: "",
    })
    expect(prefill.html).not.toContain("emailer-signature")
  })
})

describe("buildForward", () => {
  it("starts with empty recipients and a Fwd: subject", () => {
    const prefill = buildForward({
      message: makeMessage({ subject: "Fwd: Fwd: Lunch plans" }),
      thread: THREAD,
      account: ACCOUNT,
    })
    expect(prefill.to).toEqual([])
    expect(prefill.cc).toEqual([])
    expect(prefill.subject).toBe("Fwd: Lunch plans")
  })

  it("carries the exact forward mode payload", () => {
    const prefill = buildForward({
      message: makeMessage({ id: "msg-9", thread_id: "thread-9" }),
      thread: { id: "thread-9" },
      account: ACCOUNT,
    })
    expect(prefill.mode).toEqual({
      kind: "forward",
      sourceMessageId: "msg-9",
      sourceThreadId: "thread-9",
      quotedHtml: expect.stringContaining("Forwarded message"),
    })
    // forwards do not thread via In-Reply-To/References
    expect(prefill.mode.kind === "forward" && "inReplyTo" in prefill.mode).toBe(
      false
    )
  })

  it("renders the forwarded header block From/Date/Subject/To and Cc", () => {
    const prefill = buildForward({
      message: makeMessage({
        cc_json: JSON.stringify([
          { name: "Carol", email: "carol@example.com" },
        ]),
      }),
      thread: THREAD,
      account: ACCOUNT,
    })
    expect(prefill.html).toContain(
      "<p>---------- Forwarded message ----------</p>"
    )
    expect(prefill.html).toContain(
      "From: Alice &lt;alice@example.com&gt;<br>Date: Nov 14, 2023, 10:13 PM<br>Subject: Lunch plans<br>To: Me &lt;me@example.com&gt;<br>Cc: Carol &lt;carol@example.com&gt;"
    )
    expect(prefill.html).toContain(
      "<blockquote><p>Original message text</p></blockquote>"
    )
  })

  it("omits To/Cc lines and Subject when empty", () => {
    const prefill = buildForward({
      message: makeMessage({ subject: null, to_json: null, cc_json: null }),
      thread: THREAD,
      account: ACCOUNT,
    })
    expect(prefill.html).toContain(
      "From: Alice &lt;alice@example.com&gt;<br>Date: Nov 14, 2023, 10:13 PM</p>"
    )
    expect(prefill.subject).toBe("Fwd:")
  })

  it("places the signature above the forwarded content", () => {
    const prefill = buildForward({
      message: makeMessage(),
      thread: THREAD,
      account: ACCOUNT,
      signatureHtml: "<p>Best, Me</p>",
    })
    const signatureIndex = prefill.html.indexOf("emailer-signature")
    const forwardIndex = prefill.html.indexOf("Forwarded message")
    expect(signatureIndex).toBeGreaterThan(-1)
    expect(signatureIndex).toBeLessThan(forwardIndex)
  })

  it("escapes header text hostile to html", () => {
    const prefill = buildForward({
      message: makeMessage({
        subject: 'Bob <b@x> & "friends"',
        from_name: "<script>alert(1)</script>",
      }),
      thread: THREAD,
      account: ACCOUNT,
    })
    expect(prefill.html).not.toContain("<script>")
    expect(prefill.html).toContain(
      "From: &lt;script&gt;alert(1)&lt;/script&gt; &lt;alice@example.com&gt;"
    )
    expect(prefill.html).toContain('Subject: Bob &lt;b@x&gt; &amp; "friends"')
  })
})
