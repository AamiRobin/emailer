import { create } from "zustand"

/**
 * Sync status store (design D5): ephemeral UI state only — durable state
 * (last_sync_at, cursors) lives in SQLite and this store is rebuilt from
 * it on launch via hydrateFromAccounts. The scheduler drives
 * setSyncing/setSynced/setError around each account pass; the offline
 * queue task (4.5) wires setOnline later — the setter already exists.
 */

export type AccountSyncStatus = "idle" | "syncing" | "error"

export interface AccountSyncState {
  status: AccountSyncStatus
  /** Unix epoch seconds of the last successful sync. */
  lastSyncAt?: number
  /** Last failure message (status "error"). */
  error?: string
  /** Pending offline operations (wired by the queue task, 4.5). */
  pendingCount?: number
}

interface SyncStoreState {
  perAccount: Record<string, AccountSyncState>
  online: boolean
}

interface SyncStoreActions {
  setSyncing: (accountId: string) => void
  setSynced: (accountId: string, lastSyncAt: number) => void
  setError: (accountId: string, error: string) => void
  setPendingCount: (accountId: string, pendingCount: number) => void
  setOnline: (online: boolean) => void
  /** Rebuild the per-account slice from the accounts table on launch. */
  hydrateFromAccounts: (accounts: { id: string; lastSyncAt?: number }[]) => void
}

export type SyncStore = SyncStoreState & SyncStoreActions

const EMPTY_ACCOUNT: AccountSyncState = { status: "idle" }

export const useSyncStore = create<SyncStore>()((set) => ({
  perAccount: {},
  online: true,

  setSyncing: (accountId) =>
    set((state) => ({
      perAccount: {
        ...state.perAccount,
        [accountId]: {
          ...EMPTY_ACCOUNT,
          ...state.perAccount[accountId],
          status: "syncing",
          error: undefined,
        },
      },
    })),

  setSynced: (accountId, lastSyncAt) =>
    set((state) => ({
      perAccount: {
        ...state.perAccount,
        [accountId]: {
          ...EMPTY_ACCOUNT,
          ...state.perAccount[accountId],
          status: "idle",
          lastSyncAt,
          error: undefined,
        },
      },
    })),

  setError: (accountId, error) =>
    set((state) => ({
      perAccount: {
        ...state.perAccount,
        [accountId]: {
          ...EMPTY_ACCOUNT,
          ...state.perAccount[accountId],
          status: "error",
          error,
        },
      },
    })),

  setPendingCount: (accountId, pendingCount) =>
    set((state) => ({
      perAccount: {
        ...state.perAccount,
        [accountId]: {
          ...EMPTY_ACCOUNT,
          ...state.perAccount[accountId],
          pendingCount,
        },
      },
    })),

  setOnline: (online) => set({ online }),

  hydrateFromAccounts: (accounts) =>
    set(() => ({
      perAccount: Object.fromEntries(
        accounts.map((account) => [
          account.id,
          { ...EMPTY_ACCOUNT, lastSyncAt: account.lastSyncAt },
        ])
      ),
    })),
}))
