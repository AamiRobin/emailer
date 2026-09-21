import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

/**
 * EventDialog tests (task 5.4). The write service is mocked at its module
 * seam (the real provider paths are covered by event-writes.test.ts); the
 * dialog's contract pinned here:
 *
 * - create from slot times: the date/time fields pre-fill from the
   * double-clicked [start, end) and Save hands the exact local-seconds to
   * createEvent with the picked destination;
 * - edit prefill: the stored row's fields pre-fill; an untouched guests
 *   field is OMITTED from the patch (provider attendees survive);
 * - OFFLINE / provider failure: the inline banner shows the typed
 *   failure, the form state is preserved and the dialog stays open (the
 *   spec's "does not silently keep an unsaved edit");
 * - delete: edit mode offers Delete through the same service.
 *
 * (No jest-dom: assertions read values/textContent.)
 */

const createEventMock = vi.hoisted(() => vi.fn())
const updateEventMock = vi.hoisted(() => vi.fn())
const deleteEventMock = vi.hoisted(() => vi.fn())
const listWritableEventCalendarsMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/calendar/event-writes", () => ({
  createEvent: createEventMock,
  updateEvent: updateEventMock,
  deleteEvent: deleteEventMock,
  listWritableEventCalendars: listWritableEventCalendarsMock,
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

import { EventDialog } from "../event-dialog"
import type { EventDialogRequest } from "../event-dialog"
import { setCalendarViewExecutor } from "../use-calendar-view"
import type { SqlExecutor } from "@/services/db/executor"

declare const process: { env: Record<string, string | undefined> }
process.env.TZ = "UTC"

const GOOGLE_DESTINATION = {
  sourceId: "src-1",
  sourceName: "Work",
  provider: "google" as const,
  calendarId: "cal-1",
}

function inputOf(testId: string): HTMLInputElement {
  return screen.getByTestId(testId) as HTMLInputElement
}

function renderDialog(request: EventDialogRequest, onSaved = vi.fn()) {
  const onOpenChange = vi.fn()
  render(
    <EventDialog
      open
      onOpenChange={onOpenChange}
      request={request}
      onSaved={onSaved}
    />
  )
  return { onOpenChange, onSaved }
}

beforeEach(() => {
  // The dialog reads its executor through the view's seam; the write
  // service is mocked, so any non-throwing executor works.
  setCalendarViewExecutor({} as unknown as SqlExecutor)
  listWritableEventCalendarsMock.mockResolvedValue([GOOGLE_DESTINATION])
  createEventMock.mockResolvedValue({
    ok: true,
    event: { uid: "ev-1" },
  })
  updateEventMock.mockResolvedValue({ ok: true, event: { uid: "ev-1" } })
  deleteEventMock.mockResolvedValue({ ok: true })
})

afterEach(() => {
  cleanup()
  setCalendarViewExecutor(null)
  vi.clearAllMocks()
})

describe("EventDialog create", () => {
  it("pre-fills the slot times and saves to the picked destination", async () => {
    const start = new Date(2026, 2, 17, 9, 0)
    const end = new Date(2026, 2, 17, 10, 0)
    const { onOpenChange, onSaved } = renderDialog({
      mode: "create",
      start,
      end,
    })

    await screen.findByTestId("event-dialog-destination")
    expect(inputOf("event-dialog-title").value).toBe("")
    expect(inputOf("event-dialog-date").value).toBe("2026-03-17")
    expect(inputOf("event-dialog-start-time").value).toBe("09:00")
    expect(inputOf("event-dialog-end-time").value).toBe("10:00")

    fireEvent.change(inputOf("event-dialog-title"), {
      target: { value: "Design review" },
    })
    fireEvent.click(screen.getByTestId("event-dialog-save"))

    await waitFor(() => expect(createEventMock).toHaveBeenCalledTimes(1))
    const [executor, input] = createEventMock.mock.calls[0] as [
      unknown,
      Record<string, unknown>,
    ]
    expect(executor).toEqual({})
    expect(input).toMatchObject({
      sourceId: "src-1",
      calendarId: "cal-1",
      title: "Design review",
      startAt: Math.floor(start.getTime() / 1000),
      endAt: Math.floor(end.getTime() / 1000),
      allDay: false,
    })
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(onSaved).toHaveBeenCalledTimes(1)
  })

  it("maps an all-day single-day slot to UTC midnights with an exclusive end", async () => {
    const start = new Date(2026, 2, 17, 9, 0)
    renderDialog({ mode: "create", start, end: new Date(2026, 2, 17, 10, 0) })
    await screen.findByTestId("event-dialog-destination")

    fireEvent.change(inputOf("event-dialog-title"), {
      target: { value: "Offsite" },
    })
    fireEvent.click(screen.getByTestId("event-dialog-all-day"))
    fireEvent.click(screen.getByTestId("event-dialog-save"))

    await waitFor(() => expect(createEventMock).toHaveBeenCalledTimes(1))
    const input = createEventMock.mock.calls[0][1] as Record<string, unknown>
    expect(input.allDay).toBe(true)
    expect(input.startAt).toBe(Date.parse("2026-03-17T00:00:00Z") / 1000)
    expect(input.endAt).toBe(Date.parse("2026-03-18T00:00:00Z") / 1000)
  })
})

describe("EventDialog edit", () => {
  const EDIT_EVENT = {
    id: "ce-src-1:cal-1:ev-9",
    sourceId: "src-1",
    calendarId: "cal-1",
    uid: "ev-9",
    summary: "Design review",
    location: "Room 2",
    description: null,
    startAt: new Date(2026, 2, 17, 9, 0).getTime() / 1000,
    endAt: new Date(2026, 2, 17, 10, 30).getTime() / 1000,
    allDay: false,
    recurrence: null,
    status: "confirmed",
  }

  it("pre-fills from the stored row and patches without touching guests", async () => {
    renderDialog({ mode: "edit", event: EDIT_EVENT })
    // Edit mode has no destination picker — wait on the form itself.
    await screen.findByTestId("event-dialog-title")

    expect(inputOf("event-dialog-title").value).toBe("Design review")
    expect(inputOf("event-dialog-date").value).toBe("2026-03-17")
    expect(inputOf("event-dialog-start-time").value).toBe("09:00")
    expect(inputOf("event-dialog-end-time").value).toBe("10:30")
    expect(inputOf("event-dialog-location").value).toBe("Room 2")

    fireEvent.click(screen.getByTestId("event-dialog-save"))
    await waitFor(() => expect(updateEventMock).toHaveBeenCalledTimes(1))
    const [, event, patch] = updateEventMock.mock.calls[0] as [
      unknown,
      unknown,
      Record<string, unknown>,
    ]
    expect(event).toEqual(EDIT_EVENT)
    expect(patch.title).toBe("Design review")
    expect(patch.startAt).toBe(EDIT_EVENT.startAt)
    expect(patch.location).toBe("Room 2")
    expect(patch.guests).toBeUndefined()
    expect(patch.reminderMinutes).toBeUndefined()
  })

  it("offers Delete and routes it through the write service", async () => {
    const { onOpenChange, onSaved } = renderDialog({
      mode: "edit",
      event: EDIT_EVENT,
    })
    await screen.findByTestId("event-dialog-delete")

    fireEvent.click(screen.getByTestId("event-dialog-delete"))
    await waitFor(() => expect(deleteEventMock).toHaveBeenCalledTimes(1))
    expect(deleteEventMock.mock.calls[0][1]).toEqual(EDIT_EVENT)
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(onSaved).toHaveBeenCalledTimes(1)
  })
})

describe("EventDialog failure paths (online-write surfacing)", () => {
  it("shows the offline failure inline, preserves the form and stays open", async () => {
    createEventMock.mockResolvedValue({
      ok: false,
      reason: "offline",
      message:
        "You're offline — the change could not be saved to the server. Reconnect and try again.",
    })
    const { onOpenChange } = renderDialog({
      mode: "create",
      start: new Date(2026, 2, 17, 9, 0),
      end: new Date(2026, 2, 17, 10, 0),
    })
    await screen.findByTestId("event-dialog-destination")

    fireEvent.change(inputOf("event-dialog-title"), {
      target: { value: "Unsaved yet" },
    })
    fireEvent.click(screen.getByTestId("event-dialog-save"))

    const banner = await screen.findByTestId("event-dialog-error")
    expect(banner.textContent).toContain("offline")
    // The form state survived (no silent unsaved edit — and no fake loss).
    expect(inputOf("event-dialog-title").value).toBe("Unsaved yet")
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(createEventMock).toHaveBeenCalledTimes(1)
  })

  it("surfaces a provider failure on delete and keeps the dialog open", async () => {
    deleteEventMock.mockResolvedValue({
      ok: false,
      reason: "failed",
      message: "the CalDAV server returned HTTP 503",
    })
    const { onOpenChange } = renderDialog({
      mode: "edit",
      event: {
        id: "ce-s:c:e",
        sourceId: "src-1",
        calendarId: "cal-1",
        uid: "e",
        summary: "T",
        location: null,
        description: null,
        startAt: 0,
        endAt: 60,
        allDay: false,
        recurrence: null,
        status: null,
      },
    })
    await screen.findByTestId("event-dialog-delete")

    fireEvent.click(screen.getByTestId("event-dialog-delete"))
    const banner = await screen.findByTestId("event-dialog-error")
    expect(banner.textContent).toContain("HTTP 503")
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("shows the connect-a-calendar note and disables Save without destinations", async () => {
    listWritableEventCalendarsMock.mockResolvedValue([])
    renderDialog({
      mode: "create",
      start: new Date(2026, 2, 17, 9, 0),
      end: new Date(2026, 2, 17, 10, 0),
    })
    await screen.findByTestId("event-dialog-no-destinations")
    expect(
      (screen.getByTestId("event-dialog-save") as HTMLButtonElement).disabled
    ).toBe(true)
  })
})
