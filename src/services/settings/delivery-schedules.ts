import type { SqlExecutor } from "@/services/db/executor"
import { getSetting, setSetting } from "@/services/db/settings"

/**
 * Delivery schedules (task 12.1, design D6): user-defined rules that HOLD
 * matching incoming mail until a recurring delivery window (the spec's
 * "newsletters, Saturdays 8 AM"), instead of letting it hit the inbox.
 *
 * Storage model — there is NO delivery-schedules table. Like the splits
 * (settings/splits.ts) and the per-scope thread sorts
 * (settings/preferences.ts), schedules persist as ONE JSON row in the
 * settings table, here PER ACCOUNT under `mail.deliverySchedules:<accountId>`
 * (the per-account namespacing of `mail.sendDelaySeconds:<accountId>`).
 * The row holds an array of DeliverySchedule; `position` is the evaluation
 * order (kept dense 0…n-1 on every write). One row per account because
 * matching values (label names especially) are account-local and the
 * ingestion hook resolves the account's schedules per sync pass.
 *
 * Every mutation reads the whole array and writes it back ("one row, the
 * service owns merging" — the setThreadSorts pattern), so no read-modify-
 * write races exist within a user action. Structural guards on read mean a
 * hand-edited or older-build row degrades to "the invalid entries are
 * dropped", never a crash; validation on WRITE throws (a UI that produced
 * an out-of-range window is a programming error, and silently "fixing" a
 * user's schedule would misfile mail against their intent).
 *
 * Hold semantics at ingestion (consumed by rules/ingestion.ts, applied by
 * the sync engines): a message matching a schedule's match earns
 * threads.held_until = nextWindowOccurrence(...) — the FIRST matching
 * schedule in position order wins. Holds are timestamps, not mail movement
 * (D6): the thread stays in its labels/All Mail/search the whole time and
 * the STRICT `held_until IS NULL` inbox exclusion (threads.ts) hides it
 * from the inbox/badges/unread counts; the due pass (email-actions/
 * holds.ts) releases due holds in one UPDATE that stamps delivered_at so
 * the whole batch re-enters at the TOP of the inbox. A thread that is
 * already held keeps its first hold — a new match does NOT move the hold
 * (see applyDeliveryHolds in rules/ingestion.ts).
 *
 * `window` is LOCAL wall-clock time (the same convention as the snooze
 * presets: a user picks "Saturdays 8 AM" in their own clock), and the next
 * occurrence is strictly after the message's arrival — a message landing
 * exactly at the window instant waits for the NEXT one, which keeps the
 * computation a pure function and the "batch opens at the window" story
 * exact (the release pass runs after the window has actually begun).
 */

/** Settings key holding one account's schedule array (JSON). */
export function deliverySchedulesSettingKey(accountId: string): string {
  return `mail.deliverySchedules:${accountId}`
}

/** What a schedule matches on — the notification_rules vocabulary. */
export type DeliveryScheduleMatchKind = "sender" | "label"

export interface DeliveryScheduleMatch {
  kind: DeliveryScheduleMatchKind
  /** sender: the whole From address (case-insensitive); label: a label
   * name or its trailing "/segment" leaf (case-insensitive — the same
   * convention the search `label:` operator and notification rules use). */
  value: string
}

/** The recurring window. Only `weekly` exists (the spec's delivery-window
 * picker); the discriminant keeps later cadences additive. */
export interface DeliveryScheduleWindow {
  kind: "weekly"
  /** 0–6, 0 = Sunday (the JS Date.getDay() convention the UI picker and
   * nextWindowOccurrence share). */
  dayOfWeek: number
  /** Window open time, LOCAL clock: 0–23 / 0–59. */
  hour: number
  minute: number
}

/** One stored delivery schedule. */
export interface DeliverySchedule {
  id: string
  /** Optional display name (the UI's list entry; matching never sees it). */
  name?: string
  match: DeliveryScheduleMatch
  window: DeliveryScheduleWindow
  /** Dense 0…n-1 tab/list order (the splits convention). */
  position: number
}

// ---------------------------------------------------------------------------
// Validation (write-time throw / read-time drop)
// ---------------------------------------------------------------------------

function isWeekdayIn(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 6
  )
}

function isHourIn(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 23
  )
}

function isMinuteIn(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 59
  )
}

/** Structural guard for a stored entry — invalid entries are dropped on
 * read so one bad record cannot take down listDeliverySchedules or a sync
 * pass that consults the schedules. */
function isDeliverySchedule(value: unknown): value is DeliverySchedule {
  if (typeof value !== "object" || value === null) return false
  const entry = value as Record<string, unknown>
  if (typeof entry.id !== "string") return false
  if (entry.name !== undefined && typeof entry.name !== "string") return false
  if (typeof entry.position !== "number" || !Number.isFinite(entry.position)) {
    return false
  }
  const match = entry.match as Record<string, unknown> | undefined
  if (
    typeof match !== "object" ||
    match === null ||
    (match.kind !== "sender" && match.kind !== "label") ||
    typeof match.value !== "string" ||
    match.value.length === 0
  ) {
    return false
  }
  const window = entry.window as Record<string, unknown> | undefined
  return (
    typeof window === "object" &&
    window !== null &&
    window.kind === "weekly" &&
    isWeekdayIn(window.dayOfWeek) &&
    isHourIn(window.hour) &&
    isMinuteIn(window.minute)
  )
}

/** Write-time validation with an actionable message (see the module doc:
 * invalid CREATE/UPDATE input throws instead of being coerced). */
function assertValidScheduleInput(
  input: { match: DeliveryScheduleMatch; window: DeliveryScheduleWindow },
  label: string
): void {
  const match = input.match
  if (
    (match.kind !== "sender" && match.kind !== "label") ||
    typeof match.value !== "string" ||
    match.value.trim().length === 0
  ) {
    throw new Error(`${label}: match must be sender|label with a value`)
  }
  const window = input.window
  if (window.kind !== "weekly") {
    throw new Error(`${label}: only the "weekly" window kind exists`)
  }
  if (!isWeekdayIn(window.dayOfWeek)) {
    throw new Error(`${label}: dayOfWeek must be an integer 0–6 (0 = Sunday)`)
  }
  if (!isHourIn(window.hour) || !isMinuteIn(window.minute)) {
    throw new Error(`${label}: hour must be 0–23 and minute 0–59`)
  }
}

// ---------------------------------------------------------------------------
// CRUD over the per-account settings row (the splits pattern)
// ---------------------------------------------------------------------------

/** The account's schedules in evaluation order. Corrupt stored shapes are
 * dropped, never thrown; a missing or unparseable row means "none yet". */
export async function listDeliverySchedules(
  executor: SqlExecutor,
  accountId: string
): Promise<DeliverySchedule[]> {
  const stored = await getSetting<unknown>(
    executor,
    deliverySchedulesSettingKey(accountId),
    []
  )
  if (!Array.isArray(stored)) return []
  return stored
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => isDeliverySchedule(entry))
    .sort((a, b) => a.entry.position - b.entry.position || a.index - b.index)
    .map(({ entry }) => entry)
}

/** Persist the whole array with dense positions (internal). */
async function persistSchedules(
  executor: SqlExecutor,
  accountId: string,
  schedules: DeliverySchedule[]
): Promise<void> {
  await setSetting(
    executor,
    deliverySchedulesSettingKey(accountId),
    schedules.map((schedule, position) => ({ ...schedule, position }))
  )
}

/** Append a schedule at the end of the evaluation order; returns the
 * stored schedule (fresh UUID id, dense position). */
export async function createDeliverySchedule(
  executor: SqlExecutor,
  accountId: string,
  input: {
    match: DeliveryScheduleMatch
    window: DeliveryScheduleWindow
    name?: string
  }
): Promise<DeliverySchedule> {
  assertValidScheduleInput(input, "createDeliverySchedule")
  const schedules = await listDeliverySchedules(executor, accountId)
  const schedule: DeliverySchedule = {
    id: crypto.randomUUID(),
    ...(input.name !== undefined ? { name: input.name } : {}),
    match: { ...input.match },
    window: { ...input.window },
    position: schedules.length,
  }
  await persistSchedules(executor, accountId, [...schedules, schedule])
  return schedule
}

/** Update a schedule's name/match/window in place (position untouched).
 * Throws "not found" for an unknown id — the UI can only offer existing
 * rows, so that is a programming/stale-UI error, not a user state. */
export async function updateDeliverySchedule(
  executor: SqlExecutor,
  accountId: string,
  scheduleId: string,
  patch: {
    name?: string
    match?: DeliveryScheduleMatch
    window?: DeliveryScheduleWindow
  }
): Promise<void> {
  const schedules = await listDeliverySchedules(executor, accountId)
  const target = schedules.find((schedule) => schedule.id === scheduleId)
  if (!target) {
    throw new Error(`updateDeliverySchedule: schedule ${scheduleId} not found`)
  }
  const next: DeliverySchedule = {
    ...target,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.match ? { match: { ...patch.match } } : {}),
    ...(patch.window ? { window: { ...patch.window } } : {}),
  }
  assertValidScheduleInput(next, "updateDeliverySchedule")
  await persistSchedules(
    executor,
    accountId,
    schedules.map((schedule) => (schedule.id === scheduleId ? next : schedule))
  )
}

/** Delete a schedule (no-op when the id is unknown). Mail is untouched —
 * a deleted schedule only stops holding NEW arrivals; threads already held
 * keep their hold until its window passes (the due pass releases them). */
export async function deleteDeliverySchedule(
  executor: SqlExecutor,
  accountId: string,
  scheduleId: string
): Promise<void> {
  const schedules = await listDeliverySchedules(executor, accountId)
  await persistSchedules(
    executor,
    accountId,
    schedules.filter((schedule) => schedule.id !== scheduleId)
  )
}

/** Reorder the whole list to `orderedIds` (the UI's up/down or drag state).
 * Unknown ids are ignored; known ids missing from the list keep their
 * relative order after the listed ones; positions re-densify. */
export async function reorderDeliverySchedules(
  executor: SqlExecutor,
  accountId: string,
  orderedIds: string[]
): Promise<void> {
  const schedules = await listDeliverySchedules(executor, accountId)
  const byId = new Map(schedules.map((schedule) => [schedule.id, schedule]))
  const ordered: DeliverySchedule[] = []
  for (const id of orderedIds) {
    const schedule = byId.get(id)
    if (schedule) {
      ordered.push(schedule)
      byId.delete(id)
    }
  }
  await persistSchedules(executor, accountId, [...ordered, ...byId.values()])
}

// ---------------------------------------------------------------------------
// Window math (pure, testable)
// ---------------------------------------------------------------------------

/**
 * One candidate occurrence: `dayDelta` days from `from`'s local DATE, at
 * the window's LOCAL wall time. The calendar arithmetic (setDate +
 * setHours — never a millisecond add) keeps the result at the user's
 * picked local time when the span crosses a DST shift.
 */
function weeklyCandidate(
  from: Date,
  dayDelta: number,
  window: DeliveryScheduleWindow
): Date {
  const candidate = new Date(from)
  candidate.setDate(candidate.getDate() + dayDelta)
  candidate.setHours(window.hour, window.minute, 0, 0)
  return candidate
}

/**
 * The next occurrence of the schedule's weekly window STRICTLY after
 * `now`. Pure: no clock reads, callers and tests pass their own base time;
 * all components are LOCAL to `now` (module doc). A moment exactly at the
 * window edge waits for next week — the release pass must observe the
 * window actually open, and "strictly after arrival" keeps the helper
 * total for the arrival-instant edge case.
 */
export function nextWindowOccurrence(
  schedule: DeliverySchedule,
  now: Date
): Date {
  // Days from `now`'s weekday forward to the window's weekday (0 = today).
  const dayDelta = (schedule.window.dayOfWeek - now.getDay() + 7) % 7
  const candidate = weeklyCandidate(now, dayDelta, schedule.window)
  if (candidate.getTime() > now.getTime()) return candidate
  // Rollover: rebuild the +7d candidate through the SAME wall-clock path
  // as the primary branch — adding a week in milliseconds would land an
  // hour off the picked local time whenever the week crosses a DST shift.
  return weeklyCandidate(now, dayDelta + 7, schedule.window)
}

// ---------------------------------------------------------------------------
// Ingestion resolution (the rules/ingestion.ts consumer)
// ---------------------------------------------------------------------------

/** The message facts a schedule can match: the From address for "sender"
 * rules, the provider-resolved label NAMES for "label" rules (the same
 * inputs IngestionEvent carries). */
export interface DeliveryHoldMatchInput {
  senderAddress: string | null
  labelNames: readonly string[]
}

/** Sender match — the whole address, case-insensitive (the notification
 * rules convention, db/notification-rules.ts). */
function matchesSender(value: string, senderAddress: string): boolean {
  return value.toLowerCase() === senderAddress.toLowerCase()
}

/** Label match — exact or trailing "/segment" leaf, case-insensitive (the
 * search label: operator convention). */
function matchesLabel(value: string, labelName: string): boolean {
  const needle = value.toLowerCase()
  const name = labelName.toLowerCase()
  return name === needle || name.endsWith(`/${needle}`)
}

/** Pure core of resolveDeliveryHold: the FIRST matching schedule in
 * position order wins, and its next window opening (unix seconds, strictly
 * after `now`) is the hold timestamp. No match → null. Split from the
 * executor wrapper so the sync engines can preload the account's schedules
 * once per pass (the options.rules pattern) and consult them per message
 * without re-reading the settings row. */
export function resolveHoldFromSchedules(
  schedules: readonly DeliverySchedule[],
  match: DeliveryHoldMatchInput,
  now: number
): number | null {
  for (const schedule of schedules) {
    const hit =
      schedule.match.kind === "sender"
        ? match.senderAddress != null &&
          matchesSender(schedule.match.value, match.senderAddress)
        : match.labelNames.some((name) =>
            matchesLabel(schedule.match.value, name)
          )
    if (!hit) continue
    return Math.floor(
      nextWindowOccurrence(schedule, new Date(now * 1000)).getTime() / 1000
    )
  }
  return null
}

/**
 * The delivery hold for one newly inserted message: consults the account's
 * schedules and returns the next window opening (unix seconds) or null
 * when nothing matches. `options` lets a per-pass caller preload the
 * schedules (the sync engines) and pin `now` (tests); by default both come
 * from the database / the current clock.
 */
export async function resolveDeliveryHold(
  executor: SqlExecutor,
  accountId: string,
  match: DeliveryHoldMatchInput,
  options?: { schedules?: DeliverySchedule[]; now?: number }
): Promise<number | null> {
  const schedules =
    options?.schedules ?? (await listDeliverySchedules(executor, accountId))
  const now = options?.now ?? Math.floor(Date.now() / 1000)
  return resolveHoldFromSchedules(schedules, match, now)
}
