//! CardDAV protocol operations (parity-round-2 task 4.1, design D4):
//! the discovery chain, the ctag/sync-token sync pass with its full-pull
//! fallback, batched `addressbook-multiget` fetches, and the
//! etag-disciplined PUT/DELETE writes.
//!
//! Transport reuses [`crate::caldav::http::request_raw`] verbatim (same
//! TCP + native-tls stack, HTTPS-except-loopback policy, no redirects, 32
//! MiB response cap); errors map 1:1 with 401 lifted into the typed
//! needs-reauth variant. Every server-supplied href is resolved against
//! the request base and origin-checked — a multistatus pointing at
//! another host is refused rather than followed with credentials.
//!
//! Nothing here logs or stores credentials; error messages never embed
//! request bytes (the command boundary redacts as a last resort).

use std::collections::{HashMap, HashSet};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;

use super::vcard;
use super::xml::{parse_multistatus, Multistatus};
use super::{
    CarddavDiscoveredBook, CarddavError, CarddavKnownCard, MAX_CARD_BYTES,
};
use crate::ai::http::{parse_request_url, RequestUrl};
use crate::caldav::http::{join_url, request_raw};

/// `addressbook-multiget` batch cap (checklist: ≤50 hrefs per batch).
const MULTIGET_BATCH: usize = 50;

/// HTTP statuses on the incremental sync-collection REPORT that mean
/// "the stored token is not usable" (RFC 6578 practice: 403/409 invalid,
/// 404 gone collection, 440 the de-facto lost token) — a full pull is
/// attempted instead of failing.
const SYNC_TOKEN_REJECTED_CODES: [u16; 4] = [403, 404, 409, 440];
/// HTTP statuses that mean the server does not support sync-collection
/// REPORTs at all (wrong method, unknown report, bad body) — the full
/// `addressbook-query` pull is the only path for such servers.
const SYNC_COLLECTION_UNSUPPORTED_CODES: [u16; 5] = [400, 403, 405, 422, 501];

/// The per-call credentials. The TS layer unseals them from the book's
/// AES-GCM envelope for EXACTLY one command call — they are never
/// persisted, logged, or echoed here.
#[derive(Debug, Clone)]
pub(crate) struct CardDavCredentials {
    pub username: String,
    pub app_password: String,
}

/// `Authorization: Basic …` — the RFC 4648 base64 of `user:pass`.
pub(crate) fn basic_auth_header(username: &str, app_password: &str) -> String {
    format!(
        "Basic {}",
        BASE64.encode(format!("{username}:{app_password}").as_bytes())
    )
}

/// Minimal XML text escaping for values EMBEDDED in request bodies
/// (sync tokens, multiget hrefs).
fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

/// Issue one request with the Basic-auth + XML headers this client always
/// sends. Non-2xx statuses become specific errors, with 401 lifted into
/// the typed [`CarddavError::Auth`] (needs-reauth).
async fn dav_request(
    method: &str,
    url: &str,
    depth: Option<&str>,
    content_type: &str,
    body: &str,
    extra_headers: &[(&str, String)],
    credentials: &CardDavCredentials,
) -> Result<crate::caldav::http::RawResponse, CarddavError> {
    let mut headers: Vec<(&str, String)> = vec![
        (
            "authorization",
            basic_auth_header(&credentials.username, &credentials.app_password),
        ),
        ("content-type", content_type.to_string()),
    ];
    if let Some(depth) = depth {
        headers.push(("depth", depth.to_string()));
    }
    for (name, value) in extra_headers {
        headers.push((name, value.clone()));
    }
    let header_refs: Vec<(&str, &str)> = headers
        .iter()
        .map(|(name, value)| (*name, value.as_str()))
        .collect();
    let response = request_raw(method, url, &header_refs, body).await?;
    if response.status == 401 {
        return Err(CarddavError::Auth);
    }
    if (300..400).contains(&response.status) {
        return Err(CarddavError::Status {
            code: response.status,
        });
    }
    Ok(response)
}

/// Issue one PROPFIND/REPORT expecting a multistatus body and parse it;
/// any non-2xx answer is a specific status error.
async fn dav_report(
    url: &str,
    method: &str,
    depth: &str,
    body: &str,
    credentials: &CardDavCredentials,
) -> Result<Multistatus, CarddavError> {
    let response = dav_request(method, url, Some(depth), "application/xml; charset=utf-8", body, &[], credentials).await?;
    if !(200..300).contains(&response.status) {
        return Err(CarddavError::Status {
            code: response.status,
        });
    }
    parse_multistatus(&response.body)
}

/// Resolve a server-supplied href against the request base and REFUSE
/// cross-origin results (credentials must never be forwarded to another
/// host/port/scheme). Returns the absolute URL.
fn resolve(base: &RequestUrl, href: &str) -> Result<String, CarddavError> {
    let joined = join_url(base, href)?;
    let resolved = parse_request_url(&joined)?;
    if !resolved.host.eq_ignore_ascii_case(&base.host)
        || resolved.port != base.port
        || resolved.https != base.https
    {
        return Err(CarddavError::Config(
            "an address-book href changed origin; refusing to forward credentials"
                .to_string(),
        ));
    }
    Ok(joined)
}

/// Comparison key for hrefs: the resolved target (path + query). Servers
/// spell the same resource as absolute paths or absolute URIs; the key
/// form makes set comparisons robust.
fn href_key(base: &RequestUrl, href: &str) -> Result<String, CarddavError> {
    let resolved = resolve(base, href)?;
    Ok(parse_request_url(&resolved)?.target)
}

fn required_etag(href: &str, etag: Option<&str>) -> Result<String, CarddavError> {
    etag
        .map(str::trim)
        .filter(|etag| !etag.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| {
            CarddavError::Parse(format!(
                "the server answered no ETag for a listed card ({href})"
            ))
        })
}

// ---------------------------------------------------------------------------
// Request bodies
// ---------------------------------------------------------------------------

/// The collections PROPFIND body: everything discovery reads in one
/// round-trip (addressbook resourcetype, display name, ctag, advertised
/// sync-token support, write privileges). Unsupported props answer with
/// a failed propstat, which the parser ignores (successful-propstat-wins).
const COLLECTIONS_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <d:resourcetype/>
    <d:displayname/>
    <cs:getctag/>
    <d:sync-token/>
    <d:current-user-privilege-set/>
  </d:prop>
</d:propfind>"#;

const PRINCIPAL_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:current-user-principal/>
  </d:prop>
</d:propfind>"#;

const HOME_SET_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <card:addressbook-home-set/>
  </d:prop>
</d:propfind>"#;

/// The Depth-0 state PROPFIND the sync pass opens with: ctag for the
/// short-circuit check plus the server's advertised sync-token support.
const STATE_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop>
    <cs:getctag/>
    <d:sync-token/>
  </d:prop>
</d:propfind>"#;

/// sync-collection REPORT body (RFC 6578). An EMPTY token element
/// requests the initial state; Depth is 0 per the RFC (sync-level
/// controls the collection scope). Etag-only props: the card bodies come
/// from the multiget that follows.
fn sync_collection_body(token: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<d:sync-collection xmlns:d="DAV:">
  <d:sync-token>{}</d:sync-token>
  <d:sync-level>1</d:sync-level>
  <d:prop>
    <d:getetag/>
  </d:prop>
</d:sync-collection>"#,
        xml_escape(token)
    )
}

/// The full-pull fallback: `addressbook-query` REPORT (RFC 6352 §8.7),
/// Depth 1, filtered on FN — the property both vCard versions REQUIRE,
/// so email-less cards still list instead of silently vanishing.
const ADDRESSBOOK_QUERY_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:getetag/>
  </d:prop>
  <card:filter>
    <card:prop-filter name="FN"/>
  </card:filter>
</card:addressbook-query>"#;

/// `addressbook-multiget` body (RFC 6352 §8.9): fetch etag + address-data
/// for an explicit href list.
fn multiget_body(hrefs: &[String]) -> String {
    let elements = hrefs
        .iter()
        .map(|href| format!("<d:href>{}</d:href>", xml_escape(href)))
        .collect::<String>();
    format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<card:addressbook-multiget xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>
    <d:getetag/>
    <card:address-data/>
  </d:prop>
  {elements}
</card:addressbook-multiget>"#
    )
}

// ---------------------------------------------------------------------------
// Discovery (RFC 6764-style chain)
// ---------------------------------------------------------------------------

/// Discover the address books reachable from `base`:
///
/// 1. Pasted-collection shortcut: a Depth-0 PROPFIND of the entered URL
///    that answers an `addressbook` resourcetype ends the chain (the
///    "copy the book URL" usage).
/// 2. `current-user-principal` — tried on the base URL first, then on
///    `/.well-known/carddav`. A 401 anywhere stops with the typed
///    needs-reauth error.
/// 3. `addressbook-home-set` on the principal.
/// 4. Depth-1 listing of the home set, filtered on the addressbook
///    resourcetype.
///
/// Every href is resolved against the request base and origin-checked.
pub(crate) async fn discover(
    base: &RequestUrl,
    credentials: &CardDavCredentials,
) -> Result<Vec<CarddavDiscoveredBook>, CarddavError> {
    // 1. The pasted URL itself may BE an address book.
    let base_url_string = base_url(base);
    if let Ok(multistatus) =
        dav_report(&base_url_string, "PROPFIND", "0", COLLECTIONS_BODY, credentials).await
    {
        let shortcut = multistatus
            .items
            .iter()
            .find(|item| item.is_addressbook && !item.is_removed() && !item.href.is_empty())
            .cloned();
        if let Some(item) = shortcut {
            return Ok(vec![CarddavDiscoveredBook {
                href: resolve(base, &item.href)?,
                display_name: item.display_name.clone(),
                read_only: item.can_write.map(|write| !write),
                ctag: item.ctag.clone(),
            }]);
        }
    }

    // 2. current-user-principal: base URL, then the well-known path.
    let well_known = resolve(base, "/.well-known/carddav")?;
    let mut principal: Option<String> = None;
    for candidate in [base_url_string.clone(), well_known] {
        match dav_report(&candidate, "PROPFIND", "0", PRINCIPAL_BODY, credentials).await {
            Ok(multistatus) => {
                let found = multistatus
                    .items
                    .iter()
                    .find_map(|item| item.current_user_principal.clone())
                    .filter(|href| !href.is_empty());
                if let Some(href) = found {
                    principal = Some(resolve(base, &href)?);
                    break;
                }
            }
            // Credentials are wrong, full stop — do not keep probing.
            Err(CarddavError::Auth) => return Err(CarddavError::Auth),
            // No principal here (404/405/parse): try the next candidate.
            Err(_) => continue,
        }
    }
    let principal_url = principal.ok_or_else(|| {
        CarddavError::Config(
            "no current-user-principal found; the server URL does not look like a \
             CardDAV endpoint — enter the server's DAV root, principal, or address \
             book URL"
                .to_string(),
        )
    })?;

    // 3. addressbook-home-set on the principal (relative hrefs resolve
    // against the principal's directory).
    let principal_parsed = parse_request_url(&principal_url)?;
    let home_multistatus =
        dav_report(&principal_url, "PROPFIND", "0", HOME_SET_BODY, credentials).await?;
    let home_href = home_multistatus
        .items
        .iter()
        .find_map(|item| item.addressbook_home_set.clone())
        .filter(|href| !href.is_empty())
        .ok_or_else(|| {
            CarddavError::Config(
                "the server published no addressbook-home-set for this principal"
                    .to_string(),
            )
        })?;
    let home_url = resolve(&principal_parsed, &home_href)?;

    // 4. Depth-1 listing of the home set, addressbooks only.
    let listing = dav_report(&home_url, "PROPFIND", "1", COLLECTIONS_BODY, credentials).await?;
    let mut books: Vec<CarddavDiscoveredBook> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for item in &listing.items {
        if !item.is_addressbook || item.is_removed() || item.href.is_empty() {
            continue;
        }
        let href = resolve(&principal_parsed, &item.href)?;
        if seen.contains(&href) {
            continue;
        }
        seen.push(href.clone());
        books.push(CarddavDiscoveredBook {
            href,
            display_name: item.display_name.clone(),
            read_only: item.can_write.map(|write| !write),
            ctag: item.ctag.clone(),
        });
    }
    if books.is_empty() {
        return Err(CarddavError::Config(
            "no address books found on the server".to_string(),
        ));
    }
    Ok(books)
}

/// Absolute URL of a parsed request (the client speaks in absolute URLs;
/// `request_raw` re-parses them).
fn base_url(base: &RequestUrl) -> String {
    join_url(base, &base.target).unwrap_or_else(|_| base.target.clone())
}

// ---------------------------------------------------------------------------
// Sync pass
// ---------------------------------------------------------------------------

/// One fetched card: absolute href, fresh ETag, RAW vCard text (the TS
/// layer stores it for lossless re-serialization on edit) and the parsed
/// projection.
#[derive(Debug)]
pub(crate) struct SyncCard {
    pub href: String,
    pub etag: String,
    pub vcard: String,
    pub summary: vcard::VCardSummary,
}

/// The parsed outcome of one sync pass.
#[derive(Debug)]
pub(crate) struct SyncOutcome {
    /// "unchanged" (ctag short-circuit), "delta" (token'd incremental),
    /// "full" (initial or fallback).
    pub mode: &'static str,
    pub next_sync_token: Option<String>,
    pub ctag: Option<String>,
    pub cards: Vec<SyncCard>,
    pub removed: Vec<String>,
    pub skipped: u32,
}

/// The intermediate listing one REPORT produces: candidate (key, etag,
/// absolute href) triples plus removals.
struct CandidateList {
    candidates: Vec<(String, String, String)>,
    removed: Vec<String>,
    token: Option<String>,
}

/// Run ONE sync pass over the address book at `book_target`:
///
/// 1. Depth-0 state PROPFIND → ctag short-circuit when the stored ctag
///    still matches (mode "unchanged", nothing else is requested).
/// 2. sync-collection REPORT — Depth 0, `sync-level 1`, etag-only props,
///    EMPTY token element for the initial state — when a stored token
///    exists or the server advertises token support. A `valid-sync-token`
///    error body, a 403/404/409/440 answer, or an unsupported-report
///    status falls back to (3).
/// 3. Full pull: `addressbook-query` REPORT, Depth 1, FN-filtered, ETag
///    required per item; local-minus-remote hrefs become removals.
/// 4. Changed hrefs (etag diff against `known_cards`) are fetched in
///    `addressbook-multiget` batches of at most 50: every requested href
///    must come back, an item 404 counts as a removal, missing
///    ETag/address-data is an error, unparsable/oversized cards are
///    counted as skipped.
pub(crate) async fn sync_book(
    base: &RequestUrl,
    credentials: &CardDavCredentials,
    book_target: &str,
    sync_token: Option<&str>,
    stored_ctag: Option<&str>,
    known_cards: &[CarddavKnownCard],
) -> Result<SyncOutcome, CarddavError> {
    let book_url = resolve(base, book_target)?;

    // Locally known cards as {key → (absolute href, etag)}.
    let mut known: HashMap<String, (String, Option<String>)> = HashMap::new();
    for card in known_cards {
        // A stored href that no longer resolves is treated as unknown —
        // it will be re-listed and re-fetched rather than failing the
        // pass.
        if let Ok(key) = href_key(base, &card.href) {
            known.insert(key, (card.href.clone(), card.etag.clone()));
        }
    }

    // 1. State PROPFIND: ctag short-circuit + advertised token support.
    let mut current_ctag: Option<String> = None;
    let mut advertised_token: Option<String> = None;
    if let Ok(state) = dav_report(&book_url, "PROPFIND", "0", STATE_BODY, credentials).await {
        if let Some(item) = state.items.first() {
            current_ctag = item.ctag.clone().filter(|tag| !tag.is_empty());
            advertised_token = item.sync_token.clone().filter(|token| !token.is_empty());
        }
    }
    if let Some(stored) = stored_ctag {
        if let Some(current) = &current_ctag {
            if current == stored {
                return Ok(SyncOutcome {
                    mode: "unchanged",
                    next_sync_token: sync_token.map(str::to_string),
                    ctag: current_ctag,
                    cards: Vec::new(),
                    removed: Vec::new(),
                    skipped: 0,
                });
            }
        }
    }

    // 2. Incremental sync-collection REPORT.
    let mut list: Option<CandidateList> = None;
    let mut mode: &'static str = "full";
    if sync_token.is_some() || advertised_token.is_some() {
        let requested_token = sync_token.unwrap_or("");
        match try_sync_collection(
            &book_url,
            credentials,
            requested_token,
            base,
            advertised_token.clone(),
        )
        .await
        {
            Ok(Some(candidate_list)) => {
                mode = if sync_token.is_some() { "delta" } else { "full" };
                list = Some(candidate_list);
            }
            // Rejected token / unsupported report: full pull below.
            Ok(None) => {}
            Err(CarddavError::Status { code })
                if SYNC_TOKEN_REJECTED_CODES.contains(&code)
                    || SYNC_COLLECTION_UNSUPPORTED_CODES.contains(&code) => {}
            Err(error) => return Err(error),
        }
    }

    // 3. Full pull fallback.
    let list = match list {
        Some(list) => list,
        None => {
            let multistatus =
                dav_report(&book_url, "REPORT", "1", ADDRESSBOOK_QUERY_BODY, credentials).await?;
            let collection_key = parse_request_url(&book_url)?.target;
            let mut candidates = Vec::new();
            for item in &multistatus.items {
                if item.href.is_empty() {
                    return Err(CarddavError::Parse(
                        "addressbook-query returned an empty href".to_string(),
                    ));
                }
                let key = href_key(base, &item.href)?;
                if key == collection_key {
                    continue;
                }
                if item.is_removed() {
                    continue;
                }
                if !(200..300).contains(&item.status) {
                    return Err(CarddavError::Status {
                        code: item.status,
                    });
                }
                let etag = required_etag(&item.href, item.etag.as_deref())?;
                candidates.push((key, etag, resolve(base, &item.href)?));
            }
            // Local-minus-remote = removals. The caller applies them only
            // after this pass returns Ok, so a failed pass can never
            // delete a local contact.
            let candidate_keys: HashSet<&str> =
                candidates.iter().map(|(key, _, _)| key.as_str()).collect();
            let removed = known
                .iter()
                .filter(|(key, _)| !candidate_keys.contains(key.as_str()))
                .map(|(_, (href, _))| href.clone())
                .collect();
            CandidateList {
                candidates,
                removed,
                token: advertised_token,
            }
        }
    };

    // 4. ETag diff → multiget batches.
    let mut to_fetch: Vec<String> = Vec::new();
    for (key, etag, absolute) in &list.candidates {
        let unchanged = known
            .get(key)
            .and_then(|(_, stored)| stored.as_deref())
            .is_some_and(|stored| stored == etag);
        if !unchanged {
            to_fetch.push(absolute.clone());
        }
    }

    let mut cards: Vec<SyncCard> = Vec::new();
    let mut removed = list.removed;
    let mut skipped: u32 = 0;
    for batch in to_fetch.chunks(MULTIGET_BATCH) {
        let expected: HashMap<String, String> = batch
            .iter()
            .filter_map(|href| {
                href_key(base, href)
                    .ok()
                    .map(|key| (key, href.clone()))
            })
            .collect();
        let response = dav_request(
            "REPORT",
            &book_url,
            Some("0"),
            "application/xml; charset=utf-8",
            &multiget_body(batch),
            &[],
            credentials,
        )
        .await?;
        if !(200..300).contains(&response.status) {
            return Err(CarddavError::Status {
                code: response.status,
            });
        }
        let multistatus = parse_multistatus(&response.body)?;
        let mut seen: HashSet<String> = HashSet::new();
        for item in &multistatus.items {
            if item.href.is_empty() {
                continue;
            }
            let key = href_key(base, &item.href)?;
            if !expected.contains_key(&key) {
                continue; // a href we did not ask about
            }
            seen.insert(key.clone());
            if item.is_removed() {
                removed.push(resolve(base, &item.href)?);
                continue;
            }
            if !(200..300).contains(&item.status) {
                return Err(CarddavError::Status {
                    code: item.status,
                });
            }
            let Some(card_text) = item.address_data.as_deref().map(str::trim).filter(|card| !card.is_empty()) else {
                return Err(CarddavError::Parse(format!(
                    "addressbook-multiget returned no address-data for a requested card ({})",
                    item.href
                )));
            };
            let etag = required_etag(&item.href, item.etag.as_deref())?;
            if card_text.len() > MAX_CARD_BYTES {
                skipped += 1;
                continue;
            }
            match vcard::parse(card_text) {
                Ok(summary) => cards.push(SyncCard {
                    href: expected[&key].clone(),
                    etag,
                    vcard: card_text.to_string(),
                    summary,
                }),
                // A card the projection rejects (no UID/FN/email, not
                // vCard 3.0/4.0, over the cap) is counted — never a silent
                // drop, never a pass failure.
                Err(_) => skipped += 1,
            }
        }
        if let Some(missing) = expected
            .keys()
            .find(|key| !seen.contains(key.as_str()))
            .cloned()
        {
            return Err(CarddavError::Parse(format!(
                "addressbook-multiget omitted a requested card ({missing})"
            )));
        }
    }
    if skipped > 0 {
        log::warn!("carddav sync: skipped {skipped} unparsable or oversized card(s)");
    }

    Ok(SyncOutcome {
        mode,
        next_sync_token: list.token,
        ctag: current_ctag,
        cards,
        removed,
        skipped,
    })
}

/// One sync-collection attempt. `Ok(Some(_))` = the REPORT answered and
/// the pass can continue from it; `Ok(None)` = the server rejected the
/// token (`valid-sync-token` error body per RFC 6578) — fall back to the
/// full pull.
async fn try_sync_collection(
    book_url: &str,
    credentials: &CardDavCredentials,
    token: &str,
    base: &RequestUrl,
    advertised_token: Option<String>,
) -> Result<Option<CandidateList>, CarddavError> {
    let response = dav_request(
        "REPORT",
        book_url,
        Some("0"),
        "application/xml; charset=utf-8",
        &sync_collection_body(token),
        &[],
        credentials,
    )
    .await?;
    if response.status == 207 {
        if response.body.contains("valid-sync-token") {
            return Ok(None);
        }
        let multistatus = parse_multistatus(&response.body)?;
        let collection_key = parse_request_url(book_url)?.target;
        let mut candidates = Vec::new();
        let mut removed = Vec::new();
        for item in &multistatus.items {
            if item.href.is_empty() {
                continue;
            }
            let key = href_key(base, &item.href)?;
            if key == collection_key {
                continue;
            }
            if item.is_removed() {
                removed.push(resolve(base, &item.href)?);
                continue;
            }
            if !(200..300).contains(&item.status) {
                return Err(CarddavError::Status {
                    code: item.status,
                });
            }
            let etag = required_etag(&item.href, item.etag.as_deref())?;
            candidates.push((key, etag, resolve(base, &item.href)?));
        }
        // Empty-token initial states usually echo an empty cursor; the
        // fresh token to persist may also come from the PROPFIND
        // advertisement.
        let token = multistatus
            .sync_token
            .filter(|token| !token.is_empty())
            .or(advertised_token);
        return Ok(Some(CandidateList {
            candidates,
            removed,
            token,
        }));
    }
    if SYNC_TOKEN_REJECTED_CODES.contains(&response.status)
        || SYNC_COLLECTION_UNSUPPORTED_CODES.contains(&response.status)
    {
        return Ok(None);
    }
    Err(CarddavError::Status {
        code: response.status,
    })
}

// ---------------------------------------------------------------------------
// Writes (etag discipline; spec conflict rule: last write wins)
// ---------------------------------------------------------------------------

/// The write input: CREATE (fresh `urn:uuid:` card at `{book}{uid}.vcf`,
/// `If-None-Match: *`) or UPDATE (name/note swapped into the existing
/// card, every other line preserved, `If-Match` when an ETag is known).
#[derive(Debug)]
pub(crate) enum PutCardInput {
    Create {
        uid: String,
        email: String,
        name: String,
        note: Option<String>,
    },
    Update {
        href: String,
        etag: Option<String>,
        vcard: String,
        name: String,
        note: Option<String>,
        uid_fallback: String,
    },
}

#[derive(Debug)]
pub(crate) struct PutOutcome {
    pub href: String,
    pub etag: String,
    pub vcard: String,
}

const VCARD_CONTENT_TYPE: &str = "text/vcard; charset=utf-8";

/// GET one card's ETag (the PUT-response-without-ETag refetch). The body
/// is not needed — the TS layer keeps its own copy.
async fn refetch_etag(
    href: &str,
    credentials: &CardDavCredentials,
) -> Result<String, CarddavError> {
    let response = dav_request(
        "GET",
        href,
        None,
        "application/xml; charset=utf-8",
        "",
        &[("accept", "text/vcard".to_string())],
        credentials,
    )
    .await?;
    if !(200..300).contains(&response.status) {
        return Err(CarddavError::Status {
            code: response.status,
        });
    }
    response.etag.clone().filter(|etag| !etag.is_empty()).ok_or_else(|| {
        CarddavError::Parse(
            "the server stored the card but did not return its ETag".to_string(),
        )
    })
}

/// PUT one card with the full conflict flow (spec: last write wins):
/// create uses `If-None-Match: *` (a 412 means the server already has a
/// resource at that URI — the local write wins, so it is re-issued
/// unconditionally); update uses `If-Match` (a 412 triggers an immediate
/// GET for a fresh ETag and a re-PUT of the LOCAL version; a 404 on the
/// update means the resource vanished — re-PUT unconditionally to
/// recreate). A 2xx response without an ETag is followed by a GET
/// refetch; a still-missing ETag is a typed error.
pub(crate) async fn put_card(
    base: &RequestUrl,
    credentials: &CardDavCredentials,
    book_target: &str,
    input: &PutCardInput,
) -> Result<PutOutcome, CarddavError> {
    let (href, body, preconditions): (String, String, Vec<(&str, String)>) = match input {
        PutCardInput::Create {
            uid,
            email,
            name,
            note,
        } => {
            let mut book_path = book_target.to_string();
            if !book_path.ends_with('/') {
                book_path.push('/');
            }
            let href = resolve(base, &format!("{book_path}{uid}.vcf"))?;
            let body = vcard::serialize_new(uid, name, email, note.as_deref());
            (href, body, vec![("if-none-match", "*".to_string())])
        }
        PutCardInput::Update {
            href,
            etag,
            vcard,
            name,
            note,
            uid_fallback,
        } => {
            let absolute = resolve(base, href)?;
            let body = vcard::update(vcard, name, note.as_deref(), uid_fallback)?;
            let preconditions = etag
                .as_deref()
                .map(|etag| vec![("if-match", etag.to_string())])
                .unwrap_or_default();
            (absolute, body, preconditions)
        }
    };

    let response = dav_request(
        "PUT",
        &href,
        None,
        VCARD_CONTENT_TYPE,
        &body,
        &preconditions,
        credentials,
    )
    .await?;

    let mut etag = response.etag.clone().filter(|etag| !etag.is_empty());
    let mut status = response.status;
    let mut preconditions = preconditions;

    // 412 on create: the URI is taken — last write wins, re-PUT
    // unconditionally.
    if status == 412 && !preconditions.is_empty() && matches!(input, PutCardInput::Create { .. }) {
        let response = dav_request("PUT", &href, None, VCARD_CONTENT_TYPE, &body, &[], credentials)
            .await?;
        status = response.status;
        etag = response.etag.clone().filter(|etag| !etag.is_empty());
    }

    // 412 on update (the resource changed under us): GET the fresh ETag
    // and re-PUT the LOCAL version (last write wins). 404: the resource
    // is gone server-side — recreate unconditionally.
    if (status == 412 || status == 404) && matches!(input, PutCardInput::Update { .. }) {
        if status == 412 {
            let fresh = refetch_etag(&href, credentials).await?;
            preconditions = vec![("if-match", fresh)];
        } else {
            preconditions = Vec::new();
        }
        let response = dav_request(
            "PUT",
            &href,
            None,
            VCARD_CONTENT_TYPE,
            &body,
            &preconditions,
            credentials,
        )
        .await?;
        status = response.status;
        etag = response.etag.clone().filter(|etag| !etag.is_empty());
    }

    if !(200..300).contains(&status) {
        return Err(CarddavError::Status { code: status });
    }
    // PUT responses routinely omit the ETag — refetch per the checklist.
    if etag.is_none() {
        etag = Some(refetch_etag(&href, credentials).await?);
    }
    Ok(PutOutcome {
        href,
        etag: etag.unwrap_or_default(),
        vcard: body,
    })
}

/// DELETE one card: `If-Match` when an ETag is known; 404 counts as
/// success (already gone — the local row may be dropped); a 412 retries
/// once WITHOUT the precondition (last write wins: the deletion wins);
/// 403 surfaces as the typed read-only-flavored status error.
pub(crate) async fn delete_card(
    base: &RequestUrl,
    credentials: &CardDavCredentials,
    href_target: &str,
    etag: Option<&str>,
) -> Result<(), CarddavError> {
    let href = resolve(base, href_target)?;
    let mut preconditions: Vec<(&str, String)> = etag
        .map(|etag| vec![("if-match", etag.to_string())])
        .unwrap_or_default();
    let mut response = dav_request(
        "DELETE",
        &href,
        None,
        "application/xml; charset=utf-8",
        "",
        &preconditions,
        credentials,
    )
    .await?;
    if response.status == 412 && !preconditions.is_empty() {
        preconditions = Vec::new();
        response = dav_request(
            "DELETE",
            &href,
            None,
            "application/xml; charset=utf-8",
            "",
            &preconditions,
            credentials,
        )
        .await?;
    }
    // 404 is SUCCESS here — already deleted server-side, deletion is
    // idempotent.
    if response.status == 404 {
        return Ok(());
    }
    if !(200..300).contains(&response.status) {
        return Err(CarddavError::Status {
            code: response.status,
        });
    }
    Ok(())
}

// ---------- Tests ----------
//
// These ride the CalDAV loopback routing mock (`caldav/mock.rs`, the
// `ai::mock` pattern — plaintext loopback HTTP is exactly what the shared
// transport policy allows): the discovery chain, the ctag short-circuit,
// the sync-collection pass with its `valid-sync-token` fallback, the
// full pull, multiget batches and error paths, and the etag-disciplined
// writes are exercised against canned Radicale-style answers.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caldav::mock::{self, Route};

    const USER: &str = "user@example.com";
    const PASS: &str = "app-password-123";
    const BOOK: &str = "/dav/user/addresses/contacts/";

    fn creds() -> CardDavCredentials {
        CardDavCredentials {
            username: USER.to_string(),
            app_password: PASS.to_string(),
        }
    }

    /// Route builder that leaks the target string (test-only): Route
    /// targets are &'static str, and most of these targets are built
    /// from the BOOK const.
    fn route(method: &'static str, target: String, response: String) -> Route {
        Route::new(method, Box::leak(target.into_boxed_str()), response)
    }

    /// Leak a built target string into a &'static str (test-only helper
    /// for `Route::new`, whose targets are &'static str).
    fn t(target: &str) -> &'static str {
        Box::leak(target.to_owned().into_boxed_str())
    }

    fn card_vcard(uid: &str, name: &str, email: &str) -> String {
        format!(
            "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:{uid}\r\nFN:{name}\r\nEMAIL:{email}\r\nEND:VCARD\r\n"
        )
    }

    /// One card response for a multiget/listing answer.
    fn card_item(href: &str, etag: &str, vcard: &str) -> String {
        format!(
            r#"<D:response>
    <D:href>{href}</D:href>
    <D:propstat>
      <D:prop>
        <D:getetag>{etag}</D:getetag>
        <C:address-data>{}</C:address-data>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>"#,
            vcard.replace('\r', "&#13;").replace('\n', "&#10;")
        )
    }

    fn multistatus(inner: &str, token: Option<&str>) -> String {
        let token_line = token
            .map(|token| format!("<D:sync-token>{token}</D:sync-token>"))
            .unwrap_or_default();
        mock::xml_response(
            207,
            "Multi-Status",
            t(&format!(
                r#"<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">{token_line}{inner}</D:multistatus>"#
            )),
        )
    }

    fn book_listing() -> String {
        mock::xml_response(
            207,
            "Multi-Status",
            r#"<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:response>
    <D:href>/dav/user/addresses/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/user/addresses/contacts/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>
        <D:displayname>Contacts</D:displayname>
        <cs:getctag>CTAG-1</cs:getctag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#,
        )
    }

    // ---------------- Discovery ----------------

    #[tokio::test]
    async fn discovery_walks_principal_home_then_books() {
        let server = mock::spawn_routes(vec![
            // The pasted-collection shortcut probe (collections body).
            Route::new("PROPFIND", "/", mock::xml_response(
                207,
                "Multi-Status",
                r#"<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/</D:href>
    <D:propstat>
      <D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#,
            ))
            .with_body_marker("current-user-privilege-set"),
            // The current-user-principal probe answers on the base URL
            // itself (Radicale-style principal collections).
            Route::new("PROPFIND", "/", mock::xml_response(
                207,
                "Multi-Status",
                r#"<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/</D:href>
    <D:propstat>
      <D:prop><D:current-user-principal><D:href>/dav/user/</D:href></D:current-user-principal></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#,
            ))
            .with_body_marker("current-user-principal"),
            Route::new("PROPFIND", "/dav/user/", mock::xml_response(
                207,
                "Multi-Status",
                r#"<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:response>
    <D:href>/dav/user/</D:href>
    <D:propstat>
      <D:prop><C:addressbook-home-set><D:href>/dav/user/addresses/</D:href></C:addressbook-home-set></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#,
            )),
            Route::new("PROPFIND", "/dav/user/addresses/", book_listing()).with_depth(1),
        ])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        let books = discover(&base, &creds()).await.expect("discovery works");
        assert_eq!(books.len(), 1, "{books:?}");
        assert_eq!(books[0].href, t(&format!("{}{}", server.base_url(), BOOK)));
        assert_eq!(books[0].display_name.as_deref(), Some("Contacts"));
        assert_eq!(books[0].ctag.as_deref(), Some("CTAG-1"));

        let requests = server.requests();
        assert_eq!(requests.len(), 4);
        // Shortcut probe first (collections body incl. privileges), then
        // principal → home-set → Depth-1 listing.
        assert!(requests[0].body.contains("current-user-privilege-set"));
        assert_eq!(requests[1].target, "/");
        assert!(requests[1].body.contains("current-user-principal"));
        assert_eq!(requests[2].target, "/dav/user/");
        assert!(requests[2].body.contains("addressbook-home-set"));
        assert_eq!(requests[3].target, "/dav/user/addresses/");
        assert_eq!(requests[3].header("depth"), Some("1"));
    }

    #[tokio::test]
    async fn discovery_shortcuts_a_pasted_addressbook_url() {
        let server = mock::spawn_routes(vec![Route::new(
            "PROPFIND",
            "/dav/user/addresses/contacts/",
            mock::xml_response(
                207,
                "Multi-Status",
                r#"<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:response>
    <D:href>/dav/user/addresses/contacts/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>
        <D:displayname>Direct</D:displayname>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#,
            ),
        )])
        .await;
        let base = parse_request_url(t(&format!(
            "{}/dav/user/addresses/contacts/",
            server.base_url()
        )))
        .unwrap();

        let books = discover(&base, &creds()).await.expect("shortcut works");
        assert_eq!(books.len(), 1);
        assert_eq!(
            books[0].href,
            format!("{}{}", server.base_url(), BOOK)
        );
        assert_eq!(books[0].display_name.as_deref(), Some("Direct"));
        assert_eq!(server.requests().len(), 1);
    }

    #[tokio::test]
    async fn discovery_401_is_the_typed_needs_reauth_error() {
        let server = mock::spawn_routes(vec![Route::new(
            "PROPFIND",
            "/",
            mock::raw_status(401, "Unauthorized"),
        )])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        let error = discover(&base, &creds()).await.expect_err("401 is an error");
        assert_eq!(error.kind(), "auth");
        let message = error.to_string();
        assert!(message.contains("app password"), "{message}");
        assert!(!message.contains(PASS), "never echo the secret: {message}");
    }

    #[tokio::test]
    async fn discovery_refuses_cross_origin_hrefs() {
        // The listing points at another host: discovery must refuse
        // instead of following it with credentials.
        let server = mock::spawn_routes(vec![
            Route::new(
                "PROPFIND",
                "/",
                mock::xml_response(
                    207,
                    "Multi-Status",
                    r#"<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/</D:href>
    <D:propstat>
      <D:prop><D:current-user-principal><D:href>/dav/user/</D:href></D:current-user-principal></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#,
                ),
            ),
            Route::new(
                "PROPFIND",
                "/dav/user/",
                mock::xml_response(
                    207,
                    "Multi-Status",
                    r#"<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:response>
    <D:href>/dav/user/</D:href>
    <D:propstat>
      <D:prop><C:addressbook-home-set><D:href>https://evil.example/dav/</D:href></C:addressbook-home-set></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#,
                ),
            ),
        ])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        let error = discover(&base, &creds())
            .await
            .expect_err("cross-origin href is refused");
        assert_eq!(error.kind(), "config");
        assert!(error.to_string().contains("origin"), "{error}");
    }

    #[tokio::test]
    async fn discovery_without_a_principal_is_a_config_error() {
        let server = mock::spawn_routes(vec![
            Route::new("PROPFIND", "/", mock::raw_status(404, "Not Found")),
            Route::new(
                "PROPFIND",
                "/.well-known/carddav",
                mock::raw_status(404, "Not Found"),
            ),
        ])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        let error = discover(&base, &creds()).await.expect_err("no principal");
        assert_eq!(error.kind(), "config");
        assert!(error.to_string().contains("current-user-principal"), "{error}");
    }

    // ---------------- Sync pass ----------------

    fn state_body(ctag: &str, token: Option<&str>) -> String {
        let token_line = token
            .map(|token| format!("<D:sync-token>{token}</D:sync-token>"))
            .unwrap_or_default();
        mock::xml_response(
            207,
            "Multi-Status",
            t(&format!(
                r#"<D:multistatus xmlns:D="DAV:" xmlns:cs="http://calendarserver.org/ns/">
  <D:response>
    <D:href>{BOOK}</D:href>
    <D:propstat>
      <D:prop><cs:getctag>{ctag}</cs:getctag>{token_line}</D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#
            )),
        )
    }

    #[tokio::test]
    async fn ctag_short_circuit_skips_the_whole_pass() {
        let server = mock::spawn_routes(vec![Route::new(
            "PROPFIND",
            BOOK,
            state_body("CTAG-1", Some("urn:sync:1")),
        )])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        let outcome = sync_book(
            &base,
            &creds(),
            BOOK,
            Some("urn:sync:1"),
            Some("CTAG-1"),
            &[],
        )
        .await
        .expect("short-circuit works");
        assert_eq!(outcome.mode, "unchanged");
        assert!(outcome.cards.is_empty());
        assert_eq!(outcome.next_sync_token.as_deref(), Some("urn:sync:1"));
        assert_eq!(server.requests().len(), 1, "no REPORT was made");
    }

    #[tokio::test]
    async fn initial_full_sync_uses_an_empty_token_and_multigets_cards() {
        let listing = multistatus(
            t(&format!(
                r#"<D:response>
    <D:href>{BOOK}a.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"etag-a"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>"#
            )),
            Some("urn:sync:fresh"),
        );
        let multiget_answer = multistatus(
            &card_item(
                t(&format!("{BOOK}a.vcf")),
                "&quot;etag-a&quot;",
                &card_vcard("uid-a", "Ada", "ada@example.test"),
            ),
            None,
        );
        let server = mock::spawn_routes(vec![
            Route::new("PROPFIND", BOOK, state_body("CTAG-2", Some("urn:sync:1"))),
            Route::new("REPORT", BOOK, listing).with_body_marker("sync-collection"),
            Route::new("REPORT", BOOK, multiget_answer).with_body_marker("addressbook-multiget"),
        ])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        let outcome = sync_book(&base, &creds(), BOOK, None, None, &[])
            .await
            .expect("initial sync works");
        assert_eq!(outcome.mode, "full");
        assert_eq!(outcome.next_sync_token.as_deref(), Some("urn:sync:fresh"));
        assert_eq!(outcome.ctag.as_deref(), Some("CTAG-2"));
        assert_eq!(outcome.cards.len(), 1);
        let card = &outcome.cards[0];
        assert_eq!(card.href, format!("{}a.vcf", server.base_url() + BOOK));
        assert_eq!(card.summary.uid, "uid-a");
        assert_eq!(card.summary.email, "ada@example.test");
        assert!(card.vcard.starts_with("BEGIN:VCARD"));

        let requests = server.requests();
        assert_eq!(requests.len(), 3);
        // RFC 6578: Depth 0, sync-level 1, EMPTY token element for the
        // initial state, etag-only props.
        let report = &requests[1];
        assert_eq!(report.header("depth"), Some("0"));
        assert!(report.body.contains("sync-level>1<"));
        assert!(report.body.contains("<d:sync-token></d:sync-token>"));
        assert!(report.body.contains("getetag"));
        assert!(!report.body.contains("address-data"), "etag-only listing");
        let multiget = &requests[2];
        assert_eq!(multiget.header("depth"), Some("0"));
        assert!(multiget.body.contains("address-data"));
    }

    #[tokio::test]
    async fn incremental_sync_sends_the_stored_token_and_applies_changes() {
        let listing = multistatus(
            t(&format!(
                r#"<D:response>
    <D:href>{BOOK}b.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"etag-b"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>{BOOK}gone.vcf</D:href>
    <D:status>HTTP/1.1 404 Not Found</D:status>
  </D:response>"#
            )),
            Some("urn:sync:3"),
        );
        let multiget_answer = multistatus(
            &card_item(
                t(&format!("{BOOK}b.vcf")),
                "&quot;etag-b&quot;",
                &card_vcard("uid-b", "Bob", "bob@example.test"),
            ),
            None,
        );
        let server = mock::spawn_routes(vec![
            Route::new("PROPFIND", BOOK, state_body("CTAG-3", Some("urn:sync:1"))),
            Route::new("REPORT", BOOK, listing).with_body_marker("urn:sync:1"),
            Route::new("REPORT", BOOK, multiget_answer).with_body_marker("addressbook-multiget"),
        ])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        let outcome = sync_book(
            &base,
            &creds(),
            BOOK,
            Some("urn:sync:1"),
            None,
            &[],
        )
        .await
        .expect("delta works");
        assert_eq!(outcome.mode, "delta");
        assert_eq!(outcome.next_sync_token.as_deref(), Some("urn:sync:3"));
        assert_eq!(outcome.cards.len(), 1);
        assert_eq!(outcome.removed.len(), 1);
        assert_eq!(
            outcome.removed[0],
            format!("{}gone.vcf", server.base_url() + BOOK)
        );
        assert!(server.requests()[1].body.contains("urn:sync:1"));
    }

    #[tokio::test]
    async fn etag_diff_skips_unchanged_cards() {
        // Same ETag as stored → the card is NOT multiget'ed again.
        let listing = multistatus(
            t(&format!(
                r#"<D:response>
    <D:href>{BOOK}a.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"etag-a"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>"#
            )),
            Some("urn:sync:2"),
        );
        let server = mock::spawn_routes(vec![
            Route::new("PROPFIND", BOOK, state_body("CTAG-4", Some("urn:sync:1"))),
            Route::new("REPORT", BOOK, listing).with_body_marker("urn:sync:1"),
        ])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();
        let known_href = format!("{}a.vcf", server.base_url() + BOOK);

        let outcome = sync_book(
            &base,
            &creds(),
            BOOK,
            Some("urn:sync:1"),
            None,
            &[CarddavKnownCard {
                href: known_href,
                etag: Some("\"etag-a\"".to_string()),
            }],
        )
        .await
        .expect("delta works");
        assert_eq!(outcome.mode, "delta");
        assert!(outcome.cards.is_empty(), "unchanged card skipped");
        assert_eq!(server.requests().len(), 2, "no multiget was made");
    }

    #[tokio::test]
    async fn valid_sync_token_falls_back_to_the_full_pull() {
        let rejected = mock::xml_response(
            403,
            "Forbidden",
            r#"<D:error xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav"><C:valid-sync-token/></D:error>"#,
        );
        let full_listing = multistatus(
            t(&format!(
                r#"<D:response>
    <D:href>{BOOK}c.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"etag-c"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>"#
            )),
            None,
        );
        let multiget_answer = multistatus(
            &card_item(
                t(&format!("{BOOK}c.vcf")),
                "&quot;etag-c&quot;",
                &card_vcard("uid-c", "Cid", "cid@example.test"),
            ),
            None,
        );
        let server = mock::spawn_routes(vec![
            Route::new("PROPFIND", BOOK, state_body("CTAG-5", Some("urn:sync:1"))),
            Route::new("REPORT", BOOK, rejected).with_body_marker("sync-collection"),
            Route::new("REPORT", BOOK, full_listing).with_body_marker("addressbook-query"),
            Route::new("REPORT", BOOK, multiget_answer).with_body_marker("addressbook-multiget"),
        ])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();
        // A locally-known href that is absent from the full listing counts
        // as removed (local-minus-remote).
        let stale_href = format!("{}stale.vcf", server.base_url() + BOOK);

        let outcome = sync_book(
            &base,
            &creds(),
            BOOK,
            Some("urn:sync:1"),
            None,
            &[CarddavKnownCard {
                href: stale_href.clone(),
                etag: Some("\"old\"".to_string()),
            }],
        )
        .await
        .expect("full fallback works");
        assert_eq!(outcome.mode, "full");
        assert_eq!(outcome.cards.len(), 1);
        assert_eq!(outcome.removed, vec![stale_href]);
        // The full-pull pass keeps the ADVERTISED token: the server does
        // support sync-collection, so the NEXT pass retries incremental
        // (it will fall back again while the token stays rejected).
        assert_eq!(outcome.next_sync_token.as_deref(), Some("urn:sync:1"));

        let requests = server.requests();
        assert_eq!(requests.len(), 4);
        // The fallback listing is the FN-filtered addressbook-query at
        // Depth 1 (so email-less cards still list).
        assert_eq!(requests[2].header("depth"), Some("1"));
        assert!(requests[2].body.contains("addressbook-query"));
        assert!(requests[2].body.contains("prop-filter"));
    }

    #[tokio::test]
    async fn unsupported_sync_collection_falls_back_to_the_full_pull() {
        let full_listing = multistatus(
            t(&format!(
                r#"<D:response>
    <D:href>{BOOK}d.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"etag-d"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>"#
            )),
            None,
        );
        let multiget_answer = multistatus(
            &card_item(
                t(&format!("{BOOK}d.vcf")),
                "&quot;etag-d&quot;",
                &card_vcard("uid-d", "Dee", "dee@example.test"),
            ),
            None,
        );
        let server = mock::spawn_routes(vec![
            // State PROPFIND refused (server without ctag/token support).
            Route::new("PROPFIND", BOOK, mock::raw_status(403, "Forbidden")),
            Route::new("REPORT", BOOK, mock::raw_status(405, "Method Not Allowed"))
                .with_body_marker("sync-collection"),
            Route::new("REPORT", BOOK, full_listing).with_body_marker("addressbook-query"),
            Route::new("REPORT", BOOK, multiget_answer).with_body_marker("addressbook-multiget"),
        ])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        // A stored token exists (an older sync) but the server now
        // rejects sync-collection outright: the pass degrades to the
        // addressbook-query pull and still converges.
        let outcome = sync_book(&base, &creds(), BOOK, Some("urn:sync:old"), None, &[])
            .await
            .expect("full pull works");
        assert_eq!(outcome.mode, "full");
        assert_eq!(outcome.cards.len(), 1);
        assert_eq!(outcome.ctag, None);
        assert_eq!(outcome.next_sync_token, None);

        let requests = server.requests();
        assert_eq!(requests.len(), 4);
        assert!(requests[1].body.contains("sync-collection"));
        assert!(requests[2].body.contains("addressbook-query"));
    }

    #[tokio::test]
    async fn full_pull_requires_an_etag_per_item() {
        let full_listing = multistatus(
            t(&format!(
                r#"<D:response>
    <D:href>{BOOK}e.vcf</D:href>
    <D:propstat>
      <D:prop><D:displayname>no etag here</D:displayname></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>"#
            )),
            None,
        );
        let server = mock::spawn_routes(vec![
            Route::new("PROPFIND", BOOK, state_body("CTAG-6", None)),
            Route::new("REPORT", BOOK, full_listing).with_body_marker("addressbook-query"),
        ])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        let error = sync_book(&base, &creds(), BOOK, None, None, &[])
            .await
            .expect_err("missing ETag is an error");
        assert_eq!(error.kind(), "parse");
        assert!(error.to_string().contains("ETag"), "{error}");
        assert_eq!(server.requests().len(), 2);
    }

    #[tokio::test]
    async fn multiget_batches_are_capped_at_fifty_hrefs() {
        // 120 changed cards → three batches (50/50/20). Each batch's
        // multiget is routed by a body marker only present in that
        // batch's request, and answers exactly that batch's cards.
        const COUNT: usize = 120;
        let mut listing_items = String::new();
        for index in 0..COUNT {
            listing_items.push_str(t(&format!(
                r#"<D:response><D:href>{BOOK}card-{index}.vcf</D:href><D:propstat><D:prop><D:getetag>"e{index}"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>"#
            )));
        }
        let listing = multistatus(&listing_items, None);

        fn batch_answer(range: std::ops::Range<usize>) -> String {
            let mut items = String::new();
            for index in range {
                items.push_str(&card_item(
                    t(&format!("{BOOK}card-{index}.vcf")),
                    t(&format!("&quot;e{index}&quot;")),
                    &card_vcard(t(&format!("uid-{index}")), t(&format!("P{index}")), t(&format!("p{index}@example.test"))),
                ));
            }
            multistatus(&items, None)
        }

        let server = mock::spawn_routes(vec![
            Route::new("PROPFIND", BOOK, state_body("CTAG-7", None)),
            Route::new("REPORT", BOOK, listing).with_body_marker("addressbook-query"),
            Route::new("REPORT", BOOK, batch_answer(0..50))
                .with_body_marker("card-0.vcf"),
            Route::new("REPORT", BOOK, batch_answer(50..100))
                .with_body_marker("card-99.vcf"),
            Route::new("REPORT", BOOK, batch_answer(100..COUNT))
                .with_body_marker("card-119.vcf"),
        ])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        let outcome = sync_book(&base, &creds(), BOOK, None, None, &[])
            .await
            .expect("all three batches land");
        assert_eq!(outcome.cards.len(), COUNT);
        assert_eq!(outcome.skipped, 0);

        let requests = server.requests();
        let multigets: Vec<_> = requests
            .iter()
            .filter(|request| request.body.contains("addressbook-multiget"))
            .collect();
        assert_eq!(multigets.len(), 3, "120 cards in 3 batches");
        let counts: Vec<usize> = multigets
            .iter()
            .map(|request| request.body.matches("<d:href>").count())
            .collect();
        assert_eq!(counts, vec![50, 50, 20], "batches capped at 50 hrefs");
    }

    #[tokio::test]
    async fn multiget_missing_href_is_an_error() {
        let listing = multistatus(
            t(&format!(
                r#"<D:response>
    <D:href>{BOOK}f.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"etag-f"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>"#
            )),
            None,
        );
        // The multiget "forgets" the requested card entirely.
        let server = mock::spawn_routes(vec![
            Route::new("PROPFIND", BOOK, state_body("CTAG-8", None)),
            Route::new("REPORT", BOOK, listing).with_body_marker("addressbook-query"),
            Route::new(
                "REPORT",
                BOOK,
                multistatus("", None),
            )
            .with_body_marker("addressbook-multiget"),
        ])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        let error = sync_book(&base, &creds(), BOOK, None, None, &[])
            .await
            .expect_err("missing href is an error");
        assert_eq!(error.kind(), "parse");
        assert!(error.to_string().contains("omitted"), "{error}");
    }

    #[tokio::test]
    async fn multiget_item_404_counts_as_a_removal_and_bad_cards_are_skipped() {
        let listing = multistatus(
            t(&format!(
                r#"<D:response>
    <D:href>{BOOK}good.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"etag-g"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>{BOOK}bad.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"etag-bad"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>"#
            )),
            None,
        );
        let multiget_answer = multistatus(
            t(&format!(
                "{}{}",
                card_item(
                    &format!("{BOOK}good.vcf"),
                    "&quot;etag-g&quot;",
                    &card_vcard("uid-g", "Good", "good@example.test"),
                ),
                // A card with no UID/FN/email: parse failure → skipped.
                card_item(
                    &format!("{BOOK}bad.vcf"),
                    "&quot;etag-bad&quot;",
                    "BEGIN:VCARD\r\nVERSION:2.1\r\nN:Bad\r\nEND:VCARD\r\n",
                )
            )),
            None,
        );
        let server = mock::spawn_routes(vec![
            Route::new("PROPFIND", BOOK, state_body("CTAG-9", None)),
            Route::new("REPORT", BOOK, listing).with_body_marker("addressbook-query"),
            Route::new("REPORT", BOOK, multiget_answer).with_body_marker("addressbook-multiget"),
        ])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        let outcome = sync_book(&base, &creds(), BOOK, None, None, &[])
            .await
            .expect("the good card still lands");
        assert_eq!(outcome.cards.len(), 1);
        assert_eq!(outcome.cards[0].summary.uid, "uid-g");
        assert_eq!(outcome.skipped, 1, "the bad card is counted");
    }

    #[tokio::test]
    async fn multiget_item_without_address_data_is_an_error() {
        let listing = multistatus(
            t(&format!(
                r#"<D:response>
    <D:href>{BOOK}h.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"etag-h"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>"#
            )),
            None,
        );
        let empty_answer = mock::xml_response(
            207,
            "Multi-Status",
            t(&format!(
                r#"<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>{BOOK}h.vcf</D:href>
    <D:propstat>
      <D:prop><D:getetag>"etag-h"</D:getetag></D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#
            )),
        );
        let server = mock::spawn_routes(vec![
            Route::new("PROPFIND", BOOK, state_body("CTAG-10", None)),
            Route::new("REPORT", BOOK, listing).with_body_marker("addressbook-query"),
            Route::new("REPORT", BOOK, empty_answer).with_body_marker("addressbook-multiget"),
        ])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        let error = sync_book(&base, &creds(), BOOK, None, None, &[])
            .await
            .expect_err("no address-data is an error");
        assert_eq!(error.kind(), "parse");
        assert!(error.to_string().contains("address-data"), "{error}");
    }

    #[tokio::test]
    async fn a_failed_report_never_reports_removals() {
        // The addressbook-query itself fails (500): the pass errors, so
        // the TS layer applies nothing — local contacts survive.
        let server = mock::spawn_routes(vec![
            Route::new("PROPFIND", BOOK, state_body("CTAG-11", None)),
            Route::new(
                "REPORT",
                BOOK,
                mock::raw_status(500, "Server Error"),
            )
            .with_body_marker("addressbook-query"),
        ])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        let error = sync_book(&base, &creds(), BOOK, None, None, &[])
            .await
            .expect_err("500 fails the pass");
        assert_eq!(error.kind(), "status");
        assert_eq!(error.status(), Some(500));
    }

    // ---------------- Writes ----------------

    #[tokio::test]
    async fn create_puts_a_vcard3_urn_uuid_card_with_if_none_match() {
        let server = mock::spawn_routes(vec![route("PUT", format!("{BOOK}urn:uuid:new-1.vcf"),
mock::raw_response(201, "Created", "ETag: \"created\"", ""),
        )])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        let outcome = put_card(
            &base,
            &creds(),
            BOOK,
            &PutCardInput::Create {
                uid: "urn:uuid:new-1".to_string(),
                email: "new@example.test".to_string(),
                name: "New Person".to_string(),
                note: Some("hello".to_string()),
            },
        )
        .await
        .expect("create works");
        assert_eq!(
            outcome.href,
            format!("{}urn:uuid:new-1.vcf", server.base_url() + BOOK)
        );
        assert_eq!(outcome.etag, "\"created\"");

        let request = &server.requests()[0];
        assert_eq!(request.method, "PUT");
        assert_eq!(
            request.header("if-none-match"),
            Some("*"),
            "creates are guarded with If-None-Match: *"
        );
        assert_eq!(
            request.header("content-type"),
            Some("text/vcard; charset=utf-8")
        );
        assert!(request.body.contains("VERSION:3.0"), "{request:?}");
        assert!(request.body.contains("UID:urn:uuid:new-1"), "{request:?}");
        assert!(request.body.contains("FN:New Person"), "{request:?}");
        assert!(request.body.contains("NOTE:hello"), "{request:?}");
        assert!(
            !request.body.contains(PASS),
            "credentials live only in the auth header"
        );
    }

    #[tokio::test]
    async fn update_puts_with_if_match_and_preserves_the_card() {
        let original = card_vcard("server-id", "Old Name", "ada@example.test");
        let server = mock::spawn_routes(vec![Route::new(
            "PUT",
            t(&format!("{BOOK}ada.vcf")),
            mock::raw_response(204, "No Content", "ETag: \"updated\"", ""),
        )])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        let outcome = put_card(
            &base,
            &creds(),
            BOOK,
            &PutCardInput::Update {
                href: format!("{BOOK}ada.vcf"),
                etag: Some("\"old\"".to_string()),
                vcard: original.clone(),
                name: "New Name".to_string(),
                note: None,
                uid_fallback: "server-id".to_string(),
            },
        )
        .await
        .expect("update works");
        assert_eq!(outcome.etag, "\"updated\"");
        assert!(outcome.vcard.contains("FN:New Name"), "{outcome:?}");

        let request = &server.requests()[0];
        assert_eq!(request.header("if-match"), Some("\"old\""));
        assert!(request.body.contains("UID:server-id"), "{request:?}");
        assert!(request.body.contains("EMAIL:ada@example.test"), "{request:?}");
        assert!(!request.body.contains("FN:Old Name"), "{request:?}");
    }

    #[tokio::test]
    async fn put_412_resolves_last_write_wins_via_get_and_reput() {
        let original = card_vcard("server-id", "Old", "ada@example.test");
        let server = mock::spawn_routes(vec![
            Route::new(
                "PUT",
                t(&format!("{BOOK}ada.vcf")),
                mock::raw_status(412, "Precondition Failed"),
            )
            .once(),
            Route::new(
                "GET",
                t(&format!("{BOOK}ada.vcf")),
                mock::raw_response(200, "OK", "ETag: \"fresh\"", ""),
            ),
            Route::new(
                "PUT",
                t(&format!("{BOOK}ada.vcf")),
                mock::raw_response(204, "No Content", "ETag: \"local-won\"", ""),
            ),
        ])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        let outcome = put_card(
            &base,
            &creds(),
            BOOK,
            &PutCardInput::Update {
                href: format!("{BOOK}ada.vcf"),
                etag: Some("\"stale\"".to_string()),
                vcard: original,
                name: "Local Wins".to_string(),
                note: None,
                uid_fallback: "server-id".to_string(),
            },
        )
        .await
        .expect("conflict resolves with the local version");
        assert_eq!(outcome.etag, "\"local-won\"");
        assert!(outcome.vcard.contains("FN:Local Wins"));

        let requests = server.requests();
        assert_eq!(requests.len(), 3);
        assert_eq!(requests[0].header("if-match"), Some("\"stale\""));
        assert_eq!(requests[1].method, "GET");
        assert_eq!(requests[2].header("if-match"), Some("\"fresh\""));
        assert!(
            requests[2].body.contains("FN:Local Wins"),
            "the LOCAL version is re-PUT (last write wins)"
        );
    }

    #[tokio::test]
    async fn put_without_response_etag_refetches() {
        let original = card_vcard("server-id", "Old", "ada@example.test");
        let server = mock::spawn_routes(vec![
            Route::new(
                "PUT",
                t(&format!("{BOOK}ada.vcf")),
                mock::raw_status(201, "Created"),
            ),
            Route::new(
                "GET",
                t(&format!("{BOOK}ada.vcf")),
                mock::raw_response(200, "OK", "ETag: \"from-get\"", ""),
            ),
        ])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        let outcome = put_card(
            &base,
            &creds(),
            BOOK,
            &PutCardInput::Update {
                href: format!("{BOOK}ada.vcf"),
                etag: None,
                vcard: original,
                name: "Refetched".to_string(),
                note: None,
                uid_fallback: "server-id".to_string(),
            },
        )
        .await
        .expect("update works");
        assert_eq!(outcome.etag, "\"from-get\"");
        assert_eq!(server.requests().len(), 2);
    }

    #[tokio::test]
    async fn delete_succeeds_on_2xx_and_tolerates_404() {
        let server = mock::spawn_routes(vec![
            Route::new(
                "DELETE",
                t(&format!("{BOOK}gone.vcf")),
                mock::raw_status(204, "No Content"),
            ),
            Route::new(
                "DELETE",
                t(&format!("{BOOK}already.vcf")),
                mock::raw_status(404, "Not Found"),
            ),
        ])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        delete_card(
            &base,
            &creds(),
            t(&format!("{BOOK}gone.vcf")),
            Some("\"etag\""),
        )
        .await
        .expect("204 is a successful DELETE");
        delete_card(
            &base,
            &creds(),
            t(&format!("{BOOK}already.vcf")),
            Some("\"etag\""),
        )
        .await
        .expect("404 is tolerated on DELETE");

        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].header("if-match"), Some("\"etag\""));

        // Any other non-2xx stays a specific failure.
        let server = mock::spawn_routes(vec![Route::new(
            "DELETE",
            t(&format!("{BOOK}broken.vcf")),
            mock::raw_status(503, "Unavailable"),
        )])
        .await;
        let error = delete_card(
            &parse_request_url(&server.base_url()).unwrap(),
            &creds(),
            t(&format!("{BOOK}broken.vcf")),
            None,
        )
        .await
        .expect_err("503 is an error");
        assert_eq!(error.status(), Some(503));
    }

    #[tokio::test]
    async fn delete_412_retries_without_the_precondition() {
        // Last write wins on delete: the deletion goes through bare.
        let server = mock::spawn_routes(vec![
            Route::new(
                "DELETE",
                t(&format!("{BOOK}contested.vcf")),
                mock::raw_status(412, "Precondition Failed"),
            )
            .once(),
            Route::new(
                "DELETE",
                t(&format!("{BOOK}contested.vcf")),
                mock::raw_status(204, "No Content"),
            ),
        ])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        delete_card(
            &base,
            &creds(),
            t(&format!("{BOOK}contested.vcf")),
            Some("\"stale\""),
        )
        .await
        .expect("the bare retry deletes");
        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert_eq!(requests[0].header("if-match"), Some("\"stale\""));
        assert_eq!(requests[1].header("if-match"), None);
    }

    #[tokio::test]
    async fn write_403_is_the_read_only_flavored_error() {
        let server = mock::spawn_routes(vec![Route::new(
            "PUT",
            t(&format!("{BOOK}ada.vcf")),
            mock::raw_status(403, "Forbidden"),
        )])
        .await;
        let base = parse_request_url(&server.base_url()).unwrap();

        let error = put_card(
            &base,
            &creds(),
            BOOK,
            &PutCardInput::Update {
                href: format!("{BOOK}ada.vcf"),
                etag: None,
                vcard: card_vcard("server-id", "Old", "ada@example.test"),
                name: "X".to_string(),
                note: None,
                uid_fallback: "server-id".to_string(),
            },
        )
        .await
        .expect_err("403 is an error");
        assert_eq!(error.status(), Some(403));
        assert!(error.to_string().contains("read-only"), "{error}");
    }

    #[tokio::test]
    async fn write_cross_origin_hrefs_are_refused() {
        // A stored href pointing at another origin never reaches the
        // transport.
        let server = mock::spawn_routes(vec![]).await;
        let base = parse_request_url(&server.base_url()).unwrap();

        let error = put_card(
            &base,
            &creds(),
            BOOK,
            &PutCardInput::Update {
                href: "https://evil.example/dav/x.vcf".to_string(),
                etag: None,
                vcard: card_vcard("x", "X", "x@example.test"),
                name: "X".to_string(),
                note: None,
                uid_fallback: "x".to_string(),
            },
        )
        .await
        .expect_err("cross-origin href refused");
        assert_eq!(error.kind(), "config");
        assert!(server.requests().is_empty());
    }
}
