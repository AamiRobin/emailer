import { describe, expect, it } from "vitest"

import { bodyReferencesAttachment, evaluateSendGuards } from "../send-guards"

/**
 * Send-guard detection tests (task 5.3, spec mail-composition "Send
 * guards"): the pure predicates the composer runs before the send flow
 * starts. The prompts and their once-per-attempt / suppression bookkeeping
 * are the composer suite's job (composer.test.tsx).
 */

describe("bodyReferencesAttachment (task 5.3)", () => {
  it("matches the attachment-wording family the spec calls out", () => {
    expect(bodyReferencesAttachment("<p>I attached the report</p>")).toBe(true)
    expect(bodyReferencesAttachment("<p>See the attachment</p>")).toBe(true)
    expect(bodyReferencesAttachment("<p>attachments follow</p>")).toBe(true)
    expect(bodyReferencesAttachment("<p>Please attach it</p>")).toBe(true)
    expect(bodyReferencesAttachment("<p>I am attaching two files</p>")).toBe(
      true
    )
    expect(bodyReferencesAttachment("<p>it attaches itself</p>")).toBe(true)
  })

  it("stays quiet for unrelated wording and plain bodies", () => {
    expect(bodyReferencesAttachment("<p>Here is the update</p>")).toBe(false)
    expect(bodyReferencesAttachment("<p></p>")).toBe(false)
    // Word boundaries: no match inside unrelated words.
    expect(bodyReferencesAttachment("<p>unattached to the outcome</p>")).toBe(
      false
    )
    expect(bodyReferencesAttachment("<p>the detacher tool</p>")).toBe(false)
  })

  it("ignores attachment wording inside quoted history", () => {
    // reply.ts buildQuotedHistory wraps the original in <blockquote>: a
    // "see attached" downthread must not trip the guard for a reply that
    // never mentions one.
    expect(
      bodyReferencesAttachment(
        "<p>Thanks for the quick reply.</p><blockquote><p>On Sep 1, Ada wrote: find attached the report</p></blockquote>"
      )
    ).toBe(false)
    // Nested blockquotes (a reply to a reply) strip fully.
    expect(
      bodyReferencesAttachment(
        "<p>On it.</p><blockquote><p>ada: see attachment</p><blockquote><p>grace: attached is the file</p></blockquote></blockquote>"
      )
    ).toBe(false)
    // The user's own wording outside the quote still fires.
    expect(
      bodyReferencesAttachment(
        "<p>I attached ours too.</p><blockquote><p>grace: attached is the file</p></blockquote>"
      )
    ).toBe(true)
  })
})

describe("evaluateSendGuards (task 5.3)", () => {
  const base = { html: "<p>Here is the update</p>", subject: "Update" }

  it("raises the attachment reminder only with the wording and no file", () => {
    expect(evaluateSendGuards({ ...base, hasAttachments: true })).toEqual([])
    expect(
      evaluateSendGuards({
        html: "<p>I attached the report</p>",
        subject: "Report",
        hasAttachments: true,
      })
    ).toEqual([])
    expect(
      evaluateSendGuards({
        html: "<p>I attached the report</p>",
        subject: "Report",
        hasAttachments: false,
      })
    ).toEqual(["attachment"])
  })

  it("raises the empty-subject confirmation for a blank subject", () => {
    expect(
      evaluateSendGuards({ ...base, subject: "", hasAttachments: true })
    ).toEqual(["emptySubject"])
    expect(
      evaluateSendGuards({ ...base, subject: "   ", hasAttachments: true })
    ).toEqual(["emptySubject"])
  })

  it("queues both guards, attachment reminder first", () => {
    expect(
      evaluateSendGuards({
        html: "<p>I attached the report</p>",
        subject: "",
        hasAttachments: false,
      })
    ).toEqual(["attachment", "emptySubject"])
  })

  it("raises nothing for a complete draft", () => {
    expect(evaluateSendGuards({ ...base, hasAttachments: false })).toEqual([])
  })
})
