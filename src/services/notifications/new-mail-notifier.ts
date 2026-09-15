import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification"

import { getExecutor } from "../db/executor"
import {
  getNotificationsEnabled,
  setSetting,
  SETTINGS_KEYS,
} from "../db/settings"

/**
 * New-mail OS notifications (task 4.6). The sync scheduler calls
 * notifyNewMail after an account pass whose engine summary reported new
 * messages; every gate lives here so the scheduler stays dumb:
 *
 * - count <= 0 → no-op;
 * - the notifications setting (default on) is read through the settings
 *   module and cached in-memory for SETTING_CACHE_TTL_MS;
 *   setNotificationsEnabled() persists the UI flip AND invalidates that
 *   cache so it takes effect immediately;
 * - the OS permission is resolved once per app run — requested at most
 *   once, a denial is remembered and never re-prompted;
 * - coalescing: at most one notification per account per 60s so sync
 *   storms cannot spam.
 *
 * Bodies never contain message content — only a count and the account
 * email. This module never rejects: a failed settings read fails open
 * (the default is on) and notification failures are swallowed.
 */

const SETTING_CACHE_TTL_MS = 30_000
const COALESCE_WINDOW_MS = 60_000

export interface NewMailEvent {
  accountId: string
  accountEmail: string
  /** Messages newly fetched for this account in one sync pass. */
  count: number
}

// ---------------------------------------------------------------------------
// Cached notifications setting
// ---------------------------------------------------------------------------

let cachedEnabled: boolean | null = null
let cachedAt = 0

async function notificationsEnabled(): Promise<boolean> {
  if (cachedEnabled !== null && Date.now() - cachedAt < SETTING_CACHE_TTL_MS) {
    return cachedEnabled
  }
  try {
    const enabled = await getNotificationsEnabled(getExecutor())
    cachedEnabled = enabled
    cachedAt = Date.now()
    return enabled
  } catch {
    // No database (e.g. plain vite outside Tauri): fail open to the
    // setting's default, without caching the failure.
    return true
  }
}

/**
 * Flip the notifications setting from the settings UI: persists it via
 * the settings module and refreshes the notifier's cache so the next
 * notifyNewMail sees the new value without waiting for the TTL.
 */
export async function setNotificationsEnabled(enabled: boolean): Promise<void> {
  await setSetting(getExecutor(), SETTINGS_KEYS.notificationsEnabled, enabled)
  cachedEnabled = enabled
  cachedAt = Date.now()
}

// ---------------------------------------------------------------------------
// Permission — resolved at most once per app run
// ---------------------------------------------------------------------------

let permissionState: "unknown" | "granted" | "denied" = "unknown"

/**
 * Ensure notification permission, requesting it at most once (a denial
 * sticks for the app run). Exported for initNotificationSystem()'s
 * startup precheck; notifyNewMail gates on it too. Never rejects.
 */
export async function ensureNotificationPermission(): Promise<boolean> {
  if (permissionState === "granted") return true
  if (permissionState === "denied") return false
  try {
    let granted = await isPermissionGranted()
    if (!granted) {
      granted = (await requestPermission()) === "granted"
    }
    permissionState = granted ? "granted" : "denied"
    return granted
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Coalescing — max one notification per account per window
// ---------------------------------------------------------------------------

const lastNotifiedAt = new Map<string, number>()

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Notify about new mail for one account. Fire-and-forget safe: never
 * rejects. Gates: positive count, enabled setting, granted permission,
 * and the per-account 60s coalescing window (the slot is reserved only
 * once every gate passed, so gated attempts never suppress later ones).
 */
export async function notifyNewMail(event: NewMailEvent): Promise<void> {
  if (event.count <= 0) return

  const last = lastNotifiedAt.get(event.accountId)
  if (last !== undefined && Date.now() - last < COALESCE_WINDOW_MS) return

  if (!(await notificationsEnabled())) return
  if (!(await ensureNotificationPermission())) return

  lastNotifiedAt.set(event.accountId, Date.now())
  try {
    sendNotification({
      title: "New mail",
      body:
        event.count === 1
          ? `1 new message for ${event.accountEmail}`
          : `${event.count} new messages for ${event.accountEmail}`,
    })
  } catch {
    // No OS notification center (or plugin failure) — nothing to do.
  }
}

/** Reset all module state — settings cache, coalescing map, permission
 * memo (tests only, mirroring setSyncAccountImplForTests). */
export function resetNewMailNotifierForTests(): void {
  cachedEnabled = null
  cachedAt = 0
  lastNotifiedAt.clear()
  permissionState = "unknown"
}
