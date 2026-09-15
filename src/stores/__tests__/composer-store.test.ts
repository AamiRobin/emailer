import { beforeEach, describe, expect, it } from "vitest"

import {
  deleteAttachmentBytes,
  getAttachmentBytes,
  setAttachmentBytes,
} from "@/components/composer/attachment-bytes"

import {
  getComposerPayload,
  useComposerStore,
  type ComposerAttachment,
  type ComposerMode,
} from "../composer-store"

/**
 * Composer draft store (tasks 8.1/8.2): open/close/reset semantics, the
 * raw-input setters, the Cc/Bcc toggles, and the send-shaped
 * serialization of getComposerPayload. Task 8.5: attachment metadata
 * state (bytes live in the registry) + payload base64 exposure.
 */

function resetStore(): void {
  useComposerStore.getState().reset()
}

/** Register one attachment's bytes and add its metadata in the same order
 * the composer's add pipeline does. */
function addAttachment(
  meta: Omit<ComposerAttachment, "id">,
  bytes: Uint8Array
): ComposerAttachment {
  const attachment = { id: crypto.randomUUID(), ...meta }
  setAttachmentBytes(attachment.id, bytes)
  useComposerStore.getState().addAttachments([attachment])
  return attachment
}

beforeEach(resetStore)

describe("composer store", () => {
  it("starts closed with a blank new-message draft", () => {
    const state = useComposerStore.getState()
    expect(state.open).toBe(false)
    expect(state.mode).toEqual({ kind: "new" })
    expect(state.activeAccountId).toBeNull()
    expect(state.to).toEqual([])
    expect(state.cc).toEqual([])
    expect(state.bcc).toEqual([])
    expect(state.showCc).toBe(false)
    expect(state.showBcc).toBe(false)
    expect(state.subject).toBe("")
    expect(state.html).toBe("")
  })

  it("openNew opens a blank draft for the given account, dropping old fields", () => {
    useComposerStore.getState().setSubject("old")
    useComposerStore.getState().setTo([{ email: "old@example.com" }])
    useComposerStore.getState().setHtml("<p>old</p>")
    useComposerStore.getState().toggleCc()

    useComposerStore.getState().openNew("acc-1")

    const state = useComposerStore.getState()
    expect(state.open).toBe(true)
    expect(state.activeAccountId).toBe("acc-1")
    expect(state.mode).toEqual({ kind: "new" })
    expect(state.subject).toBe("")
    expect(state.to).toEqual([])
    expect(state.html).toBe("")
    expect(state.showCc).toBe(false)
  })

  it("openNew tolerates a null account (no active account yet)", () => {
    useComposerStore.getState().openNew(null)
    expect(useComposerStore.getState().open).toBe(true)
    expect(useComposerStore.getState().activeAccountId).toBeNull()
  })

  it("openWith opens with a reply/forward mode and a blank draft", () => {
    const mode: ComposerMode = {
      kind: "reply",
      replyAll: true,
      inReplyTo: "<msg-0@example.com>",
      references: "<msg-0@example.com>",
      sourceMessageId: "m-1",
      sourceThreadId: "t-1",
      quotedHtml: "<p>quoted</p>",
    }
    useComposerStore.getState().setSubject("stale")
    useComposerStore.getState().openWith(mode, "acc-2")

    const state = useComposerStore.getState()
    expect(state.open).toBe(true)
    expect(state.mode).toEqual(mode)
    expect(state.activeAccountId).toBe("acc-2")
    expect(state.subject).toBe("")
  })

  it("close hides the composer but keeps the in-progress draft", () => {
    useComposerStore.getState().openNew("acc-1")
    useComposerStore.getState().setSubject("keep me")

    useComposerStore.getState().close()

    const state = useComposerStore.getState()
    expect(state.open).toBe(false)
    expect(state.subject).toBe("keep me")
  })

  it("reset drops the draft entirely and closes", () => {
    useComposerStore.getState().openNew("acc-1")
    useComposerStore.getState().setTo([{ email: "a@x.com" }])
    useComposerStore.getState().setHtml("<p>body</p>")

    useComposerStore.getState().reset()

    const state = useComposerStore.getState()
    expect(state.open).toBe(false)
    expect(state.activeAccountId).toBeNull()
    expect(state.to).toEqual([])
    expect(state.html).toBe("")
    expect(state.mode).toEqual({ kind: "new" })
  })

  it("setTo/setCc/setBcc store raw recipient arrays", () => {
    const recipients = [{ name: "Ada", email: "ada@example.com" }]
    useComposerStore.getState().setTo(recipients)
    useComposerStore.getState().setCc([{ email: "cc@example.com" }])
    useComposerStore.getState().setBcc([{ email: "bcc@example.com" }])

    expect(useComposerStore.getState().to).toEqual(recipients)
    expect(useComposerStore.getState().cc).toEqual([
      { email: "cc@example.com" },
    ])
    expect(useComposerStore.getState().bcc).toEqual([
      { email: "bcc@example.com" },
    ])
  })

  it("setSubject and setHtml keep the draft fields current", () => {
    useComposerStore.getState().setSubject("Hello")
    useComposerStore.getState().setHtml("<p>World</p>")
    expect(useComposerStore.getState().subject).toBe("Hello")
    expect(useComposerStore.getState().html).toBe("<p>World</p>")
  })

  it("toggleCc/toggleBcc flip the row visibility independently", () => {
    useComposerStore.getState().toggleCc()
    expect(useComposerStore.getState().showCc).toBe(true)
    expect(useComposerStore.getState().showBcc).toBe(false)
    useComposerStore.getState().toggleBcc()
    expect(useComposerStore.getState().showBcc).toBe(true)
    useComposerStore.getState().toggleCc()
    expect(useComposerStore.getState().showCc).toBe(false)
  })

  it("getComposerPayload serializes into the SendEmailInput shape", () => {
    useComposerStore.getState().openNew("acc-1")
    useComposerStore.getState().setTo([{ email: "to@example.com" }])
    useComposerStore.getState().setCc([{ email: "cc@example.com" }])
    useComposerStore.getState().setBcc([])
    useComposerStore.getState().setSubject("Hi")
    useComposerStore.getState().setHtml("<p>Hello <strong>world</strong></p>")

    expect(getComposerPayload()).toEqual({
      to: [{ email: "to@example.com" }],
      cc: [{ email: "cc@example.com" }],
      bcc: [],
      subject: "Hi",
      htmlBody: "<p>Hello <strong>world</strong></p>",
      textBody: "Hello world",
    })
  })

  it("getComposerPayload reflects resets and empty drafts", () => {
    useComposerStore.getState().setHtml("<p>gone</p>")
    useComposerStore.getState().reset()
    expect(getComposerPayload()).toEqual({
      to: [],
      cc: [],
      bcc: [],
      subject: "",
      htmlBody: "",
      textBody: "",
    })
  })

  // ---- Task 8.5: attachments ----

  it("starts with no attachments; openNew/openWith drop stale ones", () => {
    expect(useComposerStore.getState().attachments).toEqual([])

    addAttachment({ name: "stale.txt", size: 2 }, new Uint8Array([1, 2]))
    useComposerStore.getState().openNew("acc-1")
    expect(useComposerStore.getState().attachments).toEqual([])

    addAttachment({ name: "stale.txt", size: 2 }, new Uint8Array([1, 2]))
    useComposerStore
      .getState()
      .openWith({ kind: "reply", replyAll: false }, "acc-1")
    expect(useComposerStore.getState().attachments).toEqual([])
  })

  it("addAttachments appends metadata; removeAttachment drops one entry and its bytes", () => {
    const kept = addAttachment(
      { name: "kept.txt", size: 2 },
      new Uint8Array([1, 2])
    )
    const removed = addAttachment(
      { name: "notes.md", size: 3, mimeType: "text/markdown" },
      new Uint8Array([1, 2, 3])
    )
    expect(useComposerStore.getState().attachments).toEqual([
      { id: kept.id, name: "kept.txt", size: 2 },
      { id: removed.id, name: "notes.md", size: 3, mimeType: "text/markdown" },
    ])

    useComposerStore.getState().removeAttachment(removed.id)
    expect(useComposerStore.getState().attachments).toEqual([
      { id: kept.id, name: "kept.txt", size: 2 },
    ])
    expect(getAttachmentBytes(removed.id)).toBeUndefined()
    expect(getAttachmentBytes(kept.id)).toBeDefined()
  })

  it("close keeps attachments (in-progress draft), reset clears bytes and metadata", () => {
    const attachment = addAttachment(
      { name: "a.txt", size: 1 },
      new Uint8Array([7])
    )
    useComposerStore.getState().close()
    expect(useComposerStore.getState().attachments).toHaveLength(1)
    expect(getAttachmentBytes(attachment.id)).toBeDefined()

    useComposerStore.getState().reset()
    expect(useComposerStore.getState().attachments).toEqual([])
    expect(getAttachmentBytes(attachment.id)).toBeUndefined()
  })

  it("getComposerPayload includes attachments as base64 (mimeType only when known)", () => {
    useComposerStore.getState().openNew("acc-1")
    useComposerStore.getState().setSubject("Files")
    addAttachment(
      { name: "a.txt", size: 3, mimeType: "text/plain" },
      new Uint8Array([97, 98, 99])
    )
    addAttachment({ name: "noext", size: 1 }, new Uint8Array([120]))

    const payload = getComposerPayload()
    expect(payload.attachments).toEqual([
      // "abc" in standard padded base64.
      {
        filename: "a.txt",
        mimeType: "text/plain",
        contentBase64: btoa("abc"),
      },
      { filename: "noext", contentBase64: btoa("x") },
    ])
  })

  it("getComposerPayload omits the attachments key when the draft has none", () => {
    useComposerStore.getState().openNew("acc-1")
    expect(getComposerPayload().attachments).toBeUndefined()
  })

  it("getComposerPayload skips metadata whose bytes are gone (e.g. resumed drafts)", () => {
    useComposerStore.getState().openNew("acc-1")
    const ghost: ComposerAttachment = {
      id: crypto.randomUUID(),
      name: "lost.bin",
      size: 10,
    }
    useComposerStore.getState().addAttachments([ghost])
    expect(getComposerPayload().attachments).toBeUndefined()

    // Direct registry deletion (not removeAttachment) has the same effect.
    const live = addAttachment(
      { name: "live.txt", size: 2 },
      new Uint8Array([1, 2])
    )
    deleteAttachmentBytes(live.id)
    expect(getComposerPayload().attachments).toBeUndefined()
  })
})
