import { useCallback, useEffect, useState } from "react"
import {
  format,
  fromUnixTime,
  isSameDay,
  startOfDay,
} from "date-fns"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

import { EventDialog, type EventDialogRequest } from "@/components/calendar/event-dialog"
import { getExecutor } from "@/services/db/executor"
import {
  extractEvents,
  type EventSuggestion,
} from "@/services/ai/event-extraction"

/**
 * The event-extraction review dialog (task 3.2, add-ai-surfaces spec
 * "Event extraction to calendar"). Opened from the reading-pane toolbar's
 * "Suggest events" button (thread-view.tsx, rendered only when AI is
 * configured and the eventExtraction surface is enabled), it runs the
 * extraction (services/ai/event-extraction.ts, cached per design D2) and
 * presents the suggestions FOR REVIEW: title, formatted time (or "All
 * day"), location, and the source line (sender + date — the event's
 * back-link).
 *
 * Nothing is created until the user confirms the event form: a
 * suggestion's "Review in calendar" accept OPENS the calendar event form
 * prefilled (event-dialog create mode with `prefill`, task 3.1) — the
 * accept itself writes nothing anywhere, and the form's own save is the
 * only write path (the spec's review-before-creation requirement). The
 * review dialog stays open underneath so further suggestions can be
 * reviewed; the single EventDialog instance is re-targeted when a second
 * suggestion is accepted.
 *
 * Failure handling mirrors task-extraction-dialog.tsx: provider errors
 * render inline with a Retry affordance; a parse warning renders inline
 * (with its own Retry) above the (possibly empty) list; an empty result
 * WITHOUT a warning is the legitimate "no events in this conversation"
 * outcome, not an error. The dialog notes that suggestions are
 * AI-generated (spec: indicate AI-generated content).
 */

interface EventExtractionDialogProps {
  threadId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** The review line for one suggestion: "Mar 17, 2026, 14:00–15:30" for a
 * timed event (end omitted → start only), "All day · <date(s)>" for an
 * all-day one. */
function suggestionTimeLine(suggestion: EventSuggestion): string {
  const start = fromUnixTime(suggestion.startAt)
  if (suggestion.allDay) {
    // The service exports no end for an all-day suggestion — single-day
    // by construction.
    return `All day · ${format(start, "MMM d, yyyy")}`
  }
  if (suggestion.endAt === undefined) {
    return format(start, "MMM d, yyyy, HH:mm")
  }
  const end = fromUnixTime(suggestion.endAt)
  if (isSameDay(start, end)) {
    return `${format(start, "MMM d, yyyy, HH:mm")}–${format(end, "HH:mm")}`
  }
  return `${format(start, "MMM d, yyyy, HH:mm")} – ${format(end, "MMM d, yyyy, HH:mm")}`
}

/**
 * Map a suggestion onto the event dialog's create request (task 3.1's
 * prefill contract): start from the unix-second start; the end is the
 * stated end, start + 1h when the message stated none — or, for an
 * all-day suggestion, the INCLUSIVE last day, which is the start day
 * itself (the service exports no end for all-day, and event-dialog
 * treats `end` as the last covered day in that mode).
 */
function requestForSuggestion(suggestion: EventSuggestion): EventDialogRequest {
  const start = new Date(suggestion.startAt * 1000)
  const end = suggestion.allDay
    ? startOfDay(start)
    : suggestion.endAt !== undefined
      ? new Date(suggestion.endAt * 1000)
      : new Date(start.getTime() + 60 * 60 * 1000)
  return {
    mode: "create",
    start,
    end,
    prefill: {
      title: suggestion.title,
      ...(suggestion.location !== undefined
        ? { location: suggestion.location }
        : {}),
      ...(suggestion.notes !== undefined
        ? { description: suggestion.notes }
        : {}),
      ...(suggestion.allDay ? { allDay: true } : {}),
    },
  }
}

export function EventExtractionDialog({
  threadId,
  open,
  onOpenChange,
}: EventExtractionDialogProps) {
  const [phase, setPhase] = useState<"extracting" | "ready" | "error">(
    "extracting"
  )
  const [suggestions, setSuggestions] = useState<EventSuggestion[]>([])
  const [warning, setWarning] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  /** The event form's current create request; null while no suggestion
   * has been accepted (the form itself renders nothing then). */
  const [eventRequest, setEventRequest] = useState<EventDialogRequest | null>(
    null
  )

  const runExtraction = useCallback(() => {
    setPhase("extracting")
    setErrorMessage(null)
    setWarning(null)
    setSuggestions([])
    setEventRequest(null)
    try {
      extractEvents(getExecutor(), threadId)
        .then((result) => {
          setSuggestions(result.suggestions)
          setWarning(result.warning ?? null)
          setPhase("ready")
        })
        .catch((error: unknown) => {
          setErrorMessage(
            error instanceof Error ? error.message : "Event extraction failed."
          )
          setPhase("error")
        })
    } catch {
      // No executor (plain vite / early startup) — same inline-error path.
      setErrorMessage("Event extraction is unavailable right now.")
      setPhase("error")
    }
  }, [threadId])

  // Fresh extraction on every open; Retry re-runs the same callback. The
  // synchronous reset is intentional — a deferred run would flash the
  // previous review state while the new extraction starts — so this uses
  // the same sanctioned set-state-in-effect escape hatch as
  // task-extraction-dialog.tsx.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      runExtraction()
    }
  }, [open, runExtraction])

  /** Accept one suggestion: open the prefilled event form (a replace of
   * any earlier request — one EventDialog instance at a time). The accept
   * itself never writes; the form's save is the only write path. */
  const reviewInCalendar = useCallback((suggestion: EventSuggestion) => {
    setEventRequest(requestForSuggestion(suggestion))
  }, [])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="event-extraction-dialog"
        className="sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>Suggested events</DialogTitle>
          <DialogDescription>
            AI-generated suggestions from this conversation — review each one
            in the calendar event form. Nothing is saved until you confirm it
            there.
          </DialogDescription>
        </DialogHeader>
        {phase === "extracting" && (
          <div
            data-testid="event-extraction-busy"
            className="py-6 text-center text-sm text-muted-foreground"
          >
            Reviewing the conversation for events…
          </div>
        )}
        {phase === "error" && (
          <div
            data-testid="event-extraction-error"
            className="flex flex-col items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
          >
            <span className="text-destructive">
              {errorMessage ?? "Event extraction failed."}
            </span>
            <Button
              variant="outline"
              size="sm"
              data-testid="event-extraction-retry"
              onClick={runExtraction}
            >
              Retry
            </Button>
          </div>
        )}
        {phase === "ready" && (
          <>
            {warning !== null && (
              <div
                data-testid="event-extraction-warning"
                className="flex flex-col items-start gap-2 rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground"
              >
                <span>{warning}</span>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="event-extraction-retry"
                  onClick={runExtraction}
                >
                  Retry
                </Button>
              </div>
            )}
            {suggestions.length === 0 ? (
              <div
                data-testid="event-extraction-empty"
                className="py-6 text-center text-sm text-muted-foreground"
              >
                No events were found in this conversation.
              </div>
            ) : (
              <div className="flex max-h-80 flex-col gap-2 overflow-y-auto pr-1">
                {suggestions.map((item, index) => (
                  <SuggestionRow
                    key={`${item.messageId}:${index}`}
                    suggestion={item}
                    index={index}
                    onAccept={() => reviewInCalendar(item)}
                  />
                ))}
              </div>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                aria-label="Close event suggestions"
              >
                Close
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
      {/* The prefilled event form (task 3.1's create-mode prefill),
          mounted alongside the review list so the dialog stays open
          underneath it — accepting another suggestion re-targets this one
          instance. Renders nothing while no request is set; its save is
          the only path that writes to a calendar. */}
      <EventDialog
        open={eventRequest !== null}
        onOpenChange={(next) => {
          if (!next) setEventRequest(null)
        }}
        request={eventRequest}
      />
    </Dialog>
  )
}

/** One review row: suggestion summary (title, time, location), source
 * line, "Review in calendar". */
function SuggestionRow({
  suggestion,
  index,
  onAccept,
}: {
  suggestion: EventSuggestion
  index: number
  onAccept: () => void
}) {
  return (
    <div
      data-testid={`event-suggestion-${index}`}
      className="flex items-start gap-2.5 rounded-lg border border-border p-2.5"
    >
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium leading-snug">{suggestion.title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          <span data-testid={`event-suggestion-time-${index}`}>
            {suggestionTimeLine(suggestion)}
          </span>
          {suggestion.location !== undefined && (
            <span data-testid={`event-suggestion-location-${index}`}>
              {" "}
              · {suggestion.location}
            </span>
          )}
        </p>
        {suggestion.notes !== undefined && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {suggestion.notes}
          </p>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          <span data-testid={`event-suggestion-source-${index}`}>
            From {suggestion.messageFrom} ·{" "}
            {format(fromUnixTime(suggestion.messageDate), "MMM d, yyyy")}
          </span>
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0"
        data-testid={`event-suggestion-review-${index}`}
        aria-label={`Review "${suggestion.title}" in calendar`}
        onClick={onAccept}
      >
        Review in calendar
      </Button>
    </div>
  )
}
