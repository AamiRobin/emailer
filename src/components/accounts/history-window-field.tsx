import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  ALL_HISTORY_VALUE,
  HISTORY_WINDOWS,
  WINDOW_ITEM_LABELS,
  type HistoryWindow,
  type HistoryWindowSetting,
} from "@/services/sync/history-window"

/**
 * The per-account history-window pick (parity-round-3 task 3.1, design
 * D6): "how far back should the FIRST sync download?" Shared by the three
 * add-account flows (the pick lands in the account row at insert time, so
 * the very first sync is already bounded) and the settings Accounts rows
 * (changing an existing account; widening offers the targeted backfill
 * there). The wording always names the first sync — the boundary is
 * download-only and never re-applied to delta sync.
 */

function settingToValue(window: HistoryWindowSetting): string {
  return window ?? ALL_HISTORY_VALUE
}

function valueToSetting(value: string): HistoryWindowSetting {
  return value === ALL_HISTORY_VALUE
    ? null
    : HISTORY_WINDOWS.includes(value as HistoryWindow)
      ? (value as HistoryWindow)
      : null
}

interface HistoryWindowFieldProps {
  /** Bound the Label's htmlFor to the trigger (unique per form). */
  id: string
  value: HistoryWindowSetting
  onChange: (window: HistoryWindowSetting) => void
  disabled?: boolean
}

export function HistoryWindowField({
  id,
  value,
  onChange,
  disabled,
}: HistoryWindowFieldProps) {
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        First sync download
      </Label>
      <Select
        items={WINDOW_ITEM_LABELS}
        value={settingToValue(value)}
        disabled={disabled}
        onValueChange={(next) => {
          if (typeof next === "string") onChange(valueToSetting(next))
        }}
      >
        <SelectTrigger id={id} className="w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(
            [...HISTORY_WINDOWS, ALL_HISTORY_VALUE] as (
              | HistoryWindow
              | typeof ALL_HISTORY_VALUE
            )[]
          ).map((item) => (
            <SelectItem key={item} value={item}>
              {WINDOW_ITEM_LABELS[item]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        Applies to the first sync only — messages older than this are left
        on the server. New mail always syncs.
      </p>
    </div>
  )
}
