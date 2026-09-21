//! Unread badge (task 4.6; tray tooltip extension task 1.2). The frontend
//! pushes the total unread count here at the end of every sync pass:
//!
//! - macOS: dock icon badge via tauri's built-in
//!   `WebviewWindow::set_badge_count` (no extra crates needed);
//! - all platforms with a tray: the tray tooltip becomes
//!   "Emailer — N unread" (desktop.rs), which is how Linux/Windows show
//!   the count outside the app — Windows taskbar overlay icons are out
//!   of scope (tauri marks `set_badge_count` unsupported on Windows).

use tauri::{AppHandle, WebviewWindow};

use crate::desktop;

#[tauri::command]
pub fn set_unread_badge(app: AppHandle, window: WebviewWindow, count: u32) -> Result<(), String> {
    desktop::update_tray_unread(&app, count);

    #[cfg(target_os = "macos")]
    return window
        .set_badge_count(if count > 0 {
            Some(i64::from(count))
        } else {
            None
        })
        .map_err(|error| error.to_string());

    #[cfg(not(target_os = "macos"))]
    {
        let _ = window;
        Ok(())
    }
}
