import { useCallback, useEffect, useState } from "react"

import type { SqlExecutor } from "@/services/db/executor"
import { getExecutor } from "@/services/db/executor"
import {
  expandEventsInRange,
  listEventsInRange,
  listVisibleCalendars,
  refreshCalendars,
} from "@/services/calendar/events"
import type {
  CalendarEvent,
  RefreshCalendarsResult,
  VisibleCalendar,
} from "@/services/calendar/events"

/**
 * Calendar view data hook (task 5.3, design D5): the cached calendar_events
 * rows for the visible grid range plus the visible-calendar list for the
 * color mapping. The rows ARE the offline cache — this hook ONLY reads
 * SQLite and never touches the network; the refresh button's provider sync
 * is a separate call (refreshCalendars, below) so an offline open renders
 * cache-only by construction (spec "Offline browsing").
 *
 * Reload triggers: the range changing (navigation/view switch is a local
 * re-read, never a network wait) and the manual reload() after a refresh
 * pass. Failures log and render the empty state — no DB outside Tauri
 * (plain vite) behaves like the thread-list store's.
 *
 * Executor seam: queries run through an injectable SqlExecutor that
 * defaults to getExecutor(); tests pass a node:sqlite executor via
 * setCalendarViewExecutor() (the account-store/thread-list override
 * pattern).
 */

let executorOverride: SqlExecutor | null = null

function resolveExecutor(): SqlExecutor {
  return executorOverride ?? getExecutor()
}

/** Test hook: run the calendar queries against `executor`; null restores
 * the production getExecutor() binding. */
export function setCalendarViewExecutor(executor: SqlExecutor | null): void {
  executorOverride = executor
}

/** The executor for the refresh pass (same seam, separate export so the
 * component's refresh handler hits the test database too). */
export function getCalendarViewExecutor(): SqlExecutor {
  return resolveExecutor()
}

export interface UseCalendarEventsResult {
  events: CalendarEvent[]
  calendars: VisibleCalendar[]
  loading: boolean
  /** Re-run the cache query (after a refresh pass changed the rows). */
  reload: () => void
}

export function useCalendarEvents(
  rangeStartSec: number,
  rangeEndSec: number
): UseCalendarEventsResult {
  const [events, setEvents] = useState<CalendarEvent[]>([])
  const [calendars, setCalendars] = useState<VisibleCalendar[]>([])
  const [loading, setLoading] = useState(true)
  const [revision, setRevision] = useState(0)
  const reload = useCallback(
    () => setRevision((current) => current + 1),
    []
  )

  useEffect(() => {
    let cancelled = false
    // The promise hop keeps the load — and its state updates, including
    // the no-DB fallback (resolveExecutor() throws outside Tauri before
    // the first await) — out of the effect body (the react-hooks/
    // set-state-in-effect rule; the use-contacts precedent). loading is
    // only ever cleared asynchronously; it starts true so the empty state
    // never flashes before the first cache query lands.
    void Promise.resolve().then(async () => {
      try {
        const executor = resolveExecutor()
        const rows = await listEventsInRange(
          executor,
          undefined,
          rangeStartSec,
          rangeEndSec
        )
        const visible = await listVisibleCalendars(executor)
        if (cancelled) return
        setEvents(expandEventsInRange(rows, rangeStartSec, rangeEndSec))
        setCalendars(visible)
        setLoading(false)
      } catch (error) {
        // No DB outside Tauri — show the empty calendar, not a crash.
        console.warn("[calendar-view] cache load failed", error)
        if (!cancelled) {
          setEvents([])
          setCalendars([])
          setLoading(false)
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [rangeStartSec, rangeEndSec, revision])

  return { events, calendars, loading, reload }
}

/**
 * The refresh button's pass (online only — the component guards): re-runs
 * the provider sync for every source via refreshCalendars and ALWAYS
 * reloads the cache query afterwards, so a failed pass still picks up
 * whatever partial rows landed. Per-source errors travel in the result;
 * the caller renders them as a banner without ever blocking the cached
 * rendering.
 */
export async function refreshCalendarsAndReload(
  reload: () => void
): Promise<RefreshCalendarsResult> {
  try {
    const result = await refreshCalendars(resolveExecutor())
    return result
  } finally {
    reload()
  }
}
