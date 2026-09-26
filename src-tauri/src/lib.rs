use tauri::webview::PageLoadEvent;
use tauri::Manager;
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_opener::OpenerExt;

mod ai;
mod avatar;
mod badge;
// Minimal CalDAV client + caldav_* commands (task 5.2, design D5).
mod caldav;
// Minimal CardDAV address-book client + carddav_* commands
// (parity-round-2 tasks 4.1–4.3, design D4).
mod carddav;
mod desktop;
mod imap;
mod mail_import;
mod net;
mod oauth;
mod smtp;
// Storage usage + delete-all-local-data commands (tasks 1.6/1.7, D11).
mod storage;
// OS secret-store commands for the credential-sealing key (review L1).
mod secrets;
// One-Click List-Unsubscribe POSTs (RFC 8058).
mod unsubscribe;
mod updates;

// CSP note (tauri.conf.json is plain JSON, so this lives here):
// `script-src` carries two pinned hashes and no `'unsafe-inline'`:
//   - `sha256-ka5fJDC6WqCeQtMKBl4z4MfkyFZlddmyWHvmhJNseFk=` — next-themes'
//     theme-init script. Its bytes are a pure function of the fixed props
//     ThemeProvider passes (`attribute="class"`, `defaultTheme="system"`,
//     `enableSystem`, `disableTransitionOnChange`, `["light","dark"]`,
//     defaults for the rest), so renderToString() of the provider yields a
//     deterministic script body. Hash computed once in
//     _compute-csp-hashes.mjs; if next-themes is ever upgraded, re-run it.
//   - `sha256-Z3Du8nrfS1AJZuAiBe6/aDaV04rs2gNm+ZcmXD51VfY=` — the email
//     frame's resize reporter (safe-email-frame.tsx RESIZE_SCRIPT). The
//     frame is sandboxed opaque-origin, so this is defense-in-depth, not the
//     primary containment.
// `style-src` still needs `'unsafe-inline'`: React renders inline `style={...}`
// attributes throughout the app, and Tauri's CSP is a static string, so there
// is no per-request nonce to mint. Vite already puts all authored CSS in
// external sheets, so no authored `<style>` blocks exist.

fn external_navigation_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::<R>::new("external-navigation")
        .on_navigation(|webview, url| {
            // App content: the tauri:// custom protocol (prod) and
            // tauri.localhost. Debug builds additionally treat the dev
            // server / loopback hosts (any port) as internal; release
            // builds compile that alternative OUT — a shipped app must
            // never mistake an arbitrary localhost server on some port
            // for its own content.
            #[cfg(debug_assertions)]
            let is_internal_host = matches!(
                url.host_str(),
                Some("localhost") | Some("127.0.0.1") | Some("tauri.localhost") | Some("::1")
            );
            #[cfg(not(debug_assertions))]
            let is_internal_host = matches!(url.host_str(), Some("tauri.localhost"));

            let is_internal = url.scheme() == "tauri" || is_internal_host;

            if is_internal {
                return true;
            }

            let is_external_link = matches!(url.scheme(), "http" | "https" | "mailto" | "tel");

            if is_external_link {
                log::info!("opening external link in system browser: {}", url);
                let _ = webview.opener().open_url(url.as_str(), None::<&str>);
                return false;
            }

            // Deny by default: anything not explicitly allowed above (odd
            // schemes, file:, javascript:, ...) must not navigate the
            // webview.
            log::warn!("blocked navigation to non-allowlisted URL: {}", url);
            false
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Single-instance MUST be the first registered plugin (its docs):
        // the callback runs in the primary instance when a second launch is
        // detected, before anything else. The callback surfaces the window
        // and relays any mailto: argument to the running webview (1.3).
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            desktop::surface_main_window(app);
            desktop::relay_deep_link_args(app, &args);
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir { file_name: None }),
                    Target::new(TargetKind::Webview),
                ])
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Launch-at-login (spec desktop-integration "Launch at login"):
        // LaunchAgent on macOS, registry/OpenBox variants elsewhere. The
        // --hidden arg powers the "start hidden in tray" requirement (1.6).
        .plugin(
            tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--hidden"]),
            ),
        )
        // mailto: deep links (spec "Mailto link handling"); schemes live in
        // tauri.conf.json plugins.deep-link.desktop.schemes (bundle time) and
        // are registered at runtime on macOS dev builds in on_run_event use.
        .plugin(tauri_plugin_deep_link::init())
        // Global compose shortcut (spec "Global compose shortcut"); the
        // accelerator and its handler are wired in task 1.5.
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        // Updater + process: in-app update checks and relaunch-after-install
        // (settings "Updates" section). Endpoints and the signing pubkey live
        // in tauri.conf.json plugins.updater; the release workflow signs
        // update artifacts with the TAURI_SIGNING_* secrets.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(external_navigation_plugin())
        .manage(updates::UpdatesState::default())
        .manage(desktop::DesktopState::default())
        // AI assistance (task 4.1, design D1): the shared per-surface
        // rate limiter for ai_chat calls.
        .manage(ai::AiState::default())
        .setup(|app| {
            // System tray (task 1.2): a build failure is the
            // platform-without-tray path (Linux without appindicator) —
            // record it so the settings UI hides the tray controls.
            let tray = desktop::build_tray(app.handle());
            let state = app.state::<desktop::DesktopState>();
            state
                .tray_available
                .store(tray.is_ok(), std::sync::atomic::Ordering::Relaxed);
            if let Err(error) = tray {
                log::warn!("tray unavailable on this platform: {error}");
            }
            // Launch-at-login boots hidden (task 1.6): the autostart
            // registration passes --hidden; remember it for page load.
            state
                .launch_hidden
                .store(desktop::detect_launch_hidden(), std::sync::atomic::Ordering::Relaxed);
            // Splash (task 1.7): show it (skipped for hidden-tray boots)
            // and arm the hard timeout; the shell calls close_splashscreen
            // when ready.
            desktop::init_splash(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ai::ai_chat,
            avatar::gravatar_fetch,
            updates::check_for_update,
            updates::download_and_install_update,
            badge::set_unread_badge,
            desktop::set_close_action,
            desktop::get_close_action,
            desktop::tray_available,
            desktop::mailto_default_state,
            desktop::mailto_set_default,
            desktop::initial_deep_links,
            desktop::set_global_compose_shortcut,
            desktop::autostart_is_enabled,
            desktop::autostart_set_enabled,
            desktop::close_splashscreen,
            desktop::open_thread_popout,
            desktop::force_close_popout,
            imap::commands::imap_test_connection,
            imap::commands::imap_list_folders,
            imap::commands::imap_fetch_messages,
            imap::commands::imap_fetch_flags,
            imap::commands::imap_fetch_flags_changed,
            imap::commands::imap_store_flags,
            imap::commands::imap_move_message,
            imap::commands::imap_delete_message,
            imap::commands::imap_append,
            imap::commands::imap_fetch_attachment,
            imap::commands::imap_fetch_source,
            imap::commands::imap_create_folder,
            imap::commands::imap_rename_folder,
            imap::commands::imap_delete_folder,
            smtp::commands::smtp_send_email,
            smtp::commands::smtp_send_raw_email,
            smtp::commands::smtp_test_connection,
            oauth::find_free_loopback_port,
            oauth::start_oauth_server,
            oauth::cancel_oauth_server,
            caldav::caldav_test_connection,
            caldav::caldav_discover,
            caldav::caldav_sync,
            caldav::caldav_put_event,
            caldav::caldav_delete_event,
            carddav::carddav_discover_books,
            carddav::carddav_sync_book,
            carddav::carddav_put_card,
            carddav::carddav_delete_card,
            mail_import::parse_eml_file,
            mail_import::parse_mbox_file,
            storage::storage_usage,
            storage::delete_all_local_data,
            storage::restrict_credentials_key_permissions,
            secrets::credentials_key_os_store,
            secrets::credentials_key_os_load,
            secrets::credentials_key_os_delete,
            unsubscribe::unsubscribe_one_click_post,
        ])
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && matches!(payload.event(), PageLoadEvent::Finished) {
                log::info!("main webview finished loading");
                // The splash owns boot visibility (finish_splash shows the
                // main window on shell-ready or at the hard timeout). The
                // only page-load action is the hidden-boot fallback: no
                // tray → show + minimize so the window stays findable.
                let window = webview.window();
                let state = webview.app_handle().state::<desktop::DesktopState>();
                if state.launch_hidden.load(std::sync::atomic::Ordering::Relaxed)
                    && !state.tray_available.load(std::sync::atomic::Ordering::Relaxed)
                {
                    let _ = window.show();
                    let _ = window.minimize();
                }
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                use tauri::Emitter;
                let label = window.label();
                // Pop-out close guard (task 1.9, spec "Pop-out thread
                // windows"): closing with a live draft must prompt. The
                // request is held and re-emitted to the pop-out's webview,
                // which owns the composer dirty state and either invokes
                // force_close_popout or cancels.
                if label.starts_with(desktop::POPOUT_LABEL_PREFIX) {
                    api.prevent_close();
                    let _ = window.app_handle().emit_to(
                        label,
                        desktop::POPOUT_CLOSE_REQUESTED_EVENT,
                        (),
                    );
                    return;
                }
                // Close-to-tray (task 1.2, spec "System tray"): with the
                // "hide" action the OS close (and the custom titlebar's
                // close, which routes through the same request) hides the
                // window instead of destroying it — sync and notifications
                // keep running.
                if label == desktop::MAIN_WINDOW_LABEL {
                    let state: tauri::State<desktop::DesktopState> =
                        window.app_handle().state();
                    if state.close_action() == desktop::CloseAction::Hide {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
