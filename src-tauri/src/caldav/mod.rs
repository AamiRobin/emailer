//! Minimal CalDAV client and the `caldav_*` commands (task 5.2, design D5).
//!
//! D5 in one line: a hand-rolled minimal client in Rust — PROPFIND for
//! discovery, REPORT (sync-collection, with a calendar-query fallback) for
//! event sync — over the same TCP + native-tls stack as the AI provider
//! clients. No SDK crate: the only dependency this task adds is
//! `quick-xml` (the design names it; see `Cargo.toml` for why the XML side
//! is not hand-rolled while the HTTP side is).
//!
//! Modules:
//! - [`http`]   — one generic `request_raw` (arbitrary METHOD + body +
//!   headers) reusing `ai::http`'s URL parsing and response decoding.
//! - [`xml`]    — WebDAV `multistatus` parsing into a flat, local-name
//!   keyed structure.
//! - [`client`] — the protocol operations: discovery (RFC 4791 §6.2-style
//!   current-user-principal → calendar-home-set → Depth-1 listing),
//!   connection test, sync-collection REPORT and its fallbacks.
//!
//! # Security / credentials contract (same posture as `ai_chat`)
//!
//! The webview cannot open raw TLS sockets, so CalDAV travels ONLY through
//! these commands. The TS layer unseals the source's config envelope
//! (`crypto/credentials`, AES-256-GCM) and passes the PLAINTEXT username +
//! app password per call, exactly like the AI client's per-call API key:
//! credentials are never persisted by this module, never logged (no
//! `log::` call here sees them) and never echoed — every error message
//! that could embed server-supplied text is scrubbed through
//! [`crate::ai::redact`] against both secrets before it reaches the
//! webview. Plaintext HTTP is refused for any non-loopback host
//! (`ai::http`'s transport policy, reused verbatim); redirects are NOT
//! followed (Basic-auth credentials must never be replayed to a redirect
//! target — a redirect surfaces as a specific `status` error telling the
//! user to correct the URL instead), and every server-supplied href is
//! resolved against the connection's origin and REFUSED when it would
//! cross to another host/port/scheme (same rule for the stored
//! `calendar_path`/`resource_path` arguments at the command boundary).
//!
//! # Sync-token with full-sync fallback (design risks note)
//!
//! Initial sync: sync-collection REPORT without a token (the server
//! returns everything plus a fresh token). Incremental: the stored token
//! goes back. If a server does not support sync-collection (400/403/…), or
//! the stored token expired (440 / 409 / 508 / 403 class failures), the
//! client falls back to a FULL pass — sync-collection without a token, or
//! a calendar-query REPORT when sync-collection is unsupported outright —
//! and reports `mode: "full"` so the TS layer can prune stale local rows.
//! Server quirks beyond this (Fastmail/Nextcloud pagination variants,
//! iCloud time-range windows) are deferred per design D5's risk note; the
//! per-source error surface (structured `kind`/`status` command errors)
//! keeps the failures specific rather than silent.
//!
//! The task's "verify against a local Radicale container" smoke test is a
//! MANUAL pass step (no container runtime in CI); behavior is covered here
//! by loopback mock-server cargo tests (see `client.rs` tests, same
//! pattern as `ai::mock`).

use serde::Serialize;

pub(crate) mod client;
pub(crate) mod http;
pub(crate) mod xml;

#[cfg(test)]
pub(crate) mod mock;

/// Response read cap for CalDAV calls. A year of calendar-data for a busy
/// calendar can be tens of MiB, so this is deliberately above the AI
/// client's 8 MiB while still bounding a hostile endpoint.
pub(crate) const MAX_RESPONSE_BYTES: u64 = 32 * 1024 * 1024;

/// Why a CalDAV call failed. Mirrors [`crate::ai::AiError`]'s shape: the
/// spec's connection-test requirement wants a SPECIFIC failure, so
/// network vs HTTP status vs unparseable body vs bad request are distinct.
/// No variant ever stores the username or app password.
#[derive(Debug, Clone)]
pub(crate) enum CaldavError {
    /// Connection, TLS, timeout, or cap failure.
    Network(String),
    /// The server answered with a non-success status. 401/403 mean the
    /// credentials or URL are wrong (the UI reports "auth"); a 3xx means
    /// the URL should be corrected (redirects are not followed — see the
    /// module docs).
    Status { code: u16 },
    /// A 2xx answer whose body was not the expected WebDAV XML.
    Parse(String),
    /// The request itself is wrong: bad URL scheme/host, missing
    /// credentials, or a calendar path that is not an absolute path.
    Config(String),
}

impl CaldavError {
    /// Stable machine-readable kind string — the `kind` field of the
    /// structured command error.
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            CaldavError::Network(_) => "network",
            CaldavError::Status { .. } => "status",
            CaldavError::Parse(_) => "parse",
            CaldavError::Config(_) => "config",
        }
    }

    pub(crate) fn status(&self) -> Option<u16> {
        match self {
            CaldavError::Status { code } => Some(*code),
            _ => None,
        }
    }
}

impl std::fmt::Display for CaldavError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CaldavError::Network(message) => write!(f, "network error: {message}"),
            // Never include the server's body here: error bodies have been
            // seen to echo request material (Nextcloud's exception traces
            // embed URLs), and the specific status is the useful part.
            CaldavError::Status { code } => match code {
                401 | 403 => write!(f, "the server rejected the username or app password (HTTP {code})"),
                404 => write!(f, "the server has no CalDAV resource at that URL (HTTP 404)"),
                301..=308 => write!(f, "the server redirected to another URL (HTTP {code}); use the final CalDAV URL directly"),
                code => write!(f, "the CalDAV server returned HTTP {code}"),
            },
            CaldavError::Parse(message) => write!(f, "unexpected response from the CalDAV server: {message}"),
            CaldavError::Config(message) => write!(f, "configuration error: {message}"),
        }
    }
}

impl std::error::Error for CaldavError {}

impl From<crate::ai::AiError> for CaldavError {
    /// Map the shared HTTP plumbing's errors (the `ai::http` helpers this
    /// module reuses return `AiError`) into the CalDAV error type.
    fn from(error: crate::ai::AiError) -> Self {
        match error {
            crate::ai::AiError::Network(message) => CaldavError::Network(message),
            crate::ai::AiError::Status { code, .. } => CaldavError::Status { code },
            crate::ai::AiError::Parse(message) => CaldavError::Parse(message),
            crate::ai::AiError::RateLimited { .. } => {
                CaldavError::Network("rate limited by the server".to_string())
            }
            crate::ai::AiError::Config(message) => CaldavError::Config(message),
        }
    }
}

/// The webview-facing error shape for the `caldav_*` commands:
/// `{ kind, message, status? }` — the same structured contract as
/// `ai_chat`'s, so the TS layer can branch without parsing prose.
#[derive(Debug, Serialize)]
pub struct CaldavCommandError {
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

/// Scrub both secrets out of a message (defense in depth — the client
/// never puts credentials in errors, but server-supplied text could echo
/// them; same last-line redaction as `ai_chat`).
fn into_command_error(error: CaldavError, username: &str, app_password: &str) -> CaldavCommandError {
    let mut message = error.to_string();
    for secret in [username, app_password] {
        message = crate::ai::redact(&message, Some(secret));
    }
    CaldavCommandError {
        kind: error.kind().to_string(),
        message,
        status: error.status(),
    }
}

/// One discovered calendar collection (spec: "Connection SHALL discover
/// the available calendars"): `href` is the ABSOLUTE URL of the
/// collection (multistatus hrefs joined against the server base and
/// origin-checked — a href that would leave the connection's
/// host/port/scheme is refused rather than followed with credentials).
/// The TS layer stores it as the calendar path and hands it back to
/// [`caldav_sync`].
#[derive(Debug, Clone, Serialize)]
pub struct CaldavDiscoveredCalendar {
    pub href: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ctag: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CaldavDiscoverResponse {
    pub calendars: Vec<CaldavDiscoveredCalendar>,
}

/// One changed event from a REPORT: the resource href and the raw
/// calendar-data (a full iCalendar VCALENDAR blob — stored as-is in
/// `calendar_events.ical` so every provider shares the uniform RFC 5545
/// surface; TS parses it with the task 5.5 `ics.ts` parser).
#[derive(Debug, Clone, Serialize)]
pub struct CaldavSyncEvent {
    pub href: String,
    pub ical: String,
}

#[derive(Debug, Serialize)]
pub struct CaldavSyncResponse {
    /// "delta" when the server answered a token'd incremental REPORT,
    /// "full" for every initial/fallback pass (the TS layer prunes stale
    /// local rows on "full").
    pub mode: String,
    /// The token to persist for the next incremental pass; null when the
    /// server cannot do incremental sync at all (calendar-query fallback)
    /// — every sync is then a full pass.
    pub next_sync_token: Option<String>,
    pub changed: Vec<CaldavSyncEvent>,
    /// Resource hrefs the server reported as deleted (sync-collection 404
    /// responses). Empty on "full" passes — pruning handles those.
    pub removed: Vec<String>,
}

fn credentials(username: &str, app_password: &str) -> Result<client::CalDavCredentials, CaldavError> {
    if username.trim().is_empty() {
        return Err(CaldavError::Config("a username is required".to_string()));
    }
    if app_password.is_empty() {
        return Err(CaldavError::Config(
            "an app password is required".to_string(),
        ));
    }
    Ok(client::CalDavCredentials {
        username: username.to_string(),
        app_password: app_password.to_string(),
    })
}

/// Validate the server URL shape once, up front, so all three commands
/// share the same error surface for a malformed URL.
fn validate_server_url(server_url: &str) -> Result<(), CaldavError> {
    crate::ai::http::parse_request_url(server_url)
        .map(|_| ())
        .map_err(CaldavError::from)
}

/// Refuse a URL-shaped path argument (`calendar_path` / `resource_path`)
/// that would carry the connection's Basic credentials to another
/// origin — the command-boundary twin of the client's href guard (the
/// CardDAV commands apply the same check to `book_url`/`href`). Absolute
/// PATHS (no scheme — the normal stored form) pass through untouched.
fn require_same_origin(server_url: &str, path_or_url: &str) -> Result<(), CaldavError> {
    if !path_or_url.contains("://") {
        return Ok(());
    }
    let server = crate::ai::http::parse_request_url(server_url)?;
    let target = crate::ai::http::parse_request_url(path_or_url)?;
    if target.host.eq_ignore_ascii_case(&server.host)
        && target.port == server.port
        && target.https == server.https
    {
        Ok(())
    } else {
        Err(CaldavError::Config(
            "the path must live on the same server as the connection".to_string(),
        ))
    }
}

/// Connection test (spec: "A connection test SHALL report success or a
/// specific failure reason"): one PROPFIND Depth 0 with Basic auth against
/// the given server URL. Ok on 2xx; a structured error otherwise (401/403
/// → "the server rejected the username or app password", redirects →
/// "use the final CalDAV URL", network failures → their own kind).
///
/// Arguments carry the UNSEALED credentials for THIS call — the TS layer
/// decrypts them per call from the source's sealed envelope (see the
/// module docs for the never-log/never-echo contract).
#[tauri::command]
pub async fn caldav_test_connection(
    server_url: String,
    username: String,
    app_password: String,
) -> Result<(), CaldavCommandError> {
    run_test_connection(&server_url, &username, &app_password)
        .await
        .map_err(|error| into_command_error(error, &username, &app_password))
}

async fn run_test_connection(
    server_url: &str,
    username: &str,
    app_password: &str,
) -> Result<(), CaldavError> {
    validate_server_url(server_url)?;
    let credentials = credentials(username, app_password)?;
    client::test_connection(server_url, &credentials).await
}

/// Discover the calendar collections reachable from `server_url`
/// (current-user-principal → calendar-home-set → Depth-1 listing, with a
/// direct Depth-1 fallback when the pasted URL already IS a calendar
/// home/collection). The credentials contract matches
/// [`caldav_test_connection`].
#[tauri::command]
pub async fn caldav_discover(
    server_url: String,
    username: String,
    app_password: String,
) -> Result<CaldavDiscoverResponse, CaldavCommandError> {
    run_discover(&server_url, &username, &app_password)
        .await
        .map(|calendars| CaldavDiscoverResponse { calendars })
        .map_err(|error| into_command_error(error, &username, &app_password))
}

async fn run_discover(
    server_url: &str,
    username: &str,
    app_password: &str,
) -> Result<Vec<CaldavDiscoveredCalendar>, CaldavError> {
    validate_server_url(server_url)?;
    let credentials = credentials(username, app_password)?;
    Ok(client::discover(server_url, &credentials)
        .await?
        .calendars)
}

/// Sync one calendar collection (design D5): sync-collection REPORT with
/// the stored token (incremental, mode "delta") or without one (initial /
/// fallback, mode "full"), falling back to a calendar-query full pass when
/// the server rejects sync-collection. `calendar_path` is one of the
/// hrefs `caldav_discover` returned (an absolute path on the server).
/// The credentials contract matches [`caldav_test_connection`].
#[tauri::command]
pub async fn caldav_sync(
    server_url: String,
    username: String,
    app_password: String,
    calendar_path: String,
    sync_token: Option<String>,
) -> Result<CaldavSyncResponse, CaldavCommandError> {
    run_sync(&server_url, &username, &app_password, &calendar_path, sync_token)
        .await
        .map_err(|error| into_command_error(error, &username, &app_password))
}

async fn run_sync(
    server_url: &str,
    username: &str,
    app_password: &str,
    calendar_path: &str,
    sync_token: Option<String>,
) -> Result<CaldavSyncResponse, CaldavError> {
    validate_server_url(server_url)?;
    // An absolute-URL calendar path must stay on the connection's
    // origin (absolute paths are the normal stored form).
    require_same_origin(server_url, calendar_path)?;
    let credentials = credentials(username, app_password)?;
    let outcome = client::sync(
        server_url,
        &credentials,
        calendar_path,
        sync_token.as_deref(),
    )
    .await?;
    Ok(CaldavSyncResponse {
        mode: outcome.mode.to_string(),
        next_sync_token: outcome.next_sync_token,
        changed: outcome
            .changed
            .into_iter()
            .map(|(href, ical)| CaldavSyncEvent { href, ical })
            .collect(),
        removed: outcome.removed,
    })
}

/// Write one event resource (task 5.4): PUT the raw iCalendar VCALENDAR
/// blob the webview built to `{calendar href}{uid}.ics` (RFC 4791 §5.3.2).
/// `resource_path` is the absolute path/URL of the event resource the TS
/// layer derives from the collection href + event uid. Ok on 2xx; the
/// credentials contract matches [`caldav_test_connection`].
#[tauri::command]
pub async fn caldav_put_event(
    server_url: String,
    username: String,
    app_password: String,
    resource_path: String,
    ical: String,
) -> Result<(), CaldavCommandError> {
    async {
        validate_server_url(&server_url)?;
        // An absolute-URL resource path must stay on the connection's
        // origin (absolute paths are the normal stored form).
        require_same_origin(&server_url, &resource_path)?;
        let credentials = credentials(&username, &app_password)?;
        client::put_event(&server_url, &credentials, &resource_path, &ical).await
    }
    .await
    .map_err(|error: CaldavError| into_command_error(error, &username, &app_password))
}

/// Delete one event resource (task 5.4): DELETE against the resource
/// href. 404 answers Ok (already gone — deletion is idempotent, the local
/// row may be dropped); the credentials contract matches
/// [`caldav_test_connection`].
#[tauri::command]
pub async fn caldav_delete_event(
    server_url: String,
    username: String,
    app_password: String,
    resource_path: String,
) -> Result<(), CaldavCommandError> {
    async {
        validate_server_url(&server_url)?;
        // An absolute-URL resource path must stay on the connection's
        // origin (absolute paths are the normal stored form).
        require_same_origin(&server_url, &resource_path)?;
        let credentials = credentials(&username, &app_password)?;
        client::delete_event(&server_url, &credentials, &resource_path).await
    }
    .await
    .map_err(|error: CaldavError| into_command_error(error, &username, &app_password))
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_kinds_are_specific_and_stable() {
        assert_eq!(CaldavError::Network("x".into()).kind(), "network");
        assert_eq!(CaldavError::Status { code: 401 }.kind(), "status");
        assert_eq!(CaldavError::Parse("x".into()).kind(), "parse");
        assert_eq!(CaldavError::Config("x".into()).kind(), "config");
        assert_eq!(CaldavError::Status { code: 401 }.status(), Some(401));
        assert_eq!(CaldavError::Config("x".into()).status(), None);
    }

    #[test]
    fn status_messages_name_the_failure_without_the_body() {
        let auth = CaldavError::Status { code: 401 }.to_string();
        assert!(auth.contains("username or app password"), "{auth}");
        let redirect = CaldavError::Status { code: 302 }.to_string();
        assert!(redirect.contains("redirected"), "{redirect}");
        let missing = CaldavError::Status { code: 404 }.to_string();
        assert!(missing.contains("404"), "{missing}");
        let other = CaldavError::Status { code: 503 }.to_string();
        assert!(other.contains("503"), "{other}");
    }

    #[tokio::test]
    async fn command_errors_redact_both_secrets() {
        let username = "secret-user-42";
        let password = "super-app-password-99";
        // A hostile body is never embedded today, but the last-line
        // redaction must hold if a message ever picks one up.
        let error = CaldavError::Parse(format!(
            "server said: auth failed for {username} with {password}"
        ));
        let command_error = into_command_error(error, username, password);
        assert!(!command_error.message.contains(username), "{command_error:?}");
        assert!(
            !command_error.message.contains(password),
            "{command_error:?}"
        );
        assert!(command_error.message.contains("[redacted]"));
        assert_eq!(command_error.kind, "parse");
    }

    #[tokio::test]
    async fn empty_credentials_are_a_config_error() {
        assert_eq!(
            run_test_connection("https://dav.example.com/", "", "").await.unwrap_err().kind(),
            "config"
        );
        assert_eq!(
            run_test_connection("https://dav.example.com/", "user", "")
                .await
                .unwrap_err()
                .kind(),
            "config"
        );
    }

    #[tokio::test]
    async fn bad_server_urls_are_config_errors_before_any_io() {
        let error = run_test_connection("ftp://dav.example.com/", "user", "pass")
            .await
            .unwrap_err();
        assert_eq!(error.kind(), "config");
        // Plaintext to a non-loopback host is refused by the shared
        // transport policy.
        let error = run_test_connection("http://dav.example.com/", "user", "pass")
            .await
            .unwrap_err();
        assert_eq!(error.kind(), "config");
    }

    #[tokio::test]
    async fn cross_origin_path_arguments_are_refused_before_any_io() {
        // A URL-shaped calendar/resource path pointing at another origin
        // is a config error before any request carries credentials
        // there (dav.example.com does not resolve here — the guard fires
        // first, so no network error can surface).
        let error = run_sync(
            "https://dav.example.com/",
            "user",
            "pass",
            "https://evil.example/cal/home/",
            None,
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind(), "config");
        assert!(error.to_string().contains("same server"), "{error}");

        let error = caldav_put_event(
            "https://dav.example.com/".to_string(),
            "user".to_string(),
            "pass".to_string(),
            "https://evil.example/cal/home/x.ics".to_string(),
            "BEGIN:VCALENDAR".to_string(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, "config");

        let error = caldav_delete_event(
            "https://dav.example.com/".to_string(),
            "user".to_string(),
            "pass".to_string(),
            "https://evil.example/cal/home/x.ics".to_string(),
        )
        .await
        .unwrap_err();
        assert_eq!(error.kind, "config");

        // Same-origin URL paths and absolute paths pass the guard (the
        // latter is the normal stored form).
        assert!(require_same_origin("https://dav.example.com/dav/", "/dav/user/cal/").is_ok());
        assert!(
            require_same_origin("https://dav.example.com/dav/", "https://dav.example.com/dav/x/")
                .is_ok()
        );
        // Host casing does not matter; port and scheme do.
        assert!(require_same_origin("https://dav.example.com/", "https://DAV.EXAMPLE.COM/cal/")
            .is_ok());
        assert!(require_same_origin("https://dav.example.com/", "https://dav.example.com:8443/")
            .is_err());
        assert!(require_same_origin("https://dav.example.com/", "http://dav.example.com/").is_err());
    }
}
