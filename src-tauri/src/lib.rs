use tauri::webview::PageLoadEvent;
use tauri_plugin_log::{Target, TargetKind};
use tauri_plugin_opener::OpenerExt;

mod badge;
mod imap;
mod mail_import;
mod net;
mod oauth;
mod smtp;
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
            let is_internal_host = matches!(
                url.host_str(),
                Some("localhost") | Some("127.0.0.1") | Some("tauri.localhost") | Some("::1")
            );

            // App content: the tauri:// custom protocol (prod) and the dev
            // server / loopback hosts (dev).
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
        // Updater + process: in-app update checks and relaunch-after-install
        // (settings "Updates" section). Endpoints and the signing pubkey live
        // in tauri.conf.json plugins.updater; the release workflow signs
        // update artifacts with the TAURI_SIGNING_* secrets.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(external_navigation_plugin())
        .manage(updates::UpdatesState::default())
        .invoke_handler(tauri::generate_handler![
            updates::check_for_update,
            updates::download_and_install_update,
            badge::set_unread_badge,
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
            imap::commands::imap_create_folder,
            imap::commands::imap_rename_folder,
            imap::commands::imap_delete_folder,
            smtp::commands::smtp_send_email,
            smtp::commands::smtp_send_raw_email,
            smtp::commands::smtp_test_connection,
            oauth::start_oauth_server,
            oauth::cancel_oauth_server,
            mail_import::parse_eml_file,
            mail_import::parse_mbox_file,
        ])
        .on_page_load(|webview, payload| {
            if webview.label() == "main" && matches!(payload.event(), PageLoadEvent::Finished) {
                log::info!("main webview finished loading");
                let _ = webview.window().show();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
