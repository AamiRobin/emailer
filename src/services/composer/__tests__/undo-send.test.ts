import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ComposerSendPayload } from "../../../stores/composer-store"
import {
  clampSendDelaySeconds,
  DEFAULT_SEND_DELAY_SECONDS,
  MAX_SEND_DELAY_SECONDS,
  MIN_SEND_DELAY_SECONDS,
  sendWithUndoDelay,
  setSendComposerDraftImplForTests,
} from "../undo-send"
import type { SendComposerDraftArgs, SendComposerDraftResult } from "../send"

/**
 * Undo-send service tests (task 5.1, design D3): the cancellable pre-send
 * delay. The load-bearing assertion is timing — the injected send (the
 * single choke point both the Gmail REST and IMAP/SMTP paths drain from)
 * must NOT be invoked before the window expires, and must be invoked
 * exactly once after it. All timing runs on fake timers; the provider is
 * substituted through the module's test seam, not vi.mock.
 */

function payload(
  overrides?: Partial<ComposerSendPayload>
): ComposerSendPayload {
  return {
    to: [{ email: "ada@example.com", name: "Ada" }],
    cc: [],
    bcc: [],
    subject: "Quarterly report",
    htmlBody: "<p>Hi there</p>",
    textBody: "Hi there",
    ...overrides,
  }
}

function sendArgs(
  overrides?: Partial<SendComposerDraftArgs>
): SendComposerDraftArgs {
  return {
    accountId: "acc-1",
    payload: payload(),
    draftKey: "draft-key-1",
    ...overrides,
  }
}

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

const sendSpy =
  vi.fn<(args: SendComposerDraftArgs) => Promise<SendComposerDraftResult>>()

beforeEach(() => {
  vi.useFakeTimers()
  // A resolved queued result by default; individual tests override.
  sendSpy.mockResolvedValue(queuedResult())
  setSendComposerDraftImplForTests(sendSpy)
})

afterEach(() => {
  setSendComposerDraftImplForTests(null)
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe("sendWithUndoDelay (task 5.1)", () => {
  it("does not invoke the send before expiry and fires it once after", async () => {
    const controller = sendWithUndoDelay({
      ...sendArgs(),
      delaySeconds: 10,
    })
    expect(controller.totalSeconds).toBe(10)

    await vi.advanceTimersByTimeAsync(9_999)
    expect(sendSpy).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(sendSpy).toHaveBeenCalledTimes(1)
    // The frozen send args — the payload the user clicked Send with.
    expect(sendSpy).toHaveBeenCalledWith({
      accountId: "acc-1",
      payload: payload(),
      draftKey: "draft-key-1",
    })

    await expect(controller.result).resolves.toEqual(queuedResult())
  })

  it("cancel before expiry prevents the provider send entirely", async () => {
    const controller = sendWithUndoDelay({
      ...sendArgs(),
      delaySeconds: 10,
    })

    await vi.advanceTimersByTimeAsync(3_000)
    expect(controller.cancel()).toBe(true)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(sendSpy).not.toHaveBeenCalled()
    await expect(controller.result).resolves.toBe(null)
  })

  it("cancel after expiry is a no-op (the send already happened)", async () => {
    const controller = sendWithUndoDelay({
      ...sendArgs(),
      delaySeconds: 5,
    })
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(controller.cancel()).toBe(false)
  })

  it("a delay of 0 skips the window and sends immediately", async () => {
    const controller = sendWithUndoDelay({
      ...sendArgs(),
      delaySeconds: 0,
    })

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(controller.cancel()).toBe(false)
    await expect(controller.result).resolves.toEqual(queuedResult())
  })

  it("clamps the window: 2s waits 5s, 60s waits 30s", async () => {
    const short = sendWithUndoDelay({ ...sendArgs(), delaySeconds: 2 })
    expect(short.totalSeconds).toBe(MIN_SEND_DELAY_SECONDS)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(sendSpy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(sendSpy).toHaveBeenCalledTimes(1)

    const long = sendWithUndoDelay({ ...sendArgs(), delaySeconds: 60 })
    expect(long.totalSeconds).toBe(MAX_SEND_DELAY_SECONDS)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(sendSpy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(sendSpy).toHaveBeenCalledTimes(2)
  })

  it("resolves null instead of rejecting when the send impl throws", async () => {
    sendSpy.mockRejectedValueOnce(new Error("account vanished"))
    const controller = sendWithUndoDelay({
      ...sendArgs(),
      delaySeconds: 5,
    })
    await vi.advanceTimersByTimeAsync(5_000)
    await expect(controller.result).resolves.toBe(null)
  })

  // Task 16.2 regression: the frozen sendArgs rebuild must carry the alias
  // From identity — an undo-window expiry re-enters sendComposerDraft, and
  // a send that goes through the window must reach the alias header exactly
  // as an immediate send would.
  it("freezes fromAlias into the send that fires at expiry", async () => {
    const fromAlias = { name: "User Work", email: "work@example.com" }
    const controller = sendWithUndoDelay({
      ...sendArgs(),
      fromAlias,
      delaySeconds: 10,
    })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(sendSpy).toHaveBeenCalledWith({
      accountId: "acc-1",
      payload: payload(),
      draftKey: "draft-key-1",
      fromAlias,
    })
    await expect(controller.result).resolves.toEqual(queuedResult())
  })

  it("carries the alias into the immediate send when the window is disabled (null included)", async () => {
    // The disabled window (delay 0) rebuilds the same sendArgs object, so
    // a null alias (the bare account identity) must ride it unchanged too.
    sendWithUndoDelay({
      ...sendArgs(),
      fromAlias: null,
      delaySeconds: 0,
    })
    expect(sendSpy).toHaveBeenCalledWith({
      accountId: "acc-1",
      payload: payload(),
      draftKey: "draft-key-1",
      fromAlias: null,
    })
  })
})

describe("clampSendDelaySeconds", () => {
  it("keeps 0 as the explicit opt-out and defaults non-numbers", () => {
    expect(clampSendDelaySeconds(0)).toBe(0)
    expect(clampSendDelaySeconds(-3)).toBe(0)
    expect(clampSendDelaySeconds(undefined)).toBe(DEFAULT_SEND_DELAY_SECONDS)
    expect(clampSendDelaySeconds(null)).toBe(DEFAULT_SEND_DELAY_SECONDS)
    expect(clampSendDelaySeconds("7")).toBe(DEFAULT_SEND_DELAY_SECONDS)
    expect(clampSendDelaySeconds(Number.NaN)).toBe(DEFAULT_SEND_DELAY_SECONDS)
  })

  it("rounds and clamps numeric values into 5–30", () => {
    expect(clampSendDelaySeconds(4.2)).toBe(5)
    expect(clampSendDelaySeconds(7.5)).toBe(8)
    expect(clampSendDelaySeconds(29.4)).toBe(29)
    expect(clampSendDelaySeconds(120)).toBe(MAX_SEND_DELAY_SECONDS)
  })
})
