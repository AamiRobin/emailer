import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import type { LabelRow } from "../../db/labels"
import type { SpecialUse } from "../../db/labels"
import { addNotificationRule } from "../../db/notification-rules"
import { muteThread } from "../../email-actions/thread-states"
import { setThreadFolder } from "../../db/threads"
import {
  blockSender,
  listBlockedSenders,
  unblockSender,
} from "../../db/blocked-senders"
import { createRule } from "../../rules"
import {
  leafFolderName,
  systemLabelForSpecialUse,
  userFolderLabelId,
} from "../../email/folder-mapper"
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
import type { FolderSyncStateRow } from "../folder-sync-state"
import { getFolderSyncState } from "../folder-sync-state"
import type { FetchFlagsChangedFn } from "../flag-sync"
import type { ImapSyncSummary } from "../imap-sync"
import { syncImapAccount } from "../imap-sync"
import { setJunkFilterEnabledPreference } from "../../settings/preferences"
import { trainJunkDocument } from "../../security/junk-filter"

// ---------------------------------------------------------------------------
// In-memory IMAP server + provider standing in for the Rust command layer
// ---------------------------------------------------------------------------

interface FakeStoredMessage {
  uid: number
  flags: string[]
  messageId?: string
  inReplyTo?: string
  references?: string
  subject?: string
  fromName?: string
  fromEmail?: string
  /** To-header addresses (sender-stats direct-to-me tests). */
  toEmails?: string[]
  /** List-unsubscribe capture (task 18.3, D13). */
  listUnsubscribe?: string
  listUnsubscribePost?: string
  date: number
  textBody?: string
  size: number
}

class FakeFolder {
  uidValidity: number
  messages = new Map<number, FakeStoredMessage>()
  private nextUid = 1

  constructor(uidValidity: number) {
    this.uidValidity = uidValidity
  }

  insert(
    message: Omit<FakeStoredMessage, "uid" | "size"> & { size?: number }
  ): number {
    const uid = this.nextUid
    this.nextUid += 1
    this.messages.set(uid, { size: 100, ...message, uid })
    return uid
  }

  get maxUid(): number {
    let max = 0
    for (const uid of this.messages.keys()) max = Math.max(max, uid)
    return max
  }

  get uidNext(): number {
    return this.maxUid + 1
  }
}

const NO_MESSAGES_ERROR =
  "no messages to fetch: provide a non-empty uidSet, or a non-zero `last` on a non-empty folder"

/**
 * Minimal EmailProvider over the fake folders, mirroring the Rust fetch
 * contract: {last: n} resolves against UIDNEXT (start = max(1, uidNext-n))
 * and an explicit uidSet is matched by UID, including the IMAP "n:*" quirk
 * (when n exceeds every UID the range still returns the newest message).
 * Every fetch is recorded so tests can assert the exact delta queries.
 */
class FakeImapProvider implements EmailProvider {
  readonly type = "imap" as const
  calls: { folder: string; query: FetchQuery }[] = []

  private readonly folders: Map<string, FakeFolder>
  private readonly descriptors: EmailFolder[]

  readonly accountId: string

  constructor(
    accountId: string,
    folders: Map<string, FakeFolder>,
    descriptors: EmailFolder[]
  ) {
    this.accountId = accountId
    this.folders = folders
    this.descriptors = descriptors
  }

  async listFolders(): Promise<EmailFolder[]> {
    return this.descriptors
  }

  async deltaSync(): Promise<DeltaSyncResult> {
    throw new Error("deltaSync is not part of the 4.3 fake provider")
  }

  async fetchMessages(
    folder: string,
    query: FetchQuery
  ): Promise<FetchMessagesResult> {
    this.calls.push({ folder, query })
    const box = this.requireFolder(folder)
    const all = this.sorted(box)
    const folderStatus = {
      uidValidity: box.uidValidity,
      uidNext: box.uidNext,
      exists: all.length,
      unseen: all.filter((m) => !m.flags.includes("\\Seen")).length,
    }
    let selected: FakeStoredMessage[]
    if (query.uidSet !== undefined) {
      selected = this.selectByUidSet(all, query.uidSet)
    } else if (query.last !== undefined) {
      if (query.last === 0 || box.uidNext <= 1) {
        throw new Error(NO_MESSAGES_ERROR)
      }
      const start = Math.max(1, box.uidNext - query.last)
      selected = all.filter((m) => m.uid >= start)
    } else {
      throw new Error("fetchMessages requires uidSet or last")
    }
    return {
      messages: selected.map((m) => toNormalizedMessage(m, folder)),
      folderStatus,
    }
  }

  async fetchFlags(folder: string, query: FetchQuery): Promise<MessageFlags[]> {
    const box = this.requireFolder(folder)
    const all = this.sorted(box)
    let selected: FakeStoredMessage[]
    if (query.uidSet !== undefined) {
      selected = this.selectByUidSet(all, query.uidSet)
    } else if (query.last !== undefined && query.last > 0 && box.uidNext > 1) {
      const start = Math.max(1, box.uidNext - query.last)
      selected = all.filter((m) => m.uid >= start)
    } else {
      throw new Error(NO_MESSAGES_ERROR)
    }
    return selected.map((m) => ({ uid: m.uid, flags: m.flags }))
  }

  private requireFolder(folder: string): FakeFolder {
    const box = this.folders.get(folder)
    if (!box) throw new Error(`no such folder: ${folder}`)
    return box
  }

  private sorted(box: FakeFolder): FakeStoredMessage[] {
    return [...box.messages.values()].sort((a, b) => a.uid - b.uid)
  }

  private selectByUidSet(
    all: FakeStoredMessage[],
    uidSet: string
  ): FakeStoredMessage[] {
    const maxUid = all.length > 0 ? (all[all.length - 1]?.uid ?? 0) : 0
    const byUid = new Map(all.map((m) => [m.uid, m]))
    const selected = new Map<number, FakeStoredMessage>()
    const add = (uid: number): void => {
      const message = byUid.get(uid)
      if (message) selected.set(uid, message)
    }
    for (const part of uidSet.split(",")) {
      const [rawStart, rawEnd] = part.split(":")
      if (rawStart === undefined || rawStart === "") continue
      const start = Number(rawStart)
      if (rawEnd === undefined || rawEnd === "") {
        add(start)
      } else if (rawEnd === "*") {
        // IMAP n:* always includes the newest message, even when n > maxUid
        if (maxUid === 0) continue
        if (start > maxUid) {
          add(maxUid)
        } else {
          for (const message of all) {
            if (message.uid >= start) add(message.uid)
          }
        }
      } else {
        const end = Number(rawEnd)
        for (const message of all) {
          if (message.uid >= start && message.uid <= end) add(message.uid)
        }
      }
    }
    return [...selected.values()].sort((a, b) => a.uid - b.uid)
  }

  // The organization/send surface is not exercised by the sync engine.
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

function toNormalizedMessage(
  message: FakeStoredMessage,
  folder: string
): NormalizedMessage {
  const attachments: NormalizedAttachment[] = []
  return {
    uid: message.uid,
    flags: message.flags,
    messageId: message.messageId,
    inReplyTo: message.inReplyTo,
    references: message.references,
    subject: message.subject,
    listUnsubscribe: message.listUnsubscribe,
    listUnsubscribePost: message.listUnsubscribePost,
    from: [{ name: message.fromName, email: message.fromEmail }],
    to: (message.toEmails ?? []).map((email) => ({ email })),
    cc: [],
    bcc: [],
    date: message.date,
    textBody: message.textBody,
    size: message.size,
    attachments,
    folder,
  }
}

/** EmailFolder descriptor exactly as folder-mapper would produce it. */
function folderDescriptor(
  path: string,
  specialUse: SpecialUse | null,
  delimiter = "/"
): EmailFolder {
  if (specialUse) {
    const system = systemLabelForSpecialUse(specialUse)
    return {
      id: system.id,
      name: system.name,
      path,
      type: "system",
      specialUse,
      delimiter,
    }
  }
  return {
    id: userFolderLabelId(path),
    name: leafFolderName(path, delimiter),
    path,
    type: "user",
    specialUse: null,
    delimiter,
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface TestHarness {
  executor: TestExecutor
  accountId: string
  folders: Map<string, FakeFolder>
  provider: FakeImapProvider
  addFolder(
    path: string,
    uidValidity: number,
    specialUse: SpecialUse | null
  ): FakeFolder
  sync(
    batchSize?: number,
    extra?: {
      reconcileFlags?: boolean
      fetchFlagsChanged?: FetchFlagsChangedFn
    }
  ): Promise<ImapSyncSummary>
}

async function createHarness(): Promise<TestHarness> {
  const executor = createTestExecutor()
  const accountId = await createAccount(executor, "imap")
  const folders = new Map<string, FakeFolder>()
  const descriptors: EmailFolder[] = []
  const provider = new FakeImapProvider(accountId, folders, descriptors)

  function addFolder(
    path: string,
    uidValidity: number,
    specialUse: SpecialUse | null
  ): FakeFolder {
    const box = new FakeFolder(uidValidity)
    folders.set(path, box)
    descriptors.push(folderDescriptor(path, specialUse))
    return box
  }

  async function sync(
    batchSize?: number,
    extra?: {
      reconcileFlags?: boolean
      fetchFlagsChanged?: FetchFlagsChangedFn
    }
  ): Promise<ImapSyncSummary> {
    return syncImapAccount({
      executor,
      provider,
      accountId,
      ...(batchSize === undefined ? {} : { batchSize }),
      ...(extra ?? {}),
    })
  }

  return { executor, accountId, folders, provider, addFolder, sync }
}

async function labelByPath(
  harness: TestHarness,
  path: string
): Promise<LabelRow | null> {
  const rows = await harness.executor.select<LabelRow>(
    "SELECT * FROM labels WHERE account_id = $1 AND imap_folder_name = $2",
    [harness.accountId, path]
  )
  return rows[0] ?? null
}

interface StoredMessageRow {
  id: string
  imap_uid: number
  thread_id: string
  is_read: number
  is_flagged: number
  subject: string | null
}

async function messagesIn(
  harness: TestHarness,
  folder: string
): Promise<StoredMessageRow[]> {
  return harness.executor.select<StoredMessageRow>(
    `SELECT id, imap_uid, thread_id, is_read, is_flagged, subject FROM messages
     WHERE account_id = $1 AND imap_folder = $2 ORDER BY imap_uid ASC`,
    [harness.accountId, folder]
  )
}

async function threadById(harness: TestHarness, threadId: string) {
  const rows = await harness.executor.select<{
    id: string
    message_count: number
    unread_count: number
    folder_label_id: string | null
    is_archived: number
    is_trashed: number
    is_spam: number
    subject: string | null
  }>(
    `SELECT id, message_count, unread_count, folder_label_id,
            is_archived, is_trashed, is_spam, subject
     FROM threads WHERE id = $1`,
    [threadId]
  )
  return rows[0] ?? null
}

async function syncState(
  harness: TestHarness,
  folder: string
): Promise<FolderSyncStateRow | null> {
  return getFolderSyncState(harness.executor, harness.accountId, folder)
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("imap sync engine", () => {
  let harness: TestHarness

  beforeEach(async () => {
    harness = await createHarness()
  })

  afterEach(() => {
    harness.executor.close()
  })

  it("first sync creates labels, messages, threads and folder_sync_state", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    harness.addFolder("Archive/2024", 200, null)
    harness.addFolder("SENT", 300, "sent") // stays empty

    inbox.insert({
      flags: ["\\Seen"],
      messageId: "<m1@x>",
      subject: "Hello",
      fromEmail: "a@x",
      date: 1000,
      textBody: "first message",
    })
    inbox.insert({
      flags: [],
      messageId: "<m2@x>",
      inReplyTo: "<m1@x>",
      subject: "Re: Hello",
      fromEmail: "b@x",
      date: 2000,
      textBody: "reply body",
    })
    inbox.insert({
      flags: [],
      messageId: "<m3@x>",
      subject: "News",
      fromEmail: "c@x",
      date: 3000,
      textBody: "newsletter",
    })
    harness.folders.get("Archive/2024")?.insert({
      flags: [],
      messageId: "<old@x>",
      subject: "Filed",
      fromEmail: "d@x",
      date: 500,
      textBody: "archived",
    })

    const summary = await harness.sync()

    // A first sync is a seed pass: the whole folder is a backfill that is
    // stored and filed but never announces — the count stays 0 while the
    // messages, threads, labels and cursors below are still created.
    expect(summary).toMatchObject({
      foldersSynced: 3,
      newMessages: 0,
      errors: [],
    })

    // labels: system by special-use identity, user by folder path
    expect(await labelByPath(harness, "INBOX")).toMatchObject({
      id: `${harness.accountId}:INBOX`,
      name: "INBOX",
      type: "system",
      special_use: "inbox",
    })
    expect(await labelByPath(harness, "Archive/2024")).toMatchObject({
      id: `${harness.accountId}:${userFolderLabelId("Archive/2024")}`,
      name: "Archive/2024",
      type: "user",
      special_use: null,
    })

    // messages + threading (reply joins root), flags mapped to is_read
    const inboxMessages = await messagesIn(harness, "INBOX")
    expect(inboxMessages).toHaveLength(3)
    const byUid = new Map(inboxMessages.map((m) => [m.imap_uid, m]))
    const m1 = byUid.get(1)
    const m2 = byUid.get(2)
    const m3 = byUid.get(3)
    expect(m1?.is_read).toBe(1)
    expect(m2?.is_read).toBe(0)
    expect(m2?.thread_id).toBe(m1?.thread_id)
    expect(m3?.thread_id).not.toBe(m1?.thread_id)

    const thread = await threadById(harness, m1?.thread_id as string)
    expect(thread).toMatchObject({
      message_count: 2,
      unread_count: 1,
      subject: "Hello",
      folder_label_id: `${harness.accountId}:INBOX`,
    })

    // cursors: one row per folder, including the empty one
    expect(await syncState(harness, "INBOX")).toMatchObject({
      uidvalidity: 100,
      last_seen_uid: 3,
    })
    expect(await syncState(harness, "Archive/2024")).toMatchObject({
      uidvalidity: 200,
      last_seen_uid: 1,
    })
    expect(await syncState(harness, "SENT")).toMatchObject({
      uidvalidity: null,
      last_seen_uid: 0,
    })
  })

  it("captures list-unsubscribe headers into the stored headers JSON (task 18.3)", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    inbox.insert({
      flags: [],
      messageId: "<list-1@x>",
      subject: "Monthly digest",
      fromEmail: "news@lists.example.com",
      listUnsubscribe:
        "<https://lists.example.com/u/1>, <mailto:leave@lists.example.com>",
      listUnsubscribePost: "List-Unsubscribe=One-Click",
      date: 1000,
      textBody: "digest",
    })
    inbox.insert({
      flags: [],
      messageId: "<plain-1@x>",
      subject: "Plain",
      fromEmail: "friend@x",
      date: 2000,
      textBody: "no headers here",
    })

    await harness.sync()

    const rows = await harness.executor.select<{
      imap_uid: number
      headers: string | null
    }>(
      `SELECT imap_uid, headers FROM messages
       WHERE account_id = $1 AND imap_folder = 'INBOX' ORDER BY imap_uid ASC`,
      [harness.accountId]
    )
    const byUid = new Map(rows.map((m) => [m.imap_uid, m]))
    const listRow = byUid.get(1)
    const plainRow = byUid.get(2)
    // The one-click pair is stored verbatim, lowercase-keyed — exactly the
    // shape unsubscribeTargetsFromHeaders reads on the mail view.
    expect(JSON.parse(listRow?.headers ?? "null")).toEqual({
      "list-unsubscribe":
        "<https://lists.example.com/u/1>, <mailto:leave@lists.example.com>",
      "list-unsubscribe-post": "List-Unsubscribe=One-Click",
    })
    // A message without the headers keeps the column NULL.
    expect(plainRow?.headers).toBeNull()
  })

  it("second sync with no changes queries only the delta and inserts nothing", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    inbox.insert({
      flags: [],
      messageId: "<m1@x>",
      subject: "Hello",
      date: 1000,
    })
    await harness.sync()
    const afterFirst = await messagesIn(harness, "INBOX")

    harness.provider.calls = []
    const summary = await harness.sync()

    // a single bounded {last: batch} query — never an unbounded uid set
    expect(harness.provider.calls).toEqual([
      { folder: "INBOX", query: { last: 200 } },
    ])
    expect(summary.newMessages).toBe(0)
    expect(summary.errors).toEqual([])
    expect(await messagesIn(harness, "INBOX")).toEqual(afterFirst)
    expect(await syncState(harness, "INBOX")).toMatchObject({
      uidvalidity: 100,
      last_seen_uid: 1,
    })
  })

  it("delta sync: a later reply joins the existing thread via references", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    inbox.insert({
      flags: [],
      messageId: "<m1@x>",
      subject: "Hello",
      date: 1000,
    })
    await harness.sync()
    const rootThread = (await messagesIn(harness, "INBOX"))[0]?.thread_id

    inbox.insert({
      flags: [],
      messageId: "<m2@x>",
      inReplyTo: "<m1@x>",
      subject: "Re: Hello",
      date: 5000,
    })

    harness.provider.calls = []
    const summary = await harness.sync()

    expect(harness.provider.calls).toEqual([
      { folder: "INBOX", query: { last: 200 } },
    ])
    expect(summary.newMessages).toBe(1)

    const messages = await messagesIn(harness, "INBOX")
    expect(messages).toHaveLength(2)
    expect(messages[1]?.thread_id).toBe(rootThread)
    expect(await threadById(harness, rootThread as string)).toMatchObject({
      message_count: 2,
      unread_count: 2,
    })
  })

  it("new mail joining a trashed thread is stored but never counted", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    harness.addFolder("Trash", 400, "trash")
    const archive = harness.addFolder("Archive", 300, null)
    inbox.insert({
      flags: [],
      messageId: "<m1@x>",
      subject: "Hello",
      fromEmail: "a@x",
      date: 1000,
    })
    await harness.sync() // seed pass: stored, never counted
    const threadId = (await messagesIn(harness, "INBOX"))[0]!.thread_id

    // The user trashes the thread locally — the placement caches the
    // count gate reads (folder moved onto the trash-role label).
    const trashLabel = await labelByPath(harness, "Trash")
    await setThreadFolder(harness.executor, threadId, trashLabel!.id)
    expect(await threadById(harness, threadId)).toMatchObject({
      is_trashed: 1,
    })

    // A reply lands in Archive — a non-inbox folder, so the placement
    // gate (not the inbox re-entry rule) is what must exclude the count.
    archive.insert({
      flags: [],
      messageId: "<m2@x>",
      inReplyTo: "<m1@x>",
      subject: "Re: Hello",
      fromEmail: "b@x",
      date: 5000,
    })
    const summary = await harness.sync()

    // Stored and threaded, but the trashed thread never announces.
    expect(summary.newMessages).toBe(0)
    const archived = await messagesIn(harness, "Archive")
    expect(archived).toHaveLength(1)
    expect(archived[0]?.thread_id).toBe(threadId)
    expect(await threadById(harness, threadId)).toMatchObject({
      message_count: 2,
      is_trashed: 1,
    })
  })

  it("a reply to an archived thread re-enters the inbox; an Archive arrival does not re-file", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    const archive = harness.addFolder("Archive", 200, "archive")
    archive.insert({
      flags: [],
      messageId: "<m1@x>",
      subject: "Hello",
      fromEmail: "a@x",
      date: 1000,
    })
    await harness.sync() // seed: the thread lives in Archive
    const threadId = (await messagesIn(harness, "Archive"))[0]!.thread_id
    const inboxLabelId = `${harness.accountId}:INBOX`
    expect(await threadById(harness, threadId)).toMatchObject({
      folder_label_id: `${harness.accountId}:${systemLabelForSpecialUse("archive").id}`,
      is_archived: 1,
    })

    // A reply lands in INBOX: the additive-INBOX rule repoints the
    // reused thread (setThreadFolder also clears is_archived), so it
    // re-enters the inbox — mirroring gmail's behavior.
    inbox.insert({
      flags: [],
      messageId: "<m2@x>",
      inReplyTo: "<m1@x>",
      subject: "Re: Hello",
      fromEmail: "b@x",
      date: 5000,
    })
    const summary = await harness.sync()
    expect(summary.newMessages).toBe(1)
    expect(await threadById(harness, threadId)).toMatchObject({
      folder_label_id: inboxLabelId,
      is_archived: 0,
    })

    // A later reply landing in Archive must NOT re-file the thread away
    // from the inbox (only inbox-role arrivals re-file).
    archive.insert({
      flags: [],
      messageId: "<m3@x>",
      inReplyTo: "<m1@x>",
      subject: "Re: Hello again",
      fromEmail: "c@x",
      date: 9000,
    })
    const third = await harness.sync()
    expect(third.newMessages).toBe(1)
    expect(await threadById(harness, threadId)).toMatchObject({
      folder_label_id: inboxLabelId,
    })
  })

  it("delta sync: bursts larger than the batch page explicit uid ranges", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    for (let index = 1; index <= 5; index += 1) {
      inbox.insert({ flags: [], messageId: `<m${index}@x>`, date: index })
    }
    await harness.sync(2) // full sync arrives in 2-message pages
    expect(await messagesIn(harness, "INBOX")).toHaveLength(5)

    inbox.insert({ flags: [], messageId: "<m6@x>", date: 6 })
    inbox.insert({ flags: [], messageId: "<m7@x>", date: 7 })
    inbox.insert({ flags: [], messageId: "<m8@x>", date: 8 })

    harness.provider.calls = []
    const summary = await harness.sync(2)

    // {last: 2} covers uid 7-8; the saturated window pages down to the
    // last unseen uid (6) — clamped at lastSeenUid+1, never refetching
    expect(harness.provider.calls).toEqual([
      { folder: "INBOX", query: { last: 2 } },
      { folder: "INBOX", query: { uidSet: "6:6" } },
    ])
    expect(summary.newMessages).toBe(3)
    expect(await messagesIn(harness, "INBOX")).toHaveLength(8)
    expect(await syncState(harness, "INBOX")).toMatchObject({
      last_seen_uid: 8,
    })
  })

  it("uidvalidity change drops the folder and re-syncs it fully", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    inbox.insert({
      flags: [],
      messageId: "<old-1@x>",
      subject: "Old",
      date: 1000,
    })
    inbox.insert({
      flags: [],
      messageId: "<old-2@x>",
      subject: "Old 2",
      date: 2000,
    })
    await harness.sync()

    // server rebuild: new uidvalidity, new uid space, new conversation
    const fresh = new FakeFolder(999)
    fresh.insert({
      flags: [],
      messageId: "<new-1@x>",
      subject: "New",
      date: 9000,
    })
    fresh.insert({
      flags: [],
      messageId: "<new-2@x>",
      inReplyTo: "<new-1@x>",
      subject: "Re: New",
      date: 9100,
    })
    harness.folders.set("INBOX", fresh)

    harness.provider.calls = []
    const summary = await harness.sync()

    expect(harness.provider.calls).toEqual([
      { folder: "INBOX", query: { last: 200 } },
    ])
    // The invalidation re-sync is a re-backfill (seed pass): the fresh
    // conversation is stored and threaded but never announces.
    expect(summary.newMessages).toBe(0)

    const messages = await messagesIn(harness, "INBOX")
    expect(messages.map((m) => m.imap_uid)).toEqual([1, 2])
    expect(messages.map((m) => m.subject)).toEqual(["New", "Re: New"])
    // the re-synced conversation threads correctly in the new uid space
    expect(messages[1]?.thread_id).toBe(messages[0]?.thread_id)
    expect(await syncState(harness, "INBOX")).toMatchObject({
      uidvalidity: 999,
      last_seen_uid: 2,
    })

    // the stale threads vanished with their messages
    const threads = await harness.executor.select<{ id: string }>(
      "SELECT id FROM threads WHERE account_id = $1",
      [harness.accountId]
    )
    expect(threads).toHaveLength(1)
  })

  it("flag-only server changes reflect through the delta window upsert", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    const uid = inbox.insert({
      flags: [],
      messageId: "<m1@x>",
      subject: "Hello",
      date: 1000,
    })
    await harness.sync()
    expect((await messagesIn(harness, "INBOX"))[0]?.is_read).toBe(0)

    inbox.messages.get(uid)?.flags.push("\\Seen")

    const summary = await harness.sync()

    expect(summary.newMessages).toBe(0)
    const messages = await messagesIn(harness, "INBOX")
    expect(messages).toHaveLength(1)
    expect(messages[0]?.is_read).toBe(1)
  })

  it("threads one conversation across folders through the shared message-id", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    const archive = harness.addFolder("Archive", 200, "archive")
    inbox.insert({
      flags: [],
      messageId: "<m1@x>",
      subject: "Hi",
      date: 1000,
    })
    inbox.insert({
      flags: [],
      messageId: "<m2@x>",
      inReplyTo: "<m1@x>",
      subject: "Re: Hi",
      date: 2000,
    })
    archive.insert({
      flags: ["\\Seen"],
      messageId: "<m1@x>",
      subject: "Hi",
      date: 1000,
    })

    const summary = await harness.sync()

    expect(summary.errors).toEqual([])
    const inboxThread = (await messagesIn(harness, "INBOX"))[0]?.thread_id
    const archivedCopy = (await messagesIn(harness, "Archive"))[0]
    // the copy joins the inbox conversation; the thread keeps its folder
    expect(archivedCopy?.thread_id).toBe(inboxThread)
    expect(await threadById(harness, inboxThread as string)).toMatchObject({
      message_count: 3,
      folder_label_id: `${harness.accountId}:INBOX`,
    })
  })

  it("collects per-folder errors and still syncs the rest", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    harness.addFolder("Broken", 300, null)
    // Seed the cursors first (both folders empty — not a seed pass): the
    // arrival below is then a genuine delta the count can report.
    await harness.sync()

    inbox.insert({
      flags: [],
      messageId: "<m1@x>",
      subject: "Hello",
      date: 1000,
    })

    const originalFetch = harness.provider.fetchMessages.bind(harness.provider)
    harness.provider.fetchMessages = async (folder, query) => {
      if (folder === "Broken") throw new Error("connection reset by peer")
      return originalFetch(folder, query)
    }

    const summary = await harness.sync()

    expect(summary.foldersSynced).toBe(1)
    expect(summary.newMessages).toBe(1)
    expect(summary.errors).toEqual(["Broken: connection reset by peer"])
    expect(await messagesIn(harness, "INBOX")).toHaveLength(1)
  })

  it("mute gating: new mail landing in a muted thread is stored but not counted as new", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    inbox.insert({
      flags: ["\\Seen"],
      messageId: "<m1@x>",
      subject: "Hello",
      fromEmail: "a@x",
      date: 1000,
      textBody: "first message",
    })
    inbox.insert({
      flags: [],
      messageId: "<solo@x>",
      subject: "Other",
      fromEmail: "c@x",
      date: 1500,
      textBody: "other",
    })
    await harness.sync()

    // Mute the Hello thread locally through the thread-states service
    // (what the UI's context menu will call).
    const root = (await messagesIn(harness, "INBOX")).find(
      (message) => message.subject === "Hello"
    )
    await muteThread(harness.executor, root?.thread_id as string)

    // A reply joins the muted thread; a fresh root lands in an unmuted
    // one. Only the latter may reach the count the scheduler forwards to
    // notifyNewMail.
    inbox.insert({
      flags: [],
      messageId: "<m2@x>",
      inReplyTo: "<m1@x>",
      subject: "Re: Hello",
      fromEmail: "b@x",
      date: 3000,
      textBody: "reply body",
    })
    inbox.insert({
      flags: [],
      messageId: "<fresh@x>",
      subject: "Fresh",
      fromEmail: "d@x",
      date: 4000,
      textBody: "fresh",
    })

    const summary = await harness.sync()

    expect(summary.newMessages).toBe(1)
    // The muted thread's reply is still fully stored…
    expect(await messagesIn(harness, "INBOX")).toHaveLength(4)
    // …and the new incoming message did NOT unmute the thread (spec).
    const rows = await harness.executor.select<{ muted_at: number | null }>(
      "SELECT muted_at FROM threads WHERE id = $1",
      [root?.thread_id as string]
    )
    expect(rows[0]?.muted_at).toBeGreaterThan(0)
  })

  // ----- Flag-consistency pass (task 4.7, D14) -----

  it("flag pass reconciles changes below the delta window without re-downloading bodies", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    for (let index = 1; index <= 4; index += 1) {
      inbox.insert({ flags: [], messageId: `<m${index}@x>`, date: index })
    }
    await harness.sync(2)
    expect((await messagesIn(harness, "INBOX"))[0]?.is_flagged).toBe(0)

    // another client stars uid 1 — outside the {last: 2} delta window
    inbox.messages.get(1)?.flags.push("\\Flagged")

    harness.provider.calls = []
    const summary = await harness.sync(2)

    // delta only touches uids 3-4; the flag pass covers uid 1 flags-only
    expect(harness.provider.calls).toEqual([
      { folder: "INBOX", query: { last: 2 } },
    ])
    expect(summary.flagChanges).toBe(1)
    expect(summary.errors).toEqual([])
    expect((await messagesIn(harness, "INBOX"))[0]?.is_flagged).toBe(1)
  })

  it("reconcileFlags: false skips the flag pass entirely", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    for (let index = 1; index <= 4; index += 1) {
      inbox.insert({ flags: [], messageId: `<m${index}@x>`, date: index })
    }
    await harness.sync(2)

    inbox.messages.get(1)?.flags.push("\\Flagged")

    const summary = await harness.sync(2, { reconcileFlags: false })

    expect(summary.flagChanges).toBe(0)
    expect((await messagesIn(harness, "INBOX"))[0]?.is_flagged).toBe(0)
  })

  it("flag pass uses the CONDSTORE changed-since hook when wired", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    for (let index = 1; index <= 4; index += 1) {
      inbox.insert({ flags: [], messageId: `<m${index}@x>`, date: index })
    }

    const hookCalls: { folder: string; sinceModseq: number }[] = []
    const MODSEQ = 4242
    // Real servers report HIGHESTMODSEQ and only return messages whose
    // mod-sequence changed; this stub returns everything (server-wins diff
    // makes that equivalent) while recording the requested cursor.
    const fetchFlagsChanged: FetchFlagsChangedFn = async (
      folder,
      sinceModseq
    ) => {
      hookCalls.push({ folder, sinceModseq })
      const box = harness.folders.get(folder)
      if (!box) throw new Error(`no such folder: ${folder}`)
      return {
        flags: [...box.messages.values()].map((message) => ({
          uid: message.uid,
          flags: message.flags,
        })),
        folderStatus: {
          uidValidity: box.uidValidity,
          uidNext: box.uidNext,
          exists: box.messages.size,
          unseen: 0,
          highestModseq: MODSEQ,
        },
      }
    }

    await harness.sync(2, { fetchFlagsChanged })
    // first run bootstraps the cursor (CHANGEDSINCE 1) and stores the status
    expect(hookCalls).toEqual([{ folder: "INBOX", sinceModseq: 1 }])
    expect(await syncState(harness, "INBOX")).toMatchObject({
      highest_modseq: MODSEQ,
    })

    // another client reads uid 1 — below the {last: 2} delta window; the
    // second run queries changed-since from the stored mod-sequence
    inbox.messages.get(1)?.flags.push("\\Seen")
    hookCalls.length = 0
    const summary = await harness.sync(2, { fetchFlagsChanged })

    expect(hookCalls).toEqual([{ folder: "INBOX", sinceModseq: MODSEQ }])
    expect(summary.flagChanges).toBe(1)
    expect((await messagesIn(harness, "INBOX"))[0]?.is_read).toBe(1)
    // the CONDSTORE cursor survives the delta pass's state upsert
    expect(await syncState(harness, "INBOX")).toMatchObject({
      highest_modseq: MODSEQ,
    })
  })

  // ----- Notification rules (task 8.1, design D16) -----

  it("never-sender rule: the message is stored but not counted as new", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    inbox.insert({
      flags: ["\\Seen"],
      messageId: "<m1@x>",
      subject: "Hello",
      fromEmail: "a@x",
      date: 1000,
    })
    await harness.sync()

    await addNotificationRule(harness.executor, {
      accountId: harness.accountId,
      matchType: "sender",
      matchValue: "newsletter@x.com",
      action: "never",
    })

    // The suppressed sender's mail lands beside a normal one. Only the
    // normal one may reach the count the scheduler forwards to
    // notifyNewMail.
    inbox.insert({
      flags: [],
      messageId: "<m2@x>",
      subject: "Digest",
      fromEmail: "newsletter@x.com",
      date: 2000,
    })
    inbox.insert({
      flags: [],
      messageId: "<m3@x>",
      subject: "Fresh",
      fromEmail: "a@x",
      date: 3000,
    })

    const summary = await harness.sync()

    expect(summary.newMessages).toBe(1)
    // The suppressed message is fully stored — only the announcement
    // count excludes it.
    expect(await messagesIn(harness, "INBOX")).toHaveLength(3)
  })

  it("never-label rule matches the folder's label name (full path or leaf)", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    const newsletters = harness.addFolder("Newsletters", 100, null)
    newsletters.insert({
      flags: [],
      messageId: "<n1@x>",
      subject: "Digest",
      fromEmail: "news@x.com",
      date: 100,
    })
    await harness.sync()

    await addNotificationRule(harness.executor, {
      accountId: harness.accountId,
      matchType: "label",
      matchValue: "newsletters",
      action: "never",
    })

    newsletters.insert({
      flags: [],
      messageId: "<n2@x>",
      subject: "Digest 2",
      fromEmail: "news@x.com",
      date: 200,
    })
    // A message in another folder is unaffected by the rule.
    inbox.insert({
      flags: [],
      messageId: "<in1@x>",
      subject: "Fresh",
      fromEmail: "news@x.com",
      date: 300,
    })

    const summary = await harness.sync()

    expect(summary.newMessages).toBe(1)
    expect(await messagesIn(harness, "Newsletters")).toHaveLength(2)
  })

  it("an always rule keeps its sender counted (VIP case)", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    inbox.insert({
      flags: ["\\Seen"],
      messageId: "<m1@x>",
      subject: "Hello",
      fromEmail: "boss@x.com",
      date: 1000,
    })
    await harness.sync()

    // Only an always rule for the regular sender exists: the message is
    // counted as before (never dominates always only when BOTH match).
    await addNotificationRule(harness.executor, {
      accountId: harness.accountId,
      matchType: "sender",
      matchValue: "boss@x.com",
      action: "always",
    })

    inbox.insert({
      flags: [],
      messageId: "<m2@x>",
      subject: "Ping",
      fromEmail: "boss@x.com",
      date: 2000,
    })

    const summary = await harness.sync()

    expect(summary.newMessages).toBe(1)
    expect(await messagesIn(harness, "INBOX")).toHaveLength(2)
  })

  // ----- Ingestion rules (task 11.1/11.2, design D5) -----
  //
  // The engine hands every newly inserted message to the rules hook after
  // the folder stamping + cache recompute; these scenarios verify the
  // end-to-end imap contract: ruled moves/trashes land locally AND queue
  // the server-side op, and ruled-away mail never notifies.

  async function pendingOps(
    harness: TestHarness
  ): Promise<{ op_type: string; payload_json: string }[]> {
    return harness.executor.select(
      `SELECT op_type, payload_json FROM pending_operations
       WHERE account_id = $1 ORDER BY seq ASC`,
      [harness.accountId]
    )
  }

  async function threadFlags(harness: TestHarness, threadId: string) {
    const rows = await harness.executor.select<{
      is_trashed: number
      is_archived: number
      is_spam: number
      unread_count: number
    }>(
      "SELECT is_trashed, is_archived, is_spam, unread_count FROM threads WHERE id = $1",
      [threadId]
    )
    return rows[0]
  }

  // The rule scenarios assert on ARRIVALS: a folder's first sync is a seed
  // pass that stores and files but never announces, so each test syncs the
  // empty folder first to establish the cursors, then delivers the mail.
  it("a move rule files the message into the target folder and never notifies", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    harness.addFolder("Newsletters", 100, null)
    await createRule(harness.executor, {
      accountId: harness.accountId,
      name: "File newsletters",
      criteriaQuery: "from:news@x.com",
      actions: [{ type: "move", folder: "Newsletters" }],
    })
    await harness.sync()

    inbox.insert({
      flags: [],
      messageId: "<n1@x>",
      subject: "Digest",
      fromEmail: "news@x.com",
      date: 1000,
    })
    inbox.insert({
      flags: [],
      messageId: "<k1@x>",
      subject: "Keep",
      fromEmail: "a@x.com",
      date: 2000,
    })

    const summary = await harness.sync()

    // The ruled message does not announce; the plain one does.
    expect(summary.newMessages).toBe(1)
    const inboxRows = await messagesIn(harness, "INBOX")
    expect(inboxRows.map((row) => row.subject)).toEqual(["Keep"])

    // The newsletter physically moved locally (row + thread folder cache).
    const moved = await messagesIn(harness, "Newsletters")
    expect(moved).toHaveLength(1)
    const folderId = await labelByPath(harness, "Newsletters")
    expect(
      await threadById(harness, moved[0]?.thread_id as string)
    ).toMatchObject({
      folder_label_id: folderId?.id,
    })

    const ops = await pendingOps(harness)
    expect(ops.map((op) => op.op_type)).toEqual(["move"])
    expect(JSON.parse(ops[0]?.payload_json ?? "{}")).toMatchObject({
      destinationFolder: "Newsletters",
      refs: [{ folder: "INBOX", uid: 1 }], // server-side location
    })
    // The folder cursors are untouched by the local move.
    expect(await syncState(harness, "INBOX")).toMatchObject({
      last_seen_uid: 2,
    })
  })

  it("a trash rule moves the message to the trash folder and never notifies", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    harness.addFolder("Trash", 100, "trash")
    await createRule(harness.executor, {
      accountId: harness.accountId,
      name: "Bin spam",
      criteriaQuery: "subject:winner",
      actions: [{ type: "trash" }],
    })
    await harness.sync()

    inbox.insert({
      flags: [],
      messageId: "<s1@x>",
      subject: "You are a winner",
      fromEmail: "spam@x.com",
      date: 1000,
    })
    inbox.insert({
      flags: [],
      messageId: "<k1@x>",
      subject: "Keep",
      fromEmail: "a@x.com",
      date: 2000,
    })

    const summary = await harness.sync()

    expect(summary.newMessages).toBe(1)
    const trashed = await messagesIn(harness, "Trash")
    expect(trashed).toHaveLength(1)
    expect(
      await threadFlags(harness, trashed[0]?.thread_id as string)
    ).toMatchObject({ is_trashed: 1 })
    expect(await messagesIn(harness, "INBOX")).toHaveLength(1)

    const ops = await pendingOps(harness)
    expect(ops.map((op) => op.op_type)).toEqual(["trash"])
    expect(JSON.parse(ops[0]?.payload_json ?? "{}")).toMatchObject({
      refs: [{ folder: "INBOX", uid: 1 }],
    })
  })

  it("a mark-as-spam rule moves the message to the junk folder and never notifies", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    harness.addFolder("Junk", 100, "spam")
    await createRule(harness.executor, {
      accountId: harness.accountId,
      name: "Spam the lottery",
      criteriaQuery: "from:winner@lottery.example",
      actions: [{ type: "mark_as_spam" }],
    })
    await harness.sync()

    inbox.insert({
      flags: [],
      messageId: "<w1@x>",
      subject: "Claim your prize",
      fromEmail: "winner@lottery.example",
      date: 1000,
    })
    inbox.insert({
      flags: [],
      messageId: "<k1@x>",
      subject: "Keep",
      fromEmail: "a@x.com",
      date: 2000,
    })

    const summary = await harness.sync()

    // The ruled message does not announce; the plain one does.
    expect(summary.newMessages).toBe(1)
    const spammed = await messagesIn(harness, "Junk")
    expect(spammed).toHaveLength(1)
    expect(
      await threadFlags(harness, spammed[0]?.thread_id as string)
    ).toMatchObject({ is_spam: 1 })
    expect(await messagesIn(harness, "INBOX")).toHaveLength(1)

    // The spam placement queues the imap move op (junk folder by role),
    // addressing the server-side location the message arrived at.
    const ops = await pendingOps(harness)
    expect(ops.map((op) => op.op_type)).toEqual(["move"])
    expect(JSON.parse(ops[0]?.payload_json ?? "{}")).toMatchObject({
      destinationFolder: "Junk",
      refs: [{ folder: "INBOX", uid: 1 }],
    })
  })
})

// ---------------------------------------------------------------------------
// Sender stats (task 13.1, design D7): the ingestion hook flow's stats
// consumer must accumulate per-sender rows from what the engine stored.
// ---------------------------------------------------------------------------

describe("imap sync sender stats", () => {
  let harness: TestHarness

  beforeEach(async () => {
    harness = await createHarness()
  })

  afterEach(() => {
    harness.executor.close()
  })

  it("accumulates reply/direct/list signals per sender for new messages", async () => {
    const inbox = harness.addFolder("INBOX", 1, "inbox")
    const me = (
      await harness.executor.select<{ email: string }>(
        "SELECT email FROM accounts WHERE id = $1",
        [harness.accountId]
      )
    )[0]?.email as string

    inbox.insert({
      flags: [],
      subject: "Hello",
      fromEmail: "Alice@X.com",
      toEmails: [me],
      date: 100,
    })
    // The account's own reply in the same thread flips participation on
    // for the thread's events (and records no row of its own).
    inbox.insert({
      flags: [],
      subject: "Re: Hello",
      fromEmail: me,
      date: 150,
    })
    // The bracketed subject prefix stands in for List-Id/Precedence.
    inbox.insert({
      flags: [],
      subject: "[announce] Release 1.0",
      fromEmail: "news@lists.dev",
      date: 200,
    })

    await harness.sync()

    const rows = await harness.executor.select<{
      sender: string
      reply_count: number
      direct_to_me_count: number
      is_mailing_list: number
      last_message_at: number | null
    }>(
      `SELECT sender, reply_count, direct_to_me_count, is_mailing_list,
              last_message_at
       FROM sender_stats WHERE account_id = $1 ORDER BY sender`,
      [harness.accountId]
    )
    expect(rows).toEqual([
      {
        sender: "alice@x.com", // lowercased key
        // The thread carries the account's own message (participation),
        // though Alice's own subject has no Re:.
        reply_count: 1,
        direct_to_me_count: 1, // to: me
        is_mailing_list: 0,
        last_message_at: 100,
      },
      {
        sender: "news@lists.dev",
        reply_count: 0,
        direct_to_me_count: 0,
        is_mailing_list: 1, // "[announce]" subject prefix
        last_message_at: 200,
      },
      // No row for the account's own address.
    ])
  })
})

// ---------------------------------------------------------------------------
// Blocked senders (task 18.2): the ingestion hook flow's FIFTH consumer on
// the imap surface — a blocklist row files the sender's new message (mark
// read + trash via the block-time action) and keeps it unannounced.
// ---------------------------------------------------------------------------

describe("imap sync blocked senders", () => {
  let harness: TestHarness

  beforeEach(async () => {
    harness = await createHarness()
  })

  afterEach(() => {
    harness.executor.close()
  })

  async function threadFlagsById(
    threadRowId: string
  ): Promise<{ is_trashed: number; unread_count: number }> {
    const rows = await harness.executor.select<{
      is_trashed: number
      unread_count: number
    }>("SELECT is_trashed, unread_count FROM threads WHERE id = $1", [
      threadRowId,
    ])
    return rows[0]!
  }

  async function pendingOps(): Promise<
    { op_type: string; payload_json: string }[]
  > {
    return harness.executor.select(
      `SELECT op_type, payload_json FROM pending_operations
       WHERE account_id = $1 ORDER BY seq ASC`,
      [harness.accountId]
    )
  }

  it("a blocked sender's new message is marked read, trashed and never counted", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    harness.addFolder("Trash", 100, "trash")
    await blockSender(harness.executor, harness.accountId, {
      sender: "spam@x.com",
      action: "trash",
    })
    // Seed the cursors first: the blocked mail below is an arrival, and a
    // folder's first sync never announces anything.
    await harness.sync()

    inbox.insert({
      flags: [],
      messageId: "<s1@x>",
      subject: "Buy now",
      fromEmail: "spam@x.com",
      date: 1000,
    })
    inbox.insert({
      flags: [],
      messageId: "<k1@x>",
      subject: "Keep",
      fromEmail: "a@x.com",
      date: 2000,
    })

    const summary = await harness.sync()

    expect(summary.newMessages).toBe(1)
    const trashed = await messagesIn(harness, "Trash")
    expect(trashed).toHaveLength(1)
    expect(
      await threadFlagsById(trashed[0]?.thread_id as string)
    ).toMatchObject({ is_trashed: 1, unread_count: 0 })
    expect(await messagesIn(harness, "INBOX")).toHaveLength(1)

    // mark_read (spec: blocked mail is marked as read) then the trash move.
    const ops = await pendingOps()
    expect(ops.map((op) => op.op_type)).toEqual(["mark_read", "trash"])
  })

  it("unblocking restores the normal inbox arrival", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    harness.addFolder("Trash", 100, "trash")
    await blockSender(harness.executor, harness.accountId, {
      sender: "spam@x.com",
      action: "trash",
    })
    await harness.sync()
    const [row] = await listBlockedSenders(harness.executor, harness.accountId)
    await unblockSender(harness.executor, row!.id)

    inbox.insert({
      flags: [],
      messageId: "<s1@x>",
      subject: "Hello again",
      fromEmail: "spam@x.com",
      date: 1000,
    })

    const summary = await harness.sync()

    // The spec's Unblock scenario: after removal the sender's mail arrives
    // normally — unread, in the inbox, nothing queued against it.
    expect(summary.newMessages).toBe(1)
    expect(await messagesIn(harness, "INBOX")).toHaveLength(1)
    expect(await messagesIn(harness, "Trash")).toHaveLength(0)
    expect(await pendingOps()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Local junk filter (task 18.10, design D19): the engine preloads the
// per-account config once per folder pass and the hook's auto-move files
// high-confidence mail into the spam-role folder, unannounced.
// ---------------------------------------------------------------------------

describe("imap sync junk filter", () => {
  let harness: TestHarness

  beforeEach(async () => {
    harness = await createHarness()
  })

  afterEach(() => {
    harness.executor.close()
  })

  async function pendingOps(): Promise<
    { op_type: string; payload_json: string }[]
  > {
    return harness.executor.select(
      `SELECT op_type, payload_json FROM pending_operations
       WHERE account_id = $1 ORDER BY seq ASC`,
      [harness.accountId]
    )
  }

  async function threadFlags(threadId: string) {
    const rows = await harness.executor.select<{ is_spam: number }>(
      "SELECT is_spam FROM threads WHERE id = $1",
      [threadId]
    )
    return rows[0]
  }

  const SPAM_BODY = "buy cheap pills now winner"

  it("auto-moves trained high-confidence mail to Junk and never announces it", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    harness.addFolder("Junk", 200, "spam")
    // Train through the REAL store until the D19 sample gate is met, and
    // flip the per-account toggle on.
    for (let i = 0; i < 50; i += 1) {
      await trainJunkDocument(
        harness.executor,
        harness.accountId,
        SPAM_BODY,
        true
      )
    }
    await setJunkFilterEnabledPreference(
      harness.executor,
      harness.accountId,
      true
    )
    // Seed the cursors first: a folder's first sync never announces.
    await harness.sync()

    inbox.insert({
      flags: [],
      messageId: "<j1@x>",
      subject: "Claim your prize",
      fromEmail: "winner@lottery.example",
      date: 1000,
      textBody: SPAM_BODY,
    })
    inbox.insert({
      flags: [],
      messageId: "<k1@x>",
      subject: "Notes",
      fromEmail: "peer@x.com",
      date: 2000,
      textBody: "meeting notes from the project review",
    })

    const summary = await harness.sync()

    // Only the delivered-normally message reaches the announcement count.
    expect(summary.newMessages).toBe(1)
    const junked = await messagesIn(harness, "Junk")
    expect(junked).toHaveLength(1)
    expect(await threadFlags(junked[0]?.thread_id as string)).toMatchObject({
      is_spam: 1,
    })
    expect(await messagesIn(harness, "INBOX")).toHaveLength(1)

    // The auto-move is the markSpam placement MINUS training (D19): one
    // move op, and the token store is exactly as the training left it.
    const ops = await pendingOps()
    expect(ops.map((op) => op.op_type)).toEqual(["move"])
    expect(JSON.parse(ops[0]?.payload_json ?? "{}")).toMatchObject({
      destinationFolder: "Junk",
      refs: [{ folder: "INBOX", uid: 1 }],
    })
  })

  it("with the toggle off the same mail delivers normally", async () => {
    const inbox = harness.addFolder("INBOX", 100, "inbox")
    harness.addFolder("Junk", 200, "spam")
    for (let i = 0; i < 50; i += 1) {
      await trainJunkDocument(
        harness.executor,
        harness.accountId,
        SPAM_BODY,
        true
      )
    }
    // No setJunkFilterEnabledPreference — the default-off account.
    await harness.sync()

    inbox.insert({
      flags: [],
      messageId: "<j1@x>",
      subject: "Claim your prize",
      fromEmail: "winner@lottery.example",
      date: 1000,
      textBody: SPAM_BODY,
    })

    const summary = await harness.sync()

    expect(summary.newMessages).toBe(1)
    expect(await messagesIn(harness, "INBOX")).toHaveLength(1)
    expect(await messagesIn(harness, "Junk")).toHaveLength(0)
    expect(await pendingOps()).toEqual([])
  })
})
