import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  flagAllAccountsForReauth,
  getTotalUnreadCount,
  listActiveAccounts,
} from "../accounts"
import { at, createAccount, createMessage, createThread } from "./fixtures"
import { createTestExecutor, type TestExecutor } from "./test-executor"
import { snoozeThread, wakeDueThreads } from "../../email-actions/snooze"
import { muteThread, unmuteThread } from "../../email-actions/thread-states"

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

  it("excludes unread messages in snoozed threads until they wake", async () => {
    const accountId = await createAccount(executor, "gmail")
    const threadId = await createThread(executor, accountId)
    await createMessage(executor, { threadId, accountId, date: at(1) })
    await createMessage(executor, { threadId, accountId, date: at(2) })

    expect(await getTotalUnreadCount(executor)).toBe(2)

    // Snoozed: the unread messages stop counting toward the OS badge
    // (read state untouched — query-level exclusion, task 2.2)…
    await snoozeThread(executor, threadId, at(1000))
    expect(await getTotalUnreadCount(executor)).toBe(0)

    // …and re-count once the wake-up (due pass / startup sweep) runs.
    expect(await wakeDueThreads(executor, at(2000))).toBe(1)
    expect(await getTotalUnreadCount(executor)).toBe(2)
  })

  it("excludes unread messages in muted threads until they are unmuted", async () => {
    const accountId = await createAccount(executor, "gmail")
    const threadId = await createThread(executor, accountId)
    await createMessage(executor, { threadId, accountId, date: at(1) })
    await createMessage(executor, { threadId, accountId, date: at(2) })

    expect(await getTotalUnreadCount(executor)).toBe(2)

    // Muted: the unread messages stop counting toward the OS badge
    // (spec: muted is excluded from unread counts; read state untouched —
    // task 3.1, same query-level pattern as snooze)…
    await muteThread(executor, threadId)
    expect(await getTotalUnreadCount(executor)).toBe(0)

    // …and re-count once the thread is unmuted.
    await unmuteThread(executor, threadId)
    expect(await getTotalUnreadCount(executor)).toBe(2)
  })
})

describe("listActiveAccounts", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("is unchanged by an account switch (the is_active flag is selection, not enablement)", async () => {
    const accountA = await createAccount(executor, "gmail")
    const accountB = await createAccount(executor, "imap")

    // Before any switch: every active-status account.
    const before = await listActiveAccounts(executor)
    expect(before.map((row) => row.id).sort()).toEqual(
      [accountA, accountB].sort()
    )

    // persistActiveAccount (account-store) clears the flag on every row
    // and sets it on the chosen one — switching to B must not shrink the
    // sync/aggregation set: A keeps syncing and stays in the unified inbox.
    await executor.execute("UPDATE accounts SET is_active = 0")
    await executor.execute("UPDATE accounts SET is_active = 1 WHERE id = $1", [
      accountB,
    ])

    const after = await listActiveAccounts(executor)
    expect(after.map((row) => row.id).sort()).toEqual(
      [accountA, accountB].sort()
    )
  })

  it("still excludes auth-error accounts regardless of the flag", async () => {
    const healthy = await createAccount(executor, "gmail")
    const paused = await createAccount(executor, "imap")
    await executor.execute(
      "UPDATE accounts SET status = 'auth-error', is_active = 1 WHERE id = $1",
      [paused]
    )

    const rows = await listActiveAccounts(executor)
    expect(rows.map((row) => row.id)).toEqual([healthy])
  })
})

describe("flagAllAccountsForReauth (task 5.4, restore side)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("flips every account to the persisted needs-reauth state and lifts with re-auth", async () => {
    const gmail = await createAccount(executor, "gmail")
    const imap = await createAccount(executor, "imap")
    // An account that was ALREADY paused (a pre-existing auth failure)
    // must not inflate the count.
    await executor.execute(
      "UPDATE accounts SET status = 'auth-error' WHERE id = $1",
      [imap]
    )

    const flagged = await flagAllAccountsForReauth(executor)
    expect(flagged).toBe(1)

    // The flag IS the accounts table's status column: the sync gate
    // (listActiveAccounts) and the send gate (status "auth-error") pick
    // it up from the same persisted value, so it survives restarts.
    const statuses = await executor.select<{ id: string; status: string }>(
      "SELECT id, status FROM accounts ORDER BY id"
    )
    expect(statuses).toEqual([
      { id: gmail, status: "auth-error" },
      { id: imap, status: "auth-error" },
    ])
    expect(await listActiveAccounts(executor)).toEqual([])

    // A second pass is a no-op: nothing left to flag.
    expect(await flagAllAccountsForReauth(executor)).toBe(0)

    // A successful re-auth flips the row back (reauth.ts finishReauth)
    // and the account syncs again.
    await executor.execute(
      "UPDATE accounts SET status = 'active' WHERE id = $1",
      [gmail]
    )
    expect((await listActiveAccounts(executor)).map((row) => row.id)).toEqual([
      gmail,
    ])
  })

  it("keeps restored mail readable offline while the flag is set", async () => {
    const accountId = await createAccount(executor, "gmail")
    const threadId = await createThread(executor, accountId)
    await createMessage(executor, { threadId, accountId, date: at(1) })

    await flagAllAccountsForReauth(executor)

    // Reading never consults account status: the unread count — a plain
    // mailbox aggregation — is unchanged by the needs-reauth flag.
    expect(await getTotalUnreadCount(executor)).toBe(1)
  })
})
