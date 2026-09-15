import { afterAll, beforeEach, describe, expect, it } from "vitest"

import {
  createAccount,
  createGmailLabel,
  createMessage,
  createThread,
} from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { removeAccount } from "../remove-account"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "../../../stores/account-store"

/**
 * Task 5.5: removal cascades to ALL local mail data of the account and
 * never touches other accounts. Runs against the real v1 schema (FKs ON)
 * through the node:sqlite executor; the store reload runs against the
 * same database via setAccountStoreExecutor.
 */

let executor: TestExecutor

async function seedMailData(accountId: string): Promise<void> {
  const threadId = await createThread(executor, accountId, {
    subject: `subject-${accountId}`,
  })
  await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_000_001,
    subject: `message-${accountId}`,
  })
  await createGmailLabel(executor, accountId, "INBOX", "INBOX", "inbox")
}

async function count(sql: string, params: string[]): Promise<number> {
  const rows = await executor.select<{ total: number }>(sql, params)
  return rows[0]?.total ?? 0
}

beforeEach(() => {
  executor = createTestExecutor()
  setAccountStoreExecutor(executor)
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: false,
  })
})

afterAll(() => {
  setAccountStoreExecutor(null)
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: false,
  })
})

describe("removeAccount", () => {
  it("deletes the account with all of its mail data and leaves the other account untouched", async () => {
    const removed = await createAccount(executor, "gmail")
    const kept = await createAccount(executor, "imap")
    await seedMailData(removed)
    await seedMailData(kept)
    // The removed account is the persisted active one — after removal the
    // restore chain must fall back to the surviving account.
    await executor.execute("UPDATE accounts SET is_active = 1 WHERE id = $1", [
      removed,
    ])

    await removeAccount(removed, { executor })

    // The account row is gone, every cascade target of the removed
    // account is gone, the other account and its data survive.
    expect(
      await count("SELECT COUNT(*) AS total FROM accounts WHERE id = $1", [
        removed,
      ])
    ).toBe(0)
    expect(await count("SELECT COUNT(*) AS total FROM accounts", [])).toBe(1)
    expect(
      await count(
        "SELECT COUNT(*) AS total FROM messages WHERE account_id = $1",
        [removed]
      )
    ).toBe(0)
    expect(
      await count(
        "SELECT COUNT(*) AS total FROM threads WHERE account_id = $1",
        [removed]
      )
    ).toBe(0)
    expect(
      await count(
        "SELECT COUNT(*) AS total FROM labels WHERE account_id = $1",
        [removed]
      )
    ).toBe(0)
    expect(
      await count(
        "SELECT COUNT(*) AS total FROM messages WHERE account_id = $1",
        [kept]
      )
    ).toBe(1)
    expect(
      await count(
        "SELECT COUNT(*) AS total FROM threads WHERE account_id = $1",
        [kept]
      )
    ).toBe(1)
    expect(
      await count(
        "SELECT COUNT(*) AS total FROM labels WHERE account_id = $1",
        [kept]
      )
    ).toBe(1)

    // The store reloaded: the removed account vanished and another
    // connected account auto-activated via the restore chain.
    const state = useAccountStore.getState()
    expect(state.accounts.map((account) => account.id)).toEqual([kept])
    expect(state.activeAccountId).toBe(kept)
  })

  it("removing the last account leaves the empty state with no active account", async () => {
    const only = await createAccount(executor, "gmail")
    await seedMailData(only)

    await removeAccount(only, { executor })

    expect(await count("SELECT COUNT(*) AS total FROM accounts", [])).toBe(0)
    expect(await count("SELECT COUNT(*) AS total FROM messages", [])).toBe(0)
    const state = useAccountStore.getState()
    expect(state.accounts).toEqual([])
    expect(state.activeAccountId).toBeNull()
  })

  it("keeps the persisted selection when a non-active account is removed", async () => {
    const first = await createAccount(executor, "gmail")
    const second = await createAccount(executor, "imap")
    await executor.execute("UPDATE accounts SET is_active = 1 WHERE id = $1", [
      second,
    ])

    await removeAccount(first, { executor })

    const state = useAccountStore.getState()
    expect(state.accounts.map((account) => account.id)).toEqual([second])
    expect(state.activeAccountId).toBe(second)
    const flagged = await executor.select<{ id: string }>(
      "SELECT id FROM accounts WHERE is_active = 1"
    )
    expect(flagged.map((row) => row.id)).toEqual([second])
  })
})
