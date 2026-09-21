import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Mock } from "vitest"

import {
  getPendingOperation,
  listPendingOperations,
  markOperationProcessing,
} from "../../db/pending-operations"
import { encryptCredentials } from "../../crypto/credentials"
import { createInMemoryKeyStore } from "../../crypto/__tests__/in-memory-key-store"
import { setDefaultKeyStore } from "../../crypto/key-management"
import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { ProviderAuthError } from "../../email/types"
import type {
  AccountType,
  EmailProvider,
  FetchMessagesResult,
  MessageRef,
} from "../../email/types"
import { GmailApiError } from "../../email/gmail-api"
import { GraphApiError } from "../../email/graph-api"
import type { LabelAdminService } from "../../labels/label-admin"
import { useOnlineStore } from "../../../stores/online-store"
import {
  cancelScheduledSend,
  createScheduledSend,
  getScheduledSend,
  markScheduledSendSending,
} from "../../db/scheduled-sends"
import { buildMimeMessage } from "../../email/mime-builder"
import { initQueueSystem, shutdownQueueSystem } from "../index"
import {
  MAX_OPERATION_ATTEMPTS,
  isAccountPaused,
  processQueue,
  resumeAccountOperations,
  triggerQueueProcessing,
  type ProcessQueueOptions,
} from "../processor"
import {
  enqueueArchive,
  enqueueCreateLabel,
  enqueueDeleteFolder,
  enqueueDeleteLabel,
  enqueueMarkRead,
  enqueueMove,
  enqueueNotSpam,
  enqueueRenameFolder,
  enqueueSend,
  enqueueSendMime,
  enqueueStar,
  enqueueTrash,
  enqueueUnsubscribePost,
} from "../operation"

type FakeProvider = EmailProvider & {
  calls: string[]
  /** Re-typed so tests can reprogram the mock without a cast. */
  archive: Mock<(refs: MessageRef[]) => Promise<void>>
  markStarred: Mock<(refs: MessageRef[], starred: boolean) => Promise<void>>
}

function createFakeProvider(
  accountId: string,
  type: AccountType
): FakeProvider {
  const calls: string[] = []
  const tag = (refs: MessageRef[]) => refs.map((ref) => ref.uid).join(",")
  return {
    accountId,
    type,
    calls,
    listFolders: vi.fn(async () => []),
    deltaSync: vi.fn(async () => {
      throw new Error("unused in queue tests")
    }),
    fetchMessages: vi.fn(async (): Promise<FetchMessagesResult> => {
      throw new Error("unused in queue tests")
    }),
    fetchFlags: vi.fn(async () => []),
    storeFlags: vi.fn(async () => {}),
    markRead: vi.fn(async (refs: MessageRef[], read: boolean) => {
      calls.push(`markRead:${tag(refs)}:${read}`)
    }),
    markStarred: vi.fn(async (refs: MessageRef[], starred: boolean) => {
      calls.push(`markStarred:${tag(refs)}:${starred}`)
    }),
    addLabels: vi.fn(async (refs: MessageRef[], labelIds: string[]) => {
      calls.push(`addLabels:${tag(refs)}:${labelIds.join(",")}`)
    }),
    removeLabels: vi.fn(async (refs: MessageRef[], labelIds: string[]) => {
      calls.push(`removeLabels:${tag(refs)}:${labelIds.join(",")}`)
    }),
    archive: vi.fn(async (refs: MessageRef[]) => {
      calls.push(`archive:${tag(refs)}`)
    }),
    trash: vi.fn(async (refs: MessageRef[]) => {
      calls.push(`trash:${tag(refs)}`)
    }),
    moveToFolder: vi.fn(
      async (refs: MessageRef[], destinationFolder: string) => {
        calls.push(`move:${tag(refs)}:${destinationFolder}`)
      }
    ),
    deleteForever: vi.fn(async (refs: MessageRef[]) => {
      calls.push(`deleteForever:${tag(refs)}`)
    }),
    getMessageSource: vi.fn(async () => ""),
    sendMessage: vi.fn(
      async (input: { subject: string; messageId?: string }) => {
        calls.push(`send:${input.subject}`)
        return { messageId: input.messageId ?? "generated" }
      }
    ),
    appendMessage: vi.fn(async () => {}),
    testConnection: vi.fn(async () => ({ success: true, message: "ok" })),
  }
}

describe("queue processor", () => {
  let executor: TestExecutor
  let accountId: string
  let imapAccountId: string
  let providers: Map<string, FakeProvider>
  let constructions: string[]

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
    imapAccountId = await createAccount(executor, "imap")
    providers = new Map()
    constructions = []
  })

  afterEach(() => {
    shutdownQueueSystem()
    resumeAccountOperations()
    useOnlineStore.getState().setOnline(true)
    setDefaultKeyStore(null)
    executor.close()
  })

  function useFakeProvider(targetAccountId: string, type: AccountType) {
    const provider = createFakeProvider(targetAccountId, type)
    providers.set(targetAccountId, provider)
    return provider
  }

  function options(): ProcessQueueOptions {
    return {
      executor,
      backoffBaseMs: 0,
      getProviderForTest: (id: string) => {
        const provider = providers.get(id)
        if (!provider) throw new Error(`no fake provider for ${id}`)
        constructions.push(id)
        return provider
      },
    }
  }

  const inboxRef: MessageRef[] = [{ folder: "INBOX", uid: 7 }]

  it("skips the run while offline and replays in FIFO order once online", async () => {
    const provider = useFakeProvider(accountId, "gmail")
    await enqueueArchive(executor, accountId, inboxRef)
    await enqueueTrash(executor, accountId, inboxRef)
    await enqueueMarkRead(executor, accountId, inboxRef)
    await enqueueSend(executor, accountId, {
      from: { email: "me@example.com" },
      to: [{ email: "you@example.com" }],
      subject: "Offline send",
      messageId: "<queued-1@example.com>",
    })

    // The task's stated verification: enqueue "offline", then process
    // once connectivity returns.
    useOnlineStore.getState().setOnline(false)
    const offline = await processQueue(options())
    expect(offline.skippedOffline).toBe(true)
    expect(provider.calls).toEqual([])
    expect(await listPendingOperations(executor, accountId)).toHaveLength(4)

    useOnlineStore.getState().setOnline(true)
    const online = await processQueue(options())
    expect(online.skippedOffline).toBe(false)
    expect(online.succeeded).toBe(4)
    // Replay order matches enqueue order, flags included.
    expect(provider.calls).toEqual([
      "archive:7",
      "trash:7",
      "markRead:7:true",
      "send:Offline send",
    ])
    expect(await listPendingOperations(executor, accountId)).toHaveLength(0)
    const statuses = await executor.select<{ status: string }>(
      "SELECT status FROM pending_operations ORDER BY seq ASC"
    )
    expect(statuses.map((row) => row.status)).toEqual([
      "done",
      "done",
      "done",
      "done",
    ])
  })

  it("retries transient failures with attempts increment, then fails permanently at the cap", async () => {
    const provider = useFakeProvider(imapAccountId, "imap")
    provider.archive.mockRejectedValue(new Error("imap connection dropped"))
    const id = await enqueueArchive(executor, imapAccountId, inboxRef)

    for (let attempt = 1; attempt < MAX_OPERATION_ATTEMPTS; attempt += 1) {
      const result = await processQueue(options())
      expect(result.requeued).toBe(1)
      const row = await getPendingOperation(executor, id)
      expect(row?.attempts).toBe(attempt)
      expect(row?.status).toBe("pending")
      expect(row?.last_error).toBe("imap connection dropped")
    }

    // Fifth attempt hits the cap: terminal 'failed', no longer retried.
    const final = await processQueue(options())
    expect(final.failed).toBe(1)
    const row = await getPendingOperation(executor, id)
    expect(row?.attempts).toBe(MAX_OPERATION_ATTEMPTS)
    expect(row?.status).toBe("failed")

    // Terminal rows never execute again.
    const after = await processQueue(options())
    expect(after.attempted).toBe(0)
    expect(provider.archive).toHaveBeenCalledTimes(MAX_OPERATION_ATTEMPTS)
  })

  it("completes a permanent Graph 404 as terminal on the FIRST attempt, error recorded once", async () => {
    const provider = useFakeProvider(accountId, "microsoft")
    provider.moveToFolder = vi.fn(async () => {
      throw new GraphApiError(
        404,
        "Graph POST me/messages/m1/move failed with 404 [ErrorItemNotFound]",
        "ErrorItemNotFound"
      )
    })
    const id = await enqueueMove(executor, accountId, inboxRef, "Archive")

    const result = await processQueue(options())
    // Failed fast: no requeue, no retry budget burned.
    expect(result.failed).toBe(1)
    expect(result.requeued).toBe(0)
    expect(result.succeeded).toBe(0)
    expect(provider.moveToFolder).toHaveBeenCalledTimes(1)

    const row = await getPendingOperation(executor, id)
    expect(row?.status).toBe("failed")
    expect(row?.attempts).toBe(0)
    expect(row?.last_error).toContain("ErrorItemNotFound")

    // Nothing pending left and a later pass never executes the op again.
    expect(await listPendingOperations(executor, accountId)).toHaveLength(0)
    const second = await processQueue(options())
    expect(second.attempted).toBe(0)
    expect(provider.moveToFolder).toHaveBeenCalledTimes(1)
  })

  it("treats Graph 403 the same terminal way but keeps retrying other failures", async () => {
    const provider = useFakeProvider(accountId, "microsoft")
    provider.moveToFolder = vi.fn(async () => {
      throw new GraphApiError(403, "Graph failed with 403 [ErrorAccessDenied]")
    })
    const id = await enqueueMove(executor, accountId, inboxRef, "Archive")

    const result = await processQueue(options())
    expect(result.failed).toBe(1)
    expect(result.requeued).toBe(0)
    const row = await getPendingOperation(executor, id)
    expect(row?.status).toBe("failed")
    expect(provider.moveToFolder).toHaveBeenCalledTimes(1)
  })

  it("holds the FIFO position while an operation retries", async () => {
    const provider = useFakeProvider(accountId, "imap")
    // One-off failure that still records the attempt (mockRejectedValueOnce
    // would replace the recording implementation).
    provider.archive.mockImplementationOnce(async (refs: MessageRef[]) => {
      provider.calls.push(`archive:${refs.map((ref) => ref.uid).join(",")}`)
      throw new Error("transient")
    })
    await enqueueArchive(executor, accountId, [{ folder: "INBOX", uid: 1 }])
    await enqueueStar(executor, accountId, [{ folder: "INBOX", uid: 2 }])

    const first = await processQueue(options())
    expect(first.requeued).toBe(1)
    expect(first.succeeded).toBe(0)
    // The star op waits; a later op never overtakes a failed earlier one.
    expect(provider.calls).toEqual(["archive:1"])

    const second = await processQueue(options())
    expect(second.succeeded).toBe(2)
    // Attempt 2 of the archive (recorded by the default mock) then the star.
    expect(provider.calls).toEqual([
      "archive:1",
      "archive:1",
      "markStarred:2:true",
    ])
  })

  it("continues other accounts while an auth error pauses one", async () => {
    const failing = useFakeProvider(accountId, "gmail")
    // The first archive attempt records itself, then fails with the typed
    // auth error; later attempts use the default (succeeding) mock.
    failing.archive.mockImplementationOnce(async (refs: MessageRef[]) => {
      failing.calls.push(`archive:${refs.map((ref) => ref.uid).join(",")}`)
      throw new ProviderAuthError(accountId, "gmail", "invalid credentials")
    })
    const healthy = useFakeProvider(imapAccountId, "imap")
    await enqueueArchive(executor, accountId, inboxRef)
    await enqueueStar(executor, accountId, inboxRef)
    await enqueueTrash(executor, imapAccountId, inboxRef)

    const first = await processQueue(options())
    expect(first.succeeded).toBe(1)
    expect(first.pausedAccounts).toEqual([accountId])
    expect(isAccountPaused(accountId)).toBe(true)

    // The failing account's ops stay pending; the healthy one drained.
    expect(await listPendingOperations(executor, accountId)).toHaveLength(2)
    expect(await listPendingOperations(executor, imapAccountId)).toHaveLength(0)

    // Paused accounts are skipped, not retried into the ground.
    const second = await processQueue(options())
    expect(second.attempted).toBe(0)
    expect(constructions.filter((id) => id === accountId)).toHaveLength(1)

    // Task 5.6 resumes after re-auth; the queue drains in order.
    resumeAccountOperations(accountId)
    const third = await processQueue(options())
    expect(third.succeeded).toBe(2)
    expect(isAccountPaused(accountId)).toBe(false)
    // Attempt 2 of the archive (default mock) then the star op.
    expect(failing.calls).toEqual([
      "archive:7",
      "archive:7",
      "markStarred:7:true",
    ])
    expect(healthy.calls).toEqual(["trash:7"])
  })

  it("coalesces overlapping runs (single-flight)", async () => {
    const provider = useFakeProvider(accountId, "imap")
    let releaseArchive!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseArchive = resolve
    })
    provider.archive.mockImplementationOnce(async (refs: MessageRef[]) => {
      provider.calls.push(`archive:${refs.map((ref) => ref.uid).join(",")}`)
      await gate
    })
    await enqueueArchive(executor, accountId, inboxRef)
    await enqueueStar(executor, accountId, inboxRef)

    const first = processQueue(options())
    const second = processQueue(options())
    expect(second).toBe(first)

    releaseArchive()
    const result = await first
    expect(result.succeeded).toBe(2)
    // One pass only: the provider was built once and each op ran once.
    expect(constructions).toEqual([accountId])
    expect(provider.calls).toEqual(["archive:7", "markStarred:7:true"])
    // The coalesced follow-up pass finds an empty queue — no double run.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(constructions).toEqual([accountId])
    expect(provider.calls).toEqual(["archive:7", "markStarred:7:true"])
  })

  it("dispatches not_spam through the label surface", async () => {
    const provider = useFakeProvider(accountId, "gmail")
    await enqueueNotSpam(executor, accountId, inboxRef)

    const result = await processQueue(options())
    expect(result.succeeded).toBe(1)
    expect(provider.calls).toEqual(["removeLabels:7:SPAM", "addLabels:7:INBOX"])
  })

  it("replays a queued one-click unsubscribe POST (task 18.3, D13)", async () => {
    useFakeProvider(accountId, "gmail") // built like any batch, unused by the op
    await enqueueUnsubscribePost(executor, {
      accountId,
      url: "https://lists.example.com/u/123",
    })

    const post = vi.fn(async (url: string) => url)
    const result = await processQueue({
      ...options(),
      unsubscribePostForTest: async (id, op) => {
        expect(id).toBe(accountId)
        expect(op.url).toBe("https://lists.example.com/u/123")
        await post(op.url)
      },
    })
    expect(result.succeeded).toBe(1)
    expect(result.failed).toBe(0)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith("https://lists.example.com/u/123")

    // The op is done and out of the pending list.
    const rows = await listPendingOperations(executor, accountId)
    expect(rows).toHaveLength(0)
  })

  it("retries a failing unsubscribe replay and fails it at the cap", async () => {
    useFakeProvider(accountId, "gmail")
    await enqueueUnsubscribePost(executor, {
      accountId,
      url: "https://lists.example.com/u/404",
    })

    for (let attempt = 0; attempt < MAX_OPERATION_ATTEMPTS; attempt += 1) {
      const result = await processQueue({
        ...options(),
        unsubscribePostForTest: async () => {
          throw new Error("list server exploded")
        },
      })
      if (attempt < MAX_OPERATION_ATTEMPTS - 1) {
        expect(result.requeued).toBe(1)
      } else {
        expect(result.failed).toBe(1)
      }
    }
    const rows = await executor.select<{
      status: string
      last_error: string | null
    }>(
      "SELECT status, last_error FROM pending_operations WHERE account_id = $1",
      [accountId]
    )
    expect(rows[0]?.status).toBe("failed")
    expect(rows[0]?.last_error).toContain("list server exploded")
  })

  it("keeps a scheduled IMAP send's aliased From header (fromAlias)", async () => {
    const provider = useFakeProvider(imapAccountId, "imap")
    // The stored payload is frozen at schedule time with the alias the
    // composer had selected (design D10): the From HEADER carries the
    // alias while the envelope must stay the account identity.
    const mime = [
      "From: Newsletter Alias <alias@sender.example>",
      `To: reader@example.com`,
      "Subject: Aliased later",
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: base64",
      "",
      "SGVsbG8=",
    ].join("\r\n")
    await enqueueSendMime(executor, {
      accountId: imapAccountId,
      mime,
      scheduledSendId: "ss-alias-1",
    })

    const result = await processQueue(options())
    expect(result.succeeded).toBe(1)

    expect(provider.sendMessage).toHaveBeenCalledTimes(1)
    const input = vi.mocked(provider.sendMessage).mock.calls[0][0] as {
      from: { email: string }
      fromAlias?: { email: string; name?: string }
      subject: string
      to: { email: string }[]
    }
    // The header identity is the alias; the envelope stays the account.
    expect(input.fromAlias).toEqual({
      email: "alias@sender.example",
      name: "Newsletter Alias",
    })
    // The envelope stays the account identity (the fixture account's
    // address), never the alias.
    expect(input.from.email).toBe(`${imapAccountId}@example.com`)
    expect(input.from.email).not.toBe("alias@sender.example")
    expect(input.subject).toBe("Aliased later")
    expect(input.to).toEqual([{ email: "reader@example.com" }])
  })

  // ---- Cancel vs transmission races: a cancelled scheduled send must
  // never transmit, whether the cancel lands before its claim or after
  // (while its op sat queued through an offline hold / retry backoff). ----

  it("skips a send_mime op whose row was cancelled before its claim", async () => {
    const provider = useFakeProvider(imapAccountId, "imap")
    const rowId = await createScheduledSend(executor, {
      accountId: imapAccountId,
      mimePayload: "m",
      recipients: [{ email: "you@example.com" }],
      subject: "Later",
      dueAt: Math.floor(Date.now() / 1000) - 60,
    })
    await enqueueSendMime(executor, {
      accountId: imapAccountId,
      mime: "m",
      scheduledSendId: rowId,
    })
    // Cancel-before-claim: the guarded transition applies ('scheduled' →
    // 'cancelled') and reports the applied boolean.
    expect(await cancelScheduledSend(executor, rowId)).toBe(true)

    const result = await processQueue(options())
    // The op completes (treated as applied — it must not retry) but
    // nothing transmits and the row stays honestly 'cancelled'.
    expect(result.succeeded).toBe(1)
    expect(provider.sendMessage).not.toHaveBeenCalled()
    expect((await getScheduledSend(executor, rowId))?.status).toBe("cancelled")
    expect(await listPendingOperations(executor, imapAccountId)).toHaveLength(0)
    // 'cancelled' is final: re-cancelling reports false.
    expect(await cancelScheduledSend(executor, rowId)).toBe(false)
  })

  it("skips a send_mime op replaying after a cancel-during-claim (offline hold)", async () => {
    const provider = useFakeProvider(imapAccountId, "imap")
    const rowId = await createScheduledSend(executor, {
      accountId: imapAccountId,
      mimePayload: "m",
      recipients: [{ email: "you@example.com" }],
      subject: "Later still",
      dueAt: Math.floor(Date.now() / 1000) - 60,
    })
    await enqueueSendMime(executor, {
      accountId: imapAccountId,
      mime: "m",
      scheduledSendId: rowId,
    })
    // The due pass claimed the row immediately (even offline) and its op
    // sat queued: go offline, then cancel the claimed ('sending') row.
    expect(await markScheduledSendSending(executor, rowId)).toBe(true)
    useOnlineStore.getState().setOnline(false)
    expect((await processQueue(options())).skippedOffline).toBe(true)
    expect(await cancelScheduledSend(executor, rowId)).toBe(true)

    // Back online: the replayed op must NOT transmit. It completes so it
    // cannot retry, and the guarded 'sending'-only sent-stamp leaves the
    // row exactly as the user left it: 'cancelled'.
    useOnlineStore.getState().setOnline(true)
    const result = await processQueue(options())
    expect(result.succeeded).toBe(1)
    expect(provider.sendMessage).not.toHaveBeenCalled()
    expect((await getScheduledSend(executor, rowId))?.status).toBe("cancelled")
  })

  it("unfolds a folded From header when rebuilding the send input", async () => {
    const provider = useFakeProvider(imapAccountId, "imap")
    // The builder folds long headers with CRLF + WSP; a naive single-line
    // parse would truncate the display name (or see a bare address).
    const mime = [
      "From: A Very Long Encoded Display Name That The Builder\r\n Folds Onto A Continuation Line <sender@example.com>",
      "To: reader@example.com",
      "Subject: Folded from",
      'Content-Type: text/plain; charset="utf-8"',
      "Content-Transfer-Encoding: base64",
      "",
      "SGVsbG8=",
    ].join("\r\n")
    await enqueueSendMime(executor, {
      accountId: imapAccountId,
      mime,
      scheduledSendId: "ss-fold-1",
    })

    const result = await processQueue(options())
    expect(result.succeeded).toBe(1)
    const input = vi.mocked(provider.sendMessage).mock.calls[0][0] as {
      fromAlias?: { email: string; name?: string }
    }
    // The full name + address survive the unfold.
    expect(input.fromAlias).toEqual({
      email: "sender@example.com",
      name: "A Very Long Encoded Display Name That The Builder Folds Onto A Continuation Line",
    })
  })

  it("rebuilds a text/plain-only payload with its body (textBody round-trip)", async () => {
    const provider = useFakeProvider(imapAccountId, "imap")
    // The real builder emits a text/plain-only alternative when no HTML
    // body is set; decomposeMimeMessage must hand that body back so the
    // SMTP rebuild carries it instead of an empty body.
    const built = buildMimeMessage({
      from: { email: `${imapAccountId}@example.com` },
      to: [{ email: "reader@example.com" }],
      subject: "Plain only",
      textBody: "Just plain text",
      messageId: "<plain@example.com>",
    })
    await enqueueSendMime(executor, {
      accountId: imapAccountId,
      mime: built.mime,
      scheduledSendId: "ss-plain-1",
    })

    const result = await processQueue(options())
    expect(result.succeeded).toBe(1)
    const input = vi.mocked(provider.sendMessage).mock.calls[0][0] as {
      textBody?: string
      htmlBody?: string
      subject: string
      messageId?: string
    }
    expect(input.textBody).toBe("Just plain text")
    expect(input.htmlBody).toBeUndefined()
    expect(input.subject).toBe("Plain only")
    expect(input.messageId).toBe("<plain@example.com>")
  })

  // ---- Account-wide FIFO backoff gate: a backoff-gated op must never be
  // overtaken by a later op — across cycles too (a stale draft_upsert
  // replaying past a newer one would overwrite it). ----

  it("a backoff-gated head op gates the whole account for the cycle", async () => {
    const gated = useFakeProvider(accountId, "imap")
    const other = useFakeProvider(imapAccountId, "imap")
    gated.archive.mockImplementationOnce(async () => {
      throw new Error("transient")
    })
    await enqueueArchive(executor, accountId, [{ folder: "INBOX", uid: 1 }])
    await enqueueStar(executor, accountId, [{ folder: "INBOX", uid: 2 }])
    await enqueueTrash(executor, imapAccountId, inboxRef)

    const first = await processQueue({ ...options(), backoffBaseMs: 50 })
    expect(first.requeued).toBe(1)

    // Next cycle while the head's backoff is still live: the account is
    // skipped ENTIRELY — the star op must not overtake the gated archive
    // (a per-op gate would have let it replay). Other accounts drain on.
    const second = await processQueue({ ...options(), backoffBaseMs: 50 })
    expect(second.attempted).toBe(0)
    expect(gated.calls).toEqual([])
    expect(other.calls).toEqual(["trash:7"])

    // Once the backoff clears, the account drains in FIFO order.
    await new Promise((resolve) => setTimeout(resolve, 60))
    const third = await processQueue({ ...options(), backoffBaseMs: 50 })
    expect(third.succeeded).toBe(2)
    expect(gated.calls).toEqual(["archive:1", "markStarred:2:true"])
  })

  it("a mid-batch op's backoff does not gate the cycle's head; it gates once it is the oldest pending", async () => {
    const provider = useFakeProvider(accountId, "imap")
    provider.markStarred.mockImplementationOnce(async () => {
      throw new Error("transient")
    })
    await enqueueArchive(executor, accountId, [{ folder: "INBOX", uid: 1 }])
    await enqueueStar(executor, accountId, [{ folder: "INBOX", uid: 2 }])
    await enqueueMarkRead(executor, accountId, [{ folder: "INBOX", uid: 3 }])

    // Cycle 1: the head runs even though a later op's backoff gets set
    // during this very cycle; the within-cycle fail-fast stops the batch
    // at the star so the mark-read never starts.
    const first = await processQueue({ ...options(), backoffBaseMs: 50 })
    expect(first.succeeded).toBe(1)
    expect(first.requeued).toBe(1)
    expect(provider.calls).toEqual(["archive:1"])

    // Cycle 2: the star is now the account's OLDEST pending op, so its
    // backoff gates the account — the mark-read must not overtake it.
    const second = await processQueue({ ...options(), backoffBaseMs: 50 })
    expect(second.attempted).toBe(0)
    expect(provider.calls).toEqual(["archive:1"])

    // Backoff clears: FIFO resumes (star retried first, then mark-read).
    await new Promise((resolve) => setTimeout(resolve, 60))
    const third = await processQueue({ ...options(), backoffBaseMs: 50 })
    expect(third.succeeded).toBe(2)
    expect(provider.calls).toEqual([
      "archive:1",
      "markStarred:2:true",
      "markRead:3:true",
    ])
  })

  describe("production provider path", () => {
    it("assembles the provider from the account row and decrypted credentials", async () => {
      setDefaultKeyStore(createInMemoryKeyStore())
      const envelope = await encryptCredentials({ password: "app-secret" })
      await executor.execute(
        `UPDATE accounts SET credentials_json = $1, imap_host = $2, imap_port = $3
        WHERE id = $4`,
        [envelope, "imap.example.com", 993, imapAccountId]
      )
      const id = await enqueueArchive(executor, imapAccountId, inboxRef)

      // No getProviderForTest: buildProvider loads the row, decrypts, and
      // uses the registered imap provider. Execution then fails on the
      // missing Tauri runtime — proving assembly reached the provider.
      const result = await processQueue({ executor, backoffBaseMs: 0 })
      expect(result.attempted).toBe(1)
      expect(result.requeued).toBe(1)
      expect(result.pausedAccounts).toEqual([])
      const row = await getPendingOperation(executor, id)
      expect(row?.attempts).toBe(1)
      expect(row?.status).toBe("pending")
      expect(row?.last_error).toBeTruthy()
    })

    it("pauses accounts with no stored credentials", async () => {
      await enqueueArchive(executor, imapAccountId, inboxRef)

      const result = await processQueue({ executor, backoffBaseMs: 0 })
      expect(result.attempted).toBe(0)
      expect(result.pausedAccounts).toEqual([imapAccountId])
      expect(isAccountPaused(imapAccountId)).toBe(true)
      expect(await listPendingOperations(executor, imapAccountId)).toHaveLength(
        1
      )
    })

    it("pauses accounts already marked auth-error in the DB", async () => {
      await executor.execute(
        "UPDATE accounts SET status = 'auth-error' WHERE id = $1",
        [imapAccountId]
      )
      await enqueueArchive(executor, imapAccountId, inboxRef)

      const result = await processQueue({ executor, backoffBaseMs: 0 })
      expect(result.pausedAccounts).toEqual([imapAccountId])
      expect(result.attempted).toBe(0)
    })
  })

  describe("initQueueSystem", () => {
    it("recovers stale processing rows and drains the queue on start", async () => {
      const provider = useFakeProvider(accountId, "imap")
      const id = await enqueueArchive(executor, accountId, inboxRef)
      // Simulate a previous session dying mid-replay.
      await markOperationProcessing(executor, id)

      await initQueueSystem({
        executor,
        backoffBaseMs: 0,
        getProviderForTest: options().getProviderForTest,
        intervalMs: 3_600_000,
      })
      // The startup pass is fire-and-forget; ride the next trigger (it
      // coalesces with the startup run if that is still in flight).
      await triggerQueueProcessing()

      expect(await listPendingOperations(executor, accountId)).toHaveLength(0)
      expect(provider.calls).toEqual(["archive:7"])
    })
  })

  // ---- Label/folder entity ops (task 10.4): dispatched through the
  // LabelAdminService seam, not the EmailProvider surface. ----

  function fakeLabelAdmin(targetAccountId: string): LabelAdminService {
    return {
      accountId: targetAccountId,
      accountType: "gmail",
      createServerLabel: vi.fn(async () => {}),
      renameServerLabel: vi.fn(async () => {}),
      deleteServerLabel: vi.fn(async () => {}),
      createServerFolder: vi.fn(async () => {}),
      renameServerFolder: vi.fn(async () => {}),
      deleteServerFolder: vi.fn(async () => {}),
    }
  }

  it("dispatches label-entity ops to the LabelAdminService and marks them done", async () => {
    useFakeProvider(accountId, "gmail")
    const admin = fakeLabelAdmin(accountId)
    await enqueueCreateLabel(executor, {
      accountId,
      labelId: `${accountId}:folder-Work`,
      name: "Work",
      color: "var(--chart-3)",
    })
    await enqueueDeleteLabel(executor, {
      accountId,
      labelId: `${accountId}:folder-Work`,
      name: "Work",
    })
    const renameAdmin = fakeLabelAdmin(imapAccountId)
    useFakeProvider(imapAccountId, "imap")
    await enqueueRenameFolder(executor, {
      accountId: imapAccountId,
      fromFolder: "Receipts",
      toFolder: "Receipts/2026",
    })
    await enqueueDeleteFolder(executor, {
      accountId: imapAccountId,
      folderName: "Receipts/2026",
    })

    const admins = new Map([
      [accountId, admin],
      [imapAccountId, renameAdmin],
    ])
    const result = await processQueue({
      ...options(),
      getLabelAdminForTest: (id) => {
        const candidate = admins.get(id)
        if (!candidate) throw new Error(`no fake admin for ${id}`)
        return candidate
      },
    })

    expect(result.succeeded).toBe(4)
    expect(result.failed).toBe(0)
    expect(admin.createServerLabel).toHaveBeenCalledWith({
      name: "Work",
      color: "var(--chart-3)",
    })
    expect(admin.deleteServerLabel).toHaveBeenCalledWith({ name: "Work" })
    expect(renameAdmin.renameServerFolder).toHaveBeenCalledWith(
      "Receipts",
      "Receipts/2026"
    )
    expect(renameAdmin.deleteServerFolder).toHaveBeenCalledWith("Receipts/2026")
    // Every op drained — no provider method was ever involved.
    expect(await listPendingOperations(executor)).toHaveLength(0)
  })

  it("treats already-exists/not-found replays as success via the admin classification", async () => {
    useFakeProvider(accountId, "gmail")
    const admin = fakeLabelAdmin(accountId)
    admin.createServerLabel = vi.fn(async () => {
      throw new GmailApiError(409, "duplicate label", "duplicate")
    })
    admin.deleteServerLabel = vi.fn(async () => {
      throw new GmailApiError(404, "gone", "notFound")
    })
    await enqueueCreateLabel(executor, {
      accountId,
      labelId: "l1",
      name: "Work",
    })
    await enqueueDeleteLabel(executor, {
      accountId,
      labelId: "l1",
      name: "Work",
    })

    const result = await processQueue({
      ...options(),
      getLabelAdminForTest: () => admin,
    })
    expect(result.succeeded).toBe(2)
    expect(result.requeued).toBe(0)
    expect(await listPendingOperations(executor, accountId)).toHaveLength(0)
  })

  it("pauses the account when the admin service hits an auth error", async () => {
    useFakeProvider(accountId, "gmail")
    await enqueueCreateLabel(executor, {
      accountId,
      labelId: "l1",
      name: "Work",
    })

    const result = await processQueue({
      ...options(),
      getLabelAdminForTest: () => {
        throw new ProviderAuthError(accountId, "gmail", "re-auth required")
      },
    })
    expect(result.pausedAccounts).toEqual([accountId])
    expect(result.attempted).toBe(1)
    // The op stays pending until task 5.6 resumes the account.
    expect(await listPendingOperations(executor, accountId)).toHaveLength(1)
    expect(isAccountPaused(accountId)).toBe(true)
  })
})
