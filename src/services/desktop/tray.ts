import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"

/**
 * Desktop-integration bridge (task 1.2, spec desktop-integration): thin
 * typed wrappers over the Rust commands and events the tray feature
 * needs. Like unread-badge.ts, everything is best-effort — outside the
 * Tauri runtime (plain-vite mock mode) the commands/events fail and the
 * wrappers degrade (tray reported unavailable, no-op unsubscribe), which
 * is exactly the spec's platform-without-tray behavior.
 */

/** The Rust side emits this to the main window when a desktop trigger
 * asks for a fresh composer: the tray menu's Compose item (1.2) and the
 * global compose shortcut (1.5) — desktop.rs COMPOSE_REQUEST_EVENT. */
const COMPOSE_REQUEST_EVENT = "compose-request"

/**
 * Whether the platform provided a tray icon. Drives the settings UI's
 * tray-dependent controls (spec: hide them where there is no tray).
 */
export async function isTrayAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>("tray_available")
  } catch {
    return false
  }
}

/**
 * Ask the OS whether the app is registered for launch-at-login (the OS
 * registration is the persistence — the toggle always reflects it).
 */
export async function isAutostartEnabled(): Promise<boolean> {
  try {
    return await invoke<boolean>("autostart_is_enabled")
  } catch {
    return false
  }
}

/**
 * Register (true) or unregister (false) launch-at-login. The registered
 * launch carries the --hidden argument, so an autostart boot parks the
 * app in the tray (or minimizes where no tray exists).
 */
export async function setAutostartEnabled(enabled: boolean): Promise<void> {
  try {
    await invoke("autostart_set_enabled", { enabled })
  } catch (error) {
    console.warn("[desktop] autostart registration failed", error)
    throw error
  }
}


/**
 * Subscribe to desktop compose requests (tray menu / global shortcut).
 * Resolves to an unsubscribe function; a non-Tauri runtime resolves to a
 * no-op unsubscribe instead of rejecting, so callers can wire it
 * fire-and-forget.
 */
export async function onComposeRequest(
  handler: () => void
): Promise<() => void> {
  try {
    const unlisten = await listen(COMPOSE_REQUEST_EVENT, handler)
    return unlisten
  } catch {
    return () => {}
  }
}
