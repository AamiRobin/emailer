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
  listRecentThreadsByParticipant,
  listThreadsAcrossAccounts,
  listThreadsByFolder,
  recomputeThreadCaches,
  setThreadFolder,
  setThreadLabels,
  setThreadStarred,
  upsertThreadByGmailId,
} from "../threads"
import { markMessagesRead } from "../messages"
import { snoozeThread, wakeDueThreads } from "../../email-actions/snooze"
import {
  markThreadDone,
  muteThread,
  pinThread,
  unmarkThreadDone,
  unmuteThread,
} from "../../email-actions/thread-states"

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

describe("snoozed threads: inbox exclusion and wake ordering (tasks 2.2/2.5)", () => {
  let executor: TestExecutor
  let accountId: string
  let inbox: string
  let older: string
  let newer: string

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

    async function seed(date: number): Promise<string> {
      const threadId = await createThread(executor, accountId)
      await createMessage(executor, {
        threadId,
        accountId,
        date,
        snippet: "s",
        isRead: true,
      })
      await setThreadLabels(executor, threadId, [inbox])
      await recomputeThreadCaches(executor, threadId)
      return threadId
    }

    older = await seed(at(100))
    newer = await seed(at(500))
  })

  afterEach(() => {
    executor.close()
  })

  it("the inbox list hides a snoozed thread; other folders keep showing it", async () => {
    await snoozeThread(executor, older, at(2000))

    const inboxRows = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "inbox" },
    })
    expect(inboxRows.map((thread) => thread.id)).toEqual([newer])

    // Non-inbox folders are NOT affected by snooze (spec: snoozed mail
    // stays visible in All Mail / its labels, and search is untouched).
    const allRows = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "all" },
    })
    expect(allRows.map((thread) => thread.id)).toEqual([newer, older])
  })

  it("after wakeDueThreads the thread is back, ordered FIRST via delivered_at", async () => {
    await snoozeThread(executor, older, at(2000))

    // Wake-up time passes (launch sweep or scheduled due pass).
    expect(await wakeDueThreads(executor, at(3000))).toBe(1)

    const rows = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "specialUse", specialUse: "inbox" },
    })
    // The woken thread tops the inbox even though its last_message_at is
    // the older one — delivered_at wins the COALESCE ordering.
    expect(rows.map((thread) => thread.id)).toEqual([older, newer])
    expect((await getThread(executor, older))?.delivered_at).toBe(at(3000))
    expect((await getThread(executor, older))?.snoozed_until).toBeNull()
  })
})

describe("muted and Done threads: inbox exclusion (tasks 3.1/3.2)", () => {
  let executor: TestExecutor
  let accountId: string
  let inbox: string
  let older: string
  let newer: string

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

    async function seed(date: number): Promise<string> {
      const threadId = await createThread(executor, accountId)
      await createMessage(executor, {
        threadId,
        accountId,
        date,
        snippet: "s",
        isRead: true,
      })
      await setThreadLabels(executor, threadId, [inbox])
      await recomputeThreadCaches(executor, threadId)
      return threadId
    }

    older = await seed(at(100))
    newer = await seed(at(500))
  })

  afterEach(() => {
    executor.close()
  })

  it("the inbox list hides a muted thread; All Mail keeps showing it; unmute restores it", async () => {
    await muteThread(executor, older)

    const inboxRows = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "inbox" },
    })
    expect(inboxRows.map((thread) => thread.id)).toEqual([newer])

    // Mute is inbox-only: All Mail (and labels/search) keep the thread.
    const allRows = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "all" },
    })
    expect(allRows.map((thread) => thread.id)).toEqual([newer, older])

    await unmuteThread(executor, older)
    const restored = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "inbox" },
    })
    expect(restored.map((thread) => thread.id)).toEqual([newer, older])
  })

  it("the inbox list hides a Done thread (without flipping is_archived); undo restores it", async () => {
    await markThreadDone(executor, older)

    const inboxRows = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "specialUse", specialUse: "inbox" },
    })
    expect(inboxRows.map((thread) => thread.id)).toEqual([newer])
    // Done is a distinct local state, not an archive write.
    expect((await getThread(executor, older))?.is_archived).toBe(0)

    const allRows = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "all" },
    })
    expect(allRows.map((thread) => thread.id)).toEqual([newer, older])

    await unmarkThreadDone(executor, older)
    const restored = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "specialUse", specialUse: "inbox" },
    })
    expect(restored.map((thread) => thread.id)).toEqual([newer, older])
  })
})

describe("listThreadsByFolder sort options (task 4.1)", () => {
  let executor: TestExecutor
  let accountId: string
  let inbox: string
  // ids for the order assertions; seeded so every option separates them.
  let zedOld: string // A — date 100, "Zed", "Mango", unread
  let alice: string //  B — date 200, "alice", "apple", unread
  let pinnedBob: string // C — date 300, no name (bob@…), "Cherry", PINNED
  let zedNew: string // D — date 400, "Zed", "banana", read
  let martha: string // E — date 500, "martha", "Apple", unread
  let anonymous: string // F — date 50, no sender, no subject, read

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

    async function seed(
      date: number,
      options?: {
        fromName?: string
        fromAddress?: string
        subject?: string
        unread?: boolean
      }
    ): Promise<string> {
      const threadId = await createThread(executor, accountId, {
        subject: options?.subject,
      })
      await createMessage(executor, {
        threadId,
        accountId,
        date,
        subject: options?.subject,
        snippet: "s",
        fromName: options?.fromName,
        fromAddress: options?.fromAddress,
        isRead: !options?.unread,
      })
      await setThreadLabels(executor, threadId, [inbox])
      await recomputeThreadCaches(executor, threadId)
      return threadId
    }

    zedOld = await seed(at(100), {
      fromName: "Zed",
      fromAddress: "zed@x.com",
      subject: "Mango",
      unread: true,
    })
    alice = await seed(at(200), {
      fromName: "alice",
      fromAddress: "alice@x.com",
      subject: "apple",
      unread: true,
    })
    pinnedBob = await seed(at(300), {
      fromAddress: "bob@x.com",
      subject: "Cherry",
    })
    zedNew = await seed(at(400), {
      fromName: "Zed",
      fromAddress: "zed@x.com",
      subject: "banana",
    })
    martha = await seed(at(500), {
      fromName: "martha",
      fromAddress: "martha@x.com",
      subject: "Apple",
      unread: true,
    })
    anonymous = await seed(at(50))
    await pinThread(executor, pinnedBob)
  })

  afterEach(() => {
    executor.close()
  })

  it("date_desc keeps the historical newest-first order", async () => {
    const rows = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "inbox" },
      sort: "date_desc",
    })
    expect(rows.map((thread) => thread.id)).toEqual([
      pinnedBob,
      martha,
      zedNew,
      alice,
      zedOld,
      anonymous,
    ])
  })

  it("date_asc flips the inbox date term (the delivered_at COALESCE)", async () => {
    const rows = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "inbox" },
      sort: "date_asc",
    })
    expect(rows.map((thread) => thread.id)).toEqual([
      pinnedBob,
      anonymous,
      zedOld,
      alice,
      zedNew,
      martha,
    ])
  })

  it("sender sorts A→Z by the newest sender name (email fallback, NULLs last)", async () => {
    const rows = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "inbox" },
      sort: "sender",
    })
    // alice < bob@x.com (C's name-less email fallback) < martha < zed
    // (tie between the two Zed threads broken by date DESC), the
    // sender-less thread last. Pinned C still leads.
    expect(rows.map((thread) => thread.id)).toEqual([
      pinnedBob,
      alice,
      martha,
      zedNew,
      zedOld,
      anonymous,
    ])
  })

  it("a corrupt participants cache sorts last instead of failing the query", async () => {
    // json_extract raises "malformed JSON" on this row — the guarded
    // sender term must degrade it to NULL (the sender-less group), not
    // fail the whole inbox query.
    await executor.execute(
      "UPDATE threads SET participants = 'not json' WHERE id = $1",
      [martha]
    )

    const rows = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "inbox" },
      sort: "sender",
    })
    // martha joins the NULL-sender group ordered by the date fallback
    // (date 500 > anonymous's 50), still a total deterministic order.
    expect(rows.map((thread) => thread.id)).toEqual([
      pinnedBob,
      alice,
      zedNew,
      zedOld,
      martha,
      anonymous,
    ])
  })

  it("subject sorts A→Z case-insensitively with a date-desc stability fallback", async () => {
    const rows = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "inbox" },
      sort: "subject",
    })
    // "apple" (E and B tie → date DESC: E first), "banana", "mango", the
    // subject-less thread last. Pinned C still leads.
    expect(rows.map((thread) => thread.id)).toEqual([
      pinnedBob,
      martha,
      alice,
      zedNew,
      zedOld,
      anonymous,
    ])
  })

  it("unread_first groups unread above read, date-desc within each group", async () => {
    const rows = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "inbox" },
      sort: "unread_first",
    })
    expect(rows.map((thread) => thread.id)).toEqual([
      pinnedBob,
      martha,
      alice,
      zedOld,
      zedNew,
      anonymous,
    ])
  })

  it("the pinned thread leads EVERY option, also through specialUse selection", async () => {
    for (const sort of [
      "date_desc",
      "date_asc",
      "sender",
      "subject",
      "unread_first",
    ] as const) {
      const rows = await listThreadsByFolder(executor, {
        accountId,
        folder: { kind: "specialUse", specialUse: "inbox" },
        sort,
      })
      expect(rows[0]?.id).toBe(pinnedBob)
      expect(rows[0]?.pinned_at).not.toBeNull()
    }
  })

  it("a woken thread's delivered_at joins the COALESCE under date_asc too", async () => {
    await snoozeThread(executor, anonymous, at(2000))
    expect(await wakeDueThreads(executor, at(3000))).toBe(1)

    const rows = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "inbox" },
      sort: "date_asc",
    })
    // delivered_at = at(3000) replaces last_message_at = at(50) in the
    // COALESCE, so the woken thread moves from oldest to newest under ASC.
    expect(rows.map((thread) => thread.id)).toEqual([
      pinnedBob,
      zedOld,
      alice,
      zedNew,
      martha,
      anonymous,
    ])
  })
})

describe("listThreadsAcrossAccounts (task 9.1)", () => {
  let executor: TestExecutor
  let accountA: string
  let accountB: string
  let inboxA: string
  let inboxB: string
  let trashA: string
  let spamA: string
  // Expected unified-inbox order: pinned first, then newest across accounts.
  let pinnedA: string
  let newestB: string
  let midB: string
  let plainA: string
  let snoozedA: string
  let mutedA: string
  let doneA: string
  let trashedA: string
  let spammedA: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountA = await createAccount(executor, "gmail")
    accountB = await createAccount(executor, "imap")
    inboxA = await createGmailLabel(
      executor,
      accountA,
      "INBOX",
      "INBOX",
      "inbox"
    )
    inboxB = await createImapFolderLabel(executor, accountB, "INBOX", "inbox")
    trashA = await createGmailLabel(
      executor,
      accountA,
      "TRASH",
      "TRASH",
      "trash"
    )
    spamA = await createGmailLabel(executor, accountA, "SPAM", "SPAM", "spam")

    async function seed(
      accountId: string,
      inboxLabelId: string,
      date: number,
      labels: string[] = []
    ): Promise<string> {
      const threadId = await createThread(executor, accountId)
      await createMessage(executor, {
        threadId,
        accountId,
        date,
        snippet: "s",
        isRead: true,
      })
      await setThreadLabels(executor, threadId, [inboxLabelId, ...labels])
      await recomputeThreadCaches(executor, threadId)
      return threadId
    }

    pinnedA = await seed(accountA, inboxA, at(100))
    await pinThread(executor, pinnedA)
    newestB = await seed(accountB, inboxB, at(300))
    midB = await seed(accountB, inboxB, at(200))
    plainA = await seed(accountA, inboxA, at(100))
    snoozedA = await seed(accountA, inboxA, at(400))
    await snoozeThread(executor, snoozedA, at(9999))
    mutedA = await seed(accountA, inboxA, at(350))
    await muteThread(executor, mutedA)
    doneA = await seed(accountA, inboxA, at(250))
    await markThreadDone(executor, doneA)
    trashedA = await seed(accountA, inboxA, at(150), [trashA])
    spammedA = await seed(accountA, inboxA, at(120), [spamA])
  })

  afterEach(() => {
    executor.close()
  })

  it("returns the preset inbox across accounts: exclusions applied, pinned first", async () => {
    const rows = await listThreadsAcrossAccounts(executor, {
      accountIds: [accountA, accountB],
      folder: { kind: "preset", preset: "inbox" },
    })
    // Snoozed/muted/done leave the list (inbox-only exclusions), and the
    // trashed/spam seeds carry the inbox label too, so their exclusion
    // exercises the preset's is_trashed/is_spam predicates.
    expect(rows.map((thread) => thread.id)).toEqual([
      pinnedA,
      newestB,
      midB,
      plainA,
    ])
    // Every row carries its account identity (design D4) and belongs to
    // the requested set.
    expect(rows.map((thread) => thread.account_id)).toEqual([
      accountA,
      accountB,
      accountB,
      accountA,
    ])
  })

  it("resolves the inbox role through both account models (gmail + imap)", async () => {
    const rows = await listThreadsAcrossAccounts(executor, {
      accountIds: [accountA, accountB],
      folder: { kind: "preset", preset: "inbox" },
    })
    expect(new Set(rows.map((thread) => thread.account_id))).toEqual(
      new Set([accountA, accountB])
    )
  })

  it("restricts to the given account subset", async () => {
    const rows = await listThreadsAcrossAccounts(executor, {
      accountIds: [accountB],
      folder: { kind: "preset", preset: "inbox" },
    })
    expect(rows.map((thread) => thread.id)).toEqual([newestB, midB])
    expect(rows.every((thread) => thread.account_id === accountB)).toBe(true)
  })

  it("treats an empty/omitted account set as every account", async () => {
    const empty = await listThreadsAcrossAccounts(executor, {
      accountIds: [],
      folder: { kind: "preset", preset: "inbox" },
    })
    const omitted = await listThreadsAcrossAccounts(executor, {
      folder: { kind: "preset", preset: "inbox" },
    })
    const expected = [pinnedA, newestB, midB, plainA]
    expect(empty.map((thread) => thread.id)).toEqual(expected)
    expect(omitted.map((thread) => thread.id)).toEqual(expected)
  })

  it("composes the preset's trash/spam exclusions into the specialUse inbox", async () => {
    // The specialUse inbox is the same inbox view as the preset: gmail
    // local trash (addSpecialLabel) keeps the INBOX membership, so the
    // selector itself must exclude the trashed/spammed seeds — identical
    // to the preset path (and the inbox badge).
    const rows = await listThreadsAcrossAccounts(executor, {
      accountIds: [accountA, accountB],
      folder: { kind: "specialUse", specialUse: "inbox" },
    })
    expect(rows.map((thread) => thread.id)).toEqual([
      pinnedA,
      newestB,
      midB,
      plainA,
    ])
  })

  it("a locally trashed inbox thread leaves both inbox lists and stays in Trash", async () => {
    // trashedA carries the inbox-role label AND the trash label, so
    // setThreadLabels flagged it locally trashed while keeping its INBOX
    // membership — exactly the row the raw specialUse selector leaked.
    // spammedA is the same shape with the spam role.
    const viaSpecialUse = await listThreadsAcrossAccounts(executor, {
      accountIds: [accountA, accountB],
      folder: { kind: "specialUse", specialUse: "inbox" },
    })
    const viaPreset = await listThreadsAcrossAccounts(executor, {
      accountIds: [accountA, accountB],
      folder: { kind: "preset", preset: "inbox" },
    })
    expect(viaSpecialUse.map((thread) => thread.id)).not.toContain(trashedA)
    expect(viaPreset.map((thread) => thread.id)).not.toContain(trashedA)
    expect(viaSpecialUse.map((thread) => thread.id)).not.toContain(spammedA)
    expect(viaPreset.map((thread) => thread.id)).not.toContain(spammedA)

    // Each stays listed in its own folder.
    const trash = await listThreadsAcrossAccounts(executor, {
      accountIds: [accountA],
      folder: { kind: "preset", preset: "trash" },
    })
    expect(trash.map((thread) => thread.id)).toEqual([trashedA])
    const spam = await listThreadsAcrossAccounts(executor, {
      accountIds: [accountA],
      folder: { kind: "preset", preset: "spam" },
    })
    expect(spam.map((thread) => thread.id)).toEqual([spammedA])
  })

  it("returns [] when no account in scope has the special-use role", async () => {
    const rows = await listThreadsAcrossAccounts(executor, {
      accountIds: [accountA, accountB],
      folder: { kind: "specialUse", specialUse: "flagged" },
    })
    expect(rows).toEqual([])
  })

  it("honors limit after the cross-account ordering", async () => {
    const rows = await listThreadsAcrossAccounts(executor, {
      accountIds: [accountA, accountB],
      folder: { kind: "preset", preset: "inbox" },
      limit: 2,
    })
    expect(rows.map((thread) => thread.id)).toEqual([pinnedA, newestB])
  })

  it("orders by the sort clause with the inbox date term", async () => {
    const rows = await listThreadsAcrossAccounts(executor, {
      accountIds: [accountA, accountB],
      folder: { kind: "preset", preset: "inbox" },
      sort: "date_asc",
    })
    // date ASC flips the COALESCE(delivered_at, last_message_at) term; the
    // pinned thread still leads.
    expect(rows.map((thread) => thread.id)).toEqual([
      pinnedA,
      plainA,
      midB,
      newestB,
    ])
  })
})

describe("listRecentThreadsByParticipant (task 2.7)", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
  })

  afterEach(() => {
    executor.close()
  })

  /** A thread whose newest message is from `fromAddress`, with the
   * participants cache populated exactly like ingestion does. */
  async function seedFromSender(options: {
    subject: string
    fromAddress: string
    date: number
  }): Promise<string> {
    const threadId = await createThread(executor, accountId, {
      subject: options.subject,
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: options.date,
      fromName: "Ada Lovelace",
      fromAddress: options.fromAddress,
    })
    await recomputeThreadCaches(executor, threadId)
    return threadId
  }

  it("finds threads by participant email (casing-insensitive), excluding the open thread, newest first", async () => {
    const openId = await seedFromSender({
      subject: "Open thread",
      fromAddress: "ada@example.com",
      date: at(300),
    })
    const olderId = await seedFromSender({
      subject: "Older thread",
      fromAddress: "ada@example.com",
      date: at(100),
    })
    // Header casing differs from the queried address — still one person.
    const middleId = await seedFromSender({
      subject: "Middle thread",
      fromAddress: "Ada@Example.com",
      date: at(200),
    })
    await seedFromSender({
      subject: "Other sender",
      fromAddress: "grace@example.com",
      date: at(250),
    })

    const rows = await listRecentThreadsByParticipant(
      executor,
      "ada@example.com",
      { excludeThreadId: openId }
    )
    expect(rows.map((thread) => thread.id)).toEqual([middleId, olderId])

    // Without the exclusion the open (newest) thread leads the list.
    const unfiltered = await listRecentThreadsByParticipant(
      executor,
      "ada@example.com"
    )
    expect(unfiltered.map((thread) => thread.id)).toEqual([
      openId,
      middleId,
      olderId,
    ])
  })

  it("caps the result at limit and skips trashed/spam threads", async () => {
    const firstId = await seedFromSender({
      subject: "First",
      fromAddress: "ada@example.com",
      date: at(300),
    })
    const secondId = await seedFromSender({
      subject: "Second",
      fromAddress: "ada@example.com",
      date: at(200),
    })
    const thirdId = await seedFromSender({
      subject: "Third",
      fromAddress: "ada@example.com",
      date: at(100),
    })
    const trashedId = await seedFromSender({
      subject: "Trashed",
      fromAddress: "ada@example.com",
      date: at(400),
    })
    await executor.execute("UPDATE threads SET is_trashed = 1 WHERE id = $1", [
      trashedId,
    ])

    expect(
      (await listRecentThreadsByParticipant(executor, "ada@example.com")).map(
        (thread) => thread.id
      )
    ).toEqual([firstId, secondId, thirdId])
    expect(
      (
        await listRecentThreadsByParticipant(executor, "ada@example.com", {
          limit: 2,
        })
      ).map((thread) => thread.id)
    ).toEqual([firstId, secondId])
  })

  it("never matches a longer address sharing the queried suffix, and [] on an empty address", async () => {
    await seedFromSender({
      subject: "Canada",
      fromAddress: "canada@example.com",
      date: at(100),
    })
    expect(
      await listRecentThreadsByParticipant(executor, "ada@example.com")
    ).toEqual([])
    expect(await listRecentThreadsByParticipant(executor, "   ")).toEqual([])
  })
})
