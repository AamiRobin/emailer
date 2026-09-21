import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { format } from "date-fns"

import { uid } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { useOnlineStore } from "@/stores/online-store"
import { refreshCalendars } from "@/services/calendar/events"
import { CalendarView } from "../calendar-view"
import { setCalendarViewExecutor } from "../use-calendar-view"

/**
 * Calendar view render tests (task 5.3, design D5). The event data runs
 * REAL range queries against a seeded node:sqlite database through the
 * executor override (the attachments-browser harness); only the refresh
 * orchestration is stubbed at the module seam — the component's contract
 * is WHEN it refreshes (never offline) and how it reports failure (banner
 * without losing the cached rendering). No jest-dom: assertions read
 * textContent and data attributes.
 */

vi.mock("@/services/calendar/events", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/calendar/events")>()
  return {
    ...actual,
    refreshCalendars: vi.fn(),
  }
})

const refreshMock = vi.mocked(refreshCalendars)

let executor: TestExecutor

/** Epoch seconds for a LOCAL wall-clock instant (timed-event seeds). */
function localSeconds(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0
): number {
  return Math.floor(new Date(year, month - 1, day, hour, minute).getTime() / 1000)
}

/** Epoch seconds for a UTC instant (all-day seeds sit at UTC midnight). */
function utcSeconds(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / 1000)
}

async function seedSource(id: string, name: string): Promise<void> {
  await executor.execute(
    `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
     VALUES ($1, NULL, 'google', $2, 'sealed')`,
    [id, name]
  )
}

async function seedEvent(overrides: {
  sourceId: string
  calendarId: string
  summary: string
  startAt: number
  endAt: number
  allDay?: boolean
}): Promise<string> {
  const id = `ce-${uid("e")}`
  await executor.execute(
    `INSERT INTO calendar_events (
       id, source_id, calendar_id, uid, ical, summary, start_at, end_at, all_day
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      id,
      overrides.sourceId,
      overrides.calendarId,
      uid("uid"),
      "BEGIN:VEVENT",
      overrides.summary,
      overrides.startAt,
      overrides.endAt,
      overrides.allDay ? 1 : 0,
    ]
  )
  return id
}

/**
 * March 2026 fixtures around the focus date Mar 15 (a Sunday, so the week
 * view shows Mar 15–21): a plain timed event early in the month, an
 * overlapping pair mid-month (lane packing), a second calendar's event,
 * and a multi-day all-day event for the dedicated row.
 */
let designReviewId: string
let overlapAId: string
let overlapBId: string
let otherCalendarId: string
let offsiteId: string

async function seedMarch(): Promise<void> {
  await seedSource("src-a", "me@gmail.com")
  await seedSource("src-b", "Work Calendar")
  designReviewId = await seedEvent({
    sourceId: "src-a",
    calendarId: "cal-a1",
    summary: "Design review",
    startAt: localSeconds(2026, 3, 2, 10),
    endAt: localSeconds(2026, 3, 2, 11),
  })
  overlapAId = await seedEvent({
    sourceId: "src-a",
    calendarId: "cal-a1",
    summary: "Overlap A",
    startAt: localSeconds(2026, 3, 17, 9),
    endAt: localSeconds(2026, 3, 17, 10, 30),
  })
  overlapBId = await seedEvent({
    sourceId: "src-a",
    calendarId: "cal-a1",
    summary: "Overlap B",
    startAt: localSeconds(2026, 3, 17, 10),
    endAt: localSeconds(2026, 3, 17, 11),
  })
  otherCalendarId = await seedEvent({
    sourceId: "src-b",
    calendarId: "cal-b1",
    summary: "From the other calendar",
    startAt: localSeconds(2026, 3, 6, 14),
    endAt: localSeconds(2026, 3, 6, 15),
  })
  offsiteId = await seedEvent({
    sourceId: "src-b",
    calendarId: "cal-b1",
    summary: "Offsite",
    startAt: utcSeconds(2026, 3, 19),
    endAt: utcSeconds(2026, 3, 21),
    allDay: true,
  })
}

const FOCUS = new Date(2026, 2, 15)

function eventChip(eventId: string): HTMLElement {
  return screen
    .getAllByTestId("calendar-event")
    .find((chip) => chip.dataset.eventId === eventId)!
}

function dayCell(dateKey: string): HTMLElement {
  return screen
    .getAllByTestId("calendar-day-cell")
    .find((cell) => cell.dataset.date === dateKey)!
}

function dayColumn(dateKey: string): HTMLElement {
  return screen
    .getAllByTestId("calendar-day-column")
    .find((column) => column.dataset.date === dateKey)!
}

beforeEach(() => {
  executor = createTestExecutor()
  setCalendarViewExecutor(executor)
  useOnlineStore.setState({ online: true })
  refreshMock.mockReset()
})

afterEach(() => {
  cleanup()
  setCalendarViewExecutor(null)
  executor.close()
  useOnlineStore.setState({ online: true })
})

describe("calendar view (task 5.3)", () => {
  it("renders the month grid with seeded events on the right days, all-day events covering their days", async () => {
    await seedMarch()
    render(<CalendarView initialFocusDate={FOCUS} />)

    await waitFor(() => expect(eventChip(designReviewId)).toBeDefined())
    expect(
      screen.getByTestId("calendar-period-label").textContent
    ).toContain("March 2026")
    // The timed event's chip lives in the March 2 cell.
    expect(
      dayCell("2026-03-02").querySelector(
        `[data-event-id="${designReviewId}"]`
      )
    ).not.toBeNull()
    // Events from the second calendar render alongside (combined view).
    expect(
      dayCell("2026-03-06").querySelector(
        `[data-event-id="${otherCalendarId}"]`
      )
    ).not.toBeNull()
  })

  it("navigates by unit (prev/next) and Today is one action back to the current month", async () => {
    await seedMarch()
    render(<CalendarView initialFocusDate={FOCUS} />)
    await waitFor(() => expect(eventChip(designReviewId)).toBeDefined())

    fireEvent.click(screen.getByTestId("calendar-prev"))
    expect(
      screen.getByTestId("calendar-period-label").textContent
    ).toContain("February 2026")

    fireEvent.click(screen.getByTestId("calendar-next"))
    fireEvent.click(screen.getByTestId("calendar-next"))
    expect(
      screen.getByTestId("calendar-period-label").textContent
    ).toContain("April 2026")

    // One action to today.
    fireEvent.click(screen.getByTestId("calendar-today"))
    expect(
      screen.getByTestId("calendar-period-label").textContent
    ).toContain(format(new Date(), "MMMM yyyy"))
  })

  it("week view shows hourly slots, times the events into the right columns and lane-packs overlaps", async () => {
    await seedMarch()
    render(<CalendarView initialFocusDate={FOCUS} />)
    await waitFor(() => expect(eventChip(designReviewId)).toBeDefined())

    fireEvent.click(screen.getByTestId("calendar-unit-week"))
    expect(
      screen.getByTestId("calendar-period-label").textContent
    ).toContain("Mar 15 – Mar 21, 2026")
    // Hourly slots exist (24 lines, labels like "9 AM").
    const hours = screen.getAllByTestId("calendar-hour-line")
    expect(hours).toHaveLength(24)
    expect(
      hours.find((line) => line.dataset.hour === "9")?.textContent
    ).toContain("9 AM")

    // The overlap pair sits in the March 17 column, side by side: the
    // simple lane policy splits the column evenly (50% each).
    const chipA = eventChip(overlapAId)
    const chipB = eventChip(overlapBId)
    expect(chipA.closest('[data-testid="calendar-day-column"]')?.getAttribute(
      "data-date"
    )).toBe("2026-03-17")
    expect(chipB.closest('[data-testid="calendar-day-column"]')?.getAttribute(
      "data-date"
    )).toBe("2026-03-17")
    expect(chipA.style.width).toBe("calc(50% - 4px)")
    expect(chipB.style.width).toBe("calc(50% - 4px)")
  })

  it("renders all-day events in the dedicated row spanning their columns", async () => {
    await seedMarch()
    render(<CalendarView initialFocusDate={FOCUS} />)
    await waitFor(() => expect(eventChip(designReviewId)).toBeDefined())

    fireEvent.click(screen.getByTestId("calendar-unit-week"))
    const row = screen.getByTestId("calendar-all-day-row")
    const chip = eventChip(offsiteId)
    expect(row.contains(chip)).toBe(true)
    // Not in the hourly columns — the dedicated row only.
    expect(
      chip.closest('[data-testid="calendar-day-column"]')
    ).toBeNull()
    // Mar 19–20 (end exclusive): a two-day span starting on the 5th
    // column of 7 → left at 4/7 of the row, width 2/7. (Segments are
    // absolutely positioned in the row, not children of a cell.)
    expect(chip.style.left).toContain("57.14")
    expect(chip.style.width).toContain("28.57")
  })

  it("day view shows the single focused day and navigates day by day", async () => {
    await seedMarch()
    render(<CalendarView initialFocusDate={FOCUS} />)
    await waitFor(() => expect(eventChip(designReviewId)).toBeDefined())

    fireEvent.click(screen.getByTestId("calendar-unit-day"))
    expect(
      screen.getByTestId("calendar-period-label").textContent
    ).toContain("Sunday, March 15, 2026")
    expect(screen.getAllByTestId("calendar-day-column")).toHaveLength(1)

    fireEvent.click(screen.getByTestId("calendar-next"))
    fireEvent.click(screen.getByTestId("calendar-next"))
    expect(
      screen.getByTestId("calendar-period-label").textContent
    ).toContain("Tuesday, March 17, 2026")
    await waitFor(() => expect(eventChip(overlapAId)).toBeDefined())
    // Both overlapping events are in this single column: 50% lanes each.
    expect(eventChip(overlapAId).style.width).toBe("calc(50% - 4px)")
    expect(eventChip(overlapBId).style.width).toBe("calc(50% - 4px)")
  })

  it("clicking an event opens the details card with time, source and calendar, and closes it", async () => {
    await seedMarch()
    render(<CalendarView initialFocusDate={FOCUS} />)
    await waitFor(() => expect(eventChip(designReviewId)).toBeDefined())

    fireEvent.click(eventChip(designReviewId))
    const details = screen.getByTestId("calendar-event-details")
    expect(details.textContent).toContain("Design review")
    expect(details.textContent).toContain("10:00 AM")
    expect(details.textContent).toContain("me@gmail.com")
    expect(details.textContent).toContain("cal-a1")

    fireEvent.click(
      screen.getByRole("button", { name: "Close event details" })
    )
    expect(
      screen.queryByTestId("calendar-event-details")
    ).toBeNull()
  })

  it("offline renders from cache, disables refresh, and never calls the sync; online refresh errors surface as a banner while the cache keeps rendering", async () => {
    await seedMarch()
    render(<CalendarView initialFocusDate={FOCUS} />)
    await waitFor(() => expect(eventChip(designReviewId)).toBeDefined())

    // Offline: cached rows render (they always do), refresh is disabled
    // with the hint, and no fetch is attempted. (act: the store toggle
    // must flush its subscription synchronously.)
    act(() => {
      useOnlineStore.setState({ online: false })
    })
    expect(screen.getByTestId("calendar-offline-hint")).not.toBeNull()
    expect(
      (screen.getByTestId("calendar-refresh") as HTMLButtonElement).disabled
    ).toBe(true)
    fireEvent.click(screen.getByTestId("calendar-refresh"))
    expect(refreshMock).not.toHaveBeenCalled()
    expect(eventChip(designReviewId)).toBeDefined()

    // Back online: a refresh pass whose source errors still renders the
    // cache and reports the failure in a dismissible banner only.
    act(() => {
      useOnlineStore.setState({ online: true })
    })
    refreshMock.mockResolvedValue({
      refreshed: 0,
      errors: [{ sourceId: "src-a", message: "token rejected" }],
    })
    fireEvent.click(screen.getByTestId("calendar-refresh"))
    await waitFor(() =>
      expect(screen.getByTestId("calendar-refresh-error").textContent).toContain(
        "token rejected"
      )
    )
    expect(
      screen.getByTestId("calendar-refresh-error").textContent
    ).toContain("cached events")
    // The cached rendering survived the failed fetch.
    expect(eventChip(designReviewId)).toBeDefined()

    fireEvent.click(
      screen.getByRole("button", { name: "Dismiss refresh error" })
    )
    expect(screen.queryByTestId("calendar-refresh-error")).toBeNull()

    // A clean pass clears the stage without a banner.
    refreshMock.mockResolvedValue({ refreshed: 1, errors: [] })
    fireEvent.click(screen.getByTestId("calendar-refresh"))
    await waitFor(() => expect(refreshMock).toHaveBeenCalledTimes(2))
    expect(screen.queryByTestId("calendar-refresh-error")).toBeNull()
  })

  it("double-clicking an empty slot calls the injected creation hook with a quantized slot (task 5.4 default no-op)", async () => {
    await seedMarch()
    const onCreateEvent = vi.fn()
    render(
      <CalendarView initialFocusDate={FOCUS} onCreateEvent={onCreateEvent} />
    )
    await waitFor(() => expect(eventChip(designReviewId)).toBeDefined())

    fireEvent.click(screen.getByTestId("calendar-unit-week"))
    fireEvent.doubleClick(dayColumn("2026-03-17"))

    expect(onCreateEvent).toHaveBeenCalledTimes(1)
    const [start, end] = onCreateEvent.mock.calls[0] as unknown as [
      Date,
      Date,
    ]
    expect(format(start, "yyyy-MM-dd")).toBe("2026-03-17")
    expect(start.getMinutes() % 30).toBe(0)
    expect(start.getHours()).toBeLessThan(24)
    expect(end.getTime() - start.getTime()).toBe(60 * 60 * 1000)

    // Default prop: rendering without onCreateEvent never throws.
    cleanup()
    render(<CalendarView initialFocusDate={FOCUS} />)
    await waitFor(() => expect(eventChip(designReviewId)).toBeDefined())
    fireEvent.click(screen.getByTestId("calendar-unit-week"))
    fireEvent.doubleClick(dayColumn("2026-03-17"))
  })

  it("shows the empty state when the range has no cached events", async () => {
    await seedSource("src-a", "me@gmail.com")
    render(<CalendarView initialFocusDate={FOCUS} />)
    await waitFor(() =>
      expect(screen.getByTestId("empty-state").textContent).toContain(
        "No events in this range"
      )
    )
  })
})
