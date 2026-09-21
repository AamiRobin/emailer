import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * .ics seam contract tests (task 5.4 bodies replacing the task 5.5
 * stubs). The write functions now really add the parsed event through the
 * event-write service and route invitation responses per the support
 * matrix (google best-effort / caldav typed unsupported). Pinned here:
 *
 * - no calendar sources (or a failing listing) → "no-source", no write;
 * - offline → the explicit "offline" failure with NO write attempted
 *   (the spec's online-write contract);
 * - a real add maps the parsed VEVENT fully (title/when/where/notes,
 *   all-day DATE handling, attendees as guests) onto createEvent and
 *   answers { ok: true, sourceId };
 * - respond: caldav → typed "unsupported" (iTIP REPLY out of scope);
 *   google → routed to the google RSVP path (unsynced event → "no-event").
 *
 * Source discovery runs against a REAL node:sqlite executor with seeded
 * calendar_sources rows (the seam now imports the settled task-5.1
 * sources module directly); the write layer is injected via deps.
 */

import type { SqlExecutor } from "../../db/executor"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { addCalendarSource } from "../sources"
import { createCalendarSource } from "./calendar-fixtures"
import { useOnlineStore } from "../../../stores/online-store"
import {
  addIcsEventToCalendar,
  CALDAV_RSVP_UNSUPPORTED_MESSAGE,
  listIcsCalendarSources,
  readCalendarSources,
  respondToInvitation,
  type CalendarSourceChoice,
  type RespondToInvitationResult,
} from "../ics-seam"
import type {
  EventWriteInput,
  EventWriteResult,
} from "../event-writes"
import type { CalendarEvent } from "../events"

const stubExecutor = { marker: "test-executor" } as unknown as SqlExecutor

const TIMED_INVITE = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:invite-1@example.com",
  "DTSTART:20260918T140000Z",
  "DTEND:20260918T150000Z",
  "SUMMARY:Roadmap sync",
  "LOCATION:https://meet.example.com/abc",
  "DESCRIPTION:Weekly sync to review the roadmap.",
  "ORGANIZER;CN=Alice Organizer:mailto:alice@example.com",
  "ATTENDEE;CN=Bob Attendee:mailto:bob@example.com",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n")

const ALL_DAY_NOTICE = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "BEGIN:VEVENT",
  "UID:notice-1@example.com",
  "DTSTART;VALUE=DATE:20260918",
  "DTEND;VALUE=DATE:20260919",
  "SUMMARY:Release day",
  "ATTENDEE:mailto:carol@example.com",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n")

/** A minimal CalendarEvent stand-in for the injected write layer. */
const WRITTEN_EVENT: CalendarEvent = {
  id: "ce-src-1:primary:written",
  sourceId: "src-1",
  calendarId: "primary",
  uid: "written",
  summary: null,
  location: null,
  description: null,
  startAt: 0,
  endAt: 0,
  allDay: false,
  recurrence: null,
  status: null,
}

describe("addIcsEventToCalendar (task 5.4 bodies)", () => {
  let executor: TestExecutor
  const created: unknown[] = []
  /** The injected write layer: records the input, answers success. */
  const createEventFake = vi.fn<
    (
      executor: SqlExecutor,
      input: EventWriteInput
    ) => Promise<EventWriteResult>
  >(async () => ({ ok: true, event: WRITTEN_EVENT }))

  function source(id: string): CalendarSourceChoice {
    return { id, name: id, provider: "google" }
  }

  beforeEach(async () => {
    executor = createTestExecutor()
    created.length = 0
    createEventFake.mockClear()
    createEventFake.mockImplementation(async (_executor, input) => {
      created.push(input)
      return { ok: true, event: WRITTEN_EVENT }
    })
    useOnlineStore.setState({ online: true })
  })

  afterEach(() => {
    executor.close()
    useOnlineStore.setState({ online: true })
  })

  it("answers no-source when no calendar source is connected (no write)", async () => {
    const result = await addIcsEventToCalendar(
      executor,
      { ics: TIMED_INVITE },
      { listSources: async () => [], createEvent: createEventFake }
    )
    expect(result).toEqual({ ok: false, reason: "no-source" })
    expect(createEventFake).not.toHaveBeenCalled()
  })

  it("degrades a failing source listing to no-source instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await addIcsEventToCalendar(executor, { ics: TIMED_INVITE }, {
      listSources: async () => {
        throw new Error("db gone")
      },
    })
    expect(result).toEqual({ ok: false, reason: "no-source" })
    expect(warn).toHaveBeenCalled()
  })

  it("adds the parsed event to the source's default calendar with full details", async () => {
    await createCalendarSource(executor, null, { id: "src-1" })
    const result = await addIcsEventToCalendar(
      executor,
      { ics: TIMED_INVITE, preferredSourceId: "src-1" },
      { createEvent: createEventFake }
    )
    expect(result).toEqual({ ok: true, sourceId: "src-1" })
    expect(created).toHaveLength(1)
    // Google source with no synced calendars yet → the "primary" default.
    expect(created[0]).toMatchObject({
      sourceId: "src-1",
      calendarId: "primary",
      title: "Roadmap sync",
      allDay: false,
      startAt: Date.parse("2026-09-18T14:00:00Z") / 1000,
      endAt: Date.parse("2026-09-18T15:00:00Z") / 1000,
      location: "https://meet.example.com/abc",
      description: "Weekly sync to review the roadmap.",
      guests: ["bob@example.com"],
    })
  })

  it("maps all-day DATE values with an exclusive end", async () => {
    await createCalendarSource(executor, null, { id: "src-1" })
    await addIcsEventToCalendar(
      executor,
      { ics: ALL_DAY_NOTICE, preferredSourceId: "src-1" },
      { createEvent: createEventFake }
    )
    expect(created[0]).toMatchObject({
      allDay: true,
      startAt: Date.parse("2026-09-18T00:00:00Z") / 1000,
      endAt: Date.parse("2026-09-19T00:00:00Z") / 1000,
      title: "Release day",
    })
  })

  it("answers offline without attempting the write (online-write contract)", async () => {
    await createCalendarSource(executor, null, { id: "src-1" })
    useOnlineStore.setState({ online: false })
    const result = await addIcsEventToCalendar(
      executor,
      { ics: TIMED_INVITE, preferredSourceId: "src-1" },
      { createEvent: createEventFake }
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("offline")
      expect(result.message).toContain("offline")
    }
    expect(createEventFake).not.toHaveBeenCalled()
  })

  it("answers invalid for non-iCalendar content", async () => {
    const result = await addIcsEventToCalendar(
      executor,
      { ics: "not a calendar" },
      { listSources: async () => [source("src-1")], createEvent: createEventFake }
    )
    expect(result).toMatchObject({ ok: false, reason: "invalid" })
    expect(createEventFake).not.toHaveBeenCalled()
  })

  it("answers no-event when the file carries no usable VEVENT", async () => {
    const result = await addIcsEventToCalendar(
      executor,
      { ics: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n" },
      { listSources: async () => [source("src-1")], createEvent: createEventFake }
    )
    expect(result).toMatchObject({ ok: false, reason: "no-event" })
    expect(createEventFake).not.toHaveBeenCalled()
  })
})

describe("respondToInvitation (task 5.4 bodies)", () => {
  let executor: TestExecutor

  beforeEach(async () => {
    executor = createTestExecutor()
    useOnlineStore.setState({ online: true })
  })

  afterEach(() => {
    executor.close()
    useOnlineStore.setState({ online: true })
  })

  function source(id: string): CalendarSourceChoice {
    return { id, name: id, provider: "google" }
  }

  it("answers no-source when no calendar source is connected", async () => {
    for (const response of ["yes", "no", "maybe"] as const) {
      const result = await respondToInvitation(
        executor,
        { ics: TIMED_INVITE, response },
        { listSources: async () => [] }
      )
      expect(result).toEqual({ ok: false, reason: "no-source" })
    }
  })

  it("answers offline without sending anything (online-write contract)", async () => {
    await createCalendarSource(executor, null, { id: "src-1" })
    useOnlineStore.setState({ online: false })
    const respond = vi.fn(async (): Promise<RespondToInvitationResult> => ({
      ok: true,
      response: "yes",
    }))
    const result = await respondToInvitation(
      executor,
      { ics: TIMED_INVITE, response: "yes", preferredSourceId: "src-1" },
      { respond }
    )
    expect(result).toMatchObject({ ok: false, reason: "offline" })
    expect(respond).not.toHaveBeenCalled()
  })

  it("answers typed unsupported for caldav sources (iTIP REPLY out of scope)", async () => {
    await addCalendarSource(executor, {
      id: "src-caldav",
      accountId: null,
      provider: "caldav",
      name: "dav",
      configJson: "sealed",
    })
    const result = await respondToInvitation(executor, {
      ics: TIMED_INVITE,
      response: "maybe",
      preferredSourceId: "src-caldav",
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("unsupported")
      expect(result.message).toBe(CALDAV_RSVP_UNSUPPORTED_MESSAGE)
    }
  })

  it("routes a google response to the google RSVP path (unsynced event → no-event)", async () => {
    await createCalendarSource(executor, null, { id: "src-1" })
    const result = await respondToInvitation(executor, {
      ics: TIMED_INVITE,
      response: "maybe",
      preferredSourceId: "src-1",
    })
    // The invitation's event is not in the local cache yet: the google
    // RSVP path refuses with a typed no-event instead of pretending.
    expect(result).toMatchObject({ ok: false, reason: "no-event" })
  })

  it("answers no-event when the invitation carries no UID", async () => {
    const result = await respondToInvitation(
      executor,
      { ics: "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n", response: "no" },
      { listSources: async () => [source("src-1")] }
    )
    expect(result).toMatchObject({ ok: false, reason: "no-event" })
  })

  it("uses the injected respond seam and answers ok on success", async () => {
    const respond = vi.fn(async (_executor, sourceId, request) => {
      expect(sourceId).toBe("src-1")
      expect(request.response).toBe("maybe")
      return { ok: true, response: "maybe" } as RespondToInvitationResult
    })
    const result = await respondToInvitation(
      executor,
      { ics: TIMED_INVITE, response: "maybe", preferredSourceId: "src-1" },
      { listSources: async () => [source("src-1")], respond }
    )
    expect(result).toEqual({ ok: true, response: "maybe" })
  })
})

describe("listIcsCalendarSources", () => {
  it("uses the injected source listing when provided", async () => {
    const choices = [
      { id: "src-1", name: "Work", provider: "google" as const },
    ]
    const sources = await listIcsCalendarSources(stubExecutor, {
      listSources: async () => choices,
    })
    expect(sources).toEqual(choices)
  })
})

describe("readCalendarSources (settled task-5.1 import)", () => {
  it("maps the seeded sources with their providers", async () => {
    const executor = createTestExecutor()
    try {
      await createCalendarSource(executor, null, { id: "src-a", name: "Work" })
      const choices = await readCalendarSources(executor)
      expect(choices).toEqual([
        { id: "src-a", name: "Work", provider: "google" },
      ])
    } finally {
      executor.close()
    }
  })

  it("degrades a failing lookup to an empty list instead of throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const choices = await readCalendarSources(stubExecutor)
    expect(choices).toEqual([])
    expect(warn).toHaveBeenCalled()
  })
})
