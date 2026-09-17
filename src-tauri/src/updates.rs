use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, State};
use tauri_plugin_updater::UpdaterExt;

/**
 * Release-channel update checks for the packaged app (docs/releases.md).
 *
 * The upstream plugin's JS `check()` cannot override the manifest
 * endpoint per call, but channel switching needs exactly that — so the
 * UI goes through these commands: Rust picks the channel's static
 * manifest URL (mirrored from src/services/updates/updater.ts), keeps
 * the checked `Update` handle in state, and downloads/installs on the
 * second command, emitting progress events for the settings UI.
 */

/// The two published channels. Keep in sync with docs/releases.md and
/// the `channels` release the workflow uploads manifests to.
const STABLE_ENDPOINT: &str =
    "https://github.com/AamiRobin/emailer/releases/download/channels/latest-stable.json";
const BETA_ENDPOINT: &str =
    "https://github.com/AamiRobin/emailer/releases/download/channels/latest-beta.json";

/// The checked-but-not-installed update. The `Update` handle carries the
/// signed manifest needed to fetch and verify the artifact, so it must
/// survive between the check and the install.
#[derive(Default)]
pub struct UpdatesState(Mutex<Option<tauri_plugin_updater::Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    version: String,
    current_version: String,
    notes: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    received: usize,
    total: Option<u64>,
}

/// Check the given channel ("stable" | "beta") for an update. Returns
/// null when the app is current. The returned metadata is a snapshot —
/// the installable handle stays in state.
#[tauri::command]
pub async fn check_for_update<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, UpdatesState>,
    channel: String,
) -> Result<Option<UpdateMetadata>, String> {
    let endpoint = match channel.as_str() {
        "beta" => BETA_ENDPOINT,
        _ => STABLE_ENDPOINT,
    };
    let url: tauri::Url = endpoint
        .parse()
        .map_err(|e| format!("invalid updater endpoint: {e}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|update| {
        let metadata = UpdateMetadata {
            version: update.version.clone(),
            current_version: update.current_version.clone(),
            notes: update.body.clone(),
        };
        *state.0.lock().unwrap() = Some(update);
        metadata
    }))
}

/// Download the pending update (progress flows to the UI through the
/// `updates://download-*` events) and install it. The app must be
/// relaunched to apply the install.
#[tauri::command]
pub async fn download_and_install_update<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, UpdatesState>,
) -> Result<(), String> {
    let pending = state.0.lock().unwrap().clone();
    let Some(update) = pending else {
        return Err("No update is pending — check for updates first.".into());
    };
    let progress_app = app.clone();
    update
        .download_and_install(
            move |received, total| {
                let _ = progress_app.emit(
                    "updates://download-progress",
                    DownloadProgress { received, total },
                );
            },
            || {
                let _ = app.emit("updates://download-finished", ());
            },
        )
        .await
        .map_err(|e| e.to_string())
}
