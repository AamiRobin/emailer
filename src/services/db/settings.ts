import type { SqlExecutor } from "./executor"

/**
 * Settings query module (task 4.6): generic key/value access to the
 * `settings` table plus typed accessors for the keys the app ships with.
 *
 * Values are JSON-encoded (the schema comment mandates it), so any JSON-
 * serializable value round-trips. getSetting returns the caller's default
 * when the key is absent or the stored text does not parse, so a corrupt
 * row can never crash a caller. This module is the canonical settings
 * access layer for later tasks — keep it generic. Feature-facing helpers
 * (persist + live cache flip) belong with their feature, e.g. the
 * new-mail notifier's setNotificationsEnabled.
 *
 * Executor-first like the other query modules (accounts.ts): production
 * callers pass getExecutor(); tests pass a node:sqlite executor.
 */

/** Keys the app currently persists; new settings go here. */
export const SETTINGS_KEYS = {
  /** New-mail OS notifications (task 4.6). Default: true. */
  notificationsEnabled: "notifications.enabled",
} as const

/**
 * Read a JSON-encoded setting. Returns `defaultValue` when the row is
 * missing or the stored text is not valid JSON.
 */
export async function getSetting<T>(
  executor: SqlExecutor,
  key: string,
  defaultValue: T
): Promise<T> {
  const rows = await executor.select<{ value: string }>(
    "SELECT value FROM settings WHERE key = $1",
    [key]
  )
  const raw = rows[0]?.value
  if (raw === undefined) return defaultValue
  try {
    return JSON.parse(raw) as T
  } catch {
    return defaultValue
  }
}

/**
 * JSON-encode and upsert a setting (`updated_at` follows the write via
 * the excluded row).
 */
export async function setSetting(
  executor: SqlExecutor,
  key: string,
  value: unknown
): Promise<void> {
  await executor.execute(
    `INSERT INTO settings (key, value, updated_at)
     VALUES ($1, $2, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       updated_at = excluded.updated_at`,
    [key, JSON.stringify(value)]
  )
}

/**
 * Whether new-mail OS notifications are enabled (task 4.6). Default on.
 * Persisted flips go through the notifier's setNotificationsEnabled,
 * which also invalidates its in-memory cache.
 */
export async function getNotificationsEnabled(
  executor: SqlExecutor
): Promise<boolean> {
  const value = await getSetting<boolean>(
    executor,
    SETTINGS_KEYS.notificationsEnabled,
    true
  )
  return typeof value === "boolean" ? value : true
}
