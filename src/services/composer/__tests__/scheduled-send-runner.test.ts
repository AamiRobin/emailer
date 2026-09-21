import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createAccount, uid } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { getAccount } from "../../db/accounts"
import {
  getPendingOperation,
  listOperationsByStatus,
  listPendingOperations,
  markOperationDone,
  markOperationFailed,
} from "../../db/pending-operations"
import { getMessage } from "../../db/messages"
import { insertLabel } from "../../db/labels"
import { listThreadsByFolder } from "../../db/threads"
import {
  cancelScheduledSend,
  createScheduledSend,
  getScheduledSend,
  markScheduledSendFailed,
  markScheduledSendSending,
  markScheduledSendSent,
} from "../../db/scheduled-sends"
import { buildMimeMessage, generateMessageId } from "../../email/mime-builder"
import type {
  AccountType,
  EmailProvider,
  FetchMessagesResult,
} from "../../email/types"
import {
  registerDueJobHandler,
  runDueJobs,
  unregisterDueJobHandler,
} from "../../sync/scheduler"
import { enqueueSendMime } from "../../queue/operation"
import { processQueue, type ProcessQueueOptions } from "../../queue/processor"
import { useOnlineStore } from "../../../stores/online-store"
import type { ComposerSendPayload } from "../../../stores/composer-store"
import { notifyScheduledSendsChanged } from "../../../components/layout/use-scheduled-sends"

// The dialog seam is replaced wholesale: the runner's contract is that it
// CALLS notifyScheduledSendsChanged (the hook module then re-queries its
// subscribers); the seam's own listener plumbing is the hook's concern.
vi.mock("../../../components/layout/use-scheduled-sends", () => ({
  notifyScheduledSendsChanged: vi.fn(),
}))
import { buildSendEmailInput } from "../send"
import {
  runDueScheduledSends,
  SCHEDULED_SENDS_DUE_JOB,
  type ScheduledSendPassSummary,
} from "../scheduled-send-runner"

/**
 * Task 10.2 (design D3): the due pass fires due scheduled sends through
 * the normal send path — enqueued as `send_mime` queue ops carrying the
 * frozen MIME, transmitted by the queue processor, and stamped
 * sent/failed from the op's outcome. The tests drive the real runner and
 * the real processor against the node:sqlite executor; only the actual
 * transmission sits behind the processor's sendMimeForTest seam (the
 * queue suite's getProviderForTest pattern). No fake timers are needed:
 * the runner takes its clock as a parameter and the queue's retry
 * backoff is injectable (backoffBaseMs: 0), so every await resolves
 * without waiting on a real or virtual clock.
 */

const NOW = 1_800_000_000

type Transmission = {
  accountId: string
  mime: string
  scheduledSendId: string
}

/** The Message-ID header the fixture builder stamped into a payload —
 * the identity the filed Sent copy must carry (the sync reconciliation
 * key when the server copy arrives). */
function messageIdOf(mime: string): string {
  const match = mime.match(/^Message-ID:\s*(\S+)\s*$/im)
  if (!match) throw new Error("fixture MIME has no Message-ID header")
  return match[1]!
}

describe("scheduled-send runner (task 10.2)", () => {
  let executor: TestExecutor
  let accountId: string
  let otherAccountId: string
  let providers: Map<string, EmailProvider>
  let transmissions: Transmission[]
  /** Scheduled-send ids whose provider transmission rejects. */
  let transmitFailsFor: Set<string>

  const makeFakeProvider = (id: string, type: AccountType): EmailProvider => ({
    accountId: id,
    type,
    listFolders: async () => [],
    deltaSync: async () => {
      throw new Error("unused in scheduled-send tests")
    },
    fetchMessages: async (): Promise<FetchMessagesResult> => {
      throw new Error("unused in scheduled-send tests")
    },
    fetchFlags: async () => [],
    storeFlags: async () => {},
    markRead: async () => {},
    markStarred: async () => {},
    addLabels: async () => {},
    removeLabels: async () => {},
    archive: async () => {},
    trash: async () => {},
    moveToFolder: async () => {},
    deleteForever: async () => {},
    getMessageSource: async () => "",
    sendMessage: async () => {
      throw new Error("scheduled sends never use the structured send")
    },
    appendMessage: async () => {},
    testConnection: async () => ({ success: true, message: "ok" }),
  })

  function queueOptions(): ProcessQueueOptions {
    return {
      executor,
      backoffBaseMs: 0,
      getProviderForTest: (id: string) => {
        const provider = providers.get(id)
        if (!provider) throw new Error(`no fake provider for ${id}`)
        return provider
      },
      sendMimeForTest: async (opAccountId, op) => {
        if (transmitFailsFor.has(op.scheduledSendId)) {
          throw new Error(`boom:${op.scheduledSendId}`)
        }
        transmissions.push({
          accountId: opAccountId,
          mime: op.mime,
          scheduledSendId: op.scheduledSendId,
        })
      },
    }
  }

  /**
   * Run the pass online with the queue seams primed: the priming pass
   * installs the options, so the runner's own in-pass queue drain
   * transmits synchronously and the summary reflects real outcomes.
   */
  async function runPassOnline(): Promise<ScheduledSendPassSummary> {
    useOnlineStore.getState().setOnline(true)
    await processQueue(queueOptions())
    return runDueScheduledSends(executor, NOW)
  }

  /** Run the pass offline: the queue skips, rows stay honestly 'sending'. */
  async function runPassOffline(): Promise<ScheduledSendPassSummary> {
    useOnlineStore.getState().setOnline(false)
    return runDueScheduledSends(executor, NOW)
  }

  /** Seed a row whose payload is a REAL built MIME (the D3 contract). */
  async function seedScheduledSend(overrides?: {
    accountId?: string
    subject?: string
    dueAt?: number
    cc?: ComposerSendPayload["cc"]
    bcc?: ComposerSendPayload["bcc"]
  }): Promise<{ id: string; mime: string }> {
    const rowAccountId = overrides?.accountId ?? accountId
    const account = await getAccount(executor, rowAccountId)
    if (!account) throw new Error("fixture account missing")
    const payload: ComposerSendPayload = {
      to: [{ email: "ada@example.com" }],
      cc: overrides?.cc ?? [],
      bcc: overrides?.bcc ?? [],
      subject: overrides?.subject ?? "Later",
      htmlBody: "<p>Hello later</p>",
      textBody: "Hello later",
    }
    const mime = buildMimeMessage(
      buildSendEmailInput(
        account,
        payload,
        undefined,
        generateMessageId(account.email)
      )
    ).mime
    const id = await createScheduledSend(executor, {
      accountId: rowAccountId,
      mimePayload: mime,
      recipients: payload.to.concat(payload.cc, payload.bcc),
      subject: payload.subject,
      dueAt: overrides?.dueAt ?? NOW - 60,
    })
    return { id, mime }
  }

  /** The account's sent-role label (the row fileIntoSent wires the copy
   * through — gmail via membership, imap via the folder). */
  async function seedSentLabel(
    targetAccountId: string,
    type: "gmail" | "imap"
  ): Promise<string> {
    const id = uid("sent-label")
    await insertLabel(executor, {
      id,
      accountId: targetAccountId,
      name: type === "gmail" ? "SENT" : "Sent",
      ...(type === "gmail"
        ? { gmailLabelId: "SENT" }
        : { imapFolderName: "Sent" }),
      specialUse: "sent",
      type: "system",
    })
    return id
  }

  async function setRowStatus(id: string, status: string): Promise<void> {
    await executor.execute(
      "UPDATE scheduled_sends SET status = $1 WHERE id = $2",
      [status, id]
    )
  }

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
    otherAccountId = await createAccount(executor, "imap")
    providers = new Map([
      [accountId, makeFakeProvider(accountId, "gmail")],
      [otherAccountId, makeFakeProvider(otherAccountId, "imap")],
    ])
    transmissions = []
    transmitFailsFor = new Set()
    vi.mocked(notifyScheduledSendsChanged).mockClear()
    useOnlineStore.getState().setOnline(true)
  })

  afterEach(() => {
    unregisterDueJobHandler(SCHEDULED_SENDS_DUE_JOB)
    useOnlineStore.getState().setOnline(true)
    executor.close()
  })

  it("fires exactly the due row with its prebuilt MIME and stamps it sent", async () => {
    const due = await seedScheduledSend({ subject: "Due now" })
    const future = await seedScheduledSend({
      subject: "Future",
      dueAt: NOW + 3_600,
    })

    const summary = await runPassOnline()

    // Exactly one transmission, and it is the stored payload byte-for-byte
    // (the point of D3: no rebuild, so Date/Message-ID stay frozen).
    expect(summary).toEqual({ sent: 1, failed: 0 })
    expect(transmissions).toHaveLength(1)
    expect(transmissions[0]).toEqual({
      accountId,
      mime: due.mime,
      scheduledSendId: due.id,
    })

    const sentRow = await getScheduledSend(executor, due.id)
    expect(sentRow?.status).toBe("sent")
    expect(typeof sentRow?.sent_at).toBe("number")
    expect(sentRow?.sent_at).toBeGreaterThan(0)

    // The future row is untouched: still scheduled, never transmitted.
    const futureRow = await getScheduledSend(executor, future.id)
    expect(futureRow?.status).toBe("scheduled")
    expect(futureRow?.sent_at).toBeNull()
    expect(
      transmissions.filter((call) => call.scheduledSendId === future.id)
    ).toEqual([])

    // The op completed and carried the row id.
    const doneOps = await listOperationsByStatus(executor, "done")
    expect(doneOps).toHaveLength(1)
    expect(doneOps[0]?.op_type).toBe("send_mime")
    expect(doneOps[0]?.payload_json).toContain(due.id)
  })

  it("catches up a send whose due passed while the app was closed", async () => {
    const missed = await seedScheduledSend({
      subject: "Missed",
      dueAt: NOW - 2 * 24 * 3_600,
    })

    const summary = await runPassOnline()

    // Same pass, same seam: due_at <= now is the only gate, so the
    // two-day-old row transmits with the rest.
    expect(summary).toEqual({ sent: 1, failed: 0 })
    expect(transmissions.map((call) => call.scheduledSendId)).toEqual([
      missed.id,
    ])
    expect(transmissions[0]?.mime).toBe(missed.mime)
    expect((await getScheduledSend(executor, missed.id))?.status).toBe("sent")
  })

  it("files the due row's local Sent copy and the op in one pass (gmail)", async () => {
    const sentLabelId = await seedSentLabel(accountId, "gmail")
    const due = await seedScheduledSend({
      subject: "Filed copy",
      cc: [{ email: "bob@example.com" }],
    })

    const summary = await runPassOnline()

    expect(summary).toEqual({ sent: 1, failed: 0 })

    // The copy is readable through the thread layer's Sent view — the
    // gap this closes: a fired scheduled send shows up in Sent exactly
    // like an immediate send's message.
    const sentThreads = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "specialUse", specialUse: "sent" },
    })
    expect(sentThreads).toHaveLength(1)
    const thread = sentThreads[0]
    expect(thread?.subject).toBe("Filed copy")
    expect(thread?.message_count).toBe(1)
    expect(thread?.unread_count).toBe(0) // own mail is read
    const threadLabels = await executor.select<{ label_id: string }>(
      "SELECT label_id FROM thread_labels WHERE thread_id = $1",
      [thread?.id]
    )
    expect(threadLabels.map((row) => row.label_id)).toEqual([sentLabelId])

    // The message row shows the frozen payload's content: the to/cc
    // split parsed from its headers, the account as sender, and the
    // Message-ID the transmission carries. Provider ids stay null —
    // the same provisional row an immediate send files; the next sync's
    // reconciliation replaces it with the server copy.
    const messageRows = await executor.select<{ id: string }>(
      "SELECT id FROM messages WHERE thread_id = $1",
      [thread?.id]
    )
    expect(messageRows).toHaveLength(1)
    const stored = await getMessage(executor, messageRows[0]?.id ?? "")
    expect(stored?.account_id).toBe(accountId)
    expect(stored?.to).toEqual([{ email: "ada@example.com" }])
    expect(stored?.cc).toEqual([{ email: "bob@example.com" }])
    expect(stored?.from_address).toBe(`${accountId}@example.com`)
    expect(stored?.message_id_header).toBe(messageIdOf(due.mime))
    expect(stored?.gmail_message_id).toBeNull()
    expect(stored?.imap_uid).toBeNull()

    // And the op went out exactly as before: one send_mime, done,
    // carrying the row id.
    const doneOps = await listOperationsByStatus(executor, "done")
    expect(doneOps).toHaveLength(1)
    expect(doneOps[0]?.op_type).toBe("send_mime")
    expect(doneOps[0]?.payload_json).toContain(due.id)
  })

  it("files the due row's local Sent copy offline, without waiting for the queue (imap)", async () => {
    const sentLabelId = await seedSentLabel(otherAccountId, "imap")
    const due = await seedScheduledSend({
      accountId: otherAccountId,
      subject: "Offline copy",
    })

    // The offline pass transmits nothing, but the copy is local and
    // immediate — that is the point of filing at claim time.
    const summary = await runPassOffline()
    expect(summary).toEqual({ sent: 0, failed: 0 })
    expect(transmissions).toEqual([])
    expect((await getScheduledSend(executor, due.id))?.status).toBe("sending")

    const sentThreads = await listThreadsByFolder(executor, {
      accountId: otherAccountId,
      folder: { kind: "specialUse", specialUse: "sent" },
    })
    expect(sentThreads).toHaveLength(1)
    expect(sentThreads[0]?.subject).toBe("Offline copy")
    // imap files through the thread's folder, not label membership.
    expect(sentThreads[0]?.folder_label_id).toBe(sentLabelId)

    const queued = await listPendingOperations(executor, otherAccountId)
    expect(queued).toHaveLength(1)
    expect(queued[0]?.op_type).toBe("send_mime")

    // The queue's replay transmits later and files NO second copy.
    useOnlineStore.getState().setOnline(true)
    await processQueue(queueOptions())
    expect((await getScheduledSend(executor, due.id))?.status).toBe("sent")
    expect(transmissions).toHaveLength(1)
    expect(transmissions[0]?.mime).toBe(due.mime)
    const after = await listThreadsByFolder(executor, {
      accountId: otherAccountId,
      folder: { kind: "specialUse", specialUse: "sent" },
    })
    expect(after).toHaveLength(1)
  })

  it("keeps an offline due send honestly 'sending' until the queue replays it", async () => {
    const due = await seedScheduledSend()

    const summary = await runPassOffline()

    // Nothing terminal happened during the pass — and that is the honest
    // summary. The row is claimed and the op is durably queued.
    expect(summary).toEqual({ sent: 0, failed: 0 })
    expect(transmissions).toEqual([])
    expect((await getScheduledSend(executor, due.id))?.status).toBe("sending")

    const queued = await listPendingOperations(executor, accountId)
    expect(queued).toHaveLength(1)
    expect(queued[0]?.op_type).toBe("send_mime")
    expect(queued[0]?.payload_json).toContain(due.id)
    // The frozen MIME travels inside the op payload (base64 part bodies,
    // so the HTML text itself only appears in encoded form).
    expect(queued[0]?.payload_json).toContain("multipart/alternative")

    // Connectivity returns → the standard queue replay transmits and the
    // processor stamps the row sent. This is the whole replay mechanism.
    useOnlineStore.getState().setOnline(true)
    const replay = await processQueue(queueOptions())
    expect(replay.skippedOffline).toBe(false)
    expect(replay.succeeded).toBe(1)
    expect(transmissions).toHaveLength(1)
    expect(transmissions[0]?.mime).toBe(due.mime)
    expect((await getScheduledSend(executor, due.id))?.status).toBe("sent")
  })

  it("fails only the failing row, isolates per account, and never rejects the pass", async () => {
    const failing = await seedScheduledSend({ subject: "Fails" })
    const healthy = await seedScheduledSend({
      accountId: otherAccountId,
      subject: "Healthy",
    })
    transmitFailsFor = new Set([failing.id])

    // First pass: the failing account's batch stops after attempt 1; the
    // healthy account sends.
    const summary = await runPassOnline()
    expect(summary).toEqual({ sent: 1, failed: 0 })
    expect(transmissions.map((call) => call.scheduledSendId)).toEqual([
      healthy.id,
    ])
    expect((await getScheduledSend(executor, failing.id))?.status).toBe(
      "sending"
    )

    // Drain the retry budget (backoffBaseMs 0): attempts 2..5, the fifth
    // parks the op as terminal 'failed' and stamps the row.
    useOnlineStore.getState().setOnline(true)
    for (let run = 0; run < 4; run += 1) {
      await processQueue(queueOptions())
    }

    const failedRow = await getScheduledSend(executor, failing.id)
    expect(failedRow?.status).toBe("failed")
    expect(failedRow?.last_error).toContain(`boom:${failing.id}`)
    expect((await getScheduledSend(executor, healthy.id))?.status).toBe("sent")
    // Only the healthy row ever transmitted.
    expect(transmissions.map((call) => call.scheduledSendId)).toEqual([
      healthy.id,
    ])
    expect(await listOperationsByStatus(executor, "failed")).toHaveLength(1)
  })

  it("isolates an enqueue failure inside the pass: the row fails, others still fire", async () => {
    await seedSentLabel(accountId, "gmail")
    const broken = await seedScheduledSend({ subject: "Broken enqueue" })
    const healthy = await seedScheduledSend({ subject: "Still fires" })

    // An executor whose pending_operations INSERT fails for the broken
    // row's op (the payload carries the row id) — a plain SqlExecutor
    // wrapper, so the fault is surgical.
    const wrapped = {
      select: <T>(sql: string, params?: unknown[]): Promise<T[]> =>
        executor.select<T>(sql, params),
      execute: async (sql: string, params?: unknown[]) => {
        if (
          sql.includes("INSERT INTO pending_operations") &&
          JSON.stringify(params).includes(broken.id)
        ) {
          throw new Error("enqueue write failed")
        }
        return executor.execute(sql, params)
      },
    }

    useOnlineStore.getState().setOnline(true)
    await processQueue(queueOptions())
    const summary = await runDueScheduledSends(wrapped, NOW)

    expect(summary).toEqual({ sent: 1, failed: 1 })
    const brokenRow = await getScheduledSend(executor, broken.id)
    expect(brokenRow?.status).toBe("failed")
    expect(brokenRow?.last_error).toContain("enqueue write failed")
    // Nothing was transmitted for the broken row; the healthy one fired.
    expect(transmissions.map((call) => call.scheduledSendId)).toEqual([
      healthy.id,
    ])
    // The filing precedes the enqueue, so the failed row's local copy
    // stands — the same honest record a terminal-failed immediate send
    // leaves — alongside the healthy row's copy for its transmitted send.
    const sentThreads = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "specialUse", specialUse: "sent" },
    })
    expect(sentThreads.map((thread) => thread.subject).sort()).toEqual([
      "Broken enqueue",
      "Still fires",
    ])
  })

  it("never transmits a cancelled row", async () => {
    const cancelled = await seedScheduledSend({ subject: "Cancelled" })
    await cancelScheduledSend(executor, cancelled.id)
    const due = await seedScheduledSend({ subject: "Due" })

    const summary = await runPassOnline()

    expect(summary).toEqual({ sent: 1, failed: 0 })
    expect(transmissions.map((call) => call.scheduledSendId)).toEqual([due.id])
    expect((await getScheduledSend(executor, cancelled.id))?.status).toBe(
      "cancelled"
    )
    // The guarded claim refuses non-'scheduled' rows outright.
    expect(await markScheduledSendSending(executor, cancelled.id)).toBe(false)
  })

  it("reconciles orphaned 'sending' rows instead of leaving them stuck", async () => {
    // Orphan: claimed, never enqueued (app died between the two writes).
    const orphan = await seedScheduledSend({ subject: "Orphan" })
    await setRowStatus(orphan.id, "sending")
    // Crashed after the provider accepted but before the row stamp.
    const doneOp = await seedScheduledSend({ subject: "Done op" })
    await setRowStatus(doneOp.id, "sending")
    const doneOpId = await enqueueSendMime(executor, {
      accountId,
      mime: doneOp.mime,
      scheduledSendId: doneOp.id,
    })
    await markOperationDone(executor, doneOpId)
    // Crashed after the op parked at the retry cap but before the stamp.
    const failedOp = await seedScheduledSend({ subject: "Failed op" })
    await setRowStatus(failedOp.id, "sending")
    const failedOpId = await enqueueSendMime(executor, {
      accountId,
      mime: failedOp.mime,
      scheduledSendId: failedOp.id,
    })
    await markOperationFailed(executor, failedOpId, "smtp down")
    // NOT stale: a live (pending) op still owns the row — offline hold.
    const live = await seedScheduledSend({ subject: "Live op" })
    await setRowStatus(live.id, "sending")
    await enqueueSendMime(executor, {
      accountId,
      mime: live.mime,
      scheduledSendId: live.id,
    })

    const summary = await runPassOffline()

    expect(summary).toEqual({ sent: 1, failed: 2 })
    const orphanRow = await getScheduledSend(executor, orphan.id)
    expect(orphanRow?.status).toBe("failed")
    expect(orphanRow?.last_error).toContain("interrupted")
    const doneRow = await getScheduledSend(executor, doneOp.id)
    expect(doneRow?.status).toBe("sent")
    // sent_at is the op's completion time.
    const opRow = await getPendingOperation(executor, doneOpId)
    expect(doneRow?.sent_at).toBe(opRow?.updated_at)
    const failedRow = await getScheduledSend(executor, failedOp.id)
    expect(failedRow?.status).toBe("failed")
    expect(failedRow?.last_error).toBe("smtp down")
    // The live op still owns its row.
    expect((await getScheduledSend(executor, live.id))?.status).toBe("sending")
  })

  it("notifies the Scheduled dialog seam when a pass touches rows, not otherwise", async () => {
    const notify = vi.mocked(notifyScheduledSendsChanged)
    try {
      // Nothing due → the pass touches nothing → no notification.
      await runPassOnline()
      expect(notify).not.toHaveBeenCalled()

      await seedScheduledSend()
      await runPassOnline()
      expect(notify).toHaveBeenCalledTimes(1)
    } finally {
      notify.mockClear()
    }
  })

  it("is registered as the scheduled-sends.run due job (bootstrap wiring shape)", async () => {
    expect(SCHEDULED_SENDS_DUE_JOB).toBe("scheduled-sends.run")
    // Register exactly the way bootstrap does, then drain through the
    // scheduler's registry — the due-job path itself, not a direct call.
    registerDueJobHandler(SCHEDULED_SENDS_DUE_JOB, () =>
      runDueScheduledSends(executor, NOW)
    )
    const due = await seedScheduledSend({ dueAt: NOW - 10 })
    useOnlineStore.getState().setOnline(true)
    await processQueue(queueOptions())
    await runDueJobs()
    expect(transmissions.map((call) => call.scheduledSendId)).toEqual([due.id])
    expect((await getScheduledSend(executor, due.id))?.status).toBe("sent")
  })

  it("guards the status transitions (sending → sent | failed only, once)", async () => {
    const row = await seedScheduledSend()

    // Terminal stamps refuse a row that is not 'sending'.
    expect(await markScheduledSendSent(executor, row.id, NOW)).toBe(false)
    expect(await markScheduledSendFailed(executor, row.id, "nope")).toBe(false)
    expect((await getScheduledSend(executor, row.id))?.status).toBe("scheduled")

    expect(await markScheduledSendSending(executor, row.id)).toBe(true)
    // The claim is single-shot: a re-claimed row reports false.
    expect(await markScheduledSendSending(executor, row.id)).toBe(false)
    expect(await markScheduledSendSent(executor, row.id, NOW + 5)).toBe(true)
    // 'sent' is terminal — a late failure stamp cannot rewrite it.
    expect(await markScheduledSendFailed(executor, row.id, "late")).toBe(false)
    const stamped = await getScheduledSend(executor, row.id)
    expect(stamped?.status).toBe("sent")
    expect(stamped?.sent_at).toBe(NOW + 5)
  })
})
