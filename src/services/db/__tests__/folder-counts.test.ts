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
import { unreadCountByLabel, unreadCountBySpecialUse } from "../folder-counts"
import {
  recomputeThreadCaches,
  setThreadLabels,
  setThreadStarred,
} from "../threads"
import { setThreadFolder } from "../threads"
import { snoozeThread, wakeDueThreads } from "../../email-actions/snooze"
import {
  markThreadDone,
  muteThread,
  unmarkThreadDone,
  unmuteThread,
} from "../../email-actions/thread-states"

/**
 * Seeds real threads through the query layer (messages + recompute for
 * unread_count caches, setThreadLabels/setThreadFolder for folder
 * membership) and verifies the conditional-aggregate query reproduces the
 * listThreadsByFolder predicates, per account, for both membership models.
 */

let executor: TestExecutor

/** Thread with `unread` unread messages; caches the count like sync does. */
async function seedThread(options: {
  accountId: string
  unread: number
  read?: number
  labelIds?: string[]
  folderLabelId?: string
  starred?: boolean
}): Promise<string> {
  const threadId = await createThread(executor, options.accountId)
  let date = at(0)
  for (let index = 0; index < (options.read ?? 0); index += 1) {
    await createMessage(executor, {
      threadId,
      accountId: options.accountId,
      date,
      isRead: true,
    })
    date += 10
  }
  for (let index = 0; index < options.unread; index += 1) {
    await createMessage(executor, {
      threadId,
      accountId: options.accountId,
      date,
    })
    date += 10
  }
  await recomputeThreadCaches(executor, threadId)
  if (options.labelIds) {
    await setThreadLabels(executor, threadId, options.labelIds)
  }
  if (options.folderLabelId !== undefined) {
    await setThreadFolder(executor, threadId, options.folderLabelId)
  }
  if (options.starred) {
    await setThreadStarred(executor, threadId)
  }
  return threadId
}

beforeEach(() => {
  executor = createTestExecutor()
})

afterEach(() => {
  executor.close()
})

describe("unreadCountBySpecialUse", () => {
  it("counts gmail threads per folder, matching the list predicates", async () => {
    const accountId = await createAccount(executor, "gmail")
    const inbox = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const sent = await createGmailLabel(
      executor,
      accountId,
      "SENT",
      "SENT",
      "sent"
    )
    const drafts = await createGmailLabel(
      executor,
      accountId,
      "DRAFTS",
      "DRAFTS",
      "drafts"
    )
    const trash = await createGmailLabel(
      executor,
      accountId,
      "TRASH",
      "TRASH",
      "trash"
    )
    const spam = await createGmailLabel(
      executor,
      accountId,
      "SPAM",
      "SPAM",
      "spam"
    )
    const work = await createGmailLabel(
      executor,
      accountId,
      "Work",
      "Label_work",
      undefined,
      "user"
    )

    // inbox: 1 + 1 unread
    await seedThread({ accountId, unread: 1, read: 1, labelIds: [inbox] })
    await seedThread({ accountId, unread: 1, labelIds: [inbox, work] })
    // starred + inbox → counted in both (starred preset keeps inbox threads)
    await seedThread({ accountId, unread: 1, labelIds: [inbox], starred: true })
    await seedThread({ accountId, unread: 1, labelIds: [sent] })
    await seedThread({ accountId, unread: 1, labelIds: [drafts] })
    // Only a user label, sent, or drafts role → gmail archived semantics
    // (absent INBOX), so these match the archive preset exactly like
    // listThreadsByFolder does: 1 + 1 + 1.
    await seedThread({ accountId, unread: 1, labelIds: [work] })
    await seedThread({ accountId, unread: 1, labelIds: [trash] })
    await seedThread({ accountId, unread: 1, labelIds: [spam] })

    expect(await unreadCountBySpecialUse(executor, accountId)).toEqual({
      inbox: 3,
      starred: 1,
      sent: 1,
      drafts: 1,
      archive: 3,
      spam: 1,
      trash: 1,
    })
  })

  it("excludes other accounts' threads from every folder", async () => {
    const accountA = await createAccount(executor, "gmail")
    const accountB = await createAccount(executor, "gmail")
    const inboxA = await createGmailLabel(
      executor,
      accountA,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const inboxB = await createGmailLabel(
      executor,
      accountB,
      "INBOX",
      "INBOX",
      "inbox"
    )

    await seedThread({ accountId: accountA, unread: 2, labelIds: [inboxA] })
    await seedThread({ accountId: accountB, unread: 5, labelIds: [inboxB] })

    const countsA = await unreadCountBySpecialUse(executor, accountA)
    expect(countsA.inbox).toBe(2)
    expect(countsA.starred).toBe(0)
    const countsB = await unreadCountBySpecialUse(executor, accountB)
    expect(countsB.inbox).toBe(5)
    expect(countsB.starred).toBe(0)
  })

  it("resolves imap folders through folder_label_id and returns zeros for an empty account", async () => {
    const accountId = await createAccount(executor, "imap")
    const inbox = await createImapFolderLabel(
      executor,
      accountId,
      "INBOX",
      "inbox"
    )
    const archive = await createImapFolderLabel(
      executor,
      accountId,
      "Archive/2024",
      "archive"
    )
    const projects = await createImapFolderLabel(
      executor,
      accountId,
      "Projects"
    )

    await seedThread({ accountId, unread: 2, folderLabelId: inbox })
    await seedThread({ accountId, unread: 1, folderLabelId: archive })
    // A plain custom folder is neither inbox nor archived — it only shows
    // through its label id.
    await seedThread({ accountId, unread: 2, folderLabelId: projects })

    expect(await unreadCountBySpecialUse(executor, accountId)).toEqual({
      inbox: 2,
      starred: 0,
      sent: 0,
      drafts: 0,
      archive: 1,
      spam: 0,
      trash: 0,
    })

    const empty = await createAccount(executor, "imap")
    expect(await unreadCountBySpecialUse(executor, empty)).toEqual({
      inbox: 0,
      starred: 0,
      sent: 0,
      drafts: 0,
      archive: 0,
      spam: 0,
      trash: 0,
    })
  })
})

describe("unreadCountByLabel", () => {
  it("sums unread over both membership models per label and account", async () => {
    const accountA = await createAccount(executor, "gmail")
    const work = await createGmailLabel(
      executor,
      accountA,
      "Work",
      "Label_work",
      undefined,
      "user"
    )
    const inbox = await createGmailLabel(
      executor,
      accountA,
      "INBOX",
      "INBOX",
      "inbox"
    )

    await seedThread({
      accountId: accountA,
      unread: 1,
      labelIds: [work, inbox],
    })
    await seedThread({ accountId: accountA, unread: 3, labelIds: [work] })
    await seedThread({ accountId: accountA, unread: 2, labelIds: [inbox] })
    // Read threads do not contribute.
    await seedThread({
      accountId: accountA,
      unread: 0,
      read: 2,
      labelIds: [work],
    })

    expect(await unreadCountByLabel(executor, accountA, work)).toBe(4)
    expect(await unreadCountByLabel(executor, accountA, inbox)).toBe(3)

    // Other accounts with the same-named label do not leak in.
    const accountB = await createAccount(executor, "gmail")
    const workB = await createGmailLabel(
      executor,
      accountB,
      "Work",
      "Label_work",
      undefined,
      "user"
    )
    await seedThread({ accountId: accountB, unread: 9, labelIds: [workB] })
    expect(await unreadCountByLabel(executor, accountA, work)).toBe(4)
  })
})

describe("snoozed threads and badges (task 2.2)", () => {
  it("a snoozed thread drops out of the inbox badge, keeps counting in other folders, and recovers after wake", async () => {
    const accountId = await createAccount(executor, "gmail")
    const inbox = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )

    // Starred + inbox thread (2 unread) and a plain inbox thread (1).
    const snoozed = await seedThread({
      accountId,
      unread: 2,
      labelIds: [inbox],
      starred: true,
    })
    await seedThread({ accountId, unread: 1, labelIds: [inbox] })

    expect((await unreadCountBySpecialUse(executor, accountId)).inbox).toBe(3)

    await snoozeThread(executor, snoozed, at(20_000))
    const whileSnoozed = await unreadCountBySpecialUse(executor, accountId)
    // Snoozed unread contributes zero to the inbox badge…
    expect(whileSnoozed.inbox).toBe(1)
    // …while other folders keep counting their mail (Starred does not
    // hide the snoozed thread, exactly like the folder list itself).
    expect(whileSnoozed.starred).toBe(2)

    // The wake (due pass / startup sweep) restores the badge — read state
    // was never touched, so the prior unread state simply re-counts.
    expect(await wakeDueThreads(executor, at(30_000))).toBe(1)
    const afterWake = await unreadCountBySpecialUse(executor, accountId)
    expect(afterWake.inbox).toBe(3)
    expect(afterWake.starred).toBe(2)
  })
})

describe("muted / Done threads and badges (tasks 3.1/3.2)", () => {
  it("a muted thread drops out of the inbox badge, keeps counting in other folders, and recovers after unmute", async () => {
    const accountId = await createAccount(executor, "gmail")
    const inbox = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )

    // Starred + inbox thread (2 unread) and a plain inbox thread (1).
    const muted = await seedThread({
      accountId,
      unread: 2,
      labelIds: [inbox],
      starred: true,
    })
    await seedThread({ accountId, unread: 1, labelIds: [inbox] })

    expect((await unreadCountBySpecialUse(executor, accountId)).inbox).toBe(3)

    await muteThread(executor, muted)
    const whileMuted = await unreadCountBySpecialUse(executor, accountId)
    // Muted unread contributes zero to the inbox badge…
    expect(whileMuted.inbox).toBe(1)
    // …while other folders keep counting their mail (Starred does not
    // hide the muted thread, exactly like the folder list itself).
    expect(whileMuted.starred).toBe(2)

    // Unmute restores the badge — read state was never touched.
    await unmuteThread(executor, muted)
    const afterUnmute = await unreadCountBySpecialUse(executor, accountId)
    expect(afterUnmute.inbox).toBe(3)
    expect(afterUnmute.starred).toBe(2)
  })

  it("a Done thread drops out of the inbox badge only; other counts keep it", async () => {
    const accountId = await createAccount(executor, "gmail")
    const inbox = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const allmail = await createGmailLabel(
      executor,
      accountId,
      "All Mail",
      "Label_all",
      undefined,
      "user"
    )

    const done = await seedThread({
      accountId,
      unread: 2,
      labelIds: [inbox, allmail],
    })
    await seedThread({ accountId, unread: 1, labelIds: [inbox] })

    expect((await unreadCountBySpecialUse(executor, accountId)).inbox).toBe(3)
    expect(await unreadCountByLabel(executor, accountId, allmail)).toBe(2)

    await markThreadDone(executor, done)
    const whileDone = await unreadCountBySpecialUse(executor, accountId)
    // The badge must match the inbox list, which hides Done mail…
    expect(whileDone.inbox).toBe(1)
    // …while the user-label badge keeps counting its mail (Done is
    // inbox-only, exactly like the folder list that still shows the
    // thread under its labels).
    expect(await unreadCountByLabel(executor, accountId, allmail)).toBe(2)

    await unmarkThreadDone(executor, done)
    expect((await unreadCountBySpecialUse(executor, accountId)).inbox).toBe(3)
  })
})
