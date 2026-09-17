import { useCallback, useEffect, useState } from "react"
import {
  CalendarClock,
  ChevronDown,
  ChevronUp,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { getExecutor } from "@/services/db/executor"
import type {
  DeliverySchedule,
  DeliveryScheduleMatch,
  DeliveryScheduleMatchKind,
  DeliveryScheduleWindow,
} from "@/services/settings/delivery-schedules"
import {
  createDeliverySchedule,
  deleteDeliverySchedule,
  listDeliverySchedules,
  reorderDeliverySchedules,
  updateDeliverySchedule,
} from "@/services/settings/delivery-schedules"
import { useActiveAccount } from "@/stores/account-store"

/**
 * Settings "Delivery schedules" section (task 12.2, design D6): manages the
 * per-account delivery schedules of the ACTIVE account (the account-store
 * selection — schedules live in one settings row per account, same scoping
 * as the rules/notifications sections). Rows show the optional name (or a
 * derived "Saturdays 8:00 AM" label for unnamed schedules), the match chip
 * and the weekly-window chip, up/down ordering controls (a swap through
 * reorderDeliverySchedules — position is the evaluation order the
 * ingestion hook resolves holds in), edit and delete (no confirm — a
 * schedule is trivially re-created, matching the rules section).
 *
 * The recurring window picker is a day-of-week select plus a native
 * <input type="time">: the window is one weekly LOCAL wall-clock instant
 * (the snooze-preset convention), so "Saturdays 8:00 AM" is exactly what
 * the two controls express and no timezone math belongs in the form.
 */

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
]

function pad2(value: number): string {
  return String(value).padStart(2, "0")
}

/** "8:05 PM"-style clock string from the window's local hour/minute
 * (12-hour with a preserved midnight/noon special case). */
function formatWindowTime(hour: number, minute: number): string {
  const period = hour < 12 ? "AM" : "PM"
  const twelveHour = hour % 12 === 0 ? 12 : hour % 12
  return `${twelveHour}:${pad2(minute)} ${period}`
}

/** "Saturdays 8:00 AM" — the human string for the weekly window (0 =
 * Sunday, the Date.getDay() convention the service shares). */
function weeklyWindowLabel(window: DeliveryScheduleWindow): string {
  return `${WEEKDAY_NAMES[window.dayOfWeek]}s ${formatWindowTime(window.hour, window.minute)}`
}

/** The row title for an unnamed schedule: the window itself ("Saturdays
 * 8:00 AM"), which is the identifying part of the spec's example. */
function scheduleTitle(schedule: DeliverySchedule): string {
  const name = schedule.name?.trim()
  return name ? name : weeklyWindowLabel(schedule.window)
}

function matchChipLabel(match: DeliveryScheduleMatch): string {
  return match.kind === "sender"
    ? `Sender: ${match.value}`
    : `Label: ${match.value}`
}

function ScheduleRowItem({
  schedule,
  isFirst,
  isLast,
  onMove,
  onEdit,
  onDelete,
}: {
  schedule: DeliverySchedule
  isFirst: boolean
  isLast: boolean
  onMove: (schedule: DeliverySchedule, direction: -1 | 1) => void
  onEdit: (schedule: DeliverySchedule) => void
  onDelete: (schedule: DeliverySchedule) => void
}) {
  const title = scheduleTitle(schedule)
  return (
    <div
      data-testid="settings-delivery-schedule-row"
      className="flex items-start gap-3 py-2.5"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{title}</p>
        <div className="mt-1 flex flex-wrap gap-1">
          <Badge variant="outline" className="font-normal">
            {matchChipLabel(schedule.match)}
          </Badge>
          <Badge variant="outline" className="font-normal">
            {weeklyWindowLabel(schedule.window)}
          </Badge>
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${title} up`}
        disabled={isFirst}
        onClick={() => onMove(schedule, -1)}
      >
        <ChevronUp />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Move ${title} down`}
        disabled={isLast}
        onClick={() => onMove(schedule, 1)}
      >
        <ChevronDown />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Edit ${title}`}
        onClick={() => onEdit(schedule)}
      >
        <Pencil />
        Edit
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Delete ${title}`}
        onClick={() => onDelete(schedule)}
      >
        <Trash2 />
        Delete
      </Button>
    </div>
  )
}

type DialogTarget =
  { mode: "add" } | { mode: "edit"; schedule: DeliverySchedule }

/** "HH:MM" (the <input type="time"> value format) → { hour, minute }, or
 * null when the field is cleared or out of range. */
function parseTimeInput(value: string): {
  hour: number
  minute: number
} | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null
  return { hour, minute }
}

function formatTimeInput(window: DeliveryScheduleWindow): string {
  return `${pad2(window.hour)}:${pad2(window.minute)}`
}

function ScheduleDialog({
  accountId,
  target,
  onOpenChange,
  onSaved,
}: {
  accountId: string
  target: DialogTarget
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const editing = target.mode === "edit" ? target.schedule : null
  const [name, setName] = useState(editing?.name ?? "")
  const [matchKind, setMatchKind] = useState<DeliveryScheduleMatchKind>(
    editing?.match.kind ?? "sender"
  )
  const [matchValue, setMatchValue] = useState(editing?.match.value ?? "")
  // Defaults are the spec's own example — "newsletters, Saturdays 8 AM".
  const [dayOfWeek, setDayOfWeek] = useState<number>(
    editing?.window.dayOfWeek ?? 6
  )
  const [time, setTime] = useState(() =>
    editing ? formatTimeInput(editing.window) : "08:00"
  )
  const [saving, setSaving] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const parsedTime = parseTimeInput(time)
  const canSave = matchValue.trim() !== "" && parsedTime !== null && !saving

  async function handleSave(): Promise<void> {
    if (!canSave || !parsedTime) return
    setSaving(true)
    setErrorMessage(null)
    const trimmedValue = matchValue.trim()
    const trimmedName = name.trim()
    const window: DeliveryScheduleWindow = {
      kind: "weekly",
      dayOfWeek,
      hour: parsedTime.hour,
      minute: parsedTime.minute,
    }
    try {
      const executor = getExecutor()
      const title = trimmedName !== "" ? trimmedName : weeklyWindowLabel(window)
      if (editing) {
        // The name is always sent (possibly "") so clearing it on edit
        // persists — the row then falls back to the derived window label.
        await updateDeliverySchedule(executor, accountId, editing.id, {
          name: trimmedName,
          match: { kind: matchKind, value: trimmedValue },
          window,
        })
        toast.success(`Delivery schedule “${title}” updated`)
      } else {
        await createDeliverySchedule(executor, accountId, {
          ...(trimmedName !== "" ? { name: trimmedName } : {}),
          match: { kind: matchKind, value: trimmedValue },
          window,
        })
        toast.success(`Delivery schedule “${title}” created`)
      }
      onSaved()
      onOpenChange(false)
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : "Could not save the delivery schedule."
      )
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit Delivery Schedule" : "Add Delivery Schedule"}
          </DialogTitle>
          <DialogDescription>
            Hold matching new mail until a recurring weekly delivery window
            opens.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void handleSave()
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="delivery-schedule-name">Name</Label>
            <Input
              id="delivery-schedule-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Optional, e.g. Weekend digests"
              autoFocus
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="delivery-schedule-match-type">Match by</Label>
            <Select
              value={matchKind}
              items={{ sender: "Sender address", label: "Label" }}
              onValueChange={(value) =>
                setMatchKind(String(value) as DeliveryScheduleMatchKind)
              }
            >
              <SelectTrigger id="delivery-schedule-match-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sender">Sender address</SelectItem>
                <SelectItem value="label">Label</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="delivery-schedule-match-value">
              {matchKind === "sender" ? "Sender address" : "Label name"}
            </Label>
            <Input
              id="delivery-schedule-match-value"
              value={matchValue}
              onChange={(event) => setMatchValue(event.target.value)}
              placeholder={
                matchKind === "sender" ? "e.g. news@x.com" : "e.g. Newsletters"
              }
            />
          </div>
          <div className="grid gap-2">
            <Label>Delivery window</Label>
            <p className="text-xs text-muted-foreground">
              Repeats weekly — matching mail waits for the next opening.
            </p>
            <div className="flex items-center gap-2">
              <Select
                value={String(dayOfWeek)}
                items={Object.fromEntries(
                  WEEKDAY_NAMES.map((day, index) => [String(index), day])
                )}
                onValueChange={(value) => setDayOfWeek(Number(value))}
              >
                <SelectTrigger
                  id="delivery-schedule-day"
                  aria-label="Delivery day"
                  className="w-36 shrink-0"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WEEKDAY_NAMES.map((day, index) => (
                    <SelectItem key={day} value={String(index)}>
                      {day}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                id="delivery-schedule-time"
                type="time"
                aria-label="Delivery time"
                value={time}
                onChange={(event) => setTime(event.target.value)}
                className="w-28 shrink-0"
              />
            </div>
          </div>
          {errorMessage && (
            <p role="alert" className="text-sm text-destructive">
              {errorMessage}
            </p>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave}>
              {saving && (
                <Loader2 className="size-3.5 animate-spin" aria-hidden />
              )}
              {editing ? "Save Changes" : "Create Schedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function DeliverySchedulesSection() {
  const account = useActiveAccount()
  const [schedules, setSchedules] = useState<DeliverySchedule[]>([])
  const [dialog, setDialog] = useState<DialogTarget | null>(null)

  const reload = useCallback(() => {
    // Without an active account there is nothing to load — the render
    // below shows the no-account state, so the stale list stays hidden.
    if (!account) return
    try {
      void listDeliverySchedules(getExecutor(), account.id)
        .then(setSchedules)
        .catch((error) => {
          console.warn("[settings] failed to load delivery schedules", error)
        })
    } catch (error) {
      console.warn("[settings] failed to load delivery schedules", error)
    }
  }, [account])

  // The shell only mounts settings after bootstrap(), so the executor is
  // available (same assumption as the other sections).
  useEffect(reload, [reload])

  /** Ordering is the ingestion evaluation order (position): moving swaps
   * the row with its neighbor through one reorderDeliverySchedules call,
   * which re-densifies positions, then re-reads. */
  async function handleMove(
    schedule: DeliverySchedule,
    direction: -1 | 1
  ): Promise<void> {
    if (!account) return
    const index = schedules.findIndex(
      (candidate) => candidate.id === schedule.id
    )
    const neighborIndex = index + direction
    if (
      index === -1 ||
      neighborIndex < 0 ||
      neighborIndex >= schedules.length
    ) {
      return
    }
    const orderedIds = schedules.map((candidate) => candidate.id)
    ;[orderedIds[index], orderedIds[neighborIndex]] = [
      orderedIds[neighborIndex]!,
      orderedIds[index]!,
    ]
    try {
      await reorderDeliverySchedules(getExecutor(), account.id, orderedIds)
      reload()
    } catch (error) {
      console.warn("[settings] failed to reorder delivery schedules", error)
    }
  }

  async function handleDelete(schedule: DeliverySchedule): Promise<void> {
    if (!account) return
    try {
      await deleteDeliverySchedule(getExecutor(), account.id, schedule.id)
      reload()
    } catch (error) {
      console.warn("[settings] failed to delete delivery schedule", error)
    }
  }

  return (
    <section aria-label="Delivery schedules" className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            Delivery schedules
          </h2>
          <p className="text-sm text-muted-foreground">
            {account
              ? `Batch deliveries for ${account.email}.`
              : "Batch deliveries on a weekly window."}
          </p>
        </div>
        <Button
          size="sm"
          disabled={!account}
          onClick={() => setDialog({ mode: "add" })}
        >
          <CalendarClock />
          Add Schedule
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        New mail matching a schedule is held until its window opens, then
        delivered together at the top of the inbox.
      </p>
      <Separator />
      {!account ? (
        <p className="text-sm text-muted-foreground">
          Add an account to manage its delivery schedules.
        </p>
      ) : schedules.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No schedules yet. New mail is delivered as it arrives.
        </p>
      ) : (
        <div className="divide-y divide-border">
          {schedules.map((schedule, index) => (
            <ScheduleRowItem
              key={schedule.id}
              schedule={schedule}
              isFirst={index === 0}
              isLast={index === schedules.length - 1}
              onMove={(target, direction) => {
                void handleMove(target, direction)
              }}
              onEdit={(target) => setDialog({ mode: "edit", schedule: target })}
              onDelete={(target) => {
                void handleDelete(target)
              }}
            />
          ))}
        </div>
      )}
      {/* Remounted on every open so the form always starts fresh. */}
      {dialog && account && (
        <ScheduleDialog
          key={dialog.mode === "edit" ? `edit-${dialog.schedule.id}` : "add"}
          accountId={account.id}
          target={dialog}
          onOpenChange={(open) => {
            if (!open) setDialog(null)
          }}
          onSaved={reload}
        />
      )}
    </section>
  )
}
