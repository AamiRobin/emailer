import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { getTotalUnreadCount } from "../accounts"
import { at, createAccount, createMessage, createThread } from "./fixtures"
import { createTestExecutor, type TestExecutor } from "./test-executor"

describe("getTotalUnreadCount", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("returns 0 on a database without messages", async () => {
    await createAccount(executor, "gmail")

    expect(await getTotalUnreadCount(executor)).toBe(0)
  })

  it("sums unread messages across accounts, ignoring read ones", async () => {
    for (const accountId of [
      await createAccount(executor, "gmail"),
      await createAccount(executor, "imap"),
    ]) {
      const threadId = await createThread(executor, accountId)
      await createMessage(executor, { threadId, accountId, date: at(1) })
      await createMessage(executor, {
        threadId,
        accountId,
        date: at(2),
        isRead: true,
      })
    }

    // 2 unread total (one per account); the read messages do not count.
    expect(await getTotalUnreadCount(executor)).toBe(2)
  })
})
