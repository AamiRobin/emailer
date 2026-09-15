import { invoke } from "@tauri-apps/api/core"

/**
 * Unread badge bridge (task 4.6). Pushes the total unread count to the
 * OS badge through the `set_unread_badge` Rust command:
 *
 * - macOS: dock icon badge, using tauri's built-in
 *   `WebviewWindow::set_badge_count` (pinned tauri 2.11 exposes it);
 * - Linux/Windows: the Rust command is a documented no-op — those
 *   platforms show the per-account counts in the account switcher UI
 *   instead (Windows taskbar overlay icons are out of scope here).
 *
 * `0` clears the badge. Best-effort by design: any failure (plain vite
 * outside Tauri, unsupported platform) is swallowed so badge updates can
 * ride along at the end of a sync pass.
 */
export async function updateUnreadBadge(totalUnread: number): Promise<void> {
  try {
    await invoke("set_unread_badge", { count: totalUnread })
  } catch {
    // The badge is cosmetic; never let it break a sync pass or startup.
  }
}
