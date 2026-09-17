import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
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
import type { SenderStatRow } from "../../db/sender-stats"
import {
  getSenderStat,
  setUserSenderClass,
  upsertSenderStat,
} from "../../db/sender-stats"
import {
  recomputeThreadCaches,
  setThreadFolder,
  setThreadLabels,
} from "../../db/threads"
import { listPriorityImportant } from "../view"

/**
 * The priority-inbox view (task 13.2, design D7): the inbox threads whose
 * NEWEST sender classifies important (scored heuristic + user overrides).
 * The REQUIRED override test lives here: a per-sender override flips a
 * thread's placement in both directions, and clearing it restores the
 * heuristic.
 */

describe("priority inbox view", () => {
  let executor: TestExecutor
  let accountId: string
  let aliceThread: string
  let bulkThread: string

  const NOW = Math.floor(Date.now() / 1000)

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
    const inboxId = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )

    async function seedInboxThread(
      subject: string,
      fromAddress: string,
      date: number
    ): Promise<string> {
      const threadId = await createThread(executor, accountId, { subject })
      await createMessage(executor, {
        threadId,
        accountId,
        subject,
        fromAddress,
        date,
      })
      // The participants cache (migration v2) is the view's sender join —
      // recomputed like the sync engines leave it.
      await recomputeThreadCaches(executor, threadId)
      await setThreadLabels(executor, threadId, [inboxId])
      return threadId
    }

    // Alice: an ongoing conversation — a reply, recent, direct → important.
    aliceThread = await seedInboxThread(
      "Re: planning",
      "alice@example.com",
      NOW - 3600
    )
    // Bulk Co: a pure newsletter — list-marked, never replied → other.
    bulkThread = await seedInboxThread(
      "Weekly digest",
      "bulk@lists.example.com",
      NOW - 7200
    )

    await upsertSenderStat(executor, accountId, "alice@example.com", {
      isReply: true,
      isDirectToMe: true,
      date: NOW - 3600,
    })
    await upsertSenderStat(executor, accountId, "bulk@lists.example.com", {
      isMailingList: true,
      date: NOW - 7200,
    })
  })

  afterEach(() => {
    executor.close()
  })

  it("lists only the threads whose newest sender classifies important", async () => {
    const threads = await listPriorityImportant(executor, [accountId])
    expect(threads.map((thread) => thread.id)).toEqual([aliceThread])
    // Sanity: the newsletter really classified other on its own row.
    const bulk = (await getSenderStat(
      executor,
      accountId,
      "bulk@lists.example.com"
    )) as SenderStatRow | null
    expect(bulk?.is_mailing_list).toBe(1)
  })

  it("keeps trashed threads out (inbox preset semantics)", async () => {
    await executor.execute("UPDATE threads SET is_trashed = 1 WHERE id = $1", [
      aliceThread,
    ])
    expect(await listPriorityImportant(executor, [accountId])).toEqual([])
  })

  it("THE override test: a user override flips placement both ways", async () => {
    // "other" → "important": the newsletter is forced in.
    await setUserSenderClass(
      executor,
      accountId,
      "bulk@lists.example.com",
      "important"
    )
    expect(
      (await listPriorityImportant(executor, [accountId])).map(
        (thread) => thread.id
      )
    ).toEqual([aliceThread, bulkThread]) // inbox order (newest first)

    // "important" → "other": Alice is forced out.
    await setUserSenderClass(executor, accountId, "alice@example.com", "other")
    expect(
      (await listPriorityImportant(executor, [accountId])).map(
        (thread) => thread.id
      )
    ).toEqual([bulkThread])

    // Clearing both restores the pure heuristic.
    await setUserSenderClass(executor, accountId, "alice@example.com", null)
    await setUserSenderClass(
      executor,
      accountId,
      "bulk@lists.example.com",
      null
    )
    expect(
      (await listPriorityImportant(executor, [accountId])).map(
        (thread) => thread.id
      )
    ).toEqual([aliceThread])
  })

  it("matches senders case-insensitively against the participants cache", async () => {
    await upsertSenderStat(executor, accountId, "CAROL@Example.com", {
      isDirectToMe: true,
      date: NOW,
    })
    const inboxId = (
      await executor.select<{ id: string }>(
        "SELECT id FROM labels WHERE special_use = 'inbox' AND account_id = $1",
        [accountId]
      )
    )[0]?.id as string
    const threadId = await createThread(executor, accountId, {
      subject: "Upper case",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      subject: "Upper case",
      fromAddress: "carol@example.com",
      date: NOW,
    })
    await recomputeThreadCaches(executor, threadId)
    await setThreadLabels(executor, threadId, [inboxId])

    const threads = await listPriorityImportant(executor, [accountId])
    expect(threads.map((thread) => thread.id)).toContain(threadId)
  })

  it("runs across every account when the account set is null, scoped otherwise", async () => {
    const otherAccount = await createAccount(executor, "imap")
    const inboxB = await createImapFolderLabel(
      executor,
      otherAccount,
      "INBOX",
      "inbox"
    )
    const threadB = await createThread(executor, otherAccount, {
      subject: "Other account",
    })
    await createMessage(executor, {
      threadId: threadB,
      accountId: otherAccount,
      subject: "Other account",
      fromAddress: "alice@example.com",
      date: NOW,
    })
    await recomputeThreadCaches(executor, threadB)
    await setThreadFolder(executor, threadB, inboxB)
    // Same sender address, second account: stats are per account, and the
    // second account's row classifies important on its own.
    await upsertSenderStat(executor, otherAccount, "alice@example.com", {
      isReply: true,
      date: NOW,
    })

    const all = await listPriorityImportant(executor, null)
    expect(all.map((thread) => thread.id).sort()).toEqual(
      [aliceThread, threadB].sort()
    )
    expect(
      (await listPriorityImportant(executor, [accountId])).map(
        (thread) => thread.id
      )
    ).toEqual([aliceThread])
  })
})
