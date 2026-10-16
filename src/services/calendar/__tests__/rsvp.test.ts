import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"

import {
  createCalendarSource,
  createFetchMock,
  googleEvent,
} from "./calendar-fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { setDefaultKeyStore } from "../../crypto/key-management"
import { createInMemoryKeyStore } from "../../crypto/__tests__/in-memory-key-store"
import { encryptCredentials } from "../../crypto/credentials"
import { clearMicrosoftTokenCache } from "../../email/microsoft-token-manager"
import { useOnlineStore } from "../../../stores/online-store"
import { parseIcsCalendar } from "../ics"
import type { IcsEvent } from "../ics"
import { buildIcsReply } from "../ics-reply"
import {
  buildReplyMailInput,
  respondToInvite,
  writeBackCaldavAttendee,
  type RsvpTarget,
} from "../rsvp"

/**
 * RSVP flow tests (parity-round-3 task 8.3, design D5): one suite per
 * source family over the SAME ordering contract —
 *
 *   answer stamped locally FIRST, write-back per family (Graph RSVP
 *   actions / Google attendees PATCH / CalDAV PUT), then the organizer
 *   REPLY mail QUEUED through the pending_operations send pipeline;
 *
 * plus the failure contracts: a failed write-back never loses the
 * answer and never blocks the REPLY, and the queued REPLY attachment is
 * byte-identical to the RUST-built canonical fixture (the Rust test
 * `ics::tests::reply_blob_matches_the_canonical_fixture` pins the same
 * bytes; ics-reply.test.ts pins the TS twin to them).
 */

vi.mock("@tauri-apps/api/core")

const invokeMock = vi.mocked(invoke)

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

/** The invitation every target is built from (the canonical meeting). */
function canonicalInviteIcs(): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    "UID:9kq3lmiqg9v1s0h3t6q8g9v1s0@google.com",
    "SEQUENCE:1",
    "DTSTART:20260918T140000Z",
    "DTEND:20260918T150000Z",
    "SUMMARY:Quarterly sync",
    "ORGANIZER;CN=Alice Organizer:mailto:alice@organizer.example",
    "ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=Bob Attendee:mailto:bob@attendee.example",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n")
}

function canonicalEvent(): IcsEvent {
  const parsed = parseIcsCalendar(canonicalInviteIcs())
  if (!parsed.ok) throw new Error("fixture invite must parse")
  return parsed.calendar.events[0]
}

async function seedRespondingAccount(
  executor: TestExecutor
): Promise<string> {
  // The exact identity the canonical fixture's ATTENDEE line carries.
  await executor.execute(
    `INSERT INTO accounts (id, type, email, display_name, status)
     VALUES ('acc-me', 'gmail', 'bob@attendee.example', 'Bob Attendee', 'active')`
  )
  return "acc-me"
}

/** The queued `send` op's decoded REPLY attachment (or null). */
async function queuedReplyAttachment(
  executor: TestExecutor
): Promise<{ subject: string; attachment: string } | null> {
  const rows = await executor.select<{
    op_type: string
    payload_json: string
  }>(
    "SELECT op_type, payload_json FROM pending_operations WHERE op_type = 'send'"
  )
  if (rows.length === 0) return null
  const payload = JSON.parse(rows[0].payload_json) as {
    input: {
      subject: string
      to: { email: string }[]
      attachments?: { filename: string; contentBase64: string }[]
    }
  }
  const base64 = payload.input.attachments?.[0]?.contentBase64
  if (!base64) return null
  const bytes = Uint8Array.from(atob(base64), (character) =>
    character.charCodeAt(0)
  )
  return {
    subject: payload.input.subject,
    attachment: new TextDecoder().decode(bytes),
  }
}

beforeEach(() => {
  setDefaultKeyStore(createInMemoryKeyStore())
  useOnlineStore.setState({ online: true })
  invokeMock.mockReset()
})

afterEach(() => {
  clearMicrosoftTokenCache()
  setDefaultKeyStore(null)
  useOnlineStore.setState({ online: true })
})

describe("microsoft family (Graph RSVP actions)", () => {
  it("applies accept on the cached event and queues the REPLY", async () => {
    const executor = createTestExecutor()
    try {
      const accountId = await seedRespondingAccount(executor)
      const configJson = await encryptCredentials({
        refreshToken: "0.rt",
        accessToken: "0.at",
        accessTokenExpiresAt: Date.now() + 3_600_000,
        clientId: "client-1",
      })
      await createCalendarSource(executor, accountId, {
        id: "src-ms",
        provider: "microsoft",
        name: "me@outlook.com",
        configJson,
      })
      await executor.execute(
        `INSERT INTO calendar_events (id, source_id, calendar_id, uid, ical, start_at, end_at, all_day)
         VALUES ('ce-ms', 'src-ms', 'cal-1', 'gev-occ-1', '', 1789740000, 1789743600, 0)`
      )
      const mock = createFetchMock()
      // Series-scope resolution: the cached row is a single instance —
      // no seriesMasterId, so the RSVP addresses the row itself.
      mock.on("GET", "/me/events/gev-occ-1", () => ({
        json: { id: "gev-occ-1", type: "singleInstance" },
      }))
      let rsvpBody: Record<string, unknown> | null = null
      mock.on("POST", "/me/events/gev-occ-1/accept", (call) => {
        rsvpBody = JSON.parse(call.body ?? "{}") as Record<string, unknown>
        return { status: 202, json: null }
      })

      const target: RsvpTarget = {
        uid: "9kq3lmiqg9v1s0h3t6q8g9v1s0@google.com",
        event: canonicalEvent(),
        row: {
          rowId: "ce-ms",
          sourceId: "src-ms",
          provider: "microsoft",
          uid: "gev-occ-1",
          calendarId: "cal-1",
        },
      }
      const outcome = await respondToInvite(executor, accountId, target, "yes", "series", {
        buildReply: buildIcsReply,
        fetchImpl: mock.fetch,
      })

      expect(outcome).toMatchObject({
        ok: true,
        writeBack: { status: "applied" },
        reply: { status: "queued" },
      })
      // sendResponse:false — the app's own REPLY mail is the answer;
      // Graph must not generate a second one.
      expect(rsvpBody).toEqual({ sendResponse: false })
      // The answer was stamped BEFORE anything went to the network.
      const stamped = await executor.select<{ partstat: string | null }>(
        "SELECT partstat FROM calendar_events WHERE id = 'ce-ms'"
      )
      expect(stamped[0]?.partstat).toBe("ACCEPTED")
      // The organizer REPLY rides the queued send pipeline.
      const queued = await queuedReplyAttachment(executor)
      expect(queued?.subject).toBe("Accepted: Quarterly sync")
      expect(queued?.attachment).toContain("METHOD:REPLY")
      expect(queued?.attachment).toContain(
        "ATTENDEE;CN=Bob Attendee;PARTSTAT=ACCEPTED:mailto:bob@attendee.example"
      )
    } finally {
      executor.close()
    }
  })

  it("resolves the series master for a series-scoped answer on an occurrence row", async () => {
    const executor = createTestExecutor()
    try {
      const accountId = await seedRespondingAccount(executor)
      const configJson = await encryptCredentials({
        refreshToken: "0.rt",
        accessToken: "0.at",
        accessTokenExpiresAt: Date.now() + 3_600_000,
        clientId: "client-1",
      })
      await createCalendarSource(executor, accountId, {
        id: "src-ms",
        provider: "microsoft",
        name: "me@outlook.com",
        configJson,
      })
      await executor.execute(
        `INSERT INTO calendar_events (id, source_id, calendar_id, uid, ical, start_at, end_at, all_day)
         VALUES ('ce-ms', 'src-ms', 'cal-1', 'gev-occ-1', '', 1789740000, 1789743600, 0)`
      )
      const mock = createFetchMock()
      mock.on("GET", "/me/events/gev-occ-1", () => ({
        json: {
          id: "gev-occ-1",
          type: "occurrence",
          seriesMasterId: "gev-master",
        },
      }))
      const posted: string[] = []
      mock.on("POST", "/me/events/gev-master/decline", () => {
        posted.push("decline")
        return { status: 202, json: null }
      })

      const outcome = await respondToInvite(
        executor,
        accountId,
        {
          uid: "series@google.com",
          event: canonicalEvent(),
          row: {
            rowId: "ce-ms",
            sourceId: "src-ms",
            provider: "microsoft",
            uid: "gev-occ-1",
            calendarId: "cal-1",
          },
        },
        "no",
        "series",
        { buildReply: buildIcsReply, fetchImpl: mock.fetch }
      )
      expect(outcome.writeBack).toEqual({ status: "applied" })
      expect(posted).toEqual(["decline"])
    } finally {
      executor.close()
    }
  })

  it("keeps the answer and the REPLY when Graph rejects the write-back", async () => {
    const executor = createTestExecutor()
    try {
      const accountId = await seedRespondingAccount(executor)
      const configJson = await encryptCredentials({
        refreshToken: "0.rt",
        accessToken: "0.at",
        accessTokenExpiresAt: Date.now() + 3_600_000,
        clientId: "client-1",
      })
      await createCalendarSource(executor, accountId, {
        id: "src-ms",
        provider: "microsoft",
        name: "me@outlook.com",
        configJson,
      })
      await executor.execute(
        `INSERT INTO calendar_events (id, source_id, calendar_id, uid, ical, start_at, end_at, all_day)
         VALUES ('ce-ms', 'src-ms', 'cal-1', 'gev-occ-1', '', 1789740000, 1789743600, 0)`
      )
      const mock = createFetchMock()
      mock.on("GET", "/me/events/gev-occ-1", () => ({
        json: { id: "gev-occ-1", type: "singleInstance" },
      }))
      mock.on("POST", "/me/events/gev-occ-1/tentativelyAccept", () => ({
        status: 500,
        json: { error: { code: "InternalServerError", message: "boom" } },
      }))

      const outcome = await respondToInvite(
        executor,
        accountId,
        {
          uid: "x@google.com",
          event: canonicalEvent(),
          row: {
            rowId: "ce-ms",
            sourceId: "src-ms",
            provider: "microsoft",
            uid: "gev-occ-1",
            calendarId: "cal-1",
          },
        },
        "maybe",
        "series",
        { buildReply: buildIcsReply, fetchImpl: mock.fetch }
      )
      // The write-back failed — the ANSWER is still stamped and the
      // REPLY still queued (the spec's failure contract).
      expect(outcome.writeBack).toMatchObject({ status: "failed" })
      expect(outcome.reply).toMatchObject({ status: "queued" })
      const stamped = await executor.select<{ partstat: string | null }>(
        "SELECT partstat FROM calendar_events WHERE id = 'ce-ms'"
      )
      expect(stamped[0]?.partstat).toBe("TENTATIVE")
      expect(await queuedReplyAttachment(executor)).not.toBeNull()
    } finally {
      executor.close()
    }
  })
})

describe("google family (attendees PATCH)", () => {
  it("patches this user's responseStatus and queues the REPLY", async () => {
    const executor = createTestExecutor()
    try {
      const accountId = await seedRespondingAccount(executor)
      const configJson = await encryptCredentials({
        refreshToken: "rt-1",
        accessToken: "at-1",
        accessTokenExpiresAt: Date.now() + 3_600_000,
        clientId: "client-1",
      })
      await createCalendarSource(executor, accountId, {
        id: "src-google",
        provider: "google",
        name: "me@gmail.com",
        configJson,
      })
      // The cached Google event id matches the invite's iCal UID bare
      // form (the 9kq3@… ↔ 9kq3 twin match).
      await executor.execute(
        `INSERT INTO calendar_events (id, source_id, calendar_id, uid, ical, start_at, end_at, all_day)
         VALUES ('ce-g', 'src-google', 'cal-main', '9kq3lmiqg9v1s0h3t6q8g9v1s0', '', 1789740000, 1789743600, 0)`
      )
      const mock = createFetchMock()
      mock.on("GET", "/calendars/cal-main/events/9kq3lmiqg9v1s0h3t6q8g9v1s0", () => ({
        json: googleEvent({
          id: "9kq3lmiqg9v1s0h3t6q8g9v1s0",
          summary: "Quarterly sync",
          attendees: [
            { email: "bob@attendee.example", responseStatus: "needsAction" },
            { email: "alice@organizer.example", responseStatus: "accepted" },
          ],
        }),
      }))
      let patched: {
        attendees?: { email: string; responseStatus: string }[]
      } | null = null
      mock.on(
        "PATCH",
        "/calendars/cal-main/events/9kq3lmiqg9v1s0h3t6q8g9v1s0",
        (call) => {
          patched = JSON.parse(call.body ?? "{}") as {
            attendees: { email: string; responseStatus: string }[]
          }
          return {
            json: googleEvent({
              id: "9kq3lmiqg9v1s0h3t6q8g9v1s0",
              attendees: patched?.attendees,
            }),
          }
        }
      )

      const outcome = await respondToInvite(
        executor,
        accountId,
        {
          uid: "9kq3lmiqg9v1s0h3t6q8g9v1s0@google.com",
          event: canonicalEvent(),
          row: {
            rowId: "ce-g",
            sourceId: "src-google",
            provider: "google",
            uid: "9kq3lmiqg9v1s0h3t6q8g9v1s0",
            calendarId: "cal-main",
          },
        },
        "yes",
        "series",
        { buildReply: buildIcsReply, fetchImpl: mock.fetch }
      )
      expect(outcome).toMatchObject({
        ok: true,
        writeBack: { status: "applied" },
        reply: { status: "queued" },
      })
      // Read through an explicit annotation: the assignment happens in
      // the fetch-mock callback, so the control-flow type here is null.
      const patchedAttendees = (
        patched as unknown as {
          attendees?: { email: string; responseStatus: string }[]
        }
      ).attendees
      const bob = patchedAttendees?.find(
        (attendee) => attendee.email === "bob@attendee.example"
      )
      expect(bob).toMatchObject({ responseStatus: "accepted" })
      const queued = await queuedReplyAttachment(executor)
      expect(queued?.attachment).toContain("METHOD:REPLY")
    } finally {
      executor.close()
    }
  })

  it("keeps the answer when Google has no matching event yet", async () => {
    const executor = createTestExecutor()
    try {
      const accountId = await seedRespondingAccount(executor)
      const configJson = await encryptCredentials({
        refreshToken: "rt-1",
        accessToken: "at-1",
        accessTokenExpiresAt: Date.now() + 3_600_000,
        clientId: "client-1",
      })
      await createCalendarSource(executor, accountId, {
        id: "src-google",
        provider: "google",
        name: "me@gmail.com",
        configJson,
      })
      const outcome = await respondToInvite(
        executor,
        accountId,
        {
          uid: "unknown@google.com",
          event: canonicalEvent(),
          row: {
            rowId: "ce-ghost",
            sourceId: "src-google",
            provider: "google",
            uid: "unknown",
            calendarId: "cal-main",
          },
        },
        "no",
        "series",
        { buildReply: buildIcsReply, fetchImpl: createFetchMock().fetch }
      )
      expect(outcome.writeBack).toMatchObject({ status: "failed" })
      expect(outcome.reply).toMatchObject({ status: "queued" })
    } finally {
      executor.close()
    }
  })
})

describe("caldav family (PUT of the attendee PARTSTAT)", () => {
  async function seedCaldav(executor: TestExecutor): Promise<string> {
    const accountId = await seedRespondingAccount(executor)
    const configJson = await encryptCredentials({
      serverUrl: "https://dav.example.com/",
      username: "secret-user",
      appPassword: "app-pass-99",
      calendarPaths: ["/cal/home/"],
    })
    await createCalendarSource(executor, accountId, {
      id: "src-caldav",
      provider: "caldav",
      name: "secret-user",
      configJson,
    })
    return accountId
  }

  const STORED_BLOB = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//emailer//Calendar 1.0//EN",
    "BEGIN:VEVENT",
    "UID:9kq3lmiqg9v1s0h3t6q8g9v1s0@google.com",
    "SEQUENCE:1",
    "DTSTART:20260918T140000Z",
    "DTEND:20260918T150000Z",
    "SUMMARY:Quarterly sync",
    "ORGANIZER;CN=Alice Organizer:mailto:alice@organizer.example",
    "ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=Bob Attendee:mailto:bob@attendee.example",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n")

  function caldavTarget(): RsvpTarget {
    return {
      uid: "9kq3lmiqg9v1s0h3t6q8g9v1s0@google.com",
      event: canonicalEvent(),
      row: {
        rowId: "ce-c",
        sourceId: "src-caldav",
        provider: "caldav",
        uid: "9kq3lmiqg9v1s0h3t6q8g9v1s0@google.com",
        calendarId: "/cal/home/",
      },
    }
  }

  it("PUTs the updated PARTSTAT to the event resource and queues the REPLY", async () => {
    const executor = createTestExecutor()
    try {
      const accountId = await seedCaldav(executor)
      await executor.execute(
        `INSERT INTO calendar_events (id, source_id, calendar_id, uid, ical, start_at, end_at, all_day)
         VALUES ('ce-c', 'src-caldav', '/cal/home/', '9kq3lmiqg9v1s0h3t6q8g9v1s0@google.com', $1, 1789740000, 1789743600, 0)`,
        [STORED_BLOB]
      )
      const puts: { path: string; ical: string }[] = []
      invokeMock.mockImplementation(((command: string, args?: unknown) => {
        if (command === "caldav_put_event") {
          const payload = args as { resourcePath: string; ical: string }
          puts.push({ path: payload.resourcePath, ical: payload.ical })
          return Promise.resolve(null)
        }
        return Promise.reject(new Error(`unexpected command ${command}`))
      }) as typeof invoke)

      const outcome = await respondToInvite(
        executor,
        accountId,
        caldavTarget(),
        "yes",
        "series",
        { buildReply: buildIcsReply }
      )
      expect(outcome).toMatchObject({
        ok: true,
        writeBack: { status: "applied" },
        reply: { status: "queued" },
      })
      expect(puts).toHaveLength(1)
      expect(puts[0].path).toBe(
        "/cal/home/9kq3lmiqg9v1s0h3t6q8g9v1s0%40google.com.ics"
      )
      // The stored ORGANIZER survives; only THIS attendee's PARTSTAT moved.
      expect(puts[0].ical).toContain(
        "ORGANIZER;CN=Alice Organizer:mailto:alice@organizer.example"
      )
      expect(puts[0].ical).toContain(
        "ATTENDEE;PARTSTAT=ACCEPTED;CN=Bob Attendee:mailto:bob@attendee.example"
      )
      expect(puts[0].ical).not.toContain("RECURRENCE-ID")
    } finally {
      executor.close()
    }
  })

  it("passes RECURRENCE-ID through the PUT for an occurrence-scoped answer", async () => {
    const executor = createTestExecutor()
    try {
      const accountId = await seedCaldav(executor)
      await executor.execute(
        `INSERT INTO calendar_events (id, source_id, calendar_id, uid, ical, start_at, end_at, all_day, recurrence_id)
         VALUES ('ce-c', 'src-caldav', '/cal/home/', '9kq3lmiqg9v1s0h3t6q8g9v1s0@google.com', $1, 1789740000, 1789743600, 0, '20260911T140000Z')`,
        [STORED_BLOB]
      )
      const puts: { ical: string }[] = []
      invokeMock.mockImplementation(((command: string, args?: unknown) => {
        if (command === "caldav_put_event") {
          const payload = args as { ical: string }
          puts.push({ ical: payload.ical })
          return Promise.resolve(null)
        }
        return Promise.reject(new Error(`unexpected command ${command}`))
      }) as typeof invoke)

      const target = caldavTarget()
      target.event = {
        ...target.event,
        recurrenceId: {
          raw: "20260911T140000Z",
          kind: "date-time",
          allDay: false,
          utc: true,
          tzid: null,
          date: new Date(1_789_135_200_000),
        },
      }
      const outcome = await respondToInvite(
        executor,
        accountId,
        target,
        "no",
        "occurrence",
        { buildReply: buildIcsReply }
      )
      expect(outcome.writeBack).toEqual({ status: "applied" })
      expect(puts[0].ical).toContain("RECURRENCE-ID:20260911T140000Z")
      expect(puts[0].ical).toContain("PARTSTAT=DECLINED")
      // The occurrence scope rides the REPLY too.
      const queued = await queuedReplyAttachment(executor)
      expect(queued?.attachment).toContain("RECURRENCE-ID:20260911T140000Z")
    } finally {
      executor.close()
    }
  })
})

describe("writeBackCaldavAttendee (blob rebuild)", () => {
  it("appends a missing attendee and never duplicates RECURRENCE-ID", async () => {
    const blob = await writeBackCaldavAttendee(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "BEGIN:VEVENT",
        "UID:x@example.com",
        "RECURRENCE-ID:20260911T140000Z",
        "ORGANIZER:mailto:o@example.com",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
      "new@example.com",
      "TENTATIVE",
      { recurrenceId: "20260911T140000Z" }
    )
    expect(blob).toContain(
      "ATTENDEE;PARTSTAT=TENTATIVE:mailto:new@example.com"
    )
    expect(blob.match(/RECURRENCE-ID/g)).toHaveLength(1)
  })
})

describe("no calendar connected", () => {
  it("skips the write-back and still queues the REPLY (reply-by-email)", async () => {
    const executor = createTestExecutor()
    try {
      const accountId = await seedRespondingAccount(executor)
      const outcome = await respondToInvite(
        executor,
        accountId,
        { uid: "solo@google.com", event: canonicalEvent(), row: null },
        "yes",
        "series",
        { buildReply: buildIcsReply }
      )
      expect(outcome).toMatchObject({
        ok: true,
        writeBack: { status: "skipped" },
        reply: { status: "queued" },
      })
    } finally {
      executor.close()
    }
  })
})

describe("REPLY mail fixture comparison (Rust-built ics parity)", () => {
  it("queues an attachment byte-identical to the Rust canonical REPLY", async () => {
    const executor = createTestExecutor()
    try {
      const accountId = await seedRespondingAccount(executor)
      // No row: the write-back is skipped and cannot interfere — the
      // assertion below is purely about the queued mail.
      await respondToInvite(
        executor,
        accountId,
        { uid: "9kq3lmiqg9v1s0h3t6q8g9v1s0@google.com", event: canonicalEvent(), row: null },
        "yes",
        "series",
        { buildReply: buildIcsReply }
      )
      const queued = await queuedReplyAttachment(executor)
      // THE fixture comparison: the queued REPLY attachment is the
      // Rust-built canonical blob, byte for byte.
      expect(queued?.attachment).toBe(CANONICAL_REPLY_FIXTURE)
      expect(queued?.subject).toBe("Accepted: Quarterly sync")
    } finally {
      executor.close()
    }
  })

  it("builds the mail input with the organizer as the sole recipient", () => {
    const input = buildReplyMailInput({
      accountEmail: "bob@attendee.example",
      accountName: "Bob Attendee",
      organizer: canonicalEvent().organizer,
      summary: "Quarterly sync",
      answer: "no",
      replyIcs: CANONICAL_REPLY_FIXTURE,
      fallbackSubject: "Meeting invitation",
    })
    expect(input?.to).toEqual([
      { name: "Alice Organizer", email: "alice@organizer.example" },
    ])
    expect(input?.subject).toBe("Declined: Quarterly sync")
    expect(input?.attachments?.[0]?.filename).toBe("invite.ics")
    expect(input?.attachments?.[0]?.mimeType).toContain("text/calendar")
  })

  it("answers null when the invite carries no organizer address", () => {
    expect(
      buildReplyMailInput({
        accountEmail: "bob@attendee.example",
        organizer: null,
        summary: null,
        answer: "yes",
        replyIcs: CANONICAL_REPLY_FIXTURE,
        fallbackSubject: "Meeting invitation",
      })
    ).toBeNull()
  })
})
