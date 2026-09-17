import { useState, type ReactElement } from "react"
import { addDays, format, set } from "date-fns"

import { formatSnoozedUntil } from "@/components/layout/use-snoozed-threads"
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
import { getSnoozePresets } from "@/services/email-actions/snooze"
import { SNOOZE_CUSTOM_LABEL } from "./snooze-flow"

/**
 * The reusable Snooze menu (task 2.3): the service's presets plus a
 * custom date/time entry, shared by every entry point. The dropdown
 * variant (`SnoozeMenu`) wraps a trigger button (row hover affordance,
 * reading-pane toolbar); the context menu renders the same preset +
 * custom entries as a `ContextMenuSub` (see thread-context-menu.tsx)
 * and anchors the shared `SnoozeCustomPicker` at the row.
 *
 * Choosing a time funnels the caller's `onPick` into the shared flow
 * (snooze-flow.snoozeThreadsWithRefresh), so all surfaces behave
 * identically. The flow + toast helpers live in snooze-flow.ts; this
 * file stays components-only (fast refresh).
 */

/** Draft value for the custom picker: tomorrow morning, local time, in
 * the datetime-local input format. */
function defaultCustomValue(): string {
  const tomorrow = set(addDays(new Date(), 1), { hours: 8, minutes: 0 })
  return format(tomorrow, "yyyy-MM-dd'T'HH:mm")
}

interface SnoozeCustomPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Popover anchor — the trigger the menu was opened from. */
  anchor: Element | null
  /** Confirmed wake-up time (unix seconds). */
  onConfirm: (until: number) => void
}

/**
 * The custom date/time entry of the snooze menu: a small popover with a
 * datetime-local input (the spec's "presets plus custom date/time" — no
 * calendar). Rendered next to the menu's trigger once "Pick date &
 * time…" closes the menu.
 */
export function SnoozeCustomPicker({
  open,
  onOpenChange,
  anchor,
  onConfirm,
}: SnoozeCustomPickerProps) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverContent
        anchor={anchor}
        align="end"
        className="w-64 gap-2"
        data-testid="snooze-custom-picker"
      >
        <SnoozeCustomForm
          onCancel={() => onOpenChange(false)}
          onConfirm={(until) => {
            onOpenChange(false)
            onConfirm(until)
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
function SnoozeCustomForm({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void
  onConfirm: (until: number) => void
}) {
  const [value, setValue] = useState(defaultCustomValue)
  const confirm = (): void => {
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return
    onConfirm(Math.floor(parsed.getTime() / 1000))
  }
  return (
    <>
      <label
        htmlFor="snooze-custom-input"
        className="text-xs font-medium text-muted-foreground"
      >
        Snooze until
      </label>
      <Input
        id="snooze-custom-input"
        data-testid="snooze-custom-input"
        type="datetime-local"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
      <div className="flex items-center justify-end gap-1">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={confirm}>
          Snooze
        </Button>
      </div>
    </>
  )
}

interface SnoozeMenuProps {
  /** Chosen wake-up time (unix seconds) + its display label. */
  onPick: (until: number, label: string) => void
  /** The trigger element, rendered through base-ui's render prop. */
  children: ReactElement
}

/**
 * Dropdown snooze menu for a button trigger: presets from
 * getSnoozePresets() (computed at open time, "Later today" only while
 * still in the future) plus the custom entry, whose picker anchors at
 * the trigger.
 */
export function SnoozeMenu({ onPick, children }: SnoozeMenuProps) {
  const [customOpen, setCustomOpen] = useState(false)
  const [anchor, setAnchor] = useState<Element | null>(null)
  return (
    <span ref={setAnchor} className="inline-flex">
      <DropdownMenu>
        <DropdownMenuTrigger render={children} />
        <DropdownMenuContent align="end" data-testid="snooze-menu">
          {getSnoozePresets().presets.map((preset) => (
            <DropdownMenuItem
              key={preset.id}
              onClick={() => onPick(preset.until, preset.label)}
            >
              {preset.label}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCustomOpen(true)}>
            {SNOOZE_CUSTOM_LABEL}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SnoozeCustomPicker
        open={customOpen}
        onOpenChange={setCustomOpen}
        anchor={anchor}
        onConfirm={(until) => {
          setCustomOpen(false)
          onPick(until, formatSnoozedUntil(until))
        }}
      />
    </span>
  )
}
