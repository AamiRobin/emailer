import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

/**
 * Event-extraction review-dialog tests (task 3.2, add-ai-surfaces spec
 * "Event extraction to calendar"). The extraction service and the
 * calendar event form are BOTH mocked at their module seams: the
 * assertions target the frozen UI contract — suggestions render with
 * time/location/source lines, an accept opens the (single) EventDialog
 * with a create request carrying the prefill (and nothing else — the
 * accept itself must not write), an empty result without a warning is
 * the empty state, a warning renders inline with a working Retry, and
 * provider errors render inline with Retry.
 *
 * (No jest-dom: assertions read values/textContent.)
 */

const extractEventsMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/ai/event-extraction", () => ({
  extractEvents: extractEventsMock,
}))

/** The props contract the tests read off the (mocked) event form. */
interface EventDialogPropsStub {
  open: boolean
  request: unknown
  onOpenChange: (next: boolean) => void
}

const eventDialogMock = vi.hoisted(() =>
  vi.fn((_props: EventDialogPropsStub) => null)
)

vi.mock("@/components/calendar/event-dialog", () => ({
  EventDialog: eventDialogMock,
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
  placeholders: (count: number, firstIndex = 1): string =>
    Array.from({ length: count }, (_, index) => `$${index + firstIndex}`).join(
      ", "
    ),
}))

import { EventExtractionDialog } from "../event-extraction-dialog"
import type { EventSuggestion } from "@/services/ai/event-extraction"

declare const process: { env: Record<string, string | undefined> }
process.env.TZ = "UTC"

const THREAD_ID = "thread-1"

function suggestion(overrides: Partial<EventSuggestion>): EventSuggestion {
  return {
    title: "Untitled event",
    startAt: Date.UTC(2026, 2, 17, 14, 0) / 1000,
    allDay: false,
    messageId: `msg-${Math.random()}`,
    messageDate: 1_700_000_000,
    messageFrom: "Alice <alice@example.com>",
    ...overrides,
  }
}

function renderDialog() {
  return render(
    <EventExtractionDialog
      threadId={THREAD_ID}
      open
      onOpenChange={vi.fn()}
    />
  )
}

/** The props the (mocked) event form most recently rendered with. */
function lastEventDialogProps(): {
  open: boolean
  request: unknown
} {
  const last = eventDialogMock.mock.calls.at(-1)
  if (!last) throw new Error("EventDialog was never rendered")
  return last[0] as { open: boolean; request: unknown }
}

beforeEach(() => {
  executorHolder.current = { marker: "test-executor" }
  // resetAllMocks (below) strips implementations — restore the form
  // mock's render and the executor every test.
  eventDialogMock.mockImplementation(() => null)
})

afterEach(() => {
  cleanup()
  executorHolder.current = null
  // reset (not clear): a test failing mid-way must not leak queued
  // once-implementations into the next test's mock resolution order.
  vi.resetAllMocks()
})

const twoSuggestions: EventSuggestion[] = [
  suggestion({
    title: "Design review",
    endAt: Date.UTC(2026, 2, 17, 15, 30) / 1000,
    location: "Room 4",
    notes: "Bring the spec",
    messageId: "msg-1",
  }),
  suggestion({
    title: "Project kickoff",
    startAt: Date.UTC(2026, 2, 18, 0, 0) / 1000,
    allDay: true,
    messageId: "msg-2",
    messageFrom: "Bob <bob@example.com>",
  }),
]

describe("EventExtractionDialog review list", () => {
  it("renders suggestions with time, location and source lines", async () => {
    extractEventsMock.mockResolvedValue({ suggestions: twoSuggestions })
    renderDialog()

    expect(await screen.findByText("Design review")).toBeTruthy()
    expect(screen.getByText("Project kickoff")).toBeTruthy()
    expect(screen.getByTestId("event-suggestion-time-0").textContent).toBe(
      "Mar 17, 2026, 14:00–15:30"
    )
    expect(screen.getByTestId("event-suggestion-time-1").textContent).toBe(
      "All day · Mar 18, 2026"
    )
    expect(screen.getByTestId("event-suggestion-location-0").textContent).toBe(
      " · Room 4"
    )
    expect(screen.getByTestId("event-suggestion-source-0").textContent).toBe(
      "From Alice <alice@example.com> · Nov 14, 2023"
    )
    // The extraction ran against the shared executor for this thread.
    expect(extractEventsMock).toHaveBeenCalledWith(
      executorHolder.current,
      THREAD_ID
    )
  })

  it("shows the busy state while the extraction is in flight", async () => {
    extractEventsMock.mockReturnValue(new Promise(() => {}))
    renderDialog()

    expect(screen.getByTestId("event-extraction-busy")).toBeTruthy()
  })

  it("renders an empty result without a warning as the no-events state", async () => {
    extractEventsMock.mockResolvedValue({ suggestions: [] })
    renderDialog()

    const empty = await screen.findByTestId("event-extraction-empty")
    expect(empty.textContent).toBe(
      "No events were found in this conversation."
    )
    expect(screen.queryByTestId("event-extraction-warning")).toBeNull()
  })

  it("renders a parse warning inline and Retry re-runs the extraction", async () => {
    extractEventsMock.mockResolvedValue({
      suggestions: [],
      warning: "The model's reply could not be read as event suggestions.",
    })
    renderDialog()

    const warning = await screen.findByTestId("event-extraction-warning")
    expect(warning.textContent).toContain(
      "could not be read as event suggestions"
    )
    expect(screen.getByTestId("event-extraction-empty")).toBeTruthy()
    expect(extractEventsMock).toHaveBeenCalledTimes(1)

    extractEventsMock.mockResolvedValueOnce({ suggestions: twoSuggestions })
    fireEvent.click(screen.getByTestId("event-extraction-retry"))

    expect(await screen.findByText("Design review")).toBeTruthy()
    expect(extractEventsMock).toHaveBeenCalledTimes(2)
  })

  it("renders provider errors inline with a working Retry", async () => {
    extractEventsMock.mockRejectedValueOnce(new Error("provider unreachable"))
    renderDialog()

    const error = await screen.findByTestId("event-extraction-error")
    expect(error.textContent).toContain("provider unreachable")

    extractEventsMock.mockResolvedValueOnce({ suggestions: twoSuggestions })
    fireEvent.click(screen.getByTestId("event-extraction-retry"))

    expect(await screen.findByText("Design review")).toBeTruthy()
  })
})

describe("EventExtractionDialog accept path", () => {
  it("opens the event form prefilled from a timed suggestion", async () => {
    extractEventsMock.mockResolvedValue({ suggestions: twoSuggestions })
    renderDialog()
    await screen.findByText("Design review")

    fireEvent.click(screen.getByLabelText('Review "Design review" in calendar'))

    const props = lastEventDialogProps()
    expect(props.open).toBe(true)
    expect(props.request).toEqual({
      mode: "create",
      start: new Date(Date.UTC(2026, 2, 17, 14, 0)),
      end: new Date(Date.UTC(2026, 2, 17, 15, 30)),
      prefill: {
        title: "Design review",
        location: "Room 4",
        description: "Bring the spec",
      },
    })
  })

  it("maps an all-day suggestion to an inclusive same-day end and replaces the form request on a second accept", async () => {
    extractEventsMock.mockResolvedValue({ suggestions: twoSuggestions })
    renderDialog()
    await screen.findByText("Project kickoff")

    fireEvent.click(
      screen.getByLabelText('Review "Project kickoff" in calendar')
    )

    // The all-day request: the INCLUSIVE last day is the start day itself
    // (the service exports no end for all-day), allDay in the prefill.
    expect(lastEventDialogProps().request).toEqual({
      mode: "create",
      start: new Date(Date.UTC(2026, 2, 18, 0, 0)),
      end: new Date(Date.UTC(2026, 2, 18, 0, 0)),
      prefill: {
        title: "Project kickoff",
        allDay: true,
      },
    })

    // Accepting the other suggestion re-targets the SAME single form —
    // the request is replaced, not stacked.
    fireEvent.click(screen.getByLabelText('Review "Design review" in calendar'))
    const request = lastEventDialogProps().request as {
      prefill: { title: string }
    }
    expect(request.prefill.title).toBe("Design review")
  })

  it("closes the event form through its onOpenChange without touching the review list", async () => {
    extractEventsMock.mockResolvedValue({ suggestions: twoSuggestions })
    renderDialog()
    await screen.findByText("Design review")

    fireEvent.click(screen.getByLabelText('Review "Design review" in calendar'))
    expect(lastEventDialogProps().open).toBe(true)

    // The dialog hands its own onOpenChange to the form; a false closes
    // the form only — the review list stays (a fresh accept re-opens).
    const formProps = eventDialogMock.mock.calls.at(-1)?.[0] as {
      onOpenChange: (next: boolean) => void
    }
    act(() => formProps.onOpenChange(false))
    expect(lastEventDialogProps().open).toBe(false)
    expect(screen.getByText("Design review")).toBeTruthy()
  })
})
