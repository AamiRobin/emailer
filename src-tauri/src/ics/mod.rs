//! iCalendar (RFC 5545 / iTIP RFC 5546) parse + build (parity-round-3
//! task 8.1, design D5).
//!
//! The `ics/` module is the Rust-side PURE half of meeting RSVP: it parses
//! `text/calendar` payloads (METHOD:REQUEST / REPLY / CANCEL at the
//! VCALENDAR level) into typed structs and builds the METHOD:REPLY blob an
//! attendee's answer mail carries. It never touches the app database —
//! every SQL statement stays frontend-side (the DB-stack rule); the
//! `ics_*` commands are pure JSON-in/JSON-out functions over strings.
//!
//! Dependency note (task wording: "quick-xml — verify it's already a
//! dep"): quick-xml IS already in the tree (CalDAV's multistatus XML).
//! iCalendar itself is NOT XML — RFC 5545 defines a line-based text
//! grammar (unfolded content lines `NAME;PARAM=..:value`), which an XML
//! pull parser cannot express — so the parser here is the same hand-rolled
//! line walker the frontend `ics.ts` (task 5.5) uses, kept in lockstep.
//! No new dependency was added.
//!
//! Supported subset (mirrors `src/services/calendar/ics.ts`):
//! - Line unfolding (§3.1), BOM strip, CRLF/LF/CR line breaks.
//! - Quote-aware colon splitting, property parameters, TEXT unescaping
//!   (§3.3.11: `\\n` `\\N` `\\,` `\\;` `\\\\`).
//! - VCALENDAR: VERSION, PRODID, METHOD. VEVENT: UID, SEQUENCE,
//!   RECURRENCE-ID, DTSTART, DTEND, SUMMARY, LOCATION, DESCRIPTION,
//!   STATUS, ORGANIZER, ATTENDEE (CN / PARTSTAT params). VALARM,
//!   VTIMEZONE and unknown components/properties are skipped gracefully —
//!   VALARM DESCRIPTIONs never leak into the event.
//! - DATE (`YYYYMMDD`) and DATE-TIME (`YYYYMMDDTHHMMSS[Z]`) values; a
//!   TZID parameter is kept verbatim (no zone database is consulted, the
//!   documented v1 limitation the TS parser shares) while UTC and
//!   floating values resolve to epoch seconds.
//!
//! Malformed input never panics: the parse returns a typed
//! [`IcsParseError`] (empty input / no VCALENDAR) and per-property
//! problems degrade to skipped fields, exactly like the TS parser.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Types (the serde shapes the `ics_*` commands exchange with the webview)
// ---------------------------------------------------------------------------

/// An ORGANIZER/ATTENDEE person (mailto: value + CN/PARTSTAT params).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IcsPerson {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partstat: Option<String>,
}

/// One DATE/DATE-TIME value: raw form kept alongside the resolved instant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IcsDateTime {
    /// The value exactly as written ("20260918T140000Z", "20260918").
    pub raw: String,
    /// All-day VALUE=DATE form.
    pub all_day: bool,
    /// DATE-TIME carried the UTC designator "Z".
    pub utc: bool,
    /// TZID parameter when present (kept verbatim — no zone resolution).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tzid: Option<String>,
    /// Resolved epoch seconds (UTC values and floating/DATE values —
    /// the latter two as the wall-clock-as-UTC reading the TS parser
    /// documents); null when the value could not be parsed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub epoch_seconds: Option<i64>,
}

/// One parsed VEVENT.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IcsEvent {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uid: Option<String>,
    /// SEQUENCE property (iCloud/Outlook invitations carry it; the RSVP
    /// REPLY must echo the invite's sequence).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence: Option<i64>,
    /// RECURRENCE-ID of the addressed occurrence (None = whole series).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence_id: Option<IcsDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dt_start: Option<IcsDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dt_end: Option<IcsDateTime>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// STATUS uppercased (CONFIRMED / TENTATIVE / CANCELLED).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organizer: Option<IcsPerson>,
    pub attendees: Vec<IcsPerson>,
}

/// The parsed VCALENDAR.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct IcsCalendar {
    /// VERSION property.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// PRODID property.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prodid: Option<String>,
    /// METHOD uppercased — REQUEST / REPLY / CANCEL / PUBLISH / ….
    #[serde(skip_serializing_if = "Option::is_none")]
    pub method: Option<String>,
    pub events: Vec<IcsEvent>,
}

/// Why parsing failed (typed — the caller renders the message; no panic).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct IcsParseError {
    /// "empty" | "not-icalendar"
    pub reason: String,
    pub message: String,
}

// ---------------------------------------------------------------------------
// Line-level helpers (RFC 5545 §3.1 unfolding + property splitting)
// ---------------------------------------------------------------------------

/// Unfold content lines (RFC 5545 §3.1): a line starting with SPACE/TAB
/// continues the previous one (the single leading whitespace character is
/// removed). Tolerates LF and lone-CR in addition to CRLF (a CRLF pair is
/// ONE break, not two), and strips a UTF-8 BOM. Owned lines, since
/// continuation lines append in place.
fn unfold(text: &str) -> Vec<String> {
    let without_bom = text.strip_prefix('\u{feff}').unwrap_or(text);
    let mut unfolded: Vec<String> = Vec::new();
    for raw_line in without_bom
        .split("\r\n")
        .flat_map(|line| line.split('\n'))
        .flat_map(|line| line.split('\r'))
    {
        if (raw_line.starts_with(' ') || raw_line.starts_with('\t')) && !unfolded.is_empty() {
            unfolded
                .last_mut()
                .expect("non-empty above")
                .push_str(&raw_line[1..]);
            continue;
        }
        unfolded.push(raw_line.to_string());
    }
    unfolded
}

/// Split on `separator`, ignoring separators inside double quotes.
fn split_unquoted(text: &str, separator: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;
    for character in text.chars() {
        if character == '"' {
            in_quotes = !in_quotes;
            current.push(character);
        } else if character == separator && !in_quotes {
            parts.push(std::mem::take(&mut current));
        } else {
            current.push(character);
        }
    }
    parts.push(current);
    parts
}

/// Unescape iCalendar TEXT (§3.3.11): `\n`/`\N` → newline, `\,` `\;`
/// `\\` → themselves; unknown escapes keep the escaped character; a
/// trailing lone backslash survives as-is.
pub(crate) fn unescape_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut characters = value.chars().peekable();
    while let Some(character) = characters.next() {
        if character != '\\' {
            out.push(character);
            continue;
        }
        match characters.next() {
            None => out.push('\\'), // trailing lone backslash: keep as-is
            Some('n') | Some('N') => out.push('\n'),
            Some(escaped) => out.push(escaped),
        }
    }
    out
}

/// Escape iCalendar TEXT (the build direction of [`unescape_text`]).
pub(crate) fn escape_text(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\n' | '\r' => out.push_str("\\n"),
            other => out.push(other),
        }
    }
    out
}

/// One parsed content line: uppercased name, uppercased param keys.
struct ContentLine {
    name: String,
    params: Vec<(String, String)>,
    value: String,
}

/// Parse one content line into name + params + value. The name/value
/// split happens at the first colon OUTSIDE double quotes (URL and
/// DESCRIPTION values contain colons). None for lines without one.
fn parse_content_line(line: &str) -> Option<ContentLine> {
    let bytes = line.as_bytes();
    let mut in_quotes = false;
    let mut colon_index: Option<usize> = None;
    for (index, byte) in bytes.iter().enumerate() {
        match byte {
            b'"' => in_quotes = !in_quotes,
            b':' if !in_quotes => {
                colon_index = Some(index);
                break;
            }
            _ => {}
        }
    }
    let colon_index = colon_index?;
    let name_and_params = &line[..colon_index];
    let value = &line[colon_index + 1..];

    let mut segments = split_unquoted(name_and_params, ';');
    let name = segments.remove(0).trim().to_ascii_uppercase();
    if name.is_empty() {
        return None;
    }
    let mut params = Vec::new();
    for segment in segments {
        let mut parts = segment.splitn(2, '=');
        let key = parts.next().unwrap_or("").trim().to_ascii_uppercase();
        let raw_value = parts.next().unwrap_or("").trim();
        if key.is_empty() {
            continue;
        }
        let unquoted = raw_value
            .strip_prefix('"')
            .and_then(|rest| rest.strip_suffix('"'))
            .unwrap_or(raw_value);
        params.push((key, unescape_text(unquoted)));
    }
    Some(ContentLine {
        name,
        params,
        value: value.to_string(),
    })
}

impl ContentLine {
    fn param(&self, key: &str) -> Option<&str> {
        self.params
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.as_str())
    }
}

// ---------------------------------------------------------------------------
// Date values
// ---------------------------------------------------------------------------

/// `YYYYMMDD` → (y, m, d) or None.
fn parse_date_parts(raw: &str) -> Option<(i32, u32, u32)> {
    if raw.len() != 8 || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let year: i32 = raw[0..4].parse().ok()?;
    let month: u32 = raw[4..6].parse().ok()?;
    let day: u32 = raw[6..8].parse().ok()?;
    Some((year, month, day))
}

/// Strict days-in-month (no rollover — Feb 30 / month 13 are rejected).
fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 {
                29
            } else {
                28
            }
        }
        _ => 0,
    }
}

/// Days since the Unix epoch for a civil date (Howard Hinnant's
/// `days_from_civil`), valid over the whole i32 year range.
fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year_adjusted = if month <= 2 { year - 1 } else { year };
    let era = if year_adjusted >= 0 {
        year_adjusted / 400
    } else {
        (year_adjusted - 399) / 400
    };
    let year_of_era = year_adjusted - era * 400;
    let month_shifted = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * i64::from(month_shifted) + 2) / 5 + i64::from(day) - 1;
    let day_of_era = i64::from(year_of_era) * 365 + i64::from(year_of_era / 4)
        - i64::from(year_of_era / 100)
        + day_of_year;
    i64::from(era) * 146_097 + day_of_era - 719_468
}

/// Build a DATE-TIME [`IcsDateTime`] with strict calendar validation
/// (impossible values → None, never a silent rollover).
fn parse_date_time(raw: &str, tzid: Option<&str>) -> Option<IcsDateTime> {
    if let Some((year, month, day)) = parse_date_parts(raw) {
        if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
            return None;
        }
        let epoch = days_from_civil(year, month, day) * 86_400;
        return Some(IcsDateTime {
            raw: raw.to_string(),
            all_day: true,
            utc: false,
            tzid: None,
            epoch_seconds: Some(epoch),
        });
    }

    // DATE-TIME: YYYYMMDDTHHMMSS with optional trailing Z.
    let (stamp, zulu) = match raw.strip_suffix('Z') {
        Some(stamp) => (stamp, true),
        None => (raw, false),
    };
    if stamp.len() != 15 || stamp.as_bytes()[8] != b'T' {
        return None;
    }
    let date = &stamp[0..8];
    let time = &stamp[9..];
    if !time.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (year, month, day) = parse_date_parts(date)?;
    let hour: i64 = time[0..2].parse().ok()?;
    let minute: i64 = time[2..4].parse().ok()?;
    let second: i64 = time[4..6].parse().ok()?;
    if !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    let epoch = days_from_civil(year, month, day) * 86_400 + hour * 3_600 + minute * 60 + second;
    Some(IcsDateTime {
        raw: raw.to_string(),
        all_day: false,
        utc: zulu,
        tzid: if zulu { None } else { tzid.map(str::to_string) },
        epoch_seconds: Some(epoch),
    })
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/// Parse an ORGANIZER/ATTENDEE value + params into an [`IcsPerson`].
fn parse_person(line: &ContentLine) -> IcsPerson {
    let value = line.value.trim();
    let email = value
        .strip_prefix("mailto:")
        .or_else(|| value.strip_prefix("MAILTO:"))
        .map(str::to_string)
        .or_else(|| {
            // Bare address form (non-conformant but seen in the wild).
            let is_bare = !value.is_empty()
                && value.contains('@')
                && !value.contains(' ')
                && !value.contains(':');
            is_bare.then(|| value.to_string())
        });
    IcsPerson {
        name: line.param("CN").map(str::to_string),
        email,
        partstat: line.param("PARTSTAT").map(|p| p.to_ascii_uppercase()),
    }
}

/// Parse a full iCalendar document. Never panics; malformed input answers
/// a typed [`IcsParseError`] and per-line problems are skipped.
pub fn parse_calendar(text: &str) -> Result<IcsCalendar, IcsParseError> {
    if text.trim().is_empty() {
        return Err(IcsParseError {
            reason: "empty".to_string(),
            message: "The attachment contains no iCalendar content.".to_string(),
        });
    }

    let mut calendar = IcsCalendar::default();
    let mut stack: Vec<String> = Vec::new();
    let mut saw_vcalendar = false;
    let mut current_event: Option<IcsEvent> = None;

    for line in unfold(text) {
        let parsed = match parse_content_line(&line) {
            Some(parsed) => parsed,
            None => continue,
        };
        match parsed.name.as_str() {
            "BEGIN" => {
                let component = parsed.value.trim().to_ascii_uppercase();
                if component == "VCALENDAR" {
                    saw_vcalendar = true;
                }
                if component == "VEVENT"
                    && stack.last().map(String::as_str) == Some("VCALENDAR")
                {
                    current_event = Some(IcsEvent::default());
                }
                stack.push(component);
            }
            "END" => {
                let component = parsed.value.trim().to_ascii_uppercase();
                while let Some(popped) = stack.pop() {
                    if popped == component {
                        break;
                    }
                }
                if component == "VEVENT" {
                    if let Some(event) = current_event.take() {
                        calendar.events.push(event);
                    }
                }
            }
            _ => {
                // Attribute the property to its innermost component only;
                // everything outside VCALENDAR/VEVENT (VTIMEZONE, VALARM,
                // unknown components) is skipped with its properties.
                let top = stack.last().map(String::as_str);
                match (top, current_event.as_mut()) {
                    (Some("VCALENDAR"), _) if stack.len() == 1 => match parsed.name.as_str() {
                        "VERSION" => calendar.version = non_empty(&parsed.value),
                        "PRODID" => calendar.prodid = non_empty(&parsed.value),
                        "METHOD" => {
                            calendar.method = non_empty(&parsed.value)
                                .map(|value| value.to_ascii_uppercase())
                        }
                        _ => {}
                    },
                    (Some("VEVENT"), Some(event)) => {
                        apply_event_property(event, &parsed);
                    }
                    _ => {}
                }
            }
        }
    }

    if !saw_vcalendar {
        return Err(IcsParseError {
            reason: "not-icalendar".to_string(),
            message: "The attachment does not look like an iCalendar (.ics) \
                      file — no VCALENDAR block was found."
                .to_string(),
        });
    }
    Ok(calendar)
}

fn non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn text_value(line: &ContentLine) -> Option<String> {
    non_empty(&unescape_text(&line.value))
}

/// Apply one VEVENT property to the accumulating event (skips everything
/// the subset does not model — RRULE, EXDATE, X- properties, …).
fn apply_event_property(event: &mut IcsEvent, line: &ContentLine) {
    match line.name.as_str() {
        "UID" => event.uid = non_empty(&line.value),
        "SEQUENCE" => {
            event.sequence = line.value.trim().parse::<i64>().ok();
        }
        "RECURRENCE-ID" => {
            event.recurrence_id =
                parse_date_time(line.value.trim(), line.param("TZID"));
        }
        "DTSTART" => event.dt_start = parse_date_time(line.value.trim(), line.param("TZID")),
        "DTEND" => event.dt_end = parse_date_time(line.value.trim(), line.param("TZID")),
        "SUMMARY" => event.summary = text_value(line),
        "LOCATION" => event.location = text_value(line),
        "DESCRIPTION" => event.description = text_value(line),
        "STATUS" => event.status = non_empty(&line.value).map(|v| v.to_ascii_uppercase()),
        "ORGANIZER" => event.organizer = Some(parse_person(line)),
        "ATTENDEE" => event.attendees.push(parse_person(line)),
        _ => {}
    }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/// The PRODID every built blob carries (same string as the TS
/// `buildEventIcal` writer — one product identity across surfaces).
pub const PRODID: &str = "-//emailer//Calendar 1.0//EN";

/// One ATTENDEE/ORGANIZER the REPLY build needs.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IcsPersonInput {
    pub email: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// The REPLY build request (the `ics_build_reply` command's input).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IcsReplyRequest {
    /// The meeting's iCalendar UID (echoed verbatim).
    pub uid: String,
    /// SEQUENCE echoed from the invitation when known (iTIP §3.2.4: a
    /// REPLY carries the sequence of the object it replies to).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sequence: Option<i64>,
    /// RECURRENCE-ID when the answer scopes to ONE occurrence of a
    /// recurring meeting (absent = whole series).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recurrence_id: Option<String>,
    /// The meeting start echoed when known (organizer servers use it to
    /// locate the object; mirrors what real clients send).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dt_start: Option<String>,
    /// The organizer (the mail goes to this person; CN kept when known —
    /// the "respect organizer CN" requirement, the minimal
    /// CALENDARSERVER-organizer form `ORGANIZER;CN=..:mailto:..`).
    pub organizer: Option<IcsPersonInput>,
    /// THE RESPONDING ATTENDEE (this user) and their PARTSTAT answer —
    /// an iTIP REPLY carries exactly one ATTENDEE: the replier.
    pub attendee: IcsPersonInput,
    /// Uppercase PARTSTAT: ACCEPTED / TENTATIVE / DECLINED / NEEDS-ACTION.
    pub partstat: String,
    /// Echoed SUMMARY (subject line) when known.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

/// Validate a PARTSTAT against the RFC 5545 grammar's participation
/// statuses (the command boundary rejects garbage before it ships).
fn valid_partstat(partstat: &str) -> bool {
    matches!(
        partstat,
        "ACCEPTED" | "DECLINED" | "TENTATIVE" | "NEEDS-ACTION" | "DELEGATED"
    )
}

/// Build the METHOD:REPLY VCALENDAR an attendee's answer mail carries
/// (RFC 5546 §3.2.3): CRLF lines, fixed property order, TEXT escaping,
/// exactly one ATTENDEE (the replier) with the updated PARTSTAT, and the
/// organizer echoed WITH its CN when known. RECURRENCE-ID rides along
/// when the user answered a single occurrence of a recurring meeting.
///
/// The output is byte-stable: the frontend test suite pins it against the
/// TS fallback builder (`src/services/calendar/ics-reply.ts`) via the
/// shared fixture in `ics-reply.test.ts`.
pub fn build_reply(request: &IcsReplyRequest) -> Result<String, String> {
    let uid = request.uid.trim();
    if uid.is_empty() {
        return Err("a meeting UID is required to build a REPLY".to_string());
    }
    let partstat = request.partstat.trim().to_ascii_uppercase();
    if !valid_partstat(&partstat) {
        return Err(format!("not a valid PARTSTAT value: {partstat}"));
    }
    let attendee_email = request.attendee.email.trim();
    if attendee_email.is_empty() {
        return Err("the answering attendee's email is required".to_string());
    }

    let mut lines: Vec<String> = vec![
        "BEGIN:VCALENDAR".to_string(),
        "VERSION:2.0".to_string(),
        format!("PRODID:{PRODID}"),
        "METHOD:REPLY".to_string(),
        "BEGIN:VEVENT".to_string(),
        format!("UID:{}", escape_text(uid)),
    ];
    if let Some(sequence) = request.sequence {
        lines.push(format!("SEQUENCE:{sequence}"));
    }
    if let Some(recurrence_id) = request.recurrence_id.as_deref() {
        let recurrence_id = recurrence_id.trim();
        if !recurrence_id.is_empty() {
            lines.push(format!("RECURRENCE-ID:{}", escape_text(recurrence_id)));
        }
    }
    if let Some(dt_start) = request.dt_start.as_deref() {
        let dt_start = dt_start.trim();
        if !dt_start.is_empty() {
            lines.push(format!("DTSTART:{}", escape_text(dt_start)));
        }
    }
    if let Some(organizer) = &request.organizer {
        let email = organizer.email.trim();
        if !email.is_empty() {
            let cn = match organizer.name.as_deref().map(str::trim) {
                Some(name) if !name.is_empty() => format!(";CN={}", escape_text(name)),
                _ => String::new(),
            };
            lines.push(format!("ORGANIZER{cn}:mailto:{}", escape_text(email)));
        }
    }
    let attendee_cn = match request.attendee.name.as_deref().map(str::trim) {
        Some(name) if !name.is_empty() => format!(";CN={}", escape_text(name)),
        _ => String::new(),
    };
    lines.push(format!(
        "ATTENDEE{attendee_cn};PARTSTAT={partstat}:mailto:{}",
        escape_text(attendee_email)
    ));
    if let Some(summary) = request.summary.as_deref() {
        let summary = summary.trim();
        if !summary.is_empty() {
            lines.push(format!("SUMMARY:{}", escape_text(summary)));
        }
    }
    lines.push("END:VEVENT".to_string());
    lines.push("END:VCALENDAR".to_string());
    // RFC 5545 §3.4: the object ends with CRLF.
    let mut blob = lines.join("\r\n");
    blob.push_str("\r\n");
    Ok(blob)
}

/// Build a METHOD:CANCEL VCALENDAR (the organizer's cancellation notice
/// shape — a test helper mirroring what Outlook/Google emit, so the
/// cancellation-handling tests can round-trip a realistic payload): the
/// REPLY's envelope with METHOD:CANCEL, STATUS:CANCELLED on the VEVENT
/// (the iTIP cancellation marker receivers key on), and no ATTENDEE
/// answer line. Test-only by design (task 8.1: "CANCEL/REQUEST build
/// helpers for tests") — production parses the organizer's real payload.
#[cfg(test)]
pub fn build_cancel(request: &IcsReplyRequest) -> Result<String, String> {
    let cancel_request = IcsReplyRequest {
        partstat: "NEEDS-ACTION".to_string(),
        ..request.clone()
    };
    let mut blob = build_reply(&cancel_request)?;
    blob = blob.replace("METHOD:REPLY", "METHOD:CANCEL");
    blob = blob.replace("END:VEVENT", "STATUS:CANCELLED\r\nEND:VEVENT");
    let without_attendees = blob
        .lines()
        .filter(|line| !line.starts_with("ATTENDEE"))
        .collect::<Vec<_>>()
        .join("\r\n");
    let mut blob = without_attendees;
    blob.push_str("\r\n");
    Ok(blob)
}

/// Build a minimal METHOD:REQUEST VCALENDAR (an invitation fixture
/// builder for the round-trip tests: the same fields the REPLY echoes).
/// Test-only — see [`build_cancel`].
#[cfg(test)]
pub fn build_request(request: &IcsReplyRequest, event: &IcsEvent) -> Result<String, String> {
    let mut blob = build_reply(request)?;
    blob = blob.replace("METHOD:REPLY", "METHOD:REQUEST");
    // Re-add the invitation's extra properties before END:VEVENT.
    let mut extras = String::new();
    if let Some(end) = &event.dt_end {
        extras.push_str(&format!("DTEND:{}\r\n", end.raw));
    }
    if let Some(summary) = &event.summary {
        extras.push_str(&format!("SUMMARY:{}\r\n", escape_text(summary)));
    }
    if let Some(location) = &event.location {
        extras.push_str(&format!("LOCATION:{}\r\n", escape_text(location)));
    }
    for attendee in &event.attendees {
        let email = attendee.email.clone().unwrap_or_default();
        // The answering attendee already rides the base blob's ATTENDEE
        // line — the invitation's list adds everyone ELSE (no duplicates).
        if request.attendee.email.trim().eq_ignore_ascii_case(email.trim()) {
            continue;
        }
        let partstat = attendee
            .partstat
            .clone()
            .unwrap_or_else(|| "NEEDS-ACTION".to_string());
        extras.push_str(&format!(
            "ATTENDEE;PARTSTAT={partstat}:mailto:{email}\r\n"
        ));
    }
    blob = blob.replace("END:VEVENT", &format!("{extras}END:VEVENT"));
    Ok(blob)
}

// ---------------------------------------------------------------------------
// Commands (pure — no SQL, no I/O; the webview calls these for the
// canonical parse/build, keeping Rust the single ics grammar authority)
// ---------------------------------------------------------------------------

/// Parse a `text/calendar` payload into the typed calendar (pure).
#[tauri::command]
pub fn ics_parse_calendar(text: String) -> Result<IcsCalendar, IcsParseError> {
    parse_calendar(&text)
}

/// Build the METHOD:REPLY blob for an attendee's answer (pure).
#[tauri::command]
pub fn ics_build_reply(request: IcsReplyRequest) -> Result<String, String> {
    build_reply(&request)
}

// ---------------------------------------------------------------------------
// Tests — round-trip over inline fixtures: a Google-generated invite, an
// Outlook/Graph-style invite, and a minimal hand-written one (no new
// dev-deps; the Rust-built REPLY output is the fixture the TS side pins).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Google Calendar-generated invitation (the shape `event.ics` from
    /// a real Google invite carries: UID with the @google.com suffix,
    /// SEQUENCE, extended params on ATTENDEE, X- properties, VALARM).
    /// Written as one element per PHYSICAL line (folded ATTENDEE lines
    /// keep their leading fold space) — a backslash-continued string
    /// literal would strip that space.
    fn google_invite() -> String {
        [
            "BEGIN:VCALENDAR",
            "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
            "VERSION:2.0",
            "CALSCALE:GREGORIAN",
            "METHOD:REQUEST",
            "BEGIN:VEVENT",
            "DTSTART:20260918T140000Z",
            "DTEND:20260918T150000Z",
            "DTSTAMP:20260901T120000Z",
            "ORGANIZER;CN=Alice Organizer:mailto:alice@organizer.example",
            "UID:9kq3lmiqg9v1s0h3t6q8g9v1s0@google.com",
            "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=",
            " TRUE;CN=Bob Attendee;X-NUM-GUESTS=0:mailto:bob@attendee.example",
            "ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRU",
            " E;CN=Alice Organizer;X-NUM-GUESTS=0:mailto:alice@organizer.example",
            "CREATED:20260830T090000Z",
            "DESCRIPTION:Quarterly sync\\nJoin: https://zoom.us/j/1234567890",
            "LAST-MODIFIED:20260901T115959Z",
            "LOCATION:Room 4",
            "SEQUENCE:1",
            "STATUS:CONFIRMED",
            "SUMMARY:Quarterly sync",
            "TRANSP:OPAQUE",
            "END:VEVENT",
            "END:VCALENDAR",
            "",
        ]
        .join("\r\n")
    }

    /// Outlook / Microsoft Graph-style invitation (EXCHANGE PRODID, TZID
    /// parameters, URN uid, RECURRENCE-ID for a single occurrence).
    fn outlook_occurrence_invite() -> String {
        [
            "BEGIN:VCALENDAR",
            "PRODID:-//Microsoft Corporation//Outlook 16.0 MIMEDIR//EN",
            "VERSION:2.0",
            "METHOD:REQUEST",
            "BEGIN:VEVENT",
            "ATTENDEE;CN=Bob Attendee;RSVP=TRUE:mailto:bob@attendee.example",
            "CLASS:PUBLIC",
            "CREATED:20260901T090000Z",
            "DTSTART;TZID=W. Europe Standard Time:20260921T100000",
            "DTEND;TZID=W. Europe Standard Time:20260921T110000",
            "RECURRENCE-ID;TZID=W. Europe Standard Time:20260914T100000",
            "UID:040000008200E00074C5B7101A82E00800000000A0B1C2D3E4F5060708@outlook.com",
            "ORGANIZER;CN=\"Alice Organizer\":MAILTO:alice@organizer.example",
            "SEQUENCE:2",
            "SUMMARY:Weekly standup (moved)",
            "LOCATION:https://teams.microsoft.com/l/meetup-join/abc123",
            "STATUS:CONFIRMED",
            "END:VEVENT",
            "END:VCALENDAR",
            "",
        ]
        .join("\r\n")
    }

    /// Minimal hand-written invitation (the smallest valid REQUEST).
    fn minimal_invite() -> String {
        [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "PRODID:-//emailer//test//EN",
            "METHOD:REQUEST",
            "BEGIN:VEVENT",
            "UID:minimal@example.com",
            "DTSTART:20261001T090000Z",
            "DTEND:20261001T100000Z",
            "SUMMARY:Minimal",
            "END:VEVENT",
            "END:VCALENDAR",
            "",
        ]
        .join("\r\n")
    }

    fn reply_request(uid: &str) -> IcsReplyRequest {
        IcsReplyRequest {
            uid: uid.to_string(),
            sequence: Some(1),
            recurrence_id: None,
            dt_start: Some("20260918T140000Z".to_string()),
            organizer: Some(IcsPersonInput {
                email: "alice@organizer.example".to_string(),
                name: Some("Alice Organizer".to_string()),
            }),
            attendee: IcsPersonInput {
                email: "bob@attendee.example".to_string(),
                name: Some("Bob Attendee".to_string()),
            },
            partstat: "ACCEPTED".to_string(),
            summary: Some("Quarterly sync".to_string()),
        }
    }

    /// THE canonical REPLY fixture — byte-identical to the TS fallback's
    /// expected output (`src/services/calendar/ics-reply.ts` test), so
    /// both builders ship the same wire format (task 8.3's "REPLY mail
    /// fixture comparison against the Rust-built ics").
    const CANONICAL_REPLY: &str = "BEGIN:VCALENDAR\r\n\
VERSION:2.0\r\n\
PRODID:-//emailer//Calendar 1.0//EN\r\n\
METHOD:REPLY\r\n\
BEGIN:VEVENT\r\n\
UID:9kq3lmiqg9v1s0h3t6q8g9v1s0@google.com\r\n\
SEQUENCE:1\r\n\
DTSTART:20260918T140000Z\r\n\
ORGANIZER;CN=Alice Organizer:mailto:alice@organizer.example\r\n\
ATTENDEE;CN=Bob Attendee;PARTSTAT=ACCEPTED:mailto:bob@attendee.example\r\n\
SUMMARY:Quarterly sync\r\n\
END:VEVENT\r\n\
END:VCALENDAR\r\n";

    #[test]
    fn parses_the_google_invite() {
        let calendar = parse_calendar(&google_invite()).expect("parses");
        assert_eq!(calendar.method.as_deref(), Some("REQUEST"));
        assert_eq!(
            calendar.prodid.as_deref(),
            Some("-//Google Inc//Google Calendar 70.9054//EN")
        );
        assert_eq!(calendar.events.len(), 1);
        let event = &calendar.events[0];
        assert_eq!(
            event.uid.as_deref(),
            Some("9kq3lmiqg9v1s0h3t6q8g9v1s0@google.com")
        );
        assert_eq!(event.sequence, Some(1));
        assert_eq!(event.summary.as_deref(), Some("Quarterly sync"));
        assert_eq!(event.location.as_deref(), Some("Room 4"));
        // DESCRIPTION unfolds across its continuation line and unescapes
        // the literal newline.
        assert_eq!(
            event.description.as_deref(),
            Some("Quarterly sync\nJoin: https://zoom.us/j/1234567890")
        );
        assert_eq!(event.status.as_deref(), Some("CONFIRMED"));
        // UTC DTSTART/DTEND resolve to exact instants.
        let start = event.dt_start.as_ref().expect("dtstart");
        assert!(start.utc && !start.all_day);
        assert_eq!(start.epoch_seconds, Some(1_789_740_000)); // 2026-09-18T14:00:00Z
        assert_eq!(event.dt_end.as_ref().and_then(|d| d.epoch_seconds), Some(1_789_743_600));
        // Organizer with CN; the folded multi-attendee list is complete.
        let organizer = event.organizer.as_ref().expect("organizer");
        assert_eq!(organizer.email.as_deref(), Some("alice@organizer.example"));
        assert_eq!(organizer.name.as_deref(), Some("Alice Organizer"));
        assert_eq!(event.attendees.len(), 2);
        assert_eq!(event.attendees[0].email.as_deref(), Some("bob@attendee.example"));
        assert_eq!(event.attendees[0].partstat.as_deref(), Some("NEEDS-ACTION"));
        assert_eq!(event.attendees[1].partstat.as_deref(), Some("ACCEPTED"));
    }

    #[test]
    fn parses_the_outlook_occurrence_invite() {
        let calendar = parse_calendar(&outlook_occurrence_invite()).expect("parses");
        assert_eq!(calendar.method.as_deref(), Some("REQUEST"));
        let event = &calendar.events[0];
        assert_eq!(event.sequence, Some(2));
        // RECURRENCE-ID parsed with its TZID kept verbatim (wall-clock
        // reading — the documented v1 limitation shared with ics.ts).
        let recurrence_id = event.recurrence_id.as_ref().expect("recurrence-id");
        assert_eq!(recurrence_id.raw, "20260914T100000");
        assert_eq!(
            recurrence_id.tzid.as_deref(),
            Some("W. Europe Standard Time")
        );
        assert!(!recurrence_id.utc);
        // Floating/TZID DATE-TIMEs still resolve (wall-clock-as-UTC).
        assert!(event.dt_start.as_ref().and_then(|d| d.epoch_seconds).is_some());
        // Quoted CN parameter on ORGANIZER ("Alice Organizer" in quotes).
        let organizer = event.organizer.as_ref().expect("organizer");
        assert_eq!(organizer.name.as_deref(), Some("Alice Organizer"));
        // Case-insensitive MAILTO: scheme prefix.
        assert_eq!(organizer.email.as_deref(), Some("alice@organizer.example"));
    }

    #[test]
    fn parses_the_minimal_invite() {
        let calendar = parse_calendar(&minimal_invite()).expect("parses");
        assert_eq!(calendar.method.as_deref(), Some("REQUEST"));
        assert_eq!(calendar.events.len(), 1);
        let event = &calendar.events[0];
        assert_eq!(event.uid.as_deref(), Some("minimal@example.com"));
        assert_eq!(event.sequence, None);
        assert_eq!(event.recurrence_id, None);
        assert_eq!(event.summary.as_deref(), Some("Minimal"));
        assert!(event.organizer.is_none());
        assert!(event.attendees.is_empty());
    }

    #[test]
    fn skips_valarm_and_vtimezone_without_leaking_properties() {
        let text = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "METHOD:REQUEST",
            "BEGIN:VTIMEZONE",
            "TZID:Europe/Berlin",
            "BEGIN:STANDARD",
            "DTSTART:19701025T030000",
            "END:STANDARD",
            "END:VTIMEZONE",
            "BEGIN:VEVENT",
            "UID:alarms@example.com",
            "SUMMARY:With alarms",
            "BEGIN:VALARM",
            "ACTION:DISPLAY",
            "DESCRIPTION:Reminder — must not leak",
            "TRIGGER:-PT10M",
            "END:VALARM",
            "END:VEVENT",
            "END:VCALENDAR",
            "",
        ]
        .join("\r\n");
        let calendar = parse_calendar(&text).expect("parses");
        let event = &calendar.events[0];
        assert_eq!(event.summary.as_deref(), Some("With alarms"));
        assert_eq!(event.description, None);
    }

    #[test]
    fn malformed_input_never_panics() {
        assert_eq!(
            parse_calendar("").unwrap_err().reason,
            "empty"
        );
        assert_eq!(
            parse_calendar("hello world").unwrap_err().reason,
            "not-icalendar"
        );
        // Property garbage inside an otherwise valid calendar is skipped.
        let text = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "METHOD:REQUEST",
            "BEGIN:VEVENT",
            "NO-COLON-LINE",
            "UID:garbage@example.com",
            "SEQUENCE:not-a-number",
            "DTSTART:20261341T990000Z", // impossible calendar value
            "END:VEVENT",
            "END:VCALENDAR",
            "",
        ]
        .join("\r\n");
        let calendar = parse_calendar(&text).expect("parses");
        let event = &calendar.events[0];
        assert_eq!(event.uid.as_deref(), Some("garbage@example.com"));
        assert_eq!(event.sequence, None);
        assert_eq!(event.dt_start, None);
    }

    #[test]
    fn reply_blob_matches_the_canonical_fixture() {
        let blob = build_reply(&reply_request(
            "9kq3lmiqg9v1s0h3t6q8g9v1s0@google.com",
        ))
        .expect("builds");
        assert_eq!(blob, CANONICAL_REPLY);
    }

    #[test]
    fn reply_with_recurrence_id_and_bare_organizer() {
        let mut request = reply_request("series@example.com");
        request.recurrence_id = Some("20260914T100000Z".to_string());
        request.sequence = None;
        request.dt_start = None;
        request.summary = None;
        request.organizer = Some(IcsPersonInput {
            email: "alice@organizer.example".to_string(),
            name: None,
        });
        request.partstat = "DECLINED".to_string();
        let blob = build_reply(&request).expect("builds");
        assert!(blob.contains("RECURRENCE-ID:20260914T100000Z\r\n"), "{blob}");
        assert!(!blob.contains("SEQUENCE:"), "{blob}");
        assert!(blob.contains("ORGANIZER:mailto:alice@organizer.example"), "{blob}");
        assert!(
            blob.contains(
                "ATTENDEE;CN=Bob Attendee;PARTSTAT=DECLINED:mailto:bob@attendee.example"
            ),
            "{blob}"
        );
    }

    #[test]
    fn reply_validation_rejects_garbage() {
        let mut request = reply_request("x@example.com");
        request.uid = "  ".to_string();
        assert_eq!(
            build_reply(&request).unwrap_err(),
            "a meeting UID is required to build a REPLY"
        );
        let mut request = reply_request("x@example.com");
        request.partstat = "MAYBE".to_string();
        assert!(build_reply(&request).unwrap_err().contains("PARTSTAT"));
        let mut request = reply_request("x@example.com");
        request.attendee.email = "".to_string();
        assert!(build_reply(&request)
            .unwrap_err()
            .contains("attendee's email"));
    }

    #[test]
    fn cancel_and_request_builders_round_trip_through_the_parser() {
        // CANCEL: parseable, METHOD:CANCEL, STATUS:CANCELLED, no ATTENDEE.
        let cancel = build_cancel(&reply_request("round@example.com")).expect("builds");
        assert!(cancel.contains("METHOD:CANCEL"), "{cancel}");
        assert!(cancel.contains("STATUS:CANCELLED"), "{cancel}");
        assert!(!cancel.contains("ATTENDEE"), "{cancel}");
        let parsed = parse_calendar(&cancel).expect("parses");
        assert_eq!(parsed.method.as_deref(), Some("CANCEL"));
        assert_eq!(parsed.events[0].status.as_deref(), Some("CANCELLED"));

        // REQUEST: parseable, METHOD:REQUEST, carries the invitation's
        // attendees (the round-trip the REPLY parse path must accept).
        let mut invitation = IcsEvent::default();
        invitation.dt_end = Some(IcsDateTime {
            raw: "20260918T150000Z".to_string(),
            all_day: false,
            utc: true,
            tzid: None,
            epoch_seconds: Some(1_789_743_600),
        });
        invitation.summary = Some("Quarterly sync".to_string());
        invitation.location = Some("Room 4".to_string());
        invitation.attendees = vec![IcsPerson {
            name: Some("Bob Attendee".to_string()),
            email: Some("bob@attendee.example".to_string()),
            partstat: Some("NEEDS-ACTION".to_string()),
        }];
        let request = build_request(
            &reply_request("round@example.com"),
            &invitation,
        )
        .expect("builds");
        let parsed = parse_calendar(&request).expect("parses");
        assert_eq!(parsed.method.as_deref(), Some("REQUEST"));
        let event = &parsed.events[0];
        assert_eq!(event.summary.as_deref(), Some("Quarterly sync"));
        assert_eq!(event.location.as_deref(), Some("Room 4"));
        assert_eq!(event.dt_end.as_ref().and_then(|d| d.epoch_seconds), Some(1_789_743_600));
        assert_eq!(event.attendees.len(), 1);
        // The surviving ATTENDEE is the base blob's answering attendee —
        // the invitation list's identical entry was deduplicated away.
        assert_eq!(event.attendees[0].partstat.as_deref(), Some("ACCEPTED"));

        // Full circle: the REPLY built from the REQUEST's parsed fields
        // matches the canonical shape again.
        let answer = build_reply(&IcsReplyRequest {
            uid: event.uid.clone().expect("uid"),
            sequence: event.sequence,
            recurrence_id: None,
            dt_start: event.dt_start.as_ref().map(|d| d.raw.clone()),
            organizer: event.organizer.as_ref().map(|organizer| IcsPersonInput {
                email: organizer.email.clone().expect("email"),
                name: organizer.name.clone(),
            }),
            attendee: IcsPersonInput {
                email: "bob@attendee.example".to_string(),
                name: Some("Bob Attendee".to_string()),
            },
            partstat: "TENTATIVE".to_string(),
            summary: event.summary.clone(),
        })
        .expect("builds");
        assert!(answer.contains("METHOD:REPLY"), "{answer}");
        assert!(
            answer.contains("ATTENDEE;CN=Bob Attendee;PARTSTAT=TENTATIVE:mailto:bob@attendee.example"),
            "{answer}"
        );
    }

    #[test]
    fn unfolding_and_text_escaping_round_trip() {
        // A SUMMARY with every escapable character survives parse(escape)
        // unchanged; folded input lines rejoin.
        let text = [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "METHOD:REQUEST",
            "BEGIN:VEVENT",
            "UID:escape@example.com",
            "SUMMARY:Comma\\, semicolon\\; backslash\\\\ and a folded\r\n  line",
            "DESCRIPTION:line one\\nline two",
            "END:VEVENT",
            "END:VCALENDAR",
            "",
        ]
        .join("\r\n");
        let calendar = parse_calendar(&text).expect("parses");
        assert_eq!(
            calendar.events[0].summary.as_deref(),
            Some("Comma, semicolon; backslash\\ and a folded line")
        );
        assert_eq!(
            calendar.events[0].description.as_deref(),
            Some("line one\nline two")
        );

        // The builder escapes them back out.
        let blob = build_reply(&IcsReplyRequest {
            uid: "escape@example.com".to_string(),
            sequence: None,
            recurrence_id: None,
            dt_start: None,
            organizer: None,
            attendee: IcsPersonInput {
                email: "bob@attendee.example".to_string(),
                name: Some("Comma, ; Person".to_string()),
            },
            partstat: "ACCEPTED".to_string(),
            summary: Some("Comma, semicolon; test".to_string()),
        })
        .expect("builds");
        assert!(
            blob.contains("ATTENDEE;CN=Comma\\, \\; Person;PARTSTAT=ACCEPTED"),
            "{blob}"
        );
        assert!(blob.contains("SUMMARY:Comma\\, semicolon\\; test"), "{blob}");
    }
}
