import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  setAccountStoreExecutor,
  useAccountStore,
  type AccountStatus,
  type AccountType,
} from "../account-store"

/**
 * Store tests run the real SQL against the node:sqlite test executor
 * (injected via setAccountStoreExecutor — tauri-plugin-sql cannot execute
 * under vitest). State is reset between tests by writing the initial state
 * back through useAccountStore.setState; the store keeps no localStorage —
 * the active account lives in accounts.is_active.
 */

let executor: TestExecutor
let idSequence = 0

function resetStore(): void {
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: false,
  })
}

interface SeedAccountOptions {
  email: string
  displayName?: string
  type?: AccountType
  status?: AccountStatus
  isActive?: boolean
}

async function seedAccount(options: SeedAccountOptions): Promise<string> {
  idSequence += 1
  const id = `acc-${idSequence}`
  await executor.execute(
    `INSERT INTO accounts (id, type, email, display_name, status, is_active)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      options.type ?? "gmail",
      options.email,
      options.displayName ?? null,
      options.status ?? "active",
      options.isActive ? 1 : 0,
    ]
  )
  return id
}

async function seedUnread(
  accountId: string,
  unread: number,
  read = 0
): Promise<void> {
  for (let index = 0; index < unread + read; index += 1) {
    idSequence += 1
    const threadId = `th-${idSequence}`
    await executor.execute(
      "INSERT INTO threads (id, account_id) VALUES ($1, $2)",
      [threadId, accountId]
    )
    await executor.execute(
      `INSERT INTO messages (id, thread_id, account_id, date, is_read)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        `msg-${idSequence}`,
        threadId,
        accountId,
        1_700_000_000 + index,
        index < read ? 1 : 0,
      ]
    )
  }
}

async function persistedActiveId(): Promise<string | null> {
  const rows = await executor.select<{ id: string }>(
    "SELECT id FROM accounts WHERE is_active = 1"
  )
  return rows[0]?.id ?? null
}

beforeEach(() => {
  executor = createTestExecutor()
  setAccountStoreExecutor(executor)
  idSequence = 0
  resetStore()
})

afterEach(() => {
  setAccountStoreExecutor(null)
  executor.close()
})

describe("account store", () => {
  it("init with no accounts loads an empty list and no active account", async () => {
    await useAccountStore.getState().init()

    const state = useAccountStore.getState()
    expect(state.accounts).toEqual([])
    expect(state.activeAccountId).toBeNull()
    expect(state.loaded).toBe(true)
  })

  it("init restores the last active account from the is_active flag", async () => {
    await seedAccount({ email: "one@example.com", displayName: "One" })
    const secondId = await seedAccount({ email: "two@example.com" })
    const thirdId = await seedAccount({
      email: "three@example.com",
      isActive: true,
    })
    await seedUnread(secondId, 2, 1)

    await useAccountStore.getState().init()

    const state = useAccountStore.getState()
    expect(state.activeAccountId).toBe(thirdId)
    expect(state.accounts).toHaveLength(3)
    // AccountInfo mapping + unread aggregate from the initial load
    const second = state.accounts.find((account) => account.id === secondId)
    expect(second).toMatchObject({
      email: "two@example.com",
      displayName: null,
      type: "gmail",
      status: "active",
      unreadCount: 2,
    })
  })

  it("init falls back to the first active-status account when no is_active flag is set", async () => {
    const firstId = await seedAccount({ email: "one@example.com" })
    await seedAccount({
      email: "broken@example.com",
      status: "auth-error",
    })

    await useAccountStore.getState().init()

    expect(useAccountStore.getState().activeAccountId).toBe(firstId)
  })

  it("init honors the is_active flag even on an auth-error account", async () => {
    await seedAccount({ email: "one@example.com" })
    const brokenId = await seedAccount({
      email: "broken@example.com",
      status: "auth-error",
      isActive: true,
    })

    await useAccountStore.getState().init()

    expect(useAccountStore.getState().activeAccountId).toBe(brokenId)
  })

  it("init with only auth-error accounts and no flag leaves no active account", async () => {
    await seedAccount({
      email: "broken@example.com",
      status: "auth-error",
    })

    await useAccountStore.getState().init()

    expect(useAccountStore.getState().activeAccountId).toBeNull()
  })

  it("init after a completed load is a no-op and keeps the current selection", async () => {
    const firstId = await seedAccount({ email: "one@example.com" })
    const secondId = await seedAccount({ email: "two@example.com" })

    const { init, setActive } = useAccountStore.getState()
    await init()
    await setActive(secondId)

    await useAccountStore.getState().init()

    expect(useAccountStore.getState().activeAccountId).toBe(secondId)
    expect(await persistedActiveId()).toBe(secondId)
    expect(useAccountStore.getState().accounts.map((a) => a.id)).toContain(
      firstId
    )
  })

  it("setActive switches instantly and persists is_active to the database", async () => {
    const firstId = await seedAccount({
      email: "one@example.com",
      isActive: true,
    })
    const secondId = await seedAccount({ email: "two@example.com" })
    await useAccountStore.getState().init()
    expect(useAccountStore.getState().activeAccountId).toBe(firstId)

    await useAccountStore.getState().setActive(secondId)

    // instant, in-memory switch
    expect(useAccountStore.getState().activeAccountId).toBe(secondId)
    // persisted: exactly the new account is flagged
    expect(await persistedActiveId()).toBe(secondId)
    const flagged = await executor.select<{ is_active: number }>(
      "SELECT is_active FROM accounts WHERE id = $1",
      [firstId]
    )
    expect(flagged[0]?.is_active).toBe(0)
  })

  it("setActive ignores unknown account ids", async () => {
    const firstId = await seedAccount({
      email: "one@example.com",
      isActive: true,
    })
    await useAccountStore.getState().init()

    await useAccountStore.getState().setActive("missing-id")

    expect(useAccountStore.getState().activeAccountId).toBe(firstId)
    expect(await persistedActiveId()).toBe(firstId)
  })

  it("refreshUnreadCounts re-aggregates unread messages per account", async () => {
    const firstId = await seedAccount({
      email: "one@example.com",
      isActive: true,
    })
    const secondId = await seedAccount({ email: "two@example.com" })
    await useAccountStore.getState().init()
    expect(
      useAccountStore
        .getState()
        .accounts.every((account) => account.unreadCount === 0)
    ).toBe(true)

    await seedUnread(firstId, 2)
    await seedUnread(secondId, 4, 2)
    await useAccountStore.getState().refreshUnreadCounts()

    const accounts = useAccountStore.getState().accounts
    expect(
      accounts.find((account) => account.id === firstId)?.unreadCount
    ).toBe(2)
    expect(
      accounts.find((account) => account.id === secondId)?.unreadCount
    ).toBe(4)
  })

  it("reload re-applies the restore semantics after the flag changed on disk", async () => {
    const firstId = await seedAccount({
      email: "one@example.com",
      isActive: true,
    })
    const secondId = await seedAccount({ email: "two@example.com" })
    await useAccountStore.getState().init()
    await useAccountStore.getState().setActive(secondId)

    // Simulate another writer flipping the flag (e.g. task 5.5 activation)
    await executor.execute("UPDATE accounts SET is_active = 0 WHERE id = $1", [
      secondId,
    ])
    await executor.execute("UPDATE accounts SET is_active = 1 WHERE id = $1", [
      firstId,
    ])
    await useAccountStore.getState().reload()

    expect(useAccountStore.getState().activeAccountId).toBe(firstId)
  })
})
