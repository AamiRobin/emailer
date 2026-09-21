import { format } from "date-fns"

/**
 * Hand-rolled iCalendar (RFC 5545) parser for .ics attachments and
 * text/calendar parts (task 5.5, design D5).
 *
 * Design D5 puts .ics parsing in TypeScript — the bytes are already
 * client-side — as PURE parsing with NO new dependency: this module is a
 * deliberate `ical.js`-equivalent SUBSET, hand-rolled to match the
 * project's audited-dependencies posture (same reasoning as D5's CalDAV
 * choice: "minimal hand-rolled keeps deps auditable"). It parses exactly
 * what the "iCalendar attachments" requirement needs and skips every
 * other component/property gracefully (VALARM, VTIMEZONE, VALARM inside
 * VEVENT, unknown X- properties, ...).
 *
 * Supported subset:
 * - Line unfolding (RFC 5545 §3.1): CRLF/LF/CR line breaks, continuation
 *   lines beginning with a space or tab.
 * - Property lines with parameters (`DTSTART;TZID=X:...`), quote-aware
 *   colon splitting, and TEXT unescaping (§3.3.11: `\n` `\N` `\,` `\;`
 *   `\\`).
 * - VCALENDAR level: VERSION, PRODID, METHOD ("REQUEST" marks an
 *   invitation).
 * - VEVENT: UID, SUMMARY, LOCATION, DESCRIPTION, STATUS, TRANSP,
 *   DTSTART/DTEND (DATE, DATE-TIME local/floating, DATE-TIME UTC "Z"),
 *   DURATION fallback, ORGANIZER/ATTENDEE (mailto: URIs, CN/PARTSTAT
 *   params), any number of events per file.
 *
 * Documented limitations (accepted for v1, task 5.5):
 * - No full time-zone resolution: a DTSTART/DTEND carrying `TZID=...` is
 *   parsed as the wall-clock time in the RUNTIME's local zone and the raw
 *   TZID is kept on {@link IcsDateTime.tzid} for display. Only the UTC
 *   "Z" form resolves to a exact instant. Recurring events (RRULE) are
 *   out of scope: the base instance's times are shown.
 * - malformed input NEVER throws: {@link parseIcsCalendar} returns a
 *   typed {@link IcsParseResult} failure, and per-event problems
 *   (unparsable DTSTART, missing UID) degrade to warnings on the success
 *   result.
 */

/** An ORGANIZER/ATTENDEE parsed from a mailto: (or bare address) value. */
export interface IcsPerson {
  /** CN parameter, unescaped; null when the property carried none. */
  name: string | null
  /** The mailto: address (or bare address value); null when unparseable. */
  email: string | null
  /** ATTENDEE;PARTSTAT=... (NEEDS-ACTION/ACCEPTED/DECLINED/TENTATIVE/DELEGATED); */
  partstat: string | null
}

/** One DTSTART/DTEND value: raw form kept alongside the best-effort Date. */
export interface IcsDateTime {
  /** The value exactly as written, e.g. "20260918T140000Z", "20260918". */
  raw: string
  /** "date" (all-day VALUE=DATE) or "date-time". */
  kind: "date" | "date-time"
  /** All-day event (DATE form) — display shows the date without a time. */
  allDay: boolean
  /** True when the DATE-TIME carried the UTC designator "Z" (exact instant). */
  utc: boolean
  /**
   * TZID parameter value when present (e.g. "America/New_York"). KNOWN
   * LIMITATION: `date` interprets TZID/floating values as the runtime's
   * LOCAL wall clock — no zone database is consulted.
   */
  tzid: string | null
  /** Best-effort JS Date (null when the value could not be parsed). */
  date: Date | null
}

/** One parsed VEVENT (skipped components like VALARM never surface). */
export interface IcsEvent {
  uid: string | null
  summary: string | null
  location: string | null
  description: string | null
  /** STATUS property value, uppercased (CONFIRMED/TENTATIVE/CANCELLED). */
  status: string | null
  /** TRANSP property value, uppercased (OPAQUE/TRANSPARENT). */
  transp: string | null
  organizer: IcsPerson | null
  attendees: IcsPerson[]
  start: IcsDateTime | null
  end: IcsDateTime | null
  /** Raw DURATION value when the event uses the duration fallback. */
  duration: string | null
}

/** The parsed VCALENDAR: calendar-level metadata plus every VEVENT. */
export interface IcsCalendar {
  version: string | null
  prodid: string | null
  /** VCALENDAR-level METHOD, uppercased ("REQUEST" = invitation). */
  method: string | null
  events: IcsEvent[]
}

/** Why parsing failed. Typed — the parser never throws (task 5.5). */
export type IcsParseFailureReason = "empty" | "not-icalendar"

export type IcsParseResult =
  | { ok: true; calendar: IcsCalendar; warnings: string[] }
  | { ok: false; reason: IcsParseFailureReason; message: string }

/** One parsed content line: uppercased name, uppercased param keys. */
export interface IcsProperty {
  name: string
  params: Record<string, string>
  /** Raw value (TEXT unescaping is applied only where the type is TEXT). */
  value: string
}

/**
 * Unfold content lines (RFC 5545 §3.1): a line starting with a space or
 * tab continues the previous line; the single leading whitespace
 * character is removed. Tolerates LF and lone-CR line breaks in addition
 * to the RFC's CRLF, and strips a UTF-8 BOM.
 */
export function unfoldIcsLines(text: string): string[] {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rawLines = withoutBom.split(/\r\n|\n|\r/)
  const unfolded: string[] = []
  for (const rawLine of rawLines) {
    if (
      unfolded.length > 0 &&
      rawLine.length > 0 &&
      (rawLine.startsWith(" ") || rawLine.startsWith("\t"))
    ) {
      unfolded[unfolded.length - 1] += rawLine.slice(1)
      continue
    }
    unfolded.push(rawLine)
  }
  return unfolded
}

/**
 * Parse one content line into name + params + value. The name/value
 * split happens at the first colon OUTSIDE double quotes (URL and
 * DESCRIPTION values legitimately contain colons). Returns null for
 * lines without a colon (malformed) — callers skip them.
 */
export function parseIcsProperty(line: string): IcsProperty | null {
  let inQuotes = false
  let colonIndex = -1
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (char === '"') {
      inQuotes = !inQuotes
    } else if (char === ":" && !inQuotes) {
      colonIndex = index
      break
    }
  }
  if (colonIndex < 0) return null

  const nameAndParams = line.slice(0, colonIndex)
  const value = line.slice(colonIndex + 1)

  const segments = splitUnquoted(nameAndParams, ";")
  const name = (segments[0] ?? "").trim().toUpperCase()
  if (!name) return null

  const params: Record<string, string> = {}
  for (const segment of segments.slice(1)) {
    const eq = segment.indexOf("=")
    if (eq <= 0) continue
    const key = segment.slice(0, eq).trim().toUpperCase()
    const rawValue = segment.slice(eq + 1).trim()
    const unquoted =
      rawValue.length >= 2 && rawValue.startsWith('"') && rawValue.endsWith('"')
        ? rawValue.slice(1, -1)
        : rawValue
    if (!(key in params)) params[key] = unescapeIcsText(unquoted)
  }

  return { name, params, value }
}

/** Split on `separator`, ignoring separators inside double quotes. */
function splitUnquoted(text: string, separator: string): string[] {
  const parts: string[] = []
  let current = ""
  let inQuotes = false
  for (const char of text) {
    if (char === '"') {
      inQuotes = !inQuotes
      current += char
    } else if (char === separator && !inQuotes) {
      parts.push(current)
      current = ""
    } else {
      current += char
    }
  }
  parts.push(current)
  return parts
}

/**
 * Unescape iCalendar TEXT (RFC 5545 §3.3.11): `\\n`/`\\N` → newline,
 * `\\,` → comma, `\\;` → semicolon, `\\\\` → backslash. Unknown escapes
 * are tolerated by keeping the escaped character (dropping the
 * backslash); a trailing lone backslash survives as-is.
 */
export function unescapeIcsText(value: string): string {
  return value.replace(/\\(.?)/g, (whole, char: string) => {
    if (char === "") return whole // trailing lone backslash: keep as-is
    switch (char) {
      case "n":
      case "N":
        return "\n"
      case ",":
        return ","
      case ";":
        return ";"
      case "\\":
        return "\\"
      default:
        return char
    }
  })
}

/**
 * Parse a DTSTART/DTEND value. DATE (`YYYYMMDD`) → all-day at UTC
 * midnight; DATE-TIME `YYYYMMDDTHHMMSSZ` → exact UTC instant; the
 * floating form (no Z) — with or without TZID — becomes LOCAL wall-clock
 * time (the documented v1 limitation above). Invalid calendar values
 * (month 13, Feb 30, hour 27, ...) yield null rather than silently
 * rolling over.
 */
export function parseIcsDateValue(
  value: string,
  params: Record<string, string> = {}
): IcsDateTime | null {
  const raw = value.trim()
  const tzid = params.TZID ?? null

  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(raw)
  if (dateOnly) {
    const [, year, month, day] = dateOnly
    const date = utcDate(
      Number(year),
      Number(month),
      Number(day),
      0,
      0,
      0
    )
    if (!date) return null // impossible calendar values never roll over
    return {
      raw,
      kind: "date",
      allDay: true,
      utc: false,
      tzid: null,
      date,
    }
  }

  const dateTime = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(raw)
  if (dateTime) {
    const [, year, month, day, hour, minute, second, zulu] = dateTime
    const utc = zulu === "Z"
    const date = utc
      ? utcDate(
          Number(year),
          Number(month),
          Number(day),
          Number(hour),
          Number(minute),
          Number(second)
        )
      : localDate(
          Number(year),
          Number(month),
          Number(day),
          Number(hour),
          Number(minute),
          Number(second)
        )
    if (!date) return null
    return {
      raw,
      kind: "date-time",
      allDay: false,
      utc,
      tzid: utc ? null : tzid,
      date,
    }
  }

  return null
}

/** Build a UTC Date with strict round-trip validation (no rollover). */
function utcDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): Date | null {
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, 0)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null
  }
  return date
}

/** Build a LOCAL wall-clock Date with strict round-trip validation. */
function localDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number
): Date | null {
  const date = new Date(year, month - 1, day, hour, minute, second, 0)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute ||
    date.getSeconds() !== second
  ) {
    return null
  }
  return date
}

const DURATION_PATTERN =
  /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/

/**
 * Parse an RFC 5545 DURATION value (`PT1H30M`, `P2DT3H`, `P1W`, ...) into
 * milliseconds; null when the value does not match the grammar or carries
 * no components at all.
 */
export function parseIcsDurationMs(value: string): number | null {
  const match = DURATION_PATTERN.exec(value.trim())
  if (!match) return null
  const [, sign, weeks, days, hours, minutes, seconds] = match
  if (!weeks && !days && !hours && !minutes && !seconds) return null
  const magnitude =
    Number(weeks ?? 0) * 7 * 86_400_000 +
    Number(days ?? 0) * 86_400_000 +
    Number(hours ?? 0) * 3_600_000 +
    Number(minutes ?? 0) * 60_000 +
    Number(seconds ?? 0) * 1_000
  return sign === "-" ? -magnitude : magnitude
}

/**
 * The event's effective end: DTEND when present, otherwise DTSTART +
 * DURATION (the RFC 5545 §3.8.5.3 fallback). Null when neither is
 * usable.
 */
export function resolveIcsEventEnd(event: IcsEvent): IcsDateTime | null {
  if (event.end?.date) return event.end
  if (!event.start?.date || event.duration === null) return null
  const durationMs = parseIcsDurationMs(event.duration)
  if (durationMs === null) return null
  return {
    raw: event.duration,
    kind: event.start.kind,
    allDay: event.start.allDay,
    utc: event.start.utc,
    tzid: event.start.tzid,
    date: new Date(event.start.date.getTime() + durationMs),
  }
}

/** Parse an ORGANIZER/ATTENDEE value + params into an IcsPerson. */
function parseIcsPerson(prop: IcsProperty): IcsPerson {
  const value = prop.value.trim()
  let email: string | null = null
  const mailto = /^mailto:(.+)$/i.exec(value)
  if (mailto) {
    email = safeDecodeURIComponent(mailto[1])
  } else if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    email = value
  }
  const name = prop.params.CN ? prop.params.CN : null
  return {
    name,
    email,
    partstat: prop.params.PARTSTAT ? prop.params.PARTSTAT.toUpperCase() : null,
  }
}

/** decodeURIComponent that tolerates malformed sequences (keeps raw). */
function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Parse a full .ics document. Never throws (task 5.5, typed failure). */
export function parseIcsCalendar(text: string): IcsParseResult {
  const warnings: string[] = []
  const lines = unfoldIcsLines(text).map(parseIcsProperty)

  const properties = lines.filter(
    (property): property is IcsProperty => property !== null
  )
  if (text.trim().length === 0) {
    return {
      ok: false,
      reason: "empty",
      message: "The attachment contains no iCalendar content.",
    }
  }

  // Component-stack walk: calendar-level properties are read only at
  // VCALENDAR depth, event properties only inside VEVENT; every other
  // component (VTIMEZONE — including its STANDARD/DAYLIGHT children —
  // VALARM inside VEVENT, unknown components) is skipped with its
  // properties attributed to itself, so VALARM DESCRIPTIONs never leak
  // into the event's DESCRIPTION.
  const calendar: IcsCalendar = {
    version: null,
    prodid: null,
    method: null,
    events: [],
  }
  const stack: string[] = []
  let sawVcalendar = false
  let currentEvent: IcsEvent | null = null

  const addWarning = (message: string): void => {
    if (!warnings.includes(message)) warnings.push(message)
  }

  for (const property of properties) {
    if (property.name === "BEGIN") {
      const component = property.value.trim().toUpperCase()
      stack.push(component)
      if (component === "VCALENDAR") {
        if (sawVcalendar) addWarning("Multiple VCALENDAR blocks; using the first.")
        sawVcalendar = true
      } else if (component === "VEVENT" && stackTop(stack, 1) === "VCALENDAR") {
        currentEvent = {
          uid: null,
          summary: null,
          location: null,
          description: null,
          status: null,
          transp: null,
          organizer: null,
          attendees: [],
          start: null,
          end: null,
          duration: null,
        }
        calendar.events.push(currentEvent)
      }
      continue
    }
    if (property.name === "END") {
      const component = property.value.trim().toUpperCase()
      while (stack.length > 0) {
        const popped = stack.pop()
        if (popped === component) break
      }
      if (component === "VEVENT") currentEvent = null
      continue
    }

    // Attribute the property to its innermost component only.
    const top = stackTop(stack, 0)
    if (top === "VCALENDAR" && stack.length === 1) {
      switch (property.name) {
        case "VERSION":
          calendar.version = property.value.trim() || null
          break
        case "PRODID":
          calendar.prodid = property.value.trim() || null
          break
        case "METHOD":
          calendar.method = property.value.trim().toUpperCase() || null
          break
        default:
          break // CALSCALE and unknown properties: skipped gracefully
      }
      continue
    }
    if (top === "VEVENT" && currentEvent !== null) {
      applyEventProperty(currentEvent, property, addWarning)
    }
    // Anything else (VTIMEZONE, VALARM, unknown components): skipped.
  }

  if (!sawVcalendar) {
    return {
      ok: false,
      reason: "not-icalendar",
      message:
        "The attachment does not look like an iCalendar (.ics) file — no VCALENDAR block was found.",
    }
  }

  return { ok: true, calendar, warnings }
}

function stackTop(stack: string[], fromTop: number): string | null {
  return stack[stack.length - 1 - fromTop] ?? null
}

/** Apply one VEVENT property to the accumulating event. */
function applyEventProperty(
  event: IcsEvent,
  property: IcsProperty,
  addWarning: (message: string) => void
): void {
  switch (property.name) {
    case "UID":
      event.uid = property.value.trim() || null
      break
    case "SUMMARY":
      event.summary = nonEmptyText(property)
      break
    case "LOCATION":
      event.location = nonEmptyText(property)
      break
    case "DESCRIPTION":
      event.description = nonEmptyText(property)
      break
    case "STATUS":
      event.status = property.value.trim().toUpperCase() || null
      break
    case "TRANSP":
      event.transp = property.value.trim().toUpperCase() || null
      break
    case "DTSTART": {
      const parsed = parseIcsDateValue(property.value, property.params)
      if (parsed) {
        event.start = parsed
      } else {
        addWarning(
          `Could not parse the event start time ("${property.value.trim()}").`
        )
      }
      break
    }
    case "DTEND": {
      const parsed = parseIcsDateValue(property.value, property.params)
      if (parsed) {
        event.end = parsed
      } else {
        addWarning(
          `Could not parse the event end time ("${property.value.trim()}").`
        )
      }
      break
    }
    case "DURATION":
      event.duration = property.value.trim() || null
      break
    case "ORGANIZER":
      event.organizer = parseIcsPerson(property)
      break
    case "ATTENDEE":
      event.attendees.push(parseIcsPerson(property))
      break
    default:
      break // RRULE, EXDATE, X- properties, ...: skipped gracefully
  }
}

/** Unescaped TEXT property value, or null when empty after trimming. */
function nonEmptyText(property: IcsProperty): string | null {
  const text = unescapeIcsText(property.value).trim()
  return text.length > 0 ? text : null
}

/** True when the calendar is an iTIP REQUEST invitation (METHOD:REQUEST). */
export function isInvitationRequest(calendar: IcsCalendar): boolean {
  return calendar.method === "REQUEST"
}

// ---------------------------------------------------------------------------
// Display helpers (describeIcsEvent* — task 5.5)
// ---------------------------------------------------------------------------

const DAY_DATE_FORMAT = "EEE, MMM d, yyyy"
const SHORT_DATE_FORMAT = "MMM d, yyyy"
const TIME_FORMAT = "h:mm a"

/** Format an all-day date from its UTC components (timezone-stable). */
function formatAllDayDate(date: Date): string {
  const localView = new Date(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate()
  )
  return format(localView, DAY_DATE_FORMAT)
}

/**
 * Human "when" line for the preview dialog. All-day events render the
 * date(s) only (DATE values are compared in UTC, so the line is stable
 * across timezones); timed events render local date/time — UTC values
 * resolve exactly, while TZID/floating values show the wall clock as
 * stored (with the TZID in parentheses per the parser's documented
 * limitation). Null when the event has no parseable start.
 */
export function describeIcsEventTime(
  start: IcsDateTime | null,
  end: IcsDateTime | null
): string | null {
  if (!start?.date) return null

  if (start.allDay) {
    const startLabel = formatAllDayDate(start.date)
    const endDate = end?.date ?? null
    if (endDate === null) return `${startLabel} (all-day)`
    const spanDays = Math.round(
      (endDate.getTime() - start.date.getTime()) / 86_400_000
    )
    if (spanDays <= 1) return `${startLabel} (all-day)`
    return `${startLabel} – ${formatAllDayDate(endDate)} (all-day)`
  }

  const tzNote = start.tzid ? ` (${start.tzid})` : ""
  const startDateTime = format(
    start.date,
    `${SHORT_DATE_FORMAT}, ${TIME_FORMAT}`
  )
  if (!end?.date) return `${startDateTime}${tzNote}`
  if (isSameLocalDay(start.date, end.date)) {
    return `${format(start.date, SHORT_DATE_FORMAT)} ${format(
      start.date,
      TIME_FORMAT
    )} – ${format(end.date, TIME_FORMAT)}${tzNote}`
  }
  return `${startDateTime} – ${format(
    end.date,
    `${SHORT_DATE_FORMAT}, ${TIME_FORMAT}`
  )}${tzNote}`
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** "Jane Doe <jane@example.com>" / email / name / "(none)" fallback. */
export function describeIcsPerson(person: IcsPerson | null): string | null {
  if (!person) return null
  if (person.name && person.email) return `${person.name} <${person.email}>`
  return person.email ?? person.name ?? null
}
