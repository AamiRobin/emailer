/**
 * Profile color palette (parity-round-2 task 4.4, accounts spec "Account
 * profiles and colors") — kept out of the profiles-editor component file
 * so fast-refresh only sees components there (the src/lib/accent.ts
 * precedent for picker palettes).
 *
 * The editor renders these as swatch buttons; the picked value is stored
 * verbatim in account_profiles.color / accounts.color_override and
 * rendered as-is by the thread-list markers (the label.color convention:
 * user content, not component styling). Ordered for distinction between
 * adjacent profiles.
 */

export type ProfileColor = {
  id: string
  /** Human-readable label for the picker's aria-labels. */
  label: string
  /** CSS hex value stored and rendered verbatim. */
  value: string
}

export const PROFILE_COLORS: readonly ProfileColor[] = [
  { id: "blue", label: "Blue", value: "#3b82f6" },
  { id: "purple", label: "Purple", value: "#8b5cf6" },
  { id: "green", label: "Green", value: "#22c55e" },
  { id: "orange", label: "Orange", value: "#f97316" },
  { id: "pink", label: "Pink", value: "#ec4899" },
  { id: "teal", label: "Teal", value: "#14b8a6" },
  { id: "red", label: "Red", value: "#ef4444" },
  { id: "amber", label: "Amber", value: "#f59e0b" },
]

/** A new profile starts on the first palette entry. */
export const DEFAULT_PROFILE_COLOR = PROFILE_COLORS[0].value
