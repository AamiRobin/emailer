import { useCallback, useEffect, useRef, useState } from "react"
import { format } from "date-fns"
import { CalendarPlus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import type { CalendarEvent } from "@/services/calendar/events"
import {
  createEvent,
  deleteEvent,
  listWritableEventCalendars,
  updateEvent,
} from "@/services/calendar/event-writes"
import type { EventWritePatch, WritableCalendar } from "@/services/calendar/event-writes"
import { getCalendarViewExecutor } from "./use-calendar-view"

/**
 * The event create/edit dialog (task 5.4, design D5; calendar spec
 * "Event creation and editing"). Create is opened from the calendar
 * view's double-clicked slot (pre-filled start/end); edit from the
 * details card (pre-filled from the stored row, with a Delete action).
 *
 * ONLINE-WRITE SURFACING (the spec's explicit-failure requirement): the
 * form never pretends — the write service refuses offline writes and any
 * provider failure, and this dialog renders the typed failure as an
 * inline banner while PRESERVING the form state, so it is clear the edit
 * was not saved and can be retried or copied out. Only a confirmed write
 * closes the dialog (the service caches the row after the server
 * confirmed; the view reloads its cache query).
 *
 * Field notes:
 * - All-day events round-trip in UTC (the cache stores UTC midnights);
 *   the end date shown is INCLUSIVE and converted to the exclusive end.
 * - Guests are comma-separated emails. The cached rows do not carry
 *   attendees, so EDIT omits the field from the write unless it changed
 *   (the provider value survives untouched; CalDAV edits additionally
 *   keep the stored blob's attendee list).
 * - The reminder field is Google-only (a single popup override);
 *   CalDAV destinations hide it with a note.
 */

export type EventDialogRequest =
  | { mode: "create"; start: Date; end: Date }
  | { mode: "edit"; event: CalendarEvent }

export interface EventDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** What the dialog edits; null while the view has nothing to show. */
  request: EventDialogRequest | null
  /** Called after a confirmed write so the view re-reads the cache. */
  onSaved?: () => void
}

interface FormState {
  title: string
  allDay: boolean
  startDate: string
  endDate: string // all-day INCLUSIVE end
  startTime: string
  endTime: string
  location: string
  description: string
  guests: string
  reminder: string
}

function pad(value: number): string {
  return String(value).padStart(2, "0")
}

/** "yyyy-MM-dd" of the UTC instant — the all-day (UTC-midnight) form. */
function utcDateString(seconds: number): string {
  const date = new Date(seconds * 1000)
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
}

/** "yyyy-MM-ddTHH:mm" → epoch seconds, LOCAL wall clock (timed events). */
function localSeconds(date: string, time: string): number | null {
  const [year, month, day] = date.split("-").map(Number)
  const [hour, minute] = time.split(":").map(Number)
  if (!year || !month || !day || Number.isNaN(hour) || Number.isNaN(minute)) {
    return null
  }
  return Math.floor(new Date(year, month - 1, day, hour, minute).getTime() / 1000)
}

/** "yyyy-MM-dd" → epoch seconds at UTC midnight (all-day events). */
function utcSeconds(date: string): number | null {
  const [year, month, day] = date.split("-").map(Number)
  if (!year || !month || !day) return null
  return Math.floor(Date.UTC(year, month - 1, day) / 1000)
}

function parseGuests(value: string): string[] {
  return value
    .split(",")
    .map((guest) => guest.trim())
    .filter((guest) => guest.length > 0)
}

function stateForRequest(request: EventDialogRequest): FormState {
  if (request.mode === "create") {
    return {
      title: "",
      allDay: false,
      startDate: format(request.start, "yyyy-MM-dd"),
      endDate: format(request.start, "yyyy-MM-dd"),
      startTime: format(request.start, "HH:mm"),
      endTime: format(request.end, "HH:mm"),
      location: "",
      description: "",
      guests: "",
      reminder: "",
    }
  }
  const event = request.event
  const start = event.allDay
    ? utcDateString(event.startAt)
    : format(new Date(event.startAt * 1000), "yyyy-MM-dd")
  // All-day ends are EXCLUSIVE in the cache — show the last covered day.
  const end = event.allDay
    ? utcDateString(Math.max(event.endAt - 86_400, event.startAt))
    : format(new Date(Math.max(event.endAt, event.startAt + 60) * 1000), "yyyy-MM-dd")
  return {
    title: event.summary ?? "",
    allDay: event.allDay,
    startDate: start,
    endDate: end,
    startTime: format(new Date(event.startAt * 1000), "HH:mm"),
    endTime: format(new Date(Math.max(event.endAt, event.startAt + 60) * 1000), "HH:mm"),
    location: event.location ?? "",
    description: event.description ?? "",
    guests: "",
    reminder: "",
  }
}

export function EventDialog({
  open,
  onOpenChange,
  request,
  onSaved,
}: EventDialogProps) {
  const [form, setForm] = useState<FormState | null>(null)
  const [destinations, setDestinations] = useState<WritableCalendar[] | null>(
    null
  )
  const [destinationKey, setDestinationKey] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | "save" | "delete">(null)
  /** Guests/reminder "unchanged" snapshots — omitted from edits unless the
   * user touched them (the cached rows carry neither field). */
  const initial = useRef<{ guests: string; reminder: string }>({
    guests: "",
    reminder: "",
  })

  const run = useCallback(() => {
    if (!request) return
    const state = stateForRequest(request)
    setForm(state)
    initial.current = { guests: state.guests, reminder: state.reminder }
    setDestinations(null)
    setDestinationKey(null)
    setError(null)
    setBusy(null)
    void (async () => {
      try {
        const found = await listWritableEventCalendars(
          getCalendarViewExecutor()
        )
        setDestinations(found)
        setDestinationKey(
          found[0] ? `${found[0].sourceId}::${found[0].calendarId}` : null
        )
      } catch (loadError) {
        // No DB outside Tauri — degrade to "nothing connected".
        console.warn("[event-dialog] calendar lookup failed", loadError)
        setDestinations([])
      }
    })()
  }, [request])

  useEffect(() => {
    if (open) {
      // Sanctioned set-state-in-effect escape (ics-preview-dialog
      // precedent): fresh form on every open, no stale-edit flash.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      run()
    }
  }, [open, run])

  // The destination's provider decides provider-only fields (reminder:
  // Google and Graph both carry a minutes-before-start reminder; CalDAV
  // has no mapping in v1).
  const provider =
    request?.mode === "edit"
      ? (destinations?.find(
          (destination) => destination.sourceId === request.event.sourceId
        )?.provider ?? null)
      : (destinations?.find(
          (destination) =>
            destinationKey ===
            `${destination.sourceId}::${destination.calendarId}`
        )?.provider ?? null)
  const supportsReminder =
    provider === "google" || provider === "microsoft"

  if (!request || !form) {
    return (
      <Dialog open={false} onOpenChange={onOpenChange}>
        <DialogContent data-testid="event-dialog" className="sm:max-w-md" />
      </Dialog>
    )
  }

  // Narrowed locals for the closures below (TS cannot keep the guard's
  // narrowing inside function declarations).
  const state = form
  const activeRequest = request

  const set = (patch: Partial<FormState>) =>
    setForm((current) => (current ? { ...current, ...patch } : current))

  function validate(): {
    startAt: number
    endAt: number
    error: string | null
  } {
    if (!state.startDate) {
      return { startAt: 0, endAt: 0, error: "Pick a date for the event." }
    }
    if (state.allDay) {
      const startAt = utcSeconds(state.startDate)
      const endAt = utcSeconds(state.endDate || state.startDate)
      if (startAt === null || endAt === null) {
        return { startAt: 0, endAt: 0, error: "The dates are not valid." }
      }
      if (endAt < startAt) {
        return {
          startAt: 0,
          endAt: 0,
          error: "The end date must be on or after the start date.",
        }
      }
      return { startAt, endAt: endAt + 86_400, error: null }
    }
    const startAt = localSeconds(state.startDate, state.startTime)
    const endAt = localSeconds(state.startDate, state.endTime)
    if (startAt === null || endAt === null) {
      return { startAt: 0, endAt: 0, error: "The times are not valid." }
    }
    if (endAt <= startAt) {
      return {
        startAt: 0,
        endAt: 0,
        error: "The end time must be after the start time.",
      }
    }
    return { startAt, endAt, error: null }
  }

  async function handleSave(): Promise<void> {
    if (busy) return
    const times = validate()
    if (times.error) {
      setError(times.error)
      return
    }
    const reminderChanged = state.reminder !== initial.current.reminder
    const guestsChanged = state.guests !== initial.current.guests
    const executor = getCalendarViewExecutor()
    setBusy("save")
    setError(null)
    try {
      let result
      if (activeRequest.mode === "create") {
        result = await createEvent(executor, {
          sourceId: destinationKey?.split("::")[0] ?? "",
          calendarId: destinationKey?.split("::").slice(1).join("::") ?? "",
          title: state.title.trim() || "(untitled)",
          startAt: times.startAt,
          endAt: times.endAt,
          allDay: state.allDay,
          location: state.location.trim() || null,
          description: state.description.trim() || null,
          guests: parseGuests(state.guests),
          reminderMinutes:
            supportsReminder && reminderChanged && state.reminder !== ""
              ? Number(state.reminder)
              : undefined,
        })
      } else {
        const patch: EventWritePatch = {
          title: state.title.trim() || "(untitled)",
          startAt: times.startAt,
          endAt: times.endAt,
          allDay: state.allDay,
          location: state.location.trim() || null,
          description: state.description.trim() || null,
        }
        if (guestsChanged) patch.guests = parseGuests(state.guests)
        if (supportsReminder && reminderChanged) {
          patch.reminderMinutes =
            state.reminder === "" ? null : Number(state.reminder)
        }
        result = await updateEvent(executor, activeRequest.event, patch)
      }
      if (result.ok) {
        toast.success(
          activeRequest.mode === "create"
            ? "Event saved to the calendar"
            : "Event updated"
        )
        onOpenChange(false)
        onSaved?.()
        return
      }
      // Nothing was persisted — keep the form exactly as the user left it
      // and say so (spec: does not silently keep an unsaved edit).
      setError(result.message ?? "The event could not be saved.")
    } catch (writeError) {
      console.warn("[event-dialog] save failed", writeError)
      setError(
        writeError instanceof Error
          ? writeError.message
          : "The event could not be saved."
      )
    } finally {
      setBusy(null)
    }
  }

  async function handleDelete(): Promise<void> {
    if (activeRequest.mode !== "edit" || busy) return
    const executor = getCalendarViewExecutor()
    setBusy("delete")
    setError(null)
    try {
      const result = await deleteEvent(executor, activeRequest.event)
      if (result.ok) {
        toast.success("Event deleted")
        onOpenChange(false)
        onSaved?.()
        return
      }
      setError(result.message ?? "The event could not be deleted.")
    } catch (deleteError) {
      console.warn("[event-dialog] delete failed", deleteError)
      setError(
        deleteError instanceof Error
          ? deleteError.message
          : "The event could not be deleted."
      )
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="event-dialog" className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {request.mode === "create" ? "New event" : "Edit event"}
          </DialogTitle>
          <DialogDescription>
            {request.mode === "create"
              ? "The event is saved to the connected calendar."
              : "Changes are written back to the calendar."}
          </DialogDescription>
        </DialogHeader>
        {error !== null && (
          <div
            role="alert"
            data-testid="event-dialog-error"
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 text-xs text-destructive"
          >
            {error}
          </div>
        )}
        <div className="grid gap-3">
          <Label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            Title
            <Input
              data-testid="event-dialog-title"
              value={form.title}
              placeholder="Event title"
              onChange={(change) => set({ title: change.target.value })}
            />
          </Label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Switch
              data-testid="event-dialog-all-day"
              checked={form.allDay}
              onCheckedChange={(checked) => set({ allDay: checked === true })}
            />
            All day
          </label>
          <div className="grid grid-cols-2 gap-2">
            <Label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
              Date
              <Input
                type="date"
                data-testid="event-dialog-date"
                value={form.startDate}
                onChange={(change) => set({ startDate: change.target.value })}
              />
            </Label>
            {form.allDay ? (
              <Label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                Last day
                <Input
                  type="date"
                  data-testid="event-dialog-end-date"
                  value={form.endDate}
                  onChange={(change) => set({ endDate: change.target.value })}
                />
              </Label>
            ) : (
              <span aria-hidden />
            )}
          </div>
          {!form.allDay && (
            <div className="grid grid-cols-2 gap-2">
              <Label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                Starts
                <Input
                  type="time"
                  data-testid="event-dialog-start-time"
                  value={form.startTime}
                  onChange={(change) => set({ startTime: change.target.value })}
                />
              </Label>
              <Label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                Ends
                <Input
                  type="time"
                  data-testid="event-dialog-end-time"
                  value={form.endTime}
                  onChange={(change) => set({ endTime: change.target.value })}
                />
              </Label>
            </div>
          )}
          {request.mode === "create" && (
            <DestinationPicker
              destinations={destinations}
              value={destinationKey}
              onSelect={setDestinationKey}
            />
          )}
          <Label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            Location
            <Input
              data-testid="event-dialog-location"
              value={form.location}
              placeholder="Optional"
              onChange={(change) => set({ location: change.target.value })}
            />
          </Label>
          <Label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            Notes
            <Textarea
              data-testid="event-dialog-description"
              value={form.description}
              placeholder="Optional"
              onChange={(change) => set({ description: change.target.value })}
            />
          </Label>
          <Label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
            Guests
            <Input
              data-testid="event-dialog-guests"
              value={form.guests}
              placeholder="comma@separated,emails@example.com"
              onChange={(change) => set({ guests: change.target.value })}
            />
          </Label>
          {provider === "caldav" ? (
            <p
              data-testid="event-dialog-reminder-note"
              className="text-xs text-muted-foreground"
            >
              Reminders are available for Google and Outlook calendars.
            </p>
          ) : (
            supportsReminder && (
              <Label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                Reminder (minutes before)
                <Input
                  type="number"
                  min={0}
                  data-testid="event-dialog-reminder"
                  value={form.reminder}
                  placeholder="Default"
                  onChange={(change) => set({ reminder: change.target.value })}
                />
              </Label>
            )
          )}
        </div>
        <DialogFooter className="items-center">
          {request.mode === "edit" && (
            <Button
              variant="ghost"
              data-testid="event-dialog-delete"
              className="mr-auto gap-1 text-destructive hover:text-destructive"
              disabled={busy !== null}
              onClick={() => void handleDelete()}
            >
              <Trash2 className="size-3.5" />
              {busy === "delete" ? "Deleting…" : "Delete"}
            </Button>
          )}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            data-testid="event-dialog-save"
            className="gap-1"
            // No destination yet (still loading / nothing connected) →
            // there is nothing to save into (create only; edits write in
            // place).
            disabled={
              busy !== null ||
              (activeRequest.mode === "create" && destinationKey === null)
            }
            onClick={() => void handleSave()}
          >
            <CalendarPlus className="size-3.5" />
            {busy === "save" ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
/**
 * The destination picker (create mode): every writable (source, calendar)
 * pair from the write service. Nothing connected (or no DB) shows the
 * connect-a-calendar note and keeps Save disabled.
 */

function DestinationPicker({
  destinations,
  value,
  onSelect,
}: {
  destinations: WritableCalendar[] | null
  value: string | null
  onSelect: (key: string) => void
}) {
  if (destinations === null) {
    return (
      <p
        data-testid="event-dialog-destinations-loading"
        className="text-xs text-muted-foreground"
      >
        Looking for your calendars…
      </p>
    )
  }
  if (destinations.length === 0) {
    return (
      <p
        data-testid="event-dialog-no-destinations"
        className={cn(
          "rounded-lg border border-border bg-muted/30 p-2 text-xs",
          "text-muted-foreground"
        )}
      >
        Connect a calendar in Settings to save events.
      </p>
    )
  }
  return (
    <Label className="flex items-center gap-2 text-xs text-muted-foreground">
      Calendar
      <select
        data-testid="event-dialog-destination"
        className="h-8 w-full flex-1 rounded-lg border border-input bg-transparent px-2 text-sm"
        value={value ?? ""}
        onChange={(change) => onSelect(change.target.value)}
      >
        {destinations.map((destination) => (
          <option
            key={`${destination.sourceId}::${destination.calendarId}`}
            value={`${destination.sourceId}::${destination.calendarId}`}
          >
            {destination.sourceName} · {destination.calendarId}
          </option>
        ))}
      </select>
    </Label>
  )
}
