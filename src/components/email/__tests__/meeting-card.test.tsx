import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

/**
 * MeetingInviteCard integration tests (parity-round-3 task 8.2, design
 * D5). Everything runs FOR REAL except the process boundaries: the db is
 * the real migrated schema in node:sqlite, the detection is the real
 * invites service, the RSVP is the real respondToInvite — only the D15
 * attachment seam (the calendar-part bytes), the executor binding, the
 * `ics_build_reply` command (answering the RUST-built canonical
 * fixture) and the toast are mocked.
 *
 * Pinned: an invite message renders the card and persists the linkage
 * (threads.invite_uid + the v20 event fields); a non-invite message
 * renders nothing and touches nothing; an account without a connected
 * calendar still renders the card and answers by email only (the queued
 * REPLY attachment is the canonical fixture, the write-back is skipped).
 */

const getAttachmentContentMock = vi.hoisted(() => vi.fn())
const invokeMock = vi.hoisted(() => vi.fn())
const executorHolder = vi.hoisted(() => ({
  current: null as unknown,
}))

vi.mock("@/services/attachments", () => ({
  getAttachmentContent: getAttachmentContentMock,
}))

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}))

vi.mock("@/services/db/executor", () => ({
  getExecutor: () => {
    const executor = executorHolder.current
    if (!executor) throw new Error("test executor not set")
    return executor
  },
}))

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

import { toast } from "sonner"

import { createTestExecutor, type TestExecutor } from "@/services/db/__tests__/test-executor"
import { createMessage, createThread } from "@/services/db/__tests__/fixtures"
import type { MessageRow } from "@/services/db/messages"
import { MeetingInviteCard } from "../meeting-card"
import { buildIcsReply } from "@/services/calendar/ics-reply"
import type { IcsReplyBuildRequest } from "@/services/calendar/ics-reply"
import type { EmailAccount } from "@/services/email/types"

/** The invitation fixture (same meeting across the scenarios). */
function inviteIcal(overrides: { method?: string; recurrenceId?: string } = {}): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `METHOD:${overrides.method ?? "REQUEST"}`,
    "BEGIN:VEVENT",
    "UID:card-1@example.com",
    ...(overrides.recurrenceId
      ? [`RECURRENCE-ID:${overrides.recurrenceId}`]
      : []),
    "SEQUENCE:1",
    "SUMMARY:Design review",
    "LOCATION:Room 4",
    "DESCRIPTION:Join: https://zoom.us/j/1234567890",
    "DTSTART:20260918T140000Z",
    "DTEND:20260918T150000Z",
    "ORGANIZER;CN=Alice Organizer:mailto:alice@organizer.example",
    "ATTENDEE;PARTSTAT=NEEDS-ACTION;CN=Me:mailto:me@example.com",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n")
}

/** The Rust `ics::build_reply` output for this meeting (the canonical
 * fixture — the ics-build-reply side pins the same bytes). */
const CANONICAL_REPLY = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//emailer//Calendar 1.0//EN",
  "METHOD:REPLY",
  "BEGIN:VEVENT",
  "UID:card-1@example.com",
  "SEQUENCE:1",
  "DTSTART:20260918T140000Z",
  "ORGANIZER;CN=Alice Organizer:mailto:alice@organizer.example",
  "ATTENDEE;CN=Me;PARTSTAT=ACCEPTED:mailto:me@example.com",
  "SUMMARY:Design review",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n")

function account(): EmailAccount {
  return {
    id: "acc-1",
    type: "gmail",
    email: "me@example.com",
    status: "active",
    isActive: true,
    isPinned: false,
  }
}

function rowFor(messageId: string, threadId: string): MessageRow {
  return { id: messageId, thread_id: threadId } as MessageRow
}

async function seedMessage(
  executor: TestExecutor,
  icsText: string | null
): Promise<{ threadId: string; messageId: string }> {
  const accountRows = await executor.select<{ id: string }>(
    "SELECT id FROM accounts WHERE id = 'acc-1'"
  )
  if (accountRows.length === 0) {
    await executor.execute(
      `INSERT INTO accounts (id, type, email, display_name, status)
       VALUES ('acc-1', 'gmail', 'me@example.com', 'Me', 'active')`
    )
  }
  const threadId = await createThread(executor, "acc-1", { subject: "Design review" })
  const messageId = await createMessage(executor, {
    threadId,
    accountId: "acc-1",
    date: 1_786_000_000,
    subject: "Invitation: Design review",
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

async function seedLinkedEvent(executor: TestExecutor): Promise<void> {
  await executor.execute(
    `INSERT INTO accounts (id, type, email, display_name, status)
     VALUES ('acc-1', 'gmail', 'me@example.com', 'Me', 'active')`
  )
  await executor.execute(
    `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
     VALUES ('src-google', 'acc-1', 'google', 'me@gmail.com', 'sealed')`
  )
  await executor.execute(
    `INSERT INTO calendar_events (id, source_id, calendar_id, uid, ical, summary, start_at, end_at, all_day)
     VALUES ('ce-1', 'src-google', 'primary', 'card-1@example.com', '', 'Design review', 1789740000, 1789743600, 0)`
  )
}

beforeEach(() => {
  getAttachmentContentMock.mockReset()
  invokeMock.mockReset()
  // The `ics_build_reply` command is the Rust grammar authority; the
  // mock answers with the TS twin (pinned byte-identical to the Rust
  // builder by ics-reply.test.ts + the Rust canonical-fixture test), so
  // the request's echoes (RECURRENCE-ID, PARTSTAT) are honored.
  invokeMock.mockImplementation((command: string, args?: unknown) => {
    if (command === "ics_build_reply") {
      const request = (args as { request: IcsReplyBuildRequest }).request
      return Promise.resolve(buildIcsReply(request))
    }
    return Promise.reject(new Error(`unexpected command ${command}`))
  })
  executorHolder.current = createTestExecutor()
})

afterEach(() => {
  cleanup()
  ;(executorHolder.current as TestExecutor).close()
  executorHolder.current = null
})

describe("MeetingInviteCard", () => {
  it("renders the invite as a card and persists the linkage", async () => {
    const executor = executorHolder.current as TestExecutor
    await seedLinkedEvent(executor)
    const { threadId, messageId } = await seedMessage(executor, inviteIcal())

    render(
      <MeetingInviteCard
        message={rowFor(messageId, threadId)}
        account={account()}
      />
    )

    // The card renders the meeting details + the three answers.
    const card = await screen.findByTestId("meeting-card")
    expect(card.getAttribute("data-invite-kind")).toBe("request")
    expect(screen.getByTestId("meeting-card-title").textContent).toBe(
      "Design review"
    )
    expect(screen.getByTestId("meeting-card-time")).not.toBeNull()
    expect(screen.getByTestId("meeting-card-organizer").textContent).toContain(
      "alice@organizer.example"
    )
    expect(screen.getByTestId("meeting-card-attendees").textContent).toContain(
      "me@example.com"
    )
    expect(screen.getByTestId("meeting-card-accept")).not.toBeNull()
    expect(screen.getByTestId("meeting-card-tentative")).not.toBeNull()
    expect(screen.getByTestId("meeting-card-decline")).not.toBeNull()
    // The join link (zoom) is surfaced for click-to-open.
    expect(screen.getByTestId("meeting-card-join").textContent).toContain(
      "Zoom"
    )

    // Linkage: the thread carries the invite uid; the matched event row
    // was stamped with the invite's SEQUENCE.
    await waitFor(async () => {
      const threads = await executor.select<{ invite_uid: string | null }>(
        "SELECT invite_uid FROM threads WHERE id = $1",
        [threadId]
      )
      expect(threads[0]?.invite_uid).toBe("card-1@example.com")
    })
    const events = await executor.select<{ sequence: number | null }>(
      "SELECT sequence FROM calendar_events WHERE id = 'ce-1'"
    )
    expect(events[0]?.sequence).toBe(1)
  })

  it("leaves a non-invite message untouched", async () => {
    const executor = executorHolder.current as TestExecutor
    const { threadId, messageId } = await seedMessage(executor, null)

    const { container } = render(
      <MeetingInviteCard
        message={rowFor(messageId, threadId)}
        account={account()}
      />
    )
    // No calendar part — the detection resolves to no-calendar-part and
    // the card never renders (the attachment seam is never even asked
    // for content: no matching row exists).
    await waitFor(() => {
      expect(getAttachmentContentMock).not.toHaveBeenCalled()
    })
    expect(container.querySelector('[data-testid="meeting-card"]')).toBeNull()
    const threads = await executor.select<{ invite_uid: string | null }>(
      "SELECT invite_uid FROM threads WHERE id = $1",
      [threadId]
    )
    expect(threads[0]?.invite_uid).toBeNull()
  })

  it("still renders for a no-calendar account and answers by email only", async () => {
    const executor = executorHolder.current as TestExecutor
    const { threadId, messageId } = await seedMessage(executor, inviteIcal())

    render(
      <MeetingInviteCard
        message={rowFor(messageId, threadId)}
        account={account()}
      />
    )
    await screen.findByTestId("meeting-card")
    // No linked event — the reply-by-email note shows.
    expect(
      screen.getByTestId("meeting-card-no-calendar").textContent
    ).toContain("No connected calendar")

    fireEvent.click(screen.getByTestId("meeting-card-accept"))
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalled()
    })

    // The REPLY went through the normal send pipeline: one queued send
    // op whose attachment is the Rust-built canonical fixture.
    const ops = await executor.select<{ op_type: string; payload_json: string }>(
      "SELECT op_type, payload_json FROM pending_operations WHERE op_type = 'send'"
    )
    expect(ops).toHaveLength(1)
    const payload = JSON.parse(ops[0].payload_json) as {
      input: {
        to: { email: string }[]
        subject: string
        attachments: { contentBase64: string }[]
      }
    }
    expect(payload.input.to[0]?.email).toBe("alice@organizer.example")
    expect(payload.input.subject).toBe("Accepted: Design review")
    const bytes = Uint8Array.from(
      atob(payload.input.attachments[0].contentBase64),
      (character) => character.charCodeAt(0)
    )
    expect(new TextDecoder().decode(bytes)).toBe(CANONICAL_REPLY)
    // The card flips to the answered state.
    await waitFor(() => {
      expect(screen.getByTestId("meeting-card-answer").textContent).toContain(
        "Accepted"
      )
    })
  })

  it("offers the occurrence-vs-series choice for recurring invites", async () => {
    const executor = executorHolder.current as TestExecutor
    const { threadId, messageId } = await seedMessage(
      executor,
      inviteIcal({ recurrenceId: "20260911T140000Z" })
    )

    render(
      <MeetingInviteCard
        message={rowFor(messageId, threadId)}
        account={account()}
      />
    )
    await screen.findByTestId("meeting-card")
    const scopeSeries = screen.getByTestId("meeting-card-scope-series")
    const scopeOccurrence = screen.getByTestId("meeting-card-scope-occurrence")
    // The series is the default.
    expect(scopeSeries.getAttribute("aria-pressed")).toBe("true")
    expect(scopeOccurrence.getAttribute("aria-pressed")).toBe("false")

    fireEvent.click(scopeOccurrence)
    expect(scopeOccurrence.getAttribute("aria-pressed")).toBe("true")

    fireEvent.click(screen.getByTestId("meeting-card-decline"))
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalled()
    })
    // The occurrence scope rode the REPLY (RECURRENCE-ID echoed).
    const ops = await executor.select<{ payload_json: string }>(
      "SELECT payload_json FROM pending_operations WHERE op_type = 'send'"
    )
    const payload = JSON.parse(ops[0].payload_json) as {
      input: { attachments: { contentBase64: string }[] }
    }
    const bytes = Uint8Array.from(
      atob(payload.input.attachments[0].contentBase64),
      (character) => character.charCodeAt(0)
    )
    expect(new TextDecoder().decode(bytes)).toContain(
      "RECURRENCE-ID:20260911T140000Z"
    )
    expect(threadId).not.toBeNull()
  })

  it("shows the cancelled state for METHOD:CANCEL invites", async () => {
    const executor = executorHolder.current as TestExecutor
    await seedLinkedEvent(executor)
    const { threadId, messageId } = await seedMessage(
      executor,
      inviteIcal({ method: "CANCEL" })
    )

    render(
      <MeetingInviteCard
        message={rowFor(messageId, threadId)}
        account={account()}
      />
    )
    const card = await screen.findByTestId("meeting-card")
    expect(card.getAttribute("data-invite-kind")).toBe("cancel")
    expect(screen.getByTestId("meeting-card-cancelled")).not.toBeNull()
    // No answer buttons on a cancelled meeting.
    expect(screen.queryByTestId("meeting-card-accept")).toBeNull()
    // The cancellation was applied to the linked row per source
    // semantics (google → status cancelled).
    await waitFor(async () => {
      const rows = await executor.select<{ status: string | null }>(
        "SELECT status FROM calendar_events WHERE id = 'ce-1'"
      )
      expect(rows[0]?.status).toBe("cancelled")
    })
  })
})
