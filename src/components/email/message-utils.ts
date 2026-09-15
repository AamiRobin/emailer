import { format, fromUnixTime } from "date-fns"

/**
 * Presentation helpers shared by the thread view composites (kept out of
 * the .tsx files so fast-refresh sees components only). Token-only styling:
 * the avatar palette indexes the `chart-1`…`chart-5` theme token utility
 * classes — never hex values (docs/ui-guide.md §3).
 */

/**
 * Avatar initials for a contact: the leading characters of the display
 * name's words, falling back to the email's local part. Deterministic, no
 * external lookup (mailbox-ui spec: avatar derived from initials only).
 */
export function getInitials(
  name: string | null | undefined,
  email: string | null | undefined
): string {
  const fromName = (name ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
  if (fromName) return fromName.slice(0, 2).toUpperCase()
  const local = (email ?? "").split("@")[0].trim()
  return local ? local[0].toUpperCase() : "?"
}

/** The chart-token utility classes usable as avatar backgrounds. */
const AVATAR_TOKEN_CLASSES = [
  "bg-chart-1/60",
  "bg-chart-2/60",
  "bg-chart-3/60",
  "bg-chart-4/60",
  "bg-chart-5/60",
] as const

/**
 * Deterministic avatar palette pick: a stable hash of the address indexes
 * into the chart tokens, so the same sender always gets the same color
 * across renders and restarts.
 */
export function avatarTokenClass(email: string | null | undefined): string {
  const key = (email ?? "").toLowerCase()
  let hash = 0
  for (let index = 0; index < key.length; index++) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0
  }
  const index = Math.abs(hash) % AVATAR_TOKEN_CLASSES.length
  return AVATAR_TOKEN_CLASSES[index]
}

/** Bytes → compact human size ("842 B", "1.5 KB", "3.2 MB"). */
export function humanFileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return ""
  const units = ["B", "KB", "MB", "GB", "TB"]
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  const rounded = unit === 0 ? String(value) : value.toFixed(1)
  return `${rounded} ${units[unit]}`
}

/** Unix seconds → full local timestamp ("Feb 15, 2023, 4:30 PM"). */
export function formatFullTimestamp(unixSeconds: number): string {
  return format(fromUnixTime(unixSeconds), "PPp")
}
