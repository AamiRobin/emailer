import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

import { setSendComposerDraftImplForTests } from "@/services/composer/undo-send"
import type {
  SendComposerDraftArgs,
  SendComposerDraftResult,
} from "@/services/composer/send"
import { useComposerStore } from "@/stores/composer-store"

import { UndoSendBanner } from "../undo-send-banner"

/**
 * Undo-send banner (task 5.2, design D3): renders from the composer
 * store's window state wherever it is mounted (shell level), shows the
 * countdown, and its Undo action cancels the pre-send window — the send
 * seam below proves the provider send never happens — and dismisses the
 * banner. The service test (undo-send.test.ts) pins the expiry timing;
 * here we only advance timers far past the window.
 */

const sendSpy =
  vi.fn<(args: SendComposerDraftArgs) => Promise<SendComposerDraftResult>>()

function beginWindow(delaySeconds = 10): void {
  useComposerStore.getState().beginUndoWindow({
    delaySeconds,
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
    },
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  sendSpy.mockResolvedValue({
    status: "queued",
    accountId: "acc-1",
    opId: "op-1",
    threadId: "thread-1",
    messageId: "<sent@example.com>",
    queuedOffline: false,
  })
  setSendComposerDraftImplForTests(sendSpy)
})

afterEach(() => {
  cleanup()
  setSendComposerDraftImplForTests(null)
  useComposerStore.getState().cancelUndoSend()
  vi.useRealTimers()
})

describe("UndoSendBanner", () => {
  it("renders nothing while no send is pending", () => {
    render(<UndoSendBanner />)
    expect(screen.queryByTestId("undo-send-banner")).toBeNull()
  })

  it("shows the countdown during the window", async () => {
    beginWindow(10)
    render(<UndoSendBanner />)

    expect(screen.getByTestId("undo-send-banner").textContent).toContain(
      "Sending in 10s"
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000)
    })
    expect(screen.getByTestId("undo-send-banner").textContent).toContain(
      "Sending in 7s"
    )
  })

  it("Undo cancels the pending send, restores the composer and dismisses the banner", async () => {
    beginWindow(10)
    render(<UndoSendBanner />)

    fireEvent.click(screen.getByRole("button", { name: "Undo" }))

    expect(screen.queryByTestId("undo-send-banner")).toBeNull()
    const state = useComposerStore.getState()
    expect(state.open).toBe(true)
    expect(state.subject).toBe("Quarterly report")
    expect(state.to).toEqual([{ email: "ada@example.com" }])

    // The provider send never happens, however long the clock runs.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(sendSpy).not.toHaveBeenCalled()
  })

  it("expiry dismisses the banner and the send goes out once", async () => {
    beginWindow(10)
    render(<UndoSendBanner />)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })

    expect(sendSpy).toHaveBeenCalledTimes(1)
    expect(screen.queryByTestId("undo-send-banner")).toBeNull()
  })
})
