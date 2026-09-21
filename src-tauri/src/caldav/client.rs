//! CalDAV protocol operations (task 5.2, design D5): connection test,
//! discovery (current-user-principal → calendar-home-set → Depth-1
//! listing, with a direct-listing fallback) and sync (sync-collection
//! REPORT with sync-token, full-sync fallbacks).
//!
//! All requests are Basic-authenticated (the app-password model from the
//! spec's CalDAV connect scenario) and all failures are specific
//! [`CaldavError`]s. Server variance beyond this flow (Fastmail/Nextcloud
//! quirks) is deferred per design D5's risk note — see `mod.rs`.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

use super::http::{join_url, request_raw};
use super::xml::parse_multistatus;
use super::{CaldavError, CaldavDiscoveredCalendar};
use crate::ai::http::parse_request_url;

/// The per-call credentials. The TS layer unseals them from the source's
/// AES-GCM config envelope for EXACTLY one command call — they are never
/// persisted, logged, or echoed here (see `mod.rs` for the contract).
#[derive(Debug, Clone)]
pub(crate) struct CalDavCredentials {
    pub username: String,
    pub app_password: String,
}

/// HTTP statuses that mean the STORED sync token is no longer usable
/// (403/409 token invalid per RFC 6578 practice, 440 the de-facto "lost
/// sync token"): a full re-sync is attempted instead of failing.
const SYNC_TOKEN_REJECTED_CODES: [u16; 4] = [403, 404, 409, 440];
/// HTTP statuses that mean the server does not support sync-collection
/// REPORTs at all (wrong method, unknown report, bad body): the initial
/// full pass falls back to a calendar-query REPORT.
const SYNC_COLLECTION_UNSUPPORTED_CODES: [u16; 5] = [400, 403, 405, 422, 501];

/// `Authorization: Basic …` — the RFC 4648 base64 of `user:pass` (the
/// app-password flow of Fastmail/Nextcloud/Radicale alike).
pub(crate) fn basic_auth_header(username: &str, app_password: &str) -> String {
    format!(
        "Basic {}",
        BASE64.encode(format!("{username}:{app_password}").as_bytes())
    )
}

/// Headers every request carries (request bodies are always XML).
fn xml_request_headers(credentials: &CalDavCredentials) -> Vec<(&'static str, String)> {
    vec![
        ("authorization", basic_auth_header(&credentials.username, &credentials.app_password)),
        ("content-type", "application/xml; charset=utf-8".to_string()),
    ]
}

/// Minimal XML text escaping for the values this client EMBEDS in
/// request bodies (sync tokens).
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// The shared PROPFIND body: everything discovery and the connection test
/// read in one round-trip. Unknown properties answer with a 404 propstat,
/// which the parser simply ignores.
const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <d:current-user-principal/>
    <d:resourcetype/>
    <d:displayname/>
    <cal:calendar-home-set/>
    <cal:calendar-description/>
    <cal:supported-calendar-component-set/>
    <cs:getctag/>
  </d:prop>
</d:propfind>"#;

/// Issue one PROPFIND and parse its multistatus. Non-2xx statuses (and
/// 2xx non-multistatus bodies) become specific errors.
async fn propfind(
    url: &str,
    credentials: &CalDavCredentials,
    depth: u8,
) -> Result<super::xml::Multistatus, CaldavError> {
    let headers = xml_request_headers(credentials);
    let depth_value = depth.to_string();
    let header_refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .chain(std::iter::once(("depth", depth_value.as_str())))
        .collect();
    let response = request_raw("PROPFIND", url, &header_refs, PROPFIND_BODY).await?;
    if !(200..300).contains(&response.status) {
        return Err(CaldavError::Status {
            code: response.status,
        });
    }
    parse_multistatus(&response.body)
}

/// Issue one REPORT and parse its multistatus. Same error surface as
/// [`propfind`].
async fn report(
    url: &str,
    credentials: &CalDavCredentials,
    body: &str,
) -> Result<super::xml::Multistatus, CaldavError> {
    let headers = xml_request_headers(credentials);
    let header_refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .chain(std::iter::once(("depth", "1")))
        .collect();
    let response = request_raw("REPORT", url, &header_refs, body).await?;
    if !(200..300).contains(&response.status) {
        return Err(CaldavError::Status {
            code: response.status,
        });
    }
    parse_multistatus(&response.body)
}

/// Connection test (spec: reports success or a specific failure): one
/// authenticated PROPFIND Depth 0 against the given URL. Anything but a
/// well-formed multistatus answer is a specific [`CaldavError`].
pub(crate) async fn test_connection(
    server_url: &str,
    credentials: &CalDavCredentials,
) -> Result<(), CaldavError> {
    propfind(server_url, credentials, 0).await.map(|_| ())
}

/// The discovery result: every calendar collection found, already
/// absolute-URL-normalized to the server's href form (an absolute PATH —
/// what the TS layer stores as the calendar path).
pub(crate) struct Discovery {
    pub calendars: Vec<CaldavDiscoveredCalendar>,
}

/// Discover the calendars reachable from `server_url` (spec: "Connection
/// SHALL discover the available calendars"):
///
/// 1. PROPFIND Depth 0 on the URL — reads `current-user-principal` and,
///    opportunistically, `calendar-home-set` (Radicale answers both on
///    the principal collection many users paste as "the server URL").
/// 2. If a principal was returned without a home: PROPFIND the principal
///    for `calendar-home-set`.
/// 3. Depth-1 listing of the calendar home when known, else of the
///    entered URL itself (the paste-a-specific-calendar case); a home
///    listing that 404s falls back to the entered URL.
///
/// Calendar collections are the `resourcetype`-calendar responses that
/// either declare no component set or include VEVENT (task 5.2 handles
/// events only; VTODO-only collections are skipped and documented).
pub(crate) async fn discover(
    server_url: &str,
    credentials: &CalDavCredentials,
) -> Result<Discovery, CaldavError> {
    let base = parse_request_url(server_url)?;

    let first = propfind(server_url, credentials, 0).await?;
    let base_response = first.responses.first().cloned();
    let mut home = base_response
        .as_ref()
        .and_then(|response| response.calendar_home_set.clone());
    let principal = base_response
        .as_ref()
        .and_then(|response| response.current_user_principal.clone());

    // 2. principal → calendar-home-set.
    if home.is_none() {
        if let Some(principal) = principal.as_deref() {
            let principal_url = join_url(&base, principal)?;
            let second = propfind(&principal_url, credentials, 0).await?;
            home = second
                .responses
                .first()
                .and_then(|response| response.calendar_home_set.clone());
        }
    }

    // 3. Depth-1 listing.
    let home_url = match home.as_deref() {
        Some(home) => Some(join_url(&base, home)?),
        None => None,
    };
    let listing = match home_url.as_deref() {
        Some(url) => match propfind(url, credentials, 1).await {
            Ok(listing) => listing,
            // A broken home link must not sink discovery when the
            // entered URL itself lists calendars.
            Err(CaldavError::Status { code: 404 | 403 }) if url != server_url => {
                propfind(server_url, credentials, 1).await?
            }
            Err(error) => return Err(error),
        },
        None => propfind(server_url, credentials, 1).await?,
    };

    let mut calendars: Vec<CaldavDiscoveredCalendar> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    // The entered URL itself may BE a calendar collection (Depth 0 answer
    // above) — include it alongside the listing when distinct.
    let candidates = listing
        .responses
        .iter()
        .chain(base_response.iter().filter(|response| response.is_calendar));
    for response in candidates {
        if !response.is_calendar || response.is_removed() {
            continue;
        }
        // Task 5.2 syncs VEVENTs; a VTODO-only collection has nothing to
        // sync (documented limitation, deferred per design risks).
        if !response.supported_components.is_empty()
            && !response
                .supported_components
                .iter()
                .any(|component| component.eq_ignore_ascii_case("VEVENT"))
        {
            continue;
        }
        let href = join_url(&base, &response.href)?;
        if seen.contains(&href) {
            continue;
        }
        seen.push(href.clone());
        calendars.push(CaldavDiscoveredCalendar {
            href,
            display_name: response
                .display_name
                .clone()
                .or_else(|| response.ctag.clone()),
            description: response.calendar_description.clone(),
            ctag: response.ctag.clone(),
        });
    }

    Ok(Discovery { calendars })
}

/// The parsed outcome of one sync pass.
#[derive(Debug)]
pub(crate) struct SyncOutcome {
    /// "delta" (token'd incremental) or "full" (initial or fallback).
    pub mode: &'static str,
    pub next_sync_token: Option<String>,
    /// (absolute href, raw calendar-data) pairs.
    pub changed: Vec<(String, String)>,
    pub removed: Vec<String>,
}

/// Sync-collection REPORT body (RFC 6578). Without a token this is the
/// INITIAL full listing — the server returns everything plus a fresh
/// token.
fn sync_collection_body(sync_token: Option<&str>) -> String {
    let token = sync_token.map(xml_escape).unwrap_or_default();
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<d:sync-collection xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:sync-token>{token}</d:sync-token>
  <d:sync-level>1</d:sync-level>
  <d:prop>
    <d:getetag/>
    <cal:calendar-data/>
  </d:prop>
</d:sync-collection>"#
    )
}

/// calendar-query REPORT body: the full-sync fallback for servers without
/// sync-collection. Filters to VEVENT resources.
const CALENDAR_QUERY_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<cal:calendar-query xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <cal:calendar-data/>
  </d:prop>
  <cal:filter>
    <cal:comp-filter name="VCALENDAR">
      <cal:comp-filter name="VEVENT"/>
    </cal:comp-filter>
  </cal:filter>
</cal:calendar-query>"#;

/// Split a parsed REPORT into changed events and removed hrefs.
fn split_report(
    multistatus: super::xml::Multistatus,
    base: &crate::ai::http::RequestUrl,
) -> Result<SyncOutcome, CaldavError> {
    let mut changed = Vec::new();
    let mut removed = Vec::new();
    for response in multistatus.responses {
        if response.is_removed() {
            removed.push(join_url(base, &response.href)?);
        } else if let Some(ical) = response.calendar_data {
            changed.push((join_url(base, &response.href)?, ical));
        }
        // A non-removed response without calendar-data (etag-only) has
        // nothing to store.
    }
    Ok(SyncOutcome {
        // Overwritten by the callers ("delta" vs "full").
        mode: "delta",
        next_sync_token: multistatus
            .sync_token
            .filter(|token| !token.is_empty()),
        changed,
        removed,
    })
}

/// Sync one calendar (design D5: sync-token incremental fetch with a
/// full-sync fallback):
///
/// - stored token present → incremental REPORT (mode "delta"); a token
///   rejection (403/404/409/440) falls through to a full pass;
/// - initial or after a rejected token → sync-collection REPORT without
///   a token (mode "full", fresh token returned);
/// - a server that rejects sync-collection outright (400/403/405/422/501)
///   → calendar-query REPORT (mode "full", NO token — every sync stays a
///   full pass for such servers).
///
/// `calendar_path` is one of the discovery hrefs (an absolute path like
/// `/dav/user/calendars/home/`).
pub(crate) async fn sync(
    server_url: &str,
    credentials: &CalDavCredentials,
    calendar_path: &str,
    sync_token: Option<&str>,
) -> Result<SyncOutcome, CaldavError> {
    let base = parse_request_url(server_url)?;
    // The path comes from a discovery href: an absolute URL (discovery
    // joins multistatus hrefs against the base) or an absolute path.
    let calendar_url = if calendar_path.contains("://") {
        calendar_path.to_string()
    } else if calendar_path.starts_with('/') {
        join_url(&base, calendar_path)?
    } else {
        return Err(CaldavError::Config(
            "the calendar path must be an absolute path or URL from the discovery result"
                .to_string(),
        ));
    };

    // Incremental attempt.
    if let Some(token) = sync_token.map(str::trim).filter(|token| !token.is_empty()) {
        match report(&calendar_url, credentials, &sync_collection_body(Some(token))).await {
            Ok(multistatus) => {
                let mut outcome = split_report(multistatus, &base)?;
                outcome.mode = "delta";
                return Ok(outcome);
            }
            Err(CaldavError::Status { code })
                if SYNC_TOKEN_REJECTED_CODES.contains(&code) =>
            {
                // Fall through to the full pass below.
            }
            Err(error) => return Err(error),
        }
    }

    // Full pass via sync-collection (no token).
    match report(&calendar_url, credentials, &sync_collection_body(None)).await {
        Ok(multistatus) => {
            let mut outcome = split_report(multistatus, &base)?;
            outcome.mode = "full";
            Ok(outcome)
        }
        Err(CaldavError::Status { code })
            if SYNC_COLLECTION_UNSUPPORTED_CODES.contains(&code) =>
        {
            // No sync-collection support: calendar-query full pass, no
            // token (every sync is full for such servers).
            let multistatus = report(&calendar_url, credentials, CALENDAR_QUERY_BODY).await?;
            let mut outcome = split_report(multistatus, &base)?;
            outcome.mode = "full";
            outcome.next_sync_token = None;
            Ok(outcome)
        }
        Err(error) => Err(error),
    }
}

// --------------------------------------------------------------------------
// Event writes (task 5.4): CalDAV event CRUD is deliberately small — a
// VEVENT resource is written with PUT (the whole .ics blob IS the state)
// and removed with DELETE against the resource href. No etag/If-Match
// concurrency control in v1: last-write-wins, the sync pass converges any
// lost update (same posture as the Google path, which has none either).
// --------------------------------------------------------------------------

/// Resolve the absolute URL of one event resource from the server base and
/// the resource path the TS layer derives (`{calendar href}{uid}.ics`).
/// Same path forms as [`sync`]'s calendar path: an absolute URL, or an
/// absolute path joined against the base; anything else is a config error
/// before any I/O.
fn resolve_resource_url(
    server_url: &str,
    resource_path: &str,
) -> Result<String, CaldavError> {
    let base = parse_request_url(server_url)?;
    if resource_path.contains("://") {
        return Ok(resource_path.to_string());
    }
    if let Some(path) = resource_path.strip_prefix('/') {
        return join_url(&base, path);
    }
    Err(CaldavError::Config(
        "the event resource path must be an absolute path or URL".to_string(),
    ))
}

/// Write one event resource (task 5.4): PUT the raw iCalendar VCALENDAR
/// blob to `{collection}/{uid}.ics` (RFC 4791 §5.3.2 — PUT creates or
/// replaces the resource wholesale). Any 2xx answer counts as persisted
/// (Radicale answers 201 on create, 201/204 on replace).
pub(crate) async fn put_event(
    server_url: &str,
    credentials: &CalDavCredentials,
    resource_path: &str,
    ical: &str,
) -> Result<(), CaldavError> {
    let url = resolve_resource_url(server_url, resource_path)?;
    let mut headers = xml_request_headers(credentials);
    // The body is iCalendar, not XML — override the shared content-type.
    headers[1] = ("content-type", "text/calendar; charset=utf-8".to_string());
    let header_refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    let response = request_raw("PUT", &url, &header_refs, ical).await?;
    if !(200..300).contains(&response.status) {
        return Err(CaldavError::Status {
            code: response.status,
        });
    }
    Ok(())
}

/// Delete one event resource (task 5.4): DELETE against the resource
/// href. 404 is SUCCESS here — the event is already gone server-side, so
/// the local row may be dropped (deletion is idempotent); any other
/// non-2xx is a specific status error.
pub(crate) async fn delete_event(
    server_url: &str,
    credentials: &CalDavCredentials,
    resource_path: &str,
) -> Result<(), CaldavError> {
    let url = resolve_resource_url(server_url, resource_path)?;
    let headers = xml_request_headers(credentials);
    let header_refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    let response = request_raw("DELETE", &url, &header_refs, "").await?;
    if response.status == 404 {
        return Ok(());
    }
    if !(200..300).contains(&response.status) {
        return Err(CaldavError::Status {
            code: response.status,
        });
    }
    Ok(())
}

// ---------- Tests ----------
//
// These ride the loopback routing mock (`mock.rs`, the `ai::mock`
// pattern): discovery flows, sync with and without tokens, the fallbacks,
// and the specific-failure surface are all exercised against canned
// Radicale-style responses — the cargo-test stand-in for the task's
// MANUAL "verify against a local Radicale container" smoke (no container
// runtime here; see mod.rs).

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caldav::mock::{self, Route};
    use crate::caldav::xml::parse_sync_token;

    const USER: &str = "user@example.com";
    const PASS: &str = "app-password-123";

    fn creds() -> CalDavCredentials {
        CalDavCredentials {
            username: USER.to_string(),
            app_password: PASS.to_string(),
        }
    }

    /// Depth-0 answer of a Radicale-style principal collection.
    fn principal_response() -> String {
        mock::xml_response(
            207,
            "Multi-Status",
            r#"<D:multistatus xmlns:D="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/dav/user/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/></D:resourcetype>
        <D:current-user-principal><D:href>/dav/user/</D:href></D:current-user-principal>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#,
        )
    }

    /// Depth-0 answer of the principal: the calendar home link.
    fn home_response() -> String {
        mock::xml_response(
            207,
            "Multi-Status",
            r#"<D:multistatus xmlns:D="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/dav/user/</D:href>
    <D:propstat>
      <D:prop>
        <cal:calendar-home-set><D:href>/dav/user/calendars/</D:href></cal:calendar-home-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#,
        )
    }

    /// Depth-1 listing of the home: two VEVENT calendars and one VTODO.
    fn collections_response() -> String {
        mock::xml_response(
            207,
            "Multi-Status",
            r#"<D:multistatus xmlns:D="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <D:response>
    <D:href>/dav/user/calendars/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/user/calendars/home/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><cal:calendar/></D:resourcetype>
        <D:displayname>Home</D:displayname>
        <cs:getctag>CTAG-A</cs:getctag>
        <cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/user/calendars/family/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><cal:calendar/></D:resourcetype>
        <D:displayname>Family</D:displayname>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/user/calendars/todos/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><cal:calendar/></D:resourcetype>
        <D:displayname>Todos</D:displayname>
        <cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#,
        )
    }

    fn event_ical(uid: &str, summary: &str) -> String {
        format!(
            "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:{uid}\r\nSUMMARY:{summary}\r\nDTSTART:20260918T100000Z\r\nDTEND:20260918T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR"
        )
    }

    /// Sync-collection REPORT answer: one updated event, one removed,
    /// fresh token. `entity_encoded` calendars get XML-entity CRs.
    fn sync_response(token: &str) -> String {
        mock::xml_response(
            207,
            "Multi-Status",
            &format!(
                r#"<D:multistatus xmlns:D="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <D:sync-token>{token}</D:sync-token>
  <D:response>
    <D:href>/cal/home/a.ics</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>"etag-a"</D:getetag>
        <cal:calendar-data>{}</cal:calendar-data>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/cal/home/gone.ics</D:href>
    <D:status>HTTP/1.1 404 Not Found</D:status>
  </D:response>
</D:multistatus>"#,
                event_ical("uid-a", "Synced")
                    .replace('\r', "&#13;")
                    .replace('\n', "&#10;")
            ),
        )
    }

    #[test]
    fn basic_auth_header_matches_the_rfc() {
        assert_eq!(
            basic_auth_header("user", "pass"),
            "Basic dXNlcjpwYXNz",
            "RFC 4648 base64 of user:pass (RFC 1945/7617)"
        );
        // App passwords routinely contain specials.
        let header = basic_auth_header("jane@example.com", "ab-cd/ef=");
        assert!(header.starts_with("Basic "), "{header}");
        assert!(
            !header.contains('@'),
            "the credentials must be base64-encoded, never raw: {header}"
        );
    }

    #[tokio::test]
    async fn connection_test_round_trips_and_checks_auth_header() {
        let server = mock::spawn_routes(vec![Route::new("PROPFIND", "/", principal_response())])
            .await;
        let url = server.base_url();
        test_connection(&url, &creds()).await.expect("207 answers");

        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.method, "PROPFIND");
        assert_eq!(request.header("depth"), Some("0"));
        assert_eq!(
            request.header("authorization"),
            Some(basic_auth_header(USER, PASS).as_str())
        );
        assert!(request.body.contains("current-user-principal"));
        assert!(
            !request.body.contains(PASS),
            "credentials live only in the auth header"
        );
    }

    #[tokio::test]
    async fn discovery_walks_principal_home_then_calendars() {
        let server = mock::spawn_routes(vec![
            Route::new("PROPFIND", "/", principal_response()),
            Route::new("PROPFIND", "/dav/user/", home_response()),
            Route::new("PROPFIND", "/dav/user/calendars/", collections_response()),
        ])
        .await;
        let url = server.base_url();

        let discovery = discover(&url, &creds()).await.expect("discovery works");
        // The VTODO-only collection is skipped; the home collection is
        // not a calendar.
        assert_eq!(discovery.calendars.len(), 2, "{:?}", discovery.calendars);
        let home = &discovery.calendars[0];
        // Discovery hrefs are ABSOLUTE URLs (multistatus paths joined
        // against the base) — the TS layer stores them as-is.
        assert_eq!(home.href, format!("{url}/dav/user/calendars/home/"));
        assert_eq!(home.display_name.as_deref(), Some("Home"));
        assert_eq!(home.ctag.as_deref(), Some("CTAG-A"));
        let family = &discovery.calendars[1];
        assert_eq!(family.href, format!("{url}/dav/user/calendars/family/"));
        assert_eq!(family.display_name.as_deref(), Some("Family"));

        let requests = server.requests();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].target, "/");
        assert_eq!(requests[0].header("depth"), Some("0"));
        assert_eq!(requests[1].target, "/dav/user/");
        assert_eq!(requests[2].target, "/dav/user/calendars/");
        assert_eq!(requests[2].header("depth"), Some("1"));
    }

    #[tokio::test]
    async fn discovery_falls_back_to_listing_the_entered_url() {
        // A server that answers current-user-principal but whose home
        // listing 404s (mis-issued link): discovery falls back to the
        // entered URL's own Depth-1 listing.
        let listing_with_calendar = mock::xml_response(
            207,
            "Multi-Status",
            r#"<D:multistatus xmlns:D="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/dav/user/calendars/home/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><cal:calendar/></D:resourcetype>
        <D:displayname>Home</D:displayname>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#,
        );
        let server = mock::spawn_routes(vec![
            Route::new("PROPFIND", "/", principal_response()),
            Route::new("PROPFIND", "/dav/user/", home_response()),
            Route::new("PROPFIND", "/dav/user/calendars/", mock::raw_status(404, "Not Found")),
            Route::new("PROPFIND", "/", listing_with_calendar).with_depth(1),
        ])
        .await;
        let url = server.base_url();

        let discovery = discover(&url, &creds()).await.expect("fallback works");
        assert_eq!(discovery.calendars.len(), 1);
        assert_eq!(
            discovery.calendars[0].href,
            format!("{url}/dav/user/calendars/home/")
        );
        assert_eq!(server.requests().len(), 4);
    }

    #[tokio::test]
    async fn discovery_works_when_the_url_directly_lists_calendars() {
        // No principal/home anywhere: a Depth-1 listing of the entered
        // URL itself must still find the calendar (Fastmail "copy the
        // calendar URL" style usage).
        let direct = mock::xml_response(
            207,
            "Multi-Status",
            r#"<D:multistatus xmlns:D="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/dav/home.ics/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><cal:calendar/></D:resourcetype>
        <D:displayname>Direct</D:displayname>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#,
        );
        let server = mock::spawn_routes(vec![
            Route::new("PROPFIND", "/", direct.clone()).with_depth(0),
            Route::new("PROPFIND", "/", direct).with_depth(1),
        ])
        .await;
        let url = server.base_url();

        let discovery = discover(&url, &creds()).await.expect("discovery works");
        assert_eq!(discovery.calendars.len(), 1);
        assert_eq!(discovery.calendars[0].href, format!("{url}/dav/home.ics/"));
        assert_eq!(discovery.calendars[0].display_name.as_deref(), Some("Direct"));
    }

    #[tokio::test]
    async fn initial_full_sync_uses_a_tokenless_sync_collection_report() {
        let server = mock::spawn_routes(vec![Route::new(
            "REPORT",
            "/cal/home/",
            sync_response("http://example.com/ns/sync/2"),
        )])
        .await;
        let url = server.base_url();

        let outcome = sync(&url, &creds(), "/cal/home/", None)
            .await
            .expect("initial sync works");
        assert_eq!(outcome.mode, "full");
        assert_eq!(outcome.next_sync_token.as_deref(), Some("http://example.com/ns/sync/2"));
        assert_eq!(outcome.changed.len(), 1);
        assert_eq!(outcome.changed[0].0, url.clone() + "/cal/home/a.ics");
        assert!(outcome.changed[0].1.starts_with("BEGIN:VCALENDAR"));
        // The 404 response is a removal — on the INITIAL pass the server
        // does not emit those, but the parser path is shared.
        assert_eq!(outcome.removed.len(), 1);

        let request = &server.requests()[0];
        assert_eq!(request.method, "REPORT");
        assert_eq!(request.header("depth"), Some("1"));
        assert!(request.body.contains("sync-collection"));
        assert!(request.body.contains("<d:sync-token></d:sync-token>"));
    }

    #[tokio::test]
    async fn incremental_sync_carries_the_stored_token() {
        let server = mock::spawn_routes(vec![Route::new(
            "REPORT",
            "/cal/home/",
            sync_response("http://example.com/ns/sync/3"),
        )])
        .await;
        let url = server.base_url();

        let outcome = sync(
            &url,
            &creds(),
            "/cal/home/",
            Some("http://example.com/ns/sync/2"),
        )
        .await
        .expect("delta works");
        assert_eq!(outcome.mode, "delta");
        assert_eq!(outcome.next_sync_token.as_deref(), Some("http://example.com/ns/sync/3"));
        assert_eq!(outcome.changed.len(), 1);
        assert_eq!(outcome.removed.len(), 1);
        assert_eq!(outcome.removed[0], url.clone() + "/cal/home/gone.ics");
        // The stored token rode in the body, XML-escaped if needed.
        assert!(server.requests()[0]
            .body
            .contains("http://example.com/ns/sync/2"));
    }

    #[tokio::test]
    async fn rejected_sync_token_falls_back_to_a_full_resync() {
        // 440 (de-facto "lost token") on the incremental REPORT, then a
        // successful tokenless pass.
        let server = mock::spawn_routes(vec![
            Route::new("REPORT", "/cal/home/", mock::raw_status(440, "Gone"))
                .with_body_marker("sync/2"),
            Route::new("REPORT", "/cal/home/", sync_response("http://example.com/ns/sync/9")),
        ])
        .await;
        let url = server.base_url();

        let outcome = sync(
            &url,
            &creds(),
            "/cal/home/",
            Some("http://example.com/ns/sync/2"),
        )
        .await
        .expect("full resync works");
        assert_eq!(outcome.mode, "full");
        assert_eq!(outcome.next_sync_token.as_deref(), Some("http://example.com/ns/sync/9"));
        assert_eq!(server.requests().len(), 2);
        assert!(server.requests()[0].body.contains("sync/2"));
        assert!(server.requests()[1].body.contains("<d:sync-token></d:sync-token>"));
    }

    #[tokio::test]
    async fn unsupported_sync_collection_falls_back_to_calendar_query() {
        let query_answer = mock::xml_response(
            207,
            "Multi-Status",
            &format!(
                r#"<D:multistatus xmlns:D="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
  <D:response>
    <D:href>/cal/home/a.ics</D:href>
    <D:propstat>
      <D:prop>
        <cal:calendar-data>{}</cal:calendar-data>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#,
                event_ical("uid-a", "Queried")
                    .replace('\r', "&#13;")
                    .replace('\n', "&#10;")
            ),
        );
        let server = mock::spawn_routes(vec![
            // Old Radicale: 403 with an error body for sync-collection.
            Route::new("REPORT", "/cal/home/", mock::raw_status(403, "Forbidden"))
                .with_body_marker("sync-collection"),
            Route::new("REPORT", "/cal/home/", query_answer).with_body_marker("calendar-query"),
        ])
        .await;
        let url = server.base_url();

        // Initial sync AND a token'd sync both degrade to the query.
        // The token'd path makes THREE requests (token'd REPORT → 403 is
        // a rejected-token code → tokenless REPORT → 403 → query); the
        // initial path makes two.
        for stored_token in [None, Some("tok-1")] {
            let outcome = sync(&url, &creds(), "/cal/home/", stored_token)
                .await
                .expect("calendar-query fallback works");
            assert_eq!(outcome.mode, "full");
            assert_eq!(
                outcome.next_sync_token, None,
                "no token exists for query-only servers"
            );
            assert_eq!(outcome.changed.len(), 1);
            assert!(outcome.changed[0].1.contains("Queried"));
        }
        let requests = server.requests();
        assert_eq!(requests.len(), 5);
        assert!(requests[0].body.contains("sync-collection"));
        assert!(requests[1].body.contains("calendar-query"));
        assert!(requests[1].body.contains("comp-filter"));
    }

    #[tokio::test]
    async fn auth_failures_are_specific_and_redacted() {
        let server = mock::spawn_routes(vec![Route::new(
            "PROPFIND",
            "/",
            mock::raw_status(401, "Unauthorized"),
        )])
        .await;
        let url = server.base_url();

        let error = test_connection(&url, &creds())
            .await
            .expect_err("401 is an error");
        assert_eq!(error.kind(), "status");
        assert_eq!(error.status(), Some(401));
        let message = error.to_string();
        assert!(message.contains("app password"), "{message}");
        assert!(!message.contains(PASS), "never echo the secret: {message}");
    }

    #[tokio::test]
    async fn redirects_are_reported_not_followed() {
        let server = mock::spawn_routes(vec![Route::new(
            "PROPFIND",
            "/",
            mock::raw_response(
                301,
                "Moved Permanently",
                "content-type: text/html",
                "<a href=\"/moved/\">moved</a>",
            ),
        )])
        .await;
        let url = server.base_url();

        let error = test_connection(&url, &creds())
            .await
            .expect_err("redirects are not followed");
        assert_eq!(error.status(), Some(301));
        assert!(error.to_string().contains("redirect"), "{error}");
        assert_eq!(server.requests().len(), 1, "no second request was made");
    }

    #[tokio::test]
    async fn sync_rejects_relative_calendar_paths() {
        let server = mock::spawn_routes(vec![]).await;
        let error = sync(&server.base_url(), &creds(), "cal/home/", None)
            .await
            .expect_err("relative path is a config error");
        assert_eq!(error.kind(), "config");
        assert!(server.requests().is_empty());
    }

    #[tokio::test]
    async fn report_bodies_that_are_not_multistatus_are_parse_errors() {
        let server = mock::spawn_routes(vec![Route::new(
            "REPORT",
            "/cal/home/",
            mock::xml_response(200, "OK", "<html>surprise</html>"),
        )])
        .await;
        let error = sync(&server.base_url(), &creds(), "/cal/home/", None)
            .await
            .expect_err("non-multistatus body is a parse error");
        assert_eq!(error.kind(), "parse");
    }

    #[tokio::test]
    async fn parse_sync_token_reads_a_report_cursor() {
        let server = mock::spawn_routes(vec![Route::new(
            "REPORT",
            "/cal/home/",
            sync_response("tok-parse-1"),
        )])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();
        let calendar_url = join_url(&base, "/cal/home/").unwrap();
        let response =
            request_raw("REPORT", &calendar_url, &[], &sync_collection_body(None))
                .await
                .expect("mock answers");
        assert_eq!(
            parse_sync_token(&response.body).expect("parses").as_deref(),
            Some("tok-parse-1")
        );
    }

    // ---------- Event writes (task 5.4) ----------

    #[tokio::test]
    async fn put_event_puts_the_ics_blob_with_the_right_headers() {
        let server = mock::spawn_routes(vec![Route::new(
            "PUT",
            "/cal/home/new-1.ics",
            mock::raw_status(201, "Created"),
        )])
        .await;
        let url = server.base_url();
        let ical = event_ical("new-1", "Created in the app");

        put_event(&url, &creds(), "/cal/home/new-1.ics", &ical)
            .await
            .expect("201 is a successful PUT");

        let request = &server.requests()[0];
        assert_eq!(request.method, "PUT");
        assert_eq!(request.target, "/cal/home/new-1.ics");
        // The body IS the event state on CalDAV — sent verbatim.
        assert_eq!(request.body, ical);
        assert_eq!(
            request.header("content-type"),
            Some("text/calendar; charset=utf-8")
        );
        assert_eq!(
            request.header("authorization"),
            Some(basic_auth_header(USER, PASS).as_str())
        );
    }

    #[tokio::test]
    async fn put_event_maps_non_2xx_to_a_status_error_without_secrets() {
        let server = mock::spawn_routes(vec![Route::new(
            "PUT",
            "/cal/home/denied.ics",
            mock::raw_status(403, "Forbidden"),
        )])
        .await;
        let url = server.base_url();

        let error = put_event(&url, &creds(), "/cal/home/denied.ics", "BEGIN:VCALENDAR")
            .await
            .expect_err("403 is an error");
        assert_eq!(error.kind(), "status");
        assert_eq!(error.status(), Some(403));
        assert!(!error.to_string().contains(PASS));
    }

    #[tokio::test]
    async fn put_event_rejects_relative_resource_paths_before_any_io() {
        let server = mock::spawn_routes(vec![]).await;
        let error = put_event(
            &server.base_url(),
            &creds(),
            "cal/home/relative.ics",
            "BEGIN:VCALENDAR",
        )
        .await
        .expect_err("relative path is a config error");
        assert_eq!(error.kind(), "config");
        assert!(server.requests().is_empty());
    }

    #[tokio::test]
    async fn delete_event_succeeds_on_2xx_and_tolerates_404() {
        let server = mock::spawn_routes(vec![
            Route::new("DELETE", "/cal/home/gone.ics", mock::raw_status(204, "No Content")),
            Route::new(
                "DELETE",
                "/cal/home/already.ics",
                mock::raw_status(404, "Not Found"),
            ),
        ])
        .await;
        let url = server.base_url();

        delete_event(&url, &creds(), "/cal/home/gone.ics")
            .await
            .expect("204 is a successful DELETE");
        // Already deleted server-side: idempotent success so the local row
        // can be dropped.
        delete_event(&url, &creds(), "/cal/home/already.ics")
            .await
            .expect("404 is tolerated on DELETE");

        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].method, "DELETE");
        assert_eq!(
            requests[0].header("authorization"),
            Some(basic_auth_header(USER, PASS).as_str())
        );

        // Any other non-2xx stays a specific failure.
        let server = mock::spawn_routes(vec![Route::new(
            "DELETE",
            "/cal/home/broken.ics",
            mock::raw_status(503, "Unavailable"),
        )])
        .await;
        let error = delete_event(&server.base_url(), &creds(), "/cal/home/broken.ics")
            .await
            .expect_err("503 is an error");
        assert_eq!(error.status(), Some(503));
    }
}
