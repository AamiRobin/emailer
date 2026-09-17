import { initDatabase } from "./db/connection"
import { getExecutor } from "./db/executor"
import { listAccounts } from "./db/accounts"
import { initNotificationSystem } from "./notifications/init-notifications"
import { initQueueSystem } from "./queue"
import {
  registerDueJobHandler,
  runDueJobsOnce,
  startScheduler,
} from "./sync/scheduler"
import { wakeDueThreads } from "./email-actions/snooze"
import { releaseDueHolds, DELIVERY_HOLDS_DUE_JOB } from "./email-actions/holds"
import {
  runAutoArchive,
  AUTO_ARCHIVE_DUE_JOB,
} from "./email-actions/auto-archive"
import { runDueFollowUps, FOLLOWUPS_DUE_JOB } from "./email-actions/followups"
import {
  runDueScheduledSends,
  SCHEDULED_SENDS_DUE_JOB,
} from "./composer/scheduled-send-runner"
import { useSyncStore } from "../stores/sync-store"
import { notifySnoozedThreadsChanged } from "../components/layout/use-snoozed-threads"

let bootstrapPromise: Promise<void> | null = null

/** Due-job registry name of the snooze wake-up handler (design D2). */
const SNOOZE_WAKE_JOB = "snooze.wake"

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
 * Register the snooze wake-up with the scheduler's due-jobs registry
 * (design D2): every scheduled tick drains it, so due threads wake within
 * 60s of their time. Re-registration on re-init is idempotent (the
 * registry replaces by name). The handler reports its result: when
 * threads actually woke, the Snoozed section is told to re-query —
 * without it a woken thread would keep showing in the sidebar until an
 * unrelated action refreshed the list. Notify is best-effort; the drain
 * itself isolates handler failures.
 */
function registerSnoozeWakeJob(): void {
  registerDueJobHandler(SNOOZE_WAKE_JOB, async () => {
    const woken = await wakeDueThreads(getExecutor())
    if (woken > 0) {
      try {
        notifySnoozedThreadsChanged()
      } catch (error) {
        console.warn(
          "[bootstrap] could not notify the snoozed section of wake-ups",
          error
        )
      }
    }
  })
}

/**
 * Register the scheduled-send due pass with the scheduler's due-jobs
 * registry (design D3, task 10.2), beside snooze.wake: every tick fires
 * due sends, and the shared runDueJobsOnce() is the launch catch-up for
 * sends whose time passed while the app was closed.
 */
function registerScheduledSendsJob(): void {
  registerDueJobHandler(SCHEDULED_SENDS_DUE_JOB, () =>
    runDueScheduledSends(getExecutor())
  )
}

/**
 * Register the delivery-hold release with the scheduler's due-jobs
 * registry (design D2/D6, task 12.1): every tick releases holds whose
 * delivery window has opened (one batched UPDATE that stamps delivered_at,
 * so the window's batch tops the inbox), and runDueJobsOnce() catches up
 * windows that opened while the app was closed.
 */
function registerDeliveryHoldsJob(): void {
  registerDueJobHandler(DELIVERY_HOLDS_DUE_JOB, () =>
    releaseDueHolds(getExecutor())
  )
}

/**
 * Register the auto-archive batch with the scheduler's due-jobs registry
 * (design D2, task 12.3): the tick fires it alongside the other due jobs
 * and runDueJobsOnce() provides the launch pass; the module's last-run
 * guard (6h) and disabled-setting no-op keep the frequent ticks cheap.
 */
function registerAutoArchiveJob(): void {
  registerDueJobHandler(AUTO_ARCHIVE_DUE_JOB, () =>
    runAutoArchive(getExecutor())
  )
}

/**
 * Register the follow-up resurfacing pass with the scheduler's due-jobs
 * registry (design D2/D8, task 14.2): every tick resurfaces due reminders
 * (stamping delivered_at so the thread tops the inbox) and marks them
 * terminal; runDueJobsOnce() is the launch catch-up for intervals that
 * elapsed while the app was closed. The pass is a cheap two-statement
 * batch and a no-op when nothing is due.
 */
function registerFollowUpsJob(): void {
  registerDueJobHandler(FOLLOWUPS_DUE_JOB, () => runDueFollowUps(getExecutor()))
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
 * without waiting on the network. The snooze wake-up, scheduled-send,
 * delivery-hold release, auto-archive and follow-up-reminder due-job
 * handlers are registered before the scheduler starts, and one
 * fire-and-forget runDueJobsOnce() drains due jobs immediately (spec: a
 * snooze, a scheduled send, a delivery window or a follow-up reminder
 * whose time passed while the app was closed is caught up on startup,
 * before the first sync; auto-archive's launch pass is gated by its own
 * last-run guard).
 */
export function bootstrap(): Promise<void> {
  bootstrapPromise ??= initDatabase()
    .then(() => {
      initNotificationSystem()
    })
    .then(() => initQueueSystem())
    .then(() => hydrateSyncStoreFromAccounts())
    .then(() => {
      registerSnoozeWakeJob()
      registerScheduledSendsJob()
      registerDeliveryHoldsJob()
      registerAutoArchiveJob()
      registerFollowUpsJob()
      startScheduler()
      void runDueJobsOnce()
    })
  return bootstrapPromise
}
