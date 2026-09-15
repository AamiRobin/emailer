import { ensureNotificationPermission } from "./new-mail-notifier"

/**
 * Startup hook for the notification system (task 4.6). Idempotent and
 * deliberately light: the only work is the one-time notification
 * permission precheck, so the first new-mail notification does not have
 * to prompt mid-sync. Everything else (settings cache, coalescing) is
 * lazy inside the notifier.
 *
 * Wiring (bootstrap — intentionally NOT wired here): call once during
 * startup, e.g. after initDatabase():
 *
 *   import { initNotificationSystem } from "@/services/notifications/init-notifications"
 *   initNotificationSystem()
 *
 * Safe outside Tauri: ensureNotificationPermission never rejects and the
 * call is not awaited.
 */
let initialized = false

export function initNotificationSystem(): void {
  if (initialized) return
  initialized = true
  void ensureNotificationPermission()
}
