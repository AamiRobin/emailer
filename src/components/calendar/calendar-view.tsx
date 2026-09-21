import { useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowLeft,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Pencil,
  RefreshCw,
  Trash2,
  WifiOff,
  X,
} from "lucide-react"
import {
  addMinutes,
  format,
  fromUnixTime,
  isSameMonth,
  isToday,
  startOfDay,
} from "date-fns"

import { cn } from "@/lib/utils"
import { EmptyState } from "@/components/email/empty-state"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import type { CalendarEvent } from "@/services/calendar/events"
import { getCalendarEvent } from "@/services/calendar/events"
import { deleteEvent } from "@/services/calendar/event-writes"
import { useOnlineStore } from "@/stores/online-store"
import { useUiStore } from "@/stores/ui-store"
import { EventDialog } from "./event-dialog"
import type { EventDialogRequest } from "./event-dialog"
import {
  eventColor,
  eventDayKeys,
  gridRangeFor,
  isAllDayRowEvent,
  localDayKey,
  packLanes,
  periodLabel,
  shiftFocus,
  type CalendarViewUnit,
} from "./calendar-model"
import {
  getCalendarViewExecutor,
  refreshCalendarsAndReload,
  useCalendarEvents,
} from "./use-calendar-view"

/**
 * The Calendar view (task 5.3 + 5.4, design D5; calendar spec "Calendar
 * views" and "Event creation and editing"): the month/week/day surface
 * behind the sidebar's Calendar entry — events at their scheduled times on
 * an hourly grid (week/day), a dedicated all-day row, events from every
 * visible calendar combined and color-coded per calendar, today always one
 * action away (Today button), and forward/backward navigation by the
 * view's own unit. Data renders straight from the local calendar_events
 * cache (use-calendar-events), so recently synced ranges render offline;
 * the Refresh button re-runs the provider sync and its failure surfaces as
 * a banner that never blocks the cached rendering.
 *
 * Event writes (task 5.4): double-clicking an empty slot opens the event
 * dialog pre-filled with the slot's times, and the details card gains
 * Edit/Delete for the selected event's stored master row (occurrence ids
 * from the view-time expansion resolve back to the master before the
 * write). Writes run through services/calendar/event-writes.ts — offline
 * or failed writes are refused with a typed reason and surface inline
 * (dialog banner / card alert) without ever mutating the cache. The
 * onCreateEvent prop remains as an override seam (tests/custom hosts);
 * the default opens the dialog.
 * Rendering follows the app's Tailwind token aesthetics; the only literal
 * colors are the per-calendar hsl hues (see calendar-model.ts, the
 * account-badge dot precedent).
 */

export interface CalendarViewProps {
  /**
   * Double-click empty slot seam (month cell / week-day hourly column):
   * receives the clicked [start, end) as Dates. Default: opens the event
   * creation dialog with those times (task 5.4); inject to override.
   */
  onCreateEvent?: (start: Date, end: Date) => void
  /** Test/deep-link seam: the initially focused date. Default: today. */
  initialFocusDate?: Date
}

export function CalendarView({
  onCreateEvent,
  initialFocusDate,
}: CalendarViewProps = {}) {
  const [unit, setUnit] = useState<CalendarViewUnit>("month")
  const [focusDate, setFocusDate] = useState<Date>(() =>
    startOfDay(initialFocusDate ?? new Date())
  )
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)
  const [refreshStage, setRefreshStage] = useState<
    "idle" | "refreshing" | "error"
  >("idle")
  const [refreshMessage, setRefreshMessage] = useState<string | null>(null)
  /** The event dialog's current request (create slot / edit event). */
  const [dialogRequest, setDialogRequest] =
    useState<EventDialogRequest | null>(null)
  /** Delete-from-the-card state (dialog delete surfaces in the dialog). */
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const grid = useMemo(() => gridRangeFor(focusDate, unit), [focusDate, unit])
  const rangeStartSec = Math.floor(grid.start.getTime() / 1000)
  const rangeEndSec = Math.floor(grid.end.getTime() / 1000)
  const { events, calendars, loading, reload } = useCalendarEvents(
    rangeStartSec,
    rangeEndSec
  )
  const online = useOnlineStore((state) => state.online)
  const setView = useUiStore((state) => state.setView)
  const previousView = useUiStore((state) => state.previousView)

  const calendarByKey = useMemo(
    () =>
      new Map(
        calendars.map((calendar) => [
          `${calendar.sourceId}:${calendar.calendarId}`,
          calendar,
        ])
      ),
    [calendars]
  )
  const selectedEvent =
    selectedEventId !== null
      ? (events.find((event) => event.id === selectedEventId) ?? null)
      : null

  const handleRefresh = () => {
    setRefreshStage("refreshing")
    setRefreshMessage(null)
    void refreshCalendarsAndReload(reload)
      .then((result) => {
        if (result.errors.length > 0) {
          setRefreshStage("error")
          setRefreshMessage(
            result.errors.map((error) => error.message).join(" · ")
          )
        } else {
          setRefreshStage("idle")
        }
      })
      .catch((error: unknown) => {
        // refreshCalendarsAndReload rethrows only unexpected failures; the
        // cache rendering never depends on this pass succeeding.
        setRefreshStage("error")
        setRefreshMessage(
          error instanceof Error ? error.message : String(error)
        )
      })
  }

  const openEvent = (eventId: string) => setSelectedEventId(eventId)
  const showMore = (day: Date) => {
    // "+N more" in a month cell zooms into that day (one action to the
    // day view — same spirit as the Today shortcut).
    setFocusDate(startOfDay(day))
    setUnit("day")
  }

  /**
   * Task 5.4 event creation: an empty-slot double-click opens the event
   * dialog with the clicked times pre-filled; the onCreateEvent prop (an
   * override seam) takes precedence when injected.
   */
  const handleSlotDoubleClick = (start: Date, end: Date) => {
    if (onCreateEvent) {
      onCreateEvent(start, end)
      return
    }
    setDeleteError(null)
    setDialogRequest({ mode: "create", start, end })
  }

  /**
   * The stored MASTER row behind the selected event: view-time recurring
   * expansions carry `<masterId>#oc-<n>` occurrence ids with occurrence
   * times — writes address the whole series, so edit/delete resolve the
   * master (its row holds the authoritative times) first.
   */
  const resolveSelectedMaster = async (): Promise<CalendarEvent | null> => {
    if (!selectedEvent) return null
    const marker = selectedEvent.id.indexOf("#oc-")
    if (marker === -1) return selectedEvent
    try {
      const master = await getCalendarEvent(
        getCalendarViewExecutor(),
        selectedEvent.id.slice(0, marker)
      )
      return master ?? selectedEvent
    } catch {
      return selectedEvent
    }
  }

  const handleEditSelected = () => {
    setDeleteError(null)
    void resolveSelectedMaster().then((event) => {
      if (event) setDialogRequest({ mode: "edit", event })
    })
  }

  const handleDeleteSelected = () => {
    setDeleteBusy(true)
    setDeleteError(null)
    void resolveSelectedMaster()
      .then(async (event) => {
        if (!event) return
        // Online-write contract: a refused/failed delete leaves the event
        // in place and reports here; nothing was removed.
        const result = await deleteEvent(getCalendarViewExecutor(), event)
        if (result.ok) {
          setSelectedEventId(null)
          reload()
        } else {
          setDeleteError(result.message ?? "The event could not be deleted.")
        }
      })
      .catch((error: unknown) => {
        setDeleteError(error instanceof Error ? error.message : String(error))
      })
      .finally(() => setDeleteBusy(false))
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="calendar-view">
      <div className="flex items-center gap-1 px-4 py-1.5">
        <Button
          variant="ghost"
          size="sm"
          aria-label="Back to mailbox"
          onClick={() => setView(previousView)}
        >
          <ArrowLeft />
          Back
        </Button>
        <h1 className="truncate text-xl font-bold text-foreground">
          Calendar
        </h1>
        <span
          data-testid="calendar-period-label"
          className="ml-1 truncate text-sm text-muted-foreground"
        >
          {periodLabel(focusDate, unit)}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            data-testid="calendar-today"
            onClick={() => setFocusDate(startOfDay(new Date()))}
          >
            Today
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous"
            data-testid="calendar-prev"
            onClick={() => setFocusDate((date) => shiftFocus(date, unit, -1))}
          >
            <ChevronLeft />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next"
            data-testid="calendar-next"
            onClick={() => setFocusDate((date) => shiftFocus(date, unit, 1))}
          >
            <ChevronRight />
          </Button>
          <div
            role="group"
            aria-label="Calendar view unit"
            data-testid="calendar-unit-toggle"
            className="ml-1 flex items-center rounded-lg border bg-muted/40 p-0.5 text-xs"
          >
            {(["month", "week", "day"] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-label={`${option} view`}
                aria-pressed={unit === option}
                data-testid={`calendar-unit-${option}`}
                className={cn(
                  "rounded-md px-2 py-1 capitalize transition-colors",
                  unit === option
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                )}
                onClick={() => setUnit(option)}
              >
                {option}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            aria-label="Refresh calendars"
            data-testid="calendar-refresh"
            // Offline the sync cannot run: the cache keeps rendering and
            // the hint below explains (spec "Offline browsing").
            disabled={!online || refreshStage === "refreshing"}
            onClick={handleRefresh}
          >
            <RefreshCw
              className={cn(
                "size-4",
                refreshStage === "refreshing" && "animate-spin"
              )}
            />
            Refresh
          </Button>
        </div>
      </div>
      <Separator />
      {!online && (
        <div
          data-testid="calendar-offline-hint"
          className="flex items-center gap-1.5 bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground"
        >
          <WifiOff aria-hidden className="size-3.5" />
          Offline — showing cached events. Reconnect and refresh to update.
        </div>
      )}
      {refreshStage === "error" && (
        <div
          role="alert"
          data-testid="calendar-refresh-error"
          className="flex items-start gap-2 border-b bg-destructive/10 px-4 py-2 text-xs text-destructive"
        >
          <span className="flex-1">
            Refresh failed: {refreshMessage} Showing cached events.
          </span>
          <button
            type="button"
            aria-label="Dismiss refresh error"
            onClick={() => {
              setRefreshStage("idle")
              setRefreshMessage(null)
            }}
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </div>
      )}
      {selectedEvent && (
        <EventDetailsCard
          event={selectedEvent}
          sourceName={
            calendarByKey.get(
              `${selectedEvent.sourceId}:${selectedEvent.calendarId}`
            )?.sourceName
          }
          deleteBusy={deleteBusy}
          deleteError={deleteError}
          onEdit={handleEditSelected}
          onDelete={handleDeleteSelected}
          onClose={() => setSelectedEventId(null)}
        />
      )}
      {events.length === 0 && !loading ? (
        <EmptyState
          icon={CalendarDays}
          title="No events in this range"
          hint="Connect a calendar source in Settings and refresh to sync events; synced ranges stay available offline."
        />
      ) : unit === "month" ? (
        <MonthGrid
          days={grid.days}
          focusDate={focusDate}
          events={events}
          onEventClick={openEvent}
          onCellDoubleClick={handleSlotDoubleClick}
          onShowMore={showMore}
        />
      ) : (
        <TimeGrid
          days={grid.days}
          events={events}
          onEventClick={openEvent}
          onSlotDoubleClick={handleSlotDoubleClick}
        />
      )}
      <EventDialog
        open={dialogRequest !== null}
        onOpenChange={(next) => {
          if (!next) setDialogRequest(null)
        }}
        request={dialogRequest}
        onSaved={reload}
      />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Details card
// ---------------------------------------------------------------------------

/** Human [start, end) line for the details card. */
function formatEventRange(event: CalendarEvent): string {
  if (event.allDay) {
    // All-day ends are EXCLUSIVE (UTC midnights) — display the last covered
    // day, the Google convention.
    const start = fromUnixTime(event.startAt)
    const lastCovered = fromUnixTime(Math.max(event.endAt - 86400, event.startAt))
    return (
      format(start, "EEE, MMM d, yyyy") +
      (event.endAt - event.startAt > 86400
        ? ` – ${format(lastCovered, "EEE, MMM d, yyyy")} (all day)`
        : " (all day)")
    )
  }
  const start = fromUnixTime(event.startAt)
  const end = fromUnixTime(Math.max(event.endAt, event.startAt + 1))
  if (localDayKey(start) === localDayKey(end)) {
    return `${format(start, "EEE, MMM d, yyyy")}, ${format(start, "h:mm a")} – ${format(end, "h:mm a")}`
  }
  return `${format(start, "MMM d, h:mm a")} – ${format(end, "MMM d, h:mm a")}`
}

function EventDetailsCard({
  event,
  sourceName,
  deleteBusy,
  deleteError,
  onEdit,
  onDelete,
  onClose,
}: {
  event: CalendarEvent
  sourceName: string | undefined
  deleteBusy: boolean
  deleteError: string | null
  onEdit: () => void
  onDelete: () => void
  onClose: () => void
}) {
  const color = eventColor(event)
  return (
    <div
      data-testid="calendar-event-details"
      className="flex items-start gap-2 border-b px-4 py-2.5"
    >
      <span
        aria-hidden
        className="mt-1.5 size-2 shrink-0 rounded-full"
        style={{ backgroundColor: color.dot }}
      />
      <div className="grid min-w-0 flex-1 gap-0.5">
        <p className="truncate text-sm font-semibold text-foreground">
          {event.summary ?? "(untitled)"}
          {event.status === "cancelled" && (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              (cancelled)
            </span>
          )}
          {event.status === "tentative" && (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              (tentative)
            </span>
          )}
        </p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {formatEventRange(event)}
        </p>
        {event.location && (
          <p className="truncate text-xs text-foreground">{event.location}</p>
        )}
        {event.description && (
          <p className="line-clamp-3 text-xs text-muted-foreground">
            {event.description}
          </p>
        )}
        <p className="truncate text-xs text-muted-foreground">
          {sourceName ?? event.sourceId} · {event.calendarId}
        </p>
        {deleteError !== null && (
          <p
            role="alert"
            data-testid="calendar-event-delete-error"
            className="text-xs text-destructive"
          >
            {deleteError}
          </p>
        )}
        <div className="mt-1 flex gap-1">
          {/* Task 5.4: every cached event belongs to a connected (writable)
          source — google and caldav both write. Recurring occurrences
          resolve to their master row before the write (see the view). */}
          <Button
            variant="outline"
            size="xs"
            className="gap-1"
            data-testid="calendar-event-edit"
            onClick={onEdit}
          >
            <Pencil className="size-3" />
            Edit
          </Button>
          <Button
            variant="outline"
            size="xs"
            className="gap-1 text-destructive hover:text-destructive"
            data-testid="calendar-event-delete"
            disabled={deleteBusy}
            onClick={onDelete}
          >
            <Trash2 className="size-3" />
            {deleteBusy ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Close event details"
        onClick={onClose}
      >
        <X />
      </Button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Month grid
// ---------------------------------------------------------------------------

function MonthGrid({
  days,
  focusDate,
  events,
  onEventClick,
  onCellDoubleClick,
  onShowMore,
}: {
  days: Date[]
  /** The focused date decides which cells are in-month shading (days[6]
   * can fall outside the focus month when the month starts late in the
   * week, so the focus itself is the anchor). */
  focusDate: Date
  events: CalendarEvent[]
  onEventClick: (eventId: string) => void
  onCellDoubleClick: (start: Date, end: Date) => void
  onShowMore: (day: Date) => void
}) {
  // Events per ISO day key, precomputed once (eventDayKeys enumerates the
  // covered days — UTC for all-day, local for timed).
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const event of events) {
      for (const key of eventDayKeys(event)) {
        const list = map.get(key)
        if (list) list.push(event)
        else map.set(key, [event])
      }
    }
    return map
  }, [events])
  const inMonth = days.map((day) => isSameMonth(day, focusDate))

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="calendar-month">
      <div className="grid grid-cols-7 border-b text-center text-xs text-muted-foreground">
        {days.slice(0, 7).map((day) => (
          <div key={localDayKey(day)} className="px-1 py-1.5">
            {format(day, "EEE")}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-6">
        {days.map((day, index) => {
          const key = localDayKey(day)
          const chips = byDay.get(key) ?? []
          return (
            <div
              key={key}
              data-testid="calendar-day-cell"
              data-date={key}
              className={cn(
                "min-h-0 overflow-hidden border-b border-r p-1 [&:nth-child(7n)]:border-r-0",
                !inMonth[index] && "bg-muted/30"
              )}
              // Task 5.4 wires event creation here: a month-cell
              // double-click proposes the 9–10 AM slot of that day.
              onDoubleClick={() => {
                const start = addMinutes(startOfDay(day), 9 * 60)
                onCellDoubleClick(start, addMinutes(start, 60))
              }}
            >
              <div className="flex justify-end px-0.5">
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    isSameMonth(day, focusDate)
                      ? "font-semibold text-foreground"
                      : "text-muted-foreground/60",
                    isToday(day) &&
                      "rounded-full bg-primary px-1.5 text-primary-foreground"
                  )}
                >
                  {format(day, "d")}
                </span>
              </div>
              <div className="mt-0.5 grid gap-0.5">
                {chips.slice(0, 3).map((event) => (
                  <MonthChip
                    key={event.id}
                    event={event}
                    onClick={() => onEventClick(event.id)}
                  />
                ))}
                {chips.length > 3 && (
                  <button
                    type="button"
                    data-testid="calendar-more"
                    className="px-1 text-start text-[10px] text-muted-foreground hover:text-foreground"
                    onClick={() => onShowMore(day)}
                  >
                    +{chips.length - 3} more
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** A month-cell chip: colored dot + (timed: start time) + summary. */
function MonthChip({
  event,
  onClick,
}: {
  event: CalendarEvent
  onClick: () => void
}) {
  const color = eventColor(event)
  return (
    <button
      type="button"
      data-testid="calendar-event"
      data-event-id={event.id}
      className={cn(
        "flex w-full items-center gap-1 rounded px-1 py-0.5 text-start text-[11px] transition-colors hover:brightness-95",
        event.status === "cancelled" && "line-through opacity-60"
      )}
      style={{
        backgroundColor: color.chipBackground,
        borderLeft: `2px solid ${color.dot}`,
      }}
      onClick={onClick}
    >
      {!event.allDay && (
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {format(fromUnixTime(event.startAt), "h:mm a")}
        </span>
      )}
      <span className="truncate text-foreground">
        {event.summary ?? "(untitled)"}
      </span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Week / day time grid
// ---------------------------------------------------------------------------

const PIXELS_PER_MINUTE = 1
const MINUTES_PER_DAY = 24 * 60
/** The scroll anchor after mount/navigation: 7 AM. */
const SCROLL_ANCHOR_MINUTES = 7 * 60
/** Double-click slots quantize to half hours; the proposed slot is 1h. */
const SLOT_QUANTUM_MINUTES = 30
const SLOT_DURATION_MINUTES = 60

interface TimedSlot {
  event: CalendarEvent
  topPx: number
  heightPx: number
  lane: number
  laneCount: number
}

/** Timed events of one day column, clamped to the day and lane-packed. */
function timedSlotsForDay(
  day: Date,
  events: CalendarEvent[]
): TimedSlot[] {
  const dayStartSec = Math.floor(startOfDay(day).getTime() / 1000)
  const dayEndSec = dayStartSec + 86400
  const inDay = events.filter(
    (event) =>
      !isAllDayRowEvent(event) &&
      event.startAt < dayEndSec &&
      event.endAt > dayStartSec
  )
  return packLanes(
    inDay,
    (event) => Math.max(event.startAt, dayStartSec),
    (event) => Math.min(event.endAt, dayEndSec)
  ).map(({ item, lane, laneCount }) => {
    const startSec = Math.max(item.startAt, dayStartSec)
    const endSec = Math.min(item.endAt, dayEndSec)
    return {
      event: item,
      lane,
      laneCount,
      topPx: ((startSec - dayStartSec) / 60) * PIXELS_PER_MINUTE,
      heightPx: Math.max(
        ((endSec - startSec) / 60) * PIXELS_PER_MINUTE,
        16
      ),
    }
  })
}

interface AllDaySegment {
  event: CalendarEvent
  startIndex: number
  endIndex: number
  lane: number
  laneCount: number
}

/**
 * The dedicated all-day row's segments: all-day + multi-day events clipped
 * to the visible days, lane-stacked (row index = lane). All-day coverage
 * uses the UTC/local day-key bridge documented in calendar-model.ts.
 */
function allDaySegments(
  days: Date[],
  events: CalendarEvent[]
): AllDaySegment[] {
  const dayKeys = days.map(localDayKey)
  const clipped: { event: CalendarEvent; startIndex: number; endIndex: number }[] =
    []
  for (const event of events) {
    if (!isAllDayRowEvent(event)) continue
    const covered = new Set(eventDayKeys(event))
    const indexes = dayKeys
      .map((key, index) => (covered.has(key) ? index : -1))
      .filter((index) => index >= 0)
    if (indexes.length === 0) continue
    clipped.push({
      event,
      startIndex: indexes[0] ?? 0,
      endIndex: indexes[indexes.length - 1] ?? 0,
    })
  }
  return packLanes(
    clipped,
    (segment) => segment.startIndex,
    (segment) => segment.endIndex + 1
  ).map(({ item, lane, laneCount }) => ({ ...item, lane, laneCount }))
}

function TimeGrid({
  days,
  events,
  onEventClick,
  onSlotDoubleClick,
}: {
  days: Date[]
  events: CalendarEvent[]
  onEventClick: (eventId: string) => void
  onSlotDoubleClick: (start: Date, end: Date) => void
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // Keep the working morning in view after mount and after navigation.
  useEffect(() => {
    const element = scrollRef.current
    if (element) {
      element.scrollTop = SCROLL_ANCHOR_MINUTES * PIXELS_PER_MINUTE
    }
  }, [days])

  const segments = useMemo(
    () => allDaySegments(days, events),
    [days, events]
  )
  const allDayLaneCount = segments.reduce(
    (max, segment) => Math.max(max, segment.lane + 1),
    0
  )
  const ALL_DAY_LANE_HEIGHT = 26

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="calendar-time-grid">
      <div className="flex items-stretch border-b text-center text-xs">
        {days.map((day) => (
          <div
            key={localDayKey(day)}
            data-testid="calendar-day-header"
            data-date={localDayKey(day)}
            className={cn(
              "flex-1 px-1 py-1.5",
              isToday(day) && "bg-muted/60"
            )}
          >
            <span className="text-muted-foreground">{format(day, "EEE")}</span>{" "}
            <span
              className={cn(
                "font-semibold tabular-nums",
                isToday(day) &&
                  "rounded-full bg-primary px-1.5 text-primary-foreground"
              )}
            >
              {format(day, "d")}
            </span>
          </div>
        ))}
      </div>
      {/* Dedicated all-day row (spec): segments span their covered columns. */}
      <div
        data-testid="calendar-all-day-row"
        className="relative border-b"
        style={{
          height: Math.max(allDayLaneCount, 1) * ALL_DAY_LANE_HEIGHT + 2,
        }}
      >
        <div
          className="absolute inset-0 grid"
          style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)` }}
        >
          {days.map((day) => (
            <div
              key={localDayKey(day)}
              data-testid="calendar-all-day-cell"
              data-date={localDayKey(day)}
              className="border-l first:border-l-0"
            />
          ))}
        </div>
        <span className="pointer-events-none absolute top-0.5 left-1 z-10 text-[10px] text-muted-foreground">
          All day
        </span>
        {segments.map((segment) => {
          const color = eventColor(segment.event)
          const span = segment.endIndex - segment.startIndex + 1
          return (
            <button
              key={segment.event.id}
              type="button"
              data-testid="calendar-event"
              data-event-id={segment.event.id}
              className={cn(
                "absolute overflow-hidden rounded px-1 text-start text-[11px] font-medium transition-colors hover:brightness-95",
                segment.event.status === "cancelled" && "line-through opacity-60"
              )}
              style={{
                left: `calc(${(segment.startIndex / days.length) * 100}% + 2px)`,
                width: `calc(${(span / days.length) * 100}% - 4px)`,
                top: segment.lane * ALL_DAY_LANE_HEIGHT + 14,
                height: ALL_DAY_LANE_HEIGHT - 2,
                backgroundColor: color.chipBackground,
                borderTop: `2px solid ${color.dot}`,
                zIndex: segment.lane + 2,
              }}
              onClick={() => onEventClick(segment.event.id)}
            >
              <span className="block truncate text-foreground">
                {segment.event.summary ?? "(untitled)"}
              </span>
            </button>
          )
        })}
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        {/* 1px per minute: the full day is 1440px tall. */}
        <div
          className="relative"
          style={{ height: MINUTES_PER_DAY * PIXELS_PER_MINUTE }}
        >
          <div className="absolute inset-0">
            {Array.from({ length: 24 }, (_, hour) => (
              <div
                key={hour}
                data-testid="calendar-hour-line"
                data-hour={hour}
                className="absolute inset-x-0 border-t border-border/50"
                style={{ top: hour * 60 * PIXELS_PER_MINUTE }}
              >
                <span className="absolute top-0.5 left-1 text-[10px] text-muted-foreground tabular-nums">
                  {format(new Date(2000, 0, 1, hour), "h a")}
                </span>
              </div>
            ))}
          </div>
          <div
            className="absolute inset-0 grid"
            style={{ gridTemplateColumns: `repeat(${days.length}, 1fr)` }}
          >
            {days.map((day) => (
              <DayColumn
                key={localDayKey(day)}
                day={day}
                slots={timedSlotsForDay(day, events)}
                onEventClick={onEventClick}
                onSlotDoubleClick={onSlotDoubleClick}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function DayColumn({
  day,
  slots,
  onEventClick,
  onSlotDoubleClick,
}: {
  day: Date
  slots: TimedSlot[]
  onEventClick: (eventId: string) => void
  onSlotDoubleClick: (start: Date, end: Date) => void
}) {
  return (
    <div
      data-testid="calendar-day-column"
      data-date={localDayKey(day)}
      className="relative border-l first:border-l-0"
      onDoubleClick={(event) => {
        // Task 5.4 wires event creation here: the clicked slot quantizes
        // to the half hour and proposes a one-hour event. jsdom (and a
        // zero-height column) report an empty rect — the fraction guard
        // falls back to the day's first slot instead of NaN.
        const rect = event.currentTarget.getBoundingClientRect()
        const fraction =
          rect.height > 0
            ? (event.clientY - rect.top) / rect.height
            : 0
        const safeFraction = Number.isFinite(fraction) ? fraction : 0
        const minutes = Math.max(
          0,
          Math.min(
            MINUTES_PER_DAY - SLOT_QUANTUM_MINUTES,
            Math.round(
              (safeFraction * MINUTES_PER_DAY) / SLOT_QUANTUM_MINUTES
            ) * SLOT_QUANTUM_MINUTES
          )
        )
        const start = addMinutes(startOfDay(day), minutes)
        onSlotDoubleClick(start, addMinutes(start, SLOT_DURATION_MINUTES))
      }}
    >
      {slots.map((slot) => {
        const color = eventColor(slot.event)
        const width = 100 / slot.laneCount
        return (
          <button
            key={slot.event.id}
            type="button"
            data-testid="calendar-event"
            data-event-id={slot.event.id}
            className={cn(
              "absolute overflow-hidden rounded px-1 py-0.5 text-start text-[11px] transition-colors hover:brightness-95",
              slot.event.status === "cancelled" && "line-through opacity-60"
            )}
            style={{
              top: slot.topPx,
              height: slot.heightPx,
              left: `calc(${slot.lane * width}% + 2px)`,
              width: `calc(${width}% - 4px)`,
              backgroundColor: color.chipBackground,
              borderLeft: `2px solid ${color.dot}`,
              zIndex: slot.lane + 2,
            }}
            onClick={() => onEventClick(slot.event.id)}
          >
            <span className="block truncate text-[10px] text-muted-foreground tabular-nums">
              {format(fromUnixTime(slot.event.startAt), "h:mm a")}
            </span>
            <span className="block truncate font-medium text-foreground">
              {slot.event.summary ?? "(untitled)"}
            </span>
          </button>
        )
      })}
    </div>
  )
}
