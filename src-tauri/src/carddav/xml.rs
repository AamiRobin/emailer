//! WebDAV/CardDAV multistatus parsing (parity-round-2 task 4.1, design
//! D4). The [`crate::caldav::xml`] approach reused for the address-book
//! property set: one streaming pass over quick-xml events, properties
//! matched by LOCAL name only (namespace prefixes are server vocabulary),
//! output a flat [`Multistatus`] of [`DavItem`]s.
//!
//! Two additions over the CalDAV parser, both required by the CardDAV
//! checklist:
//!
//! - **Successful-propstat-wins status selection**: servers answer
//!   multi-prop PROPFINDs with one propstat per property, and the failed
//!   ones (e.g. a 404 for `getctag` on a server without ctag support)
//!   must not mark the whole resource failed — the first successful
//!   propstat's properties are merged and the item counts as 200; the
//!   first failing propstat's code is only used when no propstat
//!   succeeded. A response-level `<status>` (sync-collection deletions,
//!   multiget misses) always wins outright.
//! - **Depth and item caps** ([`MAX_DEPTH`], [`MAX_ITEMS`]): a hostile or
//!   broken server cannot blow the parser with unbounded nesting or an
//!   unbounded response; exceeding either is a typed parse error.
//!
//! Malformed XML never panics — it is a typed [`CarddavError::Parse`]
//! whose message never embeds the body.

use quick_xml::events::Event;
use quick_xml::Reader;

use super::CarddavError;

/// Maximum `<response>` items parsed from one body (checklist: item caps).
pub(crate) const MAX_ITEMS: usize = 50_000;
/// Maximum element nesting depth accepted (checklist: depth caps).
pub(crate) const MAX_DEPTH: usize = 128;

/// One `<response>` of a multistatus body, with the properties the
/// CardDAV client reads.
#[derive(Debug, Default, Clone)]
pub(crate) struct DavItem {
    /// The request-URI this response is about (the `href` that is a
    /// direct child of the response element).
    pub href: String,
    /// The effective status: the response-level `<status>` when present,
    /// else 200 when any propstat succeeded, else the first failing
    /// propstat's code, else 200 (a response with no status at all).
    pub status: u16,
    pub display_name: Option<String>,
    /// `resourcetype` contains an `addressbook` element.
    pub is_addressbook: bool,
    /// `current-user-privilege-set` read: `None` when the server omitted
    /// privilege information; `Some(false)` when the set exists without a
    /// write privilege; `Some(true)` when write/write-content/all is
    /// granted.
    pub can_write: Option<bool>,
    pub ctag: Option<String>,
    pub etag: Option<String>,
    /// CARD: `address-data`: the raw, XML-unescaped vCard text.
    pub address_data: Option<String>,
    /// `current-user-principal`'s inner href.
    pub current_user_principal: Option<String>,
    /// CARDDAV `addressbook-home-set`'s inner href.
    pub addressbook_home_set: Option<String>,
    /// A `sync-token` found INSIDE a prop (the collections PROPFIND's
    /// supported-report advertisement).
    pub sync_token: Option<String>,
}

impl DavItem {
    /// True when the response represents a DELETED resource: the derived
    /// status is 404 (RFC 6578 §3.6 deletions; multiget misses).
    pub(crate) fn is_removed(&self) -> bool {
        self.status == 404
    }
}

/// A parsed multistatus body.
#[derive(Debug, Default, Clone)]
pub(crate) struct Multistatus {
    pub items: Vec<DavItem>,
    /// The `sync-token` that is a DIRECT child of `multistatus` (the
    /// cursor for the next incremental REPORT). `Some("")` when the
    /// report echoed an empty element.
    pub sync_token: Option<String>,
}

/// What the streaming pass is currently collecting.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Prop {
    /// A text-valued prop, by its local name.
    Text(&'static str),
    ResourceType,
    CurrentUserPrincipal,
    AddressbookHomeSet,
    /// `current-user-privilege-set`: watch for write privileges.
    PrivilegeSet,
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
            Prop::AddressbookHomeSet => "addressbook-home-set",
            Prop::PrivilegeSet => "current-user-privilege-set",
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
    /// For the href-carrying props: the inner `href` element is open, so
    /// Text events belong to the value.
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
    current: Option<DavItem>,
    /// Per-response propstat bookkeeping (successful-propstat-wins).
    saw_successful_propstat: bool,
    first_prop_error: Option<u16>,
    direct_status: Option<u16>,
}

impl Parser {
    fn begin_response(&mut self) {
        self.current = Some(DavItem::default());
        self.saw_successful_propstat = false;
        self.first_prop_error = None;
        self.direct_status = None;
    }

    /// Fold the per-response propstat bookkeeping into the item's
    /// effective status.
    fn finish_response(&mut self, mut item: DavItem) {
        item.status = if let Some(code) = self.direct_status {
            code
        } else if self.saw_successful_propstat {
            200
        } else {
            self.first_prop_error.unwrap_or(200)
        };
        item.href = item.href.trim().to_string();
        self.result.items.push(item);
    }

    fn handle_start(
        &mut self,
        name: &str,
        _attributes: Attributes<'_>,
    ) -> Result<(), CarddavError> {
        let local = local_name(name);
        if self.stack.len() >= MAX_DEPTH {
            return Err(CarddavError::Parse(
                "XML nesting limit exceeded".to_string(),
            ));
        }
        let capturing = self.capture.as_ref().map(|capture| capture.prop);
        let depth_before_push = self.stack.len();

        // Descendant detection inside an active capture.
        match capturing {
            Some(Prop::ResourceType) if local == "addressbook" => {
                self.mark_current_addressbook()?;
            }
            Some(Prop::CurrentUserPrincipal | Prop::AddressbookHomeSet) if local == "href" => {
                if let Some(capture) = self.capture.as_mut() {
                    capture.in_href = true;
                }
            }
            Some(Prop::PrivilegeSet)
                if matches!(local.as_str(), "write" | "write-content" | "all") =>
            {
                if let Some(item) = self.current.as_mut() {
                    item.can_write = Some(true);
                }
            }
            _ => {}
        }

        // Start a capture when a recognized element appears where we read
        // it.
        if self.capture.is_none() {
            let inside_prop = self.stack.last().map(String::as_str) == Some("prop");
            let new_capture = if inside_prop {
                match local.as_str() {
                    "displayname" => Some(Prop::Text("displayname")),
                    "getctag" => Some(Prop::Text("getctag")),
                    "getetag" => Some(Prop::Text("getetag")),
                    "address-data" => Some(Prop::Text("address-data")),
                    "sync-token" => Some(Prop::Text("sync-token")),
                    "resourcetype" => Some(Prop::ResourceType),
                    "current-user-principal" => Some(Prop::CurrentUserPrincipal),
                    "addressbook-home-set" => Some(Prop::AddressbookHomeSet),
                    "current-user-privilege-set" => {
                        // Presence of the privilege set without a write
                        // privilege means read-only (decided at capture
                        // end; the write* arm above can still upgrade it).
                        if let Some(item) = self.current.as_mut() {
                            item.can_write = Some(false);
                        }
                        Some(Prop::PrivilegeSet)
                    }
                    _ => None,
                }
            } else if local == "sync-token" && depth_before_push == 1 {
                // The report cursor: a direct child of multistatus.
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
            // WebDAV never nests responses; only start a NEW one at the
            // multistatus level.
            if self.stack.len() == 2 && self.stack[0] == "multistatus" {
                self.begin_response();
            }
        }
        Ok(())
    }

    fn handle_empty(&mut self, name: &str, _attributes: Attributes<'_>) -> Result<(), CarddavError> {
        let local = local_name(name);
        // Self-closing elements emit Empty and NO End event.
        match self.capture.as_ref().map(|capture| capture.prop) {
            Some(Prop::ResourceType) if local == "addressbook" => {
                self.mark_current_addressbook()?;
            }
            Some(Prop::PrivilegeSet)
                if matches!(local.as_str(), "write" | "write-content" | "all") =>
            {
                if let Some(item) = self.current.as_mut() {
                    item.can_write = Some(true);
                }
            }
            _ => {}
        }
        // An empty report-level sync-token (initial REPORT echoes can be
        // `<D:sync-token/>`): stored as Some("") — the caller treats an
        // empty cursor as "no token" and full-pulls.
        if self.capture.is_none() && local == "sync-token" && self.stack.len() == 1 {
            self.result.sync_token = Some(String::new());
        }
        Ok(())
    }

    fn handle_text(&mut self, text: &str) {
        if let Some(capture) = self.capture.as_mut() {
            // For href-carrying props only the inner href's text is the
            // value; for everything else all character data counts.
            let wants_text = match capture.prop {
                Prop::CurrentUserPrincipal | Prop::AddressbookHomeSet => capture.in_href,
                _ => true,
            };
            if wants_text {
                capture.text.push_str(text);
            }
            return;
        }
        if self.in_response_href {
            if let Some(item) = self.current.as_mut() {
                item.href.push_str(text);
            }
        }
        // Inter-element whitespace outside captures: skipped.
    }

    fn handle_end(&mut self, name: &str) {
        let local = local_name(name);

        if let Some(capture) = self.capture.take() {
            // The capture ends at the close of the element that started
            // it (the depth check is belt-and-braces for a pathological
            // same-named nest).
            if local == capture.prop.local() && capture.depth == self.stack.len() - 1 {
                self.finish_capture(capture);
            } else {
                self.capture = Some(capture);
            }
        }

        if local == "href" {
            self.in_response_href = false;
        }

        // A response element closed: derive its status and fold it in.
        if local == "response" && self.stack.len() == 2 && self.stack[0] == "multistatus" {
            if let Some(item) = self.current.take() {
                self.finish_response(item);
            }
        }

        self.stack.pop();
    }

    /// Called at the close of a PROPSTAT-level `status` capture (via
    /// [`Self::finish_capture`]).
    fn record_propstat_status(&mut self, code: u16) {
        if (200..300).contains(&code) {
            self.saw_successful_propstat = true;
            // Successful propstat wins: the first success clears any
            // recorded error (its props were merged live as they closed).
            // No further action needed — the item is already marked 200
            // unless a direct status overrides.
        } else if self.first_prop_error.is_none() {
            self.first_prop_error = Some(code);
        }
    }

    fn finish_capture(&mut self, capture: Capture) {
        let text = capture.text.trim().to_string();
        match capture.prop {
            Prop::Text("sync-token") => {
                if capture.depth == 1 {
                    // Report cursor (in-prop tokens land on the item).
                    self.result.sync_token = Some(text);
                } else if let Some(item) = self.current.as_mut() {
                    item.sync_token = Some(text);
                }
            }
            Prop::Text("displayname") => {
                if let Some(item) = self.current.as_mut() {
                    item.display_name = Some(text);
                }
            }
            Prop::Text("getctag") => {
                if let Some(item) = self.current.as_mut() {
                    item.ctag = Some(text);
                }
            }
            Prop::Text("getetag") => {
                if let Some(item) = self.current.as_mut() {
                    item.etag = Some(text);
                }
            }
            Prop::Text("address-data") => {
                // address-data keeps its interior text verbatim (only the
                // trim touches it): it is vCard, not XML text.
                if let Some(item) = self.current.as_mut() {
                    item.address_data = Some(text);
                }
            }
            Prop::Status(response_level) => {
                let code = parse_status_line(&text).unwrap_or(0);
                if response_level {
                    self.direct_status = Some(code);
                } else {
                    self.record_propstat_status(code);
                }
            }
            Prop::CurrentUserPrincipal => {
                if let Some(item) = self.current.as_mut() {
                    item.current_user_principal = Some(text);
                }
            }
            Prop::AddressbookHomeSet => {
                if let Some(item) = self.current.as_mut() {
                    item.addressbook_home_set = Some(text);
                }
            }
            // Structural props carry no text value of their own; the
            // privilege set's verdict was recorded on entry/upgrade.
            // Untracked text props have nothing to store.
            Prop::ResourceType | Prop::PrivilegeSet | Prop::Text(_) => {}
        }
    }

    fn mark_current_addressbook(&mut self) -> Result<(), CarddavError> {
        match self.current.as_mut() {
            Some(item) => {
                item.is_addressbook = true;
                Ok(())
            }
            None => Err(CarddavError::Parse(
                "multistatus property outside a response".to_string(),
            )),
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

/// Parse a multistatus body. Malformed XML is a [`CarddavError::Parse`]
/// with a specific message (never the body itself); a 2xx body without
/// any multistatus element is a parse error too.
pub(crate) fn parse_multistatus(body: &str) -> Result<Multistatus, CarddavError> {
    let mut reader = Reader::from_str(body);
    let mut parser = Parser::default();

    loop {
        let event = match reader.read_event() {
            Ok(event) => event,
            Err(error) => {
                return Err(CarddavError::Parse(format!(
                    "malformed XML from the CardDAV server ({error})"
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
                    CarddavError::Parse(format!(
                        "malformed XML text from the CardDAV server ({error})"
                    ))
                })?;
                parser.handle_text(&decoded);
            }
            // quick-xml 0.42 splits entity references into their own
            // events (`&#13;` in address-data bodies); decode them into
            // the SAME capture the surrounding text feeds. Predefined
            // entities and character references pass, anything else is
            // a parse error (the whole-text unescape discipline of
            // earlier quick-xml versions).
            Event::GeneralRef(reference) => {
                let name = reference.into_inner();
                let decoded = match quick_xml::escape::resolve_predefined_entity(&name) {
                    Some(value) => value.to_string(),
                    None => quick_xml::escape::unescape(&format!("&{name};"))
                        .map_err(|error| {
                            CarddavError::Parse(format!(
                                "malformed XML text from the CardDAV server ({error})"
                            ))
                        })?
                        .into_owned(),
                };
                parser.handle_text(&decoded);
            }
            Event::End(end) => parser.handle_end(end.name().as_ref()),
            Event::Eof => break,
            // Comments, declarations, processing instructions, CDATA:
            // CardDAV props we read never arrive as CDATA sections.
            _ => {}
        }
        if parser.result.items.len() > MAX_ITEMS {
            return Err(CarddavError::Parse(
                "multistatus exceeded the item limit".to_string(),
            ));
        }
    }

    if !parser.saw_multistatus {
        return Err(CarddavError::Parse(
            "the response was not a WebDAV multistatus document".to_string(),
        ));
    }
    // quick-xml (0.42) does not report EOF with unclosed elements as an
    // error — a TRUNCATED response must not pass as a valid (empty)
    // report.
    if !parser.stack.is_empty() {
        return Err(CarddavError::Parse(
            "truncated XML from the CardDAV server (unclosed elements)".to_string(),
        ));
    }
    Ok(parser.result)
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_addressbook_collections_with_prefixes() {
        let body = r#"<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav" xmlns:cs="http://calendarserver.org/ns/">
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
  <D:response>
    <D:href>/dav/user/contacts/</D:href>
    <D:propstat>
      <D:prop>
        <D:resourcetype><D:collection/><C:addressbook/></D:resourcetype>
        <D:displayname>Contacts</D:displayname>
        <cs:getctag>CTAG-9</cs:getctag>
        <D:sync-token>urn:uuid:token-1</D:sync-token>
        <D:current-user-privilege-set>
          <D:privilege><D:read/><D:write-content/></D:privilege>
        </D:current-user-privilege-set>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>"#;
        let parsed = parse_multistatus(body).expect("fixture parses");
        assert_eq!(parsed.items.len(), 2);
        let principal = &parsed.items[0];
        assert_eq!(principal.href, "/dav/user/");
        assert!(!principal.is_addressbook);
        assert_eq!(
            principal.current_user_principal.as_deref(),
            Some("/dav/user/")
        );
        let book = &parsed.items[1];
        assert!(book.is_addressbook);
        assert_eq!(book.display_name.as_deref(), Some("Contacts"));
        assert_eq!(book.ctag.as_deref(), Some("CTAG-9"));
        assert_eq!(book.sync_token.as_deref(), Some("urn:uuid:token-1"));
        // write-content present → writable.
        assert_eq!(book.can_write, Some(true));
        assert_eq!(parsed.sync_token, None);
    }

    #[test]
    fn read_only_privileges_and_prefixless_forms_parse() {
        // Nextcloud-style prefixless elements; a read-only privilege set
        // (no write privilege inside).
        let body = r#"<multistatus xmlns="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
          <response>
            <href>/remote/contacts/</href>
            <propstat>
              <prop>
                <resourcetype><collection/><c:addressbook/></resourcetype>
                <displayname>Shared</displayname>
                <current-user-privilege-set><privilege><read/></privilege></current-user-privilege-set>
              </prop>
              <status>HTTP/1.1 200 OK</status>
            </propstat>
          </response>
        </multistatus>"#;
        let parsed = parse_multistatus(body).expect("parses");
        let item = &parsed.items[0];
        assert!(item.is_addressbook);
        assert_eq!(item.display_name.as_deref(), Some("Shared"));
        assert_eq!(item.can_write, Some(false));
        assert_eq!(item.status, 200);
    }

    #[test]
    fn successful_propstat_wins_over_failed_ones() {
        // getctag 404s (unsupported prop), the rest answers 200: the item
        // must count as 200 and keep the successful props.
        let body = r#"<D:multistatus xmlns:D="DAV:" xmlns:cs="http://calendarserver.org/ns/">
          <D:response>
            <D:href>/book/</D:href>
            <D:propstat>
              <D:prop><D:resourcetype><D:collection/><C:addressbook xmlns:C="urn:ietf:params:xml:ns:carddav"/></D:resourcetype><cs:getctag/></D:prop>
              <D:status>HTTP/1.1 404 Not Found</D:status>
            </D:propstat>
            <D:propstat>
              <D:prop><D:displayname>Book</D:displayname></D:prop>
              <D:status>HTTP/1.1 200 OK</D:status>
            </D:propstat>
          </D:response>
        </D:multistatus>"#;
        let parsed = parse_multistatus(body).expect("parses");
        let item = &parsed.items[0];
        assert_eq!(item.status, 200);
        assert_eq!(item.display_name.as_deref(), Some("Book"));
        assert!(item.ctag.is_none());
    }

    #[test]
    fn all_failed_propstats_surface_the_first_error_code() {
        let body = r#"<D:multistatus xmlns:D="DAV:">
          <D:response>
            <D:href>/book/</D:href>
            <D:propstat>
              <D:prop><D:displayname>x</D:displayname></D:prop>
              <D:status>HTTP/1.1 403 Forbidden</D:status>
            </D:propstat>
          </D:response>
        </D:multistatus>"#;
        let parsed = parse_multistatus(body).expect("parses");
        assert_eq!(parsed.items[0].status, 403);
    }

    #[test]
    fn response_level_status_wins_and_reports_deletions() {
        let body = r#"<D:multistatus xmlns:D="DAV:">
          <D:sync-token>tok-2</D:sync-token>
          <D:response>
            <D:href>/book/a.vcf</D:href>
            <D:status>HTTP/1.1 404 Not Found</D:status>
          </D:response>
        </D:multistatus>"#;
        let parsed = parse_multistatus(body).expect("parses");
        assert_eq!(parsed.sync_token.as_deref(), Some("tok-2"));
        assert!(parsed.items[0].is_removed());
    }

    #[test]
    fn multiget_items_carry_etag_and_address_data() {
        let body = r#"<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
          <D:response>
            <D:href>/book/a.vcf</D:href>
            <D:propstat>
              <D:prop>
                <D:getetag>"etag-a"</D:getetag>
                <C:address-data>BEGIN:VCARD&#13;&#10;VERSION:3.0&#13;&#10;END:VCARD</C:address-data>
              </D:prop>
              <D:status>HTTP/1.1 200 OK</D:status>
            </D:propstat>
          </D:response>
        </D:multistatus>"#;
        let parsed = parse_multistatus(body).expect("parses");
        let item = &parsed.items[0];
        assert_eq!(item.etag.as_deref(), Some("\"etag-a\""));
        // XML entities decode to real CRLFs inside address-data.
        assert_eq!(
            item.address_data.as_deref(),
            Some("BEGIN:VCARD\r\nVERSION:3.0\r\nEND:VCARD")
        );
    }

    #[test]
    fn empty_selfclosed_report_sync_token_is_an_empty_cursor() {
        let body = r#"<D:multistatus xmlns:D="DAV:"><D:sync-token/></D:multistatus>"#;
        let parsed = parse_multistatus(body).expect("parses");
        assert_eq!(parsed.sync_token, Some(String::new()));
    }

    #[test]
    fn addressbook_home_set_is_parsed_from_the_inner_href() {
        let body = r#"<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
          <D:response>
            <D:href>/dav/user/</D:href>
            <D:propstat>
              <D:prop>
                <C:addressbook-home-set><D:href>/dav/user/addresses/</D:href></C:addressbook-home-set>
              </D:prop>
              <D:status>HTTP/1.1 200 OK</D:status>
            </D:propstat>
          </D:response>
        </D:multistatus>"#;
        let parsed = parse_multistatus(body).expect("parses");
        assert_eq!(
            parsed.items[0].addressbook_home_set.as_deref(),
            Some("/dav/user/addresses/")
        );
    }

    #[test]
    fn malformed_and_truncated_xml_are_parse_errors() {
        let error = parse_multistatus("<D:multistatus><D:response>").unwrap_err();
        assert_eq!(error.kind(), "parse");
        assert!(parse_multistatus("definitely not xml").is_err());
        // A 2xx HTML error page is NOT a valid (empty) report.
        let error = parse_multistatus("<html><body>ok</body></html>").unwrap_err();
        assert!(error.to_string().contains("multistatus"), "{error}");
    }

    #[test]
    fn depth_and_item_caps_are_enforced() {
        // Nesting beyond MAX_DEPTH is rejected outright.
        let deep = format!("<D:multistatus xmlns:D=\"DAV:\">{}x{}", "<D:a>".repeat(MAX_DEPTH + 2), "</D:a>".repeat(MAX_DEPTH + 2));
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
