import { describe, expect, it } from "vitest"

import {
  nextOccurrence,
  nextOccurrenceFromUnix,
  parseRecurrenceJson,
  parseRecurrenceRule,
  serializeRecurrence,
  type RecurrenceRule,
} from "../recurrence"

/**
 * Recurrence date-math tests (task 5.6). All dates are local-time
 * `Date`s; the module preserves the from-date's time-of-day. The cases
 * below pin the documented calendar decisions: weekly strictly-after
 * weekday selection, monthly day-of-month clamping, yearly Feb-29
 * handling, everyN unit arithmetic across month boundaries, and the
 * from-due-date contract (nextOccurrence only ever sees the due date —
 * the "completed late" behavior is proven at the service level in
 * service.test.ts).
 */

/** Weekday-asserting helper: 0 = Sunday … 6 = Saturday. */
function dateOf(
  year: number,
  monthIndex: number,
  day: number,
  hour = 0,
  minute = 0
): Date {
  return new Date(year, monthIndex, day, hour, minute, 0, 0)
}

function expectIsDate(actual: Date | null, expected: Date): void {
  expect(actual).not.toBeNull()
  expect(actual?.getFullYear()).toBe(expected.getFullYear())
  expect(actual?.getMonth()).toBe(expected.getMonth())
  expect(actual?.getDate()).toBe(expected.getDate())
  expect(actual?.getHours()).toBe(expected.getHours())
  expect(actual?.getMinutes()).toBe(expected.getMinutes())
}

// Friday, March 6 2026 (getDay() = 5) at 15:00 local.
const FRI_MAR_6_2026 = dateOf(2026, 2, 6, 15, 0)

describe("nextOccurrence daily", () => {
  it("advances exactly one day, preserving the time of day", () => {
    expectIsDate(
      nextOccurrence({ kind: "daily" }, FRI_MAR_6_2026),
      dateOf(2026, 2, 7, 15, 0)
    )
  })

  it("crosses month boundaries by plain arithmetic", () => {
    expectIsDate(
      nextOccurrence({ kind: "daily" }, dateOf(2026, 0, 31, 9, 30)),
      dateOf(2026, 1, 1, 9, 30)
    )
  })
})

describe("nextOccurrence weekly (weekday selection)", () => {
  it("picks the next selected weekday after the due date", () => {
    // Due Friday, Mondays + Wednesdays selected → the coming Monday.
    expectIsDate(
      nextOccurrence({ kind: "weekly", weekdays: [1, 3] }, FRI_MAR_6_2026),
      dateOf(2026, 2, 9, 15, 0)
    )
  })

  it("skips the due date itself even when it is a selected weekday", () => {
    // Due Friday with Fridays selected → NEXT Friday (strictly after).
    expectIsDate(
      nextOccurrence({ kind: "weekly", weekdays: [5] }, FRI_MAR_6_2026),
      dateOf(2026, 2, 13, 15, 0)
    )
  })

  it("normalizes unordered weekday sets", () => {
    expectIsDate(
      nextOccurrence({ kind: "weekly", weekdays: [3, 1] }, FRI_MAR_6_2026),
      dateOf(2026, 2, 9, 15, 0)
    )
  })

  it("wraps over the weekend", () => {
    // Due Friday with Sat+Sun selected → the very next day (Saturday).
    expectIsDate(
      nextOccurrence({ kind: "weekly", weekdays: [0, 6] }, FRI_MAR_6_2026),
      dateOf(2026, 2, 7, 15, 0)
    )
  })
})

describe("nextOccurrence monthly (day-of-month clamping)", () => {
  it("clamps Jan 31 to Feb 28 in a month with fewer days", () => {
    const jan31 = dateOf(2026, 0, 31, 9, 30)
    expectIsDate(
      nextOccurrence({ kind: "monthly" }, jan31),
      dateOf(2026, 1, 28, 9, 30)
    )
  })

  it("clamps to Feb 29 on a leap year", () => {
    expectIsDate(
      nextOccurrence({ kind: "monthly" }, dateOf(2024, 0, 31, 9, 30)),
      dateOf(2024, 1, 29, 9, 30)
    )
  })

  it("keeps the day when the next month is long enough", () => {
    expectIsDate(
      nextOccurrence({ kind: "monthly" }, dateOf(2026, 0, 15, 8, 0)),
      dateOf(2026, 1, 15, 8, 0)
    )
  })

  it("honors an explicit dayOfMonth anchor (no drift after a clamp)", () => {
    // The Feb 28 (clamped) instance completed → explicit 31 lands Mar 31.
    expectIsDate(
      nextOccurrence({ kind: "monthly", dayOfMonth: 31 }, dateOf(2026, 1, 28, 9, 30)),
      dateOf(2026, 2, 31, 9, 30)
    )
  })

  it("uses the due date's own day as the inferred anchor", () => {
    // Documented drift: a clamped Feb 28 due expands to Mar 28 when the
    // rule carries no explicit dayOfMonth.
    expectIsDate(
      nextOccurrence({ kind: "monthly" }, dateOf(2026, 1, 28, 9, 30)),
      dateOf(2026, 2, 28, 9, 30)
    )
  })
})

describe("nextOccurrence yearly (Feb-29 handling)", () => {
  it("expands Feb 29 to Feb 28 on a non-leap year", () => {
    expectIsDate(
      nextOccurrence({ kind: "yearly" }, dateOf(2024, 1, 29, 12, 0)),
      dateOf(2025, 1, 28, 12, 0)
    )
  })

  it("keeps month/day and time for ordinary dates", () => {
    expectIsDate(
      nextOccurrence({ kind: "yearly" }, dateOf(2026, 5, 10, 7, 45)),
      dateOf(2027, 5, 10, 7, 45)
    )
  })
})

describe("nextOccurrence everyN (unit arithmetic across months)", () => {
  it("adds N days across a month boundary", () => {
    expectIsDate(
      nextOccurrence({ kind: "everyN", unit: "day", n: 3 }, dateOf(2026, 0, 30, 6, 0)),
      dateOf(2026, 1, 2, 6, 0)
    )
  })

  it("adds N weeks", () => {
    expectIsDate(
      nextOccurrence(
        { kind: "everyN", unit: "week", n: 2 },
        FRI_MAR_6_2026
      ),
      dateOf(2026, 2, 20, 15, 0)
    )
  })

  it("adds N months with month-end clamping", () => {
    expectIsDate(
      nextOccurrence(
        { kind: "everyN", unit: "month", n: 1 },
        dateOf(2026, 0, 31, 9, 30)
      ),
      dateOf(2026, 1, 28, 9, 30)
    )
  })
})

describe("rule validation", () => {
  it("accepts the documented shapes and normalizes weekdays", () => {
    expect(parseRecurrenceRule({ kind: "daily" })).toEqual({ kind: "daily" })
    expect(parseRecurrenceRule({ kind: "yearly" })).toEqual({ kind: "yearly" })
    expect(
      parseRecurrenceRule({ kind: "weekly", weekdays: [3, 1, 1] })
    ).toEqual({ kind: "weekly", weekdays: [1, 3] })
    expect(parseRecurrenceRule({ kind: "monthly", dayOfMonth: 31 })).toEqual({
      kind: "monthly",
      dayOfMonth: 31,
    })
    expect(parseRecurrenceRule({ kind: "monthly" })).toEqual({ kind: "monthly" })
    expect(parseRecurrenceRule({ kind: "everyN", unit: "day", n: 3 })).toEqual({
      kind: "everyN",
      unit: "day",
      n: 3,
    })
  })

  it("rejects malformed rules as null (degrade, never throw)", () => {
    expect(parseRecurrenceRule(null)).toBeNull()
    expect(parseRecurrenceRule("weekly")).toBeNull()
    expect(parseRecurrenceRule({ kind: "quarterly" })).toBeNull()
    // Weekly without a non-empty weekday set is not a rule.
    expect(parseRecurrenceRule({ kind: "weekly", weekdays: [] })).toBeNull()
    expect(parseRecurrenceRule({ kind: "weekly" })).toBeNull()
    // Out-of-range weekday numbers are filtered; all-bad → rejected.
    expect(parseRecurrenceRule({ kind: "weekly", weekdays: [7, -1] })).toBeNull()
    expect(parseRecurrenceRule({ kind: "monthly", dayOfMonth: 0 })).toBeNull()
    expect(parseRecurrenceRule({ kind: "monthly", dayOfMonth: 32 })).toBeNull()
    expect(parseRecurrenceRule({ kind: "everyN", unit: "hour", n: 2 })).toBeNull()
    expect(parseRecurrenceRule({ kind: "everyN", unit: "day", n: 0 })).toBeNull()
    expect(
      parseRecurrenceRule({ kind: "everyN", unit: "day", n: 1.5 })
    ).toBeNull()
  })

  it("nextOccurrence returns null for an (unreachable) empty weekday set", () => {
    expect(
      nextOccurrence({ kind: "weekly", weekdays: [] } as RecurrenceRule,
        FRI_MAR_6_2026)
    ).toBeNull()
  })
})

describe("serialization round trip", () => {
  it("serializes and parses back to the same rule", () => {
    const rule: RecurrenceRule = { kind: "weekly", weekdays: [1, 3] }
    expect(parseRecurrenceJson(serializeRecurrence(rule))).toEqual(rule)
  })

  it("parses null, empty and garbage column values to null", () => {
    expect(parseRecurrenceJson(null)).toBeNull()
    expect(parseRecurrenceJson("")).toBeNull()
    expect(parseRecurrenceJson("{not json")).toBeNull()
    expect(parseRecurrenceJson("\"a string\"")).toBeNull()
  })
})

describe("nextOccurrenceFromUnix", () => {
  it("converts unix seconds in and out of the date math", () => {
    const dueAt = Math.floor(dateOf(2026, 0, 31, 9, 30).getTime() / 1000)
    const expected = Math.floor(dateOf(2026, 1, 28, 9, 30).getTime() / 1000)
    expect(
      nextOccurrenceFromUnix({ kind: "monthly" }, dueAt)
    ).toBe(expected)
  })
})
