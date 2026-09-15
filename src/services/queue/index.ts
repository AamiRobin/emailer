import { getExecutor } from "../db/executor"
import { requeueStaleProcessingOperations } from "../db/pending-operations"
import { initOnlineTracking, onBackOnline } from "../online"
import {
  startQueueProcessor,
  stopQueueProcessor,
  triggerQueueProcessing,
  type StartQueueProcessorOptions,
} from "./processor"

/**
 * One-stop init for the offline queue system (task 4.5, design D10).
 *
 * WIRING (applied by the reviewer — bootstrap.ts/App.tsx are untouched in
 * this task): chain this after DB init, e.g.
 *
 *   // bootstrap.ts
 *   bootstrapPromise ??= initDatabase().then(() => initQueueSystem())
 *
 * or, after `await bootstrap()` wherever startup completes. It must run
 * after initDatabase() because the startup crash-recovery below queries
 * pending_operations through the shared executor (getDb() throws before
 * init). Re-exported surface: everything from ./operation and
 * ./processor, so feature code imports { enqueueSend, processQueue, … }
 * from "services/queue".
 *
 * Steps (each idempotent, so double-init from StrictMode is safe):
 * 1. initOnlineTracking() — mirror window online/offline events into the
 *    shared zustand store.
 * 2. Subscribe to back-online transitions → triggerQueueProcessing(), the
 *    D10 online-event trigger that replays queued ops without waiting for
 *    the next 30s tick.
 * 3. Crash recovery: rows left 'processing' by a previous session that
 *    died mid-replay return to 'pending' (safe: queue ops are idempotent
 *    or Message-ID deduplicateable).
 * 4. startQueueProcessor({ intervalMs: 30_000 }) — the D10 replay cycle
 *    (plus an immediate pass at startup).
 */

let unsubscribeBackOnline: (() => void) | null = null

/**
 * Options default to the production posture (30s interval, shared
 * executor, real providers); tests may inject executor/getProviderForTest/
 * intervalMs. Production wiring calls `initQueueSystem()` bare.
 */
export async function initQueueSystem(
  options: StartQueueProcessorOptions = {}
): Promise<void> {
  initOnlineTracking()
  unsubscribeBackOnline ??= onBackOnline(() => {
    void triggerQueueProcessing()
  })
  // Startup crash recovery — before the first processor pass so recovered
  // rows are visible to it. Requires the DB to be initialized (see above).
  await requeueStaleProcessingOperations(options.executor ?? getExecutor(), 0)
  startQueueProcessor(options)
}

/** Teardown (tests, HMR): stops the interval and the online subscription. */
export function shutdownQueueSystem(): void {
  stopQueueProcessor()
  unsubscribeBackOnline?.()
  unsubscribeBackOnline = null
}

// Everything from ./operation (op union, enqueue helpers, [de]serialization)
// and ./processor (processQueue, start/stop/trigger, resume) for feature
// call sites.
export * from "./operation"
export * from "./processor"
