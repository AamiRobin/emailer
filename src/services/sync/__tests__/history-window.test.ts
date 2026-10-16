import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import {
  clampToRange,
  clampToWindow,
  dismissBoundedFirstSyncNotice,
  historyWindowBoundary,
  isBoundedFirstSync,
  isBoundedNoticeDismissed,
  markBoundedFirstSync,
  pageIsEntirelyOutOfWindow,
  parseHistoryWindow,
  windowIsWider,
} from "../history-window"

/**
 * The history-window grammar (parity-round-3 task 3.2, design D6): the
 * stored TEXT value's parsing, the boundary arithmetic every driver
 * shares, the widening ordering, and the client-side clamps. The flag
 * helpers run against the in-memory executor like the other db tests.
 */

/** 2026-10-04T12:34:56Z — a fixed "now" so the arithmetic is exact. */
const NOW = Date.UTC(2026, 9, 4, 12, 34, 56) / 1000

describe("parseHistoryWindow", () => {
  it("accepts exactly the four stored tokens", () => {
    expect(parseHistoryWindow("1m")).toBe("1m")
    expect(parseHistoryWindow("3m")).toBe("3m")
    expect(parseHistoryWindow("6m")).toBe("6m")
    expect(parseHistoryWindow("1y")).toBe("1y")
  })

  it("reads everything else (null/empty/corrupt) as the unbounded default", () => {
    expect(parseHistoryWindow(null)).toBeNull()
    expect(parseHistoryWindow(undefined)).toBeNull()
    expect(parseHistoryWindow("")).toBeNull()
    expect(parseHistoryWindow("all")).toBeNull()
    expect(parseHistoryWindow("2m")).toBeNull()
  })
})

describe("historyWindowBoundary", () => {
  it("computes midnight UTC of the day N months before now", () => {
    expect(historyWindowBoundary("3m", NOW)).toBe(
      Date.UTC(2026, 6, 4) / 1000
    )
    expect(historyWindowBoundary("1m", NOW)).toBe(Date.UTC(2026, 8, 4) / 1000)
    expect(historyWindowBoundary("6m", NOW)).toBe(Date.UTC(2026, 3, 4) / 1000)
  })

  it("computes one calendar year for 1y", () => {
    expect(historyWindowBoundary("1y", NOW)).toBe(Date.UTC(2025, 9, 4) / 1000)
  })

  it("null is unbounded (no clamp)", () => {
    expect(historyWindowBoundary(null, NOW)).toBeNull()
  })
})

describe("windowIsWider", () => {
  it("orders 1m < 3m < 6m < 1y < null", () => {
    expect(windowIsWider("1m", "3m")).toBe(true)
    expect(windowIsWider("3m", "1m")).toBe(false)
    expect(windowIsWider("6m", "3m")).toBe(false)
    expect(windowIsWider("3m", "1y")).toBe(true)
    expect(windowIsWider(null, "1y")).toBe(false)
    // Equal never widens; narrowing never does either.
    expect(windowIsWider("3m", "3m")).toBe(false)
    expect(windowIsWider("1y", null)).toBe(true)
  })
})

describe("clampToWindow / pageIsEntirelyOutOfWindow / clampToRange", () => {
  const boundary = 1_000
  const messages = [
    { id: "old", date: 999 },
    { id: "edge", date: 1_000 },
    { id: "new", date: 1_001 },
  ]

  it("keeps messages at or after the boundary; null keeps everything", () => {
    expect(clampToWindow(messages, boundary).map((m) => m.id)).toEqual([
      "edge",
      "new",
    ])
    expect(clampToWindow(messages, null)).toHaveLength(3)
  })

  it("detects a fully stale page; null never stops the walk", () => {
    expect(pageIsEntirelyOutOfWindow(messages, boundary)).toBe(false)
    expect(pageIsEntirelyOutOfWindow([{ date: 5 }], boundary)).toBe(true)
    expect(pageIsEntirelyOutOfWindow([{ date: 5 }], null)).toBe(false)
  })

  it("clampToRange keeps the half-open [since, until) and honors until null", () => {
    expect(
      clampToRange(messages, { since: 1_000, until: 1_001 }).map((m) => m.id)
    ).toEqual(["edge"])
    expect(clampToRange(messages, { since: 999, until: null }).map((m) => m.id))
      .toEqual(["old", "edge", "new"])
  })
})

describe("bounded-first-sync flags", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = "acc-flags"
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      [accountId, "gmail", "acc-flags@example.com"]
    )
  })

  afterEach(() => {
    executor.close()
  })

  it("round-trips bounded + dismissed through the settings table", async () => {
    expect(await isBoundedFirstSync(executor, accountId)).toBe(false)
    expect(await isBoundedNoticeDismissed(executor, accountId)).toBe(false)

    await markBoundedFirstSync(executor, accountId)
    // Idempotent — the engines mark on every bounded seed pass.
    await markBoundedFirstSync(executor, accountId)
    expect(await isBoundedFirstSync(executor, accountId)).toBe(true)

    await dismissBoundedFirstSyncNotice(executor, accountId)
    expect(await isBoundedNoticeDismissed(executor, accountId)).toBe(true)
    expect(await isBoundedFirstSync(executor, accountId)).toBe(true)
  })

  it("flags are per account", async () => {
    const otherId = "acc-flags-2"
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      [otherId, "imap", "acc-flags-2@example.com"]
    )
    await markBoundedFirstSync(executor, accountId)
    expect(await isBoundedFirstSync(executor, otherId)).toBe(false)
  })
})
