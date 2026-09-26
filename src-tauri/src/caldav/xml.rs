//! WebDAV/CalDAV multistatus parsing (task 5.2, design D5).
//!
//! Design D5 names `quick-xml` for the CalDAV client and that is the one
//! deliberate dependency of this task (see `Cargo.toml` for the
//! rationale): CalDAV responses are namespaced, property ORDER and
//! namespace PREFIXES vary per server (Radicale uses `D:`/`cal:`,
//! Nextcloud `d:`/`cal:`, some servers no prefixes at all), and
//! `calendar-data` embeds XML-escaped iCalendar text (`&#13;` for CR and
//! friends) that hand-rolled string walking would have to re-decode
//! correctly.
//!
//! The parse is a single streaming pass over quick-xml events, matching
//! properties by LOCAL name only (namespace prefixes are server
//! vocabulary; the CalDAV property local-name set is unique in practice —
//! a documented trade-off). Output is a flat [`Multistatus`] with one
//! [`DavResponse`] per `<response>`: the properties the client cares
//! about, the resource's `<href>` (a direct child of the response), and
//! the response/propstat status codes (sync-collection reports deletions
//! as 404 statuses). Both nesting depth and the number of parsed
//! responses are capped, so a hostile or broken server cannot blow the
//! parser with unbounded nesting or an unbounded response; exceeding
//! either is a typed parse error. Malformed XML never panics — it is a
//! typed [`CaldavError::Parse`].

use quick_xml::events::Event;
use quick_xml::Reader;

use super::CaldavError;

/// Maximum `<response>` items parsed from one body (the same cap the
/// CardDAV parser enforces: a real calendar never approaches it, a
/// hostile endpoint must not stream one forever).
pub(crate) const MAX_ITEMS: usize = 50_000;
/// Maximum element nesting depth accepted (the same cap the CardDAV
/// parser enforces).
pub(crate) const MAX_DEPTH: usize = 128;
/// One `<response>` (a.k.a. `<D:response>`) of a multistatus body.
#[derive(Debug, Default, Clone)]
pub(crate) struct DavResponse {
    /// The request-URI this response is about (the `href` that is a
    /// direct child of the response element).
    pub href: String,
    /// Status carried by a `status` element that is a direct child of the
    /// response (sync-collection deletions: 404).
    pub status: Option<u16>,
    /// Status carried by the enclosing propstat's `status` element.
    pub prop_status: Option<u16>,
    pub display_name: Option<String>,
    /// `resourcetype` contains a `calendar` element.
    pub is_calendar: bool,
    pub calendar_description: Option<String>,
    /// CalendarServer `getctag` (change tag; display-only today).
    pub ctag: Option<String>,
    /// `getetag` of the resource.
    pub etag: Option<String>,
    /// CALDAV `calendar-data`: the raw, XML-unescaped iCalendar blob.
    pub calendar_data: Option<String>,
    /// `current-user-principal`'s inner href.
    pub current_user_principal: Option<String>,
    /// CALDAV `calendar-home-set`'s inner href.
    pub calendar_home_set: Option<String>,
    /// `supported-calendar-component-set`'s `<comp name="…">` names.
    pub supported_components: Vec<String>,
}

impl DavResponse {
    /// True when the response represents a DELETED resource: either the
    /// response-level or the propstat-level status is 404 (RFC 6578 §3.6:
    /// deletions are reported with a 404 status on the response).
    pub(crate) fn is_removed(&self) -> bool {
        self.status == Some(404) || self.prop_status == Some(404)
    }
}

/// A parsed multistatus body.
#[derive(Debug, Default, Clone)]
pub(crate) struct Multistatus {
    pub responses: Vec<DavResponse>,
    /// The `sync-token` that is a DIRECT child of `multistatus` (the
    /// cursor for the next incremental REPORT).
    pub sync_token: Option<String>,
}

/// What the streaming pass is currently collecting. Text props capture
/// their character data; structural props (resourcetype,
/// current-user-principal, calendar-home-set,
/// supported-calendar-component-set) watch for specific descendants.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Prop {
    /// A text-valued prop, by its local name.
    Text(&'static str),
    ResourceType,
    CurrentUserPrincipal,
    CalendarHomeSet,
    SupportedComponentSet,
    /// A `status` element: `true` = direct child of the response,
    /// `false` = child of a propstat.
    Status(bool),
}

impl Prop {
    fn local(&self) -> &'static str {
        match self {
            Prop::Text(name) => name,
            Prop::ResourceType => "resourcetype",
            Prop::CurrentUserPrincipal => "current-user-principal",
            Prop::CalendarHomeSet => "calendar-home-set",
            Prop::SupportedComponentSet => "supported-calendar-component-set",
            Prop::Status(_) => "status",
        }
    }
}

/// Active capture: which property, at which stack depth it started, and
/// the text accumulated so far.
#[derive(Debug, Clone)]
struct Capture {
    prop: Prop,
    depth: usize,
    text: String,
    /// For the href-carrying props (current-user-principal,
    /// calendar-home-set): the inner `href` element is open, so Text
    /// events belong to the value.
    in_href: bool,
}

/// Streaming parser state (one pass, no lookahead).
#[derive(Debug, Default)]
struct Parser {
    /// Open-element stack of local names.
    stack: Vec<String>,
    capture: Option<Capture>,
    /// Inside a `href` that is a DIRECT child of `response`.
    in_response_href: bool,
    /// Any `multistatus` element was seen (a 2xx body without one is a
    /// parse error, not an empty report).
    saw_multistatus: bool,
    result: Multistatus,
    current: Option<DavResponse>,
}

impl Parser {
    fn handle_start(&mut self, name: &str, attributes: Attributes<'_>) -> Result<(), CaldavError> {
        let local = local_name(name);
        if self.stack.len() >= MAX_DEPTH {
            return Err(CaldavError::Parse(
                "XML nesting limit exceeded".to_string(),
            ));
        }
        let capturing = self.capture.as_ref().map(|capture| capture.prop);
        let depth_before_push = self.stack.len();

        // Descendant detection inside an active capture.
        match capturing {
            Some(Prop::ResourceType) if local == "calendar" => {
                self.mark_current_calendar()?;
            }
            Some(Prop::CurrentUserPrincipal | Prop::CalendarHomeSet) if local == "href" => {
                if let Some(capture) = self.capture.as_mut() {
                    capture.in_href = true;
                }
            }
            Some(Prop::SupportedComponentSet) if local == "comp" => {
                self.record_component(attributes)?;
            }
            _ => {}
        }

        // Start a capture when a recognized element appears where we read
        // it. Props are read inside `<prop>`; the report-level
        // `sync-token` and the `status` elements sit elsewhere.
        if self.capture.is_none() {
            let inside_prop = self.stack.last().map(String::as_str) == Some("prop");
            let new_capture = if inside_prop {
                match local.as_str() {
                    "displayname" => Some(Prop::Text("displayname")),
                    "getctag" => Some(Prop::Text("getctag")),
                    "getetag" => Some(Prop::Text("getetag")),
                    "calendar-data" => Some(Prop::Text("calendar-data")),
                    "calendar-description" => Some(Prop::Text("calendar-description")),
                    "sync-token" => Some(Prop::Text("sync-token")),
                    "resourcetype" => Some(Prop::ResourceType),
                    "current-user-principal" => Some(Prop::CurrentUserPrincipal),
                    "calendar-home-set" => Some(Prop::CalendarHomeSet),
                    "supported-calendar-component-set" => Some(Prop::SupportedComponentSet),
                    _ => None,
                }
            } else if local == "sync-token" && depth_before_push == 1 {
                // The report cursor: a direct child of multistatus. (An
                // in-prop sync-token is captured by the prop arm above.)
                Some(Prop::Text("sync-token"))
            } else if local == "status" {
                let response_level = self.stack.last().map(String::as_str) == Some("response");
                Some(Prop::Status(response_level))
            } else {
                None
            };
            if let Some(prop) = new_capture {
                self.capture = Some(Capture {
                    prop,
                    depth: depth_before_push,
                    text: String::new(),
                    in_href: false,
                });
            }
        }

        // The response's own href (direct child of response, no capture
        // active) is captured via in_response_href + Text events below.
        self.in_response_href = self.capture.is_none()
            && local == "href"
            && depth_before_push == 2
            && self.stack.first().map(String::as_str) == Some("multistatus")
            && self.stack.last().map(String::as_str) == Some("response");

        self.stack.push(local);
        if self.stack.last().map(String::as_str) == Some("response") {
            // Entering a response element. WebDAV never nests responses,
            // but only start a NEW one at the multistatus level; a stray
            // nested one is ignored (its props would error loudly
            // otherwise).
            if self.stack.len() == 2 && self.stack[0] == "multistatus" {
                self.current = Some(DavResponse::default());
            }
        }
        Ok(())
    }

    fn handle_empty(&mut self, name: &str, attributes: Attributes<'_>) -> Result<(), CaldavError> {
        let local = local_name(name);
        // Self-closing elements emit Empty and NO End event.
        match self.capture.as_ref().map(|capture| capture.prop) {
            Some(Prop::ResourceType) if local == "calendar" => {
                self.mark_current_calendar()?;
            }
            Some(Prop::SupportedComponentSet) if local == "comp" => {
                self.record_component(attributes)?;
            }
            _ => {}
        }
        // An empty report-level sync-token (initial REPORT echoes can be
        // `<D:sync-token/>`): stored as Some("") — the caller treats an
        // empty cursor as "no token" and always full-syncs.
        if self.capture.is_none() && local == "sync-token" && self.stack.len() == 1 {
            self.result.sync_token = Some(String::new());
        }
        Ok(())
    }

    fn handle_text(&mut self, text: &str) -> Result<(), CaldavError> {
        if let Some(capture) = self.capture.as_mut() {
            // For href-carrying props only the inner href's text is the
            // value; for everything else all character data counts.
            let wants_text = match capture.prop {
                Prop::CurrentUserPrincipal | Prop::CalendarHomeSet => capture.in_href,
                _ => true,
            };
            if wants_text {
                capture.text.push_str(text);
            }
            return Ok(());
        }
        if self.in_response_href {
            if let Some(response) = self.current.as_mut() {
                response.href.push_str(text);
            }
        }
        // Inter-element whitespace outside captures: skipped.
        Ok(())
    }

    fn handle_end(&mut self, name: &str) {
        let local = local_name(name);

        if let Some(capture) = self.capture.take() {
            // The capture ends at the close of the element that started
            // it (props never nest same-named elements; the depth check
            // is belt-and-braces for a pathological `<getetag><getetag>`)
            if local == capture.prop.local() && capture.depth == self.stack.len() - 1 {
                self.finish_capture(capture);
            } else {
                self.capture = Some(capture);
            }
        }

        if local == "href" {
            self.in_response_href = false;
        }

        // A response element closed: fold it into the result.
        if local == "response" && self.stack.len() == 2 && self.stack[0] == "multistatus" {
            if let Some(mut response) = self.current.take() {
                response.href = response.href.trim().to_string();
                if !response.href.is_empty() || response.is_calendar {
                    self.result.responses.push(response);
                }
                // A response with no href and no calendar marker carries
                // nothing usable — dropped rather than surfaced.
            }
        }

        self.stack.pop();
    }

    fn finish_capture(&mut self, capture: Capture) {
        let text = capture.text.trim().to_string();
        match capture.prop {
            Prop::Text("sync-token") => {
                if capture.depth == 1 {
                    // Report cursor (in-prop tokens are ignored — they
                    // duplicate the report-level one at best).
                    self.result.sync_token = Some(text);
                }
            }
            Prop::Text("displayname") => {
                if let Some(response) = self.current.as_mut() {
                    response.display_name = Some(text);
                }
            }
            Prop::Text("getctag") => {
                if let Some(response) = self.current.as_mut() {
                    response.ctag = Some(text);
                }
            }
            Prop::Text("getetag") => {
                if let Some(response) = self.current.as_mut() {
                    response.etag = Some(text);
                }
            }
            Prop::Text("calendar-description") => {
                if let Some(response) = self.current.as_mut() {
                    response.calendar_description = Some(text);
                }
            }
            Prop::Text("calendar-data") => {
                // calendar-data keeps its interior text verbatim (only
                // the trim touches it): it is iCalendar, not XML text.
                if let Some(response) = self.current.as_mut() {
                    response.calendar_data = Some(text);
                }
            }
            // Unknown text prop — nothing to store.
            Prop::Text(_) => {}
            Prop::Status(response_level) => {
                let code = parse_status_line(&text);
                if let Some(response) = self.current.as_mut() {
                    if response_level {
                        response.status = code;
                    } else {
                        response.prop_status = code;
                    }
                }
            }
            Prop::CurrentUserPrincipal => {
                if let Some(response) = self.current.as_mut() {
                    response.current_user_principal = Some(text);
                }
            }
            Prop::CalendarHomeSet => {
                if let Some(response) = self.current.as_mut() {
                    response.calendar_home_set = Some(text);
                }
            }
            // Structural props carry no text value of their own.
            Prop::ResourceType | Prop::SupportedComponentSet => {}
        }
    }

    fn mark_current_calendar(&mut self) -> Result<(), CaldavError> {
        match self.current.as_mut() {
            Some(response) => {
                response.is_calendar = true;
                Ok(())
            }
            None => Err(CaldavError::Parse(
                "multistatus property outside a response".to_string(),
            )),
        }
    }

    fn record_component(&mut self, attributes: Attributes<'_>) -> Result<(), CaldavError> {
        let mut name: Option<String> = None;
        for attribute in attributes.flatten() {
            if local_name(attribute.key.as_ref()) == "name" {
                // The attribute value arrives entity-escaped.
                name = quick_xml::escape::unescape(&attribute.value)
                    .ok()
                    .map(|value| value.into_owned());
            }
        }
        if let Some(name) = name.filter(|name| !name.is_empty()) {
            match self.current.as_mut() {
                Some(response) => {
                    response.supported_components.push(name);
                    Ok(())
                }
                None => Err(CaldavError::Parse(
                    "multistatus property outside a response".to_string(),
                )),
            }
        } else {
            Ok(())
        }
    }
}

/// Borrow-shortening alias (quick-xml's attribute iterator).
type Attributes<'a> = quick_xml::events::attributes::Attributes<'a>;

/// Parse one HTTP status line (`HTTP/1.1 200 OK`) into its code.
fn parse_status_line(text: &str) -> Option<u16> {
    text.split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
}

/// Local (prefix-stripped, lowercased) element name.
fn local_name(name: &str) -> String {
    match name.rsplit_once(':') {
        Some((_, local)) => local.to_ascii_lowercase(),
        None => name.to_ascii_lowercase(),
    }
}

/// Parse a multistatus body. Malformed XML is a [`CaldavError::Parse`]
/// with a specific message (never the body itself — it can embed
/// user-controlled hrefs); a 2xx body without any multistatus element is
/// a parse error too.
pub(crate) fn parse_multistatus(body: &str) -> Result<Multistatus, CaldavError> {
    let mut reader = Reader::from_str(body);
    let mut parser = Parser::default();

    loop {
        let event = match reader.read_event() {
            Ok(event) => event,
            Err(error) => {
                return Err(CaldavError::Parse(format!(
                    "malformed XML from the CalDAV server ({error})"
                )));
            }
        };
        match event {
            Event::Start(start) => {
                if local_name(start.name().as_ref()) == "multistatus" {
                    parser.saw_multistatus = true;
                }
                parser.handle_start(start.name().as_ref(), start.attributes())?;
            }
            Event::Empty(start) => {
                if local_name(start.name().as_ref()) == "multistatus" {
                    parser.saw_multistatus = true;
                }
                parser.handle_empty(start.name().as_ref(), start.attributes())?;
            }
            Event::Text(text) => {
                let raw = text.into_inner();
                let decoded = quick_xml::escape::unescape(&raw).map_err(|error| {
                    CaldavError::Parse(format!(
                        "malformed XML text from the CalDAV server ({error})"
                    ))
                })?;
                parser.handle_text(&decoded)?;
            }
            // quick-xml 0.42 splits entity references into their own
            // events (`&#13;` in calendar-data / address-data bodies);
            // decode them into the SAME capture the surrounding text
            // feeds. Predefined entities and character references pass,
            // anything else is a parse error (the whole-text unescape
            // discipline of earlier quick-xml versions).
            Event::GeneralRef(reference) => {
                let name = reference.into_inner();
                let decoded = match quick_xml::escape::resolve_predefined_entity(&name) {
                    Some(value) => value.to_string(),
                    None => quick_xml::escape::unescape(&format!("&{name};"))
                        .map_err(|error| {
                            CaldavError::Parse(format!(
                                "malformed XML text from the CalDAV server ({error})"
                            ))
                        })?
                        .into_owned(),
                };
                parser.handle_text(&decoded)?;
            }
            Event::End(end) => parser.handle_end(end.name().as_ref()),
            Event::Eof => break,
            // Comments, declarations, processing instructions, CDATA:
            // CalDAV props we read never arrive as CDATA sections.
            _ => {}
        }
        if parser.result.responses.len() > MAX_ITEMS {
            return Err(CaldavError::Parse(
                "multistatus exceeded the item limit".to_string(),
            ));
        }
    }

    if !parser.saw_multistatus {
        return Err(CaldavError::Parse(
            "the response was not a WebDAV multistatus document".to_string(),
        ));
    }
    // quick-xml (0.42) does not report EOF with unclosed elements as an
    // error — a TRUNCATED response must not pass as a valid (empty)
    // report.
    if !parser.stack.is_empty() {
        return Err(CaldavError::Parse(
            "truncated XML from the CalDAV server (unclosed elements)".to_string(),
        ));
    }
    Ok(parser.result)
}

/// Extract just the report-level sync token from a REPORT body
/// (`parse_sync_token` work item). `Some("")` when the report echoed an
/// empty token, `None` when it carried none.
///
/// Not on the task 5.2 command path (the sync flow reads the token off
/// the full parse); kept as the named helper for the task 5.4 event
/// write flows, which will need to read a cursor without the rest.
#[allow(dead_code)]
pub(crate) fn parse_sync_token(body: &str) -> Result<Option<String>, CaldavError> {
    Ok(parse_multistatus(body)?.sync_token)
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    /// Radicale-style discovery answer: `D:`/`cal:`/`cs:` prefixes, a
    /// principal response plus two calendar collections.
    const DISCOVERY_FIXTURE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
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
</D:multistatus>"#;

    const COLLECTIONS_FIXTURE: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <D:response>
    <D:href>/dav/user/calendars/home/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><cal:calendar/></D:resourcetype>
        <D:displayname>Home</D:displayname>
        <cal:calendar-description>Family events</cal:calendar-description>
        <cs:getctag>CTAG-1</cs:getctag>
        <cal:supported-calendar-component-set>
          <cal:comp name="VEVENT"/>
          <cal:comp name="VTODO"/>
        </cal:supported-calendar-component-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/user/calendars/tasks/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><cal:calendar/></D:resourcetype>
        <D:displayname>Tasks</D:displayname>
        <cal:supported-calendar-component-set>
          <cal:comp name="VTODO"/>
        </cal:supported-calendar-component-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;

    #[test]
    fn parses_discovery_fixture_with_prefixes() {
        let parsed = parse_multistatus(DISCOVERY_FIXTURE).expect("fixture parses");
        assert_eq!(parsed.responses.len(), 1);
        let response = &parsed.responses[0];
        assert_eq!(response.href, "/dav/user/");
        // The status lives in the propstat (per-response statuses only
        // appear on sync-collection deletions).
        assert_eq!(response.prop_status, Some(200));
        assert_eq!(response.status, None);
        assert_eq!(
            response.current_user_principal.as_deref(),
            Some("/dav/user/")
        );
        assert!(!response.is_calendar);

        let parsed = parse_multistatus(COLLECTIONS_FIXTURE).expect("fixture parses");
        assert_eq!(parsed.responses.len(), 2);
        let home = &parsed.responses[0];
        assert!(home.is_calendar);
        assert_eq!(home.display_name.as_deref(), Some("Home"));
        assert_eq!(home.calendar_description.as_deref(), Some("Family events"));
        assert_eq!(home.ctag.as_deref(), Some("CTAG-1"));
        assert_eq!(home.supported_components, vec!["VEVENT", "VTODO"]);
        // The tasks-only calendar is recognized as a calendar, and its
        // component set lets the caller filter it out.
        let tasks = &parsed.responses[1];
        assert!(tasks.is_calendar);
        assert_eq!(tasks.supported_components, vec!["VTODO"]);
        assert_eq!(parsed.sync_token, None);
    }

    #[test]
    fn parses_prefixless_and_selfclosed_variants() {
        // Nextcloud-style: lowercase/no prefixes, self-closed elements.
        let body = r#"<multistatus xmlns="DAV:">
          <response>
            <href>/remote.php/dav/calendars/user/home/</href>
            <propstat>
              <prop>
                <resourcetype><collection/><calendar/></resourcetype>
                <displayname>Personal</displayname>
              </prop>
              <status>HTTP/1.1 200 OK</status>
            </propstat>
          </response>
        </multistatus>"#;
        let parsed = parse_multistatus(body).expect("parses");
        let response = &parsed.responses[0];
        assert!(response.is_calendar);
        assert_eq!(response.display_name.as_deref(), Some("Personal"));
        assert_eq!(response.href, "/remote.php/dav/calendars/user/home/");
    }

    #[test]
    fn parses_sync_report_with_token_entities_and_removals() {
        let body = r#"<D:multistatus xmlns:D="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
          <D:sync-token>http://example.com/ns/sync/1234</D:sync-token>
          <D:response>
            <D:href>/dav/user/cal/home/a.ics</D:href>
            <D:propstat>
              <D:prop>
                <D:getetag>"abc"</D:getetag>
                <cal:calendar-data>BEGIN:VCALENDAR&#13;&#10;END:VCALENDAR</cal:calendar-data>
              </D:prop>
              <D:status>HTTP/1.1 200 OK</D:status>
            </D:propstat>
          </D:response>
          <D:response>
            <D:href>/dav/user/cal/home/deleted.ics</D:href>
            <D:status>HTTP/1.1 404 Not Found</D:status>
          </D:response>
        </D:multistatus>"#;
        let parsed = parse_multistatus(body).expect("parses");
        assert_eq!(
            parsed.sync_token.as_deref(),
            Some("http://example.com/ns/sync/1234")
        );
        assert_eq!(parsed.responses.len(), 2);
        let added = &parsed.responses[0];
        assert!(!added.is_removed());
        assert_eq!(added.etag.as_deref(), Some("\"abc\""));
        // XML entities in calendar-data are decoded (`&#13;&#10;` → CRLF).
        assert_eq!(
            added.calendar_data.as_deref(),
            Some("BEGIN:VCALENDAR\r\nEND:VCALENDAR")
        );
        let removed = &parsed.responses[1];
        assert!(removed.is_removed());
        assert!(removed.calendar_data.is_none());
    }

    #[test]
    fn propstat_404_counts_as_removed() {
        let body = r#"<D:multistatus xmlns:D="DAV:">
          <D:response>
            <D:href>/dav/gone.ics</D:href>
            <D:propstat>
              <D:prop><D:getetag/></D:prop>
              <D:status>HTTP/1.1 404 Not Found</D:status>
            </D:propstat>
          </D:response>
        </D:multistatus>"#;
        let parsed = parse_multistatus(body).expect("parses");
        assert!(parsed.responses[0].is_removed());
        assert_eq!(parsed.responses[0].href, "/dav/gone.ics");
    }

    #[test]
    fn empty_selfclosed_sync_token_is_an_empty_cursor() {
        let body = r#"<D:multistatus xmlns:D="DAV:"><D:sync-token/><D:response><D:href>/a</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response></D:multistatus>"#;
        let parsed = parse_multistatus(body).expect("parses");
        // The caller must treat an empty cursor as "no token" (full sync).
        assert_eq!(parsed.sync_token, Some(String::new()));
    }

    #[test]
    fn calendar_home_set_is_parsed_from_the_inner_href() {
        let body = r#"<D:multistatus xmlns:D="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">
          <D:response>
            <D:href>/dav/user/</D:href>
            <D:propstat>
              <D:prop>
                <cal:calendar-home-set><D:href>/dav/user/calendars/</D:href></cal:calendar-home-set>
              </D:prop>
              <D:status>HTTP/1.1 200 OK</D:status>
            </D:propstat>
          </D:response>
        </D:multistatus>"#;
        let parsed = parse_multistatus(body).expect("parses");
        assert_eq!(
            parsed.responses[0].calendar_home_set.as_deref(),
            Some("/dav/user/calendars/")
        );
    }

    #[test]
    fn malformed_xml_is_a_parse_error() {
        let error = parse_multistatus("<D:multistatus><D:response>").unwrap_err();
        assert_eq!(error.kind(), "parse");
        assert!(
            parse_multistatus("definitely not xml").is_err(),
            "non-XML garbage is a parse error"
        );
        // A 2xx HTML error page is NOT a valid (empty) report.
        let error = parse_multistatus("<html><body>ok</body></html>").unwrap_err();
        assert!(error.to_string().contains("multistatus"), "{error}");
    }

    #[test]
    fn parse_sync_token_extracts_only_the_report_cursor() {
        let body = r#"<D:multistatus xmlns:D="DAV:">
          <D:response>
            <D:href>/a</D:href>
            <D:propstat>
              <D:prop><D:sync-token>in-prop-noise</D:sync-token></D:prop>
              <D:status>HTTP/1.1 200 OK</D:status>
            </D:propstat>
          </D:response>
          <D:sync-token>real-cursor-7</D:sync-token>
        </D:multistatus>"#;
        assert_eq!(
            parse_sync_token(body).unwrap().as_deref(),
            Some("real-cursor-7")
        );
        assert_eq!(
            parse_sync_token("<D:multistatus xmlns:D=\"DAV:\"/>").unwrap(),
            None
        );
    }

    #[test]
    fn depth_and_item_caps_are_enforced() {
        // Nesting beyond MAX_DEPTH is rejected outright.
        let deep = format!(
            "<D:multistatus xmlns:D=\"DAV:\">{}x{}",
            "<D:a>".repeat(MAX_DEPTH + 2),
            "</D:a>".repeat(MAX_DEPTH + 2)
        );
        let error = parse_multistatus(&deep).unwrap_err();
        assert!(error.to_string().contains("nesting limit"), "{error}");
        // More than MAX_ITEMS responses are rejected.
        let mut body = String::from("<D:multistatus xmlns:D=\"DAV:\">");
        for index in 0..=(MAX_ITEMS) {
            body.push_str(&format!(
                "<D:response><D:href>/r{index}</D:href><D:status>HTTP/1.1 200 OK</D:status></D:response>"
            ));
        }
        body.push_str("</D:multistatus>");
        let error = parse_multistatus(&body).unwrap_err();
        assert!(error.to_string().contains("item limit"), "{error}");
    }
}

