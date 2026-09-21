/**
 * Accent color switching.
 *
 * Accents are pure CSS variable sets in `src/index.css` (`[data-accent="<id>"]`
 * for light values plus `[data-accent="<id>"].dark` where dark values differ).
 * This module only toggles the `data-accent` attribute on `<html>` and keeps
 * the choice across restarts — components never change.
 *
 * NOTE: localStorage is the interim persistence store. A later task moves this
 * to the DB-backed settings service; keep reads/writes behind this module so
 * that swap stays local.
 */

export const ACCENT_STORAGE_KEY = "emailer-accent"

export type Accent = {
  /** Value applied as `data-accent` on `<html>`. "default" clears the attribute. */
  id: string
  /** Human-readable label for settings UIs. */
  name: string
}

export const DEFAULT_ACCENT_ID = "default"

export const ACCENTS: readonly Accent[] = [
  { id: DEFAULT_ACCENT_ID, name: "Neutral" },
  { id: "blue", name: "Blue" },
  { id: "violet", name: "Violet" },
  { id: "green", name: "Green" },
  { id: "amber", name: "Amber" },
  { id: "orange", name: "Orange" },
  { id: "rose", name: "Rose" },
  { id: "teal", name: "Teal" },
  { id: "cyan", name: "Cyan" },
]

function isAccentId(value: string): boolean {
  return ACCENTS.some((accent) => accent.id === value)
}

export function getStoredAccentId(): string {
  try {
    const stored = localStorage.getItem(ACCENT_STORAGE_KEY)
    if (stored && isAccentId(stored)) {
      return stored
    }
  } catch {
    // localStorage unavailable (e.g. hardened webview) — fall through to default.
  }

  return DEFAULT_ACCENT_ID
}

export function applyAccent(id: string): void {
  const accentId = isAccentId(id) ? id : DEFAULT_ACCENT_ID
  const root = document.documentElement

  if (accentId === DEFAULT_ACCENT_ID) {
    root.removeAttribute("data-accent")
  } else {
    root.setAttribute("data-accent", accentId)
  }

  try {
    localStorage.setItem(ACCENT_STORAGE_KEY, accentId)
  } catch {
    // Best-effort persistence; the attribute is already applied for this session.
  }
}

/** Restore the persisted accent. Call once at app start, before first paint. */
export function initAccent(): void {
  applyAccent(getStoredAccentId())
}
