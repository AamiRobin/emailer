import { useState } from "react"
import { addDays, format, set } from "date-fns"
import { Clock } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent } from "@/components/ui/popover"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { getScheduleSendPresets } from "@/components/layout/use-scheduled-sends"

/**
 * The composer's "Schedule send" picker (task 10.1): a clock button next
 * to Send opening a dropdown with the send-later presets (presets computed
 * at open time — the snooze-menu pattern) plus a custom date/time entry
 * (datetime-local, like the snooze custom picker). The chosen time is
 * handed to the caller's `onSchedule` (unix seconds); the composer owns
 * the payload build/store/toast flow.
 */

/** Draft value for the custom picker: tomorrow morning, local time, in
 * the datetime-local input format. */
function defaultCustomValue(): string {
  const tomorrow = set(addDays(new Date(), 1), { hours: 8, minutes: 0 })
  return format(tomorrow, "yyyy-MM-dd'T'HH:mm")
}

interface ScheduleCustomPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Popover anchor — the trigger the menu was opened from. */
  anchor: Element | null
  /** Confirmed send time (unix seconds). */
  onConfirm: (dueAt: number) => void
}

/**
 * The custom date/time entry of the schedule menu: a small popover with a
 * datetime-local input. Confirm stays disabled while the parsed time is
 * not in the future (a due-at-in-the-past scheduled send would be a lie).
 */
export function ScheduleSendCustomPicker({
  open,
  onOpenChange,
  anchor,
  onConfirm,
}: ScheduleCustomPickerProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverContent
        anchor={anchor}
        align="end"
        className="w-64 gap-2"
        data-testid="schedule-custom-picker"
      >
        <ScheduleCustomForm
          onCancel={() => onOpenChange(false)}
          onConfirm={(dueAt) => {
            onOpenChange(false)
            onConfirm(dueAt)
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * The picker body. Mounted only while the popover is open (base-ui
 * unmounts the closed popup), so the draft time always starts at the
 * default — no open/effect state reset needed.
 */
function ScheduleCustomForm({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void
  onConfirm: (dueAt: number) => void
}) {
  const [value, setValue] = useState(defaultCustomValue)
  // The default draft is in the future; validity (parseable + not in the
  // past) is sampled in the change handler, not during render.
  const [valid, setValid] = useState(true)
  const handleChange = (next: string): void => {
    setValue(next)
    const parsed = new Date(next).getTime()
    setValid(!Number.isNaN(parsed) && parsed > Date.now())
  }
  const confirm = (): void => {
    if (!valid) return
    onConfirm(Math.floor(new Date(value).getTime() / 1000))
  }
  return (
    <>
      <label
        htmlFor="schedule-custom-input"
        className="text-xs font-medium text-muted-foreground"
      >
        Schedule for
      </label>
      <Input
        id="schedule-custom-input"
        data-testid="schedule-custom-input"
        type="datetime-local"
        value={value}
        onChange={(event) => handleChange(event.target.value)}
      />
      <div className="flex items-center justify-end gap-1">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={!valid} onClick={confirm}>
          Schedule
        </Button>
      </div>
    </>
  )
}

interface ScheduleSendMenuProps {
  /** Mirrors the Send button's disabled state (nothing to schedule). */
  disabled: boolean
  /** Chosen send time (unix seconds) — presets and custom picker alike. */
  onSchedule: (dueAt: number) => void
}

/**
 * Dropdown schedule menu for a clock button: presets from
 * getScheduleSendPresets() plus the custom entry, whose picker anchors at
 * the trigger.
 */
export function ScheduleSendMenu({
  disabled,
  onSchedule,
}: ScheduleSendMenuProps) {
  const [customOpen, setCustomOpen] = useState(false)
  const [anchor, setAnchor] = useState<Element | null>(null)
  return (
    <span ref={setAnchor} className="inline-flex">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              disabled={disabled}
              aria-label="Schedule send"
            >
              <Clock aria-hidden />
            </Button>
          }
        />
        <DropdownMenuContent align="end" data-testid="schedule-send-menu">
          {getScheduleSendPresets().presets.map((preset) => (
            <DropdownMenuItem
              key={preset.id}
              onClick={() => onSchedule(preset.dueAt)}
            >
              {preset.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCustomOpen(true)}>
            Pick date &amp; time…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ScheduleSendCustomPicker
        open={customOpen}
        onOpenChange={setCustomOpen}
        anchor={anchor}
        onConfirm={(dueAt) => {
          setCustomOpen(false)
          onSchedule(dueAt)
        }}
      />
    </span>
  )
}
