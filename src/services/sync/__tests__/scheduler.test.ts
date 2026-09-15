import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createAccount,
  createMessage,
  createThread,
} from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import type { SqlExecutor } from "../../db/executor"
import { registerProvider } from "../../email/provider-factory"
import { createImapSmtpProvider } from "../../email/imap-smtp-provider"
import type {
  ConnectionTestResult,
  EmailAccount,
  EmailProvider,
} from "../../email/types"
import { ProviderAuthError } from "../../email/types"
import { useSyncStore } from "../../../stores/sync-store"
import { useAccountStore } from "../../../stores/account-store"
import { notifyNewMail } from "../../notifications/new-mail-notifier"
import { updateUnreadBadge } from "../../notifications/unread-badge"
import type { SyncAllResult } from "../scheduler"
import {
  AccountSyncAuthError,
  setSyncAccountImplForTests,
  startScheduler,
  stopScheduler,
  syncAccount,
  triggerRefresh,
} from "../scheduler"

// The scheduler resolves its executor through getExecutor(); point that at
// the shared in-memory test database for the whole suite. Everything else
// (accounts queries, sqlite schema) runs for real.
let executor: TestExecutor | null = null

vi.mock("../../db/executor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../db/executor")>()
  return {
    ...actual,
    getExecutor: (): SqlExecutor => {
      if (!executor) throw new Error("test executor not initialized")
      return executor
    },
  }
})

// OS side effects of a pass (task 4.6): the notification and badge
// modules are mocked so the passes here assert the wiring only.
vi.mock("../../notifications/new-mail-notifier", () => ({
  notifyNewMail: vi.fn(),
}))

vi.mock("../../notifications/unread-badge", () => ({
  updateUnreadBadge: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface SyncRecorder {
  calls: string[]
  concurrent: number
  maxConcurrent: number
  /** When set, the next sync blocks until the promise is resolved. */
  gate: Promise<void> | null
  /** Fail this account (plain error unless authError). */
  failing?: { accountId: string; authError?: boolean }
}

function makeRecorder(recorder: SyncRecorder) {
  return async (account: EmailAccount): Promise<void> => {
    if (recorder.failing?.accountId === account.id) {
      throw recorder.failing.authError
        ? new AccountSyncAuthError(account.id, "token expired")
        : new Error(`sync failed for ${account.id}`)
    }
    recorder.calls.push(account.id)
    recorder.concurrent += 1
    recorder.maxConcurrent = Math.max(
      recorder.maxConcurrent,
      recorder.concurrent
    )
    if (recorder.gate) await recorder.gate
    recorder.concurrent -= 1
  }
}

async function createAccountRow(
  type: "gmail" | "imap",
  overrides: { status?: string; isActive?: number } = {}
): Promise<string> {
  const id = await createAccount(executor as TestExecutor, type)
  await executor?.execute(
    `UPDATE accounts SET
       status = $1, is_active = $2, last_sync_at = $3
     WHERE id = $4`,
    [overrides.status ?? "active", overrides.isActive ?? 1, 1_700_000_000, id]
  )
  return id
}

function storeState() {
  return useSyncStore.getState()
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

describe("sync scheduler", () => {
  let recorder: SyncRecorder

  beforeEach(() => {
    executor = createTestExecutor()
    recorder = { calls: [], concurrent: 0, maxConcurrent: 0, gate: null }
    setSyncAccountImplForTests(makeRecorder(recorder))
  })

  afterEach(() => {
    stopScheduler()
    setSyncAccountImplForTests(null)
    vi.useRealTimers()
    useSyncStore.setState({ perAccount: {}, online: true })
    useAccountStore.setState({
      accounts: [],
      activeAccountId: null,
      loaded: false,
    })
    executor?.close()
    executor = null
  })

  it("triggerRefresh syncs all active accounts immediately and updates the store", async () => {
    const first = await createAccountRow("gmail")
    const second = await createAccountRow("imap")

    const result = await triggerRefresh()

    expect(result.synced.sort()).toEqual([first, second].sort())
    expect(result.errors).toEqual([])
    expect(recorder.calls.sort()).toEqual([first, second].sort())
    expect(recorder.maxConcurrent).toBe(1)

    // store: back to idle with the DB last_sync_at read back after the pass
    const state = storeState().perAccount
    expect(state[first]).toMatchObject({
      status: "idle",
      lastSyncAt: 1_700_000_000,
      error: undefined,
    })
    expect(state[second]?.status).toBe("idle")
  })

  it("triggerRefresh(accountId) syncs only that account", async () => {
    await createAccountRow("gmail")
    const target = await createAccountRow("gmail")

    const result = await triggerRefresh(target)

    expect(result.synced).toEqual([target])
    expect(recorder.calls).toEqual([target])
  })

  it("skips accounts that are auth-error or disabled", async () => {
    await createAccountRow("gmail", { status: "auth-error" })
    const active = await createAccountRow("gmail")
    await createAccountRow("imap", { isActive: 0 })

    const result = await triggerRefresh()

    expect(result.synced).toEqual([active])
    expect(recorder.calls).toEqual([active])
  })

  it("isolates per-account errors and still syncs the rest", async () => {
    const failing = await createAccountRow("gmail")
    const healthy = await createAccountRow("imap")
    recorder.failing = { accountId: failing }

    const result = await triggerRefresh()

    expect(result.synced).toEqual([healthy])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.accountId).toBe(failing)
    expect(result.errors[0]?.error).toBeInstanceOf(Error)

    const state = storeState().perAccount
    expect(state[failing]).toMatchObject({
      status: "error",
      error: `sync failed for ${failing}`,
    })
    // the healthy account synced regardless
    expect(state[healthy]?.status).toBe("idle")
  })

  it("surfaces the typed auth-error marker from the pass", async () => {
    const failing = await createAccountRow("gmail")
    recorder.failing = { accountId: failing, authError: true }

    const result = await triggerRefresh()

    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]?.error).toBeInstanceOf(AccountSyncAuthError)
    expect(storeState().perAccount[failing]?.status).toBe("error")
  })

  it("persists auth-error status for the failing account; others keep syncing", async () => {
    const failing = await createAccountRow("gmail")
    const healthy = await createAccountRow("imap")
    recorder.failing = { accountId: failing, authError: true }
    const failingEmail = (
      await executor?.select<{ email: string }>(
        "SELECT email FROM accounts WHERE id = $1",
        [failing]
      )
    )?.[0]?.email

    const result = await triggerRefresh()

    // Error isolation is unchanged: the healthy account synced.
    expect(result.synced).toEqual([healthy])

    // The failure was persisted: only the failing row flipped to the
    // durable auth-error state (survives restarts, 5.6).
    const rows = await executor?.select<{ id: string; status: string }>(
      "SELECT id, status FROM accounts"
    )
    const statusById = new Map(rows?.map((row) => [row.id, row.status]))
    expect(statusById.get(failing)).toBe("auth-error")
    expect(statusById.get(healthy)).toBe("active")

    // The sync-store error names the account, and the switcher reloaded —
    // the paused account now reports auth-error there too.
    expect(storeState().perAccount[failing]?.error).toContain(failingEmail)
    const storeAccount = useAccountStore
      .getState()
      .accounts.find((account) => account.id === failing)
    expect(storeAccount?.status).toBe("auth-error")

    // Later passes skip the paused account entirely.
    recorder.failing = undefined
    recorder.calls = []
    const second = await triggerRefresh()
    expect(second.synced).toEqual([healthy])
    expect(second.errors).toEqual([])
    expect(recorder.calls).toEqual([healthy])
  })

  it("interval fires syncAllAccounts periodically", async () => {
    vi.useFakeTimers()
    await createAccountRow("gmail")
    startScheduler({ intervalMs: 60_000 })

    await vi.advanceTimersByTimeAsync(59_999)
    expect(recorder.calls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(recorder.calls).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(recorder.calls).toHaveLength(2)

    stopScheduler()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(recorder.calls).toHaveLength(2)
  })

  it("coalesces overlapping triggers into a single drain pass (single-flight)", async () => {
    const first = await createAccountRow("gmail")
    const second = await createAccountRow("imap")

    let releaseGate!: () => void
    recorder.gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })

    const runOne = triggerRefresh()
    // first account is stuck in the gate; second runs after it
    await vi.waitFor(() => expect(recorder.calls).toEqual([first]))

    // overlapping triggers while the pass is in flight
    const runTwo = triggerRefresh()
    const runThree = triggerRefresh(first)

    releaseGate()
    const [resultOne, resultTwo, resultThree] = await Promise.all([
      runOne,
      runTwo,
      runThree,
    ])

    // pass 1 (first, second) + exactly one drain pass (first, second)
    expect(recorder.calls).toEqual([first, second, first, second])
    expect(recorder.maxConcurrent).toBe(1)
    for (const result of [
      resultOne,
      resultTwo,
      resultThree,
    ] as SyncAllResult[]) {
      expect(result.errors).toEqual([])
    }
    expect(resultThree.synced.sort()).toEqual([first, second].sort())
  })

  it("syncAccount rethrows provider auth failures as the typed marker", async () => {
    const accountId = await createAccountRow("imap")
    const rows = await executor?.select<{ email: string }>(
      "SELECT email FROM accounts WHERE id = $1",
      [accountId]
    )
    const account: EmailAccount = {
      id: accountId,
      type: "imap",
      email: rows?.[0]?.email ?? "",
      status: "active",
      isActive: true,
      isPinned: false,
      imapHost: "imap.example.com",
      imapPort: 993,
    }

    // Stand-in imap provider: listFolders is the first call the imap sync
    // engine makes and it rejects with the shared auth error.
    const denied = new ProviderAuthError(
      accountId,
      "imap",
      "invalid credentials"
    )
    const throwingProvider: EmailProvider = {
      accountId,
      type: "imap",
      async listFolders(): Promise<never> {
        throw denied
      },
      async deltaSync(): Promise<never> {
        throw denied
      },
      async fetchMessages(): Promise<never> {
        throw denied
      },
      async fetchFlags(): Promise<never> {
        throw denied
      },
      async storeFlags(): Promise<never> {
        throw denied
      },
      async markRead(): Promise<never> {
        throw denied
      },
      async markStarred(): Promise<never> {
        throw denied
      },
      async addLabels(): Promise<never> {
        throw denied
      },
      async removeLabels(): Promise<never> {
        throw denied
      },
      async archive(): Promise<never> {
        throw denied
      },
      async trash(): Promise<never> {
        throw denied
      },
      async moveToFolder(): Promise<never> {
        throw denied
      },
      async deleteForever(): Promise<never> {
        throw denied
      },
      async sendMessage(): Promise<never> {
        throw denied
      },
      async appendMessage(): Promise<never> {
        throw denied
      },
      async testConnection(): Promise<ConnectionTestResult> {
        return { success: false, message: "denied", authError: true }
      },
    }
    registerProvider("imap", () => throwingProvider)

    await expect(syncAccount(account)).rejects.toMatchObject({
      name: "AccountSyncAuthError",
      accountId,
    })

    // restore the real imap registration (the factory is per-test-file)
    registerProvider("imap", createImapSmtpProvider)
  })

  it("manual refresh on a missing account resolves without syncing", async () => {
    const result = await triggerRefresh("does-not-exist")
    expect(result).toEqual({ synced: [], errors: [] })
    expect(recorder.calls).toEqual([])
  })
})

describe("scheduler → new-mail notification and badge wiring", () => {
  /** Outcome returned by the fake per-account sync (undefined → void). */
  let nextOutcome: { newMessages: number } | undefined

  beforeEach(() => {
    executor = createTestExecutor()
    nextOutcome = undefined
    vi.mocked(notifyNewMail).mockClear()
    vi.mocked(updateUnreadBadge).mockClear()
    setSyncAccountImplForTests(async () => nextOutcome)
  })

  afterEach(() => {
    stopScheduler()
    setSyncAccountImplForTests(null)
    useSyncStore.setState({ perAccount: {}, online: true })
    useAccountStore.setState({
      accounts: [],
      activeAccountId: null,
      loaded: false,
    })
    executor?.close()
    executor = null
  })

  it("notifies when an account sync reports new messages", async () => {
    const id = await createAccountRow("gmail")
    nextOutcome = { newMessages: 3 }
    const rows = await executor?.select<{ email: string }>(
      "SELECT email FROM accounts WHERE id = $1",
      [id]
    )

    await triggerRefresh()

    expect(vi.mocked(notifyNewMail)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(notifyNewMail)).toHaveBeenCalledWith({
      accountId: id,
      accountEmail: rows?.[0]?.email ?? "",
      count: 3,
    })
  })

  it("does not notify when the sync reports no new messages", async () => {
    await createAccountRow("imap")
    nextOutcome = { newMessages: 0 }

    await triggerRefresh()

    expect(vi.mocked(notifyNewMail)).not.toHaveBeenCalled()
  })

  it("does not notify accounts whose sync failed", async () => {
    await createAccountRow("gmail")
    setSyncAccountImplForTests(async () => {
      throw new Error("sync failed")
    })

    const result = await triggerRefresh()

    expect(result.errors).toHaveLength(1)
    expect(vi.mocked(notifyNewMail)).not.toHaveBeenCalled()
  })

  it("refreshes the switcher counts and pushes the fresh unread total to the badge", async () => {
    const id = await createAccountRow("gmail")
    const db = executor as TestExecutor
    const threadId = await createThread(db, id)
    await createMessage(db, { threadId, accountId: id, date: 1_700_000_001 })
    await createMessage(db, {
      threadId,
      accountId: id,
      date: 1_700_000_002,
      isRead: true,
    })
    const rows = await db.select<{ email: string }>(
      "SELECT email FROM accounts WHERE id = $1",
      [id]
    )
    useAccountStore.setState({
      accounts: [
        {
          id,
          type: "gmail",
          email: rows[0]?.email ?? "",
          displayName: null,
          status: "active",
          unreadCount: 0,
          lastSyncAt: 1_700_000_000,
        },
      ],
      activeAccountId: id,
      loaded: true,
    })
    nextOutcome = { newMessages: 1 }

    await triggerRefresh()

    // Fresh COUNT query, not the sync outcome: only the 1 unread message
    // counts, the read one is ignored.
    expect(vi.mocked(updateUnreadBadge)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(updateUnreadBadge)).toHaveBeenCalledWith(1)
    expect(useAccountStore.getState().accounts[0]?.unreadCount).toBe(1)
  })

  it("runs the badge refresh even when every account failed", async () => {
    await createAccountRow("gmail")
    setSyncAccountImplForTests(async () => {
      throw new Error("sync failed")
    })

    await triggerRefresh()

    // The badge reflects DB truth regardless of sync errors (0 unread).
    expect(vi.mocked(updateUnreadBadge)).toHaveBeenCalledWith(0)
  })
})

describe("sync store", () => {
  it("drives the per-account slice and the online flag", () => {
    useSyncStore.setState({ perAccount: {}, online: true })
    const store = useSyncStore.getState()

    store.setSyncing("a")
    expect(useSyncStore.getState().perAccount.a?.status).toBe("syncing")

    store.setSynced("a", 123)
    expect(useSyncStore.getState().perAccount.a).toEqual({
      status: "idle",
      lastSyncAt: 123,
    })

    store.setError("a", "boom")
    expect(useSyncStore.getState().perAccount.a).toMatchObject({
      status: "error",
      error: "boom",
    })

    store.setPendingCount("a", 3)
    expect(useSyncStore.getState().perAccount.a?.pendingCount).toBe(3)

    store.setOnline(false)
    expect(useSyncStore.getState().online).toBe(false)
    store.setOnline(true)

    store.hydrateFromAccounts([{ id: "x", lastSyncAt: 7 }, { id: "y" }])
    expect(useSyncStore.getState().perAccount.x).toEqual({
      status: "idle",
      lastSyncAt: 7,
    })
    expect(useSyncStore.getState().perAccount.y).toEqual({ status: "idle" })
  })
})
