import { useCallback, useEffect, useState } from "react"
import { CalendarPlus } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { getExecutor } from "@/services/db/executor"
import {
  describeIcsEventTime,
  describeIcsPerson,
  isInvitationRequest,
  parseIcsCalendar,
  resolveIcsEventEnd,
  type IcsCalendar,
  type IcsEvent,
} from "@/services/calendar/ics"
import {
  addIcsEventToCalendar,
  listIcsCalendarSources,
  respondToInvitation,
  type CalendarSourceChoice,
  type InvitationResponse,
} from "@/services/calendar/ics-seam"

/**
 * The "Add to calendar" preview dialog (task 5.5 + 5.4, design D5;
 * calendar spec "iCalendar attachments"). Opened from an .ics /
 * text/calendar attachment row in the reading pane's attachment list, it
 * parses the attachment text with the pure parser (services/calendar/
 * ics.ts) and ALWAYS shows the parsed event details — summary, when,
 * where, description, organizer (the spec scenario's first half).
 *
 * METHOD:REQUEST invitations additionally show the Yes/No/Maybe row; a
 * response goes through the respondToInvitation seam.
 *
 * The WRITE half is real since task 5.4 (see services/calendar/
 * ics-seam.ts): confirming Add maps the parsed details onto the event
 * write service and adds it to the chosen source's default calendar —
 * respecting the online-write contract ("offline" means nothing was
 * written, surfaced below); RSVP answers are sent where the source
 * supports them (Google) and refused with the CalDAV limitation copy
 * otherwise. "no-source" keeps/raises the "Connect a calendar" note;
 * "unavailable" (degraded write layer) toasts the informational v1
 * message; provider failures surface their message inline. Parsing
 * failures (the parser never throws) render inline with a Retry
 * affordance; content-fetch failures render the same way.
 */

/** Informational v1 copy (frozen contract — see the seam module docs). */
const ADD_UNAVAILABLE_TOAST =
  "Adding to a calendar arrives with calendar setup — the event details are shown here already."
const RSVP_UNAVAILABLE_TOAST =
  "Invitation responses arrive with calendar setup — the event details are shown here already."
const NO_SOURCES_NOTE =
  "Connect a calendar in Settings (coming with calendar setup)."
const ADD_OFFLINE_NOTE =
  "You're offline — the event was not added to a calendar. Reconnect and try again."
const RSVP_OFFLINE_NOTE =
  "You're offline — the response was not sent. Reconnect and try again."

/** Map a seam failure to its inline status line (task 5.4 reasons). */
function failureStatus(
  message: string | undefined,
  fallback: string
): string {
  if (message) return message
  return fallback
}

interface ParsedIcs {
  ics: string
  calendar: IcsCalendar
  warnings: string[]
}

export interface IcsPreviewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Loads the raw .ics text (usually readIcsAttachmentText over the
   * exact attachment row; message-level flows can use
   * readFirstCalendarIcs). Called on every open and on Retry.
   */
  loadIcs: () => Promise<string>
}

type Phase = "loading" | "ready" | "error"

export function IcsPreviewDialog({
  open,
  onOpenChange,
  loadIcs,
}: IcsPreviewDialogProps) {
  const [phase, setPhase] = useState<Phase>("loading")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [parsed, setParsed] = useState<ParsedIcs | null>(null)
  /** null = the source list is still loading; [] = none connected. */
  const [sources, setSources] = useState<CalendarSourceChoice[] | null>(null)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [eventIndex, setEventIndex] = useState(0)
  const [busy, setBusy] = useState<null | "add" | "rsvp">(null)
  const [status, setStatus] = useState<string | null>(null)
  const [rsvpSent, setRsvpSent] = useState<InvitationResponse | null>(null)
  const [added, setAdded] = useState(false)

  const run = useCallback(() => {
    setPhase("loading")
    setErrorMessage(null)
    setParsed(null)
    setSources(null)
    setSourceId(null)
    setEventIndex(0)
    setStatus(null)
    setRsvpSent(null)
    setAdded(false)
    setBusy(null)
    void (async () => {
      let text: string
      try {
        text = await loadIcs()
      } catch (error) {
        console.warn("[ics-preview] attachment content failed", error)
        setErrorMessage("Could not load the calendar attachment.")
        setPhase("error")
        return
      }
      const result = parseIcsCalendar(text)
      if (!result.ok) {
        setErrorMessage(result.message)
        setPhase("error")
        return
      }
      setParsed({
        ics: text,
        calendar: result.calendar,
        warnings: result.warnings,
      })
      setPhase("ready")
      try {
        const executor = getExecutor()
        const choices = await listIcsCalendarSources(executor)
        setSources(choices)
        setSourceId(choices[0]?.id ?? null)
      } catch (error) {
        // No db / outside Tauri — degrade to "no calendar connected".
        console.warn("[ics-preview] calendar source lookup failed", error)
        setSources([])
      }
    })()
  }, [loadIcs])

  useEffect(() => {
    if (open) {
      // Sanctioned set-state-in-effect escape (task-extraction-dialog
      // precedent): fresh load on every open, no stale-review flash.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      run()
    }
  }, [open, run])

  const event = parsed?.calendar.events[eventIndex] ?? parsed?.calendar.events[0] ?? null
  const invitation = parsed !== null && isInvitationRequest(parsed.calendar)

  async function handleAdd(): Promise<void> {
    if (!parsed || !sourceId || busy) return
    setBusy("add")
    setStatus(null)
    try {
      const result = await addIcsEventToCalendar(getExecutor(), {
        ics: parsed.ics,
        preferredSourceId: sourceId,
      })
      if (result.ok) {
        setAdded(true)
        setStatus("Added to the calendar.")
        toast.success("Event added to your calendar")
      } else if (result.reason === "no-source") {
        setStatus(NO_SOURCES_NOTE)
        toast.info(NO_SOURCES_NOTE)
      } else if (result.reason === "offline") {
        setStatus(ADD_OFFLINE_NOTE)
        toast.info(ADD_OFFLINE_NOTE)
      } else if (result.reason === "unavailable") {
        setStatus(ADD_UNAVAILABLE_TOAST)
        toast.info(ADD_UNAVAILABLE_TOAST)
      } else {
        // invalid / no-event / config / unsupported / failed: the seam's
        // message is the honest line (CalDAV RSVP-style limitations,
        // provider rejections); a generic fallback keeps it readable.
        const note = failureStatus(
          result.message,
          "Adding to the calendar failed. Try again."
        )
        setStatus(note)
        toast.info(note)
      }
    } catch (error) {
      console.warn("[ics-preview] add-to-calendar failed", error)
      setStatus("Adding to the calendar failed. Try again.")
    } finally {
      setBusy(null)
    }
  }

  async function handleRespond(response: InvitationResponse): Promise<void> {
    if (!parsed || busy || rsvpSent) return
    setBusy("rsvp")
    setStatus(null)
    try {
      const result = await respondToInvitation(getExecutor(), {
        ics: parsed.ics,
        response,
      })
      if (result.ok) {
        setRsvpSent(response)
        setStatus("Response sent.")
        toast.success("Your response was sent")
      } else if (result.reason === "no-source") {
        setStatus(NO_SOURCES_NOTE)
        toast.info(NO_SOURCES_NOTE)
      } else if (result.reason === "offline") {
        setStatus(RSVP_OFFLINE_NOTE)
        toast.info(RSVP_OFFLINE_NOTE)
      } else if (result.reason === "unavailable") {
        setStatus(RSVP_UNAVAILABLE_TOAST)
        toast.info(RSVP_UNAVAILABLE_TOAST)
      } else {
        const note = failureStatus(
          result.message,
          "Sending the response failed. Try again."
        )
        setStatus(note)
        toast.info(note)
      }
    } catch (error) {
      console.warn("[ics-preview] invitation response failed", error)
      setStatus("Sending the response failed. Try again.")
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="ics-preview-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {event?.summary ?? "Calendar event"}
          </DialogTitle>
          <DialogDescription>
            {invitation
              ? "This message carries a calendar invitation."
              : "Event details from the calendar attachment."}
          </DialogDescription>
        </DialogHeader>
        {phase === "loading" && (
          <div
            data-testid="ics-preview-loading"
            className="py-6 text-center text-sm text-muted-foreground"
          >
            Reading the calendar attachment…
          </div>
        )}
        {phase === "error" && (
          <div
            data-testid="ics-preview-error"
            className="flex flex-col items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm"
          >
            <span className="text-destructive">
              {errorMessage ?? "This file could not be read as an iCalendar file."}
            </span>
            <Button
              variant="outline"
              size="sm"
              data-testid="ics-preview-retry"
              onClick={run}
            >
              Retry
            </Button>
          </div>
        )}
        {phase === "ready" && parsed !== null && (
          <>
            {parsed.calendar.events.length > 1 && (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                Event
                <select
                  data-testid="ics-event-picker"
                  className="h-8 w-full flex-1 rounded-lg border border-input bg-transparent px-2 text-sm"
                  value={eventIndex}
                  onChange={(change) => setEventIndex(Number(change.target.value))}
                >
                  {parsed.calendar.events.map((item, index) => (
                    <option key={index} value={index}>
                      {item.summary ?? `Event ${index + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <EventDetails event={event} />
            {parsed.warnings.length > 0 && (
              <div
                data-testid="ics-preview-warnings"
                className="rounded-lg border border-border bg-muted/30 p-2 text-xs text-muted-foreground"
              >
                {parsed.warnings[0]}
              </div>
            )}
            {invitation && (
              <InvitationRow
                busy={busy === "rsvp"}
                sent={rsvpSent}
                onRespond={(response) => void handleRespond(response)}
              />
            )}
            <SourcePicker
              sources={sources}
              sourceId={sourceId}
              onSelect={setSourceId}
            />
            {status !== null && (
              <p
                data-testid="ics-add-status"
                role="status"
                className="text-xs text-muted-foreground"
              >
                {status}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              <Button
                data-testid="ics-add"
                className="gap-1"
                disabled={
                  busy !== null || added || !sourceId || event === null
                }
                onClick={() => void handleAdd()}
              >
                <CalendarPlus className="size-3.5" />
                {added ? "Added" : busy === "add" ? "Adding…" : "Add to calendar"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** The parsed details grid (the spec scenario's first half). */
function EventDetails({ event }: { event: IcsEvent | null }) {
  if (!event) {
    return (
      <p className="text-sm text-muted-foreground">
        No event was found in this calendar file.
      </p>
    )
  }
  const when = describeIcsEventTime(event.start, resolveIcsEventEnd(event))
  const organizer = describeIcsPerson(event.organizer)
  return (
    <dl className="grid gap-1.5 text-sm">
      {when !== null && (
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-xs text-muted-foreground">When</dt>
          <dd data-testid="ics-preview-when" className="min-w-0 flex-1">
            {when}
          </dd>
        </div>
      )}
      {event.location !== null && (
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-xs text-muted-foreground">Where</dt>
          <dd data-testid="ics-preview-where" className="min-w-0 flex-1">
            {event.location}
          </dd>
        </div>
      )}
      {organizer !== null && (
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-xs text-muted-foreground">
            Organizer
          </dt>
          <dd data-testid="ics-preview-organizer" className="min-w-0 flex-1">
            {organizer}
          </dd>
        </div>
      )}
      {event.description !== null && (
        <div className="flex gap-2">
          <dt className="w-20 shrink-0 text-xs text-muted-foreground">Notes</dt>
          <dd
            data-testid="ics-preview-description"
            className="min-w-0 flex-1 whitespace-pre-wrap break-words"
          >
            {event.description}
          </dd>
        </div>
      )}
    </dl>
  )
}

/** The Yes/No/Maybe row for METHOD:REQUEST invitations. */
function InvitationRow({
  busy,
  sent,
  onRespond,
}: {
  busy: boolean
  sent: InvitationResponse | null
  onRespond: (response: InvitationResponse) => void
}) {
  return (
    <div
      data-testid="ics-rsvp-row"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/30 p-2.5"
    >
      <span className="text-xs font-medium text-muted-foreground">
        Are you going?
      </span>
      <div className="ml-auto flex gap-1.5">
        {(
          [
            ["yes", "Yes"],
            ["maybe", "Maybe"],
            ["no", "No"],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            variant={sent === value ? "default" : "outline"}
            size="sm"
            className="h-7"
            data-testid={`ics-rsvp-${value}`}
            disabled={busy || sent !== null}
            onClick={() => onRespond(value)}
          >
            {label}
          </Button>
        ))}
      </div>
    </div>
  )
}

/**
 * The destination picker over the lazy calendar-sources read. Empty (or
 * still unloaded) shows the connect-a-calendar note — the parsed details
 * above remain visible regardless (v1 contract: details first, write
 * path lands with task 5.4). A native select keeps the picker robust in
 * tests; it upgrades to the settings Select when the calendar settings
 * UI lands.
 */
function SourcePicker({
  sources,
  sourceId,
  onSelect,
}: {
  sources: CalendarSourceChoice[] | null
  sourceId: string | null
  onSelect: (id: string) => void
}) {
  if (sources === null) {
    return (
      <p data-testid="ics-sources-loading" className="text-xs text-muted-foreground">
        Looking for your calendars…
      </p>
    )
  }
  if (sources.length === 0) {
    return (
      <p
        data-testid="ics-no-sources"
        className="rounded-lg border border-border bg-muted/30 p-2 text-xs text-muted-foreground"
      >
        {NO_SOURCES_NOTE}
      </p>
    )
  }
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      Add to
      <select
        data-testid="ics-source-picker"
        className="h-8 w-full flex-1 rounded-lg border border-input bg-transparent px-2 text-sm"
        value={sourceId ?? ""}
        onChange={(change) => onSelect(change.target.value)}
      >
        {sources.map((source) => (
          <option key={source.id} value={source.id}>
            {source.name}
          </option>
        ))}
      </select>
    </label>
  )
}
