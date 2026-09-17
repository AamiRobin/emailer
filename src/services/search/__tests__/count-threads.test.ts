import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  at,
  createAccount,
  createGmailLabel,
  createMessage,
  createThread,
} from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { recomputeThreadCaches, setThreadLabels } from "../../db/threads"
import { countThreadsForQuery } from "../index"

/**
 * countThreadsForQuery (task 9.3): the split tab bar's per-tab counts.
 * The helper must see exactly the result set the search pipeline lists —
 * same account-set restriction, same trash/spam exclusions, same operator
 * and FTS matching — just COUNTed instead of returned.
 */

let executor: TestExecutor
let accountA: string
let accountB: string

/** Seed a thread + one message and rebuild the thread caches. */
async function seed(options: {
  accountId: string
  subject: string
  fromName: string
  fromAddress: string
  date: number
  isRead?: boolean
}): Promise<string> {
  const threadId = await createThread(executor, options.accountId, {
    subject: options.subject,
  })
  await createMessage(executor, {
    threadId,
    accountId: options.accountId,
    date: options.date,
    subject: options.subject,
    snippet: options.subject,
    fromName: options.fromName,
    fromAddress: options.fromAddress,
    isRead: options.isRead,
  })
  await recomputeThreadCaches(executor, threadId)
  return threadId
}

beforeEach(async () => {
  executor = createTestExecutor()
  accountA = await createAccount(executor, "gmail")
  accountB = await createAccount(executor, "imap")
})

afterEach(() => {
  executor.close()
})

describe("countThreadsForQuery (task 9.3)", () => {
  it("counts matches across the account set like the search would", async () => {
    await seed({
      accountId: accountA,
      subject: "Report from boss",
      fromName: "Boss",
      fromAddress: "boss@work.com",
      date: at(100),
    })
    await seed({
      accountId: accountB,
      subject: "Boss pings account B",
      fromName: "Boss",
      fromAddress: "boss@work.com",
      date: at(200),
    })
    await seed({
      accountId: accountA,
      subject: "Unrelated",
      fromName: "Alice",
      fromAddress: "alice@x.com",
      date: at(300),
    })

    expect(
      await countThreadsForQuery(executor, [accountA, accountB], "from:boss")
    ).toBe(2)
    expect(await countThreadsForQuery(executor, [accountA], "from:boss")).toBe(
      1
    )
    expect(await countThreadsForQuery(executor, [accountB], "from:boss")).toBe(
      1
    )
    // Free text rides the same FTS index as search.
    expect(
      await countThreadsForQuery(executor, [accountA, accountB], "report")
    ).toBe(1)
  })

  it("counts flag operators over the thread caches", async () => {
    await seed({
      accountId: accountA,
      subject: "Unread one",
      fromName: "Biz",
      fromAddress: "biz@x.com",
      date: at(100),
    })
    await seed({
      accountId: accountB,
      subject: "Unread two",
      fromName: "Biz",
      fromAddress: "biz@x.com",
      date: at(200),
    })
    await seed({
      accountId: accountB,
      subject: "Read three",
      fromName: "Biz",
      fromAddress: "biz@x.com",
      date: at(300),
      isRead: true,
    })

    expect(
      await countThreadsForQuery(executor, [accountA, accountB], "is:unread")
    ).toBe(2)
    expect(
      await countThreadsForQuery(executor, [accountB], "is:unread biz")
    ).toBe(1)
  })

  it("excludes trashed threads from the count", async () => {
    const live = await seed({
      accountId: accountA,
      subject: "Live roadmap",
      fromName: "Biz",
      fromAddress: "biz@x.com",
      date: at(100),
    })
    const trashed = await seed({
      accountId: accountA,
      subject: "Trashed roadmap",
      fromName: "Biz",
      fromAddress: "biz@x.com",
      date: at(200),
    })
    const trashLabel = await createGmailLabel(
      executor,
      accountA,
      "TRASH",
      "TRASH",
      "trash"
    )
    await setThreadLabels(executor, trashed, [trashLabel])
    void live

    expect(await countThreadsForQuery(executor, [accountA], "roadmap")).toBe(1)
  })

  it("counts 0 for empty queries and empty account sets", async () => {
    await seed({
      accountId: accountA,
      subject: "Anything",
      fromName: "Biz",
      fromAddress: "biz@x.com",
      date: at(100),
    })
    expect(await countThreadsForQuery(executor, [accountA], "")).toBe(0)
    expect(await countThreadsForQuery(executor, [accountA], "   ")).toBe(0)
    expect(await countThreadsForQuery(executor, [accountA], "from:")).toBe(0)
    expect(await countThreadsForQuery(executor, [], "anything")).toBe(0)
  })
})
