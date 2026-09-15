import { create } from "zustand"

import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import { useUiStore } from "@/stores/ui-store"

/**
 * Account store — the sidebar account switcher's source of truth.
 *
 * Loads the accounts plus per-account unread counts from the local SQLite
 * database, restores the last active account on launch, and switches
 * accounts purely in memory: setActive only changes store state (mailbox
 * panes read activeAccountId), so switching never waits on the network.
 *
 * Unread counts are the number of unread messages in the account
 * (`COUNT(messages) WHERE is_read = 0`, summed across the whole account —
 * the plain per-account total the accounts spec's "unread badge per
 * account" scenario needs). They are a cached aggregate: refreshUnreadCounts()
 * re-runs the GROUP BY query; sync/mark-read/account flows call it (or
 * reload()) after they change messages.
 *
 * The active selection persists through the `accounts.is_active` flag
 * ("last active account"): setActive clears it on every row and sets it on
 * the chosen one; init restores it (is_active row → first active-status
 * account → none). Deliberately not localStorage — SQLite is the single
 * source of truth, so the selection survives restarts with the mail data.
 *
 * Queries go through an injectable SqlExecutor that defaults to
 * getExecutor(); tests pass a node:sqlite executor via
 * setAccountStoreExecutor() (tauri-plugin-sql cannot run under vitest).
 * These are the minimal queries the switcher needs — the shared accounts
 * query module (src/services/db/accounts.ts) lands with task 5.3.
 */

export type AccountType = "gmail" | "imap"
export type AccountStatus = "active" | "auth-error"

export interface AccountInfo {
  id: string
  type: AccountType
  email: string
  displayName: string | null
  status: AccountStatus
  /** Unread messages in the account (messages.is_read = 0). */
  unreadCount: number
  /** Unix epoch seconds of the last completed sync, if ever synced. */
  lastSyncAt?: number | null
}

interface AccountState {
  accounts: AccountInfo[]
  activeAccountId: string | null
  /** True once init() (or reload()) has loaded accounts from the database. */
  loaded: boolean
  /** Idempotent single-flight load for app startup; later calls are no-ops. */
  init(): Promise<void>
  /** Force a fresh load (re-applies the restore semantics of init). */
  reload(): Promise<void>
  /** Instant local switch + is_active persistence. No network. */
  setActive(id: string): Promise<void>
  /** Re-run the unread aggregate into the current account list. */
  refreshUnreadCounts(): Promise<void>
}

interface AccountRow {
  id: string
  type: string
  email: string
  display_name: string | null
  status: string
  last_sync_at: number | null
  is_active: number
}

function toAccountInfo(row: AccountRow, unreadCount: number): AccountInfo {
  return {
    id: row.id,
    type: row.type === "imap" ? "imap" : "gmail",
    email: row.email,
    displayName: row.display_name,
    status: row.status === "auth-error" ? "auth-error" : "active",
    unreadCount,
    lastSyncAt: row.last_sync_at,
  }
}

async function loadAccounts(
  executor: SqlExecutor
): Promise<{ accounts: AccountInfo[]; persistedActiveId: string | null }> {
  const rows = await executor.select<AccountRow>(
    `SELECT id, type, email, display_name, status, last_sync_at, is_active
     FROM accounts
     ORDER BY created_at ASC, id ASC`
  )
  const unreadRows = await executor.select<{
    account_id: string
    unread: number
  }>(
    `SELECT account_id, COUNT(*) AS unread
     FROM messages
     WHERE is_read = 0
     GROUP BY account_id`
  )
  const unreadByAccount = new Map(
    unreadRows.map((row) => [row.account_id, row.unread])
  )
  const accounts = rows.map((row) =>
    toAccountInfo(row, unreadByAccount.get(row.id) ?? 0)
  )
  // Last active account flag; first row wins if multiple are flagged.
  const persisted = rows.find((row) => row.is_active === 1)
  return { accounts, persistedActiveId: persisted?.id ?? null }
}

/** is_active row → first active-status account → none. */
function restoreActiveId(
  accounts: AccountInfo[],
  persistedActiveId: string | null
): string | null {
  if (
    persistedActiveId &&
    accounts.some((account) => account.id === persistedActiveId)
  ) {
    return persistedActiveId
  }
  return accounts.find((account) => account.status === "active")?.id ?? null
}

async function persistActiveAccount(
  executor: SqlExecutor,
  id: string
): Promise<void> {
  await executor.execute("UPDATE accounts SET is_active = 0")
  await executor.execute("UPDATE accounts SET is_active = 1 WHERE id = $1", [
    id,
  ])
}

let executorOverride: SqlExecutor | null = null
let initPromise: Promise<void> | null = null

function resolveExecutor(): SqlExecutor {
  return executorOverride ?? getExecutor()
}

/** Test hook: run store queries against `executor` (node:sqlite under
 * vitest); pass null to restore the production getExecutor() binding. */
export function setAccountStoreExecutor(executor: SqlExecutor | null): void {
  executorOverride = executor
}

async function runLoad(): Promise<void> {
  const { accounts, persistedActiveId } = await loadAccounts(resolveExecutor())
  useAccountStore.setState({
    accounts,
    activeAccountId: restoreActiveId(accounts, persistedActiveId),
    loaded: true,
  })
}

export const useAccountStore = create<AccountState>((set, get) => ({
  accounts: [],
  activeAccountId: null,
  loaded: false,

  init: () => {
    if (get().loaded) return Promise.resolve()
    // Single-flight while in flight; cleared on settle so a failure (or a
    // test reset) can retry and a completed load is never re-run.
    initPromise ??= runLoad().finally(() => {
      initPromise = null
    })
    return initPromise
  },

  reload: () => runLoad(),

  setActive: (id) => {
    const { accounts, activeAccountId } = get()
    if (
      !accounts.some((account) => account.id === id) ||
      activeAccountId === id
    ) {
      return Promise.resolve()
    }
    // Instant local switch first — consumers re-render from this state with
    // no network round-trip. The open thread belongs to the previous
    // account, so the reading pane must not try to load it there (it would
    // render "message not found"). Persistence is best-effort: a failed
    // write only means the selection is not restored on the next launch.
    set({ activeAccountId: id })
    useUiStore.getState().setActiveThread(null)
    return persistActiveAccount(resolveExecutor(), id).catch((error) => {
      console.warn("[account-store] failed to persist active account", error)
    })
  },

  refreshUnreadCounts: async () => {
    const unreadRows = await resolveExecutor().select<{
      account_id: string
      unread: number
    }>(
      `SELECT account_id, COUNT(*) AS unread
       FROM messages
       WHERE is_read = 0
       GROUP BY account_id`
    )
    const unreadByAccount = new Map(
      unreadRows.map((row) => [row.account_id, row.unread])
    )
    set((state) => {
      let changed = false
      const accounts = state.accounts.map((account): AccountInfo => {
        const unreadCount = unreadByAccount.get(account.id) ?? 0
        if (unreadCount === account.unreadCount) return account
        changed = true
        return { ...account, unreadCount }
      })
      return changed ? { accounts } : state
    })
  },
}))

/** Startup hook for the shell: idempotent, and DB failures are logged and
 * swallowed so the UI still renders (empty switcher) without a database —
 * e.g. plain vite outside Tauri. */
export function initAccountStore(): Promise<void> {
  return useAccountStore
    .getState()
    .init()
    .catch((error) => {
      console.warn("[account-store] init failed; no accounts loaded", error)
    })
}

/** Stable-reference selector for the active account (identity is stable
 * while the accounts array is unchanged, so it is safe as a hook selector). */
export function selectActiveAccount(state: AccountState): AccountInfo | null {
  return (
    state.accounts.find((account) => account.id === state.activeAccountId) ??
    null
  )
}

export function useActiveAccount(): AccountInfo | null {
  return useAccountStore(selectActiveAccount)
}
