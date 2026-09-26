//! Local storage usage + reset (tasks 1.6/1.7, settings spec "Local
//! storage usage and reset", design D11).
//!
//! What Emailer keeps on the device, and where:
//!
//! - `attachment_cache/<sha-256>.bin` under the app DATA dir — downloaded
//!   attachment bytes (src/services/attachments/cache.ts);
//! - `emailer.db` (+ `-wal`/`-shm`) — the single SQLite database the
//!   webview owns through tauri-plugin-sql. Mail bodies, the AI cache,
//!   calendar/task data, contacts, preferences and the sealed credential
//!   slots all live inside it, and tauri-plugin-sql resolves its relative
//!   URL against the app CONFIG dir (wrapper.rs app_config_dir), which on
//!   Linux differs from the data dir (~/.config vs ~/.local/share);
//! - `credentials.key` under the app DATA dir — the AES key-sealing file
//!   (src/services/crypto/key-management.ts);
//! - the webviews' own storage (localStorage/theme, IndexedDB) — held by
//!   the OS webview runtime OUTSIDE both dirs, cleared engine-side via
//!   clear_all_browsing_data.
//!
//! `storage_usage` therefore walks BOTH dirs (deduplicated) and sums file
//! sizes on the FILESYSTEM — no counting in SQL (design D11). Message
//! bodies / AI cache / calendar+task data are DB-internal and cannot be
//! split by a walk; they are reported as part of the databases kind and
//! the settings UI says so.
//!
//! `delete_all_local_data` closes nothing itself (the webview closes the
//! plugin's DB pool first — on Windows an open SQLite file cannot be
//! unlinked), wipes the CONTENTS of both dirs (not the dirs themselves —
//! handles must stay valid), then clears the webviews' browsing data and
//! relaunches into the first-run state — in that order, so a wipe failure
//! returns before ANY data outside the dirs was touched. Servers are never
//! touched: the command has no network surface at all. This module never
//! logs path contents or credential material — only counts and category
//! names.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager, Runtime};

/// The reported kinds, in the fixed order the settings UI renders them.
const KINDS: [&str; 4] = ["attachments", "databases", "keys", "other"];

/// Bytes summed per kind, plus how many entries could not be read.
#[derive(Debug, Default)]
struct StorageScan {
    bytes: [u64; KINDS.len()],
    unreadable_entries: u64,
}

/// One kind row of the usage breakdown.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KindUsage {
    pub kind: &'static str,
    pub bytes: u64,
}

/// The full breakdown + total (`storage_usage`'s payload).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageUsage {
    pub kinds: Vec<KindUsage>,
    pub total: u64,
    /// Entries that could not be stat'ed (permissions, races). A nonzero
    /// count means the breakdown is a lower bound — the UI says so
    /// instead of presenting a possibly-short total as exact.
    pub unreadable_entries: u64,
}

impl StorageScan {
    fn into_usage(self) -> StorageUsage {
        let total = self.bytes.iter().sum();
        StorageUsage {
            kinds: KINDS
                .iter()
                .zip(self.bytes)
                .map(|(kind, bytes)| KindUsage { kind, bytes })
                .collect(),
            total,
            unreadable_entries: self.unreadable_entries,
        }
    }
}

/// Which kind a file belongs to, decided from its path BELOW the walked
/// root. The first component identifies the feature directory
/// (`attachment_cache`); the file NAME identifies the database family
/// (`emailer.db`, `emailer.db-wal`, `emailer.db-shm`, `emailer.db-journal`,
/// and any `<base>.db|.sqlite|.sqlite3` with the same sidecar suffixes)
/// and the sealed-key file. Everything else is "other".
fn classify(relative: &Path) -> usize {
    let first = relative
        .components()
        .next()
        .and_then(|component| component.as_os_str().to_str());
    if first == Some("attachment_cache") {
        return KINDS.iter().position(|kind| *kind == "attachments").unwrap_or(3);
    }
    if let Some(name) = relative.file_name().and_then(|name| name.to_str()) {
        if name == "credentials.key" {
            return KINDS.iter().position(|kind| *kind == "keys").unwrap_or(3);
        }
        if database_file_name(name) {
            return KINDS
                .iter()
                .position(|kind| *kind == "databases")
                .unwrap_or(3);
        }
    }
    KINDS.iter().position(|kind| *kind == "other").unwrap_or(3)
}

/// Whether `name` is a SQLite database file or one of its sidecars
/// (`-wal` / `-shm` / `-journal`): strip a trailing sidecar suffix, then
/// match the database extensions.
fn database_file_name(name: &str) -> bool {
    const SIDECARS: [&str; 3] = ["-wal", "-shm", "-journal"];
    let base = SIDECARS
        .iter()
        .find_map(|suffix| name.strip_suffix(suffix))
        .unwrap_or(name);
    [".db", ".sqlite", ".sqlite3"]
        .iter()
        .any(|extension| base.ends_with(extension))
}

/// Iteratively walk `root`, summing every regular file's size into its
/// kind. Non-recursive on purpose (deep caches cannot overflow the stack),
/// and entry metadata (NOT symlink-following) decides files vs
/// directories, so a symlinked directory can never loop the walk.
/// Unreadable entries are counted, not fatal — a permission hiccup must
/// not hide the rest of the breakdown.
fn scan_tree(root: &Path, scan: &mut StorageScan) {
    let mut directories = vec![root.to_path_buf()];
    while let Some(directory) = directories.pop() {
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                scan.unreadable_entries += 1;
                continue;
            }
        };
        for entry in entries {
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    scan.unreadable_entries += 1;
                    continue;
                }
            };
            let path = entry.path();
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => {
                    scan.unreadable_entries += 1;
                    continue;
                }
            };
            if file_type.is_dir() {
                directories.push(path);
                continue;
            }
            let bytes = entry.metadata().map(|metadata| metadata.len());
            match bytes {
                Ok(bytes) => {
                    let relative = path
                        .strip_prefix(root)
                        .unwrap_or(&path);
                    let kind = classify(relative);
                    scan.bytes[kind] = scan.bytes[kind].saturating_add(bytes);
                }
                Err(_) => scan.unreadable_entries += 1,
            }
        }
    }
}

/// The directories whose contents make up "all local data": the app data
/// dir (attachments, key file) and the app config dir (the SQLite
/// database). Deduplicated — on macOS and Windows both resolve to the
/// same directory.
pub fn app_roots<R: Runtime>(app: &AppHandle<R>) -> Result<Vec<PathBuf>, String> {
    let mut roots: Vec<PathBuf> = Vec::new();
    for resolved in [app.path().app_data_dir(), app.path().app_config_dir()] {
        let dir = resolved.map_err(|error| format!("app directory unavailable: {error}"))?;
        if !roots
            .iter()
            .any(|existing| identical_dirs(existing, &dir))
        {
            roots.push(dir);
        }
    }
    Ok(roots)
}

/// Same-directory check that survives case and symlink differences
/// between the path helpers; falls back to plain equality when the
/// filesystem cannot canonicalize (dir does not exist yet).
fn identical_dirs(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Sum the app's on-device storage (task 1.6). Fire-and-read: a full walk
/// of the app dirs is IO-bound and bounded by the attachment cache's
/// 200 MB / hashed-file layout, so no progress surface is needed.
#[tauri::command]
pub fn storage_usage<R: Runtime>(app: AppHandle<R>) -> Result<StorageUsage, String> {
    let mut scan = StorageScan::default();
    for root in app_roots(&app)? {
        scan_tree(&root, &mut scan);
    }
    Ok(scan.into_usage())
}

/// Delete every entry INSIDE `dir`, keeping the directory itself. Names
/// are never logged (the key file lives here) — the error carries the
/// failure kind and the entry's file NAME only when the OS reports one.
pub fn wipe_dir_contents(dir: &Path) -> io::Result<()> {
    let entries = fs::read_dir(dir)?;
    for entry in entries {
        let entry = entry?;
        let path = entry.path();
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let result = if is_dir {
            fs::remove_dir_all(&path)
        } else {
            fs::remove_file(&path)
        };
        result.map_err(|error| io::Error::new(
            error.kind(),
            format!("could not remove {}: {error}", path.file_name().and_then(|n| n.to_str()).unwrap_or("<unnamed>")),
        ))?;
    }
    Ok(())
}

/// Wipe all local data and relaunch into the first-run state (task 1.7).
/// The webview drives the order — it closes the plugin's DB connections
/// FIRST (an open SQLite file cannot be unlinked on Windows) — then this
/// command deletes the contents of both app dirs, and only after the wipe
/// succeeded clears the webviews' browsing storage engine-side and
/// restarts the process (a wipe failure returns before the browsing data
/// was touched, so a retry sees a consistent state). On success this
/// never returns (`AppHandle::restart` exits).
#[tauri::command]
pub fn delete_all_local_data<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    for root in app_roots(&app)? {
        wipe_dir_contents(&root)
            .map_err(|error| format!("local data wipe failed: {error}"))?;
    }

    // Webview-owned storage (localStorage/sessionStorage/IndexedDB — the
    // theme mirror, the accent bootstrap) lives outside the app dirs and
    // is cleared by the webview runtime here, after the file-based state
    // is gone. Best-effort per webview: a platform refusal is logged, not
    // fatal — the restart into first-run re-seeds it either way.
    let mut browsing_errors = Vec::new();
    for (label, webview) in app.webview_windows() {
        if let Err(error) = webview.clear_all_browsing_data() {
            browsing_errors.push(format!("{label}: {error}"));
        }
    }
    if !browsing_errors.is_empty() {
        log::warn!(
            "browsing-data clear incomplete after wipe: {}",
            browsing_errors.join("; ")
        );
    }

    // Relaunch into first-run. Never returns on success.
    app.restart();
}

// ---------------------------------------------------------------------------
// Credentials key file permissions
// ---------------------------------------------------------------------------

/// Restrict `credentials.key` (the AES key-sealing file the crypto layer
/// keeps under the app data dir) to the owning user: on Unix, mode
/// 0600 (no group/other bits). A missing file is Ok — there is nothing
/// to restrict yet (first run); any other I/O failure surfaces with
/// context. Pure path-based (no Tauri handle), so it is unit-testable.
fn set_owner_only_permissions(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match fs::metadata(path) {
            Ok(metadata) => {
                let mut permissions = metadata.permissions();
                permissions.set_mode(0o600);
                fs::set_permissions(path, permissions)
                    .map_err(|error| format!("could not restrict {}: {error}", path.display()))?;
                Ok(())
            }
            // Nothing sealed yet — first run, nothing to restrict.
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("could not stat {}: {error}", path.display())),
        }
    }
    // Non-Unix platforms have no POSIX mode bits to clear; the file
    // system's own defaults apply.
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

/// Tighten `<app_data_dir>/credentials.key` to owner-only permissions.
/// Takes NO path argument — the file is resolved from the app's own data
/// dir, so the command can never be aimed at an arbitrary file.
#[tauri::command]
pub fn restrict_credentials_key_permissions(app: AppHandle) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("app data dir unavailable: {error}"))?;
    set_owner_only_permissions(&data_dir.join("credentials.key"))
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::env;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Unique temp directory (no tempfile dependency): pid + counter.
    fn temp_dir(name: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let dir = env::temp_dir().join(format!(
            "emailer-storage-{}-{}-{}",
            name,
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn write(dir: &Path, relative: &str, size: usize) {
        let path = dir.join(relative);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(&path, vec![0u8; size]).expect("write file");
    }

    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn classify_maps_each_kind() {
        assert_eq!(classify(Path::new("attachment_cache/abc.bin")), 0);
        assert_eq!(classify(Path::new("emailer.db")), 1);
        assert_eq!(classify(Path::new("emailer.db-wal")), 1);
        assert_eq!(classify(Path::new("emailer.db-shm")), 1);
        assert_eq!(classify(Path::new("calendar.sqlite-journal")), 1);
        assert_eq!(classify(Path::new("credentials.key")), 2);
        assert_eq!(classify(Path::new("logs/app.log")), 3);
        assert_eq!(classify(Path::new("random.txt")), 3);
    }

    #[test]
    fn scan_sums_sizes_per_kind() {
        let root = temp_dir("scan");
        // A sentinel OUTSIDE the walked subtree must never be counted.
        let outside = temp_dir("scan-outside");
        write(&root, "emailer.db", 200);
        write(&root, "emailer.db-wal", 50);
        write(&root, "credentials.key", 32);
        write(&root, "attachment_cache/aaa.bin", 100);
        write(&root, "attachment_cache/nested/bbb.bin", 30);
        write(&root, "logs/emailer.log", 10);
        write(&outside, "sibling.bin", 4096);

        let mut scan = StorageScan::default();
        scan_tree(&root, &mut scan);

        assert_eq!(scan.bytes[0], 130, "attachments: cache dir incl. nested");
        assert_eq!(scan.bytes[1], 250, "databases: db + wal");
        assert_eq!(scan.bytes[2], 32, "keys");
        assert_eq!(scan.bytes[3], 10, "other");
        assert_eq!(scan.unreadable_entries, 0);
        let usage = scan.into_usage();
        assert_eq!(usage.total, 422);
        assert_eq!(usage.kinds.len(), KINDS.len());
        // The sibling stayed outside the walk (its own dir, untouched).
        assert!(outside.join("sibling.bin").exists());

        cleanup(&root);
        cleanup(&outside);
    }

    #[test]
    fn scan_counts_unreadable_entries_but_survives() {
        let root = temp_dir("scan-unreadable");
        write(&root, "attachment_cache/gone.bin", 5);
        // Remove the file BETWEEN listing and stat is racy; instead make
        // the walk fail on a vanished root: scanning a nonexistent root
        // counts one unreadable entry and does not panic.
        let mut scan = StorageScan::default();
        scan_tree(&root.join("does-not-exist"), &mut scan);
        assert_eq!(scan.unreadable_entries, 1);
        assert_eq!(scan.total_bytes(), 0);
        cleanup(&root);
    }

    #[test]
    fn wipe_removes_contents_but_keeps_dir_and_neighbors() {
        let app_data = temp_dir("wipe-appdata");
        let parent = app_data.parent().expect("temp parent").to_path_buf();
        // Sentinel files: one OUTSIDE the app-data dir (same parent), one
        // in a sibling directory — the wipe scope is app-data CONTENTS.
        write(&parent, "sentinel-outside.txt", 1);
        let sibling = parent.join("sentinel-sibling-dir");
        fs::create_dir_all(&sibling).expect("sibling dir");
        fs::write(sibling.join("sentinel-inside-sibling.txt"), b"x")
            .expect("write sentinel");

        write(&app_data, "emailer.db", 10);
        write(&app_data, "attachment_cache/aaa.bin", 20);
        write(&app_data, "credentials.key", 4);

        wipe_dir_contents(&app_data).expect("wipe succeeds");

        assert!(app_data.exists(), "the app-data dir itself is kept");
        let remaining = fs::read_dir(&app_data)
            .expect("read wiped dir")
            .count();
        assert_eq!(remaining, 0, "every entry inside app-data is gone");
        assert!(parent.join("sentinel-outside.txt").exists());
        assert!(sibling.join("sentinel-inside-sibling.txt").exists());

        cleanup(&app_data);
        let _ = fs::remove_file(parent.join("sentinel-outside.txt"));
        let _ = fs::remove_dir_all(sibling);
    }

    #[test]
    fn wipe_reports_missing_dir_as_error() {
        let missing = env::temp_dir().join("emailer-storage-does-not-exist");
        assert!(wipe_dir_contents(&missing).is_err());
    }

    #[test]
    fn identical_dirs_equality_then_canonicalization() {
        // Equal strings are identical without touching the filesystem —
        // even when both paths do not exist.
        assert!(identical_dirs(Path::new("/x/a"), Path::new("/x/a")));
        assert!(identical_dirs(
            Path::new("/x/does-not-exist"),
            Path::new("/x/does-not-exist")
        ));

        // The same existing directory via two spellings: the "." component
        // makes the strings differ, so only canonicalization can tell them
        // equal.
        let dir = temp_dir("identical");
        assert!(identical_dirs(&dir, &dir.join(".")));

        // A missing path is never identical to an existing one, and two
        // different missing paths are not identical either (only the
        // canonicalize branch could say so, and it failed).
        assert!(!identical_dirs(&dir.join("missing"), &dir));
        assert!(!identical_dirs(
            &dir.join("missing-a"),
            &dir.join("missing-b")
        ));

        cleanup(&dir);
    }

    impl StorageScan {
        fn total_bytes(&self) -> u64 {
            self.bytes.iter().sum()
        }
    }

    #[cfg(unix)]
    #[test]
    fn credentials_key_permissions_restrict_to_owner() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("key-permissions");
        fs::create_dir_all(&dir).expect("create temp dir");
        let key = dir.join("credentials.key");
        fs::write(&key, b"sealed-key-bytes").expect("write key file");
        // The pre-fix state: a default-created 0644 file.
        fs::set_permissions(&key, fs::Permissions::from_mode(0o644)).expect("widen mode");
        set_owner_only_permissions(&key).expect("restriction succeeds");
        let mode = fs::metadata(&key).expect("stat").permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "owner read/write only");
        // A missing file is Ok (first run — nothing sealed yet).
        set_owner_only_permissions(&dir.join("absent.key")).expect("missing file is Ok");
        // Idempotent: a second call keeps 0600.
        set_owner_only_permissions(&key).expect("idempotent");
        assert_eq!(fs::metadata(&key).unwrap().permissions().mode() & 0o777, 0o600);
    }
}
