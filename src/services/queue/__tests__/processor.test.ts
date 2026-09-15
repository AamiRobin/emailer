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
import type { LabelAdminService } from "../../labels/label-admin"
import { useOnlineStore } from "../../../stores/online-store"
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
  enqueueNotSpam,
  enqueueRenameFolder,
  enqueueSend,
  enqueueStar,
  enqueueTrash,
} from "../operation"

type FakeProvider = EmailProvider & {
  calls: string[]
  /** Re-typed so tests can reprogram the mock without a cast. */
  archive: Mock<(refs: MessageRef[]) => Promise<void>>
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
