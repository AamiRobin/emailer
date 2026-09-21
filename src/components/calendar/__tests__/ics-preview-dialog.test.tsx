import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

/**
 * IcsPreviewDialog tests (task 5.5). The ics-seam write functions and
 * the source listing are mocked at their module seams (task 5.4 owns the
 * real bodies); the parser runs for real against a fixture .ics. The
 * assertions target the frozen UI contract:
 *
 * - parsed details render from the fixture (summary/when/where/
 *   organizer/description) — the spec scenario's first half;
 * - a METHOD:REQUEST invite shows the Yes/No/Maybe row, a plain publish
 *   does not;
 * - no connected sources shows the "Connect a calendar" note and the
 *   details remain visible;
 * - add/rsvp "unavailable" (the v1 seam contract) toasts the
 *   informational message and shows the inline status;
 * - parse/content failures render the typed error with Retry.
 *
 * (No jest-dom: text assertions read textContent.)
 */

const listIcsCalendarSourcesMock = vi.hoisted(() => vi.fn())
const addIcsEventToCalendarMock = vi.hoisted(() => vi.fn())
const respondToInvitationMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/calendar/ics-seam", () => ({
  listIcsCalendarSources: listIcsCalendarSourcesMock,
  addIcsEventToCalendar: addIcsEventToCalendarMock,
  respondToInvitation: respondToInvitationMock,
}))

const executorHolder = vi.hoisted(() => ({
  current: null as unknown,
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

import { IcsPreviewDialog } from "../ics-preview-dialog"

// The app tsconfig has no @types/node (vite/client only) — declare the
// slice of process this file sets for deterministic date formatting.
declare const process: { env: Record<string, string | undefined> }

process.env.TZ = "UTC"

const REQUEST_INVITE = [
  "BEGIN:VCALENDAR",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "VERSION:2.0",
  "METHOD:REQUEST",
  "BEGIN:VEVENT",
  "UID:abc123@google.com",
  "DTSTAMP:20260901T120000Z",
  "DTSTART:20260918T140000Z",
  "DTEND:20260918T150000Z",
  "SUMMARY:Roadmap sync",
  "LOCATION:https://meet.example.com/abc-def-ghi",
  "DESCRIPTION:Weekly sync to review the roadmap.",
  "ORGANIZER;CN=Alice Organizer:mailto:alice@example.com",
  "ATTENDEE;CN=Bob Attendee:mailto:bob@example.com",
  "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n")

const PUBLISH_NOTICE = REQUEST_INVITE.replace(
  "METHOD:REQUEST",
  "METHOD:PUBLISH"
)

/** textContent of an element by test id (no jest-dom in this repo). */
function textOf(testId: string): string {
  const element = screen.getByTestId(testId)
  return element.textContent ?? ""
}

function renderDialog(loadIcs: () => Promise<string>) {
  return render(
    <IcsPreviewDialog open onOpenChange={vi.fn()} loadIcs={loadIcs} />
  )
}

beforeEach(() => {
  executorHolder.current = { marker: "test-executor" }
  listIcsCalendarSourcesMock.mockResolvedValue([
    { id: "src-1", name: "Work" },
  ])
  addIcsEventToCalendarMock.mockResolvedValue({
    ok: false,
    reason: "unavailable",
  })
  respondToInvitationMock.mockResolvedValue({
    ok: false,
    reason: "unavailable",
  })
})

afterEach(() => {
  cleanup()
  executorHolder.current = null
  vi.clearAllMocks()
})

describe("IcsPreviewDialog parsed details", () => {
  it("renders the fixture's summary, when, where, organizer and notes", async () => {
    renderDialog(async () => REQUEST_INVITE)

    await screen.findByTestId("ics-preview-dialog")
    await screen.findByText("Roadmap sync")
    await screen.findByTestId("ics-preview-when")
    expect(textOf("ics-preview-when")).toContain(
      "Sep 18, 2026 2:00 PM – 3:00 PM"
    )
    expect(textOf("ics-preview-where")).toBe(
      "https://meet.example.com/abc-def-ghi"
    )
    expect(textOf("ics-preview-organizer")).toBe(
      "Alice Organizer <alice@example.com>"
    )
    expect(textOf("ics-preview-description")).toBe(
      "Weekly sync to review the roadmap."
    )
    // One connected source → the picker shows it, no connect note.
    screen.getByTestId("ics-source-picker")
    expect(screen.queryByTestId("ics-no-sources")).toBeNull()
    expect(
      (screen.getByTestId("ics-add") as HTMLButtonElement).disabled
    ).toBe(false)
  })

  it("offers the Add-to-calendar action through the seam with the chosen source", async () => {
    renderDialog(async () => REQUEST_INVITE)
    fireEvent.click(await screen.findByTestId("ics-add"))
    await waitFor(() => {
      expect(addIcsEventToCalendarMock).toHaveBeenCalledWith(
        { marker: "test-executor" },
        { ics: REQUEST_INVITE, preferredSourceId: "src-1" }
      )
    })
    // The v1 seam answered "unavailable" — informational toast + status.
    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledTimes(1)
    })
    await screen.findByTestId("ics-add-status")
    expect(textOf("ics-add-status")).toContain("arrives with calendar setup")
  })

  it("surfaces the seam's no-source answer when the source vanished", async () => {
    addIcsEventToCalendarMock.mockResolvedValue({
      ok: false,
      reason: "no-source",
    })
    renderDialog(async () => REQUEST_INVITE)
    fireEvent.click(await screen.findByTestId("ics-add"))
    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith(
        "Connect a calendar in Settings (coming with calendar setup)."
      )
    })
  })
})

describe("IcsPreviewDialog invitation (METHOD:REQUEST)", () => {
  it("shows the Yes/No/Maybe row for a REQUEST and routes the response", async () => {
    renderDialog(async () => REQUEST_INVITE)
    fireEvent.click(await screen.findByTestId("ics-rsvp-maybe"))
    await waitFor(() => {
      expect(respondToInvitationMock).toHaveBeenCalledWith(
        { marker: "test-executor" },
        { ics: REQUEST_INVITE, response: "maybe" }
      )
    })
    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledTimes(1)
    })
    await screen.findByTestId("ics-add-status")
    expect(textOf("ics-add-status")).toContain(
      "Invitation responses arrive with calendar setup"
    )
  })

  it("hides the response row for a non-REQUEST calendar file", async () => {
    renderDialog(async () => PUBLISH_NOTICE)
    await screen.findByTestId("ics-add")
    expect(screen.queryByTestId("ics-rsvp-row")).toBeNull()
  })
})

describe("IcsPreviewDialog failure and empty-source paths", () => {
  it("shows the connect-a-calendar note (details still visible) when no sources exist", async () => {
    listIcsCalendarSourcesMock.mockResolvedValue([])
    renderDialog(async () => REQUEST_INVITE)
    await screen.findByTestId("ics-no-sources")
    expect(textOf("ics-no-sources")).toContain(
      "Connect a calendar in Settings (coming with calendar setup)."
    )
    // The parsed details remain shown — the spec scenario's first half.
    await screen.findByText("Roadmap sync")
    // No source → Add is disabled rather than dead-ending at the seam.
    expect(
      (screen.getByTestId("ics-add") as HTMLButtonElement).disabled
    ).toBe(true)
  })

  it("renders the typed parse failure with Retry for non-iCalendar content", async () => {
    renderDialog(async () => "just some text, no calendar here")
    await screen.findByTestId("ics-preview-error")
    expect(textOf("ics-preview-error")).toContain(
      "does not look like an iCalendar"
    )
    expect(screen.queryByTestId("ics-add")).toBeNull()
  })

  it("renders the content-fetch failure with Retry", async () => {
    renderDialog(async () => {
      throw new Error("attachment fetch failed")
    })
    await screen.findByTestId("ics-preview-error")
    expect(textOf("ics-preview-error")).toContain(
      "Could not load the calendar attachment."
    )
    fireEvent.click(await screen.findByTestId("ics-preview-retry"))
    await screen.findByTestId("ics-preview-error")
  })

  it("renders a multi-event file with an event picker", async () => {
    const twoEvents = REQUEST_INVITE.replace(
      "END:VEVENT",
      [
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:second@google.com",
        "DTSTART:20260921T090000Z",
        "SUMMARY:Second event",
      ].join("\r\n")
    )
    renderDialog(async () => twoEvents)
    await screen.findByTestId("ics-event-picker")
    await screen.findByText("Second event")
  })
})
