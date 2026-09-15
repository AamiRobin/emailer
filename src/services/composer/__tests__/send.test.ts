import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount, uid } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import type { SqlExecutor } from "../../db/executor"
import { insertLabel } from "../../db/labels"
import { findLabelsBySpecialUse } from "../../db/labels"
import {
  incrementOperationAttempts,
  listOperationsByStatus,
  markOperationDone,
  markOperationFailed,
  type PendingOperationRow,
} from "../../db/pending-operations"
import { getMessage, insertMessage } from "../../db/messages"
import { getThread, insertThread, listThreadsByFolder } from "../../db/threads"
import type {
  DeltaSyncResult,
  EmailFolder,
  EmailProvider,
  FetchMessagesResult,
  MessageFlags,
  NormalizedMessage,
} from "../../email/types"
import { operationFromRow } from "../../queue/operation"
import { syncGmailAccount } from "../../sync/gmail-sync"
import { syncImapAccount } from "../../sync/imap-sync"
import { useOnlineStore } from "../../../stores/online-store"
import { saveDraft } from "../drafts"
import {
  EmptyMessageError,
  FailedSendNotFoundError,
  FailedSendNotRetryableError,
  InvalidRecipientError,
  listFailedSends,
  MissingRecipientsError,
  onSendCompleted,
  onSendFailed,
  reconcileProvisionalSent,
  retryFailedSend,
  SendAccountNotFoundError,
  sendComposerDraft,
  type SendCompletedEvent,
  type SendComposerDraftArgs,
} from "../send"

/**
 * Task 8.7 service-layer tests. There is no provider behind a send at
 * all: every send enqueues into pending_operations (the offline invariant
 * — online and offline are the same code path), the provisional Sent rows
 * are asserted through the thread/message query layer, and the sync-side
 * reconciliation wiring runs against fake providers that only serve
 * fetches.
 */

// ---- Helpers ---------------------------------------------------------------

function composerPayload(
  overrides?: Partial<SendComposerDraftArgs["payload"]>
): SendComposerDraftArgs["payload"] {
  return {
    to: [{ email: "alice@example.com", name: "Alice" }],
    cc: [],
    bcc: [],
    subject: "Quarterly report",
    htmlBody: "<p>Hi there</p>",
    textBody: "Hi there",
    ...overrides,
  }
}

async function seedDraft(
  executor: SqlExecutor,
  accountId: string,
  draftKey = "composer-1"
): Promise<string> {
  const saved = await saveDraft(executor, {
    accountId,
    draftKey,
    draft: {
      to: [{ email: "alice@example.com" }],
      cc: [],
      bcc: [],
      subject: "Quarterly report",
      bodyHtml: "<p>Hi there</p>",
    },
  })
  return saved.id
}

async function seedSentLabel(
  executor: SqlExecutor,
  accountId: string,
  type: "gmail" | "imap"
): Promise<string> {
  const id = uid("sent-label")
  await insertLabel(executor, {
    id,
    accountId,
    name: type === "gmail" ? "SENT" : "Sent",
    ...(type === "gmail"
      ? { gmailLabelId: "SENT" }
      : { imapFolderName: "Sent" }),
    specialUse: "sent",
    type: "system",
  })
  return id
}

/** Queued (pending) ops for the account, deserialized, FIFO order. */
async function queuedOps(executor: SqlExecutor, accountId: string) {
  const rows: PendingOperationRow[] = await listOperationsByStatus(
    executor,
    "pending",
    accountId
  )
  return rows.map(operationFromRow)
}

async function sentThreadIds(
  executor: SqlExecutor,
  accountId: string
): Promise<string[]> {
  const threads = await listThreadsByFolder(executor, {
    accountId,
    folder: { kind: "specialUse", specialUse: "sent" },
  })
  return threads.map((thread) => thread.id)
}

// ---- Fake providers for the sync-side reconciliation wiring ----------------

/** Stand-in for any provider method the sync path must never call. */
function unused(name: string): () => Promise<never> {
  return () => Promise.reject(new Error(`${name} must not be called`))
}

function fakeMessage(overrides: Partial<NormalizedMessage>): NormalizedMessage {
  return {
    uid: 1,
    flags: ["\\Seen"],
    from: [],
    to: [],
    cc: [],
    bcc: [],
    date: 1_700_000_100,
    size: 100,
    attachments: [],
    ...overrides,
  }
}

interface FakeSendOutcome {
  opId: string
  messageId: string
  threadId: string
  accountId: string
}

/** Send one message through the service and return its key coordinates. */
async function sendThroughService(
  executor: SqlExecutor,
  accountId: string,
  overrides?: Partial<SendComposerDraftArgs["payload"]>
): Promise<FakeSendOutcome> {
  const completed: SendCompletedEvent[] = []
  const off = onSendCompleted((event) => completed.push(event))
  const result = await sendComposerDraft({
    executor,
    accountId,
    payload: composerPayload(overrides),
  })
  off()
  if (result.status !== "queued") throw new Error("expected a queued send")
  expect(completed).toHaveLength(1)
  return {
    opId: result.opId,
    messageId: result.messageId,
    threadId: result.threadId,
    accountId,
  }
}

/** Minimal imap provider exposing one Sent folder with the given messages. */
function fakeImapProvider(
  accountId: string,
  messages: NormalizedMessage[]
): EmailProvider {
  return {
    accountId,
    type: "imap",
    listFolders: (): Promise<EmailFolder[]> =>
      Promise.resolve([
        {
          id: "SENT",
          name: "Sent",
          path: "Sent",
          type: "system",
          specialUse: "sent",
          delimiter: "/",
        },
      ]),
    deltaSync: unused("deltaSync"),
    fetchMessages: (): Promise<FetchMessagesResult> =>
      Promise.resolve({
        messages,
        folderStatus: {
          uidValidity: 42,
          uidNext: messages.length + 1,
          exists: messages.length,
          unseen: 0,
        },
      }),
    fetchFlags: (): Promise<MessageFlags[]> => Promise.resolve([]),
    storeFlags: unused("storeFlags"),
    markRead: unused("markRead"),
    markStarred: unused("markStarred"),
    addLabels: unused("addLabels"),
    removeLabels: unused("removeLabels"),
    archive: unused("archive"),
    trash: unused("trash"),
    moveToFolder: unused("moveToFolder"),
    deleteForever: unused("deleteForever"),
    sendMessage: unused("sendMessage"),
    appendMessage: unused("appendMessage"),
    testConnection: () => Promise.resolve({ success: true, message: "ok" }),
  }
}

/** Minimal gmail provider serving one full sync over the given messages. */
function fakeGmailProvider(
  accountId: string,
  messages: NormalizedMessage[]
): EmailProvider {
  return {
    accountId,
    type: "gmail",
    listFolders: (): Promise<EmailFolder[]> =>
      Promise.resolve([
        {
          id: "SENT",
          name: "SENT",
          path: "SENT",
          type: "system",
          specialUse: "sent",
          delimiter: "/",
        },
      ]),
    deltaSync: (cursor: string | null): Promise<DeltaSyncResult> =>
      Promise.resolve({
        messages: [],
        nextCursor: cursor === null ? "history-1" : "history-2",
        needsFullSync: false,
      }),
    fetchMessages: (): Promise<FetchMessagesResult> =>
      Promise.resolve({
        messages,
        folderStatus: {
          uidValidity: 0,
          uidNext: messages.length + 1,
          exists: messages.length,
          unseen: 0,
        },
      }),
    fetchFlags: (): Promise<MessageFlags[]> => Promise.resolve([]),
    storeFlags: unused("storeFlags"),
    markRead: unused("markRead"),
    markStarred: unused("markStarred"),
    addLabels: unused("addLabels"),
    removeLabels: unused("removeLabels"),
    archive: unused("archive"),
    trash: unused("trash"),
    moveToFolder: unused("moveToFolder"),
    deleteForever: unused("deleteForever"),
    sendMessage: unused("sendMessage"),
    appendMessage: unused("appendMessage"),
    testConnection: () => Promise.resolve({ success: true, message: "ok" }),
  }
}

// ---- Suite ------------------------------------------------------------------

describe("sendComposerDraft", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
    useOnlineStore.getState().setOnline(true)
  })

  describe("validation", () => {
    it("throws MissingRecipientsError and mutates nothing", async () => {
      const accountId = await createAccount(executor)
      const draftId = await seedDraft(executor, accountId)

      await expect(
        sendComposerDraft({
          executor,
          accountId,
          payload: composerPayload({
            to: [],
            subject: "",
            htmlBody: "",
            textBody: "",
          }),
          draftId,
        })
      ).rejects.toBeInstanceOf(MissingRecipientsError)

      expect(await queuedOps(executor, accountId)).toHaveLength(0)
      expect(await sentThreadIds(executor, accountId)).toHaveLength(0)
    })

    it("throws InvalidRecipientError carrying the invalid count only", async () => {
      const accountId = await createAccount(executor)
      const error = await sendComposerDraft({
        executor,
        accountId,
        payload: composerPayload({
          to: [
            { email: "not-an-address" },
            { email: "alice@example.com" },
            { email: "also@bad" },
          ],
        }),
      }).catch((caught: unknown) => caught)

      expect(error).toBeInstanceOf(InvalidRecipientError)
      expect((error as InvalidRecipientError).count).toBe(2)
      // Privacy rule: error text carries counts, never recipient content.
      expect((error as Error).message).not.toContain("not-an-address")
    })

    it("throws EmptyMessageError when subject and body are blank", async () => {
      const accountId = await createAccount(executor)
      await expect(
        sendComposerDraft({
          executor,
          accountId,
          payload: composerPayload({
            subject: "   ",
            htmlBody: "  ",
            textBody: " ",
          }),
        })
      ).rejects.toBeInstanceOf(EmptyMessageError)
    })

    it("throws SendAccountNotFoundError for an unknown account", async () => {
      await expect(
        sendComposerDraft({
          executor,
          accountId: "missing",
          payload: composerPayload(),
        })
      ).rejects.toBeInstanceOf(SendAccountNotFoundError)
    })
  })

  describe("happy path (gmail account)", () => {
    it("queues the send, files Sent locally, deletes the draft, bumps contacts and fires the listener", async () => {
      const accountId = await createAccount(executor, "gmail")
      await seedSentLabel(executor, accountId, "gmail")
      const draftId = await seedDraft(executor, accountId)
      const completed: SendCompletedEvent[] = []
      const failures: string[] = []
      const offCompleted = onSendCompleted((event) => completed.push(event))
      const offFailed = onSendFailed((event) => failures.push(event.error))

      const result = await sendComposerDraft({
        executor,
        accountId,
        payload: composerPayload({
          cc: [{ email: "alice@example.com" }], // dedupes against To
          bcc: [{ email: "hidden@example.com" }],
          textBody: "", // generated from the HTML
        }),
        draftId,
        mode: {
          kind: "reply",
          inReplyTo: "<orig@example.com>",
          references: "<root@example.com> <orig@example.com>",
        },
      })
      offCompleted()
      offFailed()

      expect(result.status).toBe("queued")
      if (result.status !== "queued") throw new Error("unreachable")
      expect(result.queuedOffline).toBe(false)
      expect(completed).toHaveLength(1)
      expect(completed[0]).toEqual({
        accountId,
        opId: result.opId,
        threadId: result.threadId,
        messageId: result.messageId,
        queuedOffline: false,
      })
      expect(failures).toHaveLength(0)

      // The draft is gone.
      const drafts = await executor.select(
        "SELECT * FROM local_drafts WHERE id = $1",
        [draftId]
      )
      expect(drafts).toHaveLength(0)

      // One queued send op carrying the full provider input.
      const ops = await queuedOps(executor, accountId)
      expect(ops).toHaveLength(1)
      const op = ops[0]
      expect(op?.kind).toBe("send")
      const input = op?.kind === "send" ? op.input : null
      expect(input).toMatchObject({
        from: { email: `${accountId}@example.com` },
        to: [{ email: "alice@example.com", name: "Alice" }],
        cc: [{ email: "alice@example.com" }],
        bcc: [{ email: "hidden@example.com" }],
        subject: "Quarterly report",
        htmlBody: "<p>Hi there</p>",
        inReplyTo: "<orig@example.com>",
        references: "<root@example.com> <orig@example.com>",
        messageId: result.messageId,
      })
      expect(input?.textBody).toContain("Hi there")

      // The message is filed into the account's Sent view.
      const sentThreads = await listThreadsByFolder(executor, {
        accountId,
        folder: { kind: "specialUse", specialUse: "sent" },
      })
      expect(sentThreads).toHaveLength(1)
      const thread = sentThreads[0]
      expect(thread?.id).toBe(result.threadId)
      expect(thread?.subject).toBe("Quarterly report")
      expect(thread?.message_count).toBe(1)
      expect(thread?.unread_count).toBe(0) // own mail is read
      expect(thread?.snippet).toContain("Hi there")
      const threadLabels = await executor.select<{ label_id: string }>(
        "SELECT label_id FROM thread_labels WHERE thread_id = $1",
        [thread?.id]
      )
      const sentLabels = await findLabelsBySpecialUse(
        executor,
        accountId,
        "sent"
      )
      expect(threadLabels.map((row) => row.label_id)).toEqual([
        sentLabels[0]?.id,
      ])

      // The provisional message row: identity, headers, no provider ids.
      const messageRows = await executor.select<{ id: string }>(
        "SELECT id FROM messages WHERE thread_id = $1",
        [thread?.id]
      )
      const stored = await getMessage(executor, messageRows[0]?.id ?? "")
      expect(stored).toMatchObject({
        account_id: accountId,
        gmail_message_id: null,
        imap_uid: null,
        imap_folder: null,
        message_id_header: result.messageId,
        in_reply_to: "<orig@example.com>",
        references_header: "<root@example.com> <orig@example.com>",
        from_address: `${accountId}@example.com`,
        subject: "Quarterly report",
        is_read: 1,
      })
      expect(stored?.snippet).toContain("Hi there")

      // Contacts bumped once per distinct address.
      const contacts = await executor.select<{
        email: string
        interaction_count: number
      }>("SELECT email, interaction_count FROM contacts ORDER BY email", [])
      expect(contacts).toEqual([
        { email: "alice@example.com", interaction_count: 1 },
        { email: "hidden@example.com", interaction_count: 1 },
      ])
    })

    it("omits cc/bcc keys when empty and derives the text part", async () => {
      const accountId = await createAccount(executor, "gmail")
      await seedSentLabel(executor, accountId, "gmail")
      await sendComposerDraft({
        executor,
        accountId,
        payload: composerPayload({ textBody: "" }),
      })
      const op = (await queuedOps(executor, accountId))[0]
      if (op?.kind !== "send") throw new Error("expected a send op")
      expect(op.input.cc).toBeUndefined()
      expect(op.input.bcc).toBeUndefined()
      expect(op.input.textBody).toBe("Hi there")
    })
  })

  describe("happy path (imap account)", () => {
    it("files Sent via the folder label and thread folder cache", async () => {
      const accountId = await createAccount(executor, "imap")
      const sentLabelId = await seedSentLabel(executor, accountId, "imap")

      const outcome = await sendThroughService(executor, accountId)

      const sentThreads = await listThreadsByFolder(executor, {
        accountId,
        folder: { kind: "specialUse", specialUse: "sent" },
      })
      expect(sentThreads).toHaveLength(1)
      expect(sentThreads[0]?.id).toBe(outcome.threadId)
      expect(sentThreads[0]?.folder_label_id).toBe(sentLabelId)
      expect(sentThreads[0]?.is_archived).toBe(0) // sent role clears the flag

      const op = (await queuedOps(executor, accountId))[0]
      expect(op?.kind).toBe("send")
    })
  })

  describe("attachments (task 8.5)", () => {
    it("carries payload attachments through the queue payload round-trip", async () => {
      const accountId = await createAccount(executor, "gmail")
      await seedSentLabel(executor, accountId, "gmail")

      const outcome = await sendThroughService(executor, accountId, {
        attachments: [
          {
            filename: "a.txt",
            mimeType: "text/plain",
            contentBase64: "aGk=",
          },
        ],
      })

      const ops = await queuedOps(executor, accountId)
      expect(ops).toHaveLength(1)
      const send = ops[0]
      if (send?.kind !== "send") throw new Error("expected a send op")
      // The base64 content survived payload_json → deserializeOperation.
      expect(send.input.attachments).toEqual([
        {
          filename: "a.txt",
          mimeType: "text/plain",
          contentBase64: "aGk=",
        },
      ])
      expect(outcome.messageId).toBeTruthy()
    })

    it("queues a send without attachments unchanged (no attachments key)", async () => {
      const accountId = await createAccount(executor, "gmail")
      await seedSentLabel(executor, accountId, "gmail")

      await sendThroughService(executor, accountId)

      const ops = await queuedOps(executor, accountId)
      const send = ops[0]
      if (send?.kind !== "send") throw new Error("expected a send op")
      expect(send.input.attachments).toBeUndefined()
    })
  })

  describe("offline", () => {
    it("queues identically and reports queuedOffline", async () => {
      const accountId = await createAccount(executor, "gmail")
      await seedSentLabel(executor, accountId, "gmail")
      useOnlineStore.getState().setOnline(false)

      const completed: SendCompletedEvent[] = []
      const off = onSendCompleted((event) => completed.push(event))
      const result = await sendComposerDraft({
        executor,
        accountId,
        payload: composerPayload(),
      })
      off()

      // Same local-first path — the row is pending and no provider is
      // ever constructed (none exists in these tests at all).
      expect(result.status).toBe("queued")
      if (result.status !== "queued") throw new Error("unreachable")
      expect(result.queuedOffline).toBe(true)
      expect(completed[0]?.queuedOffline).toBe(true)
      const rows = await listOperationsByStatus(executor, "pending", accountId)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.status).toBe("pending")
    })
  })

  describe("enqueue-path failure", () => {
    it("keeps the draft, returns failed and fires onSendFailed", async () => {
      const accountId = await createAccount(executor, "gmail")
      await seedSentLabel(executor, accountId, "gmail")
      const draftId = await seedDraft(executor, accountId)

      // Fail exactly the queue INSERT; every other statement runs.
      const failing: SqlExecutor = {
        select: (sql, params) => executor.select(sql, params),
        execute: async (sql, params) => {
          if (sql.includes("INSERT INTO pending_operations")) {
            throw new Error("disk I/O error")
          }
          return executor.execute(sql, params)
        },
      }
      const failures: { accountId: string; error: string }[] = []
      const off = onSendFailed((event) => failures.push(event))

      const result = await sendComposerDraft({
        executor: failing,
        accountId,
        payload: composerPayload(),
        draftId,
      })
      off()

      expect(result).toEqual({ status: "failed", error: "disk I/O error" })
      expect(failures).toEqual([{ accountId, error: "disk I/O error" }])
      // The message is kept: the draft survives, nothing was filed.
      const drafts = await executor.select(
        "SELECT id FROM local_drafts WHERE id = $1",
        [draftId]
      )
      expect(drafts).toHaveLength(1)
      const threads = await executor.select("SELECT * FROM threads", [])
      expect(threads).toHaveLength(0)
    })
  })
})

// ---- Failed-send retry surface ----------------------------------------------

describe("failed send retry surface", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  /** A queued send whose replay hit the processor's retry cap. */
  async function parkAFailedSend(): Promise<{
    accountId: string
    outcome: FakeSendOutcome
  }> {
    const accountId = await createAccount(executor, "gmail")
    const outcome = await sendThroughService(executor, accountId)
    await markOperationFailed(executor, outcome.opId, "SMTP connection refused")
    return { accountId, outcome }
  }

  it("listFailedSends describes parked sends without recipient content", async () => {
    const { accountId, outcome } = await parkAFailedSend()

    const failed = await listFailedSends(executor, accountId)
    expect(failed).toHaveLength(1)
    expect(failed[0]).toMatchObject({
      opId: outcome.opId,
      subject: "Quarterly report",
      recipientCount: 1,
      lastError: "SMTP connection refused",
      attempts: 0,
    })

    // Other accounts see nothing.
    const other = await createAccount(executor, "gmail")
    expect(await listFailedSends(executor, other)).toHaveLength(0)

    // Non-send ops are filtered out even in the same account.
    await executor.execute(
      "UPDATE pending_operations SET op_type = 'archive' WHERE id = $1",
      [outcome.opId]
    )
    expect(await listFailedSends(executor, accountId)).toHaveLength(0)
  })

  it("retryFailedSend requeues with the attempt budget reset", async () => {
    const { outcome } = await parkAFailedSend()
    await incrementOperationAttempts(executor, outcome.opId)
    await incrementOperationAttempts(executor, outcome.opId)

    await retryFailedSend(executor, outcome.opId)

    const rows = await listOperationsByStatus(executor, "pending")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: outcome.opId,
      status: "pending",
      attempts: 0,
      last_error: "requeued by manual retry",
    })
  })

  it("retryFailedSend rejects unknown ids and non-failed rows", async () => {
    const { outcome } = await parkAFailedSend()

    await expect(retryFailedSend(executor, "nope")).rejects.toBeInstanceOf(
      FailedSendNotFoundError
    )

    await markOperationDone(executor, outcome.opId)
    await expect(
      retryFailedSend(executor, outcome.opId)
    ).rejects.toBeInstanceOf(FailedSendNotRetryableError)
  })
})

// ---- Provisional Sent reconciliation ----------------------------------------

describe("reconcileProvisionalSent", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("deletes the provisional twin when the server copy carries the same Message-ID, and drops the emptied thread", async () => {
    const accountId = await createAccount(executor, "gmail")
    await seedSentLabel(executor, accountId, "gmail")
    const outcome = await sendThroughService(executor, accountId)

    const deleted = await reconcileProvisionalSent(executor, accountId, {
      messageIdHeader: outcome.messageId,
      subject: "Quarterly report",
      fromAddress: `${accountId}@example.com`,
      date: 1_700_000_100,
    })

    expect(deleted).toBe(1)
    const messages = await executor.select(
      "SELECT * FROM messages WHERE account_id = $1",
      [accountId]
    )
    expect(messages).toHaveLength(0)
    // The provisional thread held only this message — it goes too.
    expect(await getThread(executor, outcome.threadId)).toBeNull()
  })

  it("keeps the thread when the server copy already joined it", async () => {
    const accountId = await createAccount(executor, "imap")
    await seedSentLabel(executor, accountId, "imap")
    const outcome = await sendThroughService(executor, accountId)
    // The imap sync path attaches the server copy to the provisional
    // thread (same Message-ID) before reconciling — simulate that state.
    await insertMessage(executor, {
      id: "server-copy",
      threadId: outcome.threadId,
      accountId,
      imapUid: 7,
      imapFolder: "Sent",
      messageIdHeader: outcome.messageId,
      date: 1_700_000_100,
      subject: "Quarterly report",
    })

    const deleted = await reconcileProvisionalSent(executor, accountId, {
      messageIdHeader: outcome.messageId,
    })

    expect(deleted).toBe(1)
    const thread = await getThread(executor, outcome.threadId)
    expect(thread).not.toBeNull()
    expect(thread?.message_count).toBe(1) // recomputed after the deletion
  })

  it("falls back to sender + subject + date window without a Message-ID", async () => {
    const accountId = await createAccount(executor, "gmail")
    await seedSentLabel(executor, accountId, "gmail")
    await sendThroughService(executor, accountId)

    // Same sender and subject, dated now: within the tolerance window.
    const deleted = await reconcileProvisionalSent(executor, accountId, {
      subject: "Quarterly report",
      fromAddress: `${accountId}@example.com`,
      date: Math.floor(Date.now() / 1000),
    })
    expect(deleted).toBe(1)

    // A distant date is outside the window: the twin is kept.
    const other = await createAccount(executor, "gmail")
    await seedSentLabel(executor, other, "gmail")
    await sendThroughService(executor, other, { subject: "Old subject" })
    const kept = await reconcileProvisionalSent(executor, other, {
      subject: "Old subject",
      fromAddress: `${other}@example.com`,
      date: 1,
    })
    expect(kept).toBe(0)
    const messages = await executor.select(
      "SELECT * FROM messages WHERE account_id = $1",
      [other]
    )
    expect(messages).toHaveLength(1)
  })

  it("over-delete guard: the fallback removes only the OLDEST match when two same-subject sends sit inside the window", async () => {
    const accountId = await createAccount(executor, "gmail")
    await seedSentLabel(executor, accountId, "gmail")
    const first = await sendThroughService(executor, accountId)
    const second = await sendThroughService(executor, accountId)

    // Make "oldest" deterministic: the first send's provisional row is an
    // hour older than the second's.
    await executor.execute(
      "UPDATE messages SET date = $1 WHERE thread_id = $2",
      [Math.floor(Date.now() / 1000) - 3600, first.threadId]
    )

    // One server copy arrives without a usable Message-ID → fallback path.
    const deleted = await reconcileProvisionalSent(executor, accountId, {
      subject: "Quarterly report",
      fromAddress: `${accountId}@example.com`,
      date: Math.floor(Date.now() / 1000),
    })
    expect(deleted).toBe(1)

    // The second send's provisional row must survive for its own server
    // copy — deleting both would strand it as a phantom.
    const remaining = await executor.select<{
      id: string
      thread_id: string
    }>("SELECT id, thread_id FROM messages WHERE account_id = $1", [accountId])
    expect(remaining).toHaveLength(1)
    expect(remaining[0].thread_id).toBe(second.threadId)

    // The surviving twin is reconciled by its own server copy later.
    const deletedLater = await reconcileProvisionalSent(executor, accountId, {
      subject: "Quarterly report",
      fromAddress: `${accountId}@example.com`,
      date: Math.floor(Date.now() / 1000),
    })
    expect(deletedLater).toBe(1)
    expect(
      await executor.select("SELECT id FROM messages WHERE account_id = $1", [
        accountId,
      ])
    ).toHaveLength(0)
  })

  it("never touches rows with provider ids or unrelated provisional rows", async () => {
    const accountId = await createAccount(executor, "gmail")
    await seedSentLabel(executor, accountId, "gmail")
    const first = await sendThroughService(executor, accountId)
    const second = await sendThroughService(executor, accountId, {
      subject: "Other message",
    })
    expect(second.opId).not.toBe(first.opId)

    // Header match removes each twin exactly once.
    expect(
      await reconcileProvisionalSent(executor, accountId, {
        messageIdHeader: first.messageId,
      })
    ).toBe(1)
    expect(
      await reconcileProvisionalSent(executor, accountId, {
        messageIdHeader: second.messageId,
      })
    ).toBe(1)
    expect(
      await executor.select("SELECT * FROM messages WHERE account_id = $1", [
        accountId,
      ])
    ).toHaveLength(0)

    // A row that HAS provider ids is never a candidate, even on a header
    // match — only fully provider-id-less provisional rows are. (Both
    // provisional threads were emptied and removed by the reconciliations
    // above, so the server copy gets its own thread — the gmail sync shape.)
    await insertThread(executor, {
      id: "server-thread",
      accountId,
      subject: "Other message",
      gmailThreadId: "t9",
    })
    await insertMessage(executor, {
      id: "server-copy",
      threadId: "server-thread",
      accountId,
      gmailMessageId: "99",
      messageIdHeader: second.messageId,
      date: 1_700_000_100,
      subject: "Other message",
    })
    const deletedAgain = await reconcileProvisionalSent(executor, accountId, {
      messageIdHeader: second.messageId,
    })
    expect(deletedAgain).toBe(0)
    expect(
      await executor.select("SELECT * FROM messages WHERE account_id = $1", [
        accountId,
      ])
    ).toHaveLength(1)
  })
})

// ---- Sync-side wiring (imap + gmail) -----------------------------------------

describe("sent reconciliation wiring", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("imap sync replaces the provisional row with the server copy in the Sent folder", async () => {
    const accountId = await createAccount(executor, "imap")
    await seedSentLabel(executor, accountId, "imap")
    const outcome = await sendThroughService(executor, accountId)

    // The server's Sent folder now holds the filed copy (same Message-ID).
    const provider = fakeImapProvider(accountId, [
      fakeMessage({
        uid: 1,
        messageId: outcome.messageId,
        subject: "Quarterly report",
        from: [{ email: `${accountId}@example.com` }],
        folder: "Sent",
        textBody: "Hi there",
      }),
    ])
    const summary = await syncImapAccount({
      executor,
      provider,
      accountId,
      reconcileFlags: false,
    })

    expect(summary.errors).toEqual([])
    const messages = await executor.select<{
      imap_uid: number | null
      imap_folder: string | null
      subject: string | null
    }>(
      "SELECT imap_uid, imap_folder, subject FROM messages WHERE account_id = $1",
      [accountId]
    )
    // Exactly one row: the provisional twin was replaced by the server copy.
    expect(messages).toEqual([
      { imap_uid: 1, imap_folder: "Sent", subject: "Quarterly report" },
    ])
    // The surviving thread is still visible in the Sent view.
    expect(await sentThreadIds(executor, accountId)).toHaveLength(1)
  })

  it("gmail sync replaces the provisional row with the server message under its server thread", async () => {
    const accountId = await createAccount(executor, "gmail")
    await seedSentLabel(executor, accountId, "gmail")
    const outcome = await sendThroughService(executor, accountId)

    const provider = fakeGmailProvider(accountId, [
      fakeMessage({
        uid: 18,
        gmailId: "18",
        gmailThreadId: "t1",
        messageId: outcome.messageId,
        subject: "Quarterly report",
        from: [{ email: `${accountId}@example.com` }],
        labelIds: ["SENT"],
        textBody: "Hi there",
      }),
    ])
    const summary = await syncGmailAccount({ executor, provider, accountId })

    expect(summary.newMessages).toBe(1)
    const messages = await executor.select<{
      gmail_message_id: string | null
      subject: string | null
    }>("SELECT gmail_message_id, subject FROM messages WHERE account_id = $1", [
      accountId,
    ])
    expect(messages).toEqual([
      { gmail_message_id: "18", subject: "Quarterly report" },
    ])
    // The emptied provisional thread is gone; the server thread remains.
    expect(await getThread(executor, outcome.threadId)).toBeNull()
    const threads = await executor.select<{ gmail_thread_id: string | null }>(
      "SELECT gmail_thread_id FROM threads WHERE account_id = $1",
      [accountId]
    )
    expect(threads).toEqual([{ gmail_thread_id: "t1" }])
  })
})
