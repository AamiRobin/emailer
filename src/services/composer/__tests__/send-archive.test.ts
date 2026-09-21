import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createAccount, createThread, uid } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { insertLabel } from "../../db/labels"
import { getThread } from "../../db/threads"
import {
  setSendComposerDraftImplForTests,
  sendWithUndoDelay,
} from "../undo-send"
import { sendComposerDraft } from "../send"
import type {
  SendComposerDraftArgs,
  SendComposerDraftResult,
} from "../send"

// The sent chime is a seam (same substitution as send.test.ts).
vi.mock("../../notifications/sounds", () => ({ playSentSound: vi.fn() }))

/**
 * Send & Archive (batch C2, service half): sendComposerDraft accepts an
 * archiveSourceThreadId and archives that thread — with the exact
 * thread-actions archive — ONLY after the send committed. The undo-send
 * controller carries the flag in its frozen args, so the archive rides
 * the expiry (the real send) and never a cancel.
 */

const playSentSound = vi.mocked((await import("../../notifications/sounds")).playSentSound)

function composerPayload(): SendComposerDraftArgs["payload"] {
  return {
    to: [{ email: "alice@example.com", name: "Alice" }],
    cc: [],
    bcc: [],
    subject: "Quarterly report",
    htmlBody: "<p>Hi there</p>",
    textBody: "Hi there",
  }
}

/** Inbox- and archive-role labels for a gmail account, so the archive
 * local mutation (remove INBOX membership) actually moves the thread. */
async function seedGmailSystemLabels(executor: TestExecutor, accountId: string) {
  for (const [name, gmailLabelId, specialUse] of [
    ["INBOX", "INBOX", "inbox"],
    ["SENT", "SENT", "sent"],
    ["ARCHIVE", null, "archive"],
  ] as const) {
    await insertLabel(executor, {
      id: uid("label"),
      accountId,
      name,
      ...(gmailLabelId ? { gmailLabelId } : {}),
      specialUse,
      type: "system",
    })
  }
}

async function threadArchived(
  executor: TestExecutor,
  threadId: string
): Promise<boolean> {
  const thread = await getThread(executor, threadId)
  return (thread?.is_archived ?? 0) === 1
}

describe("sendComposerDraft — Send & Archive", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("archives the source thread after the send commits", async () => {
    const accountId = await createAccount(executor, "gmail")
    await seedGmailSystemLabels(executor, accountId)
    const sourceThreadId = await createThread(executor, accountId, {
      subject: "Q3 numbers",
    })

    const result = await sendComposerDraft({
      executor,
      accountId,
      payload: composerPayload(),
      mode: { kind: "reply", inReplyTo: "<orig@example.com>", sourceThreadId },
      archiveSourceThreadId: sourceThreadId,
    })

    expect(result.status).toBe("queued")
    expect(await threadArchived(executor, sourceThreadId)).toBe(true)
  })

  it("does not archive without the flag", async () => {
    const accountId = await createAccount(executor, "gmail")
    await seedGmailSystemLabels(executor, accountId)
    const sourceThreadId = await createThread(executor, accountId)

    const result = await sendComposerDraft({
      executor,
      accountId,
      payload: composerPayload(),
      mode: { kind: "reply", inReplyTo: "<orig@example.com>", sourceThreadId },
    })

    expect(result.status).toBe("queued")
    expect(await threadArchived(executor, sourceThreadId)).toBe(false)
  })

  it("skips the archive when the send fails validation", async () => {
    const accountId = await createAccount(executor, "gmail")
    await seedGmailSystemLabels(executor, accountId)
    const sourceThreadId = await createThread(executor, accountId)

    // Validation throws (typed errors) before anything mutates — the
    // archive never runs.
    await expect(
      sendComposerDraft({
        executor,
        accountId,
        payload: { ...composerPayload(), to: [] },
        mode: {
          kind: "reply",
          inReplyTo: "<orig@example.com>",
          sourceThreadId,
        },
        archiveSourceThreadId: sourceThreadId,
      })
    ).rejects.toThrow()
    expect(await threadArchived(executor, sourceThreadId)).toBe(false)
  })

  it("an archive failure never fails the committed send", async () => {
    const accountId = await createAccount(executor, "gmail")
    await seedGmailSystemLabels(executor, accountId)

    const result = await sendComposerDraft({
      executor,
      accountId,
      payload: composerPayload(),
      mode: {
        kind: "reply",
        inReplyTo: "<orig@example.com>",
        sourceThreadId: "thread-deleted-mid-compose",
      },
      archiveSourceThreadId: "thread-deleted-mid-compose",
    })

    expect(result.status).toBe("queued")
    expect(playSentSound).toHaveBeenCalled()
  })
})

describe("sendWithUndoDelay — Send & Archive rides the frozen args", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
    vi.useFakeTimers()
  })

  afterEach(() => {
    setSendComposerDraftImplForTests(null)
    vi.useRealTimers()
    executor.close()
  })

  it("the expiry fires the send with archiveSourceThreadId intact; cancel fires nothing", async () => {
    const sentArgs: SendComposerDraftArgs[] = []
    setSendComposerDraftImplForTests(async (args) => {
      sentArgs.push(args)
      return {
        status: "queued",
        accountId: args.accountId,
        opId: "op-1",
        threadId: "thread-1",
        messageId: "<sent@example.com>",
        queuedOffline: false,
      } satisfies SendComposerDraftResult
    })

    const argsBase = {
      accountId: "acc-1",
      payload: composerPayload(),
      archiveSourceThreadId: "source-thread",
    }

    // Expiry path: the frozen args carry the archive flag.
    const controller = sendWithUndoDelay({ ...argsBase, delaySeconds: 5 })
    await vi.advanceTimersByTimeAsync(5_000)
    const result = await controller.result
    expect(result?.status).toBe("queued")
    expect(sentArgs).toHaveLength(1)
    expect(sentArgs[0].archiveSourceThreadId).toBe("source-thread")

    // Cancel path: the impl is never invoked — nothing to archive.
    const cancelled = sendWithUndoDelay({ ...argsBase, delaySeconds: 5 })
    cancelled.cancel()
    await vi.advanceTimersByTimeAsync(30_000)
    await cancelled.result
    expect(sentArgs).toHaveLength(1)
  })
})
