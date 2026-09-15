import { getExecutor } from "../db/executor"
import type { AccountRow } from "../db/accounts"
import {
  getAccount,
  listActiveAccounts,
  toEmailAccount,
  updateStatus,
} from "../db/accounts"
import {
  decryptCredentials,
  CredentialDecryptError,
} from "../crypto/credentials"
import { getProvider } from "../email/provider-factory"
// Registers gmail + imap in the provider factory on import (idempotent),
// so getProvider works however this module is first loaded.
import "../email/register-providers"
import type { EmailAccount, ProviderCredentials } from "../email/types"
import type { WireSecurity } from "../email/invoke"
import { imapFetchFlagsChanged } from "./flag-sync"
import { ProviderAuthError } from "../email/types"
import { syncGmailAccount } from "./gmail-sync"
import { syncImapAccount } from "./imap-sync"
import { useSyncStore } from "../../stores/sync-store"
import { useAccountStore } from "../../stores/account-store"
import { useFolderCountsStore } from "../../stores/folder-counts-store"
import { refreshThreadList } from "../../stores/thread-list-store"
import { getTotalUnreadCount } from "../db/accounts"
import { notifyNewMail } from "../notifications/new-mail-notifier"
import { updateUnreadBadge } from "../notifications/unread-badge"

/**
 * Background sync scheduler (task 4.4): provider-agnostic orchestrator
 * over all connected accounts plus the 60s interval.
 *
 * Semantics:
 * - syncAllAccounts() runs the active accounts (status "active",
 *   is_active on) sequentially; accounts marked "auth-error" (task 5.6)
 *   are skipped. Per-account failures are isolated: collected into the
 *   result and surfaced in the sync store, the run continues.
 * - startScheduler({intervalMs = 60_000}) ticks syncAllAccounts();
 *   stopScheduler() clears the tick. Starting does NOT sync immediately —
 *   call triggerRefresh() for that (bootstrap decides the initial sync).
 * - triggerRefresh(accountId?) syncs immediately, bypassing the interval
 *   wait: all active accounts, or one specific account.
 * - Single-flight: overlapping triggers never run concurrently. A request
 *   made while a pass is in flight is merged into one queued pass that
 *   drains after the current one (triggerRefresh returns a promise
 *   settling after the whole chain; its result is the final pass's).
 *
 * Auth errors: syncAccount converts ProviderAuthError (and undecryptable
 * credentials) into AccountSyncAuthError — the typed marker task 5.6
 * catches. When a pass catches it, the account's row is flipped to
 * status "auth-error" (persisted, so the pause survives restarts) and
 * only that account stops syncing; the re-auth UI lives in the account
 * flows (reauth.ts) and the switcher dialog.
 *
 * Bootstrap wiring (do NOT call at import time): after initDatabase(),
 *   import { startScheduler } from "@/services/sync/scheduler"
 *   startScheduler()            // periodic pass every 60s
 *   void triggerRefresh()       // optional immediate initial sync
 * and stopScheduler() on teardown. registerEmailProviders() runs on
 * import of this module.
 *
 * New-mail notifications (task 4.6): after each account sync the engine
 * summary's newMessages count is forwarded to notifyNewMail (which does
 * its own gating: setting, permission, 60s coalescing). After every pass
 * completes, the pass refreshes the account switcher's unread counts,
 * pushes a fresh total to the OS unread badge (macOS dock; no-op
 * elsewhere), and reloads the sidebar folder counts plus the open thread
 * list. All best-effort and never affect the sync result.
 */

export const DEFAULT_SYNC_INTERVAL_MS = 60_000

/**
 * Typed marker rethrown by syncAccount when an account cannot
 * authenticate (server rejection or undecryptable credentials). Task 5.6
 * catches this to set the account's status to "auth-error" and pause its
 * sync.
 */
export class AccountSyncAuthError extends Error {
  readonly accountId: string

  constructor(accountId: string, message: string) {
    super(message)
    this.name = "AccountSyncAuthError"
    this.accountId = accountId
  }
}

export interface SyncAccountError {
  accountId: string
  /** The thrown value; AccountSyncAuthError instances mark auth failures. */
  error: unknown
}

export interface SyncAllResult {
  /** Account ids that completed without an error. */
  synced: string[]
  /** Per-account failures; other accounts still sync (isolation). */
  errors: SyncAccountError[]
}

export interface SchedulerOptions {
  /** Interval between background passes (default 60s). */
  intervalMs?: number
}

// ---------------------------------------------------------------------------
// Single-account sync
// ---------------------------------------------------------------------------

async function credentialsFor(
  account: EmailAccount
): Promise<ProviderCredentials> {
  // Gmail is OAuth-only: createGmailProvider decrypts the token envelope
  // from account.credentialsJson lazily; the imap-style password is unused.
  if (account.type === "gmail") return { password: "" }
  const envelope = await decryptCredentials<ProviderCredentials>(
    account.credentialsJson ?? null
  )
  if (!envelope?.password) {
    throw new AccountSyncAuthError(
      account.id,
      "no stored password for imap account; re-authentication required"
    )
  }
  return envelope
}

/**
 * What the scheduler consumes from a per-account sync. The engines
 * return richer summaries; runAccountSync reduces them to this. The
 * test-seam impl may resolve void instead (meaning "nothing to report").
 */
export interface SchedulerSyncOutcome {
  /** Messages newly inserted for this account during this sync. */
  newMessages: number
}

async function runAccountSync(
  account: EmailAccount
): Promise<SchedulerSyncOutcome> {
  const executor = getExecutor()
  const credentials = await credentialsFor(account)
  const provider = getProvider(account, credentials)
  if (account.type === "gmail") {
    const summary = await syncGmailAccount({
      executor,
      provider,
      accountId: account.id,
    })
    return { newMessages: summary.newMessages }
  }
  // CONDSTORE fast path (D14): the engine cannot build ImapParams itself —
  // bind the changed-since command to this account's connection config.
  if (!account.imapHost || !account.imapPort || !account.imapSecurity) {
    throw new AccountSyncAuthError(
      account.id,
      "imap account is missing server configuration"
    )
  }
  const summary = await syncImapAccount({
    executor,
    provider,
    accountId: account.id,
    fetchFlagsChanged: (folder, sinceModseq) =>
      imapFetchFlagsChanged(
        {
          host: account.imapHost as string,
          port: account.imapPort as number,
          security: account.imapSecurity as WireSecurity,
          username: account.email,
          password: credentials.password,
          acceptInvalidCerts: false,
        },
        folder,
        sinceModseq
      ),
  })
  return { newMessages: summary.newMessages }
}

/**
 * Sync one account: dispatches gmail vs imap with decrypted credentials.
 * Returns the sync outcome the scheduler consumes for new-mail
 * notifications. Auth failures are rethrown as AccountSyncAuthError
 * (marker for 5.6); everything else propagates as-is.
 */
export async function syncAccount(
  account: EmailAccount
): Promise<SchedulerSyncOutcome> {
  try {
    return await runAccountSync(account)
  } catch (error) {
    if (
      error instanceof ProviderAuthError ||
      error instanceof CredentialDecryptError
    ) {
      throw new AccountSyncAuthError(account.id, error.message)
    }
    throw error
  }
}

// ---------------------------------------------------------------------------
// Test seam: substitute the per-account sync without mocking modules.
// ---------------------------------------------------------------------------

type SyncAccountImpl = (
  account: EmailAccount
) => Promise<SchedulerSyncOutcome | void>

let syncAccountImpl: SyncAccountImpl = syncAccount

/**
 * Replace the per-account sync implementation (tests). Pass null to
 * restore the real one.
 */
export function setSyncAccountImplForTests(impl: SyncAccountImpl | null): void {
  syncAccountImpl = impl ?? syncAccount
}

// ---------------------------------------------------------------------------
// Single-flight pass runner
// ---------------------------------------------------------------------------

let inFlight = false
let pendingAccountIds: Set<string> | null = null
let currentRun: Promise<SyncAllResult> = Promise.resolve({
  synced: [],
  errors: [],
})

/**
 * Task 5.6: persist an auth failure as the account's durable "auth-error"
 * status. listActiveAccounts/executePass filter on status "active", so the
 * paused account is skipped by every later pass — including after a
 * restart, because the flag lives in SQLite, not in memory. The account
 * store reload makes the switcher show the warning glyph / re-auth entry
 * right away. Best-effort: a persistence failure must not mask the sync
 * error that caused it.
 */
async function markAccountAuthError(accountId: string): Promise<void> {
  try {
    await updateStatus(getExecutor(), accountId, "auth-error")
    await useAccountStore.getState().reload()
  } catch (error) {
    console.warn(
      `[scheduler] could not persist auth-error for account ${accountId}`,
      error
    )
  }
}

function executePass(accountIds: string[]): Promise<SyncAllResult> {
  return (async () => {
    const synced: string[] = []
    const errors: SyncAccountError[] = []
    const store = useSyncStore.getState()

    for (const accountId of accountIds) {
      let account: EmailAccount
      try {
        const row: AccountRow | null = await getAccount(
          getExecutor(),
          accountId
        )
        // Skip accounts deleted mid-run or paused as auth-errors (5.6).
        if (!row || row.status !== "active" || row.is_active !== 1) continue
        account = toEmailAccount(row)
      } catch (error) {
        errors.push({ accountId, error })
        continue
      }

      store.setSyncing(accountId)
      try {
        const outcome = await syncAccountImpl(account)
        const refreshed = await getAccount(getExecutor(), accountId)
        store.setSynced(
          accountId,
          refreshed?.last_sync_at ?? Math.floor(Date.now() / 1000)
        )
        synced.push(accountId)
        // New-mail OS notification (4.6): fire-and-forget — the notifier
        // applies its own gating (setting, permission, 60s coalescing)
        // and never rejects, so it cannot stall or fail the pass.
        if (outcome && outcome.newMessages > 0) {
          void notifyNewMail({
            accountId: account.id,
            accountEmail: account.email,
            count: outcome.newMessages,
          })
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (error instanceof AccountSyncAuthError) {
          // Task 5.6: flip the row to "auth-error" so only this account
          // pauses (the pass continues); the stored message names the
          // account so the sync indicator can point at the right sign-in.
          await markAccountAuthError(accountId)
          store.setError(
            accountId,
            `Sign-in failed for ${account.email}: ${message}`
          )
        } else {
          // Never log credentials/tokens: only the message reaches the store.
          store.setError(accountId, message)
        }
        errors.push({ accountId, error })
      }
    }
    await refreshUnreadIndicators()
    return { synced, errors }
  })()
}

/**
 * Post-pass UI refresh (task 4.6): re-run the account switcher's
 * per-account counts, push a fresh total to the OS badge, and reload the
 * sidebar folder badges and the open thread list so mail that arrived in
 * a background pass is visible without a manual refresh. Best-effort — a
 * database, badge, or store failure is swallowed and never fails the
 * pass. Importing the zustand stores from a service is the accepted
 * layering here (D5): they are cached aggregates over the same local
 * database this pass just changed.
 */
async function refreshUnreadIndicators(): Promise<void> {
  try {
    await useAccountStore.getState().refreshUnreadCounts()
    await updateUnreadBadge(await getTotalUnreadCount(getExecutor()))
    await useFolderCountsStore.getState().refreshFolderCounts()
    await refreshThreadList()
  } catch {
    // Cosmetic indicators only — a broken badge must not break syncing.
  }
}

/**
 * Run one pass over the given accounts. Single-flight: while a pass is
 * running, the request is merged into the pending set and the current
 * chain promise is returned; the pending pass drains right after.
 */
function runPass(accountIds: string[]): Promise<SyncAllResult> {
  if (inFlight) {
    pendingAccountIds = new Set([...(pendingAccountIds ?? []), ...accountIds])
    return currentRun
  }

  inFlight = true
  const pass = executePass(accountIds)
  currentRun = (async () => {
    let result: SyncAllResult
    try {
      result = await pass
    } finally {
      inFlight = false
    }
    if (pendingAccountIds) {
      const next = [...pendingAccountIds]
      pendingAccountIds = null
      // The chain resolves with the final (drained) pass's result.
      return runPass(next)
    }
    return result
  })()
  return currentRun
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Sync every active account sequentially, isolating per-account errors. */
export async function syncAllAccounts(): Promise<SyncAllResult> {
  const rows = await listActiveAccounts(getExecutor())
  return runPass(rows.map((row) => row.id))
}

/**
 * Manual refresh: sync immediately without waiting for the interval —
 * all active accounts, or just `accountId` when given (silently skipped
 * when the account is missing, deleted, or paused as auth-error).
 */
export async function triggerRefresh(
  accountId?: string
): Promise<SyncAllResult> {
  if (accountId !== undefined) {
    const row = await getAccount(getExecutor(), accountId)
    if (!row || row.status !== "active" || row.is_active !== 1) {
      return { synced: [], errors: [] }
    }
    return runPass([accountId])
  }
  return syncAllAccounts()
}

let intervalHandle: ReturnType<typeof setInterval> | null = null

/** Start the periodic background pass (does not sync immediately). */
export function startScheduler(options: SchedulerOptions = {}): void {
  stopScheduler()
  const intervalMs = options.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS
  intervalHandle = setInterval(() => {
    void syncAllAccounts()
  }, intervalMs)
}

/** Stop the periodic pass; an in-flight pass runs to completion. */
export function stopScheduler(): void {
  if (intervalHandle !== null) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
}
