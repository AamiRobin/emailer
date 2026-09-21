import {
  addDays,
  addMonths,
  addWeeks,
  differenceInCalendarDays,
  format,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subDays,
  subMonths,
  subWeeks,
} from "date-fns"
import { fromUnixTime } from "date-fns"

import type { CalendarEvent } from "@/services/calendar/events"

/**
 * Calendar view model (task 5.3, design D5) — the pure helpers behind
 * calendar-view.tsx, kept out of the tsx so fast-refresh sees components
 * only (the thread-list-store presentation-helpers precedent).
 *
 * Three decisions live here, documented:
 *
 * Color (per-calendar, spec "color-coded per calendar"): the data model has
 * no per-calendar color column (task 5.1 stores no calendarList entry), so
 * the hue is DERIVED from `${sourceId}:${calendarId}` with the same djb2
 * hash mod 360 as the account identity hue (account-hue.ts) — deterministic
 * across sessions and surfaces. Rendering uses an hsl dot plus a
 * low-alpha hsl chip background/border with TOKEN text colors
 * (text-foreground), mirroring the account-badge dot pattern, so chips stay
 * legible in both themes without hardcoding theme-specific colors.
 *
 * Lane packing (overlapping timed events): a simple greedy per-day lane
 * assignment — sort by start (longer first on ties), drop each event into
 * the first lane whose last event already ended, else open a new lane; each
 * event spans 1/laneCount of the column width. Deliberately day-wide (not
 * per-cluster): a busy hour narrows the whole day's events, which keeps the
 * geometry stable and the code small; a real cluster-aware layout is a
 * later refinement.
 *
 * All-day bucketing (spec "all-day events in a dedicated row"): all-day
 * events are stored at UTC midnight (task 5.1, Google's `date` convention),
 * so they are bucketed by UTC calendar day, and each grid day contributes
 * the UTC day key of its LOCAL-NOON instant — stable for every real-world
 * timezone (±11h), so a UTC "Mar 5" all-day lands on the local "Mar 5"
 * column everywhere. Timed events bucket by local calendar day. The
 * dedicated all-day row exists in the week/day views (above the time
 * grid); the month view renders all-day events as chips inside their day
 * cells (the Google-month convention) since it has no hourly grid.
 */

export type CalendarViewUnit = "month" | "week" | "day"

/** Deterministic hue (0-359) for one calendar (source + calendar id). */
export function calendarHue(calendarKey: string): number {
  let hash = 5381
  for (let index = 0; index < calendarKey.length; index += 1) {
    hash = ((hash << 5) + hash + calendarKey.charCodeAt(index)) % 360
  }
  return hash
}

export interface CalendarColor {
  /** Solid accent for the chip's dot. */
  dot: string
  /** Low-alpha wash for the chip background (token text on top). */
  chipBackground: string
  /** Low-alpha border tying the chip to its calendar. */
  chipBorder: string
}

export function calendarColor(hue: number): CalendarColor {
  return {
    dot: `hsl(${hue} 55% 50%)`,
    chipBackground: `hsl(${hue} 55% 50% / 0.12)`,
    chipBorder: `hsl(${hue} 55% 50% / 0.35)`,
  }
}

/** The per-calendar color key of an event. */
export function eventCalendarKey(event: CalendarEvent): string {
  return `${event.sourceId}:${event.calendarId}`
}

export function eventColor(event: CalendarEvent): CalendarColor {
  return calendarColor(calendarHue(eventCalendarKey(event)))
}

// ---------------------------------------------------------------------------
// Range model: focus date + unit → grid range (exclusive end)
// ---------------------------------------------------------------------------

export interface GridRange {
  /** First day shown (local midnight). */
  start: Date
  /** EXCLUSIVE end — the epoch query range's upper bound. */
  end: Date
  /** One Date per visible column/day (42 for month, 7 for week, 1 for day). */
  days: Date[]
}

/**
 * The grid behind a focus date: month = the 6-week (42-cell) grid covering
 * startOfMonth…endOfMonth; week = the locale week (weekStartsOn default —
 * Sunday for en-US, date-fns' default) containing the focus; day = the
 * single focus day. The end is exclusive so the query range is a clean
 * [start, end).
 */
export function gridRangeFor(
  focus: Date,
  unit: CalendarViewUnit
): GridRange {
  if (unit === "day") {
    const start = startOfDay(focus)
    return { start, end: addDays(start, 1), days: [start] }
  }
  if (unit === "week") {
    const start = startOfWeek(focus)
    const days: Date[] = []
    for (let index = 0; index < 7; index += 1) days.push(addDays(start, index))
    return { start, end: addDays(start, 7), days }
  }
  const start = startOfWeek(startOfMonth(focus))
  const days: Date[] = []
  for (let index = 0; index < 42; index += 1) days.push(addDays(start, index))
  return { start, end: addDays(start, 42), days }
}

/** Navigate forward/backward by the view's unit (spec: by their unit). */
export function shiftFocus(
  focus: Date,
  unit: CalendarViewUnit,
  delta: 1 | -1
): Date {
  if (unit === "month") return delta === 1 ? addMonths(focus, 1) : subMonths(focus, 1)
  if (unit === "week") return delta === 1 ? addWeeks(focus, 1) : subWeeks(focus, 1)
  return addDays(focus, delta)
}

/** Header label for the visible period. */
export function periodLabel(focus: Date, unit: CalendarViewUnit): string {
  if (unit === "month") return format(focus, "MMMM yyyy")
  if (unit === "day") return format(focus, "EEEE, MMMM d, yyyy")
  // Week: "Sep 7 – 13, 2026" via the exclusive end's last covered day.
  const start = startOfWeek(focus)
  return `${format(start, "MMM d")} – ${format(subDays(addDays(start, 7), 1), "MMM d, yyyy")}`
}

// ---------------------------------------------------------------------------
// Day bucketing
// ---------------------------------------------------------------------------

/** Local ISO day key ("2026-03-05") of a Date. */
export function localDayKey(date: Date): string {
  return format(date, "yyyy-MM-dd")
}

/**
 * The ISO day keys an event covers: all-day events enumerate UTC days over
 * [startAt, endAt) (their native storage frame); timed events enumerate
 * LOCAL days over the covered instants. Capped at 62 keys — a pathological
 * years-long event still renders (clamped) rather than hanging the view.
 */
export function eventDayKeys(event: CalendarEvent): string[] {
  const keys: string[] = []
  if (event.allDay) {
    let dayStart = Math.floor(event.startAt / 86400) * 86400
    const lastInstant = event.endAt - 1
    while (dayStart <= lastInstant && keys.length < 62) {
      keys.push(new Date(dayStart * 1000).toISOString().slice(0, 10))
      dayStart += 86400
    }
    return keys
  }
  let day = startOfDay(fromUnixTime(event.startAt))
  const lastDay = startOfDay(fromUnixTime(Math.max(event.endAt - 1, event.startAt)))
  while (day <= lastDay && keys.length < 62) {
    keys.push(localDayKey(day))
    day = addDays(day, 1)
  }
  return keys
}

/**
 * True when the event belongs in the dedicated all-day row (week/day):
 * every all-day event, plus multi-day timed events (they cannot sit on one
 * day's hourly column honestly).
 */
export function isAllDayRowEvent(event: CalendarEvent): boolean {
  if (event.allDay) return true
  return (
    differenceInCalendarDays(
      startOfDay(fromUnixTime(Math.max(event.endAt - 1, event.startAt))),
      startOfDay(fromUnixTime(event.startAt))
    ) > 0
  )
}

// ---------------------------------------------------------------------------
// Lane packing + positioning
// ---------------------------------------------------------------------------

/** An event with its greedy lane assignment (see the module docstring). */
export interface LaidOutEvent<T> {
  item: T
  lane: number
  laneCount: number
}

/**
 * Greedy lane packing over items with [startSec, endSec) spans: first lane
 * whose recorded end <= the item's start wins, else a new lane opens. Width
 * splits evenly across the total lane count (the documented simple policy).
 */
export function packLanes<T>(
  items: T[],
  startOf: (item: T) => number,
  endOf: (item: T) => number
): LaidOutEvent<T>[] {
  const ordered = [...items].sort((a, b) =>
    startOf(a) !== startOf(b)
      ? startOf(a) - startOf(b)
      : endOf(b) - endOf(a) // longer first on ties
  )
  const laneEnds: number[] = []
  const laid: LaidOutEvent<T>[] = []
  for (const item of ordered) {
    let lane = laneEnds.findIndex((end) => end <= startOf(item))
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(endOf(item))
    } else {
      laneEnds[lane] = endOf(item)
    }
    laid.push({ item, lane, laneCount: 0 })
  }
  for (const entry of laid) entry.laneCount = laneEnds.length
  return laid
}
