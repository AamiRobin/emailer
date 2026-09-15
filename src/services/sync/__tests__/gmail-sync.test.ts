import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import type { LabelRow } from "../../db/labels"
import type {
  ConnectionTestResult,
  DeltaSyncResult,
  EmailFolder,
  EmailProvider,
  FetchMessagesResult,
  FetchQuery,
  MessageFlags,
  NormalizedAttachment,
  NormalizedMessage,
  SendEmailResult,
} from "../../email/types"
import type { GmailSyncSummary } from "../gmail-sync"
import { syncGmailAccount } from "../gmail-sync"

// ---------------------------------------------------------------------------
// In-memory Gmail provider standing in for the REST layer
// ---------------------------------------------------------------------------

interface FakeGmailMessage {
  id: string
  threadId: string
  /** Gmail label ids exactly as the API reports them. */
  labelIds: string[]
  subject?: string
  fromEmail: string
  date: number
  textBody?: string
}

/** flagsForLabelIds: read is the ABSENCE of UNREAD, star is STARRED. */
function flagsForLabelIds(labelIds: string[]): string[] {
  const flags: string[] = []
  if (!labelIds.includes("UNREAD")) flags.push("\\Seen")
  if (labelIds.includes("STARRED")) flags.push("\\Flagged")
  return flags
}

function toNormalizedMessage(message: FakeGmailMessage): NormalizedMessage {
  const attachments: NormalizedAttachment[] = []
  return {
    uid: Number(message.id),
    flags: flagsForLabelIds(message.labelIds),
    subject: message.subject,
    from: [{ email: message.fromEmail }],
    to: [],
    cc: [],
    bcc: [],
    date: message.date,
    textBody: message.textBody,
    size: 100,
    attachments,
    folder: undefined,
    gmailId: message.id,
    gmailThreadId: message.threadId,
    labelIds: message.labelIds,
    historyId: "0",
  }
}

class FakeGmailProvider implements EmailProvider {
  readonly accountId: string
  readonly type = "gmail" as const

  /** The profile history id — the delta cursor the engine must persist. */
  historyId: string
  /** Cursors the API treats as expired (needsFullSync fallback). */
  expiredCursors = new Set<string>()
  /** Messages queued into the next deltaSync response, then drained. */
  deltaAdds: NormalizedMessage[] = []

  readonly folders: EmailFolder[]
  private readonly messages = new Map<string, FakeGmailMessage>()

  deltaCalls: (string | null)[] = []
  fetchCalls: FetchQuery[] = []

  constructor(accountId: string, folders: EmailFolder[], historyId: string) {
    this.accountId = accountId
    this.folders = folders
    this.historyId = historyId
  }

  addMessage(message: FakeGmailMessage): void {
    this.messages.set(message.id, message)
  }

  removeMessage(id: string): void {
    this.messages.delete(id)
  }

  /** Queue a (possibly already stored) message into the next delta. */
  queueDeltaAdd(message: FakeGmailMessage): void {
    this.addMessage(message)
    this.deltaAdds.push(toNormalizedMessage(message))
  }

  async listFolders(): Promise<EmailFolder[]> {
    return this.folders
  }

  async deltaSync(cursor: string | null): Promise<DeltaSyncResult> {
    this.deltaCalls.push(cursor)
    if (cursor === null || this.expiredCursors.has(cursor)) {
      return {
        messages: [],
        nextCursor: this.historyId,
        needsFullSync: true,
      }
    }
    const messages = this.deltaAdds
    this.deltaAdds = []
    return { messages, nextCursor: this.historyId, needsFullSync: false }
  }

  async fetchMessages(
    _folder: string,
    query: FetchQuery
  ): Promise<FetchMessagesResult> {
    this.fetchCalls.push(query)
    if (query.last === undefined) {
      throw new Error("fake gmail provider only enumerates via {last}")
    }
    const all = [...this.messages.values()].sort((a, b) => a.date - b.date)
    return {
      messages: all.slice(-query.last).map(toNormalizedMessage),
      folderStatus: {
        uidValidity: 1,
        uidNext: 0,
        exists: all.length,
        unseen: 0,
      },
    }
  }

  async fetchFlags(): Promise<MessageFlags[]> {
    throw new Error("not implemented in fake")
  }
  async storeFlags(): Promise<void> {
    throw new Error("not implemented in fake")
  }
  async markRead(): Promise<void> {
    throw new Error("not implemented in fake")
  }
  async markStarred(): Promise<void> {
    throw new Error("not implemented in fake")
  }
  async addLabels(): Promise<void> {
    throw new Error("not implemented in fake")
  }
  async removeLabels(): Promise<void> {
    throw new Error("not implemented in fake")
  }
  async archive(): Promise<void> {
    throw new Error("not implemented in fake")
  }
  async trash(): Promise<void> {
    throw new Error("not implemented in fake")
  }
  async moveToFolder(): Promise<void> {
    throw new Error("not implemented in fake")
  }
  async deleteForever(): Promise<void> {
    throw new Error("not implemented in fake")
  }
  async sendMessage(): Promise<SendEmailResult> {
    throw new Error("not implemented in fake")
  }
  async appendMessage(): Promise<void> {
    throw new Error("not implemented in fake")
  }
  async testConnection(): Promise<ConnectionTestResult> {
    return { success: true, message: "fake" }
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface TestHarness {
  executor: TestExecutor
  accountId: string
  provider: FakeGmailProvider
  sync(options?: { batchSize?: number }): Promise<GmailSyncSummary>
}

function defaultFolders(): EmailFolder[] {
  return [
    {
      id: "INBOX",
      name: "Inbox",
      path: "INBOX",
      type: "system",
      specialUse: "inbox",
      delimiter: "/",
    },
    {
      id: "folder-Receipts",
      name: "Receipts",
      path: "Receipts",
      type: "user",
      specialUse: null,
      delimiter: "/",
    },
  ]
}

async function createHarness(): Promise<TestHarness> {
  const executor = createTestExecutor()
  const accountId = await createAccount(executor, "gmail")
  const provider = new FakeGmailProvider(accountId, defaultFolders(), "500")

  function sync(options?: { batchSize?: number }): Promise<GmailSyncSummary> {
    return syncGmailAccount({
      executor,
      provider,
      accountId,
      ...(options?.batchSize === undefined
        ? {}
        : { batchSize: options.batchSize }),
    })
  }

  return { executor, accountId, provider, sync }
}

function message(
  overrides: Partial<FakeGmailMessage> & { id: string; threadId: string }
): FakeGmailMessage {
  return {
    labelIds: ["INBOX"],
    subject: `Subject ${overrides.id}`,
    fromEmail: "sender@example.com",
    date: Number(overrides.id),
    textBody: `body ${overrides.id}`,
    ...overrides,
  }
}

async function accountRow(harness: TestHarness) {
  const rows = await harness.executor.select<{
    gmail_history_id: string | null
    labels_synced_at: number | null
    last_sync_at: number | null
    last_full_sync_at: number | null
  }>(
    `SELECT gmail_history_id, labels_synced_at, last_sync_at, last_full_sync_at
     FROM accounts WHERE id = $1`,
    [harness.accountId]
  )
  return rows[0]
}

async function labelRow(
  harness: TestHarness,
  rowId: string
): Promise<LabelRow | null> {
  const rows = await harness.executor.select<LabelRow>(
    "SELECT * FROM labels WHERE id = $1",
    [rowId]
  )
  return rows[0] ?? null
}

interface StoredMessageRow {
  id: string
  gmail_message_id: string | null
  thread_id: string
  is_read: number
  is_flagged: number
  subject: string | null
}

async function storedMessages(
  harness: TestHarness
): Promise<StoredMessageRow[]> {
  return harness.executor.select<StoredMessageRow>(
    `SELECT id, gmail_message_id, thread_id, is_read, is_flagged, subject
     FROM messages WHERE account_id = $1 ORDER BY gmail_message_id ASC`,
    [harness.accountId]
  )
}

interface StoredThreadRow {
  id: string
  gmail_thread_id: string | null
  subject: string | null
  message_count: number
  unread_count: number
  is_archived: number
}

async function storedThreads(harness: TestHarness): Promise<StoredThreadRow[]> {
  return harness.executor.select<StoredThreadRow>(
    `SELECT id, gmail_thread_id, subject, message_count, unread_count, is_archived
     FROM threads WHERE account_id = $1 ORDER BY gmail_thread_id ASC`,
    [harness.accountId]
  )
}

async function threadLabelIds(
  harness: TestHarness,
  threadRowId: string
): Promise<string[]> {
  const rows = await harness.executor.select<{ label_id: string }>(
    "SELECT label_id FROM thread_labels WHERE thread_id = $1 ORDER BY label_id ASC",
    [threadRowId]
  )
  return rows.map((row) => row.label_id)
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("gmail sync engine", () => {
  let harness: TestHarness

  beforeEach(async () => {
    harness = await createHarness()
  })

  afterEach(() => {
    harness.executor.close()
  })

  it("first sync runs the full path: labels, threads, messages, caches and cursor", async () => {
    harness.provider.addMessage(
      message({
        id: "101",
        threadId: "t1",
        date: 100,
        labelIds: ["INBOX", "UNREAD"],
        subject: "Hello",
      })
    )
    harness.provider.addMessage(
      message({
        id: "102",
        threadId: "t1",
        date: 200,
        labelIds: ["INBOX", "Receipts"],
        subject: "Re: Hello",
      })
    )
    harness.provider.addMessage(
      message({
        id: "103",
        threadId: "t2",
        date: 300,
        labelIds: ["Receipts", "UNREAD", "STARRED"],
        subject: "Invoice",
      })
    )

    const summary = await harness.sync()

    expect(summary).toEqual({
      mode: "full",
      labelsSynced: 2,
      newMessages: 3,
      threadsCreatedOrUpdated: 2,
    })

    // labels: system by special use + user label, gmail id = label name
    expect(await labelRow(harness, `${harness.accountId}:INBOX`)).toMatchObject(
      {
        name: "INBOX",
        gmail_label_id: "INBOX",
        special_use: "inbox",
        type: "system",
      }
    )
    expect(
      await labelRow(harness, `${harness.accountId}:folder-Receipts`)
    ).toMatchObject({
      name: "Receipts",
      gmail_label_id: "Receipts",
      special_use: null,
      type: "user",
    })

    // cursor capture happens through deltaSync(null) before enumeration
    expect(harness.provider.deltaCalls).toEqual([null])
    expect(harness.provider.fetchCalls).toEqual([{ last: 500 }])

    // messages: keyed by gmail id, flags mapped from labels
    const messages = await storedMessages(harness)
    expect(messages).toHaveLength(3)
    const byGmailId = new Map(messages.map((m) => [m.gmail_message_id, m]))
    expect(byGmailId.get("101")?.is_read).toBe(0)
    expect(byGmailId.get("102")?.is_read).toBe(1)
    expect(byGmailId.get("103")?.is_flagged).toBe(1)

    // threads grouped by the server thread id with recomputed caches
    const threads = await storedThreads(harness)
    expect(threads).toHaveLength(2)
    const inboxThread = threads.find((t) => t.gmail_thread_id === "t1")
    const receiptsThread = threads.find((t) => t.gmail_thread_id === "t2")
    expect(inboxThread).toMatchObject({
      subject: "Hello",
      message_count: 2,
      unread_count: 1,
      is_archived: 0,
    })
    expect(receiptsThread).toMatchObject({
      message_count: 1,
      unread_count: 1,
      is_archived: 1, // no INBOX label → archived in the gmail model
    })

    // thread_labels membership from message labelIds
    expect(await threadLabelIds(harness, inboxThread?.id as string)).toEqual([
      `${harness.accountId}:INBOX`,
      `${harness.accountId}:folder-Receipts`,
    ])
    expect(await threadLabelIds(harness, receiptsThread?.id as string)).toEqual(
      [`${harness.accountId}:folder-Receipts`]
    )

    // messages joined to their server threads
    expect(byGmailId.get("101")?.thread_id).toBe(
      byGmailId.get("102")?.thread_id
    )
    expect(byGmailId.get("103")?.thread_id).not.toBe(inboxThread?.id)

    // accounts row: history cursor + sync timestamps persisted
    expect(await accountRow(harness)).toMatchObject({
      gmail_history_id: "500",
      labels_synced_at: expect.any(Number),
      last_sync_at: expect.any(Number),
      last_full_sync_at: expect.any(Number),
    })
  })

  it("delta sync persists added messages, recompute caches and advances the cursor", async () => {
    harness.provider.addMessage(
      message({
        id: "101",
        threadId: "t1",
        date: 100,
        labelIds: ["INBOX", "Receipts", "UNREAD"],
        subject: "Hello",
      })
    )
    await harness.sync()

    harness.provider.historyId = "600"
    harness.provider.queueDeltaAdd(
      message({
        id: "102",
        threadId: "t1",
        date: 200,
        // the delta sees only the new member — INBOX, no Receipts
        labelIds: ["INBOX", "UNREAD"],
        subject: "Re: Hello",
      })
    )

    const summary = await harness.sync()

    expect(summary).toEqual({
      mode: "delta",
      labelsSynced: 2,
      newMessages: 1,
      threadsCreatedOrUpdated: 1,
    })
    // the stored cursor was passed to the provider and then advanced
    expect(harness.provider.deltaCalls).toEqual([null, "500"])
    expect(harness.provider.fetchCalls).toEqual([{ last: 500 }]) // no re-enumeration

    const messages = await storedMessages(harness)
    expect(messages).toHaveLength(2)
    const threads = await storedThreads(harness)
    expect(threads).toHaveLength(1)
    expect(threads[0]).toMatchObject({ message_count: 2, unread_count: 2 })
    // membership is additive: the delta-added member does not wipe
    // Receipts learned during the full sync
    expect(await threadLabelIds(harness, threads[0]?.id as string)).toEqual([
      `${harness.accountId}:INBOX`,
      `${harness.accountId}:folder-Receipts`,
    ])
    expect(await accountRow(harness)).toMatchObject({ gmail_history_id: "600" })
  })

  it("needsFullSync fallback re-enumerates and stores the fresh cursor", async () => {
    harness.provider.addMessage(
      message({ id: "101", threadId: "t1", date: 100 })
    )
    await harness.sync()

    harness.provider.expiredCursors.add("500")
    harness.provider.historyId = "700"
    harness.provider.addMessage(
      message({ id: "102", threadId: "t3", date: 200, labelIds: ["UNREAD"] })
    )

    const summary = await harness.sync()

    expect(summary.mode).toBe("full")
    expect(summary.newMessages).toBe(1)
    // deltaSync(cursor) hit the expired branch; the fresh cursor came from
    // its needsFullSync response — no extra deltaSync(null) call
    expect(harness.provider.deltaCalls).toEqual([null, "500"])
    expect(harness.provider.fetchCalls).toEqual([{ last: 500 }, { last: 500 }])
    expect(await storedMessages(harness)).toHaveLength(2)
    expect(await accountRow(harness)).toMatchObject({ gmail_history_id: "700" })
  })

  it("full sync covers only the {last} window (documented enumeration limit)", async () => {
    for (const id of ["101", "102", "103"]) {
      harness.provider.addMessage(
        message({ id, threadId: `t-${id}`, date: Number(id), labelIds: [] })
      )
    }

    const summary = await harness.sync({ batchSize: 2 })

    expect(summary.newMessages).toBe(2)
    expect(harness.provider.fetchCalls).toEqual([{ last: 2 }])
    const messages = await storedMessages(harness)
    expect(messages.map((m) => m.gmail_message_id)).toEqual(["102", "103"])
  })

  it("delta re-fetch of a known message refreshes flags without counting it as new", async () => {
    harness.provider.addMessage(
      message({
        id: "101",
        threadId: "t1",
        date: 100,
        labelIds: ["INBOX", "UNREAD"],
      })
    )
    await harness.sync()
    expect((await storedMessages(harness))[0]?.is_read).toBe(0)

    harness.provider.historyId = "600"
    harness.provider.queueDeltaAdd(
      message({ id: "101", threadId: "t1", date: 100, labelIds: ["INBOX"] })
    )

    const summary = await harness.sync()

    expect(summary.newMessages).toBe(0)
    const messages = await storedMessages(harness)
    expect(messages).toHaveLength(1) // upsert, not duplicate
    expect(messages[0]?.is_read).toBe(1)
  })

  it("empty mailbox full sync still stores the cursor and timestamps", async () => {
    const summary = await harness.sync()

    expect(summary).toEqual({
      mode: "full",
      labelsSynced: 2,
      newMessages: 0,
      threadsCreatedOrUpdated: 0,
    })
    expect(await storedMessages(harness)).toHaveLength(0)
    expect(await storedThreads(harness)).toHaveLength(0)
    expect(await accountRow(harness)).toMatchObject({
      gmail_history_id: "500",
      last_sync_at: expect.any(Number),
    })
  })

  it("skips state labels without a labels row from membership", async () => {
    harness.provider.addMessage(
      message({
        id: "101",
        threadId: "t1",
        date: 100,
        labelIds: ["INBOX", "UNREAD", "STARRED", "CATEGORY_PROMOTIONS"],
      })
    )

    await harness.sync()

    const threads = await storedThreads(harness)
    expect(await threadLabelIds(harness, threads[0]?.id as string)).toEqual([
      `${harness.accountId}:INBOX`,
    ])
  })
})
