import { initDatabase } from "./db/connection"
import { getExecutor } from "./db/executor"
import { listAccounts } from "./db/accounts"
import { initNotificationSystem } from "./notifications/init-notifications"
import { initQueueSystem } from "./queue"
import { startScheduler } from "./sync/scheduler"
import { useSyncStore } from "../stores/sync-store"

let bootstrapPromise: Promise<void> | null = null

/**
 * Seed the sync store from the accounts table (one-shot, idempotent):
 * without it the SyncIndicator shows "Not synced yet" after a restart
 * even when accounts.last_sync_at holds a real timestamp. Best-effort —
 * a hydration failure must not keep the scheduler from starting.
 */
async function hydrateSyncStoreFromAccounts(): Promise<void> {
  try {
    const rows = await listAccounts(getExecutor())
    useSyncStore.getState().hydrateFromAccounts(
      rows.map((row) => ({
        id: row.id,
        lastSyncAt: row.last_sync_at ?? undefined,
      }))
    )
  } catch (error) {
    console.warn("[bootstrap] could not hydrate the sync store", error)
  }
}

/**
 * One-time app startup initialization, awaited by App before the shell
 * renders. The database (and its migrations) must be ready before any
 * feature init or store hydration runs, since stores are rebuilt from the
 * DB on launch. Further init steps can be chained here later; each must
 * stay idempotent (StrictMode mounts this twice in dev).
 *
 * After the DB is ready: OS notification permission precheck, the offline
 * queue (30s replay processor + online tracking), the sync indicator
 * hydration from accounts.last_sync_at, and the background sync
 * scheduler (60s interval) start. Neither loop runs an immediate sync on
 * launch — the first refresh is user/UI-triggered so the window paints
 * without waiting on the network.
 */
export function bootstrap(): Promise<void> {
  bootstrapPromise ??= initDatabase()
    .then(() => {
      initNotificationSystem()
    })
    .then(() => initQueueSystem())
    .then(() => hydrateSyncStoreFromAccounts())
    .then(() => {
      startScheduler()
    })
  return bootstrapPromise
}
