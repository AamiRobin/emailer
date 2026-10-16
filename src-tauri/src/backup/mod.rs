//! Backup archive writer/reader + restore file swap (parity-round-3
//! tasks 5.1–5.3, design D4).
//!
//! The `.emailer-backup` format is a tar+gz stream (the `tar` + `flate2`
//! crates) of exactly two entries:
//!
//! - `manifest.json` — the checksum carrier: format `version`, `createdAt`,
//!   `appVersion`, an opaque `summary` blob the frontend fills, and one
//!   entry record per payload file (`name` / `bytes` / `sha256`). The
//!   manifest never lists itself (a file cannot checksum its own bytes);
//!   its own integrity rides on the gzip stream (CRC32 + length footer,
//!   forced by the drain at the end of every read) plus the strict
//!   entry-set checks below.
//! - `db.snapshot` — the SECRET-FREE SQLite snapshot the frontend produced
//!   with `createStrippedSnapshot` (VACUUM INTO + second-connection strip;
//!   design.md "Spike results (1.2)"). All SQL stays frontend-side: this
//!   module only ever moves and hashes file bytes.
//!
//! Commands:
//!
//! - `export_backup` — tars the frontend's snapshot with the manifest,
//!   computing every SHA-256 here (sha2). The archive lands at
//!   `<dest>.part` first and is renamed only after the stream finished —
//!   a failed export never leaves a partial archive behind that could be
//!   mistaken for a valid backup.
//! - `verify_backup_archive` — opens an archive, parses the manifest and
//!   re-computes every listed entry's SHA-256. Any mismatch, missing or
//!   unexpected entry is a typed error BEFORE the caller touches any live
//!   data. Returns the parsed manifest so the UI can version-gate and
//!   show what it is about to restore.
//! - `extract_backup_snapshot` — the same verified read, but the snapshot
//!   bytes stream into a scratch directory (`.part` first, renamed only
//!   after every checksum matched), producing the file the restore flows
//!   import. Extraction re-verifies, so the bytes a restore consumes are
//!   exactly the bytes the manifest vouched for at that moment.
//! - `replace_database_with_snapshot` — the replace-mode swap: the live
//!   `emailer.db` family (db + `-wal`/`-shm`/`-journal` sidecars) moves
//!   ASIDE under fixed names and the verified snapshot takes its place.
//!   Same-directory renames are atomic on all three desktop platforms;
//!   a failure between the two renames moves the old files back.
//! - `finalize_replaced_database` — after the frontend re-opened and
//!   migrated the restored database: commit (delete the aside copy) or
//!   rollback (put it back verbatim), so a restore that fails AFTER the
//!   swap still leaves the pre-restore data intact (spec: "a failed or
//!   cancelled restore MUST leave the existing local data intact").
//!
//! The swap deliberately wipes ONLY the database files — not the whole
//! `delete_all_local_data` app-dir wipe: restore must keep THIS device's
//! `credentials.key` (the re-auth flow re-seals into it) and its webview
//! storage (the app does not relaunch). The frontend closes the plugin's
//! database pool before invoking — an open SQLite file cannot be
//! renamed/unlinked on Windows (the delete-all flow's precedent).

use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime};

/// The manifest's own entry name inside the archive.
pub const MANIFEST_ENTRY: &str = "manifest.json";
/// The only payload entry: the stripped SQLite snapshot.
pub const SNAPSHOT_ENTRY: &str = "db.snapshot";
/// The live database's file name inside the app config dir (the plugin
/// resolves `sqlite:emailer.db` against it — see storage.rs).
const LIVE_DB_NAME: &str = "emailer.db";
/// Fixed aside name for the replaced live database during a replace-mode
/// restore (the rollback window between the swap and
/// `finalize_replaced_database`). Fixed names — never caller-supplied —
/// so the commands cannot be aimed at arbitrary files.
const ASIDE_DB_NAME: &str = "emailer.db.pre-restore";
/// SQLite sidecar suffixes that travel with the main file.
const SIDECARS: [&str; 3] = ["-wal", "-shm", "-journal"];

// ---------- Manifest ----------

/// One payload entry's checksum record.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestEntry {
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
}

/// The manifest. Extra frontend fields ride in `summary` (a passthrough
/// value, so a newer frontend can enrich it without a Rust change); the
/// other fields are the stable contract.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    /// Format version. Owned by the frontend (BACKUP_MANIFEST_VERSION);
    /// Rust neither sets nor gates it — the typed unknown/newer-version
    /// refusal is a frontend error mapped to restore UI copy.
    pub version: u32,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub app_version: Option<String>,
    #[serde(default)]
    pub summary: Option<serde_json::Value>,
    #[serde(default)]
    pub entries: Vec<ManifestEntry>,
}

// ---------- Command results / errors ----------

/// `export_backup`'s success payload.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExportedBackup {
    pub path: String,
    /// Total compressed archive size in bytes.
    pub bytes: u64,
    pub snapshot_sha256: String,
    pub manifest_sha256: String,
}

/// `verify_backup_archive`'s success payload: the manifest, verbatim.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedBackup {
    pub manifest: BackupManifest,
    /// Sum of the verified payload entry sizes (uncompressed).
    pub bytes: u64,
}

/// `extract_backup_snapshot`'s success payload.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedBackup {
    pub manifest: BackupManifest,
    /// Absolute path of the extracted `db.snapshot` (inside `destDir`).
    pub snapshot_path: String,
}

/// Typed error for every command in this module — the `kind` string is
/// stable so the TS layer can branch (the model_downloads precedent)
/// without parsing prose:
/// - `io` — filesystem failures (missing files, unwritable destination);
/// - `corrupt_archive` — not a gzip/tar stream, broken framing, duplicate
///   or unexpected entries;
/// - `bad_manifest` — the manifest JSON is missing, unparsable or lists
///   impossible entries;
/// - `checksum_mismatch` — a payload entry's recomputed SHA-256 (or byte
///   count) differs from its manifest record;
/// - `missing_entry` — the manifest lists an entry the archive lacks.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupError {
    kind: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    entry: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expected_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    actual_sha256: Option<String>,
}

impl BackupError {
    fn io(message: String) -> Self {
        Self {
            kind: "io".into(),
            message,
            entry: None,
            expected_sha256: None,
            actual_sha256: None,
        }
    }

    fn corrupt(message: String) -> Self {
        Self {
            kind: "corrupt_archive".into(),
            message,
            entry: None,
            expected_sha256: None,
            actual_sha256: None,
        }
    }

    fn bad_manifest(message: String) -> Self {
        Self {
            kind: "bad_manifest".into(),
            message,
            entry: None,
            expected_sha256: None,
            actual_sha256: None,
        }
    }

    fn missing_entry(name: &str) -> Self {
        Self {
            kind: "missing_entry".into(),
            message: format!("archive does not contain the manifest entry {name}"),
            entry: Some(name.into()),
            expected_sha256: None,
            actual_sha256: None,
        }
    }

    fn checksum_mismatch(entry: &str, expected: &str, actual: &str) -> Self {
        Self {
            kind: "checksum_mismatch".into(),
            message: format!(
                "entry {entry} does not match its manifest checksum: expected {expected}, got {actual}"
            ),
            entry: Some(entry.into()),
            expected_sha256: Some(expected.into()),
            actual_sha256: Some(actual.into()),
        }
    }

    fn byte_size_mismatch(entry: &str, expected: u64, actual: u64) -> Self {
        Self {
            kind: "checksum_mismatch".into(),
            message: format!(
                "entry {entry} has {actual} bytes, its manifest record says {expected}"
            ),
            entry: Some(entry.into()),
            expected_sha256: None,
            actual_sha256: None,
        }
    }

    fn from_io(error: &io::Error, context: &str) -> Self {
        Self::io(format!("{context}: {error}"))
    }
}

// ---------- The commands ----------

/// Write the tar+gz archive (task 5.1). `manifest_json` is the frontend's
/// manifest WITHOUT checksums — this command fills `entries` from the
/// bytes it actually archives, so the recorded checksums can never drift
/// from the payload. See the module comment for the atomicity contract.
#[tauri::command]
pub async fn export_backup(
    snapshot_path: String,
    manifest_json: String,
    dest_path: String,
) -> Result<ExportedBackup, BackupError> {
    // Whole-file hashing + gzip of a mailbox-sized snapshot: Tauri runs
    // non-async commands on the main thread, and that work must not freeze
    // the window (the repo's own spawn_blocking convention, same as the
    // embeddings/voice commands).
    tokio::task::spawn_blocking(move || {
        export_backup_sync(snapshot_path, manifest_json, dest_path)
    })
    .await
    .map_err(|error| BackupError::io(format!("export task failed: {error}")))?
}

fn export_backup_sync(
    snapshot_path: String,
    manifest_json: String,
    dest_path: String,
) -> Result<ExportedBackup, BackupError> {
    let snapshot = PathBuf::from(&snapshot_path);
    let dest = PathBuf::from(&dest_path);

    let mut manifest: BackupManifest = serde_json::from_str(&manifest_json)
        .map_err(|error| BackupError::bad_manifest(format!("manifest_json: {error}")))?;

    // Fail before anything is created when there is nothing to archive.
    let (snapshot_bytes, snapshot_sha) = sha256_hex_of_file(&snapshot)?;

    // Caller-supplied entries (if any) are replaced, never merged: these
    // checksums describe THIS archive's bytes.
    manifest.entries = vec![ManifestEntry {
        name: SNAPSHOT_ENTRY.into(),
        bytes: snapshot_bytes,
        sha256: snapshot_sha.clone(),
    }];
    let manifest_bytes = serde_json::to_vec_pretty(&manifest)
        .map_err(|error| BackupError::bad_manifest(format!("serialize manifest: {error}")))?;

    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|error| BackupError::from_io(&error, "create destination dir"))?;
        }
    }

    // `<dest>.part` first; the rename below is same-directory and atomic.
    // Every failure path removes the part file, so no half-written file
    // survives that a file picker could present as a valid backup.
    let part = part_path(&dest);
    match write_archive(&part, &manifest_bytes, &snapshot) {
        Ok(()) => {
            let manifest_sha = hex(&{
                let mut hasher = Sha256::new();
                hasher.update(&manifest_bytes);
                hasher.finalize()
            });
            match fs::rename(&part, &dest) {
                Ok(()) => {
                    let bytes = fs::metadata(&dest)
                        .map_err(|error| BackupError::from_io(&error, "stat archive"))?
                        .len();
                    Ok(ExportedBackup {
                        path: dest.to_string_lossy().into_owned(),
                        bytes,
                        snapshot_sha256: snapshot_sha,
                        manifest_sha256: manifest_sha,
                    })
                }
                Err(error) => {
                    let _ = fs::remove_file(&part);
                    Err(BackupError::from_io(&error, "publish archive"))
                }
            }
        }
        Err(error) => {
            let _ = fs::remove_file(&part);
            Err(error)
        }
    }
}

/// Verify every manifest entry's checksum (task 5.2) without extracting
/// anything. Typed errors on any mismatch; the caller has not touched
/// live data when one fires.
#[tauri::command]
pub async fn verify_backup_archive(
    archive_path: String,
) -> Result<VerifiedBackup, BackupError> {
    // Full-archive checksum pass — off the main thread (see export_backup).
    tokio::task::spawn_blocking(move || verify_backup_archive_sync(archive_path))
        .await
        .map_err(|error| BackupError::io(format!("verify task failed: {error}")))?
}

fn verify_backup_archive_sync(archive_path: String) -> Result<VerifiedBackup, BackupError> {
    let (manifest, bytes) = read_archive(Path::new(&archive_path), None)?;
    Ok(VerifiedBackup { manifest, bytes })
}

/// Verify AND extract the snapshot into a fresh scratch directory
/// (tasks 5.2/5.3). The snapshot becomes `<destDir>/db.snapshot` only
/// after every checksum matched; a failure leaves no `db.snapshot` and no
/// `.part` residue behind.
#[tauri::command]
pub async fn extract_backup_snapshot(
    archive_path: String,
    dest_dir: String,
) -> Result<ExtractedBackup, BackupError> {
    // Same main-thread rule as export/verify: the whole archive streams
    // through gunzip + SHA-256 here.
    tokio::task::spawn_blocking(move || {
        extract_backup_snapshot_sync(archive_path, dest_dir)
    })
    .await
    .map_err(|error| BackupError::io(format!("extract task failed: {error}")))?
}

fn extract_backup_snapshot_sync(
    archive_path: String,
    dest_dir: String,
) -> Result<ExtractedBackup, BackupError> {
    let dest_dir = PathBuf::from(&dest_dir);
    fs::create_dir_all(&dest_dir)
        .map_err(|error| BackupError::from_io(&error, "create scratch dir"))?;
    let snapshot_path = dest_dir.join(SNAPSHOT_ENTRY);
    let part = part_path(&snapshot_path);
    match read_archive(Path::new(&archive_path), Some(&part)) {
        Ok((manifest, _bytes)) => {
            if let Err(error) = fs::rename(&part, &snapshot_path) {
                let _ = fs::remove_file(&part);
                return Err(BackupError::from_io(&error, "publish snapshot"));
            }
            Ok(ExtractedBackup {
                manifest,
                snapshot_path: snapshot_path.to_string_lossy().into_owned(),
            })
        }
        Err(error) => {
            let _ = fs::remove_file(&part);
            Err(error)
        }
    }
}

/// Replace-mode swap (task 5.3): the live database family moves aside,
/// the verified snapshot becomes the live database. The frontend MUST
/// have closed the plugin's database pool first (Windows cannot rename an
/// open SQLite file) and runs `initDatabase()` afterwards — only then may
/// it call `finalize_replaced_database`.
#[tauri::command]
pub fn replace_database_with_snapshot<R: Runtime>(
    app: AppHandle<R>,
    snapshot_path: String,
) -> Result<(), BackupError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| BackupError::io(format!("app config dir unavailable: {error}")))?;
    swap_database_files(&config_dir, Path::new(&snapshot_path))
}

/// Commit or roll back a replace-mode restore (task 5.3, spec "a failed
/// or cancelled restore MUST leave the existing local data intact").
/// `rollback: false` deletes the aside copy (the restore succeeded);
/// `rollback: true` puts the pre-restore database family back verbatim
/// after removing the failed restored one.
#[tauri::command]
pub fn finalize_replaced_database<R: Runtime>(
    app: AppHandle<R>,
    rollback: bool,
) -> Result<(), BackupError> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|error| BackupError::io(format!("app config dir unavailable: {error}")))?;
    finalize_replaced_database_in(&config_dir, rollback)
}

// ---------- Archive reading / writing ----------

/// Write one finished archive: manifest.json (fixed, reproducible header)
/// followed by the snapshot file. Returns once the gzip stream is flushed
/// to disk.
fn write_archive(part: &Path, manifest_bytes: &[u8], snapshot: &Path) -> Result<(), BackupError> {
    let file = File::create(part).map_err(|error| BackupError::from_io(&error, "create archive"))?;
    let mut builder = tar::Builder::new(GzEncoder::new(file, Compression::default()));

    let mut header = tar::Header::new_gnu();
    header.set_size(manifest_bytes.len() as u64);
    header.set_mode(0o644);
    header.set_mtime(0);
    header.set_cksum();
    builder
        .append_data(&mut header, MANIFEST_ENTRY, manifest_bytes)
        .map_err(|error| BackupError::from_io(&error, "append manifest"))?;

    builder
        .append_path_with_name(snapshot, SNAPSHOT_ENTRY)
        .map_err(|error| BackupError::from_io(&error, "append snapshot"))?;

    builder
        .finish()
        .map_err(|error| BackupError::from_io(&error, "finish archive"))?;
    builder
        .into_inner()
        .map_err(|error| BackupError::from_io(&error, "flush archive"))?
        .finish()
        .map_err(|error| BackupError::from_io(&error, "finish gzip"))?;
    Ok(())
}

/// A `Write` sink that counts bytes and feeds a SHA-256 as they pass.
struct HashingSink<W: Write> {
    inner: W,
    hasher: Sha256,
    bytes: u64,
}

impl<W: Write> Write for HashingSink<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self.inner.write(buf)?;
        self.hasher.update(&buf[..written]);
        self.bytes += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

/// Read one archive: parse the manifest and hash every payload entry,
/// optionally streaming `db.snapshot` into `snapshot_part` while at it.
/// The manifest's entry list is the sole authority — every listed entry
/// must be present with matching size and SHA-256, and nothing else may
/// ride along. `snapshot_part` is only published (renamed to its final
/// name by the caller) after ALL checks passed; a failure mid-read can
/// leave a partial part file, which the command wrappers delete.
fn read_archive(
    archive_path: &Path,
    snapshot_part: Option<&Path>,
) -> Result<(BackupManifest, u64), BackupError> {
    let file =
        File::open(archive_path).map_err(|error| BackupError::from_io(&error, "open archive"))?;
    let mut archive = tar::Archive::new(GzDecoder::new(file));

    let mut manifest: Option<BackupManifest> = None;
    // name → (bytes, sha256) as read from the archive.
    let mut seen: HashMap<String, (u64, String)> = HashMap::new();

    let entries = archive
        .entries()
        .map_err(|error| BackupError::corrupt(format!("not a readable tar+gz archive: {error}")))?;
    for entry in entries {
        let mut entry = entry
            .map_err(|error| BackupError::corrupt(format!("unreadable archive entry: {error}")))?;
        let name = entry
            .path()
            .map_err(|error| BackupError::corrupt(format!("unreadable entry name: {error}")))?
            .to_string_lossy()
            .into_owned();
        // Flat, non-hidden file names only — a backup is written by this
        // module, and anything else is tampering or a foreign archive.
        if name.is_empty() || name.starts_with('.') || name.contains('/') || name.contains('\\') {
            return Err(BackupError::corrupt(format!(
                "unexpected entry name {name:?}"
            )));
        }
        if name == MANIFEST_ENTRY {
            if manifest.is_some() {
                return Err(BackupError::corrupt("duplicate manifest.json".into()));
            }
            let mut json = String::new();
            entry
                .read_to_string(&mut json)
                .map_err(|error| BackupError::corrupt(format!("unreadable manifest: {error}")))?;
            manifest = Some(serde_json::from_str(&json).map_err(|error| {
                BackupError::bad_manifest(format!("manifest.json is not a valid manifest: {error}"))
            })?);
            continue;
        }
        if seen.contains_key(&name) {
            return Err(BackupError::corrupt(format!("duplicate entry {name:?}")));
        }
        // io::sink stands in when no extraction is wanted, so both paths
        // share one hashing loop.
        let sink: Box<dyn Write> = match snapshot_part {
            Some(part) if name == SNAPSHOT_ENTRY => Box::new(
                File::create(part)
                    .map_err(|error| BackupError::from_io(&error, "create snapshot part file"))?,
            ),
            _ => Box::new(io::sink()),
        };
        let mut hashing = HashingSink {
            inner: sink,
            hasher: Sha256::new(),
            bytes: 0,
        };
        io::copy(&mut entry, &mut hashing)
            .map_err(|error| BackupError::corrupt(format!("entry {name:?} is truncated: {error}")))?;
        hashing
            .inner
            .flush()
            .map_err(|error| BackupError::from_io(&error, "write snapshot part file"))?;
        let HashingSink { hasher, bytes, .. } = hashing;
        let sha = hex(&hasher.finalize());
        seen.insert(name, (bytes, sha));
    }

    // A truncated gzip stream can still read as a clean end of the tar
    // iteration — drain the decoder to EOF so flate2's footer check
    // (CRC32 + length) always runs.
    let mut decoder = archive.into_inner();
    io::copy(&mut decoder, &mut io::sink())
        .map_err(|error| BackupError::corrupt(format!("truncated gzip stream: {error}")))?;

    let manifest = manifest
        .ok_or_else(|| BackupError::bad_manifest("archive has no manifest.json".into()))?;

    // The manifest entry list must describe exactly what the archive
    // carries: every listed entry present with matching size + digest,
    // and no payload entry outside the list.
    for listed in &manifest.entries {
        let (bytes, sha) = seen
            .get(&listed.name)
            .ok_or_else(|| BackupError::missing_entry(&listed.name))?;
        if *bytes != listed.bytes {
            return Err(BackupError::byte_size_mismatch(
                &listed.name,
                listed.bytes,
                *bytes,
            ));
        }
        if *sha != listed.sha256.to_ascii_lowercase() {
            return Err(BackupError::checksum_mismatch(
                &listed.name,
                &listed.sha256,
                sha,
            ));
        }
    }
    for name in seen.keys() {
        if !manifest.entries.iter().any(|listed| &listed.name == name) {
            return Err(BackupError::corrupt(format!(
                "archive carries unlisted entry {name:?}"
            )));
        }
    }
    // The format is "manifest + db.snapshot, exactly": an archive without
    // the snapshot payload would pass every per-entry check above and
    // only explode later at extract with a generic io error.
    if !seen.contains_key(SNAPSHOT_ENTRY) {
        return Err(BackupError::missing_entry(SNAPSHOT_ENTRY));
    }

    let total: u64 = seen.values().map(|(bytes, _)| bytes).sum();
    Ok((manifest, total))
}

// ---------- Replace-mode file swap ----------

/// The full file family of one SQLite database (main + sidecars).
fn db_family(base: &Path) -> Vec<PathBuf> {
    let mut family = vec![base.to_path_buf()];
    for sidecar in SIDECARS {
        let mut named = base.as_os_str().to_os_string();
        named.push(sidecar);
        family.push(PathBuf::from(named));
    }
    family
}

/// Remove every member of a database family that exists. Missing files
/// are fine (a clean close leaves no sidecars).
fn remove_db_family(base: &Path) -> Result<(), BackupError> {
    for path in db_family(base) {
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|error| BackupError::from_io(&error, "remove database file"))?;
        }
    }
    Ok(())
}

/// The aside twin of one database-family member: `emailer.db` →
/// `emailer.db.pre-restore`, sidecars likewise. Returns a bare FILE NAME
/// to be joined with the live dir.
fn aside_name(member: &Path) -> PathBuf {
    let name = member
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let suffix = name.strip_prefix(LIVE_DB_NAME).unwrap_or_default();
    PathBuf::from(format!("{ASIDE_DB_NAME}{suffix}"))
}

/// Move the live database family aside. Returns false when there was no
/// live database at all (first run — nothing to preserve).
fn move_aside(live_dir: &Path) -> Result<bool, BackupError> {
    let live = live_dir.join(LIVE_DB_NAME);
    if !live.exists() {
        return Ok(false);
    }
    for member in db_family(&live) {
        if member.exists() {
            let aside = live_dir.join(aside_name(&member));
            if let Err(error) = fs::rename(&member, &aside) {
                // A partial move-aside (e.g. Windows open-handle) must not
                // leave the live directory WITHOUT a database: roll the
                // already-moved members back so the caller's failure is
                // recoverable, matching swap_database_files' contract.
                let _ = move_back(live_dir);
                return Err(
                    BackupError::from_io(&error, "set live database aside")
                );
            }
        }
    }
    Ok(true)
}

/// Move the aside family back over whatever sits at the live names
/// (rollback path — the live side is the FAILED restore and is removed).
fn move_back(live_dir: &Path) -> Result<(), BackupError> {
    let live = live_dir.join(LIVE_DB_NAME);
    remove_db_family(&live)?;
    if !live_dir.join(ASIDE_DB_NAME).exists() {
        return Err(BackupError::io(
            "no pre-restore database copy to roll back to".into(),
        ));
    }
    for member in db_family(&live) {
        let aside_member = live_dir.join(aside_name(&member));
        if aside_member.exists() {
            fs::rename(&aside_member, &member)
                .map_err(|error| BackupError::from_io(&error, "restore database file"))?;
        }
    }
    Ok(())
}

/// Drop the aside family (commit path — the restore succeeded).
fn clear_aside(live_dir: &Path) -> Result<(), BackupError> {
    remove_db_family(&live_dir.join(ASIDE_DB_NAME))
}

/// The replace-mode swap over plain paths (unit-testable; the command
/// resolves `live_dir` from the app config dir). On any failure the
/// pre-swap state is restored best-effort before the error returns.
fn swap_database_files(live_dir: &Path, snapshot_path: &Path) -> Result<(), BackupError> {
    if !snapshot_path.is_file() {
        return Err(BackupError::io(format!(
            "snapshot file {} does not exist",
            snapshot_path.display()
        )));
    }
    // An aside family from a CRASHED earlier restore is the only copy of
    // the user's pre-restore data (finalize never ran). Silently clearing
    // it here would make the next failed restore lose the original data
    // for good — refuse instead and let the user decide.
    if live_dir.join(ASIDE_DB_NAME).exists() {
        return Err(BackupError::io(
            "a pre-restore database copy from an unfinished restore exists — \
             finalize or discard it before restoring again"
                .into(),
        ));
    }
    clear_aside(live_dir)?;
    let had_live = move_aside(live_dir)?;
    let live = live_dir.join(LIVE_DB_NAME);
    if let Err(error) = fs::rename(snapshot_path, &live) {
        if had_live {
            let _ = move_back(live_dir);
        }
        return Err(BackupError::from_io(&error, "promote snapshot"));
    }
    Ok(())
}

/// The finalize half of the replace swap over plain paths.
fn finalize_replaced_database_in(live_dir: &Path, rollback: bool) -> Result<(), BackupError> {
    if rollback {
        move_back(live_dir)
    } else {
        clear_aside(live_dir)
    }
}

// ---------- Helpers ----------

/// `<path>.part` — the never-presented-as-valid staging name.
fn part_path(path: &Path) -> PathBuf {
    let mut named = path.as_os_str().to_os_string();
    named.push(".part");
    PathBuf::from(named)
}

/// Streaming SHA-256 over a file: `(bytes, lowercase hex digest)`.
fn sha256_hex_of_file(path: &Path) -> Result<(u64, String), BackupError> {
    let mut file = File::open(path).map_err(|error| BackupError::from_io(&error, "open snapshot"))?;
    let mut hasher = Sha256::new();
    let mut bytes: u64 = 0;
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| BackupError::from_io(&error, "read snapshot"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        bytes += read as u64;
    }
    Ok((bytes, hex(&hasher.finalize())))
}

/// Lowercase hex encoding of a digest.
fn hex(digest: &[u8]) -> String {
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// Unique temp directory (no tempfile dependency): pid + counter, the
    /// storage.rs tests' helper.
    fn temp_dir(name: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let dir = env::temp_dir().join(format!(
            "emailer-backup-{}-{}-{}",
            name,
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn digest_of(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        hex(&hasher.finalize())
    }

    /// One exported archive with a known snapshot payload.
    fn export_fixture(dir: &Path, name: &str, payload: &[u8]) -> PathBuf {
        let snapshot = dir.join(format!("{name}.snapshot"));
        fs::write(&snapshot, payload).expect("write snapshot");
        let manifest = serde_json::json!({
            "version": 1,
            "createdAt": "2026-10-04T00:00:00.000Z",
            "appVersion": "0.1.0",
            "summary": { "accounts": 1 },
        });
        let dest = dir.join(format!("{name}.emailer-backup"));
        let result = export_backup_sync(
            snapshot.to_string_lossy().into_owned(),
            serde_json::to_string(&manifest).unwrap(),
            dest.to_string_lossy().into_owned(),
        )
        .expect("export succeeds");
        assert_eq!(result.snapshot_sha256, digest_of(payload));
        dest
    }

    #[test]
    fn export_writes_archive_with_both_entries_and_manifest_checksums() {
        let dir = temp_dir("export");
        let payload = b"sqlite-bytes-0123456789";
        let dest = export_fixture(&dir, "ok", payload);

        // No .part residue, the archive exists under its real name.
        assert!(dest.exists());
        assert!(!part_path(&dest).exists());

        let (manifest, bytes) = read_archive(&dest, None).expect("archive reads back");
        assert_eq!(manifest.version, 1);
        assert_eq!(
            manifest.created_at.as_deref(),
            Some("2026-10-04T00:00:00.000Z")
        );
        assert_eq!(manifest.app_version.as_deref(), Some("0.1.0"));
        assert_eq!(manifest.summary, Some(serde_json::json!({ "accounts": 1 })));
        assert_eq!(manifest.entries.len(), 1);
        assert_eq!(manifest.entries[0].name, SNAPSHOT_ENTRY);
        assert_eq!(manifest.entries[0].bytes, payload.len() as u64);
        assert_eq!(manifest.entries[0].sha256, digest_of(payload));
        assert_eq!(bytes, payload.len() as u64);

        cleanup(&dir);
    }

    #[test]
    fn export_missing_snapshot_fails_before_creating_anything() {
        let dir = temp_dir("export-missing");
        let dest = dir.join("out.emailer-backup");
        let error = export_backup_sync(
            dir.join("absent.db").to_string_lossy().into_owned(),
            r#"{"version":1}"#.into(),
            dest.to_string_lossy().into_owned(),
        )
        .unwrap_err();
        assert_eq!(error.kind, "io");
        // Neither the archive nor its staging file may exist.
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists());
        cleanup(&dir);
    }

    #[test]
    fn export_bad_manifest_json_is_a_typed_error_with_no_archive() {
        let dir = temp_dir("export-bad-manifest");
        let snapshot = dir.join("s.db");
        fs::write(&snapshot, b"payload").unwrap();
        let dest = dir.join("out.emailer-backup");
        let error = export_backup_sync(
            snapshot.to_string_lossy().into_owned(),
            "not json".into(),
            dest.to_string_lossy().into_owned(),
        )
        .unwrap_err();
        assert_eq!(error.kind, "bad_manifest");
        assert!(!dest.exists());
        assert!(!part_path(&dest).exists());
        cleanup(&dir);
    }

    /// Hand-write an archive from a manifest + payload, bypassing
    /// export_backup — the tool for crafting the corrupted fixtures the
    /// verifier must catch.
    fn write_raw_archive(
        dest: &Path,
        manifest: &serde_json::Value,
        payload: Option<&[u8]>,
    ) {
        let file = File::create(dest).expect("create archive");
        let mut builder = tar::Builder::new(GzEncoder::new(file, Compression::default()));
        let json = serde_json::to_vec(manifest).unwrap();
        let mut header = tar::Header::new_gnu();
        header.set_size(json.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, MANIFEST_ENTRY, json.as_slice())
            .unwrap();
        if let Some(payload) = payload {
            let mut payload_header = tar::Header::new_gnu();
            payload_header.set_size(payload.len() as u64);
            payload_header.set_mode(0o644);
            payload_header.set_cksum();
            builder
                .append_data(&mut payload_header, SNAPSHOT_ENTRY, payload)
                .unwrap();
        }
        builder.finish().unwrap();
        builder.into_inner().unwrap().finish().unwrap();
    }

    #[test]
    fn verify_detects_a_tampered_payload_with_typed_checksum_error() {
        let dir = temp_dir("verify-tamper");
        // Honest manifest, dishonest payload.
        let archive = dir.join("tampered.emailer-backup");
        write_raw_archive(
            &archive,
            &serde_json::json!({
                "version": 1,
                "entries": [{
                    "name": SNAPSHOT_ENTRY,
                    "bytes": 14,
                    "sha256": digest_of(b"original-bytes"),
                }],
            }),
            Some(b"tampered-bytez"),
        );
        let error = verify_backup_archive_sync(archive.to_string_lossy().into_owned()).unwrap_err();
        assert_eq!(error.kind, "checksum_mismatch");
        assert_eq!(error.entry.as_deref(), Some(SNAPSHOT_ENTRY));
        assert_eq!(
            error.expected_sha256.as_deref(),
            Some(digest_of(b"original-bytes").as_str())
        );
        assert_eq!(
            error.actual_sha256.as_deref(),
            Some(digest_of(b"tampered-bytez").as_str())
        );
        cleanup(&dir);
    }

    #[test]
    fn verify_detects_a_byte_size_drift_before_the_digest() {
        let dir = temp_dir("verify-size-drift");
        // Same manifest as the digest case, but the payload ALSO has a
        // different length — the size check must fire first (a cheap
        // count before any digest comparison matters).
        let archive = dir.join("sized.emailer-backup");
        write_raw_archive(
            &archive,
            &serde_json::json!({
                "version": 1,
                "entries": [{
                    "name": SNAPSHOT_ENTRY,
                    "bytes": 99,
                    "sha256": digest_of(b"original-bytes"),
                }],
            }),
            Some(b"tampered-bytes"),
        );
        let error = verify_backup_archive_sync(archive.to_string_lossy().into_owned()).unwrap_err();
        assert_eq!(error.kind, "checksum_mismatch");
        assert_eq!(error.entry.as_deref(), Some(SNAPSHOT_ENTRY));
        assert_eq!(error.expected_sha256, None);
        cleanup(&dir);
    }

    #[test]
    fn verify_detects_a_tampered_manifest_record() {
        let dir = temp_dir("verify-manifest-tamper");
        // Honest payload, manifest record pointing at other bytes: the
        // same mismatch, from the other side.
        let archive = dir.join("manifest-tampered.emailer-backup");
        write_raw_archive(
            &archive,
            &serde_json::json!({
                "version": 1,
                "entries": [{
                    "name": SNAPSHOT_ENTRY,
                    "bytes": 13,
                    "sha256": digest_of(&[0u8; 32]),
                }],
            }),
            Some(b"honest-bytes"),
        );
        let error = verify_backup_archive_sync(archive.to_string_lossy().into_owned()).unwrap_err();
        assert_eq!(error.kind, "checksum_mismatch");
        assert_eq!(error.entry.as_deref(), Some(SNAPSHOT_ENTRY));
        cleanup(&dir);
    }

    #[test]
    fn verify_rejects_a_broken_manifest_as_bad_manifest() {
        let dir = temp_dir("verify-bad-manifest");
        let archive = dir.join("bad-manifest.emailer-backup");
        let file = File::create(&archive).unwrap();
        let mut builder = tar::Builder::new(GzEncoder::new(file, Compression::default()));
        let mut header = tar::Header::new_gnu();
        header.set_size(8);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, MANIFEST_ENTRY, b"not json" as &[u8])
            .unwrap();
        builder.finish().unwrap();
        builder.into_inner().unwrap().finish().unwrap();

        let error = verify_backup_archive_sync(archive.to_string_lossy().into_owned()).unwrap_err();
        assert_eq!(error.kind, "bad_manifest");
        cleanup(&dir);
    }

    #[test]
    fn verify_rejects_truncated_and_foreign_archives_as_corrupt() {
        let dir = temp_dir("verify-corrupt");
        let good = export_fixture(&dir, "good", b"payload-bytes");
        let bytes = fs::read(&good).unwrap();

        // Truncated stream: the gzip footer is gone.
        let truncated = dir.join("truncated.emailer-backup");
        fs::write(&truncated, &bytes[..bytes.len() - 10]).unwrap();
        let error = verify_backup_archive_sync(truncated.to_string_lossy().into_owned()).unwrap_err();
        assert_eq!(error.kind, "corrupt_archive");

        // Not an archive at all.
        let garbage = dir.join("garbage.emailer-backup");
        fs::write(&garbage, b"definitely not gzip").unwrap();
        let error = verify_backup_archive_sync(garbage.to_string_lossy().into_owned()).unwrap_err();
        assert_eq!(error.kind, "corrupt_archive");

        // A flipped byte INSIDE the gzip payload breaks the CRC footer.
        let mut flipped = bytes.clone();
        let last = flipped.len() - 1;
        flipped[last] ^= 0xff;
        let flipped_path = dir.join("flipped.emailer-backup");
        fs::write(&flipped_path, &flipped).unwrap();
        let error = verify_backup_archive_sync(flipped_path.to_string_lossy().into_owned()).unwrap_err();
        assert!(
            matches!(error.kind.as_str(), "corrupt_archive" | "checksum_mismatch"),
            "flipped byte must fail, got {} ({})",
            error.kind,
            error.message
        );

        // Missing file is io, not corrupt.
        let error = verify_backup_archive_sync(
            dir.join("absent.emailer-backup")
                .to_string_lossy()
                .into_owned(),
        )
        .unwrap_err();
        assert_eq!(error.kind, "io");

        cleanup(&dir);
    }

    #[test]
    fn verify_rejects_an_archive_whose_snapshot_entry_is_missing() {
        let dir = temp_dir("verify-missing-entry");
        let archive = dir.join("no-payload.emailer-backup");
        write_raw_archive(
            &archive,
            &serde_json::json!({
                "version": 1,
                "entries": [{
                    "name": SNAPSHOT_ENTRY,
                    "bytes": 4,
                    "sha256": digest_of(b"abcd"),
                }],
            }),
            None,
        );
        let error = verify_backup_archive_sync(archive.to_string_lossy().into_owned()).unwrap_err();
        assert_eq!(error.kind, "missing_entry");
        assert_eq!(error.entry.as_deref(), Some(SNAPSHOT_ENTRY));
        cleanup(&dir);
    }

    #[test]
    fn verify_rejects_unlisted_extra_entries_as_corrupt() {
        let dir = temp_dir("verify-extra");
        // Manifest honest about db.snapshot — but the archive also packs a
        // surprise second payload the manifest never listed.
        let archive = dir.join("extra.emailer-backup");
        let file = File::create(&archive).unwrap();
        let mut builder = tar::Builder::new(GzEncoder::new(file, Compression::default()));
        let manifest = serde_json::json!({
            "version": 1,
            "entries": [{
                "name": SNAPSHOT_ENTRY,
                "bytes": 4,
                "sha256": digest_of(b"abcd"),
            }],
        });
        let json = serde_json::to_vec(&manifest).unwrap();
        let mut header = tar::Header::new_gnu();
        header.set_size(json.len() as u64);
        header.set_mode(0o644);
        header.set_cksum();
        builder
            .append_data(&mut header, MANIFEST_ENTRY, json.as_slice())
            .unwrap();
        let mut payload_header = tar::Header::new_gnu();
        payload_header.set_size(4);
        payload_header.set_mode(0o644);
        payload_header.set_cksum();
        builder
            .append_data(&mut payload_header, SNAPSHOT_ENTRY, b"abcd" as &[u8])
            .unwrap();
        let mut extra_header = tar::Header::new_gnu();
        extra_header.set_size(2);
        extra_header.set_mode(0o644);
        extra_header.set_cksum();
        builder
            .append_data(&mut extra_header, "extra.bin", b"hi" as &[u8])
            .unwrap();
        builder.finish().unwrap();
        builder.into_inner().unwrap().finish().unwrap();

        let error = verify_backup_archive_sync(archive.to_string_lossy().into_owned()).unwrap_err();
        assert_eq!(error.kind, "corrupt_archive");
        cleanup(&dir);
    }

    #[test]
    fn extract_writes_the_snapshot_only_after_verification() {
        let dir = temp_dir("extract-ok");
        let payload = b"restorable-sqlite-bytes";
        let archive = export_fixture(&dir, "src", payload);
        let scratch = dir.join("scratch");
        let result = extract_backup_snapshot_sync(
            archive.to_string_lossy().into_owned(),
            scratch.to_string_lossy().into_owned(),
        )
        .expect("extract succeeds");
        let extracted = PathBuf::from(&result.snapshot_path);
        assert_eq!(
            extracted.file_name().unwrap().to_string_lossy(),
            SNAPSHOT_ENTRY
        );
        assert_eq!(fs::read(&extracted).unwrap(), payload);
        assert!(!part_path(&extracted).exists(), "no .part residue");

        // The failure twin: a corrupt archive must leave the scratch dir
        // with NEITHER the snapshot nor a .part file.
        let corrupt = dir.join("corrupt.emailer-backup");
        fs::write(&corrupt, b"not an archive").unwrap();
        let scratch2 = dir.join("scratch2");
        let error = extract_backup_snapshot_sync(
            corrupt.to_string_lossy().into_owned(),
            scratch2.to_string_lossy().into_owned(),
        )
        .unwrap_err();
        assert_eq!(error.kind, "corrupt_archive");
        let left: Vec<_> = fs::read_dir(&scratch2)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(left.is_empty(), "scratch dir must be empty, found {left:?}");

        cleanup(&dir);
    }

    #[test]
    fn swap_moves_live_aside_promotes_snapshot_and_rolls_back() {
        let dir = temp_dir("swap");
        let live = dir.join(LIVE_DB_NAME);
        fs::write(&live, b"old-live-db").unwrap();
        fs::write(dir.join("emailer.db-wal"), b"old-wal").unwrap();
        let snapshot = dir.join("db.snapshot");
        fs::write(&snapshot, b"new-snapshot-db").unwrap();

        swap_database_files(&dir, &snapshot).expect("swap succeeds");
        assert_eq!(fs::read(&live).unwrap(), b"new-snapshot-db");
        assert!(!snapshot.exists(), "the snapshot moved onto the live name");
        assert_eq!(fs::read(dir.join(ASIDE_DB_NAME)).unwrap(), b"old-live-db");
        assert_eq!(
            fs::read(dir.join(format!("{ASIDE_DB_NAME}-wal"))).unwrap(),
            b"old-wal"
        );

        // Rollback: the pre-restore family comes back verbatim.
        finalize_replaced_database_in(&dir, true).expect("rollback succeeds");
        assert_eq!(fs::read(&live).unwrap(), b"old-live-db");
        assert_eq!(fs::read(dir.join("emailer.db-wal")).unwrap(), b"old-wal");
        assert!(!dir.join(ASIDE_DB_NAME).exists());

        // A later swap + commit drops the aside copy.
        fs::write(&snapshot, b"second-attempt").unwrap();
        swap_database_files(&dir, &snapshot).expect("second swap succeeds");
        finalize_replaced_database_in(&dir, false).expect("commit succeeds");
        assert_eq!(fs::read(&live).unwrap(), b"second-attempt");
        assert!(!dir.join(ASIDE_DB_NAME).exists());
        assert!(!dir.join(format!("{ASIDE_DB_NAME}-wal")).exists());
        cleanup(&dir);
    }

    #[test]
    fn swap_failure_leaves_the_live_database_in_place() {
        let dir = temp_dir("swap-fail");
        let live = dir.join(LIVE_DB_NAME);
        fs::write(&live, b"precious").unwrap();

        // Missing snapshot: typed io error, live untouched, no aside copy.
        let error = swap_database_files(&dir, &dir.join("absent.snapshot")).unwrap_err();
        assert_eq!(error.kind, "io");
        assert_eq!(fs::read(&live).unwrap(), b"precious");
        assert!(!dir.join(ASIDE_DB_NAME).exists());

        // A stale aside copy from an aborted earlier attempt is cleared,
        // so the swap still succeeds.
        fs::write(dir.join(format!("{ASIDE_DB_NAME}-wal")), b"stale").unwrap();
        let snapshot = dir.join("db.snapshot");
        fs::write(&snapshot, b"fresh").unwrap();
        swap_database_files(&dir, &snapshot).expect("stale aside copy is cleared");
        assert_eq!(fs::read(&live).unwrap(), b"fresh");
        cleanup(&dir);
    }

    #[test]
    fn rollback_without_an_aside_copy_is_a_typed_error() {
        let dir = temp_dir("rollback-empty");
        let error = finalize_replaced_database_in(&dir, true).unwrap_err();
        assert_eq!(error.kind, "io");
        // Commit without anything to clean is a no-op success.
        finalize_replaced_database_in(&dir, false).expect("commit is a no-op");
        cleanup(&dir);
    }

    #[test]
    fn aside_name_maps_every_family_member() {
        let dir = Path::new("/config");
        assert_eq!(
            aside_name(&dir.join("emailer.db")),
            PathBuf::from(ASIDE_DB_NAME)
        );
        assert_eq!(
            aside_name(&dir.join("emailer.db-wal")),
            PathBuf::from(format!("{ASIDE_DB_NAME}-wal"))
        );
        assert_eq!(
            aside_name(&dir.join("emailer.db-shm")),
            PathBuf::from(format!("{ASIDE_DB_NAME}-shm"))
        );
        assert_eq!(
            aside_name(&dir.join("emailer.db-journal")),
            PathBuf::from(format!("{ASIDE_DB_NAME}-journal"))
        );
    }

    fn cleanup(dir: &Path) {
        let _ = fs::remove_dir_all(dir);
    }
}
