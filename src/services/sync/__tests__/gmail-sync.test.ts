import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createAccount, createGmailLabel } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { listAliases } from "../../db/aliases"
import {
  blockSender,
  listBlockedSenders,
  unblockSender,
} from "../../db/blocked-senders"
import { getThread } from "../../db/threads"
import { muteThread } from "../../email-actions/thread-states"
import { addNotificationRule } from "../../db/notification-rules"
import type { LabelRow } from "../../db/labels"
import { createRule, updateRule, type RuleAction } from "../../rules"
import type { GmailSendAs } from "../../email/gmail-api"
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
import { setJunkFilterEnabledPreference } from "../../settings/preferences"
import {
  getSubscription,
  listSubscriptions,
  markUnsubscribed,
  recordSenderSeen,
} from "../../settings/subscriptions"
import { trainJunkDocument } from "../../security/junk-filter"

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
  /** To-header addresses (sender-stats direct-to-me tests). */
  toEmails?: string[]
  /** List-unsubscribe capture (task 18.3, D13). */
  listUnsubscribe?: string
  listUnsubscribePost?: string
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
    listUnsubscribe: message.listUnsubscribe,
    listUnsubscribePost: message.listUnsubscribePost,
    from: [{ email: message.fromEmail }],
    to: (message.toEmails ?? []).map((email) => ({ email })),
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
  async getMessageSource(): Promise<string> {
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
  sync(options?: {
    batchSize?: number
    /** SendAs source for the alias reconcile tail (task 16.2). */
    listSendAs?: () => Promise<GmailSendAs[]>
  }): Promise<GmailSyncSummary>
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

  function sync(options?: {
    batchSize?: number
    listSendAs?: () => Promise<GmailSendAs[]>
  }): Promise<GmailSyncSummary> {
    return syncGmailAccount({
      executor,
      provider,
      accountId,
      ...(options?.batchSize === undefined
        ? {}
        : { batchSize: options.batchSize }),
      ...(options?.listSendAs === undefined
        ? {}
        : { listSendAs: options.listSendAs }),
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
  is_spam: number
}

async function storedThreads(harness: TestHarness): Promise<StoredThreadRow[]> {
  return harness.executor.select<StoredThreadRow>(
    `SELECT id, gmail_thread_id, subject, message_count, unread_count,
            is_archived, is_spam
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

async function pendingOps(
  harness: TestHarness
): Promise<{ op_type: string; payload_json: string }[]> {
  return harness.executor.select(
    `SELECT op_type, payload_json FROM pending_operations
     WHERE account_id = $1 ORDER BY seq ASC`,
    [harness.accountId]
  )
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

  it("captures list-unsubscribe headers into the stored headers JSON (task 18.3)", async () => {
    harness.provider.addMessage(
      message({
        id: "201",
        threadId: "t1",
        fromEmail: "news@lists.example.com",
        listUnsubscribe:
          "<https://lists.example.com/u/1>, <mailto:leave@lists.example.com>",
        listUnsubscribePost: "List-Unsubscribe=One-Click",
      })
    )
    harness.provider.addMessage(
      message({
        id: "202",
        threadId: "t2",
        fromEmail: "friend@example.com",
      })
    )

    await harness.sync()

    const rows = await harness.executor.select<{
      gmail_message_id: string | null
      headers: string | null
    }>(
      `SELECT gmail_message_id, headers FROM messages
       WHERE account_id = $1 ORDER BY gmail_message_id ASC`,
      [harness.accountId]
    )
    const byGmailId = new Map(rows.map((row) => [row.gmail_message_id, row]))
    // The one-click pair is stored verbatim, lowercase-keyed — exactly the
    // shape unsubscribeTargetsFromHeaders reads on the mail view.
    expect(JSON.parse(byGmailId.get("201")?.headers ?? "null")).toEqual({
      "list-unsubscribe":
        "<https://lists.example.com/u/1>, <mailto:leave@lists.example.com>",
      "list-unsubscribe-post": "List-Unsubscribe=One-Click",
    })
    // A message without the headers keeps the column NULL.
    expect(byGmailId.get("202")?.headers).toBeNull()
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
    // The history-expiry re-enumeration is a backfill pass (countNew:
    // false) — it stores the fresh window but announces nothing.
    expect(summary.newMessages).toBe(0)
    // deltaSync(cursor) hit the expired branch; the fresh cursor came from
    // its needsFullSync response — no extra deltaSync(null) call
    expect(harness.provider.deltaCalls).toEqual([null, "500"])
    expect(harness.provider.fetchCalls).toEqual([{ last: 500 }, { last: 500 }])
    expect(await storedMessages(harness)).toHaveLength(2)
    expect(await accountRow(harness)).toMatchObject({ gmail_history_id: "700" })
  })

  it("a message whose thread is trashed never counts as new (placement gate)", async () => {
    // A provider whose label list includes TRASH so thread membership can
    // carry the trash special-use the placement gate reads.
    const provider = new FakeGmailProvider(
      harness.accountId,
      [
        ...defaultFolders(),
        {
          id: "TRASH",
          name: "Trash",
          path: "TRASH",
          type: "system",
          specialUse: "trash",
          delimiter: "/",
        },
      ],
      "500"
    )
    provider.addMessage(
      message({
        id: "301",
        threadId: "t-junked",
        labelIds: ["TRASH", "UNREAD"],
        subject: "Junked root",
      })
    )
    provider.addMessage(
      message({ id: "302", threadId: "t-live", subject: "Live mail" })
    )
    // First sync counts the live thread only — the trashed thread's
    // member never announces (countNew holds for a plain first sync).
    const first = await syncGmailAccount({
      executor: harness.executor,
      provider,
      accountId: harness.accountId,
    })
    expect(first.newMessages).toBe(1)

    // A later delta delivering another message into the trashed thread
    // also never announces.
    provider.historyId = "600"
    provider.queueDeltaAdd(
      message({
        id: "303",
        threadId: "t-junked",
        labelIds: ["TRASH", "UNREAD"],
        subject: "Junked reply",
      })
    )
    const second = await syncGmailAccount({
      executor: harness.executor,
      provider,
      accountId: harness.accountId,
    })
    expect(second.mode).toBe("delta")
    expect(second.newMessages).toBe(0)
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

  it("mute gating: new mail landing in a muted thread is stored but not counted as new", async () => {
    harness.provider.addMessage(
      message({ id: "101", threadId: "t1", date: 100 })
    )
    await harness.sync()

    // Mute t1 locally through the thread-states service (what the UI's
    // context menu will call).
    const stored = await storedThreads(harness)
    const t1 = stored.find((t) => t.gmail_thread_id === "t1")
    await muteThread(harness.executor, t1?.id as string)

    // A new reply joins the muted thread; a fresh message lands in an
    // unmuted one. Only the latter may reach the count the scheduler
    // forwards to notifyNewMail.
    harness.provider.historyId = "600"
    harness.provider.queueDeltaAdd(
      message({
        id: "102",
        threadId: "t1",
        date: 200,
        labelIds: ["INBOX", "UNREAD"],
        subject: "Re: noisy",
      })
    )
    harness.provider.queueDeltaAdd(
      message({ id: "103", threadId: "t2", date: 300 })
    )

    const summary = await harness.sync()

    expect(summary.newMessages).toBe(1)
    // The muted thread's message is still fully stored…
    expect(await storedMessages(harness)).toHaveLength(3)
    // …and the new incoming message did NOT unmute the thread (spec).
    const t1Row = await getThread(harness.executor, t1?.id as string)
    expect(t1Row?.muted_at).toBeGreaterThan(0)
  })

  // ----- Notification rules (task 8.1, design D16) -----

  it("never-sender rule: the message is stored but not counted as new", async () => {
    harness.provider.addMessage(
      message({ id: "101", threadId: "t1", date: 100 })
    )
    await harness.sync()

    await addNotificationRule(harness.executor, {
      accountId: harness.accountId,
      matchType: "sender",
      matchValue: "newsletter@x.com",
      action: "never",
    })

    // A suppressed sender's mail lands beside a normal one. Only the
    // normal one may reach the count the scheduler forwards to
    // notifyNewMail.
    harness.provider.historyId = "600"
    harness.provider.queueDeltaAdd(
      message({
        id: "102",
        threadId: "t2",
        date: 200,
        fromEmail: "newsletter@x.com",
        labelIds: ["INBOX", "UNREAD"],
      })
    )
    harness.provider.queueDeltaAdd(
      message({ id: "103", threadId: "t3", date: 300 })
    )

    const summary = await harness.sync()

    expect(summary.newMessages).toBe(1)
    // The suppressed message is fully stored and unread — only the
    // announcement count excludes it.
    const messages = await storedMessages(harness)
    expect(messages).toHaveLength(3)
    const threads = await storedThreads(harness)
    const t2 = threads.find((thread) => thread.gmail_thread_id === "t2")
    expect(t2).toMatchObject({ message_count: 1, unread_count: 1 })
  })

  it("never-label rule matches the resolved label name of the message", async () => {
    await addNotificationRule(harness.executor, {
      accountId: harness.accountId,
      matchType: "label",
      matchValue: "receipts",
      action: "never",
    })

    // Message 101 carries the Receipts label → suppressed; 102 does not.
    harness.provider.addMessage(
      message({
        id: "101",
        threadId: "t1",
        date: 100,
        labelIds: ["Receipts", "UNREAD"],
      })
    )
    harness.provider.addMessage(
      message({ id: "102", threadId: "t2", date: 200 })
    )

    const summary = await harness.sync()

    expect(summary.newMessages).toBe(1)
    expect(await storedMessages(harness)).toHaveLength(2)
  })

  it("an always rule keeps its sender counted (VIP case)", async () => {
    harness.provider.addMessage(
      message({ id: "101", threadId: "t1", date: 100 })
    )
    await harness.sync()

    // The account's only rule is an always-notify for the account's
    // regular sender: nothing is suppressed, and a never rule for a
    // different sender would not affect it either.
    await addNotificationRule(harness.executor, {
      accountId: harness.accountId,
      matchType: "sender",
      matchValue: "sender@example.com",
      action: "always",
    })
    await addNotificationRule(harness.executor, {
      accountId: harness.accountId,
      matchType: "sender",
      matchValue: "other@x.com",
      action: "never",
    })

    harness.provider.historyId = "600"
    harness.provider.queueDeltaAdd(
      message({
        id: "102",
        threadId: "t1",
        date: 200,
        labelIds: ["INBOX", "UNREAD"],
      })
    )

    const summary = await harness.sync()

    expect(summary.newMessages).toBe(1)
  })

  // ----- Ingestion rules (task 11.1/11.2, design D5) -----
  //
  // The engine hands every newly inserted message to the rules hook after
  // its thread group is stored; these scenarios verify the end-to-end
  // contract: the rule's actions apply through the thread-actions service
  // (local effect + pending op) and ruled-away mail never reaches the
  // newMessages count the scheduler forwards to notifyNewMail.

  async function seedRule(
    harness: TestHarness,
    criteriaQuery: string,
    actions: RuleAction[]
  ): Promise<string> {
    return createRule(harness.executor, {
      accountId: harness.accountId,
      name: `rule: ${criteriaQuery}`,
      criteriaQuery,
      actions,
    })
  }

  it("an archive rule files the thread, queues the op and never notifies", async () => {
    await seedRule(harness, "from:newsletter@x.com", [{ type: "archive" }])

    // The ruled sender's mail lands beside a normal one: only the normal
    // one may reach the notification count.
    harness.provider.addMessage(
      message({
        id: "101",
        threadId: "t1",
        date: 100,
        fromEmail: "newsletter@x.com",
        labelIds: ["INBOX", "UNREAD"],
        subject: "Digest",
      })
    )
    harness.provider.addMessage(
      message({ id: "102", threadId: "t2", date: 200 })
    )

    const summary = await harness.sync()

    expect(summary.newMessages).toBe(1)
    const threads = await storedThreads(harness)
    const t1 = threads.find((thread) => thread.gmail_thread_id === "t1")
    // Ruled away: fully stored, still unread — but out of the inbox.
    expect(t1).toMatchObject({
      message_count: 1,
      unread_count: 1,
      is_archived: 1,
    })

    const ops = await pendingOps(harness)
    expect(ops.map((op) => op.op_type)).toEqual(["archive"])
    const payload = JSON.parse(ops[0]?.payload_json ?? "{}") as {
      refs?: { providerMessageId?: string }[]
    }
    expect(payload.refs?.[0]?.providerMessageId).toBe("101")
  })

  it("a mark-as-spam rule files the thread into spam and never notifies", async () => {
    // The real provider lists SPAM among its system labels, so the local
    // spam-role label row (the placement the rule's effect rebuilds the
    // caches from) exists.
    harness.provider.folders.push({
      id: "SPAM",
      name: "Spam",
      path: "SPAM",
      type: "system",
      specialUse: "spam",
      delimiter: "/",
    })
    await seedRule(harness, "from:winner@lottery.example", [
      { type: "mark_as_spam" },
    ])

    // The ruled sender's mail lands beside a normal one: only the normal
    // one may reach the notification count.
    harness.provider.addMessage(
      message({
        id: "101",
        threadId: "t1",
        date: 100,
        fromEmail: "winner@lottery.example",
        labelIds: ["INBOX", "UNREAD"],
        subject: "Claim your prize",
      })
    )
    harness.provider.addMessage(
      message({ id: "102", threadId: "t2", date: 200 })
    )

    const summary = await harness.sync()

    expect(summary.newMessages).toBe(1)
    const threads = await storedThreads(harness)
    const t1 = threads.find((thread) => thread.gmail_thread_id === "t1")
    // Ruled away: fully stored, still unread — but in spam.
    expect(t1).toMatchObject({
      message_count: 1,
      unread_count: 1,
      is_spam: 1,
    })

    const ops = await pendingOps(harness)
    expect(ops.map((op) => op.op_type)).toEqual(["add_labels"])
    const payload = JSON.parse(ops[0]?.payload_json ?? "{}") as {
      labelIds?: string[]
    }
    expect(payload.labelIds).toEqual(["SPAM"])
  })

  it("a labeling + mark-read rule applies both actions in order and counts nothing", async () => {
    await seedRule(harness, "subject:invoice", [
      { type: "add_labels", labels: ["Receipts"] },
      { type: "mark_read" },
    ])

    harness.provider.addMessage(
      message({
        id: "101",
        threadId: "t1",
        date: 100,
        fromEmail: "billing@vendor.com",
        labelIds: ["INBOX", "UNREAD"],
        subject: "Invoice 42",
      })
    )

    const summary = await harness.sync()

    // mark_read ruled the message away from the announcement…
    expect(summary.newMessages).toBe(0)
    const messages = await storedMessages(harness)
    expect(messages[0]).toMatchObject({ is_read: 1 })
    const threads = await storedThreads(harness)
    expect(threads[0]).toMatchObject({ unread_count: 0, is_archived: 0 })
    // …while the label still applied and both ops queued, in rule order.
    const receiptsId = `${harness.accountId}:folder-Receipts`
    expect(await threadLabelIds(harness, threads[0]?.id as string)).toEqual([
      `${harness.accountId}:INBOX`,
      receiptsId,
    ])
    expect((await pendingOps(harness)).map((op) => op.op_type)).toEqual([
      "add_labels",
      "mark_read",
    ])
    const addLabels = JSON.parse(
      (await pendingOps(harness))[0]?.payload_json ?? "{}"
    ) as { labelIds?: string[] }
    // Provider-facing ids: the Receipts label row's gmail id is its name.
    expect(addLabels.labelIds).toEqual(["Receipts"])
  })

  it("a star rule acts on the thread and the mail still counts as new", async () => {
    await seedRule(harness, "subject:invoice", [{ type: "star" }])

    harness.provider.addMessage(
      message({
        id: "101",
        threadId: "t1",
        date: 100,
        labelIds: ["INBOX", "UNREAD"],
        subject: "Invoice 42",
      })
    )

    const summary = await harness.sync()

    // Additive actions keep the message notifying…
    expect(summary.newMessages).toBe(1)
    const messages = await storedMessages(harness)
    expect(messages[0]).toMatchObject({ is_flagged: 1 })
    const threads = await storedThreads(harness)
    expect(threads[0]).toMatchObject({ unread_count: 1 })
    expect((await pendingOps(harness)).map((op) => op.op_type)).toEqual([
      "star",
    ])
  })

  it("disabled rules leave the sync pass untouched", async () => {
    const ruleId = await seedRule(harness, "from:newsletter@x.com", [
      { type: "archive" },
    ])
    await updateRule(harness.executor, ruleId, { enabled: false })

    harness.provider.addMessage(
      message({
        id: "101",
        threadId: "t1",
        date: 100,
        fromEmail: "newsletter@x.com",
        labelIds: ["INBOX", "UNREAD"],
        subject: "Digest",
      })
    )

    const summary = await harness.sync()

    // Processed exactly as if the rule did not exist (spec).
    expect(summary.newMessages).toBe(1)
    const threads = await storedThreads(harness)
    expect(threads[0]).toMatchObject({ is_archived: 0, unread_count: 1 })
    expect(await pendingOps(harness)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Sender stats (task 13.1, design D7): the ingestion hook flow's stats
// consumer must accumulate per-sender rows from what the engine stored.
// ---------------------------------------------------------------------------

describe("gmail sync sender stats", () => {
  let harness: TestHarness

  beforeEach(async () => {
    harness = await createHarness()
  })

  afterEach(() => {
    harness.executor.close()
  })

  async function statRows(): Promise<
    {
      sender: string
      reply_count: number
      direct_to_me_count: number
      is_mailing_list: number
      last_message_at: number | null
    }[]
  > {
    return harness.executor.select(
      `SELECT sender, reply_count, direct_to_me_count, is_mailing_list,
              last_message_at
       FROM sender_stats WHERE account_id = $1 ORDER BY sender`,
      [harness.accountId]
    )
  }

  it("accumulates reply/direct/list signals per sender for new messages", async () => {
    const me = (
      await harness.executor.select<{ email: string }>(
        "SELECT email FROM accounts WHERE id = $1",
        [harness.accountId]
      )
    )[0]?.email as string

    harness.provider.addMessage(
      message({
        id: "101",
        threadId: "t1",
        date: 100,
        fromEmail: "Alice@X.com",
        toEmails: [me],
        labelIds: ["INBOX", "UNREAD"],
        subject: "Hello",
      })
    )
    // The thread's own member from the account's address: participation
    // flips on for the whole thread group.
    harness.provider.addMessage(
      message({
        id: "102",
        threadId: "t1",
        date: 150,
        fromEmail: me,
        labelIds: [],
        subject: "Re: Hello",
      })
    )
    harness.provider.addMessage(
      message({
        id: "103",
        threadId: "t2",
        date: 200,
        fromEmail: "news@lists.dev",
        labelIds: ["INBOX", "CATEGORY_PROMOTIONS"],
        subject: "Weekly digest",
      })
    )

    await harness.sync()

    expect(await statRows()).toEqual([
      {
        sender: "alice@x.com", // lowercased key
        // t1 carries a message from the account's own address — the
        // participation signal — though the subject has no Re:.
        reply_count: 1,
        direct_to_me_count: 1, // to: me
        is_mailing_list: 0,
        last_message_at: 100,
      },
      {
        sender: "news@lists.dev",
        reply_count: 0,
        direct_to_me_count: 0,
        is_mailing_list: 1, // the raw CATEGORY_* tab label
        last_message_at: 200,
      },
      // The account's own message (102) records NO row: own sent copies
      // are not inbound-sender signals.
    ])
  })

  it("accumulates across passes instead of overwriting", async () => {
    harness.provider.addMessage(
      message({
        id: "101",
        threadId: "t1",
        date: 100,
        fromEmail: "news@lists.dev",
        labelIds: ["INBOX", "CATEGORY_FORUMS"],
        subject: "Digest 1",
      })
    )
    await harness.sync()

    harness.provider.historyId = "600"
    harness.provider.queueDeltaAdd(
      message({
        id: "102",
        threadId: "t2",
        date: 200,
        fromEmail: "news@lists.dev",
        labelIds: ["INBOX"],
        subject: "Digest 2",
      })
    )
    await harness.sync()

    expect(await statRows()).toEqual([
      {
        sender: "news@lists.dev",
        reply_count: 0,
        direct_to_me_count: 0,
        is_mailing_list: 1, // stuck from the first pass
        last_message_at: 200,
      },
    ])
  })
})

describe("alias reconcile rides the sync (task 16.2, design D10)", () => {
  let harness: TestHarness

  beforeEach(async () => {
    harness = await createHarness()
  })

  afterEach(() => {
    harness.executor.close()
  })

  it("reconciles settings/sendAs into the alias rows after a full sync", async () => {
    harness.provider.addMessage(message({ id: "101", threadId: "t1" }))
    await harness.sync({
      listSendAs: async () => [
        {
          // The primary entry — skipped (the account identity baseline).
          sendAsEmail: `${harness.accountId}@example.com`,
          isPrimary: true,
        },
        {
          sendAsEmail: "work@example.com",
          displayName: "Work",
          isDefault: true,
          verificationStatus: "accepted",
        },
        {
          // Unverified — must not become a From identity.
          sendAsEmail: "pending@example.com",
          verificationStatus: "pending",
        },
      ],
    })

    const aliases = await listAliases(harness.executor, harness.accountId)
    expect(aliases).toHaveLength(1)
    expect(aliases[0]).toMatchObject({
      account_id: harness.accountId,
      email: "work@example.com",
      display_name: "Work",
      is_default: 1,
      source: "gmail",
    })
  })

  it("also runs on the delta path", async () => {
    harness.provider.addMessage(
      message({ id: "101", threadId: "t1", date: 100 })
    )
    await harness.sync({ listSendAs: async () => [] })

    harness.provider.historyId = "600"
    harness.provider.queueDeltaAdd(
      message({ id: "102", threadId: "t2", date: 200 })
    )
    await harness.sync({
      listSendAs: async () => [
        { sendAsEmail: "delta-alias@example.com", displayName: "Later" },
      ],
    })

    const aliases = await listAliases(
      harness.executor,
      harness.accountId,
      "gmail"
    )
    expect(aliases.map((alias) => alias.email)).toEqual([
      "delta-alias@example.com",
    ])
  })

  it("a failing alias pass never fails the sync and stores no rows", async () => {
    harness.provider.addMessage(message({ id: "101", threadId: "t1" }))
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
    try {
      const summary = await harness.sync({
        listSendAs: () => Promise.reject(new Error("sendAs endpoint down")),
      })
      // The message sync itself completed untouched.
      expect(summary).toMatchObject({ mode: "full", newMessages: 1 })
      expect(
        await listAliases(harness.executor, harness.accountId)
      ).toHaveLength(0)
      expect(warnSpy).toHaveBeenCalledWith(
        "[gmail-sync] alias sync failed; skipping this pass",
        expect.any(Error)
      )
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// Blocked senders (task 18.2, mail-security "Block sender"): the ingestion
// hook flow's FIFTH consumer. A blocklist row files the sender's new
// message (mark read + trash/archive per the block-time action, queued as
// pending ops) and keeps it out of the newMessages count; other senders
// are untouched.
// ---------------------------------------------------------------------------

describe("gmail sync blocked senders", () => {
  let harness: TestHarness

  beforeEach(async () => {
    harness = await createHarness()
  })

  afterEach(() => {
    harness.executor.close()
  })

  /** The local trash branch needs a trash-role label row (gmail model). */
  async function seedTrashLabel(): Promise<void> {
    await createGmailLabel(
      harness.executor,
      harness.accountId,
      "TRASH",
      "TRASH",
      "trash"
    )
  }

  /** storedThreads does not carry is_trashed; the placement flag reads
   * straight off the row for the trash assertions. */
  async function threadFlag(
    harness: TestHarness,
    threadRowId: string
  ): Promise<{ is_archived: number; is_trashed: number }> {
    const rows = await harness.executor.select<{
      is_archived: number
      is_trashed: number
    }>("SELECT is_archived, is_trashed FROM threads WHERE id = $1", [
      threadRowId,
    ])
    return rows[0]!
  }

  it("a blocked sender's new message is marked read, trashed and never counted", async () => {
    await seedTrashLabel()
    await blockSender(harness.executor, harness.accountId, {
      sender: "spam@x.com",
      action: "trash",
    })

    harness.provider.addMessage(
      message({
        id: "101",
        threadId: "t1",
        date: 100,
        fromEmail: "spam@x.com",
        labelIds: ["INBOX", "UNREAD"],
        subject: "Buy now",
      })
    )
    // An unblocked sender syncs normally beside it.
    harness.provider.addMessage(
      message({
        id: "102",
        threadId: "t2",
        date: 200,
        labelIds: ["INBOX", "UNREAD"],
      })
    )

    const summary = await harness.sync()

    // Only the unblocked message reaches the announcement count.
    expect(summary.newMessages).toBe(1)
    const threads = await storedThreads(harness)
    const blocked = threads.find((thread) => thread.gmail_thread_id === "t1")
    expect(blocked).toMatchObject({ message_count: 1, unread_count: 0 })
    expect(await threadFlag(harness, blocked!.id)).toMatchObject({
      is_trashed: 1,
    })
    const messages = await storedMessages(harness)
    expect(
      messages.find((row) => row.gmail_message_id === "101")
    ).toMatchObject({ is_read: 1 })
    // Filed through the thread-actions path: local effect + queue ops.
    const ops = await pendingOps(harness)
    expect(ops.map((op) => op.op_type)).toEqual(["mark_read", "trash"])
    const trashPayload = JSON.parse(ops[1]?.payload_json ?? "{}") as {
      refs?: { providerMessageId?: string }[]
    }
    expect(trashPayload.refs?.[0]?.providerMessageId).toBe("101")
  })

  it("honors the archive choice from block time", async () => {
    await blockSender(harness.executor, harness.accountId, {
      sender: "news@x.com",
      action: "archive",
    })

    harness.provider.addMessage(
      message({
        id: "101",
        threadId: "t1",
        date: 100,
        fromEmail: "news@x.com",
        labelIds: ["INBOX", "UNREAD"],
        subject: "Digest",
      })
    )

    const summary = await harness.sync()

    expect(summary.newMessages).toBe(0)
    const threads = await storedThreads(harness)
    expect(threads[0]).toMatchObject({ unread_count: 0 })
    expect(await threadFlag(harness, threads[0]!.id)).toMatchObject({
      is_archived: 1,
      is_trashed: 0,
    })
    expect((await pendingOps(harness)).map((op) => op.op_type)).toEqual([
      "mark_read",
      "archive",
    ])
  })

  it("unblocking restores the normal inbox arrival", async () => {
    await blockSender(harness.executor, harness.accountId, {
      sender: "spam@x.com",
      action: "trash",
    })
    const rows = await listBlockedSenders(harness.executor, harness.accountId)
    await unblockSender(harness.executor, rows[0]!.id)

    harness.provider.addMessage(
      message({
        id: "101",
        threadId: "t1",
        date: 100,
        fromEmail: "spam@x.com",
        labelIds: ["INBOX", "UNREAD"],
      })
    )

    const summary = await harness.sync()

    expect(summary.newMessages).toBe(1)
    const threads = await storedThreads(harness)
    expect(threads[0]).toMatchObject({ unread_count: 1, is_archived: 0 })
    expect(await threadFlag(harness, threads[0]!.id)).toMatchObject({
      is_trashed: 0,
    })
    expect(await pendingOps(harness)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Gmail junk-filter exemption (task 18.10, design D19): Google's
// server-side filtering already files gmail spam, so the gmail engine
// NEVER passes a junk config to the ingestion hook — even a fully trained
// store plus an (unsupported, but persisted) opt-in flag must not move a
// single message.
// ---------------------------------------------------------------------------

describe("gmail sync junk-filter exemption", () => {
  let harness: TestHarness

  beforeEach(async () => {
    harness = await createHarness()
  })

  afterEach(() => {
    harness.executor.close()
  })

  async function threadFlag(threadRowId: string) {
    const rows = await harness.executor.select<{
      is_spam: number
      is_trashed: number
    }>("SELECT is_spam, is_trashed FROM threads WHERE id = $1", [threadRowId])
    return rows[0]!
  }

  it("never classifies, even trained and opted in", async () => {
    const SPAM_BODY = "buy cheap pills now winner"
    for (let i = 0; i < 50; i += 1) {
      await trainJunkDocument(
        harness.executor,
        harness.accountId,
        SPAM_BODY,
        true
      )
    }
    // Not reachable from any settings UI (gmail accounts get a disabled
    // switch), but persisted state must not matter: the engine never
    // builds a config for a non-IMAP account.
    await setJunkFilterEnabledPreference(
      harness.executor,
      harness.accountId,
      true
    )

    harness.provider.addMessage(
      message({
        id: "101",
        threadId: "t1",
        date: 100,
        fromEmail: "winner@lottery.example",
        labelIds: ["INBOX", "UNREAD"],
        subject: "Claim your prize",
        textBody: SPAM_BODY,
      })
    )

    const summary = await harness.sync()

    // The spammy message is treated exactly like any other arrival.
    expect(summary.newMessages).toBe(1)
    const messages = await storedMessages(harness)
    expect(messages.find((row) => row.gmail_message_id === "101")).toBeDefined()
    const threads = await storedThreads(harness)
    expect(await threadFlag(threads[0]!.id)).toMatchObject({
      is_spam: 0,
      is_trashed: 0,
    })
    expect(await pendingOps(harness)).toEqual([])
  })
})

describe("gmail sync subscriptions", () => {
  let harness: TestHarness

  beforeEach(async () => {
    harness = await createHarness()
  })

  afterEach(() => {
    harness.executor.close()
  })

  it("lists senders of List-Unsubscribe mail; plain mail never enters the list (task 3.6, D13)", async () => {
    harness.provider.addMessage(
      message({
        id: "301",
        threadId: "t301",
        fromEmail: "news@lists.example.com",
        listUnsubscribe: "<https://lists.example.com/u/1>",
        listUnsubscribePost: "List-Unsubscribe=One-Click",
      })
    )
    harness.provider.addMessage(
      message({ id: "302", threadId: "t302", fromEmail: "friend@example.com" })
    )

    const summary = await harness.sync()
    // Detection never touches the notification count.
    expect(summary.newMessages).toBe(2)

    const entries = await listSubscriptions(
      harness.executor,
      harness.accountId
    )
    expect(entries.map((entry) => entry.sender)).toEqual([
      "news@lists.example.com",
    ])
    expect(entries[0]).toMatchObject({
      state: "subscribed",
      listUnsubscribe: "<https://lists.example.com/u/1>",
      listUnsubscribePost: "List-Unsubscribe=One-Click",
    })
  })

  it("new mail from an unsubscribed sender flips its entry to resumed (task 3.6, D13)", async () => {
    // The manager already knows the sender, and the user unsubscribed.
    await recordSenderSeen(harness.executor, harness.accountId, {
      sender: "news@lists.example.com",
      lastSeenAt: 100,
      listUnsubscribe: "<https://lists.example.com/u/1>",
    })
    await markUnsubscribed(
      harness.executor,
      harness.accountId,
      "news@lists.example.com",
      { at: 150 }
    )

    harness.provider.addMessage(
      message({
        id: "303",
        threadId: "t303",
        date: 5000,
        fromEmail: "news@lists.example.com",
        listUnsubscribe: "<https://lists.example.com/u/1>",
        subject: "We missed you",
      })
    )
    await harness.sync()

    // The spec's sender-resumed scenario: the unsubscribe did not hold.
    const entry = await getSubscription(
      harness.executor,
      harness.accountId,
      "news@lists.example.com"
    )
    expect(entry?.state).toBe("resumed")
    expect(entry?.lastSeenAt).toBe(5000)
    expect(entry?.unsubscribedAt).toBe(150)
  })
})
