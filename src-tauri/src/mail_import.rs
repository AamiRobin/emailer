//! EML/mbox import parsing (task 19.3, data-portability spec "Import EML
//! and mbox"). The webview hands over a user-picked absolute path; this
//! module reads and parses the bytes Rust-side and returns fully decoded
//! messages (headers, bodies, attachment content, and the RAW RFC 822
//! source per entry) so the TS importer never re-parses MIME and the
//! optional server upload can transmit the original bytes verbatim.
//!
//! File access deliberately uses `std::fs` instead of the plugin-fs
//! commands: the paths arrive from the native open dialog (user consent,
//! already widened into the fs runtime scope by the dialog plugin), and
//! reading here avoids shipping potentially-huge mbox bytes through the
//! JSON bridge just to hand them back for parsing.
//!
//! Single EML: one file, one message — a parse failure is the file's
//! error. mbox: framed entries are split by mail-parser's own
//! `mailbox::mbox::MessageIterator` (the exact inverse of the exporter's
//! mboxrd escaping — one `>` stripped from `>*From ` line starts, `From `
//! separators recognized at line starts), and each entry parses
//! independently: a corrupt/non-mail entry becomes a per-entry error and
//! never aborts the batch (spec "Safe failure and integrity").

use mail_parser::mailbox::mbox::MessageIterator;
use serde::Serialize;

use crate::imap::client::{
    build_section_map, encode_base64, extract_part_bytes, parse_raw_message,
    part_index_for_section,
};
use crate::imap::types::{ImapAddress, ImapAttachment, ImapMessage};

/// One decoded attachment: metadata plus its true binary content
/// (mail-parser has undone the transfer encoding), base64 for the JSON
/// bridge (the D15 convention — no byte arrays over the wire).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAttachment {
    pub filename: Option<String>,
    pub content_type: String,
    pub content_id: Option<String>,
    pub is_inline: bool,
    pub size: u32,
    /// Decoded content, standard base64. Empty when the part's bytes were
    /// unreachable (orphan MIME part — kept as an empty part rather than
    /// dropped, mirroring the exporter's cache-miss behavior).
    pub base64_bytes: String,
}

/// One fully parsed importable message. Mirrors the fields the TS sync
/// engines persist (message-id forms are the parser's canonical bracketed
/// `<id>`; date falls back to the mbox separator time, else 0), plus the
/// raw source for faithful server upload.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedEml {
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    /// Space-separated ancestor chain, oldest first.
    pub references: Option<String>,
    /// `List-Unsubscribe` value, verbatim (task 18.3, D13); None when absent.
    pub list_unsubscribe: Option<String>,
    /// `List-Unsubscribe-Post` value, verbatim; None when absent.
    pub list_unsubscribe_post: Option<String>,
    pub subject: Option<String>,
    pub from: Vec<ImapAddress>,
    pub to: Vec<ImapAddress>,
    pub cc: Vec<ImapAddress>,
    pub bcc: Vec<ImapAddress>,
    /// Date header as unix seconds (fallback mbox separator time, else 0).
    pub date: i64,
    pub text_body: Option<String>,
    pub html_body: Option<String>,
    pub attachments: Vec<ImportedAttachment>,
    /// Size of the raw source in octets.
    pub size: u32,
    /// The message's RFC 822 source, standard base64 — uploaded verbatim
    /// when the user opts into server upload (no reconstruction).
    pub raw_base64: String,
}

/// One mbox entry outcome: `error` is None on success, or the entry's own
/// failure text (parse refused / non-mail content) with `message` None —
/// a bad entry never aborts the file's remaining entries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MboxEntryResult {
    /// 0-based position in the mbox (framing order).
    pub index: usize,
    pub error: Option<String>,
    pub message: Option<ParsedEml>,
}

/// Parse one RFC 822 byte slice into a [`ParsedEml`], decoding attachment
/// content bytes. Reuses the IMAP sync parser for every header/body
/// projection (identical Message-ID bracketing, references join and date
/// fallback semantics) and reads the bytes back out of a second parse —
/// the exporter's `extract_part_bytes` seam.
fn parse_eml_bytes(raw: &[u8], internal_date: Option<i64>) -> Result<ParsedEml, String> {
    let message: ImapMessage = parse_raw_message(raw, 0, Vec::new(), internal_date)?;

    // The crate's parser is deliberately lenient (a header-less blob can
    // still yield a body part), so "parsed" alone does not mean mail.
    // Require the minimal identity a message can be displayed and filed
    // with — a subject or participant header — and refuse everything else
    // as non-mail content (per-entry error, spec "Safe failure and
    // integrity"). The date is deliberately excluded: it falls back to the
    // mbox separator time, which every entry carries.
    if message.subject.is_none()
        && message.from.is_empty()
        && message.to.is_empty()
        && message.cc.is_empty()
    {
        return Err("no subject or participant header found — not an RFC 822 message".to_string());
    }

    // Second parse for attachment bytes only: the sync parser carries no
    // content, and the crate's parse is cheap relative to the import.
    let parser = mail_parser::MessageParser::default();
    let parsed = parser
        .parse(raw)
        .ok_or_else(|| "failed to parse MIME message".to_string())?;
    let section_map = build_section_map(&parsed);

    let attachments = message
        .attachments
        .iter()
        .map(|attachment| imported_attachment(&parsed, &section_map, attachment))
        .collect();

    Ok(ParsedEml {
        message_id: message.message_id,
        in_reply_to: message.in_reply_to,
        references: message.references,
        list_unsubscribe: message.list_unsubscribe,
        list_unsubscribe_post: message.list_unsubscribe_post,
        subject: message.subject,
        from: message.from,
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        date: message.date,
        text_body: message.text_body,
        html_body: message.html_body,
        attachments,
        size: message.size,
        raw_base64: encode_base64(raw),
    })
}

/// Decode one attachment's content (empty when its section path cannot be
/// located — see [`ImportedAttachment::base64_bytes`]).
fn imported_attachment(
    parsed: &mail_parser::Message<'_>,
    section_map: &std::collections::BTreeMap<usize, String>,
    attachment: &ImapAttachment,
) -> ImportedAttachment {
    let base64_bytes = part_index_for_section(section_map, &attachment.part_id)
        .and_then(|part_idx| extract_part_bytes(parsed, part_idx).ok())
        .map(|bytes| encode_base64(&bytes))
        .unwrap_or_default();
    ImportedAttachment {
        filename: Some(attachment.filename.clone()),
        content_type: attachment.mime_type.clone(),
        content_id: attachment.content_id.clone(),
        is_inline: attachment.is_inline,
        size: attachment.size,
        base64_bytes,
    }
}

/// Split mbox bytes into framed entries and parse each independently.
/// Non-mail/corrupt entries surface as per-entry errors; the file-level
/// framing (unreadable separator garbage before the first `From ` line)
/// is tolerated by the iterator.
fn parse_mbox_bytes(raw: &[u8]) -> Vec<MboxEntryResult> {
    let mut entries = Vec::new();
    for (index, entry) in MessageIterator::new(raw).enumerate() {
        let result = match entry {
            Err(error) => Err(format!("mbox entry {}: {error}", index + 1)),
            Ok(entry) => parse_eml_bytes(
                entry.contents(),
                i64::try_from(entry.internal_date()).ok(),
            ),
        };
        match result {
            Ok(message) => entries.push(MboxEntryResult {
                index,
                error: None,
                message: Some(message),
            }),
            Err(error) => entries.push(MboxEntryResult {
                index,
                error: Some(error),
                message: None,
            }),
        }
    }
    entries
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Hard ceiling for one imported file. Parsing keeps the raw bytes plus
/// per-entry decoded bodies and base64 copies in memory (~2.3x the file
/// size), so an unbounded read is an OOM primitive — even user-picked
/// files deserve a cap. 1 GiB comfortably covers real archives.
const MAX_IMPORT_FILE_BYTES: u64 = 1024 * 1024 * 1024;

/// Trust-boundary check for a path handed over from the webview: the
/// command reads any absolute path with process privileges, so require the
/// extension the picker advertises and a sane size before touching disk.
/// (A compromised webview must not turn these commands into arbitrary
/// file reads of, say, `~/.ssh/id_rsa`.)
fn validate_import_path(path: &str, expected_ext: &str) -> Result<std::path::PathBuf, String> {
    let path = std::path::PathBuf::from(path);
    let is_expected = path
        .extension()
        .and_then(|ext| ext.to_str())
        .is_some_and(|ext| ext.eq_ignore_ascii_case(expected_ext));
    if !is_expected {
        return Err(format!("not a .{expected_ext} file: {}", path.display()));
    }
    let metadata = std::fs::metadata(&path)
        .map_err(|error| format!("could not stat {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("not a regular file: {}", path.display()));
    }
    if metadata.len() > MAX_IMPORT_FILE_BYTES {
        return Err(format!(
            "file is {} bytes; the import limit is {MAX_IMPORT_FILE_BYTES} bytes",
            metadata.len()
        ));
    }
    Ok(path)
}

/// Parse one `.eml` file. The whole file is the message; any parse failure
/// is the file's error (the TS importer reports it per file).
#[tauri::command]
pub async fn parse_eml_file(path: String) -> Result<ParsedEml, String> {
    // Blocking read + parse run on the async runtime's worker pool (async
    // command) — the main thread and the UI stay free.
    let path = validate_import_path(&path, "eml")?;
    let raw = std::fs::read(&path).map_err(|error| format!("could not read {}: {error}", path.display()))?;
    parse_eml_bytes(&raw, None)
}

/// Parse one mbox file into per-entry outcomes. Only an unreadable FILE is
/// a command error; unreadable ENTRIES are reported inside the result.
#[tauri::command]
pub async fn parse_mbox_file(path: String) -> Result<Vec<MboxEntryResult>, String> {
    let path = validate_import_path(&path, "mbox")?;
    let raw = std::fs::read(&path).map_err(|error| format!("could not read {}: {error}", path.display()))?;
    Ok(parse_mbox_bytes(&raw))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const EML_WITH_ATTACHMENT: &[u8] = b"From: Alice Example <alice@example.com>\r\n\
To: bob@example.com\r\n\
Cc: Carol <carol@example.net>\r\n\
Subject: =?utf-8?q?Quarterly_report?=\r\n\
Date: Tue, 14 Nov 2023 22:13:20 +0000\r\n\
Message-ID: <report-1@example.com>\r\n\
MIME-Version: 1.0\r\n\
Content-Type: multipart/mixed; boundary=\"outer\"\r\n\
\r\n\
--outer\r\n\
Content-Type: text/plain; charset=UTF-8\r\n\
Content-Transfer-Encoding: quoted-printable\r\n\
\r\n\
Hello Bob,=0A\
attached is the report.\r\n\
--outer\r\n\
Content-Type: application/pdf; name=\"report.pdf\"\r\n\
Content-Disposition: attachment; filename=\"report.pdf\"\r\n\
Content-Transfer-Encoding: base64\r\n\
\r\n\
JVBERi0xLjQK\r\n\
--outer--\r\n";

    #[test]
    fn parses_eml_headers_bodies_and_attachment_bytes() {
        let parsed = parse_eml_bytes(EML_WITH_ATTACHMENT, None).expect("fixture parses");

        assert_eq!(parsed.message_id.as_deref(), Some("<report-1@example.com>"));
        assert_eq!(parsed.subject.as_deref(), Some("Quarterly report"));
        assert_eq!(parsed.date, 1_700_000_000);
        assert_eq!(parsed.from.len(), 1);
        assert_eq!(parsed.from[0].name.as_deref(), Some("Alice Example"));
        assert_eq!(parsed.from[0].email.as_deref(), Some("alice@example.com"));
        assert_eq!(
            parsed.to.iter().map(|a| a.email.as_deref()).collect::<Vec<_>>(),
            vec![Some("bob@example.com")]
        );
        assert_eq!(
            parsed.cc.iter().map(|a| a.email.as_deref()).collect::<Vec<_>>(),
            vec![Some("carol@example.net")]
        );
        // Quoted-printable body decoded.
        assert_eq!(
            parsed.text_body.as_deref(),
            Some("Hello Bob,\nattached is the report.")
        );
        // body_html is derived from the text part (the crate's accessor
        // semantics — the sync engine sees the same).
        assert!(parsed.html_body.is_some());

        let attachments = &parsed.attachments;
        assert_eq!(attachments.len(), 1);
        assert_eq!(attachments[0].filename.as_deref(), Some("report.pdf"));
        assert_eq!(attachments[0].content_type, "application/pdf");
        assert!(!attachments[0].is_inline);
        // base64 payload decodes to the PDF magic bytes.
        assert_eq!(attachments[0].base64_bytes, "JVBERi0xLjQK");

        // The raw source rides along, base64 of the exact input bytes.
        assert_eq!(parsed.size, EML_WITH_ATTACHMENT.len() as u32);
        assert_eq!(parsed.raw_base64, encode_base64(EML_WITH_ATTACHMENT));
    }

    #[test]
    fn rejects_non_mail_eml_content() {
        assert!(parse_eml_bytes(b"this is not a mail message\n", None).is_err());
        assert!(parse_eml_bytes(b"", None).is_err());
        // A bare date header is not identity enough.
        assert!(parse_eml_bytes(b"Date: Tue, 14 Nov 2023 22:13:20 +0000\n\nprose\n", None).is_err());
    }

    /// Two well-formed messages separated by `From ` lines, plus one entry
    /// that is plain prose (no header block — the parser refuses it).
    const MBOX_TWO_OK_ONE_BAD: &[u8] = b"From alice@example.com Tue Nov 14 22:13:20 2023\n\
From: alice@example.com\n\
To: bob@example.com\n\
Subject: First\n\
Date: Tue, 14 Nov 2023 22:13:20 +0000\n\
Message-ID: <m-1@example.com>\n\
\n\
Body one escaped next line\n\
>From the depths\n\
\n\
From bob@example.com Wed Nov 15 10:00:00 2023\n\
not a message, just some notes\n\
\n\
From alice@example.com Thu Nov 16 08:30:00 2023\n\
From: alice@example.com\n\
Subject: Second\n\
Date: Thu, 16 Nov 2023 08:30:00 +0000\n\
Message-ID: <m-2@example.com>\n\
\n\
Body two\n\
\n";

    #[test]
    fn parses_mbox_per_entry_and_reports_the_bad_one() {
        let entries = parse_mbox_bytes(MBOX_TWO_OK_ONE_BAD);

        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].index, 0);
        assert_eq!(entries[0].error, None);
        let first = entries[0].message.as_ref().expect("first parses");
        assert_eq!(first.message_id.as_deref(), Some("<m-1@example.com>"));
        assert_eq!(first.subject.as_deref(), Some("First"));
        // mboxrd un-escaping: the exporter's `>From ` gained one `>` back.
        // The framing blank line before the next separator stays part of
        // the source (harmless — APPEND/uploads and re-parsing accept it).
        assert_eq!(
            first.text_body.as_deref(),
            Some("Body one escaped next line\nFrom the depths\n\n")
        );

        assert!(entries[1].message.is_none());
        assert!(entries[1]
            .error
            .as_deref()
            .expect("bad entry carries an error")
            .contains("not an RFC 822 message"));
        let second = entries[2].message.as_ref().expect("third parses");
        assert_eq!(second.message_id.as_deref(), Some("<m-2@example.com>"));
        assert_eq!(second.subject.as_deref(), Some("Second"));
        // The Date header wins; the separator time (Thu Nov 16 08:30:00
        // 2023 = 1_700_123_400) is only parse_raw_message's fallback.
        assert_eq!(second.date, 1_700_123_400);
    }

    #[test]
    fn parses_empty_and_separatorless_mbox_into_no_entries() {
        assert!(parse_mbox_bytes(b"").is_empty());
        assert!(parse_mbox_bytes(b"preamble without any From line\n").is_empty());
    }

    #[test]
    fn import_path_guard_rejects_wrong_extension_and_missing_files() {
        // Wrong/absent extension: rejected before any disk access, so
        // arbitrary paths like /etc/passwd never reach std::fs::read.
        assert!(validate_import_path("/etc/passwd", "eml").is_err());
        assert!(validate_import_path("/home/u/.ssh/id_rsa", "mbox").is_err());
        assert!(validate_import_path("no-extension", "eml").is_err());
        // Correct extension but no such file: the stat step errors.
        let missing = std::env::temp_dir().join("emailer-import-guard-missing.mbox");
        let _ = std::fs::remove_file(&missing);
        assert!(validate_import_path(
            missing.to_str().unwrap(),
            "mbox"
        )
        .is_err());
    }

    #[test]
    fn import_path_guard_accepts_matching_extension_case_insensitively() {
        let file = std::env::temp_dir().join("emailer-import-guard.EML");
        std::fs::write(&file, b"From: a@example.com\n\nbody\n").expect("write temp file");
        assert!(validate_import_path(file.to_str().unwrap(), "eml").is_ok());
        // The eml command's extension gate accepts .mbox paths only for
        // the mbox command.
        assert!(validate_import_path(file.to_str().unwrap(), "mbox").is_err());
        let _ = std::fs::remove_file(&file);
    }
}
