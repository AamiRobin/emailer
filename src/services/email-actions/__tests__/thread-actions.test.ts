import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  at,
  createAccount,
  createGmailLabel,
  createImapFolderLabel,
  createMessage,
  createThread,
} from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import type { SqlExecutor } from "../../db/executor"
import {
  listOperationsByStatus,
  type PendingOperationRow,
} from "../../db/pending-operations"
import { operationFromRow, type QueueOperation } from "../../queue/operation"
import {
  getThreadWithMessages,
  listThreadsByFolder,
  recomputeThreadCaches,
  setThreadFolder,
  setThreadLabels,
} from "../../db/threads"
import type { MessageRef } from "../../email/types"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "../../../stores/account-store"
import {
  setFolderCountsStoreExecutor,
  useFolderCountsStore,
} from "../../../stores/folder-counts-store"
import { MissingProviderRefError } from "../message-refs"
import {
  AccountNotFoundError,
  archiveThread,
  bulkApply,
  deleteForeverThread,
  markNotSpam,
  markSpam,
  MissingSpecialFolderError,
  NotInTrashError,
  onThreadListChanged,
  setThreadRead,
  setThreadStarred,
  ThreadNotFoundError,
  trashThread,
  type ThreadListChangeEvent,
} from "../thread-actions"

/**
 * Task 10.1 service-layer tests. The layer is db + queue only — no
 * provider exists in these tests at all (nothing to mock): the offline
 * invariant "actions never call the server, they only enqueue" is
 * enforced by construction and asserted via the pending_operations rows.
 */

/** Enqueued (pending) ops for the account, deserialized, FIFO order. */
async function enqueuedOps(
  executor: SqlExecutor,
  accountId: string
): Promise<QueueOperation[]> {
  const rows: PendingOperationRow[] = await listOperationsByStatus(
    executor,
    "pending",
    accountId
  )
  return rows.map(operationFromRow)
}

/** Proxy that records every execute() statement (ordering assertions). */
function recordingExecutor(executor: SqlExecutor): {
  statements: string[]
  executor: SqlExecutor
} {
  const statements: string[] = []
  return {
    statements,
    executor: {
      select: (sql, params) => executor.select(sql, params),
      execute: async (sql, params) => {
        statements.push(sql)
        return executor.execute(sql, params)
      },
    },
  }
}

// ---- Seeds ----------------------------------------------------------------

/** gmail labels (INBOX/TRASH/SPAM rows) for one account. */
interface GmailLabels {
  inbox: string
  trash: string
  spam: string
}

async function seedGmailLabels(
  executor: SqlExecutor,
  accountId: string
): Promise<GmailLabels> {
  return {
    inbox: await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    ),
    trash: await createGmailLabel(
      executor,
      accountId,
      "TRASH",
      "TRASH",
      "trash"
    ),
    spam: await createGmailLabel(executor, accountId, "SPAM", "SPAM", "spam"),
  }
}

/**
 * Numeric-string gmail message id generator. Unique across the suite (the
 * schema enforces (account_id, gmail_message_id) uniqueness).
 */
let gmailIdSequence = 5_000_000_000_000_000

/** A two-message unread gmail thread sitting in Inbox. */
async function seedGmailInboxThread(
  executor: SqlExecutor,
  accountId: string,
  labels: GmailLabels
): Promise<{ threadId: string; refs: MessageRef[] }> {
  const threadId = await createThread(executor, accountId, {
    subject: "Hello",
  })
  await setThreadLabels(executor, threadId, [labels.inbox])
  const ids = [gmailIdSequence + 1, gmailIdSequence + 2].map(String)
  gmailIdSequence += 2
  let offset = 0
  for (const gmailId of ids) {
    await createMessage(executor, {
      threadId,
      accountId,
      date: at(offset),
      gmailMessageId: gmailId,
      snippet: `body ${offset}`,
    })
    offset += 60
  }
  await recomputeThreadCaches(executor, threadId)
  return {
    threadId,
    refs: ids.map((id) => ({
      folder: "",
      uid: Number(id),
      providerMessageId: id,
    })),
  }
}

/** imap system folders (INBOX/Trash/Junk/Archive paths) for one account. */
interface ImapFolders {
  inbox: string
  trash: string
  spam: string
  archive: string
}

async function seedImapFolders(
  executor: SqlExecutor,
  accountId: string
): Promise<ImapFolders> {
  return {
    inbox: await createImapFolderLabel(executor, accountId, "INBOX", "inbox"),
    trash: await createImapFolderLabel(executor, accountId, "Trash", "trash"),
    spam: await createImapFolderLabel(executor, accountId, "Junk", "spam"),
    archive: await createImapFolderLabel(
      executor,
      accountId,
      "Archive",
      "archive"
    ),
  }
}

/** A two-message unread imap thread living in `folderPath`. */
async function seedImapThread(
  executor: SqlExecutor,
  accountId: string,
  folderLabelId: string,
  folderPath: string
): Promise<{ threadId: string; refs: MessageRef[] }> {
  const threadId = await createThread(executor, accountId, {
    subject: "Hello",
  })
  await setThreadFolder(executor, threadId, folderLabelId)
  const uids = [101, 102]
  let offset = 0
  for (const imapUid of uids) {
    await createMessage(executor, {
      threadId,
      accountId,
      date: at(offset),
      imapFolder: folderPath,
      imapUid,
      snippet: `body ${offset}`,
    })
    offset += 60
  }
  await recomputeThreadCaches(executor, threadId)
  return {
    threadId,
    refs: uids.map((imapUid) => ({ folder: folderPath, uid: imapUid })),
  }
}

async function inboxList(
  executor: SqlExecutor,
  accountId: string
): Promise<string[]> {
  const rows = await listThreadsByFolder(executor, {
    accountId,
    folder: { kind: "preset", preset: "inbox" },
  })
  return rows.map((row) => row.id)
}

// ---- gmail model ----------------------------------------------------------

describe("thread actions — gmail label model", () => {
  let executor: TestExecutor
  let accountId: string
  let labels: GmailLabels

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
    labels = await seedGmailLabels(executor, accountId)
  })

  afterEach(() => {
    executor.close()
  })

  it("archive removes INBOX membership, lands in Archive, queues archive", async () => {
    const { threadId, refs } = await seedGmailInboxThread(
      executor,
      accountId,
      labels
    )

    await archiveThread(executor, accountId, threadId)

    const loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.labelIds).toEqual([])
    expect(loaded?.thread).toMatchObject({
      is_archived: 1,
      is_trashed: 0,
      is_spam: 0,
    })
    expect(await inboxList(executor, accountId)).not.toContain(threadId)
    const archiveList = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "archive" },
    })
    expect(archiveList.map((row) => row.id)).toContain(threadId)

    const ops = await enqueuedOps(executor, accountId)
    expect(ops).toEqual([{ accountId, kind: "archive", refs }])
  })

  it("archive is locally idempotent (double archive stays consistent)", async () => {
    const { threadId } = await seedGmailInboxThread(executor, accountId, labels)

    await archiveThread(executor, accountId, threadId)
    await archiveThread(executor, accountId, threadId)

    const loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.labelIds).toEqual([])
    expect(loaded?.thread.is_archived).toBe(1)
    // Two queued replays are harmless: dropping an absent label converges.
    expect(await enqueuedOps(executor, accountId)).toHaveLength(2)
  })

  it("trash adds TRASH membership and queues trash", async () => {
    const { threadId, refs } = await seedGmailInboxThread(
      executor,
      accountId,
      labels
    )

    await trashThread(executor, accountId, threadId)

    const loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.thread).toMatchObject({ is_trashed: 1, is_archived: 0 })
    expect(loaded?.labelIds).toContain(labels.trash)
    expect(await inboxList(executor, accountId)).not.toContain(threadId)

    const ops = await enqueuedOps(executor, accountId)
    expect(ops).toEqual([{ accountId, kind: "trash", refs }])
  })

  it("markSpam adds SPAM membership and queues add_labels [SPAM]", async () => {
    const { threadId, refs } = await seedGmailInboxThread(
      executor,
      accountId,
      labels
    )

    await markSpam(executor, accountId, threadId)

    const loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.thread).toMatchObject({ is_spam: 1, is_archived: 0 })
    expect(loaded?.labelIds).toContain(labels.spam)
    expect(await inboxList(executor, accountId)).not.toContain(threadId)

    const ops = await enqueuedOps(executor, accountId)
    expect(ops).toEqual([
      { accountId, kind: "add_labels", refs, labelIds: ["SPAM"] },
    ])
  })

  it("markNotSpam returns the thread to the Inbox and queues not_spam", async () => {
    const { threadId, refs } = await seedGmailInboxThread(
      executor,
      accountId,
      labels
    )
    await markSpam(executor, accountId, threadId)

    await markNotSpam(executor, accountId, threadId)

    const loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.thread).toMatchObject({
      is_spam: 0,
      is_archived: 0,
      is_trashed: 0,
    })
    expect(loaded?.labelIds).toContain(labels.inbox)
    expect(loaded?.labelIds).not.toContain(labels.spam)
    expect(await inboxList(executor, accountId)).toContain(threadId)

    const ops = await enqueuedOps(executor, accountId)
    // First op is the earlier markSpam; not_spam is queued after it (FIFO).
    expect(ops[1]).toEqual({ accountId, kind: "not_spam", refs })
  })

  it("deleteForever is guarded, removes rows, queues delete_forever", async () => {
    const { threadId, refs } = await seedGmailInboxThread(
      executor,
      accountId,
      labels
    )

    // Guard: refusing from the inbox leaves everything untouched.
    await expect(
      deleteForeverThread(executor, accountId, threadId)
    ).rejects.toBeInstanceOf(NotInTrashError)
    expect(await getThreadWithMessages(executor, threadId)).not.toBeNull()
    expect(await enqueuedOps(executor, accountId)).toEqual([])

    await trashThread(executor, accountId, threadId)
    await deleteForeverThread(executor, accountId, threadId)

    expect(await getThreadWithMessages(executor, threadId)).toBeNull()
    const leftover = await executor.select<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE thread_id = $1",
      [threadId]
    )
    expect(leftover[0]?.count).toBe(0)

    const ops = await enqueuedOps(executor, accountId)
    // FIFO: the trash replay lands before the expunge so the server-side
    // message is in Trash (the gmail trash endpoint) when delete runs.
    expect(ops.map((op) => op.kind)).toEqual(["trash", "delete_forever"])
    expect(ops[1]).toEqual({ accountId, kind: "delete_forever", refs })
  })

  it("setThreadRead flips message rows + unread cache, queues mark ops", async () => {
    const { threadId, refs } = await seedGmailInboxThread(
      executor,
      accountId,
      labels
    )

    await setThreadRead(executor, accountId, threadId, true)
    let loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.thread.unread_count).toBe(0)
    expect(loaded?.messages.every((message) => message.is_read === 1)).toBe(
      true
    )

    await setThreadRead(executor, accountId, threadId, false)
    loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.thread.unread_count).toBe(2)
    expect(loaded?.messages.every((message) => message.is_read === 0)).toBe(
      true
    )

    const ops = await enqueuedOps(executor, accountId)
    expect(ops).toEqual([
      { accountId, kind: "mark_read", refs },
      { accountId, kind: "mark_unread", refs },
    ])
  })

  it("setThreadStarred flips message flags + is_starred, queues star ops", async () => {
    const { threadId, refs } = await seedGmailInboxThread(
      executor,
      accountId,
      labels
    )

    await setThreadStarred(executor, accountId, threadId, true)
    let loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.thread.is_starred).toBe(1)
    expect(loaded?.messages.every((message) => message.is_flagged === 1)).toBe(
      true
    )
    const starredList = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "starred" },
    })
    expect(starredList.map((row) => row.id)).toContain(threadId)

    await setThreadStarred(executor, accountId, threadId, false)
    loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.thread.is_starred).toBe(0)
    expect(loaded?.messages.every((message) => message.is_flagged === 0)).toBe(
      true
    )

    const ops = await enqueuedOps(executor, accountId)
    expect(ops).toEqual([
      { accountId, kind: "star", refs },
      { accountId, kind: "unstar", refs },
    ])
  })

  it("bulkApply archives N threads with one change event", async () => {
    const seeded = []
    for (let index = 0; index < 3; index++) {
      seeded.push(await seedGmailInboxThread(executor, accountId, labels))
    }
    const events: ThreadListChangeEvent[] = []
    const unsubscribe = onThreadListChanged((event) => events.push(event))

    await bulkApply(
      executor,
      accountId,
      seeded.map((thread) => thread.threadId),
      "archive"
    )
    unsubscribe()

    const inbox = await inboxList(executor, accountId)
    for (const thread of seeded) {
      expect(inbox).not.toContain(thread.threadId)
    }
    const ops = await enqueuedOps(executor, accountId)
    expect(ops).toHaveLength(3)
    expect(ops.every((op) => op.kind === "archive")).toBe(true)
    expect(events).toEqual([
      {
        action: "archive",
        accountId,
        threadIds: seeded.map((thread) => thread.threadId),
      },
    ])
  })

  it("mutates locally BEFORE enqueueing (D10 ordering)", async () => {
    const { threadId } = await seedGmailInboxThread(executor, accountId, labels)
    const recorded = recordingExecutor(executor)

    await archiveThread(recorded.executor, accountId, threadId)

    const enqueueAt = recorded.statements.findIndex((sql) =>
      sql.includes("INSERT INTO pending_operations")
    )
    const localAt = recorded.statements.findIndex((sql) =>
      sql.includes("UPDATE threads SET is_archived")
    )
    expect(localAt).toBeGreaterThan(-1)
    expect(enqueueAt).toBeGreaterThan(localAt)
  })

  it("rejects with typed errors and enqueues nothing", async () => {
    const { threadId } = await seedGmailInboxThread(executor, accountId, labels)

    // unknown thread id
    await expect(
      archiveThread(executor, accountId, "thread-nope")
    ).rejects.toBeInstanceOf(ThreadNotFoundError)

    // thread owned by a different account
    const otherAccountId = await createAccount(executor, "gmail")
    await expect(
      archiveThread(executor, otherAccountId, threadId)
    ).rejects.toBeInstanceOf(ThreadNotFoundError)

    // unknown account
    await expect(
      archiveThread(executor, "acc-nope", threadId)
    ).rejects.toBeInstanceOf(AccountNotFoundError)

    // message without a gmail provider id cannot be addressed
    const brokenThread = await createThread(executor, accountId)
    await setThreadLabels(executor, brokenThread, [labels.inbox])
    await createMessage(executor, {
      threadId: brokenThread,
      accountId,
      date: at(0),
    })
    await expect(
      archiveThread(executor, accountId, brokenThread)
    ).rejects.toBeInstanceOf(MissingProviderRefError)

    expect(await enqueuedOps(executor, accountId)).toEqual([])
  })
})

// ---- imap model -----------------------------------------------------------

describe("thread actions — imap folder model", () => {
  let executor: TestExecutor
  let accountId: string
  let folders: ImapFolders

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "imap")
    folders = await seedImapFolders(executor, accountId)
  })

  afterEach(() => {
    executor.close()
  })

  it("archive moves messages to the Archive folder and queues archive", async () => {
    const { threadId, refs } = await seedImapThread(
      executor,
      accountId,
      folders.inbox,
      "INBOX"
    )

    await archiveThread(executor, accountId, threadId)

    const loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.thread.folder_label_id).toBe(folders.archive)
    expect(loaded?.thread).toMatchObject({
      is_archived: 1,
      is_trashed: 0,
      is_spam: 0,
    })
    expect(
      loaded?.messages.every((message) => message.imap_folder === "Archive")
    ).toBe(true)
    expect(await inboxList(executor, accountId)).not.toContain(threadId)

    const ops = await enqueuedOps(executor, accountId)
    expect(ops).toEqual([{ accountId, kind: "archive", refs }])
  })

  it("trash moves messages to the Trash folder and queues trash", async () => {
    const { threadId, refs } = await seedImapThread(
      executor,
      accountId,
      folders.inbox,
      "INBOX"
    )

    await trashThread(executor, accountId, threadId)

    const loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.thread).toMatchObject({ is_trashed: 1, is_archived: 0 })
    expect(
      loaded?.messages.every((message) => message.imap_folder === "Trash")
    ).toBe(true)

    const ops = await enqueuedOps(executor, accountId)
    expect(ops).toEqual([{ accountId, kind: "trash", refs }])
  })

  it("markSpam moves to Junk and queues a move (imap has no labels)", async () => {
    const { threadId, refs } = await seedImapThread(
      executor,
      accountId,
      folders.inbox,
      "INBOX"
    )

    await markSpam(executor, accountId, threadId)

    const loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.thread).toMatchObject({ is_spam: 1, is_archived: 0 })
    expect(
      loaded?.messages.every((message) => message.imap_folder === "Junk")
    ).toBe(true)

    const ops = await enqueuedOps(executor, accountId)
    expect(ops).toEqual([
      { accountId, kind: "move", refs, destinationFolder: "Junk" },
    ])
  })

  it("markNotSpam moves back to INBOX and queues a move to INBOX", async () => {
    const { threadId, refs } = await seedImapThread(
      executor,
      accountId,
      folders.spam,
      "Junk"
    )

    await markNotSpam(executor, accountId, threadId)

    const loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.thread).toMatchObject({
      is_spam: 0,
      is_archived: 0,
      is_trashed: 0,
    })
    expect(loaded?.thread.folder_label_id).toBe(folders.inbox)
    expect(
      loaded?.messages.every((message) => message.imap_folder === "INBOX")
    ).toBe(true)
    expect(await inboxList(executor, accountId)).toContain(threadId)

    const ops = await enqueuedOps(executor, accountId)
    expect(ops).toEqual([
      { accountId, kind: "move", refs, destinationFolder: "INBOX" },
    ])
  })

  it("deleteForever is guarded, removes rows, queues delete_forever", async () => {
    const { threadId } = await seedImapThread(
      executor,
      accountId,
      folders.inbox,
      "INBOX"
    )

    await expect(
      deleteForeverThread(executor, accountId, threadId)
    ).rejects.toBeInstanceOf(NotInTrashError)
    expect(await getThreadWithMessages(executor, threadId)).not.toBeNull()

    await trashThread(executor, accountId, threadId)
    await deleteForeverThread(executor, accountId, threadId)

    expect(await getThreadWithMessages(executor, threadId)).toBeNull()
    const leftover = await executor.select<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE thread_id = $1",
      [threadId]
    )
    expect(leftover[0]?.count).toBe(0)

    const ops = await enqueuedOps(executor, accountId)
    expect(ops.map((op) => op.kind)).toEqual(["trash", "delete_forever"])
    // Refs address the messages' CURRENT folder (Trash) — after the queued
    // trash replay lands, the server-side copy lives there too.
    expect(ops[1]).toEqual({
      accountId,
      kind: "delete_forever",
      refs: [
        { folder: "Trash", uid: 101 },
        { folder: "Trash", uid: 102 },
      ],
    })
  })

  it("setThreadRead updates rows + unread cache, queues mark ops", async () => {
    const { threadId, refs } = await seedImapThread(
      executor,
      accountId,
      folders.inbox,
      "INBOX"
    )

    await setThreadRead(executor, accountId, threadId, true)
    let loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.thread.unread_count).toBe(0)
    expect(loaded?.messages.every((message) => message.is_read === 1)).toBe(
      true
    )

    await setThreadRead(executor, accountId, threadId, false)
    loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.thread.unread_count).toBe(2)

    const ops = await enqueuedOps(executor, accountId)
    expect(ops).toEqual([
      { accountId, kind: "mark_read", refs },
      { accountId, kind: "mark_unread", refs },
    ])
  })

  it("setThreadStarred updates flags + is_starred, queues star ops", async () => {
    const { threadId, refs } = await seedImapThread(
      executor,
      accountId,
      folders.inbox,
      "INBOX"
    )

    await setThreadStarred(executor, accountId, threadId, true)
    let loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.thread.is_starred).toBe(1)
    expect(loaded?.messages.every((message) => message.is_flagged === 1)).toBe(
      true
    )

    await setThreadStarred(executor, accountId, threadId, false)
    loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.thread.is_starred).toBe(0)
    expect(loaded?.messages.every((message) => message.is_flagged === 0)).toBe(
      true
    )

    const ops = await enqueuedOps(executor, accountId)
    expect(ops).toEqual([
      { accountId, kind: "star", refs },
      { accountId, kind: "unstar", refs },
    ])
  })

  it("archive degrades gracefully without a local archive folder", async () => {
    const { threadId } = await seedImapThread(
      executor,
      accountId,
      folders.inbox,
      "INBOX"
    )
    // Remove the archive-role folder: the provider resolves the role
    // server-side at replay, so the op still queues.
    await executor.execute("DELETE FROM labels WHERE id = $1", [
      folders.archive,
    ])

    await archiveThread(executor, accountId, threadId)

    const loaded = await getThreadWithMessages(executor, threadId)
    expect(
      loaded?.messages.every((message) => message.imap_folder === "INBOX")
    ).toBe(true)
    const ops = await enqueuedOps(executor, accountId)
    expect(ops.map((op) => op.kind)).toEqual(["archive"])
  })

  it("markSpam without a Junk folder throws and enqueues nothing", async () => {
    const { threadId } = await seedImapThread(
      executor,
      accountId,
      folders.inbox,
      "INBOX"
    )
    await executor.execute("DELETE FROM labels WHERE id = $1", [folders.spam])

    await expect(
      markSpam(executor, accountId, threadId)
    ).rejects.toBeInstanceOf(MissingSpecialFolderError)
    expect(await enqueuedOps(executor, accountId)).toEqual([])
  })

  it("mutates locally BEFORE enqueueing (D10 ordering)", async () => {
    const { threadId } = await seedImapThread(
      executor,
      accountId,
      folders.inbox,
      "INBOX"
    )
    const recorded = recordingExecutor(executor)

    await archiveThread(recorded.executor, accountId, threadId)

    const enqueueAt = recorded.statements.findIndex((sql) =>
      sql.includes("INSERT INTO pending_operations")
    )
    const localAt = recorded.statements.findIndex((sql) =>
      sql.includes("UPDATE messages SET imap_folder")
    )
    expect(localAt).toBeGreaterThan(-1)
    expect(enqueueAt).toBeGreaterThan(localAt)
  })
})

// ---- Indicator refresh + change hook --------------------------------------

describe("thread actions — indicators and change hook", () => {
  let executor: TestExecutor
  let accountId: string
  let labels: GmailLabels

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
    labels = await seedGmailLabels(executor, accountId)
    // The actions refresh these two stores best-effort; with the test
    // executors injected the refresh is fully observable.
    setAccountStoreExecutor(executor)
    setFolderCountsStoreExecutor(executor)
  })

  afterEach(() => {
    setAccountStoreExecutor(null)
    setFolderCountsStoreExecutor(null)
    useAccountStore.setState({ accounts: [], activeAccountId: null })
    useFolderCountsStore.setState({ accountId: null })
    executor.close()
  })

  it("refreshes account unread badges and sidebar folder counts", async () => {
    const { threadId } = await seedGmailInboxThread(executor, accountId, labels)
    useAccountStore.setState({
      accounts: [
        {
          id: accountId,
          type: "gmail",
          email: "reader@example.com",
          displayName: null,
          status: "active",
          unreadCount: 99,
        },
      ],
      activeAccountId: accountId,
    })

    await setThreadRead(executor, accountId, threadId, true)

    expect(useAccountStore.getState().accounts[0]?.unreadCount).toBe(0)
    expect(useFolderCountsStore.getState().counts.inbox).toBe(0)
    expect(useFolderCountsStore.getState().accountId).toBe(accountId)
  })

  it("emits onThreadListChanged after the mutation; unsubscribe works", async () => {
    const { threadId } = await seedGmailInboxThread(executor, accountId, labels)
    const events: ThreadListChangeEvent[] = []
    const unsubscribe = onThreadListChanged((event) => events.push(event))

    await trashThread(executor, accountId, threadId)
    expect(events).toEqual([
      { action: "trash", accountId, threadIds: [threadId] },
    ])

    unsubscribe()
    await archiveThread(executor, accountId, threadId)
    expect(events).toHaveLength(1)
  })
})
