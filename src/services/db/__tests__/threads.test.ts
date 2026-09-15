import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  at,
  createAccount,
  createGmailLabel,
  createImapFolderLabel,
  createMessage,
  createThread,
} from "./fixtures"
import { createTestExecutor, type TestExecutor } from "./test-executor"
import {
  getLabelsForThreads,
  getThread,
  getThreadWithMessages,
  listThreadsByFolder,
  recomputeThreadCaches,
  setThreadFolder,
  setThreadLabels,
  setThreadStarred,
  upsertThreadByGmailId,
} from "../threads"
import { markMessagesRead } from "../messages"

describe("thread cache recompute", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
  })

  afterEach(() => {
    executor.close()
  })

  it("rebuilds counts, attachment flag, dates and newest snippet", async () => {
    const threadId = await createThread(executor, accountId)
    const m1 = await createMessage(executor, {
      threadId,
      accountId,
      date: at(0),
      snippet: "oldest words",
      isRead: true,
    })
    const m2 = await createMessage(executor, {
      threadId,
      accountId,
      date: at(100),
      snippet: "middle words",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: at(200),
      snippet: "latest words",
      hasAttachments: true,
      attachments: [{ id: "att-1", filename: "report.pdf", size: 2048 }],
    })

    await recomputeThreadCaches(executor, threadId)
    const thread = await getThread(executor, threadId)
    expect(thread).toMatchObject({
      message_count: 3,
      unread_count: 2,
      has_attachments: 1,
      first_message_at: at(0),
      last_message_at: at(200),
      snippet: "latest words",
    })

    // flag changes flow into the unread cache on the next recompute;
    // m3 was never marked, so exactly one unread remains
    await markMessagesRead(executor, [m1, m2])
    await recomputeThreadCaches(executor, threadId)
    expect((await getThread(executor, threadId))?.unread_count).toBe(1)
  })

  it("tracks a new newest message and zeroes out when emptied", async () => {
    const threadId = await createThread(executor, accountId)
    await createMessage(executor, {
      threadId,
      accountId,
      date: at(0),
      snippet: "only words",
    })
    await recomputeThreadCaches(executor, threadId)

    const newer = await createMessage(executor, {
      threadId,
      accountId,
      date: at(300),
      snippet: "newest words",
    })
    await recomputeThreadCaches(executor, threadId)
    let thread = await getThread(executor, threadId)
    expect(thread).toMatchObject({
      message_count: 2,
      last_message_at: at(300),
      snippet: "newest words",
    })

    await executor.execute("DELETE FROM messages WHERE id = $1", [newer])
    await executor.execute("DELETE FROM messages WHERE thread_id = $1", [
      threadId,
    ])
    await recomputeThreadCaches(executor, threadId)
    thread = await getThread(executor, threadId)
    expect(thread).toMatchObject({
      message_count: 0,
      unread_count: 0,
      has_attachments: 0,
      first_message_at: null,
      last_message_at: null,
      snippet: null,
    })
  })
})

describe("participants cache (migration v2)", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
  })

  afterEach(() => {
    executor.close()
  })

  it("fresh threads start with a NULL participants column", async () => {
    const threadId = await createThread(executor, accountId)
    expect((await getThread(executor, threadId))?.participants).toBeNull()
  })

  it("recompute caches the newest message's from plus up to two unique to's", async () => {
    const threadId = await createThread(executor, accountId)
    await createMessage(executor, {
      threadId,
      accountId,
      date: at(0),
      fromName: "Old Sender",
      fromAddress: "old@example.com",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: at(100),
      fromName: "Alice",
      fromAddress: "alice@example.com",
      to: [
        { name: "Bob", email: "bob@example.com" },
        { email: "alice@example.com" },
        { email: "carol@example.com" },
        { email: "dave@example.com" },
      ],
    })
    await recomputeThreadCaches(executor, threadId)
    const thread = await getThread(executor, threadId)
    // from first, then unique to's in order capped at two; the sender's own
    // address among the to's is dropped.
    expect(JSON.parse(thread?.participants ?? "null")).toEqual([
      { name: "Alice", email: "alice@example.com" },
      { name: "Bob", email: "bob@example.com" },
      { email: "carol@example.com" },
    ])
  })

  it("caches NULL when the newest message has no usable contacts", async () => {
    const threadId = await createThread(executor, accountId)
    await createMessage(executor, {
      threadId,
      accountId,
      date: at(0),
      snippet: "s",
    })
    await recomputeThreadCaches(executor, threadId)
    expect((await getThread(executor, threadId))?.participants).toBeNull()
  })

  it("getLabelsForThreads batch-groups user label chips per thread", async () => {
    const inbox = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const work = await createGmailLabel(
      executor,
      accountId,
      "Work",
      "Label_work",
      undefined,
      "user"
    )
    const threadA = await createThread(executor, accountId)
    const threadB = await createThread(executor, accountId)
    await setThreadLabels(executor, threadA, [inbox, work])
    await setThreadLabels(executor, threadB, [inbox])

    const labels = await getLabelsForThreads(executor, accountId, [
      threadA,
      threadB,
    ])
    // System labels are folders, not chips — only user labels come back.
    expect(labels.get(threadA)).toEqual([
      { id: work, name: "Work", color: null },
    ])
    expect(labels.has(threadB)).toBe(false)
  })
})

describe("setThreadLabels derives gmail folder caches", () => {
  let executor: TestExecutor
  let accountId: string
  let inboxLabelId: string
  let trashLabelId: string
  let spamLabelId: string
  let workLabelId: string
  let threadId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
    inboxLabelId = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    trashLabelId = await createGmailLabel(
      executor,
      accountId,
      "TRASH",
      "TRASH",
      "trash"
    )
    spamLabelId = await createGmailLabel(
      executor,
      accountId,
      "SPAM",
      "SPAM",
      "spam"
    )
    workLabelId = await createGmailLabel(
      executor,
      accountId,
      "Work",
      "Label_work",
      undefined,
      "user"
    )
    threadId = await createThread(executor, accountId, {
      subject: "State test",
    })
  })

  afterEach(() => {
    executor.close()
  })

  it("absent inbox label means archived; trash and spam win", async () => {
    await setThreadLabels(executor, threadId, [inboxLabelId])
    expect(await getThread(executor, threadId)).toMatchObject({
      is_archived: 0,
      is_trashed: 0,
      is_spam: 0,
    })

    // removed from inbox only → archived
    await setThreadLabels(executor, threadId, [workLabelId])
    expect(await getThread(executor, threadId)).toMatchObject({
      is_archived: 1,
      is_trashed: 0,
      is_spam: 0,
    })

    await setThreadLabels(executor, threadId, [trashLabelId])
    expect(await getThread(executor, threadId)).toMatchObject({
      is_trashed: 1,
      is_archived: 0,
    })

    await setThreadLabels(executor, threadId, [spamLabelId])
    expect(await getThread(executor, threadId)).toMatchObject({
      is_spam: 1,
      is_archived: 0,
      is_trashed: 0,
    })

    // inbox + user label → still in the mailbox
    await setThreadLabels(executor, threadId, [inboxLabelId, workLabelId])
    expect(await getThread(executor, threadId)).toMatchObject({
      is_archived: 0,
    })

    // no labels at all → not in inbox → archived (gmail semantics)
    await setThreadLabels(executor, threadId, [])
    expect(await getThread(executor, threadId)).toMatchObject({
      is_archived: 1,
      is_trashed: 0,
      is_spam: 0,
    })
  })

  it("replaces membership and is readable via getThreadWithMessages", async () => {
    await setThreadLabels(executor, threadId, [inboxLabelId, workLabelId])
    await setThreadLabels(executor, threadId, [workLabelId])
    const withMessages = await getThreadWithMessages(executor, threadId)
    expect(withMessages?.labelIds).toEqual([workLabelId])
  })
})

describe("listThreadsByFolder with gmail-style fixtures", () => {
  let executor: TestExecutor
  let accountId: string
  let inbox: string
  let trash: string
  let spam: string
  let work: string
  // newest → oldest expected overall order: starred, archived, inInbox
  let inInbox: string
  let archived: string
  let trashed: string
  let spammed: string
  let starred: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
    inbox = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    trash = await createGmailLabel(
      executor,
      accountId,
      "TRASH",
      "TRASH",
      "trash"
    )
    spam = await createGmailLabel(executor, accountId, "SPAM", "SPAM", "spam")
    work = await createGmailLabel(
      executor,
      accountId,
      "Work",
      "Label_work",
      undefined,
      "user"
    )

    async function seed(
      labels: string[],
      date: number,
      options?: { starred?: boolean; unread?: boolean }
    ): Promise<string> {
      const threadId = await createThread(executor, accountId)
      await createMessage(executor, {
        threadId,
        accountId,
        date,
        snippet: "s",
        isRead: !options?.unread,
      })
      await setThreadLabels(executor, threadId, labels)
      await recomputeThreadCaches(executor, threadId)
      if (options?.starred) {
        await setThreadStarred(executor, threadId)
      }
      return threadId
    }

    inInbox = await seed([inbox], at(100), { unread: true })
    archived = await seed([work], at(300))
    trashed = await seed([trash], at(200))
    spammed = await seed([spam], at(400))
    starred = await seed([inbox], at(500), { starred: true })
  })

  afterEach(() => {
    executor.close()
  })

  it("lists inbox threads newest first, with unread counts", async () => {
    const rows = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "inbox" },
    })
    expect(rows.map((thread) => thread.id)).toEqual([starred, inInbox])
    expect(rows.map((thread) => thread.unread_count)).toEqual([0, 1])
  })

  it("routes archive, trash, spam and starred folders", async () => {
    const archive = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "archive" },
    })
    expect(archive.map((thread) => thread.id)).toEqual([archived])

    const trashFolder = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "trash" },
    })
    expect(trashFolder.map((thread) => thread.id)).toEqual([trashed])

    const spamFolder = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "spam" },
    })
    expect(spamFolder.map((thread) => thread.id)).toEqual([spammed])

    const starredFolder = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "starred" },
    })
    expect(starredFolder.map((thread) => thread.id)).toEqual([starred])
  })

  it("'all' excludes trash and spam but keeps archived", async () => {
    const rows = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "all" },
    })
    expect(rows.map((thread) => thread.id)).toEqual([
      starred,
      archived,
      inInbox,
    ])
  })

  it("supports limit and label-driven folder selection", async () => {
    const limited = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "all" },
      limit: 2,
    })
    expect(limited.map((thread) => thread.id)).toEqual([starred, archived])

    const workFolder = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "labelId", labelId: work },
    })
    expect(workFolder.map((thread) => thread.id)).toEqual([archived])

    const inboxFolder = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "specialUse", specialUse: "inbox" },
    })
    expect(inboxFolder.map((thread) => thread.id)).toEqual([starred, inInbox])

    const trashFolder = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "specialUse", specialUse: "trash" },
    })
    expect(trashFolder.map((thread) => thread.id)).toEqual([trashed])
  })

  it("upsertThreadByGmailId reuses the server thread id", async () => {
    const gmailThreadId = "gt-1"
    const first = await upsertThreadByGmailId(executor, {
      id: "new-thread-1",
      accountId,
      gmailThreadId,
      subject: "Original subject",
    })
    expect(first).toEqual({ id: "new-thread-1", created: true })

    const second = await upsertThreadByGmailId(executor, {
      id: "other-app-id",
      accountId,
      gmailThreadId,
      subject: "Refreshed subject",
    })
    expect(second).toEqual({ id: "new-thread-1", created: false })
    const thread = await getThread(executor, "new-thread-1")
    expect(thread?.subject).toBe("Refreshed subject")
    expect(thread?.gmail_thread_id).toBe(gmailThreadId)
  })
})

describe("listThreadsByFolder with imap-style fixtures", () => {
  let executor: TestExecutor
  let accountId: string
  let inboxFolder: string
  let archiveFolder: string
  let trashFolder: string
  let workFolder: string
  let inInbox: string
  let inArchive: string
  let inTrash: string
  let inWork: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "imap")
    inboxFolder = await createImapFolderLabel(
      executor,
      accountId,
      "INBOX",
      "inbox"
    )
    archiveFolder = await createImapFolderLabel(
      executor,
      accountId,
      "Archive",
      "archive"
    )
    trashFolder = await createImapFolderLabel(
      executor,
      accountId,
      "Trash",
      "trash"
    )
    workFolder = await createImapFolderLabel(executor, accountId, "Work")

    async function seed(
      folderLabelId: string,
      folderName: string,
      date: number
    ): Promise<string> {
      const threadId = await createThread(executor, accountId)
      await createMessage(executor, {
        threadId,
        accountId,
        date,
        snippet: "s",
        imapFolder: folderName,
        imapUid: date,
      })
      await setThreadFolder(executor, threadId, folderLabelId)
      await recomputeThreadCaches(executor, threadId)
      return threadId
    }

    inInbox = await seed(inboxFolder, "INBOX", at(100))
    inArchive = await seed(archiveFolder, "Archive", at(300))
    inTrash = await seed(trashFolder, "Trash", at(200))
    inWork = await seed(workFolder, "Work", at(400))
  })

  afterEach(() => {
    executor.close()
  })

  it("resolves presets through the folder label role", async () => {
    const inbox = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "inbox" },
    })
    expect(inbox.map((thread) => thread.id)).toEqual([inInbox])

    const archive = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "archive" },
    })
    expect(archive.map((thread) => thread.id)).toEqual([inArchive])

    const trash = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "trash" },
    })
    expect(trash.map((thread) => thread.id)).toEqual([inTrash])
  })

  it("lists a custom folder by labelId; filed threads are not archived", async () => {
    const work = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "labelId", labelId: workFolder },
    })
    expect(work.map((thread) => thread.id)).toEqual([inWork])
    expect(work[0]).toMatchObject({
      is_archived: 0,
      is_trashed: 0,
      is_spam: 0,
      folder_label_id: workFolder,
    })
  })

  it("moving a thread between folders updates its caches", async () => {
    await setThreadFolder(executor, inWork, archiveFolder)
    const thread = await getThread(executor, inWork)
    expect(thread).toMatchObject({
      folder_label_id: archiveFolder,
      is_archived: 1,
    })

    const archive = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "labelId", labelId: archiveFolder },
    })
    expect(archive.map((row) => row.id)).toEqual([inWork, inArchive])
  })
})
