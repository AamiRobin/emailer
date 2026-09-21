import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  assignAccountToProfile,
  createProfile,
  deleteProfile,
  setAccountColorOverride,
} from "@/services/db/account-profiles"
import { snoozeThread, wakeDueThreads } from "@/services/email-actions/snooze"
import {
  muteThread,
  unmuteThread,
} from "@/services/email-actions/thread-states"
import { accountHue } from "@/components/email/account-hue"
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
    effectiveColors: {},
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
): Promise<string[]> {
  const threadIds: string[] = []
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
    threadIds.push(threadId)
  }
  return threadIds
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

  it("per-account counts exclude snoozed and muted threads (same exclusion as the OS badge)", async () => {
    const firstId = await seedAccount({
      email: "one@example.com",
      isActive: true,
    })
    await seedAccount({ email: "two@example.com" })
    const [, snoozedThread, mutedThread] = await seedUnread(firstId, 3)
    await useAccountStore.getState().init()
    expect(
      useAccountStore.getState().accounts.find((a) => a.id === firstId)
        ?.unreadCount
    ).toBe(3)

    // Snoozed (task 2.2 carry-over) and muted (task 3.1) threads stop
    // counting toward the switcher badges — UNREAD_BY_ACCOUNT_SQL applies
    // the same exclusion predicate as getTotalUnreadCount's OS badge.
    await snoozeThread(executor, snoozedThread, 1_700_000_500)
    await muteThread(executor, mutedThread)

    // refreshUnreadCounts runs the shared aggregate…
    await useAccountStore.getState().refreshUnreadCounts()
    expect(
      useAccountStore.getState().accounts.find((a) => a.id === firstId)
        ?.unreadCount
    ).toBe(1)

    // …and so does the initial load (the two call sites share one SQL
    // constant and cannot drift).
    await useAccountStore.getState().reload()
    expect(
      useAccountStore.getState().accounts.find((a) => a.id === firstId)
        ?.unreadCount
    ).toBe(1)

    // Clearing the flags restores the counts without any read-state change.
    await unmuteThread(executor, mutedThread)
    expect(await wakeDueThreads(executor, 1_700_001_000)).toBe(1)
    await useAccountStore.getState().refreshUnreadCounts()
    expect(
      useAccountStore.getState().accounts.find((a) => a.id === firstId)
        ?.unreadCount
    ).toBe(3)
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

/**
 * effectiveColor (parity-round-2 task 4.4, design D10): the account store
 * resolves the accounts spec's chain — per-account override, else the
 * profile color, else the individual/generated color — into a reactive
 * map rebuilt at load and on refreshProfileColors().
 */
describe("account store effectiveColor (parity-round-2 task 4.4)", () => {
  let executor: TestExecutor
  let idSequence = 0

  function resetStore(): void {
    useAccountStore.setState({
      accounts: [],
      activeAccountId: null,
      effectiveColors: {},
      loaded: false,
    })
  }

  async function seedAccount(email: string): Promise<string> {
    idSequence += 1
    const id = `acc-${idSequence}`
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      [id, "gmail", email]
    )
    return id
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

  it("falls back to the generated hue when no profile or override exists", async () => {
    const accountId = await seedAccount("plain@example.com")
    await useAccountStore.getState().init()

    const expected = `hsl(${accountHue(accountId)} 55% 50%)`
    expect(useAccountStore.getState().effectiveColor(accountId)).toBe(expected)
    // The same value the unified-inbox badge derives, so an unprofiled
    // account's marker and badge always agree.
    expect(useAccountStore.getState().effectiveColors[accountId]).toBe(
      expected
    )
  })

  it("resolves the profile color for assigned accounts", async () => {
    const workId = await seedAccount("one@example.com")
    const otherId = await seedAccount("two@example.com")
    const profile = await createProfile(executor, {
      name: "Work",
      color: "#8b5cf6",
    })
    await assignAccountToProfile(executor, workId, profile.id)
    await useAccountStore.getState().init()

    expect(useAccountStore.getState().effectiveColor(workId)).toBe("#8b5cf6")
    // The unassigned sibling keeps its generated hue.
    expect(useAccountStore.getState().effectiveColor(otherId)).toBe(
      `hsl(${accountHue(otherId)} 55% 50%)`
    )
  })

  it("prefers the per-account override over the profile color (siblings keep the profile color)", async () => {
    const overriddenId = await seedAccount("one@example.com")
    const siblingId = await seedAccount("two@example.com")
    const profile = await createProfile(executor, {
      name: "Work",
      color: "#8b5cf6",
    })
    await assignAccountToProfile(executor, overriddenId, profile.id)
    await assignAccountToProfile(executor, siblingId, profile.id)
    await setAccountColorOverride(executor, overriddenId, "#f97316")
    await useAccountStore.getState().init()

    // The accounts spec's per-account-override scenario: the overriding
    // account shows orange while its profile siblings keep purple.
    expect(useAccountStore.getState().effectiveColor(overriddenId)).toBe(
      "#f97316"
    )
    expect(useAccountStore.getState().effectiveColor(siblingId)).toBe(
      "#8b5cf6"
    )
  })

  it("refreshProfileColors re-resolves after a profiles edit without a full reload", async () => {
    const accountId = await seedAccount("one@example.com")
    await useAccountStore.getState().init()
    const generated = `hsl(${accountHue(accountId)} 55% 50%)`
    expect(useAccountStore.getState().effectiveColor(accountId)).toBe(generated)

    const profile = await createProfile(executor, {
      name: "Work",
      color: "#8b5cf6",
    })
    await assignAccountToProfile(executor, accountId, profile.id)
    await useAccountStore.getState().refreshProfileColors()
    expect(useAccountStore.getState().effectiveColor(accountId)).toBe(
      "#8b5cf6"
    )

    // A rename/re-color + refresh flows through the same seam.
    await setAccountColorOverride(executor, accountId, "#22c55e")
    await useAccountStore.getState().refreshProfileColors()
    expect(useAccountStore.getState().effectiveColor(accountId)).toBe(
      "#22c55e"
    )

    // Delete-keeps-accounts: after the profile goes, the effective color
    // falls back (override survives deletion — the individual color).
    await deleteProfile(executor, profile.id)
    await useAccountStore.getState().refreshProfileColors()
    expect(useAccountStore.getState().effectiveColor(accountId)).toBe(
      "#22c55e"
    )
    // A full reload re-derives the same map from the same rows.
    await useAccountStore.getState().reload()
    expect(useAccountStore.getState().effectiveColor(accountId)).toBe(
      "#22c55e"
    )
  })

  it("effectiveColor returns null for unknown account ids", async () => {
    await useAccountStore.getState().init()
    expect(useAccountStore.getState().effectiveColor("missing")).toBeNull()
  })
})
