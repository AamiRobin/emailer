import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

import {
  deleteAttachmentBytes,
  getAttachmentBytes,
  setAttachmentBytes,
} from "@/components/composer/attachment-bytes"
import { setSendComposerDraftImplForTests } from "@/services/composer/undo-send"
import type {
  SendComposerDraftArgs,
  SendComposerDraftResult,
} from "@/services/composer/send"

import {
  getComposerPayload,
  useComposerStore,
  type ComposerAttachment,
  type ComposerMode,
  type UndoSendSnapshot,
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

describe("composer store undo send (tasks 5.1/5.2, design D3)", () => {
  const sendSpy =
    vi.fn<(args: SendComposerDraftArgs) => Promise<SendComposerDraftResult>>()

  function queuedResult(): SendComposerDraftResult {
    return {
      status: "queued",
      accountId: "acc-1",
      opId: "op-1",
      threadId: "thread-1",
      messageId: "<sent@example.com>",
      queuedOffline: false,
    }
  }

  function undoSnapshot(
    overrides?: Partial<UndoSendSnapshot>
  ): UndoSendSnapshot {
    return {
      accountId: "acc-1",
      mode: { kind: "new" },
      draftKey: "draft-key-1",
      fromAlias: null,
      to: [{ name: "Ada", email: "ada@example.com" }],
      cc: [{ email: "cc@example.com" }],
      bcc: [],
      showCc: true,
      showBcc: false,
      subject: "Quarterly report",
      html: "<p>Hi there</p>",
      attachments: [{ id: "att-1", name: "notes.txt", size: 3 }],
      ...overrides,
    }
  }

  function beginWindow(delaySeconds: number, snapshot = undoSnapshot()): void {
    useComposerStore.getState().beginUndoWindow({
      snapshot,
      sendArgs: {
        accountId: snapshot.accountId,
        payload: {
          to: snapshot.to,
          cc: snapshot.cc,
          bcc: snapshot.bcc,
          subject: snapshot.subject,
          htmlBody: snapshot.html,
          textBody: "Hi there",
        },
        draftKey: snapshot.draftKey ?? undefined,
      },
      delaySeconds,
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    sendSpy.mockResolvedValue(queuedResult())
    setSendComposerDraftImplForTests(sendSpy)
  })

  afterEach(() => {
    setSendComposerDraftImplForTests(null)
    useComposerStore.getState().cancelUndoSend()
    vi.useRealTimers()
  })

  it("holds the window closed-composer, then fires the send once at expiry", async () => {
    useComposerStore.getState().openNew("acc-1")
    useComposerStore.getState().setSubject("stale")

    beginWindow(10)

    let state = useComposerStore.getState()
    expect(state.open).toBe(false)
    expect(state.undoWindow).toMatchObject({
      accountId: "acc-1",
      subject: "Quarterly report",
      totalSeconds: 10,
      remainingSeconds: 10,
    })

    await vi.advanceTimersByTimeAsync(9_999)
    expect(sendSpy).not.toHaveBeenCalled()
    expect(useComposerStore.getState().undoWindow).not.toBeNull()

    await vi.advanceTimersByTimeAsync(1)
    expect(sendSpy).toHaveBeenCalledTimes(1)
    // Expiry transmits the frozen send args, not the live composer state.
    expect(sendSpy).toHaveBeenCalledWith({
      accountId: "acc-1",
      payload: {
        to: [{ name: "Ada", email: "ada@example.com" }],
        cc: [{ email: "cc@example.com" }],
        bcc: [],
        subject: "Quarterly report",
        htmlBody: "<p>Hi there</p>",
        textBody: "Hi there",
      },
      draftKey: "draft-key-1",
    })

    // The send is real: the window closes and the stale draft is dropped.
    state = useComposerStore.getState()
    expect(state.undoWindow).toBeNull()
    expect(state.open).toBe(false)
    expect(state.subject).toBe("")
    expect(state.to).toEqual([])
    expect(state.attachments).toEqual([])
  })

  it("cancelUndoSend before expiry prevents the send and restores the snapshot", async () => {
    beginWindow(10)
    await vi.advanceTimersByTimeAsync(4_000)

    // Mid-window navigation: the user opened a fresh compose over the
    // window (fields dropped, bytes registry cleared).
    useComposerStore.getState().openNew("acc-2")
    useComposerStore.getState().setSubject("brand new draft")
    expect(useComposerStore.getState().undoWindow).not.toBeNull()
    // The snapshot's attachment bytes are still live during the window;
    // re-register them as the surviving session registry state.
    setAttachmentBytes("att-1", new Uint8Array([1, 2, 3]))

    expect(useComposerStore.getState().cancelUndoSend()).toBe(true)

    const state = useComposerStore.getState()
    expect(state.undoWindow).toBeNull()
    // The user lands back in the composer, snapshot intact.
    expect(state.open).toBe(true)
    expect(state.activeAccountId).toBe("acc-1")
    expect(state.mode).toEqual({ kind: "new" })
    expect(state.draftKey).toBe("draft-key-1")
    expect(state.subject).toBe("Quarterly report")
    expect(state.html).toBe("<p>Hi there</p>")
    expect(state.to).toEqual([{ name: "Ada", email: "ada@example.com" }])
    expect(state.cc).toEqual([{ email: "cc@example.com" }])
    expect(state.showCc).toBe(true)
    expect(state.attachments).toEqual([
      { id: "att-1", name: "notes.txt", size: 3 },
    ])

    // The provider send never happens, however long the clock runs.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it("superseding a window flushes the first message instead of dropping it", async () => {
    beginWindow(10)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(sendSpy).not.toHaveBeenCalled()

    // A second send while A's window runs: A must TRANSMIT now (flush),
    // not vanish.
    beginWindow(
      10,
      undoSnapshot({
        accountId: "acc-2",
        draftKey: "draft-key-2",
        subject: "Second report",
      })
    )

    // A's frozen payload went out immediately, through the same invoke
    // path expiry uses.
    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy.mock.calls[0][0].accountId).toBe("acc-1")
    expect(sendSpy.mock.calls[0][0].payload.subject).toBe("Quarterly report")

    // A's stale result handler must not clobber the new window (the
    // generation was bumped first): let its microtasks run, then check B.
    await vi.advanceTimersByTimeAsync(0)
    expect(useComposerStore.getState().undoWindow).toMatchObject({
      accountId: "acc-2",
      subject: "Second report",
      totalSeconds: 10,
      remainingSeconds: 10,
    })
    // The flushed message surfaced the standard sent toast.
    expect(toast.success).toHaveBeenCalledWith("Message sent")

    // B fires at its own expiry, with B's payload.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(sendSpy).toHaveBeenCalledTimes(2)
    expect(sendSpy.mock.calls[1][0].accountId).toBe("acc-2")
    expect(sendSpy.mock.calls[1][0].payload.subject).toBe("Second report")
    expect(useComposerStore.getState().undoWindow).toBeNull()
  })

  it("cancelUndoSend after the expiry fired is refused (the send is committing)", async () => {
    // Gate the send: invoked at expiry, resolved only when the test says.
    let releaseSend: (result: SendComposerDraftResult) => void = () => {}
    sendSpy.mockImplementationOnce(
      () =>
        new Promise<SendComposerDraftResult>((resolve) => {
          releaseSend = resolve
        })
    )

    beginWindow(5)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sendSpy).toHaveBeenCalledTimes(1) // in flight, not yet resolved

    // A late cancel must NOT restore the snapshot: the send WILL commit,
    // and a restored draft would duplicate it on the user's next Send.
    expect(useComposerStore.getState().cancelUndoSend()).toBe(false)
    expect(useComposerStore.getState().open).toBe(false)
    expect(useComposerStore.getState().subject).toBe("")

    // The gated send completes exactly once and closes its own window.
    releaseSend(queuedResult())
    await vi.advanceTimersByTimeAsync(0)
    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(useComposerStore.getState().undoWindow).toBeNull()
  })

  it("restoring after the registry cleared drops ghost attachments with a warning", async () => {
    const live = addAttachment(
      { name: "live.txt", size: 2 },
      new Uint8Array([1, 2])
    )
    const ghost: ComposerAttachment = {
      id: crypto.randomUUID(),
      name: "ghost.bin",
      size: 9,
    }
    beginWindow(
      10,
      undoSnapshot({
        attachments: [{ id: live.id, name: live.name, size: live.size }, ghost],
      })
    )
    await vi.advanceTimersByTimeAsync(1_000)

    // Mid-window the user opened a fresh compose: the bytes registry
    // cleared. Only the live attachment's bytes come back (as the
    // composer re-registers them for a draft that still has them).
    useComposerStore.getState().openNew("acc-2")
    setAttachmentBytes(live.id, new Uint8Array([1, 2]))

    expect(useComposerStore.getState().cancelUndoSend()).toBe(true)
    const state = useComposerStore.getState()
    // The ghost descriptor is gone instead of rendering as an unsendable
    // chip, and the warning says so.
    expect(state.attachments).toEqual([
      { id: live.id, name: "live.txt", size: 2 },
    ])
    expect(getComposerPayload().attachments).toEqual([
      { filename: "live.txt", contentBase64: btoa("\u0001\u0002") },
    ])
    expect(toast.warning).toHaveBeenCalledWith(
      "Some attachments were no longer available and were removed"
    )
  })

  it("an unexpected expiry rejection restores the draft with an error toast", async () => {
    sendSpy.mockRejectedValueOnce(new Error("the account row vanished"))

    beginWindow(5)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(sendSpy).toHaveBeenCalledTimes(1)
    const state = useComposerStore.getState()
    // Null result = crash, not cancel: nothing transmitted, so the draft
    // goes back into the composer and the failure is surfaced.
    expect(state.undoWindow).toBeNull()
    expect(state.open).toBe(true)
    expect(state.subject).toBe("Quarterly report")
    expect(toast.error).toHaveBeenCalledWith(
      "Sending failed — your draft was restored"
    )
  })

  it("a failed expiry result restores the draft with the composer open", async () => {
    sendSpy.mockResolvedValue({
      status: "failed",
      error: "unable to reach local storage",
    })

    beginWindow(5)
    await vi.advanceTimersByTimeAsync(5_000)

    expect(sendSpy).toHaveBeenCalledTimes(1)
    const state = useComposerStore.getState()
    // Nothing was transmitted — the draft goes back to the composer.
    expect(state.undoWindow).toBeNull()
    expect(state.open).toBe(true)
    expect(state.subject).toBe("Quarterly report")
  })

  it("a failed expiry result leaves an in-progress new compose alone", async () => {
    sendSpy.mockResolvedValue({
      status: "failed",
      error: "unable to reach local storage",
    })

    beginWindow(5)
    // Mid-window the user started a fresh compose over the window.
    useComposerStore.getState().openNew("acc-2")
    useComposerStore.getState().setSubject("fresh work")

    await vi.advanceTimersByTimeAsync(5_000)

    expect(sendSpy).toHaveBeenCalledTimes(1)
    const state = useComposerStore.getState()
    expect(state.undoWindow).toBeNull()
    // The same open-guard the queued branch has: the failed restore must
    // not yank the user's new draft out from under them.
    expect(state.open).toBe(true)
    expect(state.activeAccountId).toBe("acc-2")
    expect(state.subject).toBe("fresh work")
  })

  it("clamps the window: 2s fires at 5s, 60s fires at 30s", async () => {
    beginWindow(2)
    expect(useComposerStore.getState().undoWindow?.totalSeconds).toBe(5)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(sendSpy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(sendSpy).toHaveBeenCalledTimes(1)

    beginWindow(60)
    expect(useComposerStore.getState().undoWindow?.totalSeconds).toBe(30)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(sendSpy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sendSpy).toHaveBeenCalledTimes(2)
    expect(useComposerStore.getState().undoWindow).toBeNull()
  })

  it("a delay of 0 opens no window and leaves the send to the caller", () => {
    useComposerStore.getState().openNew("acc-1")
    beginWindow(0)
    expect(useComposerStore.getState().undoWindow).toBeNull()
    expect(useComposerStore.getState().open).toBe(true)
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it("counts the remaining seconds down for the banner", async () => {
    beginWindow(10)
    expect(useComposerStore.getState().undoWindow?.remainingSeconds).toBe(10)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(useComposerStore.getState().undoWindow?.remainingSeconds).toBe(7)
  })
})

describe("composer store PGP toggles (task 18.5)", () => {
  it("flips sign and encrypt independently", () => {
    useComposerStore.getState().togglePgpSign()
    expect(useComposerStore.getState().pgpSign).toBe(true)
    expect(useComposerStore.getState().pgpEncrypt).toBe(false)

    useComposerStore.getState().togglePgpEncrypt()
    expect(useComposerStore.getState().pgpSign).toBe(true)
    expect(useComposerStore.getState().pgpEncrypt).toBe(true)

    useComposerStore.getState().togglePgpSign()
    useComposerStore.getState().togglePgpEncrypt()
    expect(useComposerStore.getState().pgpSign).toBe(false)
    expect(useComposerStore.getState().pgpEncrypt).toBe(false)
  })

  it("openNew/openWith/reset drop stale toggles like every draft field", () => {
    useComposerStore.getState().openNew("acc-1")
    useComposerStore.getState().togglePgpSign()
    useComposerStore.getState().togglePgpEncrypt()

    useComposerStore.getState().openNew("acc-2")
    expect(useComposerStore.getState().pgpSign).toBe(false)
    expect(useComposerStore.getState().pgpEncrypt).toBe(false)

    useComposerStore.getState().togglePgpEncrypt()
    useComposerStore.getState().reset()
    expect(useComposerStore.getState().pgpEncrypt).toBe(false)
  })

  it("the undo window snapshot carries the toggles; a cancel restores them", async () => {
    const sendSpy =
      vi.fn<(args: SendComposerDraftArgs) => Promise<SendComposerDraftResult>>()
    sendSpy.mockResolvedValue({
      status: "queued",
      accountId: "acc-1",
      opId: "op-1",
      threadId: "thread-1",
      messageId: "<sent@example.com>",
      queuedOffline: false,
    })
    setSendComposerDraftImplForTests(sendSpy)
    try {
      vi.useFakeTimers()
      useComposerStore.getState().openNew("acc-1")
      useComposerStore.getState().togglePgpSign()

      useComposerStore.getState().beginUndoWindow({
        delaySeconds: 10,
        sendArgs: {
          accountId: "acc-1",
          payload: {
            to: [{ email: "ada@example.com" }],
            cc: [],
            bcc: [],
            subject: "Quarterly report",
            htmlBody: "<p>Hi there</p>",
            textBody: "Hi there",
          },
          draftKey: "draft-key-1",
        },
        snapshot: {
          accountId: "acc-1",
          mode: { kind: "new" },
          draftKey: "draft-key-1",
          fromAlias: null,
          to: [{ email: "ada@example.com" }],
          cc: [],
          bcc: [],
          showCc: false,
          showBcc: false,
          subject: "Quarterly report",
          html: "<p>Hi there</p>",
          attachments: [],
          pgpSign: true,
          pgpEncrypt: false,
        },
      })

      // A cancel puts the user back with the PGP intent intact.
      expect(useComposerStore.getState().cancelUndoSend()).toBe(true)
      const state = useComposerStore.getState()
      expect(state.open).toBe(true)
      expect(state.pgpSign).toBe(true)
      expect(state.pgpEncrypt).toBe(false)

      // And toggles absent from an old snapshot restore as off.
      useComposerStore.getState().beginUndoWindow({
        delaySeconds: 10,
        sendArgs: {
          accountId: "acc-1",
          payload: {
            to: [],
            cc: [],
            bcc: [],
            subject: "",
            htmlBody: "",
            textBody: "",
          },
        },
        snapshot: {
          accountId: "acc-1",
          mode: { kind: "new" },
          draftKey: "draft-key-1",
          fromAlias: null,
          to: [],
          cc: [],
          bcc: [],
          showCc: false,
          showBcc: false,
          subject: "",
          html: "",
          attachments: [],
        },
      })
      expect(useComposerStore.getState().cancelUndoSend()).toBe(true)
      expect(useComposerStore.getState().pgpSign).toBe(false)
    } finally {
      setSendComposerDraftImplForTests(null)
      useComposerStore.getState().cancelUndoSend()
      vi.useRealTimers()
    }
  })
})
