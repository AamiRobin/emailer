//! Shared pinned-model downloader (parity-round-3 task 1.4, design D1/D3).
//!
//! One streaming command both local-AI features build on: `download_model`
//! fetches a HuggingFace model file (BGE-small-en-v1.5 for embeddings,
//! ggml-base for voice) over HTTP into a temp file inside the destination
//! directory, reports progress through `models://download-*` events,
//! verifies the SHA-256 of the FULL downloaded file against the caller's
//! pinned expectation, and only then renames the temp file into place —
//! a partial or tampered download never becomes the model file.
//!
//! `cancel_model_download` flips a per-model flag the stream loop checks
//! between chunks; cancellation deletes the temp file and reports a typed
//! `cancelled` error.
//!
//! Rust NEVER executes app SQL in this project: persistence of download
//! state is the frontend's job (migration v21 `model_downloads`, updated
//! by TS from these events and return values). This module only moves
//! bytes.

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Runtime, State};

/// Progress events (`{modelId, received, total}`), emitted at most once
/// per [`PROGRESS_EMIT_INTERVAL`] bytes — the same channel shape the
/// updater uses (`updates://download-progress`).
pub const PROGRESS_EVENT: &str = "models://download-progress";
/// Emitted once after the atomic rename: `{modelId, path, bytes, sha256}`.
pub const FINISHED_EVENT: &str = "models://download-finished";
/// Emitted when a cancellation won the race: `{modelId}`.
pub const CANCELLED_EVENT: &str = "models://download-cancelled";

/// Minimum progress delta between two progress events (256 KiB keeps a
/// 110–150 MB download at a few hundred events instead of thousands).
const PROGRESS_EMIT_INTERVAL: u64 = 256 * 1024;

/// Live-download registry: one cancel flag per running `model_id`. The
/// entry is inserted by `download_model` and removed when the download
/// settles, so a second download of the same model is refused while one
/// is in flight and `cancel_model_download` reports false for unknown
/// models.
#[derive(Default)]
pub struct ModelDownloadsState(Mutex<HashMap<String, Arc<AtomicBool>>>);

// ---------- Command results / errors ----------

/// The command's success payload. `path` is the final (renamed) file,
/// `bytes` the streamed length, `sha256` the hex digest of the file on
/// disk (equal to `expectedSha256` — the command fails otherwise).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
}

/// Typed error for both download commands — the `kind` string is stable
/// so the TS layer can branch (`checksum_mismatch` → refuse activation
/// and offer a re-download, `cancelled` → silent cleanup, `network` /
/// `io` → retryable, `already_running` → ignore double clicks) without
/// parsing prose (the ai module's precedent).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelDownloadError {
    kind: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    actual_sha256: Option<String>,
}

impl ModelDownloadError {
    fn network(message: String) -> Self {
        Self {
            kind: "network".into(),
            message,
            expected_sha256: None,
            actual_sha256: None,
        }
    }

    fn io(message: String) -> Self {
        Self {
            kind: "io".into(),
            message,
            expected_sha256: None,
            actual_sha256: None,
        }
    }

    fn config(message: String) -> Self {
        Self {
            kind: "config".into(),
            message,
            expected_sha256: None,
            actual_sha256: None,
        }
    }

    fn cancelled() -> Self {
        Self {
            kind: "cancelled".into(),
            message: "download cancelled".into(),
            expected_sha256: None,
            actual_sha256: None,
        }
    }

    fn already_running(model_id: &str) -> Self {
        Self {
            kind: "already_running".into(),
            message: format!("a download for model {model_id} is already in progress"),
            expected_sha256: None,
            actual_sha256: None,
        }
    }

    fn checksum_mismatch(expected: &str, actual: &str) -> Self {
        Self {
            kind: "checksum_mismatch".into(),
            message: format!(
                "SHA-256 mismatch: expected {expected}, downloaded file hashes to {actual}"
            ),
            expected_sha256: Some(expected.into()),
            actual_sha256: Some(actual.into()),
        }
    }
}

// ---------- Event sink ----------

/// Progress/finish/cancel notifications. A trait (not a bare closure) so
/// the unit tests can collect events without a Tauri app while the
/// command wraps an `AppHandle` — the mock-runtime app in tests would
/// still work, but a collector also asserts exactly what was emitted.
trait DownloadEvents: Send + Sync {
    fn progress(&self, _received: u64, _total: Option<u64>) {}
    fn cancelled(&self) {}
    fn finished(&self, _result: &DownloadResult) {}
}

struct TauriDownloadEvents<R: Runtime> {
    app: AppHandle<R>,
    model_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload<'a> {
    model_id: &'a str,
    received: u64,
    total: Option<u64>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FinishedPayload<'a> {
    model_id: &'a str,
    path: &'a str,
    bytes: u64,
    sha256: &'a str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CancelledPayload<'a> {
    model_id: &'a str,
}

impl<R: Runtime> DownloadEvents for TauriDownloadEvents<R> {
    fn progress(&self, received: u64, total: Option<u64>) {
        let _ = self.app.emit(
            PROGRESS_EVENT,
            ProgressPayload { model_id: &self.model_id, received, total },
        );
    }

    fn cancelled(&self) {
        let _ = self
            .app
            .emit(CANCELLED_EVENT, CancelledPayload { model_id: &self.model_id });
    }

    fn finished(&self, result: &DownloadResult) {
        let _ = self.app.emit(
            FINISHED_EVENT,
            FinishedPayload {
                model_id: &self.model_id,
                path: &result.path,
                bytes: result.bytes,
                sha256: &result.sha256,
            },
        );
    }
}

// ---------- The commands ----------

/// Stream `url` into `dest_dir`, verify SHA-256, rename into place.
///
/// The final file name is the URL's last path segment. The download lands
/// in `dest_dir` as `.<filename>.<model_id>.part` first, so an
/// interrupted or cancelled run never leaves a half-written file under
/// the real name. On success the caller gets [`DownloadResult`] plus the
/// `models://download-finished` event; the frontend records the state row
/// (Rust never touches the app database).
#[tauri::command]
pub async fn download_model<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ModelDownloadsState>,
    model_id: String,
    url: String,
    expected_sha256: String,
    dest_dir: String,
) -> Result<DownloadResult, ModelDownloadError> {
    let cancel = register_download(&state, &model_id)?;
    let events = TauriDownloadEvents { app, model_id: model_id.clone() };
    let result = run_download(
        &model_id,
        &url,
        &expected_sha256,
        Path::new(&dest_dir),
        &cancel,
        &events,
    )
    .await;
    // Settled (ok, cancelled, failed): the registry entry must go, so a
    // retry is not refused and cancel stops reporting the model as live.
    state
        .0
        .lock()
        .expect("model downloads registry")
        .remove(&model_id);
    result
}

/// Flag the running download for `model_id`. Returns false when nothing
/// is running for that id (the frontend treats that as a no-op cleanup).
#[tauri::command]
pub fn cancel_model_download(
    state: State<'_, ModelDownloadsState>,
    model_id: String,
) -> Result<bool, ModelDownloadError> {
    Ok(flag_cancel(&state, &model_id))
}

// ---------- The streaming worker ----------

/// The download pipeline, factored out of the command so the unit tests
/// can drive it against a local TCP server without a Tauri app.
async fn run_download(
    model_id: &str,
    url: &str,
    expected_sha256: &str,
    dest_dir: &Path,
    cancel: &AtomicBool,
    events: &dyn DownloadEvents,
) -> Result<DownloadResult, ModelDownloadError> {
    let expected = normalize_sha256(expected_sha256)?;

    // The destination directory is created on demand (the settings UI
    // points this at an app-scoped models directory that may not exist
    // on first download).
    std::fs::create_dir_all(dest_dir)
        .map_err(|error| ModelDownloadError::io(format!("create dest_dir: {error}")))?;

    let filename = filename_from_url(url)?;
    let temp_path = temp_path_for(dest_dir, &filename, model_id);

    // Per-chunk cancel checks make cancellation latency one chunk, not
    // one file; the flag is honored before any byte moves, too.
    if cancel.load(Ordering::SeqCst) {
        return Err(ModelDownloadError::cancelled());
    }

    // Explicit connect/read timeouts: the default client has none, so a
    // stalled connection would hang stream.next() forever — the cancel
    // flag is only observed between chunks, and a wedged download would
    // hold its registry entry (every retry answering already_running)
    // until the app restarts. The read timeout bounds each body read, so
    // a stall errors into the normal cleanup paths.
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|error| ModelDownloadError::network(error.to_string()))?;
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| ModelDownloadError::network(error.to_string()))?;
    if !response.status().is_success() {
        return Err(ModelDownloadError::network(format!(
            "HTTP {} for {url}",
            response.status().as_u16()
        )));
    }
    let total = response.content_length();

    let mut temp = File::create(&temp_path)
        .map_err(|error| ModelDownloadError::io(format!("create temp file: {error}")))?;
    let mut stream = response.bytes_stream();
    let mut received: u64 = 0;
    let mut last_emitted: u64 = 0;
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            drop(temp);
            let _ = std::fs::remove_file(&temp_path);
            events.cancelled();
            return Err(ModelDownloadError::cancelled());
        }
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                drop(temp);
                let _ = std::fs::remove_file(&temp_path);
                return Err(ModelDownloadError::network(error.to_string()));
            }
        };
        if let Err(error) = temp.write_all(&chunk) {
            drop(temp);
            let _ = std::fs::remove_file(&temp_path);
            return Err(ModelDownloadError::io(format!("write temp file: {error}")));
        }
        received += chunk.len() as u64;
        if received - last_emitted >= PROGRESS_EMIT_INTERVAL {
            last_emitted = received;
            events.progress(received, total);
        }
    }
    if let Err(error) = temp.sync_all() {
        drop(temp);
        let _ = std::fs::remove_file(&temp_path);
        return Err(ModelDownloadError::io(format!("flush temp file: {error}")));
    }
    drop(temp);
    events.progress(received, total);

    // Verify the FULL file as it now exists on disk (not the streamed
    // bytes): the digest the caller pinned vouches for exactly the bytes
    // the rename is about to promote. Hashing ~150 MB is multi-second
    // disk work — off the async runtime, like every other heavy call in
    // this crate.
    let hash_task = tokio::task::spawn_blocking({
        let temp_path = temp_path.clone();
        move || sha256_hex_of_file(&temp_path)
    });
    let actual = match hash_task.await {
        Ok(Ok(actual)) => actual,
        Ok(Err(error)) => {
            let _ = std::fs::remove_file(&temp_path);
            return Err(error);
        }
        Err(error) => {
            let _ = std::fs::remove_file(&temp_path);
            return Err(ModelDownloadError::io(format!(
                "hash task failed: {error}"
            )));
        }
    };
    if actual != expected {
        let _ = std::fs::remove_file(&temp_path);
        return Err(ModelDownloadError::checksum_mismatch(&expected, &actual));
    }

    // Same-directory rename: atomic on all three desktop platforms.
    let dest_path = dest_dir.join(&filename);
    if let Err(error) = std::fs::rename(&temp_path, &dest_path) {
        let _ = std::fs::remove_file(&temp_path);
        return Err(ModelDownloadError::io(format!("rename into place: {error}")));
    }

    let result = DownloadResult {
        path: dest_path.to_string_lossy().into_owned(),
        bytes: received,
        sha256: actual,
    };
    events.finished(&result);
    Ok(result)
}

// ---------- Helpers ----------

/// Insert the model's cancel flag, refusing a second concurrent download
/// of the same id. Factored out of the command for direct unit tests.
fn register_download(
    state: &ModelDownloadsState,
    model_id: &str,
) -> Result<Arc<AtomicBool>, ModelDownloadError> {
    let mut registry = state.0.lock().expect("model downloads registry");
    if registry.contains_key(model_id) {
        return Err(ModelDownloadError::already_running(model_id));
    }
    let flag = Arc::new(AtomicBool::new(false));
    registry.insert(model_id.to_string(), flag.clone());
    Ok(flag)
}

/// Set the model's cancel flag; false when no download is running.
fn flag_cancel(state: &ModelDownloadsState, model_id: &str) -> bool {
    let flag = state
        .0
        .lock()
        .expect("model downloads registry")
        .get(model_id)
        .cloned();
    match flag {
        Some(flag) => {
            flag.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

/// Lowercase + trim the expected digest; anything but 64 hex chars is a
/// caller bug (`config`), never a download failure.
fn normalize_sha256(expected: &str) -> Result<String, ModelDownloadError> {
    let normalized = expected.trim().to_ascii_lowercase();
    if normalized.len() == 64 && normalized.chars().all(|c| c.is_ascii_hexdigit()) {
        Ok(normalized)
    } else {
        Err(ModelDownloadError::config(
            "expected_sha256 must be a 64-character hex digest".into(),
        ))
    }
}

/// Last path segment of the URL, sanitized to a plain file name (no path
/// separators, no percent-escapes, no dotfile trickery).
fn filename_from_url(url: &str) -> Result<String, ModelDownloadError> {
    let path = reqwest::Url::parse(url)
        .map_err(|error| ModelDownloadError::config(format!("invalid url: {error}")))?
        .path()
        .to_string();
    let raw = path.rsplit('/').find(|segment| !segment.is_empty());
    let name = raw.unwrap_or("model.bin");
    let sanitized: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' })
        .collect();
    let trimmed = sanitized.trim_matches('.').to_string();
    if trimmed.is_empty() {
        Ok("model.bin".into())
    } else {
        Ok(trimmed)
    }
}

/// The temp-file layout inside `dest_dir`: hidden, model-scoped, `.part`
/// — recognizable for cleanup, never colliding with the final name.
fn temp_path_for(dest_dir: &Path, filename: &str, model_id: &str) -> PathBuf {
    let safe_model: String = model_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || "._-".contains(c) { c } else { '_' })
        .collect();
    dest_dir.join(format!(".{filename}.{safe_model}.part"))
}

/// Streaming SHA-256 over the file at `path`, lowercase hex out.
fn sha256_hex_of_file(path: &Path) -> Result<String, ModelDownloadError> {
    let mut file = File::open(path)
        .map_err(|error| ModelDownloadError::io(format!("reopen temp file: {error}")))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| ModelDownloadError::io(format!("hash temp file: {error}")))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::{TcpListener, TcpStream};
    use std::time::Duration;

    /// Event collector for the tests: records progress/cancel/finish
    /// calls instead of emitting to a webview.
    #[derive(Default)]
    struct CollectedEvents {
        progress: Mutex<Vec<(u64, Option<u64>)>>,
        cancelled: AtomicBool,
        finished: Mutex<Vec<String>>,
    }

    impl DownloadEvents for CollectedEvents {
        fn progress(&self, received: u64, total: Option<u64>) {
            self.progress.lock().unwrap().push((received, total));
        }

        fn cancelled(&self) {
            self.cancelled.store(true, Ordering::SeqCst);
        }

        fn finished(&self, result: &DownloadResult) {
            self.finished.lock().unwrap().push(result.path.clone());
        }
    }

    /// One-response HTTP server on a random loopback port: answers the
    /// first connection with `HTTP 200` + `body`, split into two writes.
    /// `slow` parks the server after the first half (per-connection flag,
    /// NOT a global — the tests run in parallel).
    struct TestServer {
        url: String,
    }

    impl TestServer {
        fn spawn(body: Vec<u8>, slow: bool) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let url = format!("http://127.0.0.1:{port}/models-file.bin?unused=1");
            let served_body = body.clone();
            std::thread::spawn(move || {
                if let Ok((stream, _)) = listener.accept() {
                    serve_one(stream, &served_body, slow);
                }
            });
            Self { url }
        }
    }

    fn serve_one(mut stream: TcpStream, body: &[u8], slow: bool) {
        let mut reader = BufReader::new(stream.try_clone().unwrap());
        // Drain the request head.
        let mut line = String::new();
        loop {
            line.clear();
            if reader.read_line(&mut line).unwrap() == 0 || line == "\r\n" {
                break;
            }
        }
        let half = body.len() / 2;
        let head = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream.write_all(head.as_bytes()).unwrap();
        stream.write_all(&body[..half]).unwrap();
        stream.flush().unwrap();
        if slow {
            // Park long enough for the test to notice the temp file and
            // flip the cancel flag; the second half never matters.
            std::thread::sleep(Duration::from_secs(10));
        }
        stream.write_all(&body[half..]).unwrap();
        stream.flush().unwrap();
    }

    fn unique_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "emailer-model-downloads-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn digest_of(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    #[tokio::test]
    async fn success_streams_verifies_and_renames_atomically() {
        let body: Vec<u8> = (0..4096u32).map(|i| (i % 251) as u8).collect();
        let expected = digest_of(&body);
        let server = TestServer::spawn(body.clone(), false);
        let dir = unique_dir("success");
        let events = CollectedEvents::default();

        let result = run_download(
            "bge-small",
            &server.url,
            &expected,
            &dir,
            &AtomicBool::new(false),
            &events,
        )
        .await
        .unwrap();

        // The final file exists under its real name with the exact bytes,
        // and no `.part` residue is left behind.
        let dest = dir.join("models-file.bin");
        assert_eq!(std::fs::read(&dest).unwrap(), body);
        assert_eq!(result.path, dest.to_string_lossy());
        assert_eq!(result.bytes, body.len() as u64);
        assert_eq!(result.sha256, expected);
        let residue = ".models-file.bin.bge-small.part";
        assert!(std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .all(|entry| entry.file_name().to_string_lossy() != residue));
        // The always-final progress report and the finished event fired.
        assert_eq!(
            events.progress.lock().unwrap().last(),
            Some(&(body.len() as u64, Some(body.len() as u64)))
        );
        assert_eq!(events.finished.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn checksum_mismatch_rejects_with_typed_error_and_cleans_up() {
        let body = b"tampered bytes".to_vec();
        let server = TestServer::spawn(body.clone(), false);
        let dir = unique_dir("mismatch");

        let error = run_download(
            "bge-small",
            &server.url,
            // A plausible-but-wrong pinned digest.
            &"0".repeat(64),
            &dir,
            &AtomicBool::new(false),
            &CollectedEvents::default(),
        )
        .await
        .unwrap_err();

        assert_eq!(error.kind, "checksum_mismatch");
        assert_eq!(
            error.expected_sha256.as_deref(),
            Some("0".repeat(64).as_str())
        );
        assert_eq!(error.actual_sha256.as_deref(), Some(digest_of(&body).as_str()));
        // Neither the temp file nor the destination may survive a failed
        // verification.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn cancel_mid_download_stops_deletes_temp_and_reports_cancelled() {
        // Two full progress intervals, so the first half arrives as its
        // own chunk set and lands in the temp file before the stall.
        let body: Vec<u8> = vec![7u8; 512 * 1024];
        let server = TestServer::spawn(body.clone(), true);
        let dir = unique_dir("cancel");
        let cancel = Arc::new(AtomicBool::new(false));
        let events = CollectedEvents::default();

        let worker_cancel = cancel.clone();
        let dir_for_worker = dir.clone();
        let url = server.url;
        let worker = tokio::spawn(async move {
            run_download(
                "ggml-base",
                &url,
                &digest_of(&body),
                &dir_for_worker,
                &worker_cancel,
                &events,
            )
            .await
        });

        // Wait until the temp file exists (the first half was flushed),
        // then cancel — the loop must notice within one chunk. Async
        // sleep, so the current-thread runtime keeps polling the worker.
        let temp = temp_path_for(&dir, "models-file.bin", "ggml-base");
        let mut waited = 0u32;
        while !temp.exists() {
            assert!(waited < 5000, "temp file never appeared");
            tokio::time::sleep(Duration::from_millis(10)).await;
            waited += 10;
        }
        cancel.store(true, Ordering::SeqCst);

        let error = worker.await.unwrap().unwrap_err();
        assert_eq!(error.kind, "cancelled");
        // Temp deleted, destination never created.
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
    }

    #[tokio::test]
    async fn cancel_before_start_fails_fast_without_touching_disk() {
        let dir = unique_dir("cancel-early");
        let error = run_download(
            "m",
            "http://127.0.0.1:1/file.bin",
            &"a".repeat(64),
            &dir,
            &AtomicBool::new(true),
            &CollectedEvents::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, "cancelled");
    }

    #[tokio::test]
    async fn bad_expected_digest_is_a_config_error() {
        let error = run_download(
            "m",
            "http://127.0.0.1:1/file.bin",
            "not-a-digest",
            &unique_dir("config"),
            &AtomicBool::new(false),
            &CollectedEvents::default(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, "config");
    }

    #[test]
    fn filename_from_url_takes_last_segment_sanitized() {
        assert_eq!(
            filename_from_url(
                "https://huggingface.co/org/repo/resolve/abc123/model.gguf?download=true"
            )
            .unwrap(),
            "model.gguf"
        );
        // Percent-escapes and separators are neutralized, not interpreted
        // (and the leading-dot trim keeps a sanitized name from ever
        // starting with dots).
        assert_eq!(
            filename_from_url("https://huggingface.co/x/y/resolve/main/..%2Fescape.bin").unwrap(),
            "_2Fescape.bin"
        );
        // A trailing slash still yields the last non-empty segment; the
        // fallback only applies when the path has no segment at all.
        assert_eq!(
            filename_from_url("https://huggingface.co/trailing/").unwrap(),
            "trailing"
        );
        assert_eq!(
            filename_from_url("https://huggingface.co/").unwrap(),
            "model.bin"
        );
    }

    #[test]
    fn registry_refuses_a_second_download_of_the_same_model() {
        let state = ModelDownloadsState::default();
        let first = register_download(&state, "bge-small").unwrap();
        assert!(!first.load(Ordering::SeqCst));

        let error = register_download(&state, "bge-small").unwrap_err();
        assert_eq!(error.kind, "already_running");

        // Cancel finds the registered download and flips its flag.
        assert!(flag_cancel(&state, "bge-small"));
        assert!(first.load(Ordering::SeqCst));
        // Unknown models report false.
        assert!(!flag_cancel(&state, "absent"));
    }

    #[test]
    fn normalize_sha256_accepts_case_and_rejects_garbage() {
        let upper = "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789";
        assert_eq!(normalize_sha256(upper).unwrap(), upper.to_ascii_lowercase());
        assert_eq!(normalize_sha256("  abcd  ").unwrap_err().kind, "config");
        assert_eq!(normalize_sha256("abc").unwrap_err().kind, "config");
    }
}
