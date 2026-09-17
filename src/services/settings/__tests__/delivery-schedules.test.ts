import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { getSetting, setSetting } from "../../db/settings"
import {
  createDeliverySchedule,
  deleteDeliverySchedule,
  deliverySchedulesSettingKey,
  listDeliverySchedules,
  nextWindowOccurrence,
  resolveDeliveryHold,
  resolveHoldFromSchedules,
  reorderDeliverySchedules,
  updateDeliverySchedule,
  type DeliverySchedule,
} from "../delivery-schedules"

/**
 * Task 12.1 storage + window math tests: CRUD over the per-account
 * settings row (the splits pattern), the pure weekly-window computation
 * (local clock, strictly-after semantics) and the ingestion resolution
 * (first matching schedule in position order wins).
 */

let executor: TestExecutor
let accountId: string

beforeEach(async () => {
  executor = createTestExecutor()
  accountId = await createAccount(executor, "gmail")
})

afterEach(() => {
  executor.close()
})

const newsletterSchedule = {
  name: "Newsletters",
  match: { kind: "label" as const, value: "Newsletters" },
  window: { kind: "weekly" as const, dayOfWeek: 6, hour: 8, minute: 0 },
}

// ---- CRUD ------------------------------------------------------------------

describe("delivery schedule CRUD", () => {
  it("creates with a fresh id and dense positions under the per-account key", async () => {
    const first = await createDeliverySchedule(
      executor,
      accountId,
      newsletterSchedule
    )
    const second = await createDeliverySchedule(executor, accountId, {
      match: { kind: "sender", value: "news@x.com" },
      window: { kind: "weekly", dayOfWeek: 0, hour: 9, minute: 30 },
    })

    expect(second.id).not.toBe(first.id)
    const list = await listDeliverySchedules(executor, accountId)
    expect(list.map((schedule) => schedule.id)).toEqual([first.id, second.id])
    expect(list.map((schedule) => schedule.position)).toEqual([0, 1])

    // The row is one JSON array under the namespaced key, per account.
    const raw = await getSetting<unknown>(
      executor,
      deliverySchedulesSettingKey(accountId),
      null
    )
    expect(Array.isArray(raw)).toBe(true)
  })

  it("scopes rows per account", async () => {
    const otherAccount = await createAccount(executor, "imap")
    await createDeliverySchedule(executor, accountId, newsletterSchedule)
    expect(await listDeliverySchedules(executor, otherAccount)).toEqual([])
    expect(await listDeliverySchedules(executor, accountId)).toHaveLength(1)
  })

  it("updates name/match/window in place; an unknown id throws", async () => {
    const created = await createDeliverySchedule(
      executor,
      accountId,
      newsletterSchedule
    )
    await updateDeliverySchedule(executor, accountId, created.id, {
      name: "Weekend press",
      window: { kind: "weekly", dayOfWeek: 6, hour: 20, minute: 15 },
    })

    const [updated] = await listDeliverySchedules(executor, accountId)
    expect(updated).toMatchObject({
      id: created.id,
      name: "Weekend press",
      window: { kind: "weekly", dayOfWeek: 6, hour: 20, minute: 15 },
    })

    await expect(
      updateDeliverySchedule(executor, accountId, "no-such-id", { name: "x" })
    ).rejects.toThrow("not found")
  })

  it("deletes a schedule (unknown id is a no-op) and reorders densely", async () => {
    const a = await createDeliverySchedule(
      executor,
      accountId,
      newsletterSchedule
    )
    const b = await createDeliverySchedule(executor, accountId, {
      match: { kind: "sender", value: "b@x.com" },
      window: { kind: "weekly", dayOfWeek: 1, hour: 8, minute: 0 },
    })
    const c = await createDeliverySchedule(executor, accountId, {
      match: { kind: "sender", value: "c@x.com" },
      window: { kind: "weekly", dayOfWeek: 2, hour: 8, minute: 0 },
    })

    await deleteDeliverySchedule(executor, accountId, "no-such-id")
    await reorderDeliverySchedules(executor, accountId, [c.id, a.id])

    const list = await listDeliverySchedules(executor, accountId)
    expect(list.map((schedule) => schedule.id)).toEqual([c.id, a.id, b.id])
    // Positions re-densified (0…n-1) after the reorder.
    expect(list.map((schedule) => schedule.position)).toEqual([0, 1, 2])
  })

  it("rejects invalid windows and matches on write", async () => {
    await expect(
      createDeliverySchedule(executor, accountId, {
        match: newsletterSchedule.match,
        window: { kind: "weekly", dayOfWeek: 7, hour: 8, minute: 0 },
      })
    ).rejects.toThrow("dayOfWeek")
    await expect(
      createDeliverySchedule(executor, accountId, {
        match: newsletterSchedule.match,
        window: { kind: "weekly", dayOfWeek: 1, hour: 24, minute: 0 },
      })
    ).rejects.toThrow("hour")
    await expect(
      createDeliverySchedule(executor, accountId, {
        match: { kind: "sender", value: "  " },
        window: newsletterSchedule.window,
      })
    ).rejects.toThrow("match")
  })

  it("drops corrupt stored entries on read instead of crashing", async () => {
    const valid = await createDeliverySchedule(
      executor,
      accountId,
      newsletterSchedule
    )
    await setSetting(executor, deliverySchedulesSettingKey(accountId), [
      { junk: true },
      valid,
      { id: "half", match: { kind: "label", value: "x" }, position: 5 },
    ])
    const list = await listDeliverySchedules(executor, accountId)
    expect(list.map((schedule) => schedule.id)).toEqual([valid.id])
  })
})

// ---- Window math (pure) ------------------------------------------------------

describe("nextWindowOccurrence", () => {
  const schedule = (
    dayOfWeek: number,
    hour: number,
    minute: number
  ): DeliverySchedule => ({
    id: "s",
    match: { kind: "label", value: "Newsletters" },
    window: { kind: "weekly", dayOfWeek, hour, minute },
    position: 0,
  })
  const expectOccurrence = (
    occurrence: Date,
    y: number,
    m: number,
    d: number,
    h: number,
    min: number
  ) => {
    expect(occurrence).toEqual(new Date(y, m, d, h, min, 0, 0))
  }

  it("finds the coming day of the window's weekday this week", () => {
    // Wednesday Sep 16 2026, 10:00 local → Saturday the 19th, 8:00.
    const now = new Date(2026, 8, 16, 10, 0, 0)
    expectOccurrence(
      nextWindowOccurrence(schedule(6, 8, 0), now),
      2026,
      8,
      19,
      8,
      0
    )
  })

  it("rolls to next week when today's window time already passed", () => {
    // Wednesday 10:00, window Wednesday 8:00 (2h ago) → next Wednesday.
    const now = new Date(2026, 8, 16, 10, 0, 0)
    expectOccurrence(
      nextWindowOccurrence(schedule(3, 8, 0), now),
      2026,
      8,
      23,
      8,
      0
    )
  })

  it("is STRICTLY after now: a moment exactly at the window waits a week", () => {
    const now = new Date(2026, 8, 16, 10, 0, 0)
    expectOccurrence(
      nextWindowOccurrence(schedule(3, 10, 0), now),
      2026,
      8,
      23,
      10,
      0
    )
  })

  it("honors later-today windows and minute precision", () => {
    const now = new Date(2026, 8, 16, 10, 0, 0)
    expectOccurrence(
      nextWindowOccurrence(schedule(3, 11, 30), now),
      2026,
      8,
      16,
      11,
      30
    )
  })

  it("wraps the day boundary forward (Saturday night → Sunday morning)", () => {
    const now = new Date(2026, 8, 19, 23, 0, 0) // Saturday
    expectOccurrence(
      nextWindowOccurrence(schedule(0, 0, 30), now),
      2026,
      8,
      20,
      0,
      30
    )
  })

  it("wraps the day boundary backward (just after midnight → next week)", () => {
    const now = new Date(2026, 8, 20, 1, 0, 0) // Sunday, 30 min after the window
    expectOccurrence(
      nextWindowOccurrence(schedule(0, 0, 30), now),
      2026,
      8,
      27,
      0,
      30
    )
  })

  it("the week rollover keeps the window's local wall time across a DST shift", () => {
    // The rollover (window already passed today → next week) is rebuilt
    // with the same wall-clock path as the primary branch, so the +7d
    // candidate stays at the picked LOCAL time even when the week crosses
    // a DST shift. US 2026: DST starts Sunday Mar 8 (02:00 → 03:00) and
    // ends Sunday Nov 1 — a Sunday-morning window rolled over from just
    // after it passes crosses the shift; in a millisecond-add
    // implementation these would come back an hour off (in TZs without
    // that shift both paths agree, and the shared builder is the guard).
    const beforeSpringForward = new Date(2026, 2, 8, 1, 45, 0) // Sunday
    expectOccurrence(
      nextWindowOccurrence(schedule(0, 1, 30), beforeSpringForward),
      2026,
      2,
      15,
      1,
      30
    )
    const afterFallBack = new Date(2026, 10, 1, 2, 45, 0) // Sunday
    expectOccurrence(
      nextWindowOccurrence(schedule(0, 2, 30), afterFallBack),
      2026,
      10,
      8,
      2,
      30
    )
  })
})

// ---- Ingestion resolution -----------------------------------------------------

describe("resolveHoldFromSchedules / resolveDeliveryHold", () => {
  it("matches a sender case-insensitively and computes the next window", () => {
    const schedules: DeliverySchedule[] = [
      {
        id: "s",
        match: { kind: "sender", value: "news@x.com" },
        window: { kind: "weekly", dayOfWeek: 6, hour: 8, minute: 0 },
        position: 0,
      },
    ]
    // Wednesday Sep 16 2026 10:00 → Saturday the 19th 8:00 local.
    const now = Math.floor(new Date(2026, 8, 16, 10, 0, 0).getTime() / 1000)
    const hold = resolveHoldFromSchedules(
      schedules,
      { senderAddress: "NEWS@x.com", labelNames: [] },
      now
    )
    expect(hold).toBe(
      Math.floor(new Date(2026, 8, 19, 8, 0, 0).getTime() / 1000)
    )
    // A null sender never matches a sender rule.
    expect(
      resolveHoldFromSchedules(
        schedules,
        { senderAddress: null, labelNames: [] },
        now
      )
    ).toBeNull()
  })

  it("matches a label name or its trailing leaf, but not a parent label", () => {
    const schedules: DeliverySchedule[] = [
      {
        id: "s",
        match: { kind: "label", value: "Newsletters" },
        window: { kind: "weekly", dayOfWeek: 6, hour: 8, minute: 0 },
        position: 0,
      },
    ]
    const now = 0
    const match = (labelNames: string[]) =>
      resolveHoldFromSchedules(
        schedules,
        { senderAddress: null, labelNames },
        now
      )
    expect(match(["Newsletters"])).not.toBeNull()
    expect(match(["Finance/Newsletters"])).not.toBeNull() // the leaf
    expect(match(["Newsletters/2024"])).toBeNull() // a parent segment
    expect(match(["Inbox", "Finance/Newsletters"])).not.toBeNull()
  })

  it("the first matching schedule in position order wins", () => {
    const early: DeliverySchedule = {
      id: "early",
      match: { kind: "sender", value: "news@x.com" },
      window: { kind: "weekly", dayOfWeek: 6, hour: 8, minute: 0 },
      position: 0,
    }
    const late: DeliverySchedule = {
      id: "late",
      match: { kind: "label", value: "Newsletters" },
      window: { kind: "weekly", dayOfWeek: 0, hour: 21, minute: 0 },
      position: 1,
    }
    const now = Math.floor(new Date(2026, 8, 16, 10, 0, 0).getTime() / 1000)
    expect(
      resolveHoldFromSchedules(
        [early, late],
        { senderAddress: "news@x.com", labelNames: ["Newsletters"] },
        now
      )
    ).toBe(Math.floor(new Date(2026, 8, 19, 8, 0, 0).getTime() / 1000))
  })

  it("resolveDeliveryHold consults the stored row; options preloads and pins now", async () => {
    await createDeliverySchedule(executor, accountId, newsletterSchedule)
    const now = Math.floor(new Date(2026, 8, 16, 10, 0, 0).getTime() / 1000)
    const expected = Math.floor(new Date(2026, 8, 19, 8, 0, 0).getTime() / 1000)

    // Loads the account's row itself…
    expect(
      await resolveDeliveryHold(executor, accountId, {
        senderAddress: null,
        labelNames: ["Newsletters"],
      })
    ).not.toBeNull()
    // …and honors the preloaded-schedules + pinned-now shape the sync
    // engines and tests use.
    expect(
      await resolveDeliveryHold(
        executor,
        accountId,
        { senderAddress: null, labelNames: ["Newsletters"] },
        { now }
      )
    ).toBe(expected)

    // Another account has no row → no hold.
    const other = await createAccount(executor, "imap")
    expect(
      await resolveDeliveryHold(
        executor,
        other,
        { senderAddress: null, labelNames: ["Newsletters"] },
        { now }
      )
    ).toBeNull()
  })
})
