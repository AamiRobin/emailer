import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createAccount,
  createGmailLabel,
  createImapFolderLabel,
  createMessage,
  createThread,
} from "./fixtures"
import { createTestExecutor, type TestExecutor } from "./test-executor"
import {
  applyBlockToExistingMail,
  blockSender,
  blockedSenderKey,
  countBlockedExisting,
  isSenderBlocked,
  listBlockedSenders,
  unblockSender,
} from "../blocked-senders"
import { recomputeThreadCaches, setThreadLabels } from "../threads"

/**
 * Sender blocklist CRUD (task 18.2) plus the block-time cleanup helpers.
 * The cleanup assertions read placement back through the thread caches —
 * the same flags the inbox list filters on — so "moved" means exactly
 * "left the inbox".
 */

let executor: TestExecutor
let accountId: string

beforeEach(async () => {
  executor = createTestExecutor()
  accountId = await createAccount(executor, "gmail")
})

afterEach(() => {
  executor.close()
})

let messageSequence = 0

/** Seed an inbox-resident gmail thread whose newest message is `from`. */
async function seedInboxThread(
  fromAddress: string,
  options?: { date?: number }
): Promise<string> {
  const threadId = await createThread(executor, accountId)
  messageSequence += 1
  await createMessage(executor, {
    threadId,
    accountId,
    date: options?.date ?? 100,
    fromAddress,
    // The queued cleanup ops carry provider refs (message-refs.ts).
    gmailMessageId: `g${messageSequence}`,
  })
  await recomputeThreadCaches(executor, threadId)
  const inbox = await executor.select<{ id: string }>(
    "SELECT id FROM labels WHERE account_id = $1 AND special_use = 'inbox'",
    [accountId]
  )
  if (inbox.length === 0) {
    const id = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    await setThreadLabels(executor, threadId, [id])
  } else {
    await setThreadLabels(executor, threadId, [inbox[0]!.id])
  }
  return threadId
}

async function threadFlags(
  threadId: string
): Promise<{ is_archived: number; is_trashed: number }> {
  const rows = await executor.select<{
    is_archived: number
    is_trashed: number
  }>("SELECT is_archived, is_trashed FROM threads WHERE id = $1", [threadId])
  return rows[0]!
}

describe("blocked senders CRUD", () => {
  it("blocks a sender and reads it back case-insensitively", async () => {
    await blockSender(executor, accountId, {
      sender: "Spam@X.com",
      action: "trash",
    })

    const rows = await listBlockedSenders(executor, accountId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      account_id: accountId,
      sender: "spam@x.com",
      action: "trash",
    })

    expect(await isSenderBlocked(executor, accountId, "SPAM@x.com")).toEqual({
      action: "trash",
    })
    expect(await isSenderBlocked(executor, accountId, " spam@x.com ")).toEqual({
      action: "trash",
    })
    // A different account (and a different address) is unaffected.
    const otherAccount = await createAccount(executor, "gmail")
    expect(await isSenderBlocked(executor, otherAccount, "spam@x.com")).toBe(
      null
    )
    expect(await isSenderBlocked(executor, accountId, "other@x.com")).toBe(null)
    expect(await isSenderBlocked(executor, accountId, "   ")).toBe(null)
  })

  it("re-blocking the same address updates the action instead of duplicating", async () => {
    await blockSender(executor, accountId, {
      sender: "spam@x.com",
      action: "trash",
    })
    await blockSender(executor, accountId, {
      sender: "spam@x.com",
      action: "archive",
    })

    const rows = await listBlockedSenders(executor, accountId)
    expect(rows).toHaveLength(1) // UNIQUE(account_id, sender) upsert
    expect(rows[0]).toMatchObject({ sender: "spam@x.com", action: "archive" })
    expect(await isSenderBlocked(executor, accountId, "spam@x.com")).toEqual({
      action: "archive",
    })
  })

  it("unblock removes the row and future checks return null", async () => {
    await blockSender(executor, accountId, {
      sender: "spam@x.com",
      action: "trash",
    })
    const [row] = await listBlockedSenders(executor, accountId)

    await unblockSender(executor, row!.id)

    expect(await listBlockedSenders(executor, accountId)).toEqual([])
    expect(await isSenderBlocked(executor, accountId, "spam@x.com")).toBe(null)
    // Idempotent: unblocking a gone row changes nothing.
    await expect(unblockSender(executor, row!.id)).resolves.toBeUndefined()
  })

  it("blockedSenderKey normalizes and rejects empty addresses", () => {
    expect(blockedSenderKey(" A@B.C ")).toBe("a@b.c")
    expect(blockedSenderKey("   ")).toBe(null)
  })
})

describe("blocked-sender cleanup (existing mail)", () => {
  it("counts and files only inbox-resident threads from that sender", async () => {
    const kept = await seedInboxThread("spam@x.com", { date: 100 })
    const second = await seedInboxThread("spam@x.com", { date: 200 })
    // Other inbox mail and already-filed mail from the same sender stay.
    const otherSender = await seedInboxThread("innocent@x.com")
    const archived = await seedInboxThread("spam@x.com")
    const trash = await executor.select<{ id: string }>(
      "SELECT id FROM labels WHERE account_id = $1 AND special_use = 'trash'",
      [accountId]
    )
    const trashId =
      trash[0]?.id ??
      (await createGmailLabel(executor, accountId, "TRASH", "TRASH", "trash"))
    await setThreadLabels(executor, archived, [trashId])
    await recomputeThreadCaches(executor, archived)

    expect(await countBlockedExisting(executor, accountId, "Spam@X.com")).toBe(
      2
    )
    expect(await countBlockedExisting(executor, accountId, "none@x.com")).toBe(
      0
    )

    const moved = await applyBlockToExistingMail(
      executor,
      accountId,
      "spam@x.com",
      "trash"
    )
    expect(moved).toBe(2)
    expect(await threadFlags(kept)).toMatchObject({ is_trashed: 1 })
    expect(await threadFlags(second)).toMatchObject({ is_trashed: 1 })
    // Out of scope: another sender's inbox mail and already-trashed mail.
    expect(await threadFlags(otherSender)).toMatchObject({
      is_trashed: 0,
      is_archived: 0,
    })
    // Idempotent: nothing inbox-resident remains, so a second pass moves 0.
    expect(await countBlockedExisting(executor, accountId, "spam@x.com")).toBe(
      0
    )
    expect(
      await applyBlockToExistingMail(executor, accountId, "spam@x.com", "trash")
    ).toBe(0)
  })

  it("archive action archives the existing conversations", async () => {
    const threadId = await seedInboxThread("spam@x.com")

    const moved = await applyBlockToExistingMail(
      executor,
      accountId,
      "spam@x.com",
      "archive"
    )

    expect(moved).toBe(1)
    expect(await threadFlags(threadId)).toMatchObject({
      is_archived: 1,
      is_trashed: 0,
    })
  })

  it("matches the imap folder-cache placement model too", async () => {
    const imapAccount = await createAccount(executor, "imap")
    const inbox = await createImapFolderLabel(
      executor,
      imapAccount,
      "INBOX",
      "inbox"
    )
    // The trash-role folder gives the local trash move a destination
    // (without it the op still queues but the local flag stays 0).
    await createImapFolderLabel(executor, imapAccount, "Trash", "trash")
    const threadId = await createThread(executor, imapAccount)
    await createMessage(executor, {
      threadId,
      accountId: imapAccount,
      date: 100,
      fromAddress: "spam@x.com",
      imapFolder: "INBOX",
      imapUid: 1,
    })
    await executor.execute(
      "UPDATE threads SET folder_label_id = $1 WHERE id = $2",
      [inbox, threadId]
    )
    await recomputeThreadCaches(executor, threadId)

    expect(
      await countBlockedExisting(executor, imapAccount, "spam@x.com")
    ).toBe(1)
    expect(
      await applyBlockToExistingMail(
        executor,
        imapAccount,
        "spam@x.com",
        "trash"
      )
    ).toBe(1)
    const rows = await executor.select<{ is_trashed: number }>(
      "SELECT is_trashed FROM threads WHERE id = $1",
      [threadId]
    )
    expect(rows[0]).toMatchObject({ is_trashed: 1 })
  })
})
