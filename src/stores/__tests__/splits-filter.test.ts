import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createAccount,
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { recomputeThreadCaches } from "@/services/db/threads"
import { countThreadsForQuery } from "@/services/search"
import { createSplit } from "@/services/settings/splits"
import { setAccountStoreExecutor, useAccountStore } from "../account-store"
import {
  refreshThreadList,
  setThreadListStoreExecutor,
  useThreadListStore,
} from "../thread-list-store"
import { DEFAULT_VIEW, useUiStore } from "../ui-store"
import { enterSplit, leaveSplit } from "@/components/layout/use-splits"

/**
 * Splits end-to-end at the store level (task 9.3, design D4): a split is
 * created from a search query through the real CRUD helper (one JSON row
 * in the settings table), entered through the tab bar's real entry flow
 * (enterSplit → ui-store setListScope → thread-list-store refresh), and
 * the loaded rows must be EXACTLY the query's search results — the
 * across-accounts variant for an un-pinned split and the single account's
 * rows for an account-pinned one. The seeded mailbox spans two accounts
 * so "only matching" cannot pass by accident of scope.
 */

let executor: TestExecutor

function resetStores(): void {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    previousView: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    readingPane: "right",
    listScope: null,
  })
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: false,
  })
  useThreadListStore.setState({
    accountId: null,
    view: null,
    scope: null,
    threads: [],
    labelsByThreadId: {},
    loading: false,
    loaded: false,
  })
}

beforeEach(() => {
  resetStores()
  executor = createTestExecutor()
  setAccountStoreExecutor(executor)
  setThreadListStoreExecutor(executor)
})

afterEach(() => {
  setThreadListStoreExecutor(null)
  setAccountStoreExecutor(null)
  executor.close()
  resetStores()
})

/** Seed a thread + one message and rebuild the thread caches. */
async function seed(options: {
  accountId: string
  subject: string
  fromAddress: string
  date: number
  unread?: boolean
}): Promise<string> {
  const threadId = await createThread(executor, options.accountId, {
    subject: options.subject,
  })
  await createMessage(executor, {
    threadId,
    accountId: options.accountId,
    date: options.date,
    subject: options.subject,
    snippet: `${options.subject} snippet`,
    fromName: "Sender",
    fromAddress: options.fromAddress,
    isRead: !options.unread,
  })
  await recomputeThreadCaches(executor, threadId)
  return threadId
}

describe("a split created from a search filters the thread list (task 9.3)", () => {
  let accountA: string
  let accountB: string
  let bossA: string
  let bossB: string
  let otherA: string

  beforeEach(async () => {
    accountA = await createAccount(executor, "gmail")
    accountB = await createAccount(executor, "imap")
    // The search pipeline covers the whole mailbox (not just the inbox),
    // so the matches are deliberately outside any inbox label.
    bossA = await seed({
      accountId: accountA,
      subject: "Boss: quarterly numbers",
      fromAddress: "boss@work.com",
      date: Math.floor(Date.now() / 1000) - 60,
      unread: true,
    })
    bossB = await seed({
      accountId: accountB,
      subject: "Boss: pinging account B",
      fromAddress: "boss@work.com",
      date: Math.floor(Date.now() / 1000) - 120,
      unread: true,
    })
    otherA = await seed({
      accountId: accountA,
      subject: "Lunch plans",
      fromAddress: "alice@example.com",
      date: Math.floor(Date.now() / 1000) - 30,
      unread: true,
    })
    useAccountStore.setState({ activeAccountId: accountA, loaded: true })
  })

  it("an un-pinned split lists ONLY the query's matches across the accounts", async () => {
    // Create from a search, the way "Save as Split" does.
    const created = await createSplit(executor, {
      name: "Boss mail",
      query: "from:boss@work.com",
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return
    // Persisted as one JSON settings row, like the per-scope sorts.
    const rows = await executor.select<{ value: string }>(
      "SELECT value FROM settings WHERE key = 'mail.splits'"
    )
    expect(JSON.parse(rows[0]!.value)).toEqual([
      {
        id: created.split.id,
        name: "Boss mail",
        query: "from:boss@work.com",
        position: 0,
      },
    ])

    // Enter the split through the tab bar's real entry flow.
    await enterSplit(created.split)

    const state = useThreadListStore.getState()
    expect(state.scope).toEqual({
      kind: "split",
      name: "Boss mail",
      query: "from:boss@work.com",
    })
    // Only the boss threads — from BOTH accounts, merged date-desc — and
    // never the non-matching lunch thread.
    expect(state.threads.map((thread) => thread.id)).toEqual([bossA, bossB])
    expect(new Set(state.threads.map((thread) => thread.account_id))).toEqual(
      new Set([accountA, accountB])
    )
    // The tab bar's count helper agrees with the list it counts.
    const activeIds = [accountA, accountB]
    expect(
      await countThreadsForQuery(executor, activeIds, "from:boss@work.com")
    ).toBe(state.threads.length)

    // Leaving restores the underlying view's own list.
    await leaveSplit()
    expect(useUiStore.getState().listScope).toBeNull()
    await refreshThreadList()
    expect(useThreadListStore.getState().scope).toEqual({
      kind: "account",
      accountId: accountA,
      folder: { kind: "specialUse", specialUse: "inbox" },
    })
  })

  it("an account-pinned split stays within its account", async () => {
    const created = await createSplit(executor, {
      name: "Boss (A only)",
      query: "from:boss@work.com is:unread",
      accountId: accountB,
    })
    expect(created.ok).toBe(true)
    if (!created.ok) return

    await enterSplit(created.split)

    const state = useThreadListStore.getState()
    expect(state.scope).toEqual({
      kind: "split",
      name: "Boss (A only)",
      query: "from:boss@work.com is:unread",
      accountId: accountB,
    })
    // The other account's boss thread never leaks in, and the pin wins
    // even though the ACTIVE account is A.
    expect(state.threads.map((thread) => thread.id)).toEqual([bossB])
    expect(
      state.threads.every((thread) => thread.account_id === accountB)
    ).toBe(true)
    void otherA
  })
})
