import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// getAttachmentContent is the D15 seam — stub it at the module seam (the
// attachments service has its own suite), the ics-detect.test.ts posture.
const getAttachmentContentMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/attachments", () => ({
  getAttachmentContent: getAttachmentContentMock,
}))

import { createAccount, createMessage, createThread } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import type { EmailAccount } from "../../email/types"
import type { MessageRow } from "../../db/messages"
import { addCalendarSource } from "../sources"
import {
  applyCancellation,
  bareUidOf,
  detectInvite,
} from "../invites"
import { encryptCredentials } from "../../crypto/credentials"
import { setDefaultKeyStore } from "../../crypto/key-management"
import { createInMemoryKeyStore } from "../../crypto/__tests__/in-memory-key-store"

/**
 * Invite detection + linkage tests (parity-round-3 tasks 8.2/8.4, design
 * D5): text/calendar part classification (REQUEST/CANCEL), the
 * threads.invite_uid + v20 event-field persistence, Google bare-uid
 * matching, the per-source cancellation semantics, and the no-calendar
 * account case (detected, nothing linked — reply-by-email).
 */

function inviteIcal(overrides: {
  uid?: string
  method?: string
  sequence?: number
  summary?: string
  location?: string
  description?: string
  recurrenceId?: string
  selfPartstat?: string
} = {}): string {
  const {
    uid = "invite-9@example.com",
    method = "REQUEST",
    sequence = 1,
    summary = "Quarterly sync",
    location = "Room 4",
    description = "Join: https://zoom.us/j/1234567890",
    recurrenceId = null,
    selfPartstat = "NEEDS-ACTION",
  } = overrides
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    ...(recurrenceId ? [`RECURRENCE-ID:${recurrenceId}`] : []),
    `SEQUENCE:${sequence}`,
    `SUMMARY:${summary}`,
    `LOCATION:${location}`,
    `DESCRIPTION:${description}`,
    "DTSTART:20260918T140000Z",
    "DTEND:20260918T150000Z",
    "ORGANIZER;CN=Alice Organizer:mailto:alice@organizer.example",
    `ATTENDEE;PARTSTAT=${selfPartstat};CN=Me:mailto:me@example.com`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n")
}

async function seedMessageWithCalendarPart(
  executor: TestExecutor,
  accountId: string,
  icsText: string | null
): Promise<{ threadId: string; messageId: string }> {
  const threadId = await createThread(executor, accountId, {
    subject: "Quarterly sync",
  })
  const messageId = await createMessage(executor, {
    threadId,
    accountId,
    date: 1_786_000_000,
    subject: "Invitation: Quarterly sync",
    fromAddress: "alice@organizer.example",
    attachments: icsText
      ? [{ id: "att-1", mimeType: "text/calendar", filename: "invite.ics" }]
      : [],
  })
  getAttachmentContentMock.mockResolvedValue(
    new TextEncoder().encode(icsText ?? "")
  )
  return { threadId, messageId }
}

function accountRow(id: string): EmailAccount {
  return {
    id,
    type: "gmail",
    email: "me@example.com",
    status: "active",
    isActive: true,
    isPinned: false,
  }
}

function messageRow(messageId: string, threadId: string): MessageRow {
  return {
    id: messageId,
    thread_id: threadId,
  } as MessageRow
}

beforeEach(() => {
  getAttachmentContentMock.mockReset()
  setDefaultKeyStore(createInMemoryKeyStore())
})

describe("detectInvite — REQUEST", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor)
  })

  afterEach(() => {
    executor.close()
    setDefaultKeyStore(null)
  })

  it("detects the invitation, persists the thread linkage and stamps the matched event", async () => {
    // A linked calendar source + a cached event row carrying the SAME
    // uid (no sequence yet — the invite's newer revision stamps it).
    await addCalendarSource(executor, {
      id: "src-google",
      accountId,
      provider: "google",
      name: "me@gmail.com",
      configJson: await encryptCredentials({ refreshToken: "rt" }),
    })
    await executor.execute(
      `INSERT INTO calendar_events (id, source_id, calendar_id, uid, ical, summary, start_at, end_at, all_day)
       VALUES ('ce-1', 'src-google', 'primary', 'invite-9@example.com', '', 'Quarterly sync', 1789740000, 1789743600, 0)`
    )

    const { threadId, messageId } = await seedMessageWithCalendarPart(
      executor,
      accountId,
      inviteIcal({})
    )
    const detected = await detectInvite(
      executor,
      accountRow(accountId),
      messageRow(messageId, threadId)
    )

    expect(detected.ok).toBe(true)
    if (!detected.ok) return
    expect(detected.kind).toBe("request")
    expect(detected.event.uid).toBe("invite-9@example.com")
    expect(detected.event.sequence).toBe(1)
    expect(detected.selfAttendee?.email).toBe("me@example.com")
    expect(detected.joinLink).toMatchObject({ label: "Zoom" })
    expect(detected.linkedEvent).toMatchObject({
      rowId: "ce-1",
      sourceId: "src-google",
      provider: "google",
    })
    // No answer recorded anywhere yet.
    expect(detected.currentPartstat).toBe("NEEDS-ACTION")

    // Linkage: the thread carries the invite uid; the event row was
    // stamped with the invite's sequence.
    const threads = await executor.select<{ invite_uid: string | null }>(
      "SELECT invite_uid FROM threads WHERE id = $1",
      [threadId]
    )
    expect(threads[0]?.invite_uid).toBe("invite-9@example.com")
    const rows = await executor.select<{
      sequence: number | null
      partstat: string | null
      recurrence_id: string | null
    }>("SELECT sequence, partstat, recurrence_id FROM calendar_events WHERE id = 'ce-1'")
    expect(rows[0]).toMatchObject({ sequence: 1, partstat: "NEEDS-ACTION" })
  })

  it("matches Google's bare-uid form (iCal UID abc@google.com ↔ event abc)", async () => {
    await addCalendarSource(executor, {
      id: "src-google",
      accountId,
      provider: "google",
      name: "me@gmail.com",
      configJson: await encryptCredentials({ refreshToken: "rt" }),
    })
    await executor.execute(
      `INSERT INTO calendar_events (id, source_id, calendar_id, uid, ical, start_at, end_at, all_day)
       VALUES ('ce-1', 'src-google', 'primary', '9kq3', '', 1789740000, 1789743600, 0)`
    )
    const { threadId, messageId } = await seedMessageWithCalendarPart(
      executor,
      accountId,
      inviteIcal({ uid: "9kq3@google.com" })
    )
    const detected = await detectInvite(
      executor,
      accountRow(accountId),
      messageRow(messageId, threadId)
    )
    expect(detected.ok && detected.linkedEvent?.rowId === "ce-1").toBe(true)
  })

  it("prefers the account-linked source when several rows carry the uid", async () => {
    await addCalendarSource(executor, {
      id: "src-linked",
      accountId,
      provider: "google",
      name: "me@gmail.com",
      configJson: await encryptCredentials({ refreshToken: "rt" }),
    })
    await addCalendarSource(executor, {
      id: "src-other",
      accountId: null,
      provider: "caldav",
      name: "other",
      configJson: await encryptCredentials({
        serverUrl: "https://dav.example.com/",
        username: "u",
        appPassword: "p",
        calendarPaths: ["/cal/"],
      }),
    })
    for (const sourceId of ["src-linked", "src-other"]) {
      await executor.execute(
        `INSERT INTO calendar_events (id, source_id, calendar_id, uid, ical, start_at, end_at, all_day)
         VALUES ('ce-${sourceId}', '${sourceId}', 'c', 'invite-9@example.com', '', 1789740000, 1789743600, 0)`
      )
    }
    const { threadId, messageId } = await seedMessageWithCalendarPart(
      executor,
      accountId,
      inviteIcal({})
    )
    const detected = await detectInvite(
      executor,
      accountRow(accountId),
      messageRow(messageId, threadId)
    )
    expect(detected.ok && detected.linkedEvent?.sourceId).toBe("src-linked")
  })

  it("never overwrites a recorded answer with a re-read of the same invite", async () => {
    await addCalendarSource(executor, {
      id: "src-google",
      accountId,
      provider: "google",
      name: "me@gmail.com",
      configJson: await encryptCredentials({ refreshToken: "rt" }),
    })
    await executor.execute(
      `INSERT INTO calendar_events (id, source_id, calendar_id, uid, ical, start_at, end_at, all_day, partstat)
       VALUES ('ce-1', 'src-google', 'primary', 'invite-9@example.com', '', 1789740000, 1789743600, 0, 'ACCEPTED')`
    )
    const { threadId, messageId } = await seedMessageWithCalendarPart(
      executor,
      accountId,
      inviteIcal({ selfPartstat: "NEEDS-ACTION" })
    )
    const detected = await detectInvite(
      executor,
      accountRow(accountId),
      messageRow(messageId, threadId)
    )
    expect(detected.ok && detected.currentPartstat).toBe("ACCEPTED")
    const rows = await executor.select<{ partstat: string | null }>(
      "SELECT partstat FROM calendar_events WHERE id = 'ce-1'"
    )
    expect(rows[0]?.partstat).toBe("ACCEPTED")
  })

  it("keeps detection working without any calendar source (no-calendar account)", async () => {
    const { threadId, messageId } = await seedMessageWithCalendarPart(
      executor,
      accountId,
      inviteIcal({})
    )
    const detected = await detectInvite(
      executor,
      accountRow(accountId),
      messageRow(messageId, threadId)
    )
    expect(detected.ok).toBe(true)
    if (detected.ok) {
      expect(detected.linkedEvent).toBeNull()
      expect(detected.currentPartstat).toBe("NEEDS-ACTION")
    }
    // The thread linkage still persists (spec: invites for accounts
    // without a calendar still render the card).
    const threads = await executor.select<{ invite_uid: string | null }>(
      "SELECT invite_uid FROM threads WHERE id = $1",
      [threadId]
    )
    expect(threads[0]?.invite_uid).toBe("invite-9@example.com")
  })
})

describe("detectInvite — non-invites", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor)
  })

  afterEach(() => {
    executor.close()
    setDefaultKeyStore(null)
  })

  async function expectUntouched(icsText: string | null, reason: string) {
    const { threadId, messageId } = await seedMessageWithCalendarPart(
      executor,
      accountId,
      icsText
    )
    const detected = await detectInvite(
      executor,
      accountRow(accountId),
      messageRow(messageId, threadId)
    )
    expect(detected).toMatchObject({ ok: false, reason })
    const threads = await executor.select<{ invite_uid: string | null }>(
      "SELECT invite_uid FROM threads WHERE id = $1",
      [threadId]
    )
    // A non-invite message is untouched — no linkage ever persisted.
    expect(threads[0]?.invite_uid).toBeNull()
  }

  it("renders nothing for a message without a calendar part", async () => {
    await expectUntouched(null, "no-calendar-part")
  })

  it("renders nothing for an unparseable part", async () => {
    await expectUntouched("not a calendar at all", "unreadable")
  })

  it("renders nothing when no VEVENT carries a UID", async () => {
    await expectUntouched(
      [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "METHOD:REQUEST",
        "BEGIN:VEVENT",
        "SUMMARY:No uid",
        "END:VEVENT",
        "END:VCALENDAR",
        "",
      ].join("\r\n"),
      "no-event"
    )
  })

  it("renders nothing when the METHOD is missing", async () => {
    await expectUntouched(
      inviteIcal({ method: "" }).replace("METHOD:", "X-METHOD:"),
      "no-method"
    )
  })

  it("renders nothing for non-RSVP methods (PUBLISH)", async () => {
    await expectUntouched(
      inviteIcal({ method: "PUBLISH" }),
      "unsupported-method"
    )
  })
})

describe("applyCancellation — per-source semantics", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor)
  })

  afterEach(() => {
    executor.close()
    setDefaultKeyStore(null)
  })

  async function seedEvent(
    sourceId: string,
    provider: "google" | "caldav" | "microsoft",
    rowId: string
  ): Promise<void> {
    await addCalendarSource(executor, {
      id: sourceId,
      accountId,
      provider,
      name: provider,
      configJson: await encryptCredentials({ refreshToken: "rt" }),
    })
    await executor.execute(
      `INSERT INTO calendar_events (id, source_id, calendar_id, uid, ical, start_at, end_at, all_day, status)
       VALUES (${rowId}, '${sourceId}', 'c', 'invite-9@example.com', '', 1789740000, 1789743600, 0, 'confirmed')`
    )
  }

  it("REMOVES the cached Graph row (Graph cancels by deleting)", async () => {
    await seedEvent("src-ms", "microsoft", "'ce-ms'")
    const touched = await applyCancellation(
      executor,
      accountId,
      "invite-9@example.com"
    )
    expect(touched).toBe(1)
    const rows = await executor.select<{ id: string }>(
      "SELECT id FROM calendar_events"
    )
    expect(rows).toEqual([])
  })

  it("flips Google and CalDAV rows to status 'cancelled' (status semantics)", async () => {
    await seedEvent("src-google", "google", "'ce-g'")
    await seedEvent("src-caldav", "caldav", "'ce-c'")
    const touched = await applyCancellation(
      executor,
      accountId,
      "invite-9@example.com"
    )
    expect(touched).toBe(2)
    const rows = await executor.select<{ id: string; status: string | null }>(
      "SELECT id, status FROM calendar_events ORDER BY id"
    )
    expect(rows).toEqual([
      { id: "ce-c", status: "cancelled" },
      { id: "ce-g", status: "cancelled" },
    ])
  })

  it("answers 0 for an unknown uid", async () => {
    expect(
      await applyCancellation(executor, accountId, "unknown@example.com")
    ).toBe(0)
  })
})

describe("bareUidOf", () => {
  it("strips the Google iCal suffix and leaves other uids alone", () => {
    expect(bareUidOf("9kq3@google.com")).toBe("9kq3")
    expect(bareUidOf("plain@example.com")).toBe("plain")
    expect(bareUidOf("noat")).toBe("noat")
  })
})
