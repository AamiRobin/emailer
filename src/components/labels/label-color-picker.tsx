import { cn } from "@/lib/utils"

/**
 * The label color palette (task 10.4): preset swatches backed by the app's
 * CSS chart tokens — the stored value is the token reference string (e.g.
 * "var(--chart-3)"), so presets follow the active accent/theme and no raw
 * color values ship in component code. `null` clears back to the default
 * (uncolored) dot. The sidebar renders the stored string through its
 * data-color exception; Gmail hex colors imported by sync show up the
 * same way.
 */

interface LabelColorPreset {
  name: string
  /** Token reference ("var(--chart-1)") or null for the default dot. */
  value: string | null
}

const LABEL_COLOR_PRESETS: LabelColorPreset[] = [
  { name: "Default", value: null },
  { name: "Color 1", value: "var(--chart-1)" },
  { name: "Color 2", value: "var(--chart-2)" },
  { name: "Color 3", value: "var(--chart-3)" },
  { name: "Color 4", value: "var(--chart-4)" },
  { name: "Color 5", value: "var(--chart-5)" },
]

interface LabelColorPickerProps {
  value: string | null
  onChange: (value: string | null) => void
  disabled?: boolean
}

export function LabelColorPicker({
  value,
  onChange,
  disabled = false,
}: LabelColorPickerProps) {
  return (
    <div
      role="radiogroup"
      aria-label="Label color"
      className="flex flex-wrap items-center gap-1.5"
    >
      {LABEL_COLOR_PRESETS.map((preset) => {
        const selected = (preset.value ?? null) === (value ?? null)
        return (
          <button
            key={preset.name}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={preset.name}
            title={preset.name}
            disabled={disabled}
            className={cn(
              "flex size-6 items-center justify-center rounded-full transition-shadow outline-none select-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
              selected && "ring-2 ring-ring ring-offset-2"
            )}
            onClick={() => onChange(preset.value)}
          >
            {/* Data-color exception: the swatch paints the token reference
                (or an imported Gmail hex) — user-facing color data, like
                the sidebar's label dot. */}
            <span
              aria-hidden
              className="size-4 rounded-full border border-border bg-muted"
              style={
                preset.value ? { backgroundColor: preset.value } : undefined
              }
            />
          </button>
        )
      })}
    </div>
  )
}
