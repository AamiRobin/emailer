import { describe, expect, it } from "vitest"

import { buildIcsReply, replyRequestFromInvite } from "../ics-reply"
import { parseIcsCalendar } from "../ics"
import type { IcsEvent } from "../ics"

/**
 * The TS METHOD:REPLY builder tests (parity-round-3 task 8.3, design
 * D5). The CANONICAL fixture below is the byte-exact output of the Rust
 * `ics::build_reply` — the Rust test
 * `ics::tests::reply_blob_matches_the_canonical_fixture` asserts the
 * same bytes (change one, change BOTH). The RSVP flow's REPLY
 * attachment is compared against this fixture in rsvp.test.ts, so the
 * mail-side answer always matches the Rust-built grammar.
 */

const CANONICAL_REPLY_FIXTURE = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//emailer//Calendar 1.0//EN",
  "METHOD:REPLY",
  "BEGIN:VEVENT",
  "UID:9kq3lmiqg9v1s0h3t6q8g9v1s0@google.com",
  "SEQUENCE:1",
  "DTSTART:20260918T140000Z",
  "ORGANIZER;CN=Alice Organizer:mailto:alice@organizer.example",
  "ATTENDEE;CN=Bob Attendee;PARTSTAT=ACCEPTED:mailto:bob@attendee.example",
  "SUMMARY:Quarterly sync",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n")

function canonicalRequest(): Parameters<typeof buildIcsReply>[0] {
  return {
    uid: "9kq3lmiqg9v1s0h3t6q8g9v1s0@google.com",
    sequence: 1,
    recurrenceId: null,
    dtStart: "20260918T140000Z",
    organizer: {
      email: "alice@organizer.example",
      name: "Alice Organizer",
    },
    attendee: { email: "bob@attendee.example", name: "Bob Attendee" },
    partstat: "ACCEPTED",
    summary: "Quarterly sync",
  }
}

describe("buildIcsReply", () => {
  it("matches the Rust-built canonical REPLY fixture byte-for-byte", () => {
    expect(buildIcsReply(canonicalRequest())).toBe(CANONICAL_REPLY_FIXTURE)
  })

  it("carries RECURRENCE-ID for single-occurrence answers and drops empty echoes", () => {
    const blob = buildIcsReply({
      ...canonicalRequest(),
      uid: "series@example.com",
      sequence: null,
      dtStart: null,
      summary: null,
      organizer: { email: "alice@organizer.example", name: null },
      recurrenceId: "20260914T100000Z",
      partstat: "DECLINED",
    })
    expect(blob).toContain("RECURRENCE-ID:20260914T100000Z\r\n")
    expect(blob).not.toContain("SEQUENCE:")
    expect(blob).not.toContain("DTSTART:")
    expect(blob).not.toContain("SUMMARY:")
    expect(blob).toContain("ORGANIZER:mailto:alice@organizer.example\r\n")
    expect(blob).toContain(
      "ATTENDEE;CN=Bob Attendee;PARTSTAT=DECLINED:mailto:bob@attendee.example\r\n"
    )
    // The object still ends with a CRLF-terminated VCALENDAR.
    expect(blob.endsWith("END:VCALENDAR\r\n")).toBe(true)
  })

  it("rejects the same inputs the Rust builder rejects", () => {
    expect(() => buildIcsReply({ ...canonicalRequest(), uid: "  " })).toThrow(
      "UID"
    )
    expect(() =>
      buildIcsReply({ ...canonicalRequest(), partstat: "MAYBE" })
    ).toThrow("PARTSTAT")
    expect(() =>
      buildIcsReply({
        ...canonicalRequest(),
        attendee: { email: "", name: null },
      })
    ).toThrow("attendee")
  })

  it("escapes TEXT values like the Rust builder", () => {
    const blob = buildIcsReply({
      ...canonicalRequest(),
      uid: "escape@example.com",
      sequence: null,
      dtStart: null,
      summary: "Comma, semicolon; test",
      organizer: null,
      attendee: { email: "bob@attendee.example", name: "Comma, ; Person" },
    })
    expect(blob).toContain(
      "ATTENDEE;CN=Comma\\, \\; Person;PARTSTAT=ACCEPTED:mailto:bob@attendee.example"
    )
    expect(blob).toContain("SUMMARY:Comma\\, semicolon\\; test")
  })
})

describe("replyRequestFromInvite", () => {
  it("echoes the parsed invitation's fields (raw values, organizer CN)", () => {
    const parsed = parseIcsCalendar(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        "UID:invite-1@example.com",
        "SEQUENCE:3",
        "RECURRENCE-ID:20260914T100000Z",
        "DTSTART:20260914T100000Z",
        "ORGANIZER;CN=Alice:mailto:alice@organizer.example",
        "ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:me@example.com",
        "SUMMARY:Weekly standup",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n")
    )
    expect(parsed.ok).toBe(true)
    const event: IcsEvent = parsed.ok
      ? parsed.calendar.events[0]
      : ({} as IcsEvent)
    const request = replyRequestFromInvite({
      event,
      attendee: { email: "me@example.com", name: "Me" },
      partstat: "TENTATIVE",
    })
    expect(request).toEqual({
      uid: "invite-1@example.com",
      sequence: 3,
      recurrenceId: "20260914T100000Z",
      dtStart: "20260914T100000Z",
      organizer: { email: "alice@organizer.example", name: "Alice" },
      attendee: { email: "me@example.com", name: "Me" },
      partstat: "TENTATIVE",
      summary: "Weekly standup",
    })
    // The assembled request round-trips through the builder into the
    // canonical shape (RECURRENCE-ID + one ATTENDEE).
    const blob = buildIcsReply(request)
    expect(blob).toContain("METHOD:REPLY")
    expect(blob).toContain("ATTENDEE;CN=Me;PARTSTAT=TENTATIVE:mailto:me@example.com")
  })

  it("tolerates an invitation without organizer or times", () => {
    const bare = parseIcsCalendar(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        "UID:bare@example.com",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n")
    )
    expect(bare.ok).toBe(true)
    const request = replyRequestFromInvite({
      event: (bare.ok ? bare.calendar.events[0] : ({} as IcsEvent)) as IcsEvent,
      attendee: { email: "me@example.com" },
      partstat: "ACCEPTED",
    })
    expect(request.uid).toBe("bare@example.com")
    expect(request.sequence ?? null).toBeNull()
    expect(request.organizer).toBeUndefined()
    expect(buildIcsReply(request)).toContain(
      "ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com"
    )
  })
})
