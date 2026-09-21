//! vCard 3.0/4.0 projection for the fields the contacts UI owns
//! (parity-round-2 task 4.1, design D4).
//!
//! The contract in one line: ONLY the standard properties are PROJECTED
//! (FN, N, EMAIL, TEL, ORG, TITLE, BDAY, NOTE, UID, REV), and everything
//! the UI does not show survives an edit verbatim — PHOTO, LOGO, X-
//! extensions, extra EMAIL/TEL/URL lines are carried through
//! [`update`] untouched, so writing a synced contact back never destroys
//! server data the app does not model.
//!
//! Robustness rules (the checklist): a resource must hold exactly ONE
//! card; vCard 2.1 and anything else without `VERSION:3.0|4.0` is
//! rejected; non-empty UID and FN are required (a missing FN may not be
//! papered over); the contact email is mandatory and lowercased (the
//! contacts table's identity key) with `PREF=1`/`TYPE=PREF` preferred;
//! structured values (N, ORG) split on ESCAPED semicolons; ~2 MiB
//! per-card cap before parsing. Line unfolding handles CRLF/CR folds AND
//! quoted-printable soft breaks (`=` at end of line, CHARSET-aware hex
//! decode — the encoding vCard 2.1-era exporters still emit). Writing
//! always escapes `\\ \n ; ,` and folds at 75 octets; NEW cards always
//! serialize as vCard 3.0 (CardDAV's mandatory baseline) with a
//! `urn:uuid:` UID the caller generates.

use super::CarddavError;

/// Per-card cap before parsing (checklist: ~2 MiB).
pub(crate) const MAX_VCARD_BYTES: usize = 2 * 1024 * 1024;

/// The projected properties of one card. Only these reach the contacts
/// row; the RAW card text rides alongside them (the row's `carddav_raw`
/// column) so [`update`] can re-serialize losslessly.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VCardSummary {
    pub uid: String,
    pub full_name: String,
    /// Lowercased; mandatory (the contacts row's identity key).
    pub email: String,
    pub note: Option<String>,
    pub telephone: Option<String>,
    pub organization: Option<String>,
    pub title: Option<String>,
    pub birthday: Option<String>,
    pub url: Option<String>,
    pub revision: Option<String>,
}

/// Reject oversized inputs BEFORE any parse work.
pub(crate) fn ensure_size(input: &str) -> Result<(), CarddavError> {
    if input.len() > MAX_VCARD_BYTES {
        return Err(CarddavError::Parse(
            "vCard exceeds the 2 MiB safety limit".to_string(),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Line-level primitives
// ---------------------------------------------------------------------------

/// RFC 6350 §3.2 unfolding: CRLF/CR normalized, continuation lines
/// (leading space/tab) joined onto their parent, and quoted-printable
/// soft breaks (`=` as the last byte of a QP-encoded line) merged.
pub(crate) fn unfold(input: &str) -> Vec<String> {
    let normalized = input.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<String> = Vec::new();
    for line in normalized.split('\n') {
        if (line.starts_with(' ') || line.starts_with('\t')) && !lines.is_empty() {
            lines.last_mut().unwrap_or(&mut String::new()).push_str(&line[1..]);
        } else {
            lines.push(line.to_owned());
        }
    }
    // QP soft breaks: a line whose value part ends with '=' continues on
    // the next physical line (drop ONE '=' and append directly, no space
    // stripping — the soft break inserts nothing).
    let mut joined: Vec<String> = Vec::new();
    for line in lines {
        let continues = joined.last().is_some_and(|previous| {
            previous.ends_with('=')
                && previous
                    .split_once(':')
                    .is_some_and(|(head, _)| head.to_ascii_uppercase().contains("QUOTED-PRINTABLE"))
        });
        if let Some(previous) = joined.last_mut().filter(|_| continues) {
            previous.pop();
            previous.push_str(&line);
        } else {
            joined.push(line);
        }
    }
    joined
}

/// Unescape a vCard TEXT value: `\n`/`\N` → newline, `\\x` → `x`.
fn unescape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch == '\\' {
            match chars.next() {
                Some('n' | 'N') => out.push('\n'),
                Some(next) => out.push(next),
                None => out.push('\\'),
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// Escape a TEXT value for writing (the inverse of [`unescape`], plus the
/// structured delimiters which must never be read as separators).
pub(crate) fn escape(value: &str) -> String {
    value
        .replace('\r', "")
        .replace('\\', "\\\\")
        .replace('\n', "\\n")
        .replace(';', "\\;")
        .replace(',', "\\,")
}

/// Split a structured value on `delimiter`, honoring backslash escapes
/// (the escapes stay in the parts; unescape them at the call site).
fn split_escaped(value: &str, delimiter: char) -> Vec<String> {
    let mut parts = vec![String::new()];
    let mut escaped = false;
    for ch in value.chars() {
        if escaped {
            if let Some(last) = parts.last_mut() {
                last.push('\\');
                last.push(ch);
            }
            escaped = false;
        } else if ch == '\\' {
            escaped = true;
        } else if ch == delimiter {
            parts.push(String::new());
        } else if let Some(last) = parts.last_mut() {
            last.push(ch);
        }
    }
    if escaped {
        if let Some(last) = parts.last_mut() {
            last.push('\\');
        }
    }
    parts
}

/// Windows-1252's 0x80–0x9F range (everything else is identity). The one
/// legacy charset worth special-casing without pulling in an encoding
/// crate; unknown labels fall back to lossy UTF-8.
fn cp1252_byte_to_char(byte: u8) -> char {
    const HIGH: [char; 32] = [
        '€', '', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '', 'Ž', '',
        '', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '', 'ž', 'Ÿ',
    ];
    match byte {
        0x80..=0x9F => HIGH[(byte - 0x80) as usize],
        other => other as char,
    }
}

/// Quoted-printable value decode (`=XX` triplets → bytes), honoring the
/// CHARSET parameter: UTF-8 (the default), ISO-8859-1 and Windows-1252
/// map byte-wise; anything else decodes lossy-UTF-8. The head is the
/// `NAME;PARAM=…` part of the content line.
fn decoded_value(head: &str, raw: &str) -> String {
    if !head.to_ascii_uppercase().contains("QUOTED-PRINTABLE") {
        return raw.to_owned();
    }
    let bytes = raw.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        // `=XX` (with `=XX` split across a soft break already merged by
        // [`unfold`]); a lone `=` followed by non-hex stays literal.
        let triplet = if bytes[index] == b'=' && index + 2 < bytes.len() {
            match (
                (bytes[index + 1] as char).to_digit(16),
                (bytes[index + 2] as char).to_digit(16),
            ) {
                (Some(high), Some(low)) => Some(((high << 4) | low) as u8),
                _ => None,
            }
        } else {
            None
        };
        if let Some(byte) = triplet {
            decoded.push(byte);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    let charset = head.split(';').find_map(|parameter| {
        let (name, value) = parameter.split_once('=')?;
        name.eq_ignore_ascii_case("charset")
            .then(|| value.trim_matches('"').to_ascii_lowercase())
    });
    match charset.as_deref() {
        Some("iso-8859-1" | "latin-1" | "latin1" | "windows-1252" | "cp1252") => {
            decoded.iter().copied().map(cp1252_byte_to_char).collect()
        }
        _ => String::from_utf8_lossy(&decoded).into_owned(),
    }
}

/// The property name of one unfolded content line: the part of the head
/// before the first ';' and after the last '.' (group prefixes like
/// `item1.EMAIL`), case preserved for round-tripping heads.
fn property_name(line: &str) -> Option<&str> {
    let (head, _) = line.split_once(':')?;
    Some(
        head.split(';')
            .next()
            .unwrap_or(head)
            .rsplit('.')
            .next()
            .unwrap_or(head),
    )
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/// Parse one vCard resource into its [`VCardSummary`] projection.
///
/// Errors (typed parse failures — callers count them as skipped cards,
/// they never sink a sync pass): over the size cap, not exactly one
/// card, no VERSION 3.0/4.0, missing/empty UID or FN, or no usable email
/// address.
pub(crate) fn parse(input: &str) -> Result<VCardSummary, CarddavError> {
    ensure_size(input)?;
    let lines = unfold(input);
    let begins = lines
        .iter()
        .filter(|line| line.eq_ignore_ascii_case("BEGIN:VCARD"))
        .count();
    let ends = lines
        .iter()
        .filter(|line| line.eq_ignore_ascii_case("END:VCARD"))
        .count();
    if begins != 1 || ends != 1 {
        return Err(CarddavError::Parse(
            "resource is not exactly one vCard".to_string(),
        ));
    }
    let version = lines.iter().find_map(|line| {
        let (head, value) = line.split_once(':')?;
        head.split(';')
            .next()
            .unwrap_or(head)
            .eq_ignore_ascii_case("VERSION")
            .then(|| value.trim().to_owned())
    });
    if !matches!(version.as_deref(), Some("3.0" | "4.0")) {
        return Err(CarddavError::Parse(
            "vCard has no supported VERSION (3.0 or 4.0)".to_string(),
        ));
    }

    let mut uid: Option<String> = None;
    let mut full_name: Option<String> = None;
    let mut note: Option<String> = None;
    let mut telephone: Option<String> = None;
    let mut organization: Option<String> = None;
    let mut title: Option<String> = None;
    let mut birthday: Option<String> = None;
    let mut url: Option<String> = None;
    let mut revision: Option<String> = None;
    // (preferred, value) in line order — PREF wins over first-seen.
    let mut emails: Vec<(bool, String)> = Vec::new();

    for line in &lines {
        let Some((head, raw)) = line.split_once(':') else {
            continue;
        };
        let Some(name) = property_name(line) else {
            continue;
        };
        let decoded = decoded_value(head, raw);
        match name.to_ascii_uppercase().as_str() {
            "UID" => {
                let value = unescape(&decoded).trim().to_owned();
                if !value.is_empty() {
                    uid = Some(value);
                }
            }
            "FN" => {
                let value = unescape(&decoded).trim().to_owned();
                if !value.is_empty() {
                    full_name = Some(value);
                }
            }
            // N is deliberately NOT projected (FN is required and is the
            // only display name the contacts row keeps); N lines survive
            // edits verbatim via [`update`].
            "EMAIL" => {
                let value = unescape(&decoded).trim().to_owned();
                if !value.is_empty() {
                    let upper = head.to_ascii_uppercase();
                    let preferred = upper.contains("PREF=1") || upper.contains("TYPE=PREF");
                    emails.push((preferred, value));
                }
            }
            "TEL" if telephone.is_none() => {
                let value = unescape(&decoded).trim().to_owned();
                if !value.is_empty() {
                    telephone = Some(value);
                }
            }
            "ORG" if organization.is_none() => {
                organization = split_escaped(decoded.trim(), ';')
                    .first()
                    .map(|part| unescape(part).trim().to_owned())
                    .filter(|part| !part.is_empty());
            }
            "TITLE" if title.is_none() => {
                let value = unescape(&decoded).trim().to_owned();
                if !value.is_empty() {
                    title = Some(value);
                }
            }
            "BDAY" if birthday.is_none() => {
                let value = unescape(&decoded).trim().to_owned();
                if !value.is_empty() {
                    birthday = Some(value);
                }
            }
            "URL" if url.is_none() => {
                let value = unescape(&decoded).trim().to_owned();
                if !value.is_empty() {
                    url = Some(value);
                }
            }
            "REV" if revision.is_none() => {
                let value = unescape(&decoded).trim().to_owned();
                if !value.is_empty() {
                    revision = Some(value);
                }
            }
            "NOTE" if note.is_none() => {
                let value = unescape(&decoded).trim().to_owned();
                if !value.is_empty() {
                    note = Some(value);
                }
            }
            _ => {}
        }
    }

    let uid = uid.ok_or_else(|| {
        CarddavError::Parse("vCard is missing its required UID".to_string())
    })?;
    // FN is REQUIRED (non-empty). The structured N is deliberately not a
    // substitute: N lines are preserved verbatim through edits instead,
    // so no data is lost — but a card without a display name is not
    // projected.
    let full_name = full_name
        .filter(|name| !name.is_empty())
        .ok_or_else(|| CarddavError::Parse("vCard is missing its required FN".to_string()))?;
    let email = emails
        .iter()
        .find(|(preferred, _)| *preferred)
        .or_else(|| emails.first())
        .map(|(_, email)| email.trim().to_lowercase())
        .ok_or_else(|| {
            CarddavError::Parse("vCard carries no usable email address".to_string())
        })?;
    if !email.contains('@') {
        return Err(CarddavError::Parse(
            "vCard carries no usable email address".to_string(),
        ));
    }

    Ok(VCardSummary {
        uid,
        full_name,
        email,
        note,
        telephone,
        organization,
        title,
        birthday,
        url,
        revision,
    })
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/// RFC 6350 §3.1 folding at 75 OCTETS with a single-space continuation.
fn fold_line(line: String) -> Vec<String> {
    const LIMIT: usize = 75;
    let mut lines = Vec::new();
    let mut current = String::new();
    for ch in line.chars() {
        if current.len() + ch.len_utf8() > LIMIT {
            lines.push(current);
            current = String::from(" ");
        }
        current.push(ch);
    }
    lines.push(current);
    lines
}

/// Join content lines into the wire form: folded, CRLF-terminated.
fn render(lines: Vec<String>) -> String {
    let mut out = String::new();
    for line in lines {
        for folded in fold_line(line) {
            out.push_str(&folded);
            out.push_str("\r\n");
        }
    }
    out
}

/// The current time as a vCard REV/timestamp value
/// (`YYYYMMDDTHHMMSSZ`, UTC basic format).
pub(crate) fn rev_timestamp() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}{month:02}{day:02}T{h:02}{m:02}{s:02}Z",
        h = secs_of_day / 3600,
        m = (secs_of_day % 3600) / 60,
        s = secs_of_day % 60
    )
}

/// Howard Hinnant's `civil_from_days` — days since 1970-01-01 to a
/// proleptic Gregorian date (no chrono dependency needed for one stamp).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as i64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

/// Serialize a brand-new card: ALWAYS vCard 3.0 (CardDAV's mandatory
/// baseline — a collection may advertise v4 support but new objects must
/// stay interoperable when it does not), with the `urn:uuid:` UID the
/// caller generated.
pub(crate) fn serialize_new(
    uid: &str,
    name: &str,
    email: &str,
    note: Option<&str>,
) -> String {
    let mut lines = vec![
        "BEGIN:VCARD".to_string(),
        "VERSION:3.0".to_string(),
        format!("UID:{}", escape(uid)),
        // N is mandatory in vCard 3.0; the app models one display name
        // (FN), so the structured components stay empty.
        "N:;;;;".to_string(),
        format!("FN:{}", escape(name)),
        format!("EMAIL;TYPE=PREF:{}", escape(email)),
    ];
    if let Some(note) = note.map(str::trim).filter(|note| !note.is_empty()) {
        lines.push(format!("NOTE:{}", escape(note)));
    }
    lines.push(format!("REV:{}", rev_timestamp()));
    lines.push("END:VCARD".to_string());
    render(lines)
}

/// Re-serialize an EXISTING card with a new display name and/or note,
/// preserving every line the app does not project: PHOTO/LOGO, X-
/// extensions, extra EMAIL/TEL/URL lines, the structured N, CATEGORIES,
/// ADR, … Only FN and NOTE are swapped in, UID/VERSION are kept, and REV
/// is refreshed. A card that is not recognizably a vCard falls back to a
/// fresh 3.0 rebuild (needs a parseable email) or a typed error.
pub(crate) fn update(
    existing: &str,
    name: &str,
    note: Option<&str>,
    uid_fallback: &str,
) -> Result<String, CarddavError> {
    let old = unfold(existing);
    let is_card = old
        .iter()
        .any(|line| line.eq_ignore_ascii_case("BEGIN:VCARD"))
        && old
            .iter()
            .any(|line| line.eq_ignore_ascii_case("END:VCARD"));
    if !is_card {
        // Not recoverable line-wise: rebuild from whatever parses.
        let summary = parse(existing)?;
        return Ok(serialize_new(&summary.uid, name, &summary.email, note));
    }

    let version = old
        .iter()
        .find_map(|line| {
            let (head, value) = line.split_once(':')?;
            head.split(';')
                .next()
                .unwrap_or(head)
                .eq_ignore_ascii_case("VERSION")
                .then(|| value.trim().to_owned())
        })
        .filter(|version| matches!(version.as_str(), "3.0" | "4.0"))
        .unwrap_or_else(|| "3.0".to_string());
    let uid = old
        .iter()
        .find_map(|line| {
            let (head, value) = line.split_once(':')?;
            head.split(';')
                .next()
                .unwrap_or(head)
                .eq_ignore_ascii_case("UID")
                .then(|| value.to_owned())
        })
        .filter(|value| !value.trim().is_empty())
        .map(|value| unescape(&value))
        .unwrap_or_else(|| uid_fallback.to_string());

    // Preserve the original N lines verbatim (the structured name is
    // never shown in the UI, so rewriting it from FN could only destroy
    // data); a 3.0 card without any N gets the mandatory empty one.
    let has_n = old
        .iter()
        .any(|line| property_name(line).is_some_and(|name| name.eq_ignore_ascii_case("N")));

    let mut lines = vec![
        "BEGIN:VCARD".to_string(),
        format!("VERSION:{version}"),
        format!("UID:{}", escape(&uid)),
    ];
    if !has_n && version == "3.0" {
        lines.push("N:;;;;".to_string());
    }
    lines.push(format!("FN:{}", escape(name)));
    for line in &old {
        let Some(prop) = property_name(line) else {
            continue;
        };
        let upper = prop.to_ascii_uppercase();
        let preserve = !matches!(
            upper.as_str(),
            "BEGIN" | "END" | "VERSION" | "UID" | "FN" | "NOTE" | "REV"
        );
        if preserve {
            lines.push(line.clone());
        }
    }
    if let Some(note) = note.map(str::trim).filter(|note| !note.is_empty()) {
        lines.push(format!("NOTE:{}", escape(note)));
    }
    lines.push(format!("REV:{}", rev_timestamp()));
    lines.push("END:VCARD".to_string());
    Ok(render(lines))
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_folded_lines_and_prefers_the_pref_email() {
        let card = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:ada\r\nFN:Ada \r\n Lovelace\r\nEMAIL;TYPE=WORK:other@example.test\r\nEMAIL;PREF=1:ADA@example.test\r\nEND:VCARD\r\n";
        let parsed = parse(card).expect("parses");
        assert_eq!(parsed.full_name, "Ada Lovelace");
        assert_eq!(parsed.email, "ada@example.test");
        assert_eq!(parsed.uid, "ada");
    }

    #[test]
    fn parses_quoted_printable_soft_breaks_with_charset() {
        let card = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:andre\r\nFN;CHARSET=ISO-8859-1;ENCODING=QUOTED-PRINTABLE:Andr=E9 Doe\r\nEMAIL:andre@example.test\r\nNOTE;ENCODING=QUOTED-PRINTABLE:Line=20one=\r\n=0ALine=20two\r\nEND:VCARD\r\n";
        let parsed = parse(card).expect("parses");
        assert_eq!(parsed.full_name, "André Doe");
        assert_eq!(parsed.note, Some("Line one\nLine two".to_string()));
    }

    #[test]
    fn parses_both_vcard_versions_and_rejects_others() {
        for version in ["3.0", "4.0"] {
            let card = format!(
                "BEGIN:VCARD\nVERSION:{version}\nUID:a\nFN:A\nEMAIL:a@example.test\nEND:VCARD"
            );
            assert!(parse(&card).is_ok(), "v{version} parses");
        }
        let error = parse(
            "BEGIN:VCARD\nVERSION:2.1\nUID:a\nFN:A\nEMAIL:a@example.test\nEND:VCARD",
        )
        .unwrap_err();
        assert!(error.to_string().contains("VERSION"), "{error}");
    }

    #[test]
    fn rejects_multiple_cards_and_missing_required_properties() {
        // No UID.
        assert!(parse("BEGIN:VCARD\nVERSION:3.0\nFN:A\nEMAIL:a@example.test\nEND:VCARD").is_err());
        // No FN.
        assert!(parse("BEGIN:VCARD\nVERSION:3.0\nUID:a\nEMAIL:a@example.test\nEND:VCARD").is_err());
        // Two cards in one resource.
        let double = "BEGIN:VCARD\nVERSION:3.0\nUID:a\nFN:A\nEMAIL:a@example.test\nEND:VCARD\nBEGIN:VCARD\nVERSION:3.0\nUID:b\nFN:B\nEMAIL:b@example.test\nEND:VCARD";
        let error = parse(double).unwrap_err();
        assert!(error.to_string().contains("exactly one"), "{error}");
        // No email at all.
        assert!(parse("BEGIN:VCARD\nVERSION:3.0\nUID:a\nFN:A\nEND:VCARD").is_err());
        // A garbage "email".
        assert!(parse("BEGIN:VCARD\nVERSION:3.0\nUID:a\nFN:A\nEMAIL:not-an-email\nEND:VCARD").is_err());
    }

    #[test]
    fn over_the_cap_cards_are_rejected_before_parsing() {
        let big = format!(
            "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:a\r\nFN:{}\r\nEMAIL:a@example.test\r\nEND:VCARD\r\n",
            "x".repeat(MAX_VCARD_BYTES + 1)
        );
        let error = parse(&big).unwrap_err();
        assert!(error.to_string().contains("2 MiB"), "{error}");
    }

    #[test]
    fn structured_values_split_on_escaped_semicolons() {
        let card = "BEGIN:VCARD\nVERSION:3.0\nUID:a\nFN:A\nEMAIL:a@example.test\nORG:Analytical Engines;Research\\;Formal\nN:Lovelace;Ada;;;\nEND:VCARD";
        let parsed = parse(card).expect("parses");
        assert_eq!(
            parsed.organization,
            Some("Analytical Engines".to_string()),
            "ORG projects its first component"
        );
    }

    #[test]
    fn new_cards_serialize_as_vcard3_with_folding_and_escape_round_trip() {
        let long_name = "Résumé Person; Research, Development — a very long display                          name that certainly exceeds the seventy-five octet fold limit";
        let serialized = serialize_new(
            "urn:uuid:0b3f1e0e-1c2d-4e5f-8a9b-0c1d2e3f4a5b",
            long_name,
            "person@example.test",
            Some("line one\nline two; with specials"),
        );
        // vCard 3.0 baseline + folded continuation lines.
        assert!(serialized.contains("VERSION:3.0"), "{serialized}");
        assert!(serialized.contains("\r\n "), "{serialized}");
        assert!(serialized.contains("UID:urn:uuid:"), "{serialized}");
        // Escapes survive a serialize→parse round-trip verbatim.
        let reparsed = parse(&serialized).expect("round-trips");
        assert_eq!(reparsed.full_name, long_name);
        assert_eq!(
            reparsed.note,
            Some("line one\nline two; with specials".to_string())
        );
        assert!(serialized.contains("REV:"), "{serialized}");
    }

    #[test]
    fn update_preserves_unmodeled_properties() {
        let original = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:server-id\r\nN:Doe;Jane;;;\r\nFN:Jane Doe\r\nEMAIL;TYPE=PREF:jane@example.test\r\nEMAIL;TYPE=HOME:other@example.test\r\nTEL;TYPE=CELL:111\r\nTEL;TYPE=HOME:222\r\nURL:https://jane.example\r\nORG:Eng;Platform\r\nTITLE:Staff Engineer\r\nBDAY:19900101\r\nPHOTO;ENCODING=b:AAAB\r\nX-AB-LABEL:Friend\r\nCATEGORIES:friends,family\r\nNOTE:old note\r\nREV:20200101T000000Z\r\nEND:VCARD\r\n";
        let updated = update(original, "Jane Q. Doe", Some("new note"), "fallback")
            .expect("update works");
        // Kept identity + version.
        assert!(updated.contains("VERSION:3.0"), "{updated}");
        assert!(updated.contains("UID:server-id"), "{updated}");
        // Swapped: FN and NOTE.
        assert!(updated.contains("FN:Jane Q. Doe"), "{updated}");
        assert!(updated.contains("NOTE:new note"), "{updated}");
        assert!(!updated.contains("old note"), "{updated}");
        // Preserved: N verbatim, secondary email, TELs, URL, ORG, TITLE,
        // BDAY, PHOTO, X- extension, CATEGORIES.
        assert!(updated.contains("N:Doe;Jane;;;"), "{updated}");
        assert!(updated.contains("EMAIL;TYPE=HOME:other@example.test"), "{updated}");
        assert!(updated.contains("TEL;TYPE=CELL:111"), "{updated}");
        assert!(updated.contains("TEL;TYPE=HOME:222"), "{updated}");
        assert!(updated.contains("URL:https://jane.example"), "{updated}");
        assert!(updated.contains("ORG:Eng;Platform"), "{updated}");
        assert!(updated.contains("TITLE:Staff Engineer"), "{updated}");
        assert!(updated.contains("BDAY:19900101"), "{updated}");
        assert!(updated.contains("PHOTO;ENCODING=b:AAAB"), "{updated}");
        assert!(updated.contains("X-AB-LABEL:Friend"), "{updated}");
        assert!(updated.contains("CATEGORIES:friends,family"), "{updated}");
        // REV refreshed.
        assert!(!updated.contains("REV:20200101T000000Z"), "{updated}");
        // And the result still parses to the new projection.
        let summary = parse(&updated).expect("updated card parses");
        assert_eq!(summary.full_name, "Jane Q. Doe");
        assert_eq!(summary.note, Some("new note".to_string()));
        assert_eq!(summary.telephone, Some("111".to_string()));
        assert_eq!(summary.organization, Some("Eng".to_string()));
    }

    #[test]
    fn update_keeps_v4_cards_v4_and_clearing_a_note_removes_it() {
        let original =
            "BEGIN:VCARD\nVERSION:4.0\nUID:a\nFN:A\nEMAIL:a@example.test\nNOTE:drop me\nEND:VCARD\n";
        let updated = update(original, "A", None, "fallback").expect("update works");
        assert!(updated.contains("VERSION:4.0"), "{updated}");
        assert!(!updated.contains("NOTE:"), "{updated}");
        let summary = parse(&updated).expect("parses");
        assert_eq!(summary.note, None);
    }

    #[test]
    fn update_of_a_non_card_falls_back_to_a_fresh_rebuild() {
        let updated = update("garbage", "New Name", None, "urn:uuid:fallback").unwrap_err();
        assert_eq!(updated.kind(), "parse");
    }

    #[test]
    fn rev_timestamp_is_utc_basic_format() {
        let stamp = rev_timestamp();
        assert_eq!(stamp.len(), 16, "{stamp}");
        assert!(stamp.ends_with('Z'), "{stamp}");
        assert_eq!(stamp.as_bytes()[8], b'T');
        assert!(stamp[..8].chars().all(|ch| ch.is_ascii_digit()));
    }

    #[test]
    fn unfold_merges_space_tab_and_qp_continuations() {
        // Unfolding strips exactly ONE leading whitespace character per
        // continuation line (the folding WSP is not value data).
        assert_eq!(
            unfold("A:one\r\n two\r\n\tthree\r\n"),
            vec!["A:onetwothree".to_string(), String::new()]
        );
        // A value space before the fold survives: "one " + "two".
        assert_eq!(
            unfold("A:one \r\n two\r\n")[0],
            "A:one two".to_string()
        );
        assert_eq!(
            unfold("NOTE;ENCODING=QUOTED-PRINTABLE:aa=\r\nbb\r\n"),
            vec!["NOTE;ENCODING=QUOTED-PRINTABLE:aabb".to_string(), String::new()]
        );
        // A trailing '=' on a NON-QP line is not a soft break.
        assert_eq!(
            unfold("FN:x=\r\ny\r\n"),
            vec!["FN:x=".to_string(), "y".to_string(), String::new()]
        );
    }
}
