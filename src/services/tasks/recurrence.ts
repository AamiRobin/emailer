import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  endOfMonth,
  fromUnixTime,
  getDate,
  getDay,
  setDate,
} from "date-fns"

/**
 * Recurrence rules for tasks (task 5.6, tasks spec "Task management",
 * design D6). Pure module: rule shape, validation and the
 * expansion-on-completion date math. No DB, no app state — the service
 * (tasks/service.ts) stores `serializeRecurrence(rule)` in
 * `tasks.recurrence_json` and calls {@link nextOccurrence} when a
 * recurring task is completed.
 *
 * FROM-THE-DUE-DATE rule (the spec's core requirement): the next
 * occurrence is always computed from the COMPLETED INSTANCE'S DUE DATE,
 * never from the completion time — completing a weekly task 3 days late
 * still schedules due + 7 days, not completion + 7 days. The service owns
 * that wiring; this module just implements `nextOccurrence(rule, from)`.
 *
 * Calendar decisions (documented per the spec's "same date next period"
 * intent):
 * - All math preserves the from-date's local time-of-day (a 15:00 due
 *   recurs at 15:00) and works in local wall-clock time (date-fns default).
 * - weekly: strictly-AFTER semantics — even when the due date itself is a
 *   selected weekday, the next occurrence is the next SELECTED weekday on
 *   a LATER day (a Friday due with Mon+Fri selected re-arms to Monday).
 * - monthly: same day-of-month, CLAMPED to the target month's end — Jan 31
 *   expands to Feb 28 (Feb 29 on leap years). The anchor day is the rule's
 *   explicit `dayOfMonth` when set, otherwise the from-date's day. An
 *   inferred anchor DRIFTS after a clamp (Jan 31 → Feb 28 → Mar 28,
 *   because expansion runs from the current due date); an explicit
 *   `dayOfMonth` never drifts (Jan 31 → Feb 28 → Mar 31). Drift is the
 *   standard trade-off for anchor-less expansion and is why the UI (task
 *   5.7) should pass `dayOfMonth` whenever the user picked a concrete day.
 * - yearly: same month/day; Feb 29 expands to Feb 28 on non-leap years
 *   (date-fns addYears clamp), with the same inferred-anchor drift note as
 *   monthly.
 * - everyN: plain unit arithmetic (N ≥ 1), no clamping needed for
 *   days/weeks; month units clamp month-ends like monthly does.
 */

/** Weekday numbers follow `Date.getDay()`: 0 = Sunday … 6 = Saturday. */
export type RecurrenceRule =
  | { kind: "daily" }
  | { kind: "weekly"; weekdays: number[] }
  | { kind: "monthly"; dayOfMonth?: number }
  | { kind: "yearly" }
  | { kind: "everyN"; unit: "day" | "week" | "month"; n: number }

const RULE_KINDS = new Set(["daily", "weekly", "monthly", "yearly", "everyN"])

function isFiniteInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    Number.isInteger(value)
}

/**
 * Validate an unknown value as a {@link RecurrenceRule}. Returns the
 * normalized rule (weekdays deduped + sorted) or null when the value is
 * not a rule this module understands — unknown shapes degrade to
 * "no recurrence", never throw: a rule was user- or model-authored and a
 * malformed one must not break listing or completion.
 */
export function parseRecurrenceRule(raw: unknown): RecurrenceRule | null {
  if (raw === null || typeof raw !== "object") return null
  const record = raw as Record<string, unknown>
  if (typeof record.kind !== "string" || !RULE_KINDS.has(record.kind)) {
    return null
  }
  switch (record.kind) {
    case "daily":
      return { kind: "daily" }
    case "yearly":
      return { kind: "yearly" }
    case "weekly": {
      if (!Array.isArray(record.weekdays)) return null
      const weekdays = [
        ...new Set(
          record.weekdays.filter(
            (day) => isFiniteInt(day) && day >= 0 && day <= 6
          )
        ),
      ].sort((a, b) => a - b)
      // The spec allows weekly recurrence only WITH weekday selection.
      if (weekdays.length === 0) return null
      return { kind: "weekly", weekdays }
    }
    case "monthly": {
      if (
        record.dayOfMonth !== undefined &&
        (!isFiniteInt(record.dayOfMonth) ||
          record.dayOfMonth < 1 ||
          record.dayOfMonth > 31)
      ) {
        return null
      }
      return record.dayOfMonth === undefined
        ? { kind: "monthly" }
        : { kind: "monthly", dayOfMonth: record.dayOfMonth }
    }
    case "everyN": {
      if (
        record.unit !== "day" &&
        record.unit !== "week" &&
        record.unit !== "month"
      ) {
        return null
      }
      if (!isFiniteInt(record.n) || record.n < 1) return null
      return { kind: "everyN", unit: record.unit, n: record.n }
    }
  }
  // Unreachable: kind is one of RULE_KINDS (checked above), but the switch
  // narrows over `string` so TS needs the terminal return.
  return null
}

/** Parse the stored `recurrence_json` column; null (or garbage) = no rule. */
export function parseRecurrenceJson(json: string | null): RecurrenceRule | null {
  if (json === null || json === "") return null
  try {
    return parseRecurrenceRule(JSON.parse(json))
  } catch {
    return null
  }
}

/** Serialize a rule for the `recurrence_json` column. */
export function serializeRecurrence(rule: RecurrenceRule): string {
  return JSON.stringify(rule)
}

/**
 * The next occurrence STRICTLY AFTER `fromDueDate`, or null when the rule
 * is invalid (e.g. weekly with an empty weekday set). `fromDueDate` is the
 * completed instance's due date — the caller (service completeTask) is
 * responsible for passing the DUE date, not the completion time.
 */
export function nextOccurrence(
  rule: RecurrenceRule,
  fromDueDate: Date
): Date | null {
  switch (rule.kind) {
    case "daily":
      return addDays(fromDueDate, 1)
    case "weekly": {
      if (rule.weekdays.length === 0) return null
      // Scan the seven days after the due date for the next selected
      // weekday — a full week always contains a match for a valid rule.
      for (let offset = 1; offset <= 7; offset += 1) {
        const candidate = addDays(fromDueDate, offset)
        if (rule.weekdays.includes(getDay(candidate))) return candidate
      }
      return null
    }
    case "monthly": {
      // Anchor day: the explicit rule day when given, else the due date's
      // own day-of-month (see the drift note in the module doc).
      const anchorDay = rule.dayOfMonth ?? getDate(fromDueDate)
      const nextMonth = addMonths(fromDueDate, 1)
      const lastDay = getDate(endOfMonth(nextMonth))
      return setDate(nextMonth, Math.min(anchorDay, lastDay))
    }
    case "yearly":
      // date-fns clamps Feb 29 + 1y to Feb 28 on non-leap years.
      return addYears(fromDueDate, 1)
    case "everyN":
      switch (rule.unit) {
        case "day":
          return addDays(fromDueDate, rule.n)
        case "week":
          return addWeeks(fromDueDate, rule.n)
        case "month":
          return addMonths(fromDueDate, rule.n)
      }
  }
}

/** Convenience for service code: next due date as unix epoch seconds. */
export function nextOccurrenceFromUnix(
  rule: RecurrenceRule,
  fromDueAtSeconds: number
): number | null {
  const next = nextOccurrence(rule, fromUnixTime(fromDueAtSeconds))
  return next === null ? null : Math.floor(next.getTime() / 1000)
}
