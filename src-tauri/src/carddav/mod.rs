//! Minimal CardDAV client and the `carddav_*` commands (parity-round-2
//! tasks 4.1–4.3, design D4) — the address-book sibling of [`crate::caldav`].
//!
//! D4 in one line: a hand-rolled minimal client in Rust — PROPFIND for
//! discovery, `addressbook-query` REPORT (sync-collection when the server
//! offers a token, with a full-pull fallback), `addressbook-multiget` for
//! fetches and PUT/DELETE write-back — reusing the CalDAV transport
//! ([`crate::caldav::http`], same TCP + native-tls stack, 32 MiB response
//! cap, no-redirect posture) and the same quick-xml multistatus approach.
//! No new crates.
//!
//! Modules:
//! - [`xml`]   — WebDAV `multistatus` parsing into flat, local-name keyed
//!   items (namespace-insensitive, successful-propstat-wins status
//!   selection, depth/item caps so a hostile server cannot blow the
//!   parser).
//! - [`vcard`] — vCard 3.0/4.0 parse/serialize/update: ONLY the standard
//!   properties are projected (FN, N, EMAIL, TEL, ORG, TITLE, BDAY, NOTE,
//!   UID, REV); every other line (PHOTO, LOGO, X- extensions, extra
//!   EMAIL/TEL/URL lines) is preserved verbatim through an edit, so
//!   writing back never destroys data the contact UI does not show.
//! - [`client`] — the protocol operations: the discovery chain
//!   (pasted-collection shortcut → current-user-principal over the base
//!   URL and `/.well-known/carddav` → addressbook-home-set → Depth-1
//!   listing filtered on the addressbook resourcetype), the ctag /
//!   sync-token sync pass with its full-pull fallback, batched multiget
//!   fetches, and the etag-disciplined PUT/DELETE writes.
//!
//! # Security / credentials contract (identical posture to `caldav`)
//!
//! CardDAV travels ONLY through these commands. The TS layer unseals the
//! book's sealed envelope (`crypto/credentials`, AES-256-GCM) and passes
//! the PLAINTEXT username + app password per call; credentials are never
//! persisted by this module, never logged, and never echoed — every error
//! message goes through [`crate::ai::redact`] against both secrets before
//! it reaches the webview. Plaintext HTTP is refused for non-loopback
//! hosts (`ai::http`'s transport policy, reused verbatim); redirects are
//! NOT followed (Basic-auth credentials are never replayed to a redirect
//! target). Additional guards this module layers on top: URLs carrying
//! userinfo (`user@host`) or a fragment are config errors, URLs are
//! capped at [`MAX_URL_BYTES`], and every server-supplied href is
//! resolved against the request base and REFUSED when it would cross to
//! another origin (credentials must never be forwarded cross-origin).
//!
//! # Sync model (checklist behaviors, RFC 6578 + RFC 6764)
//!
//! `carddav_sync_book` runs ONE pass over one address book:
//!
//! 1. PROPFIND Depth 0 for `getctag` + `sync-token`; when the stored ctag
//!    still matches the pass is skipped entirely (mode "unchanged").
//! 2. sync-collection REPORT — Depth 0, `sync-level 1`, etag-only props,
//!    EMPTY token element for the initial state — when a stored token
//!    exists or the server advertises support. A `valid-sync-token` error
//!    body (RFC 6578) or a 403/404/409/440 answer falls back to (3).
//! 3. Full pull: `addressbook-query` REPORT, Depth 1, filtered on FN (so
//!    email-less cards still list), every item required to carry an ETag;
//!    local-minus-remote hrefs become removals.
//! 4. Changed hrefs are fetched in `addressbook-multiget` batches of at
//!    most 50; EVERY requested href must come back (a missing one is an
//!    error), an item 404 counts as a removal, missing ETag/address-data
//!    is an error.
//!
//! Failure isolation: a failed pass returns an error BEFORE anything is
//! applied — the TS layer only writes on success, so a broken REPORT can
//! never delete a local contact. Cards that fail to parse (or exceed the
//! 2 MiB per-card cap) never sink the pass: they are counted in
//! `skipped` (warn-with-count) and the mapped cards still land.
//!
//! Conflict rule (spec "last write wins"): PUT carries `If-Match` on
//! update and `If-None-Match: *` on create; a 412 triggers an immediate
//! GET for a fresh ETag and a re-PUT of the LOCAL version (last write
//! wins — the mirror image of the reference's server-wins choice, per the
//! Emailer spec). A PUT response without an ETag is followed by a GET
//! refetch; a DELETE 404 counts as success.

use serde::{Deserialize, Serialize};

pub(crate) mod client;
pub(crate) mod vcard;
pub(crate) mod xml;

/// URL length cap (checklist: ~16 KiB) — a hostile discovery answer must
/// not be able to make the client build absurd request lines.
pub(crate) const MAX_URL_BYTES: usize = 16 * 1024;

/// Per-card cap before vCard parsing (checklist: ~2 MiB). Larger
/// `address-data` blobs are counted as skipped, never parsed.
pub(crate) const MAX_CARD_BYTES: usize = 2 * 1024 * 1024;

/// Why a CardDAV call failed. Mirrors [`crate::caldav::CaldavError`]'s
/// shape plus one variant: a 401 anywhere in a flow is surfaced as the
/// TYPED needs-reauth error ([`CarddavError::Auth`]) so the TS layer can
/// ask for a reconnect without parsing prose. No variant ever stores the
/// username or app password.
#[derive(Debug, Clone)]
pub(crate) enum CarddavError {
    /// Connection, TLS, timeout, or cap failure.
    Network(String),
    /// The server answered with a non-success status (3xx = a redirect we
    /// refuse to follow; 403 on a write usually means a read-only book).
    Status { code: u16 },
    /// 401: the credentials were rejected — reconnect the address book.
    Auth,
    /// A 2xx answer whose body was not the expected WebDAV XML / vCard.
    Parse(String),
    /// The request itself is wrong: bad URL scheme/host, userinfo or
    /// fragment in the URL, a cross-origin href, missing credentials.
    Config(String),
}

impl CarddavError {
    /// Stable machine-readable kind string — the `kind` field of the
    /// structured command error.
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            CarddavError::Network(_) => "network",
            CarddavError::Status { .. } => "status",
            CarddavError::Auth => "auth",
            CarddavError::Parse(_) => "parse",
            CarddavError::Config(_) => "config",
        }
    }

    pub(crate) fn status(&self) -> Option<u16> {
        match self {
            CarddavError::Status { code } => Some(*code),
            CarddavError::Auth => Some(401),
            _ => None,
        }
    }
}

impl std::fmt::Display for CarddavError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CarddavError::Network(message) => write!(f, "network error: {message}"),
            // Never include the server's body here: error bodies have been
            // seen to echo request material, and the specific status is
            // the useful part.
            CarddavError::Status { code } => match code {
                403 => write!(
                    f,
                    "the server refused the change (HTTP 403); the address book may be read-only"
                ),
                404 => write!(f, "the server has no such CardDAV resource (HTTP 404)"),
                301..=308 => write!(
                    f,
                    "the server redirected to another URL (HTTP {code}); use the final CardDAV URL directly"
                ),
                code => write!(f, "the CardDAV server returned HTTP {code}"),
            },
            CarddavError::Auth => write!(
                f,
                "the server rejected the username or app password (HTTP 401); reconnect the address book"
            ),
            CarddavError::Parse(message) => {
                write!(f, "unexpected response from the CardDAV server: {message}")
            }
            CarddavError::Config(message) => write!(f, "configuration error: {message}"),
        }
    }
}

impl std::error::Error for CarddavError {}

impl From<crate::ai::AiError> for CarddavError {
    /// Map the shared HTTP plumbing's errors (the `ai::http` helpers this
    /// module reuses return `AiError`) into the CardDAV error type.
    fn from(error: crate::ai::AiError) -> Self {
        match error {
            crate::ai::AiError::Network(message) => CarddavError::Network(message),
            crate::ai::AiError::Status { code, .. } => CarddavError::Status { code },
            crate::ai::AiError::Parse(message) => CarddavError::Parse(message),
            crate::ai::AiError::RateLimited { .. } => {
                CarddavError::Network("rate limited by the server".to_string())
            }
            crate::ai::AiError::Config(message) => CarddavError::Config(message),
        }
    }
}

impl From<crate::caldav::CaldavError> for CarddavError {
    /// The reused transport ([`crate::caldav::http::request_raw`]) speaks
    /// `CaldavError`; map it 1:1 (401 keeps its own typed variant below —
    /// the transport reports it as a status, and the carddav request
    /// helpers re-map 401 to [`CarddavError::Auth`]).
    fn from(error: crate::caldav::CaldavError) -> Self {
        match error {
            crate::caldav::CaldavError::Network(message) => CarddavError::Network(message),
            crate::caldav::CaldavError::Status { code } => CarddavError::Status { code },
            crate::caldav::CaldavError::Parse(message) => CarddavError::Parse(message),
            crate::caldav::CaldavError::Config(message) => CarddavError::Config(message),
        }
    }
}

/// The webview-facing error shape for the `carddav_*` commands:
/// `{ kind, message, status? }` — the same structured contract as the
/// `caldav_*` commands, with the extra "auth" kind for 401.
#[derive(Debug, Serialize)]
pub struct CarddavCommandError {
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
}

/// Scrub both secrets out of a message (defense in depth — the client
/// never puts credentials in errors, but server-supplied text could echo
/// them; same last-line redaction as `caldav`).
fn into_command_error(error: CarddavError, username: &str, app_password: &str) -> CarddavCommandError {
    let mut message = error.to_string();
    for secret in [username, app_password] {
        message = crate::ai::redact(&message, Some(secret));
    }
    CarddavCommandError {
        kind: error.kind().to_string(),
        message,
        status: error.status(),
    }
}

/// Validate the server URL once, up front, so all commands share the same
/// error surface: length cap, the shared transport policy (HTTPS except
/// loopback), no userinfo in the authority, no fragment.
pub(crate) fn validate_server_url(server_url: &str) -> Result<crate::ai::http::RequestUrl, CarddavError> {
    if server_url.len() > MAX_URL_BYTES {
        return Err(CarddavError::Config(
            "the server URL is longer than 16 KiB".to_string(),
        ));
    }
    // Userinfo and fragments are checked on the raw string BEFORE the
    // shared parse (a `user:pass@host` authority would otherwise die as
    // "invalid port" inside the shared parser with a less precise error).
    if let Some((_, authority_and_path)) = server_url.split_once("://") {
        let authority = authority_and_path
            .split(['/', '?', '#'])
            .next()
            .unwrap_or("");
        if authority.contains('@') {
            return Err(CarddavError::Config(
                "the server URL must not contain user info (user:pass@host); \
                 enter the username and app password separately"
                    .to_string(),
            ));
        }
    }
    let parsed = crate::ai::http::parse_request_url(server_url)?;
    if parsed.target.contains('#') {
        return Err(CarddavError::Config(
            "the server URL must not contain a fragment (#)".to_string(),
        ));
    }
    Ok(parsed)
}

/// One discovered address book collection. `href` is the ABSOLUTE URL of
/// the collection (server hrefs joined against the request base and
/// origin-checked); the TS layer stores it as the book URL and hands it
/// back to `carddav_sync_book`.
#[derive(Debug, Clone, Serialize)]
pub struct CarddavDiscoveredBook {
    pub href: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    /// `current-user-privilege-set` says write-content is absent.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub read_only: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ctag: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CarddavDiscoverResponse {
    pub books: Vec<CarddavDiscoveredBook>,
}

/// One fetched card after `addressbook-multiget`: the absolute href, the
/// ETag the TS layer stores for the next If-Match, the RAW vCard
/// (preserved verbatim in the contact row so edits re-serialize without
/// data loss) and the parsed projection of the standard properties.
#[derive(Debug, Clone, Serialize)]
pub struct CarddavSyncCard {
    pub href: String,
    pub etag: String,
    pub vcard: String,
    pub uid: String,
    pub full_name: String,
    /// Lowercased — the contacts row's identity key.
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct CarddavSyncResponse {
    /// "unchanged" (ctag short-circuit hit), "delta" (token'd incremental
    /// REPORT) or "full" (initial/fallback pass).
    pub mode: String,
    /// The token to persist for the next incremental pass; null when the
    /// server cannot do incremental sync (full-pull-only server).
    pub next_sync_token: Option<String>,
    /// The fresh `getctag` for the next short-circuit check.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ctag: Option<String>,
    pub cards: Vec<CarddavSyncCard>,
    /// Absolute hrefs the server reported deleted (delta) or that are
    /// gone from the full listing (full). Empty on "unchanged".
    pub removed: Vec<String>,
    /// Cards skipped this pass: parse failures, missing required
    /// properties (UID/FN/email), or over the 2 MiB per-card cap. A
    /// skipped card NEVER deletes or blocks the others (design D4:
    /// warn-with-count, never a silent drop of the pass).
    pub skipped: u32,
}

/// One locally-known card the TS layer passes in so the client can skip
/// unchanged hrefs and compute full-pull removals.
#[derive(Debug, Clone, Deserialize)]
pub struct CarddavKnownCard {
    pub href: String,
    pub etag: Option<String>,
}

/// The result of one write: the resource href and the ETag to store for
/// the next If-Match (always present on success — a PUT response without
/// an ETag is followed by a GET refetch, and a still-missing ETag is an
/// error), plus the serialized card as the server now holds it (stored
/// verbatim in the contact row).
#[derive(Debug, Clone, Serialize)]
pub struct CarddavPutResponse {
    pub href: String,
    pub etag: String,
    pub vcard: String,
}

fn credentials(username: &str, app_password: &str) -> Result<client::CardDavCredentials, CarddavError> {
    if username.trim().is_empty() {
        return Err(CarddavError::Config("a username is required".to_string()));
    }
    if app_password.is_empty() {
        return Err(CarddavError::Config("an app password is required".to_string()));
    }
    Ok(client::CardDavCredentials {
        username: username.to_string(),
        app_password: app_password.to_string(),
    })
}

/// Discover the address books reachable from `server_url` (the checklist
/// discovery chain; see [`client::discover`]). The credentials contract
/// matches [`carddav_sync_book`].
#[tauri::command]
pub async fn carddav_discover_books(
    server_url: String,
    username: String,
    app_password: String,
) -> Result<CarddavDiscoverResponse, CarddavCommandError> {
    async {
        let parsed = validate_server_url(&server_url)?;
        let credentials = credentials(&username, &app_password)?;
        client::discover(&parsed, &credentials).await
    }
    .await
    .map(|books| CarddavDiscoverResponse { books })
    .map_err(|error: CarddavError| into_command_error(error, &username, &app_password))
}

/// Sync one address book collection (the checklist sync pass; see
/// [`client::sync_book`]). `book_url` is a href `carddav_discover_books`
/// returned; `known_cards` is the locally stored {href, etag} set for
/// this book (drives the etag diff and the full-pull removals). The
/// credentials contract matches the module docs: unsealed per call,
/// never persisted.
#[tauri::command]
pub async fn carddav_sync_book(
    server_url: String,
    username: String,
    app_password: String,
    book_url: String,
    sync_token: Option<String>,
    ctag: Option<String>,
    known_cards: Vec<CarddavKnownCard>,
) -> Result<CarddavSyncResponse, CarddavCommandError> {
    async {
        let parsed = validate_server_url(&server_url)?;
        let credentials = credentials(&username, &app_password)?;
        let book_parsed = validate_server_url(&book_url)?;
        if book_parsed.host != parsed.host
            || book_parsed.port != parsed.port
            || book_parsed.https != parsed.https
        {
            return Err(CarddavError::Config(
                "the address book URL must live on the same server as the connection"
                    .to_string(),
            ));
        }
        client::sync_book(
            &parsed,
            &credentials,
            &book_parsed.target,
            sync_token.as_deref().filter(|token| !token.trim().is_empty()),
            ctag.as_deref().filter(|tag| !tag.trim().is_empty()),
            &known_cards,
        )
        .await
    }
    .await
    .map(|outcome| CarddavSyncResponse {
        mode: outcome.mode.to_string(),
        next_sync_token: outcome.next_sync_token,
        ctag: outcome.ctag,
        cards: outcome
            .cards
            .into_iter()
            .map(|card| CarddavSyncCard {
                href: card.href,
                etag: card.etag,
                vcard: card.vcard,
                uid: card.summary.uid,
                full_name: card.summary.full_name,
                email: card.summary.email,
                note: card.summary.note,
            })
            .collect(),
        removed: outcome.removed,
        skipped: outcome.skipped,
    })
    .map_err(|error: CarddavError| into_command_error(error, &username, &app_password))
}

/// Create or update one contact card on the server (the etag-disciplined
/// write; see [`client::put_card`]). Two shapes:
///
/// - CREATE: `uid` + `email` given, `href`/`existing_vcard` absent — the
///   card is serialized fresh as vCard 3.0 with the given `urn:uuid:` UID
///   and PUT with `If-None-Match: *` to `{book_url}{uid}.vcf`.
/// - UPDATE: `href` + `existing_vcard` given — the new name/note are
///   swapped into the existing card (every other line preserved) and PUT
///   with `If-Match` when `existing_etag` is known. A 412 resolves per
///   the spec's last-write-wins: immediate GET for a fresh ETag, re-PUT
///   of the local version.
#[tauri::command]
pub async fn carddav_put_card(
    server_url: String,
    username: String,
    app_password: String,
    book_url: String,
    name: String,
    note: Option<String>,
    email: Option<String>,
    uid: Option<String>,
    href: Option<String>,
    existing_vcard: Option<String>,
    existing_etag: Option<String>,
) -> Result<CarddavPutResponse, CarddavCommandError> {
    async {
        let parsed = validate_server_url(&server_url)?;
        let credentials = credentials(&username, &app_password)?;
        let book_parsed = validate_server_url(&book_url)?;
        if book_parsed.host != parsed.host
            || book_parsed.port != parsed.port
            || book_parsed.https != parsed.https
        {
            return Err(CarddavError::Config(
                "the address book URL must live on the same server as the connection"
                    .to_string(),
            ));
        }
        let input = match (href, existing_vcard) {
            (Some(href), Some(vcard)) => client::PutCardInput::Update {
                href,
                etag: existing_etag.filter(|etag| !etag.trim().is_empty()),
                vcard,
                name,
                note,
                uid_fallback: uid.unwrap_or_default(),
            },
            _ => client::PutCardInput::Create {
                uid: uid.filter(|uid| !uid.trim().is_empty())
                    .ok_or_else(|| CarddavError::Config("creating a contact requires a UID".to_string()))?,
                email: email
                    .filter(|email| !email.trim().is_empty())
                    .ok_or_else(|| {
                        CarddavError::Config("creating a contact requires an email address".to_string())
                    })?,
                name,
                note,
            },
        };
        client::put_card(&parsed, &credentials, &book_parsed.target, &input).await
    }
    .await
    .map(|outcome| CarddavPutResponse {
        href: outcome.href,
        etag: outcome.etag,
        vcard: outcome.vcard,
    })
    .map_err(|error: CarddavError| into_command_error(error, &username, &app_password))
}

/// Delete one contact card (see [`client::delete_card`]): DELETE with
/// `If-Match` when an ETag is known; a 404 counts as success (already
/// gone — the local row may be dropped); a 412 retries once WITHOUT the
/// precondition (last-write-wins: the deletion wins).
#[tauri::command]
pub async fn carddav_delete_card(
    server_url: String,
    username: String,
    app_password: String,
    href: String,
    etag: Option<String>,
) -> Result<(), CarddavCommandError> {
    async {
        let parsed = validate_server_url(&server_url)?;
        let credentials = credentials(&username, &app_password)?;
        let href_parsed = validate_server_url(&href)?;
        if href_parsed.host != parsed.host
            || href_parsed.port != parsed.port
            || href_parsed.https != parsed.https
        {
            return Err(CarddavError::Config(
                "the card URL must live on the same server as the connection".to_string(),
            ));
        }
        client::delete_card(
            &parsed,
            &credentials,
            &href_parsed.target,
            etag.as_deref().filter(|etag| !etag.trim().is_empty()),
        )
        .await
    }
    .await
    .map_err(|error: CarddavError| into_command_error(error, &username, &app_password))
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_kinds_are_specific_and_stable() {
        assert_eq!(CarddavError::Network("x".into()).kind(), "network");
        assert_eq!(CarddavError::Status { code: 403 }.kind(), "status");
        assert_eq!(CarddavError::Auth.kind(), "auth");
        assert_eq!(CarddavError::Parse("x".into()).kind(), "parse");
        assert_eq!(CarddavError::Config("x".into()).kind(), "config");
        assert_eq!(CarddavError::Auth.status(), Some(401));
        assert_eq!(CarddavError::Status { code: 412 }.status(), Some(412));
        assert_eq!(CarddavError::Config("x".into()).status(), None);
    }

    #[test]
    fn auth_and_readonly_messages_name_the_failure_without_the_body() {
        let auth = CarddavError::Auth.to_string();
        assert!(auth.contains("username or app password"), "{auth}");
        assert!(auth.contains("reconnect"), "{auth}");
        let forbidden = CarddavError::Status { code: 403 }.to_string();
        assert!(forbidden.contains("read-only"), "{forbidden}");
        let redirect = CarddavError::Status { code: 302 }.to_string();
        assert!(redirect.contains("redirected"), "{redirect}");
    }

    #[test]
    fn command_errors_redact_both_secrets() {
        let username = "secret-user-42";
        let password = "super-app-password-99";
        let error = CarddavError::Parse(format!(
            "server said: auth failed for {username} with {password}"
        ));
        let command_error = into_command_error(error, username, password);
        assert!(!command_error.message.contains(username), "{command_error:?}");
        assert!(!command_error.message.contains(password), "{command_error:?}");
        assert!(command_error.message.contains("[redacted]"));
        assert_eq!(command_error.kind, "parse");
    }

    #[tokio::test]
    async fn url_guards_reject_userinfo_fragments_and_oversize() {
        // Userinfo in the authority is refused (credentials ride the Basic
        // header, never the URL).
        let error = validate_server_url("https://user:pass@dav.example.com/").unwrap_err();
        assert_eq!(error.kind(), "config");
        assert!(error.to_string().contains("user info"), "{error}");
        // Fragments never reach a server.
        let error = validate_server_url("https://dav.example.com/#frag").unwrap_err();
        assert_eq!(error.kind(), "config");
        // Oversize URLs are refused before any I/O.
        let long = format!("https://dav.example.com/{}", "a".repeat(MAX_URL_BYTES));
        assert_eq!(validate_server_url(&long).unwrap_err().kind(), "config");
        // Non-loopback plaintext HTTP stays refused by the shared policy.
        assert_eq!(
            validate_server_url("http://dav.example.com/").unwrap_err().kind(),
            "config"
        );
        // A plain https URL passes and round-trips its parts.
        let parsed = validate_server_url("https://dav.example.com:8443/dav/").unwrap();
        assert_eq!(parsed.host, "dav.example.com");
        assert_eq!(parsed.port, 8443);
        assert!(parsed.https);
    }

    #[test]
    fn empty_credentials_are_a_config_error() {
        assert_eq!(credentials("", "pass").unwrap_err().kind(), "config");
        assert_eq!(credentials("user", "").unwrap_err().kind(), "config");
        assert!(credentials("user", "pass").is_ok());
    }
}
