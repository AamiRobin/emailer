import { afterEach, describe, expect, it, vi } from "vitest"

// The app tsconfig has no @types/node (vite/client only) — declare the
// slice of process this file sets for deterministic date formatting.
declare const process: { env: Record<string, string | undefined> }

// Deterministic local-time formatting for the describeIcsEventTime tests:
// runs before the module imports (vi.hoisted precedes import hoisting).
vi.hoisted(() => {
  process.env.TZ = "UTC"
})

/**
 * .ics parser tests (task 5.5, design D5). The parser is pure — these
 * exercise exactly the supported RFC 5545 subset: line unfolding,
 * quote-aware property parsing, TEXT unescaping, DATE vs DATE-TIME vs
 * UTC vs TZID values, the DURATION fallback, METHOD detection, multiple
 * VEVENTs, CRLF handling, graceful skipping of unknown components
 * (VTIMEZONE, VALARM) on a real-world-shaped Google Calendar invite, and
 * typed failures (never throws) for malformed input.
 */

import {
  describeIcsEventTime,
  describeIcsPerson,
  isInvitationRequest,
  parseIcsCalendar,
  parseIcsDateValue,
  parseIcsDurationMs,
  parseIcsProperty,
  resolveIcsEventEnd,
  unescapeIcsText,
  unfoldIcsLines,
} from "../ics"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("unfoldIcsLines", () => {
  it("unfolds CRLF continuations starting with a space (RFC 5545 §3.1)", () => {
    const text = "SUMMARY:Hello\r\n  World\r\nEND:VEVENT\r\n"
    expect(unfoldIcsLines(text)).toEqual([
      "SUMMARY:Hello World",
      "END:VEVENT",
      "",
    ])
  })

  it("unfolds tab continuations and tolerates LF-only and CR-only breaks", () => {
    expect(unfoldIcsLines("A:one\n\ttwo\nB:x")).toEqual(["A:onetwo", "B:x"])
    // A bare CR is treated as a line break; "two" does not start with
    // whitespace, so it is its own (content) line.
    expect(unfoldIcsLines("A:one\rtwo")).toEqual(["A:one", "two"])
  })

  it("strips a UTF-8 BOM", () => {
    expect(unfoldIcsLines("\uFEFFBEGIN:VCALENDAR")).toEqual([
      "BEGIN:VCALENDAR",
    ])
  })
})

describe("parseIcsProperty", () => {
  it("splits name, params, and value at the first unquoted colon", () => {
    const property = parseIcsProperty("DTSTART;TZID=America/New_York:20260918T140000")
    expect(property).not.toBeNull()
    expect(property?.name).toBe("DTSTART")
    expect(property?.params.TZID).toBe("America/New_York")
    expect(property?.value).toBe("20260918T140000")
  })

  it("keeps colons inside quoted parameters and inside values", () => {
    const property = parseIcsProperty('ATTENDEE;CN="Doe: John":mailto:bob@x.example')
    expect(property?.params.CN).toBe("Doe: John")
    expect(property?.value).toBe("mailto:bob@x.example")

    const url = parseIcsProperty("LOCATION:https://meet.example.com/abc")
    expect(url?.value).toBe("https://meet.example.com/abc")
  })

  it("uppercases the name and parameter keys, keeps the value verbatim", () => {
    const property = parseIcsProperty("summary;language=en:Hello")
    expect(property?.name).toBe("SUMMARY")
    expect(property?.params.LANGUAGE).toBe("en")
    expect(property?.value).toBe("Hello")
  })

  it("returns null for lines without a colon or without a name", () => {
    expect(parseIcsProperty("no colon here")).toBeNull()
    expect(parseIcsProperty(":value-only")).toBeNull()
  })
})

describe("unescapeIcsText", () => {
  it("unescapes the RFC 5545 §3.3.11 sequences", () => {
    expect(unescapeIcsText("line one\\nline two")).toBe("line one\nline two")
    expect(unescapeIcsText("line one\\Nline two")).toBe("line one\nline two")
    expect(unescapeIcsText("Team sync\\, Q3")).toBe("Team sync, Q3")
    expect(unescapeIcsText("a\\;b")).toBe("a;b")
    expect(unescapeIcsText("C:\\\\path")).toBe("C:\\path")
  })

  it("tolerates unknown escapes and a trailing lone backslash", () => {
    expect(unescapeIcsText("a\\qb")).toBe("aqb")
    expect(unescapeIcsText("trailing\\")).toBe("trailing\\")
  })
})

describe("parseIcsDateValue", () => {
  it("parses the all-day DATE form at UTC midnight", () => {
    const value = parseIcsDateValue("20260918")
    expect(value).not.toBeNull()
    expect(value?.kind).toBe("date")
    expect(value?.allDay).toBe(true)
    expect(value?.utc).toBe(false)
    expect(value?.tzid).toBeNull()
    expect(value?.date?.toISOString()).toBe("2026-09-18T00:00:00.000Z")
  })

  it("parses the UTC DATE-TIME form to the exact instant", () => {
    const value = parseIcsDateValue("20260918T140000Z")
    expect(value?.kind).toBe("date-time")
    expect(value?.allDay).toBe(false)
    expect(value?.utc).toBe(true)
    expect(value?.tzid).toBeNull()
    expect(value?.date?.getTime()).toBe(Date.UTC(2026, 8, 18, 14, 0, 0))
  })

  it("parses the floating form as local wall-clock time", () => {
    const value = parseIcsDateValue("20260918T140000")
    expect(value?.utc).toBe(false)
    expect(value?.tzid).toBeNull()
    expect(value?.date?.getTime()).toBe(new Date(2026, 8, 18, 14, 0, 0).getTime())
  })

  it("keeps the TZID parameter and treats the value as local wall clock", () => {
    const value = parseIcsDateValue("20260918T140000", {
      TZID: "America/New_York",
    })
    expect(value?.tzid).toBe("America/New_York")
    expect(value?.utc).toBe(false)
    // Documented v1 limitation: no zone resolution — local wall clock.
    expect(value?.date?.getTime()).toBe(new Date(2026, 8, 18, 14, 0, 0).getTime())
  })

  it("rejects impossible calendar values instead of rolling over", () => {
    expect(parseIcsDateValue("20261318")).toBeNull() // month 13
    expect(parseIcsDateValue("20260230")).toBeNull() // Feb 30
    expect(parseIcsDateValue("20260918T270000Z")).toBeNull() // hour 27
    expect(parseIcsDateValue("20260918T146100Z")).toBeNull() // minute 61
    expect(parseIcsDateValue("20260918T146000Z")).toBeNull() // leap second
    expect(parseIcsDateValue("not-a-date")).toBeNull()
    expect(parseIcsDateValue("20260918T1400Z")).toBeNull() // truncated
  })
})

describe("parseIcsDurationMs", () => {
  it("parses the RFC 5545 duration grammar", () => {
    expect(parseIcsDurationMs("PT1H30M")).toBe(90 * 60_000)
    expect(parseIcsDurationMs("P2DT3H")).toBe(
      2 * 86_400_000 + 3 * 3_600_000
    )
    expect(parseIcsDurationMs("P1W")).toBe(7 * 86_400_000)
    expect(parseIcsDurationMs("PT45S")).toBe(45_000)
    expect(parseIcsDurationMs("-PT15M")).toBe(-15 * 60_000)
  })

  it("rejects malformed durations", () => {
    expect(parseIcsDurationMs("P")).toBeNull()
    expect(parseIcsDurationMs("1H30M")).toBeNull()
    expect(parseIcsDurationMs("PT")).toBeNull()
    expect(parseIcsDurationMs("")).toBeNull()
  })
})

describe("resolveIcsEventEnd", () => {
  const start = parseIcsDateValue("20260918T140000Z")

  it("prefers DTEND", () => {
    const end = parseIcsDateValue("20260918T150000Z")
    const event = {
      uid: "u",
      summary: null,
      location: null,
      description: null,
      status: null,
      transp: null,
      organizer: null,
      attendees: [],
      start,
      end,
      duration: null,
    }
    expect(resolveIcsEventEnd(event)?.date?.getTime()).toBe(
      Date.UTC(2026, 8, 18, 15, 0, 0)
    )
  })

  it("falls back to DTSTART + DURATION", () => {
    const event = {
      uid: "u",
      summary: null,
      location: null,
      description: null,
      status: null,
      transp: null,
      organizer: null,
      attendees: [],
      start,
      end: null,
      duration: "PT1H30M",
    }
    const end = resolveIcsEventEnd(event)
    expect(end?.date?.getTime()).toBe(
      Date.UTC(2026, 8, 18, 14, 0, 0) + 90 * 60_000
    )
  })

  it("returns null without DTEND or a usable DURATION", () => {
    expect(
      resolveIcsEventEnd({
        uid: "u",
        summary: null,
        location: null,
        description: null,
        status: null,
        transp: null,
        organizer: null,
        attendees: [],
        start,
        end: null,
        duration: null,
      })
    ).toBeNull()
    expect(
      resolveIcsEventEnd({
        uid: "u",
        summary: null,
        location: null,
        description: null,
        status: null,
        transp: null,
        organizer: null,
        attendees: [],
        start,
        end: null,
        duration: "bogus",
      })
    ).toBeNull()
  })
})

// A Google-Calendar-shaped invite: VTIMEZONE block, a VALARM inside the
// VEVENT, folded ATTENDEE line, RRULE, X- properties — the parser must
// surface ONLY the VEVENT's own properties.
const GOOGLE_INVITE = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "CALSCALE:GREGORIAN",
  "METHOD:REQUEST",
  "BEGIN:VTIMEZONE",
  "TZID:America/New_York",
  "X-LIC-LOCATION:America/New_York",
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:-0500",
  "TZOFFSETTO:-0400",
  "TZNAME:EDT",
  "DTSTART:19700308T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:-0400",
  "TZOFFSETTO:-0500",
  "TZNAME:EST",
  "DTSTART:19701101T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  "DTSTART;TZID=America/New_York:20260918T140000",
  "DTEND;TZID=America/New_York:20260918T150000",
  "RRULE:FREQ=WEEKLY;BYDAY=FR",
  "DTSTAMP:20260901T120000Z",
  "UID:abc123@google.com",
  "CREATED:20260820T093000Z",
  "DESCRIPTION:Weekly sync to review the roadmap.\\n\\nBring question",
  " s.",
  "LAST-MODIFIED:20260820T093000Z",
  "LOCATION:https://meet.example.com/abc-def-ghi",
  "SEQUENCE:0",
  "STATUS:CONFIRMED",
  "SUMMARY:Roadmap sync",
  "TRANSP:OPAQUE",
  "ORGANIZER;CN=Alice Organizer:mailto:alice@example.com",
  "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP",
  " =TRUE;CN=Bob Attendee;X-NUM-GUESTS=0:mailto:bob%40example.com",
  "X-GOOGLE-CONFERENCE:https://meet.example.com/abc-def-ghi",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "DESCRIPTION:This is an event reminder",
  "TRIGGER:-P10M",
  "END:VALARM",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n")

describe("parseIcsCalendar", () => {
  it("parses the Google-shaped invite, skipping VTIMEZONE and VALARM", () => {
    const result = parseIcsCalendar(GOOGLE_INVITE)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { calendar, warnings } = result
    expect(warnings).toEqual([])
    expect(calendar.version).toBe("2.0")
    expect(calendar.prodid).toBe("-//Google Inc//Google Calendar 70.9054//EN")
    expect(calendar.method).toBe("REQUEST")
    expect(isInvitationRequest(calendar)).toBe(true)
    expect(calendar.events).toHaveLength(1)

    const event = calendar.events[0]
    expect(event.uid).toBe("abc123@google.com")
    expect(event.summary).toBe("Roadmap sync")
    expect(event.location).toBe("https://meet.example.com/abc-def-ghi")
    // DESCRIPTION unfolded across the continuation line AND unescaped.
    expect(event.description).toBe(
      "Weekly sync to review the roadmap.\n\nBring questions."
    )
    expect(event.status).toBe("CONFIRMED")
    expect(event.transp).toBe("OPAQUE")

    // TZID value: local wall clock + the raw zone name kept.
    expect(event.start?.tzid).toBe("America/New_York")
    expect(event.start?.date?.getTime()).toBe(
      new Date(2026, 8, 18, 14, 0, 0).getTime()
    )
    expect(event.end?.date?.getTime()).toBe(
      new Date(2026, 8, 18, 15, 0, 0).getTime()
    )

    expect(event.organizer).toEqual({
      name: "Alice Organizer",
      email: "alice@example.com",
      partstat: null,
    })
    expect(event.attendees).toHaveLength(1)
    expect(event.attendees[0]).toEqual({
      name: "Bob Attendee",
      email: "bob@example.com",
      partstat: "NEEDS-ACTION",
    })

    // The VALARM's DESCRIPTION/DTSTART must NOT leak into the event, and
    // VTIMEZONE's DTSTARTs must not either.
    expect(event.description).not.toBe("This is an event reminder")
  })

  it("parses multiple VEVENTs into a list", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:first@example.com",
      "SUMMARY:First",
      "DTSTART:20260921T090000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:second@example.com",
      "SUMMARY:Second",
      "DTSTART:20260922T090000Z",
      "DURATION:PT30M",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n")
    const result = parseIcsCalendar(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.calendar.events).toHaveLength(2)
    expect(result.calendar.events.map((event) => event.summary)).toEqual([
      "First",
      "Second",
    ])
  })

  it("handles CRLF and LF line endings alike", () => {
    const lines = [
      "BEGIN:VCALENDAR",
      "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      "UID:x@y",
      "SUMMARY:Either ending",
      "DTSTART:20260918T100000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ]
    const crlf = parseIcsCalendar(lines.join("\r\n"))
    const lf = parseIcsCalendar(lines.join("\n"))
    expect(crlf.ok && lf.ok).toBe(true)
    if (crlf.ok && lf.ok) {
      expect(crlf.calendar.events[0]?.summary).toBe("Either ending")
      expect(lf.calendar.events[0]?.summary).toBe("Either ending")
      expect(crlf.calendar.method).toBe("PUBLISH")
      expect(isInvitationRequest(crlf.calendar)).toBe(false)
    }
  })

  it("degrades malformed events to warnings instead of throwing", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "SUMMARY:Broken times",
      "DTSTART:not-a-date",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n")
    const result = parseIcsCalendar(text)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.calendar.events[0]?.start).toBeNull()
    expect(
      result.warnings.some((warning) => warning.includes("start time"))
    ).toBe(true)
  })

  it("fails typed — not throwing — on non-iCalendar input", () => {
    const empty = parseIcsCalendar("")
    expect(empty).toEqual({
      ok: false,
      reason: "empty",
      message: expect.any(String),
    })

    const garbage = parseIcsCalendar(
      "This is just an email body pasted into a file.\nNothing to see."
    )
    expect(garbage.ok).toBe(false)
    if (garbage.ok) return
    expect(garbage.reason).toBe("not-icalendar")

    // Unterminated VCALENDAR still parses (tolerant) — malformed ENDs
    // never throw.
    const unterminated = parseIcsCalendar("BEGIN:VCALENDAR\r\nMETHOD:PUBLISH")
    expect(unterminated.ok).toBe(true)
  })

  it("unescapes commas and semicolons in SUMMARY", () => {
    const result = parseIcsCalendar(
      [
        "BEGIN:VCALENDAR",
        "BEGIN:VEVENT",
        "UID:esc@x",
        "SUMMARY:Team sync\\, Q3 planning\\; bring notes",
        "END:VEVENT",
        "END:VCALENDAR",
      ].join("\n")
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.calendar.events[0]?.summary).toBe(
      "Team sync, Q3 planning; bring notes"
    )
  })
})

describe("describeIcsEventTime", () => {
  it("formats all-day single and multi-day spans (timezone-stable UTC)", () => {
    const start = parseIcsDateValue("20260918")
    expect(describeIcsEventTime(start, null)).toBe(
      "Fri, Sep 18, 2026 (all-day)"
    )
    // A one-day all-day span (end is EXCLUSIVE per RFC 5545).
    const nextDay = parseIcsDateValue("20260919")
    expect(describeIcsEventTime(start, nextDay)).toBe(
      "Fri, Sep 18, 2026 (all-day)"
    )
    const endOfWeek = parseIcsDateValue("20260921")
    expect(describeIcsEventTime(start, endOfWeek)).toBe(
      "Fri, Sep 18, 2026 – Mon, Sep 21, 2026 (all-day)"
    )
  })

  it("formats same-day timed events with one date and both times", () => {
    const start = parseIcsDateValue("20260918T140000Z")
    const end = parseIcsDateValue("20260918T150000Z")
    expect(describeIcsEventTime(start, end)).toBe("Sep 18, 2026 2:00 PM – 3:00 PM")
  })

  it("formats cross-day timed events with both dates", () => {
    const start = parseIcsDateValue("20260918T230000Z")
    const end = parseIcsDateValue("20260919T010000Z")
    expect(describeIcsEventTime(start, end)).toBe(
      "Sep 18, 2026, 11:00 PM – Sep 19, 2026, 1:00 AM"
    )
  })

  it("appends the raw TZID as the zone note (documented limitation)", () => {
    const start = parseIcsDateValue("20260918T140000", {
      TZID: "America/New_York",
    })
    expect(describeIcsEventTime(start, null)).toBe(
      "Sep 18, 2026, 2:00 PM (America/New_York)"
    )
  })

  it("returns null without a parseable start", () => {
    expect(describeIcsEventTime(null, null)).toBeNull()
    expect(
      describeIcsEventTime(
        {
          raw: "bogus",
          kind: "date-time",
          allDay: false,
          utc: false,
          tzid: null,
          date: null,
        },
        null
      )
    ).toBeNull()
  })
})

describe("describeIcsPerson", () => {
  it("joins name and email", () => {
    expect(
      describeIcsPerson({ name: "Alice", email: "alice@example.com", partstat: null })
    ).toBe("Alice <alice@example.com>")
  })
  it("falls back to whichever part exists", () => {
    expect(describeIcsPerson({ name: null, email: "x@example.com", partstat: null })).toBe(
      "x@example.com"
    )
    expect(describeIcsPerson({ name: "Just A Name", email: null, partstat: null })).toBe(
      "Just A Name"
    )
    expect(describeIcsPerson(null)).toBeNull()
  })
})
