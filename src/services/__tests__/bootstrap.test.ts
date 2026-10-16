import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { initDatabase } from "@/services/db/connection"

/**
 * Startup orchestration (task 1.x). Each registered due-job handler is
 * contract-tested in its own module; what is pinned here is the WIRE —
 * bootstrap() must, in order: initialize the database, start the
 * notification system, the offline queue, hydrate the sync store from
 * accounts, register all seven due-job handlers, start the scheduler and
 * drain due jobs once. Every stage is mocked: a broken wire here means
 * dead snooze/backfill/scheduled-send with every piece green in
 * isolation.
 *
 * bootstrap() memoizes on a module-level promise, so the test resets the
 * module registry between cases (vi.resetModules + dynamic import) to
 * exercise the once-only discipline per fresh module instance.
 */

vi.mock("@/services/db/connection", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/db/connection")>()
  return {
    ...actual,
    initDatabase: vi.fn(async () => {}),
  }
})

vi.mock("@/services/notifications/init-notifications", () => ({
  initNotificationSystem: vi.fn(),
}))

vi.mock("@/services/queue", () => ({
  initQueueSystem: vi.fn(async () => {}),
}))

vi.mock("@/services/sync/scheduler", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/sync/scheduler")>()
  return {
    ...actual,
    registerDueJobHandler: vi.fn(),
    runDueJobsOnce: vi.fn(async () => ({ ran: [] })),
    startScheduler: vi.fn(),
  }
})

const syncStoreHydrate = vi.fn()

vi.mock("@/stores/sync-store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/sync-store")>()
  return {
    ...actual,
    useSyncStore: {
      getState: () => ({
        hydrateFromAccounts: syncStoreHydrate,
      }),
    },
  }
})

vi.mock("@/services/db/accounts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/db/accounts")>()
  return {
    ...actual,
    listAccounts: vi.fn(async () => [
      { id: "acc-1", last_sync_at: 1_700_000_000 },
      { id: "acc-2", last_sync_at: null },
    ]),
  }
})

vi.mock("@/services/email-actions/snooze", () => ({
  wakeDueThreads: vi.fn(async () => []),
}))
vi.mock("@/services/email-actions/holds", () => ({
  releaseDueHolds: vi.fn(async () => []),
  DELIVERY_HOLDS_DUE_JOB: "delivery-holds.due",
}))
vi.mock("@/services/email-actions/auto-archive", () => ({
  runAutoArchive: vi.fn(async () => ({})),
  AUTO_ARCHIVE_DUE_JOB: "auto-archive.due",
}))
vi.mock("@/services/categorization/backfill", () => ({
  startCategoryBackfill: vi.fn(),
  CATEGORY_BACKFILL_DUE_JOB: "category-backfill.due",
}))
vi.mock("@/services/email-actions/followups", () => ({
  runDueFollowUps: vi.fn(async () => []),
  FOLLOWUPS_DUE_JOB: "followups.due",
}))
vi.mock("@/services/composer/scheduled-send-runner", () => ({
  runDueScheduledSends: vi.fn(async () => []),
  SCHEDULED_SENDS_DUE_JOB: "scheduled-sends.due",
}))
vi.mock("@/services/embeddings/indexer", () => ({
  runSemanticIndexSlice: vi.fn(async () => {}),
  SEMANTIC_INDEX_DUE_JOB: "semantic-index.due",
}))
vi.mock("@/services/db/executor", () => ({
  getExecutor: () => ({}) as unknown,
}))
vi.mock("@/services/search/folded-backfill", () => ({
  backfillFoldedText: vi.fn(async () => {}),
}))
vi.mock("@/components/layout/use-snoozed-threads", () => ({
  notifySnoozedThreadsChanged: vi.fn(),
}))

async function freshBootstrap(): Promise<typeof import("../bootstrap")> {
  vi.resetModules()
  return import("../bootstrap")
}

const { registerDueJobHandler, runDueJobsOnce, startScheduler } =
  await import("@/services/sync/scheduler")
const { initNotificationSystem } = await import(
  "@/services/notifications/init-notifications"
)
const { initQueueSystem } = await import("@/services/queue")

const schedulerMocks = vi.mocked({
  registerDueJobHandler,
  runDueJobsOnce,
  startScheduler,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(initDatabase).mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("bootstrap() — main-window startup wire", () => {
  it("runs every stage exactly once and registers all due-job handlers", async () => {
    const mod = await freshBootstrap()
    await mod.bootstrap()

    expect(initDatabase).toHaveBeenCalledTimes(1)
    expect(initNotificationSystem).toHaveBeenCalledTimes(1)
    expect(initQueueSystem).toHaveBeenCalledTimes(1)

    // Sync-store hydration seeds the indicator from accounts.last_sync_at.
    expect(syncStoreHydrate).toHaveBeenCalledWith([
      { id: "acc-1", lastSyncAt: 1_700_000_000 },
      { id: "acc-2", lastSyncAt: undefined },
    ])

    const registeredJobs = schedulerMocks.registerDueJobHandler.mock.calls.map(
      (call) => call[0] as string
    )
    expect(registeredJobs).toContain("snooze.wake")
    expect(registeredJobs).toContain("scheduled-sends.due")
    expect(registeredJobs).toContain("delivery-holds.due")
    expect(registeredJobs).toContain("auto-archive.due")
    expect(registeredJobs).toContain("followups.due")
    expect(registeredJobs).toContain("category-backfill.due")
    expect(registeredJobs).toContain("semantic-index.due")

    expect(schedulerMocks.startScheduler).toHaveBeenCalledTimes(1)
    expect(schedulerMocks.runDueJobsOnce).toHaveBeenCalledTimes(1)
  })

  it("is idempotent — a second call reuses the first promise", async () => {
    const mod = await freshBootstrap()
    const first = mod.bootstrap()
    const second = mod.bootstrap()
    await Promise.all([first, second])

    expect(initDatabase).toHaveBeenCalledTimes(1)
    expect(schedulerMocks.startScheduler).toHaveBeenCalledTimes(1)
  })

  it("a queue-init failure propagates — the app must not render half-booted", async () => {
    vi.mocked(initQueueSystem).mockRejectedValueOnce(
      new Error("queue init failed")
    )
    const mod = await freshBootstrap()
    await expect(mod.bootstrap()).rejects.toThrow("queue init failed")
    expect(schedulerMocks.startScheduler).not.toHaveBeenCalled()
  })
})

describe("bootstrapPopout() — reduced startup", () => {
  it("initializes the database only — no scheduler, queue or notifications", async () => {
    const mod = await freshBootstrap()
    await mod.bootstrapPopout()

    expect(initDatabase).toHaveBeenCalledTimes(1)
    expect(initNotificationSystem).not.toHaveBeenCalled()
    expect(initQueueSystem).not.toHaveBeenCalled()
    expect(schedulerMocks.startScheduler).not.toHaveBeenCalled()
    expect(schedulerMocks.registerDueJobHandler).not.toHaveBeenCalled()
  })

  it("is idempotent per window", async () => {
    const mod = await freshBootstrap()
    await Promise.all([mod.bootstrapPopout(), mod.bootstrapPopout()])
    expect(initDatabase).toHaveBeenCalledTimes(1)
  })
})
