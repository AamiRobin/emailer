//! Unread badge (task 4.6). Sets the macOS dock icon badge from the
//! frontend via tauri's built-in `WebviewWindow::set_badge_count` (no
//! extra crates needed). Other platforms are a deliberate no-op: Linux
//! and Windows show the per-account unread counts in the account
//! switcher UI instead — Windows taskbar overlay icons are out of scope
//! for this task (tauri itself marks `set_badge_count` unsupported on
//! Windows).

#[cfg(target_os = "macos")]
use tauri::WebviewWindow;

/// Set the dock badge to `count` unread messages; `0` clears it.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn set_unread_badge(window: WebviewWindow, count: u32) -> Result<(), String> {
    window
        .set_badge_count(if count > 0 {
            Some(i64::from(count))
        } else {
            None
        })
        .map_err(|error| error.to_string())
}

/// No-op off macOS (see module docs): the badge is dock-only by design.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn set_unread_badge(count: u32) -> Result<(), String> {
    let _ = count;
    Ok(())
}
