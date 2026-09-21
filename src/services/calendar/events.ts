import type { FetchImpl } from "../email/token-manager"
import type { SqlExecutor } from "../db/executor"
import { placeholders } from "../db/executor"
import { createCalendarTokens, listCalendars, syncEvents } from "./google-calendar"
import {
  createMicrosoftCalendarTokens,
  listMicrosoftCalendars,
  syncMicrosoftCalendarEvents,
} from "./microsoft-calendar"
import { listCalendarSources } from "./sources"
import type { CalendarProvider, CalendarSource } from "./sources"

/**
 * Calendar event read model + refresh orchestration (task 5.3, design D5).
 *
 * The `calendar_events` rows written by task 5.1's provider sync ARE the
 * cache: the month/week/day views render whatever is stored for their range,
 * so recently synced ranges render offline (spec "Offline browsing" — the
 * refresh error may surface for the fetch only, never block cached
 * rendering). Cached-range policy, v1, honest limitation: there is NO
 * per-range sync bookkeeping (which windows were fully synced), so "recently
 * synced" is approximated as "everything the sync stored" — Google's full
 * sync defaults to a one-year back window (google-calendar.ts), which is
 * exactly the offline browsing range the calendar spec asks for. The
 * idx_calendar_events_start_at index serves the range predicate below.
 *
 * Recurring events are stored as their RRULE-bearing master (task 5.1 keeps
 * the raw recurrence array JSON, singleEvents=false) — occurrence expansion
 * happens HERE, at view time: a minimal RFC 5545 expansion supporting
 * FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL and EXDATE.
 * Rules carrying unsupported parts (BYDAY/BYMONTHDAY/BYSETPOS/RDATE) are
 * NOT expanded — the master renders at its stored position if it overlaps
 * the range (graceful degradation, never wrong dates).
 */

/** calendar_events row as consumed by the views (camelCase). */
export interface CalendarEvent {
  id: string
  sourceId: string
  calendarId: string
  uid: string
  summary: string | null
  location: string | null
  description: string | null
  /** Epoch seconds; all-day events sit at UTC midnight (Google convention). */
  startAt: number
  /** Epoch seconds, EXCLUSIVE end (uniform with Google's all-day `date`). */
  endAt: number
  allDay: boolean
  /** Raw recurrence-rule array JSON ("RRULE:...", "EXDATE:..."), or null. */
  recurrence: string | null
  /** confirmed | tentative | cancelled */
  status: string | null
}

/** One calendar (source × provider calendar) that has cached events. */
export interface VisibleCalendar {
  sourceId: string
  sourceName: string
  provider: CalendarProvider
  calendarId: string
}

/** A per-source refresh failure (message is provider text, never tokens). */
export interface RefreshError {
  sourceId: string
  message: string
}

export interface RefreshCalendarsResult {
  /** Sources that synced without error. */
  refreshed: number
  /** Per-source failures — the UI shows these without blocking the cache. */
  errors: RefreshError[]
}

export interface RefreshCalendarsOptions {
  /** Test seam; production uses the global fetch (tauri-plugin-http). */
  fetchImpl?: FetchImpl
}

// ---------------------------------------------------------------------------
// Range queries
// ---------------------------------------------------------------------------

/**
 * Events overlapping [rangeStart, rangeEnd) (epoch seconds), ordered by
 * start. Overlap predicate: start_at < rangeEnd AND end_at > rangeStart —
 * end_at is EXCLUSIVE for all-day events (Google `date` convention, task
 * 5.1), and treating every event as [start, end) keeps one predicate.
 *
 * Recurring masters: an RRULE master that started before the range has
 * end_at <= rangeStart and would be missed by the overlap predicate, so the
 * query additionally admits any event with a recurrence payload; the
 * expansion step (expandEventsInRange) then keeps only real occurrences
 * inside the range.
 */
export async function listEventsInRange(
  executor: SqlExecutor,
  sourceIds: string[] | undefined,
  rangeStart: number,
  rangeEnd: number
): Promise<CalendarEvent[]> {
  const params: unknown[] = [rangeEnd, rangeStart]
  let sql = `
    SELECT id, source_id, calendar_id, uid, summary, location, description,
           start_at, end_at, all_day, recurrence, status
      FROM calendar_events
     WHERE start_at < $1
       AND (end_at > $2 OR recurrence IS NOT NULL)`
  if (sourceIds && sourceIds.length > 0) {
    sql += ` AND source_id IN (${placeholders(sourceIds.length, 3)})`
    params.push(...sourceIds)
  } else if (sourceIds && sourceIds.length === 0) {
    return []
  }
  sql += ` ORDER BY start_at ASC, id ASC`
  const rows = await executor.select<{
    id: string
    source_id: string
    calendar_id: string
    uid: string
    summary: string | null
    location: string | null
    description: string | null
    start_at: number
    end_at: number
    all_day: number
    recurrence: string | null
    status: string | null
  }>(sql, params)
  return rows.map((row) => ({
    id: row.id,
    sourceId: row.source_id,
    calendarId: row.calendar_id,
    uid: row.uid,
    summary: row.summary,
    location: row.location,
    description: row.description,
    startAt: row.start_at,
    endAt: row.end_at,
    allDay: row.all_day === 1,
    recurrence: row.recurrence,
    status: row.status,
  }))
}

/**
 * The calendars the views combine (spec: "events from all visible calendars
 * combined, color-coded per calendar"). Visibility, v1: the schema has no
 * per-calendar visibility column yet (task 5.1 stores the source row and
 * the chosen calendars' events), so every calendar_id that has cached
 * events is treated as visible and labeled by its calendar id; the source's
 * display name rides along for the details surface. When a visibility
 * column lands, this is the one query that changes.
 */
export async function listVisibleCalendars(
  executor: SqlExecutor
): Promise<VisibleCalendar[]> {
  const rows = await executor.select<{
    source_id: string
    source_name: string
    provider: CalendarProvider
    calendar_id: string
  }>(
    `SELECT DISTINCT ce.source_id, cs.name AS source_name, cs.provider,
            ce.calendar_id
       FROM calendar_events ce
       JOIN calendar_sources cs ON cs.id = ce.source_id
      ORDER BY ce.source_id ASC, ce.calendar_id ASC`
  )
  return rows.map((row) => ({
    sourceId: row.source_id,
    sourceName: row.source_name,
    provider: row.provider,
    calendarId: row.calendar_id,
  }))
}

/**
 * One cached event row by its primary key (task 5.4): the edit/delete
 * path uses it to resolve a recurring EXPANSION occurrence
 * (`<masterId>#oc-<n>`, a view-time construct with no row of its own)
 * back to its stored master before a write. Null when the row is gone
 * (deleted by a concurrent sync — the UI treats that as nothing to edit).
 */
export async function getCalendarEvent(
  executor: SqlExecutor,
  id: string
): Promise<CalendarEvent | null> {
  const rows = await executor.select<{
    id: string
    source_id: string
    calendar_id: string
    uid: string
    summary: string | null
    location: string | null
    description: string | null
    start_at: number
    end_at: number
    all_day: number
    recurrence: string | null
    status: string | null
  }>(
    `SELECT id, source_id, calendar_id, uid, summary, location, description,
            start_at, end_at, all_day, recurrence, status
       FROM calendar_events WHERE id = $1`,
    [id]
  )
  const row = rows[0]
  if (!row) return null
  return {
    id: row.id,
    sourceId: row.source_id,
    calendarId: row.calendar_id,
    uid: row.uid,
    summary: row.summary,
    location: row.location,
    description: row.description,
    startAt: row.start_at,
    endAt: row.end_at,
    allDay: row.all_day === 1,
    recurrence: row.recurrence,
    status: row.status,
  }
}

// ---------------------------------------------------------------------------
// Recurrence expansion (view time — task 5.3)
// ---------------------------------------------------------------------------

const SECONDS_PER_DAY = 86400
/** Safety cap for pathological rules (e.g. COUNT missing + far UNTIL). */
const MAX_OCCURRENCES = 5000

interface ParsedRrule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY"
  interval: number
  count?: number
  /** Inclusive upper bound (epoch seconds). */
  until?: number
}

/** `YYYYMMDD[THHMMSS[Z]]` → epoch seconds (UTC); null when unparseable. */
function parseIcsDateSeconds(value: string): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/.exec(
    value
  )
  if (!match) return null
  const seconds = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] ?? "0"),
    Number(match[5] ?? "0"),
    Number(match[6] ?? "0")
  )
  return Number.isNaN(seconds) ? null : Math.floor(seconds / 1000)
}

/**
 * Parse the RRULE line into the supported subset. Any rule with a part we
 * do not expand (BYDAY, BYMONTHDAY, BYSETPOS, RDATE) returns null so the
 * caller falls back to rendering the master rather than inventing dates.
 */
function parseRrule(rules: string[]): ParsedRrule | null {
  const line = rules.find((rule) => rule.startsWith("RRULE:"))
  if (!line) return null
  const parts: Record<string, string> = {}
  for (const piece of line.slice("RRULE:".length).split(";")) {
    const eq = piece.indexOf("=")
    if (eq > 0) parts[piece.slice(0, eq).toUpperCase()] = piece.slice(eq + 1)
  }
  const freq = parts.FREQ
  if (
    freq !== "DAILY" &&
    freq !== "WEEKLY" &&
    freq !== "MONTHLY" &&
    freq !== "YEARLY"
  ) {
    return null
  }
  if (
    parts.BYDAY !== undefined ||
    parts.BYMONTHDAY !== undefined ||
    parts.BYSETPOS !== undefined ||
    parts.RDATE !== undefined
  ) {
    return null
  }
  const interval = parts.INTERVAL ? Number.parseInt(parts.INTERVAL, 10) : 1
  if (!Number.isFinite(interval) || interval < 1) return null
  let count: number | undefined
  if (parts.COUNT !== undefined) {
    count = Number.parseInt(parts.COUNT, 10)
    if (!Number.isFinite(count) || count < 1) return null
  }
  let until: number | undefined
  if (parts.UNTIL !== undefined) {
    until = parseIcsDateSeconds(parts.UNTIL) ?? undefined
    if (until === undefined) return null
  }
  return { freq, interval, count, until }
}

/** All EXDATE instants across the rule array (epoch seconds, UTC). */
function collectExdates(rules: string[]): Set<number> {
  const excluded = new Set<number>()
  for (const rule of rules) {
    if (!rule.startsWith("EXDATE")) continue
    const colon = rule.indexOf(":")
    if (colon === -1) continue
    for (const value of rule.slice(colon + 1).split(",")) {
      const seconds = parseIcsDateSeconds(value.trim())
      if (seconds !== null) excluded.add(seconds)
    }
  }
  return excluded
}

/**
 * UTC calendar parts of an epoch instant — recurrence steps operate on UTC
 * dates because all-day dtstarts sit at UTC midnight (task 5.1) and timed
 * ones keep their absolute UTC time-of-day.
 */
function utcParts(seconds: number): { year: number; month: number; day: number } {
  const date = new Date(seconds * 1000)
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
  }
}

/**
 * Next occurrence start: step the UTC date by the rule's frequency, then
 * re-attach dtstart's UTC time-of-day. Month/year stepping clamps through
 * Date.UTC's rollover (Jan 31 + 1 month → Feb 28/Mar 1 depending on year —
 * the stock JS behavior, kept rather than inventing a clamping policy).
 */
function nextOccurrenceStart(
  startAt: number,
  rule: ParsedRrule
): number {
  const timeOfDay = ((startAt % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY
  const parts = utcParts(startAt)
  switch (rule.freq) {
    case "DAILY":
      parts.day += rule.interval
      break
    case "WEEKLY":
      parts.day += 7 * rule.interval
      break
    case "MONTHLY":
      parts.month += rule.interval
      break
    case "YEARLY":
      parts.year += rule.interval
      break
  }
  return (
    Date.UTC(parts.year, parts.month, parts.day) / 1000 + timeOfDay
  )
}

/**
 * Expand one recurring event into its occurrences overlapping
 * [rangeStart, rangeEnd). Occurrence 0 is dtstart itself (COUNT counts it);
 * each occurrence carries id `<masterId>#oc-<n>` so React keys and
 * details selection stay stable. EXDATE instants are dropped; UNTIL is
 * inclusive. Non-recurring events pass through unchanged.
 */
export function expandEventsInRange(
  events: CalendarEvent[],
  rangeStart: number,
  rangeEnd: number
): CalendarEvent[] {
  const result: CalendarEvent[] = []
  for (const event of events) {
    const overlaps = event.endAt > rangeStart && event.startAt < rangeEnd
    if (!event.recurrence) {
      if (overlaps) result.push(event)
      continue
    }
    let rules: string[] = []
    try {
      const parsed: unknown = JSON.parse(event.recurrence)
      if (Array.isArray(parsed)) {
        rules = parsed.filter((rule): rule is string => typeof rule === "string")
      }
    } catch {
      // A corrupt recurrence blob degrades to the master event below.
    }
    const rule = parseRrule(rules)
    if (!rule) {
      // Unsupported/corrupt rule: render the master only when it overlaps
      // (never invent dates from a rule we cannot expand).
      if (overlaps) result.push(event)
      continue
    }
    const excluded = collectExdates(rules)
    const duration = Math.max(event.endAt - event.startAt, 0)
    let occurrenceStart = event.startAt
    for (let index = 0; index < MAX_OCCURRENCES; index += 1) {
      if (rule.count !== undefined && index >= rule.count) break
      if (rule.until !== undefined && occurrenceStart > rule.until) break
      if (occurrenceStart >= rangeEnd) break
      const occurrenceEnd = occurrenceStart + duration
      if (
        occurrenceEnd > rangeStart &&
        !excluded.has(occurrenceStart)
      ) {
        result.push({
          ...event,
          id: `${event.id}#oc-${index}`,
          startAt: occurrenceStart,
          endAt: occurrenceEnd,
          recurrence: null,
        })
      }
      occurrenceStart = nextOccurrenceStart(occurrenceStart, rule)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Refresh orchestration
// ---------------------------------------------------------------------------

/**
 * Re-run the provider sync for every connected source (the calendar view's
 * refresh button, task 5.3): Google sources re-discover their calendar list
 * (which also picks up calendars added since connecting) and delta-sync
 * each one through task 5.1's syncEvents (sync-token bookkeeping is that
 * service's job). Microsoft sources do the same through the Graph
 * calendarView delta feed (task 3.6, deltaLink cursors). A source whose
 * discovery fails but that has prior sync state falls back to its known
 * calendar ids. CalDAV support landed concurrently (task 5.2): the
 * connector module is imported dynamically with a non-analyzable specifier
 * and called best-effort via its `syncCaldavSource(executor, source)`
 * export (plus legacy-name fallbacks) — a missing or incompatible
 * connector degrades to a recorded error, never a throw. Errors are
 * collected PER SOURCE: one dead source never blocks the others, and every
 * failure is reported to the UI while the cached rows keep rendering.
 */
export async function refreshCalendars(
  executor: SqlExecutor,
  options: RefreshCalendarsOptions = {}
): Promise<RefreshCalendarsResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const sources = await listCalendarSources(executor)
  let refreshed = 0
  const errors: RefreshError[] = []
  for (const source of sources) {
    try {
      if (source.provider === "google") {
        await refreshGoogleSource(executor, source, fetchImpl)
        refreshed += 1
      } else if (source.provider === "microsoft") {
        await refreshMicrosoftSource(executor, source, fetchImpl)
        refreshed += 1
      } else {
        const outcome = await tryCaldavSync(executor, source)
        if (outcome.ok) {
          refreshed += 1
        } else {
          errors.push({ sourceId: source.id, message: outcome.message })
        }
      }
    } catch (error) {
      errors.push({
        sourceId: source.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { refreshed, errors }
}

/** Sync one Google source: discover calendars, delta-sync each. */
async function refreshGoogleSource(
  executor: SqlExecutor,
  source: CalendarSource,
  fetchImpl: FetchImpl
): Promise<void> {
  const tokens = await createCalendarTokens(source, fetchImpl)
  let calendarIds: string[]
  try {
    calendarIds = (await listCalendars(tokens, fetchImpl)).map(
      (entry) => entry.id
    )
  } catch (error) {
    // Discovery failed (offline blip, API error) — fall back to the
    // calendars this source already synced, whose ids live in the
    // sync-state bookkeeping (task 5.1). No known ids → rethrow so the
    // source counts as failed rather than silently syncing nothing.
    const known = Object.keys(source.syncState)
    if (known.length === 0) throw error
    calendarIds = known
  }
  for (const calendarId of calendarIds) {
    await syncEvents(executor, source, calendarId, tokens, { fetchImpl })
  }
}

/**
 * Sync one Microsoft source (task 3.6): discover the Graph calendar list,
 * delta-sync each through the calendarView feed — the Google source's
 * exact shape (discovery fallback to known sync-state calendars, per-
 * calendar cursors) over a different provider client.
 */
async function refreshMicrosoftSource(
  executor: SqlExecutor,
  source: CalendarSource,
  fetchImpl: FetchImpl
): Promise<void> {
  const tokens = await createMicrosoftCalendarTokens(
    executor,
    source,
    fetchImpl
  )
  let calendarIds: string[]
  try {
    calendarIds = (await listMicrosoftCalendars(tokens, fetchImpl)).map(
      (entry) => entry.id
    )
  } catch (error) {
    const known = Object.keys(source.syncState)
    if (known.length === 0) throw error
    calendarIds = known
  }
  for (const calendarId of calendarIds) {
    await syncMicrosoftCalendarEvents(executor, source, calendarId, tokens, {
      fetchImpl,
    })
  }
}

/** The subset of the task 5.2 connector this module calls, duck-typed:
 * `syncCaldavSource` is 5.2's real export (executor + source; it unseals
 * the envelope itself and rides the Tauri HTTP commands, so no fetchImpl
 * is passed). */
interface CaldavConnector {
  syncCaldavSource?: (...args: unknown[]) => Promise<unknown>
  syncCaldavEvents?: (...args: unknown[]) => Promise<unknown>
  syncEvents?: (...args: unknown[]) => Promise<unknown>
}

/**
 * Best-effort CalDAV sync (task 5.2 lands concurrently). The specifier is
 * a runtime variable annotated @vite-ignore so the bundler does not fail
 * the build while the connector is mid-landing; a missing/incompatible
 * connector resolves to a recorded error. The call shape matches 5.2's
 * `syncCaldavSource(executor, source)`; per-calendar failures inside that
 * sync are recorded there and returned, so a throw here is a whole-source
 * failure (bad envelope, missing connection details).
 */
async function tryCaldavSync(
  executor: SqlExecutor,
  source: CalendarSource
): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const specifier = "./caldav"
    const mod = (await import(/* @vite-ignore */ specifier)) as CaldavConnector
    const sync =
      mod.syncCaldavSource ?? mod.syncCaldavEvents ?? mod.syncEvents
    if (typeof sync !== "function") {
      return {
        ok: false,
        message: "The CalDAV connector does not expose a sync entry point yet",
      }
    }
    await sync(executor, source)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}
