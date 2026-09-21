//! Desktop integration (Phase 1, spec desktop-integration). The tray half
//! of the module lives here; autostart/deep-link/global-shortcut commands
//! join as their tasks land.
//!
//! Architecture note: the close-to-tray choice is stored in the SQLite
//! settings table, which the webview owns (tauri-plugin-sql). Rust only
//! keeps the *live* value in managed state — the frontend pushes it at
//! boot and on every change (`set_close_action`), mirroring how the
//! unread badge is a webview-computed value pushed through a command.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{
    menu::{MenuBuilder, MenuItem},
    tray::{TrayIcon, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, State,
};

pub const TRAY_ID: &str = "emailer-tray";
pub const MAIN_WINDOW_LABEL: &str = "main";
pub const SPLASH_WINDOW_LABEL: &str = "splashscreen";
/// Hard timeout for the splash window (task 1.7): the shell normally
/// signals ready well within this; a slow or failed init still lands the
/// user on the main window instead of a stuck splash.
pub const SPLASH_TIMEOUT_SECS: u64 = 8;
/// Emitted to the main window when a desktop trigger asks for a fresh
/// composer — currently the tray menu's Compose item (1.2) and the global
/// compose shortcut (1.5). The shell opens a new draft on it.
pub const COMPOSE_REQUEST_EVENT: &str = "compose-request";

/// What closing the main window does. `Hide` keeps sync and notifications
/// running in the background (spec "Close to tray"); `Quit` exits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CloseAction {
    Quit,
    Hide,
}

impl CloseAction {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "quit" => Some(Self::Quit),
            "hide" => Some(Self::Hide),
            _ => None,
        }
    }
}

/// Managed state: the live close action, whether the platform gave us
/// a tray (Linux without appindicator fails tray construction at startup —
/// the settings UI hides the tray-dependent controls in that case), and
/// the registered global compose accelerator (so a new registration can
/// unregister the previous one).
#[derive(Default)]
pub struct DesktopState {
    close_action: Mutex<Option<CloseAction>>,
    pub tray_available: AtomicBool,
    compose_shortcut: Mutex<Option<String>>,
    /// Set at startup when the process was launched with `--hidden` (the
    /// autostart registration's argument): the main window stays hidden
    /// on page load (or minimizes where no tray exists to park in).
    pub launch_hidden: AtomicBool,
}

impl DesktopState {
    pub fn close_action(&self) -> CloseAction {
        *self
            .close_action
            .lock()
            .expect("close_action mutex poisoned")
            .get_or_insert(CloseAction::Quit)
    }
}

fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Surface the main window from Rust-side triggers (single-instance relay,
/// tray menu). Exposed for lib.rs's single-instance callback.
pub fn surface_main_window<R: Runtime>(app: &AppHandle<R>) {
    show_main_window(app)
}

/// Relay second-launch deep-link arguments (task 1.3): a `mailto:` URL in
/// the second process's argv is re-emitted to the running instance with
/// the exact payload shape the deep-link plugin uses
/// (`deep-link://new-url`, a JSON URL array), so the webview listens once
/// for cold-start (plugin scans argv on Win/Linux, RunEvent::Opened on
/// macOS) and warm-start (this relay) alike.
pub fn relay_deep_link_args<R: Runtime>(app: &AppHandle<R>, args: &[String]) {
    for arg in args {
        if let Ok(url) = arg.parse::<tauri::Url>() {
            if url.scheme() == "mailto" {
                let _ = app.emit("deep-link://new-url", vec![url.to_string()]);
            }
        }
    }
}

/// Build the tray icon (id `emailer-tray`): Open / Compose / Quit menu,
/// left-click surfaces the window, right-click opens the menu. Returns
/// the built icon so the caller can record tray availability; a build
/// failure is the platform-without-tray path and is reported, not fatal.
pub fn build_tray<R: Runtime>(app: &AppHandle<R>) -> Result<TrayIcon<R>, tauri::Error> {
    let open = MenuItem::with_id(app, "tray-open", "Open Emailer", true, None::<&str>)?;
    let compose = MenuItem::with_id(app, "tray-compose", "Compose", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "Quit", true, None::<&str>)?;
    let menu = MenuBuilder::new(app).items(&[&open, &compose, &quit]).build()?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("Emailer")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "tray-open" => show_main_window(app),
            "tray-compose" => {
                show_main_window(app);
                let _ = app.emit_to(MAIN_WINDOW_LABEL, COMPOSE_REQUEST_EVENT, ());
            }
            "tray-quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)
}

/// Set the tray tooltip to the unread count ("Emailer — N unread"); an
/// empty count resets to the bare app name. Best-effort: Linux tray
/// implementations vary in tooltip support.
pub fn update_tray_unread<R: Runtime>(app: &AppHandle<R>, count: u32) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let tooltip = if count > 0 {
            format!("Emailer — {count} unread")
        } else {
            "Emailer".to_string()
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

// ---------------------------------------------------------------------------
// Mailto default-handler control (task 1.4, spec "Mailto link handling")
// ---------------------------------------------------------------------------

/// macOS LaunchServices: the only programmatic way to read/set the
/// default `mailto:` handler. The previous default is NOT recoverable via
/// API once we take over, so the frontend records it before switching
/// (`mailto_set_default(true)` is only called after it captured
/// `mailto_default_state()`), and hands it back for restore.
#[cfg(target_os = "macos")]
mod default_handler {
    use core_foundation::base::TCFType;
    use core_foundation::string::CFString;
    use std::ffi::c_void;

    #[link(name = "CoreServices", kind = "framework")]
    extern "C" {
        fn LSCopyDefaultHandlerForURLScheme(scheme: *const c_void) -> *const c_void;
        fn LSSetDefaultHandlerForURLScheme(scheme: *const c_void, handler: *const c_void);
    }

    /// The bundle id of the current default handler for `scheme`, or None
    /// when LaunchServices reports none.
    pub fn current_handler(scheme: &str) -> Option<String> {
        let scheme_cf = CFString::new(scheme);
        unsafe {
            let raw = LSCopyDefaultHandlerForURLScheme(scheme_cf.as_concrete_TypeRef() as *const c_void);
            if raw.is_null() {
                return None;
            }
            Some(CFString::wrap_under_create_rule(raw as *const _).to_string())
        }
    }

    /// Point `scheme` at `bundle_id`. Only meaningful when the app is
    /// registered as a handler (bundle Info.plist carries the scheme —
    /// true for bundled builds via plugins.deep-link.desktop.schemes).
    pub fn set_handler(scheme: &str, bundle_id: &str) {
        let scheme_cf = CFString::new(scheme);
        let handler_cf = CFString::new(bundle_id);
        unsafe {
            LSSetDefaultHandlerForURLScheme(
                scheme_cf.as_concrete_TypeRef() as *const c_void,
                handler_cf.as_concrete_TypeRef() as *const c_void,
            );
        }
    }
}

/// The mailto URLs that launched THIS process (cold start, task 1.4):
/// the startup event fires before the webview exists, so the frontend
/// queries these once at shell boot. Only mailto links are returned.
#[tauri::command]
pub fn initial_deep_links(app: AppHandle) -> Vec<String> {
    use tauri_plugin_deep_link::DeepLinkExt;

    app.deep_link()
        .get_current()
        .unwrap_or_default()
        .map(|urls| {
            urls.into_iter()
                .filter(|url| url.scheme().eq_ignore_ascii_case("mailto"))
                .map(|url| url.to_string())
                .collect()
        })
        .unwrap_or_default()
}

/// The bundle id macOS falls back to when unsetting without a recorded
/// previous handler (the OS default mail client on a stock system).
#[cfg(target_os = "macos")]
const MACOS_FALLBACK_MAIL: &str = "com.apple.mail";

/// Whether Emailer is the OS's default `mailto:` handler, plus the
/// current handler's bundle id (the value the frontend records before a
/// takeover so "unset" can restore the actual previous client).
#[tauri::command]
pub fn mailto_default_state(app: AppHandle) -> Result<MailtoDefaultState, String> {
    let bundle_id = app.config().identifier.clone();

    #[cfg(target_os = "macos")]
    {
        let current = default_handler::current_handler("mailto");
        Ok(MailtoDefaultState {
            is_default: current.as_deref() == Some(bundle_id.as_str()),
            current_handler: current,
        })
    }

    #[cfg(not(target_os = "macos"))]
    {
        let is_default = app
            .deep_link()
            .is_registered("mailto")
            .map_err(|error| error.to_string())?;
        Ok(MailtoDefaultState {
            is_default,
            current_handler: if is_default { Some(bundle_id) } else { None },
        })
    }
}

#[derive(serde::Serialize)]
pub struct MailtoDefaultState {
    pub is_default: bool,
    /// The bundle id currently owning `mailto:` (macOS only reports other
    /// handlers; Windows/Linux report our own when registered).
    pub current_handler: Option<String>,
}

/// Set or unset Emailer as the default `mailto:` handler.
///
/// `restore_to` carries the recorded previous handler for the macOS
/// unset path (LaunchServices cannot enumerate "the previous default"
/// after we take over — the caller saved it from `mailto_default_state`).
#[tauri::command]
pub fn mailto_set_default(
    app: AppHandle,
    enabled: bool,
    restore_to: Option<String>,
) -> Result<(), String> {
    let bundle_id = app.config().identifier.clone();

    #[cfg(target_os = "macos")]
    {
        if enabled {
            default_handler::set_handler("mailto", &bundle_id);
        } else {
            default_handler::set_handler(
                "mailto",
                restore_to.as_deref().unwrap_or(MACOS_FALLBACK_MAIL),
            );
        }
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = restore_to;
        if enabled {
            app.deep_link()
                .register("mailto")
                .map_err(|error| error.to_string())
        } else {
            app.deep_link()
                .unregister("mailto")
                .map_err(|error| error.to_string())
        }
    }
}

// ---------------------------------------------------------------------------
// Global compose shortcut (task 1.5, spec "Global compose shortcut")
// ---------------------------------------------------------------------------

/// Register (Some) or clear (None) the system-wide compose shortcut. The
/// accelerator string is the user-facing format ("CmdOrCtrl+Shift+Space");
/// parse/registration failures are reported so the settings UI can show
/// exactly why a binding was rejected (OS-level conflicts included — the
/// global-shortcut plugin surfaces them as register errors).
pub fn apply_global_compose_shortcut<R: Runtime>(
    app: &AppHandle<R>,
    accelerator: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let state = app.state::<DesktopState>();
    let mut current = state
        .compose_shortcut
        .lock()
        .expect("compose_shortcut mutex poisoned");

    // Clearing replaces the registration; a rebind first drops the old
    // accelerator so the OS frees the keystroke immediately.
    if let Some(previous) = current.take() {
        let _ = app.global_shortcut().unregister(previous.as_str());
    }

    if let Some(accelerator) = accelerator {
        app.global_shortcut()
            .on_shortcut(accelerator.as_str(), |app, _shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    surface_main_window(app);
                    let _ = app.emit_to(MAIN_WINDOW_LABEL, COMPOSE_REQUEST_EVENT, ());
                }
            })
            .map_err(|error| format!("failed to register {accelerator:?}: {error}"))?;
        *current = Some(accelerator);
    }

    Ok(())
}

/// Push the user's configured accelerator (or null to clear). Invoked at
/// boot and on every settings change.
#[tauri::command]
pub fn set_global_compose_shortcut(
    app: AppHandle,
    accelerator: Option<String>,
) -> Result<(), String> {
    apply_global_compose_shortcut(&app, accelerator)
}

// ---------------------------------------------------------------------------
// Launch at login (task 1.6, spec "Launch at login")
// ---------------------------------------------------------------------------

/// Whether the OS currently has the app registered for launch-at-login.
#[tauri::command]
pub fn autostart_is_enabled(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

/// Enable (registers with the OS; the launch carries `--hidden`, configured
/// at plugin init) or disable (removes the registration) launch-at-login.
#[tauri::command]
pub fn autostart_set_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let autostart = app.autolaunch();
    if enabled {
        autostart.enable().map_err(|error| error.to_string())
    } else {
        autostart.disable().map_err(|error| error.to_string())
    }
}

/// Whether this process was launched hidden (the `--hidden` autostart
/// argument). Called from lib.rs's setup.
pub fn detect_launch_hidden() -> bool {
    std::env::args().any(|arg| arg == "--hidden")
}

/// Show the splash (unless this is a hidden autostart boot with a tray to
/// park in — a splash flash would defeat the hidden start) and arm the
/// hard timeout. Called from lib.rs's setup.
pub fn init_splash<R: Runtime>(app: &AppHandle<R>) {
    let state = app.state::<DesktopState>();
    let hidden_tray_boot = state.launch_hidden.load(Ordering::Relaxed)
        && state.tray_available.load(Ordering::Relaxed);

    if let Some(splash) = app.get_webview_window(SPLASH_WINDOW_LABEL) {
        if hidden_tray_boot {
            let _ = splash.close();
        } else {
            let _ = splash.show();
        }
    }

    if !hidden_tray_boot {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(SPLASH_TIMEOUT_SECS)).await;
            finish_splash(&handle);
        });
    }
}

/// End the splash: close it and land on the main window (unless this is a
/// hidden autostart boot — parked in the tray, or already shown+minimized
/// by the page-load fallback). Idempotent; drives both the shell-ready
/// path and the hard timeout.
pub fn finish_splash<R: Runtime>(app: &AppHandle<R>) {
    if let Some(splash) = app.get_webview_window(SPLASH_WINDOW_LABEL) {
        let _ = splash.close();
    }
    let state = app.state::<DesktopState>();
    if state.launch_hidden.load(Ordering::Relaxed) {
        return;
    }
    surface_main_window(app);
}

/// Shell-ready signal (task 1.7): the frontend invokes this once the
/// React shell finished bootstrapping (database ready).
#[tauri::command]
pub fn close_splashscreen(app: AppHandle) {
    finish_splash(&app);
}

// ---------------------------------------------------------------------------
// Pop-out thread windows (task 1.9, spec "Pop-out thread windows")
// ---------------------------------------------------------------------------

pub const POPOUT_LABEL_PREFIX: &str = "popout-";
/// Emitted to a pop-out window when a close was requested (OS control or
/// the custom titlebar): the webview runs the draft guard, then either
/// invokes `force_close_popout` or cancels.
pub const POPOUT_CLOSE_REQUESTED_EVENT: &str = "popout-close-requested";

/// Thread ids are uuid-shaped, but never trust external strings for a
/// window label: Tauri labels allow alphanumerics plus `-`, `/`, `_`,
/// `.` and ` ` — anything else is folded to `_`.
fn sanitize_label_part(part: &str) -> String {
    part.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | ' ') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Open (or focus, if one already exists) a pop-out window showing
/// `thread_id`. The window loads the normal app bundle; the webview
/// recognizes itself by its window label (`popout-<threadId>`) and
/// renders the pop-out surface — no separate route file needed.
#[tauri::command]
pub fn open_thread_popout(app: AppHandle, thread_id: String) -> Result<String, String> {
    let label = format!("{}{}", POPOUT_LABEL_PREFIX, sanitize_label_part(&thread_id));

    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.unminimize();
        let _ = existing.set_focus();
        return Ok(label);
    }

    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Emailer")
    .inner_size(900.0, 700.0)
    .min_inner_size(560.0, 420.0)
    .visible(false);

    // Same titlebar split as the main window (D8): macOS keeps the
    // native traffic lights over the webview; Windows/Linux go
    // undecorated and render the custom controls.
    #[cfg(target_os = "macos")]
    {
        builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay);
    }
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.decorations(false);
    }

    builder
        .build()
        .map_err(|error| format!("failed to open pop-out window: {error}"))?;
    Ok(label)
}

/// Force-close a pop-out window, bypassing the draft guard (the webview
/// invokes this only after the guard resolved). Popouts only — the label
/// prefix is checked so this can never close the main window.
#[tauri::command]
pub fn force_close_popout(app: AppHandle, label: String) -> Result<(), String> {
    if !label.starts_with(POPOUT_LABEL_PREFIX) {
        return Err(format!("not a pop-out window label: {label:?}"));
    }
    let Some(window) = app.get_webview_window(&label) else {
        return Ok(());
    };
    // destroy() skips CloseRequested (which the guard deliberately
    // prevents); close() would re-enter the guard forever.
    window
        .destroy()
        .map_err(|error| format!("failed to close pop-out: {error}"))
}

// ---------------------------------------------------------------------------
// Commands (invoked from the webview)
// ---------------------------------------------------------------------------

/// Push the persisted close-action preference into the live state (called
/// at boot and whenever the setting changes).
#[tauri::command]
pub fn set_close_action(
    state: State<'_, DesktopState>,
    action: String,
) -> Result<(), String> {
    let parsed = CloseAction::parse(&action).ok_or_else(|| {
        format!("invalid close action: expected \"quit\" or \"hide\", got {action:?}")
    })?;
    *state
        .close_action
        .lock()
        .expect("close_action mutex poisoned") = Some(parsed);
    Ok(())
}

/// The live close action (the frontend reads the persisted value from its
/// own settings table; this is the Rust-side source of truth for tests).
#[tauri::command]
pub fn get_close_action(state: State<'_, DesktopState>) -> String {
    match state.close_action() {
        CloseAction::Quit => "quit".to_string(),
        CloseAction::Hide => "hide".to_string(),
    }
}

/// Whether a tray icon exists on this platform — the settings section
/// hides tray-dependent controls when it is false (spec: "Where the
/// platform has no tray, the app SHALL behave as a normal windowed
/// application without these controls").
#[tauri::command]
pub fn tray_available(state: State<'_, DesktopState>) -> bool {
    state.tray_available.load(Ordering::Relaxed)
}
