use std::collections::hash_map::RandomState;
use std::future::Future;
use std::hash::{BuildHasher, Hasher};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;
use lettre::address::Envelope;
use lettre::message::header::ContentType;
use lettre::message::{Attachment, Mailbox, MultiPart};
use lettre::transport::smtp::authentication::{Credentials, Mechanism};
use lettre::transport::smtp::client::{
    AsyncSmtpConnection, Tls, TlsParameters, TlsParametersBuilder,
};
use lettre::transport::smtp::extension::{ClientId, Extension};
use lettre::{Address, AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

use super::types::*;
use crate::net::require_plaintext_host_is_loopback;

// ---------- Timeouts ----------

/// lettre only applies its `timeout` to the TCP connect, so every operation
/// below is additionally wrapped in an overall tokio timeout (hung reads on
/// an established connection would otherwise block forever).
const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const SMTP_TEST_TIMEOUT: Duration = Duration::from_secs(60);
const SMTP_SEND_TIMEOUT: Duration = Duration::from_secs(120);

const AUTH_MECHANISMS: [Mechanism; 2] = [Mechanism::Plain, Mechanism::Login];

/// Run `fut` with a timeout, mapping elapsed timers to a readable error.
async fn with_timeout<F, T, E>(fut: F, dur: Duration, what: &str) -> Result<T, String>
where
    F: Future<Output = Result<T, E>>,
    E: std::fmt::Display,
{
    tokio::time::timeout(dur, fut)
        .await
        .map_err(|_| format!("{what}: timed out after {}s", dur.as_secs()))?
        .map_err(|e| format!("{what} failed: {e}"))
}

// ---------- Transport / TLS ----------

fn build_tls_parameters(host: &str) -> Result<TlsParameters, String> {
    // TLS is always verified: this is a release app sending user mail, so
    // certificate and hostname checks stay on. `accept_invalid_certs` is
    // still deserialized (it is part of the wire contract with the TS layer)
    // so old settings rows do not break deserialization, but its value no
    // longer opens the door to a bypass. A local mail bridge must present a
    // valid certificate.
    TlsParametersBuilder::new(host.to_string())
        .build()
        .map_err(|e| format!("SMTP TLS parameters for {host} failed: {e}"))
}

/// Build an async SMTP transport: implicit TLS (`Security::Tls`), STARTTLS
/// (`Security::Starttls`) or plain TCP (`Security::None`, dev only).
///
/// TLS is always verified — certificate and hostname checks stay on for
/// `Tls`/`Starttls`. The `accept_invalid_certs` field is still deserialized
/// (part of the wire contract with the TS layer) so old settings rows do not
/// break deserialization, but its value no longer opens a bypass; a local
/// mail bridge must present a valid certificate.
fn build_transport(params: &SmtpParams) -> Result<AsyncSmtpTransport<Tokio1Executor>, String> {
    require_plaintext_host_is_loopback(
        matches!(params.security, Security::None),
        &params.host,
    )?;
    let mut builder = match params.security {
        Security::Tls => AsyncSmtpTransport::<Tokio1Executor>::relay(&params.host)
            .map_err(|e| format!("invalid SMTP host {}: {e}", params.host))?,
        Security::Starttls => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&params.host)
            .map_err(|e| format!("invalid SMTP host {}: {e}", params.host))?,
        Security::None => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&params.host),
    };

    if matches!(params.security, Security::Tls | Security::Starttls) {
        let tls = build_tls_parameters(&params.host)?;
        builder = builder.tls(match params.security {
            Security::Tls => Tls::Wrapper(tls),
            _ => Tls::Required(tls),
        });
    }

    builder = builder
        .port(params.port)
        .authentication(AUTH_MECHANISMS.to_vec())
        .timeout(Some(TCP_CONNECT_TIMEOUT));

    // Authenticate only when credentials were provided (mirrors the
    // connection test); AUTH with an empty username would be rejected.
    if !params.username.trim().is_empty() {
        builder = builder.credentials(Credentials::new(
            params.username.clone(),
            params.password.clone(),
        ));
    }

    Ok(builder.build())
}

// ---------- Address helpers ----------

/// Parse a bare address ("user@example.org") into a lettre envelope address.
fn parse_address(email: &str) -> Result<Address, String> {
    let trimmed = email.trim();
    if trimmed.is_empty() {
        return Err("email address must not be empty".to_string());
    }
    trimmed
        .parse::<Address>()
        .map_err(|e| format!("invalid email address '{trimmed}': {e}"))
}

fn parse_mailbox(addr: &EmailAddress) -> Result<Mailbox, String> {
    Ok(Mailbox::new(addr.name.clone(), parse_address(&addr.email)?))
}

/// Parse every recipient (to + cc + bcc); errors when there is none.
fn collect_recipients(email: &OutgoingEmail) -> Result<Vec<Address>, String> {
    let mut recipients = Vec::new();
    for addr in email.to.iter().chain(&email.cc).chain(&email.bcc) {
        recipients.push(parse_address(&addr.email)?);
    }
    if recipients.is_empty() {
        return Err("no recipients: at least one of to/cc/bcc is required".to_string());
    }
    Ok(recipients)
}

fn domain_of(email: &str) -> String {
    let domain = email.trim().rsplit('@').next().unwrap_or("").trim();
    if domain.is_empty() {
        "localhost".to_string()
    } else {
        domain.to_string()
    }
}

/// Restore the canonical "<id>" form for a Message-ID token; empty -> None.
fn normalize_id_token(id: &str) -> Option<String> {
    let t = id.trim();
    if t.is_empty() {
        None
    } else if t.starts_with('<') {
        Some(t.to_string())
    } else {
        Some(format!("<{t}>"))
    }
}

/// Normalize a space-separated References chain to bracketed "<id>" tokens.
fn normalize_id_chain(ids: &str) -> Option<String> {
    let normalized: Vec<String> = ids
        .split_whitespace()
        .filter_map(normalize_id_token)
        .collect();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized.join(" "))
    }
}

/// The Message-ID to send: the provided one (bracket-normalized), else a
/// freshly generated one anchored at the sender's domain.
fn resolve_message_id(provided: Option<&str>, from_email: &str) -> String {
    if let Some(id) = provided.and_then(normalize_id_token) {
        return id;
    }
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or_default();
    let salt = RandomState::new().build_hasher().finish();
    let domain = domain_of(from_email);
    format!("<{nanos:x}.{salt:x}@{domain}>")
}

// ---------- Body helpers ----------

/// Escape HTML-significant characters for generated HTML parts.
fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Derive a minimal HTML part from a plain-text body.
fn html_from_text(text: &str) -> String {
    let paragraphs: Vec<String> = text
        .split("\n\n")
        .map(|p| format!("<p>{}</p>", escape_html(p).replace('\n', "<br>\n")))
        .collect();
    paragraphs.join("\n")
}

/// Derive a readable plain-text part from an HTML body: line-break and
/// block-level tags become newlines, all other tags are stripped and common
/// entities are decoded.
pub(crate) fn fallback_plain_text(html: &str) -> String {
    /// Tags whose end (or `<br>`) forces a line break in the plain text.
    const BLOCK_TAGS: &[&str] = &[
        "p",
        "div",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "li",
        "tr",
        "table",
        "ul",
        "ol",
        "blockquote",
        "pre",
        "section",
        "article",
        "header",
        "footer",
    ];

    let mut stripped = String::with_capacity(html.len());
    let mut tag = String::new();
    let mut in_tag = false;

    for ch in html.chars() {
        if in_tag {
            if ch == '>' {
                let name = tag.trim().to_lowercase();
                let name = name.trim_end_matches('/').trim();
                let is_br = name == "br";
                let is_block_end = name
                    .strip_prefix('/')
                    .map(|n| BLOCK_TAGS.contains(&n))
                    .unwrap_or(false);
                if is_br || is_block_end {
                    stripped.push('\n');
                }
                in_tag = false;
                tag.clear();
            } else {
                tag.push(ch);
            }
        } else if ch == '<' {
            in_tag = true;
        } else {
            stripped.push(ch);
        }
    }

    // Decode the entities that matter for plain text. `&amp;` must be
    // decoded LAST, otherwise "&amp;lt;" would double-decode: "&amp;" ->
    // "&" first produces "&lt;", which the later "&lt;" pass would wrongly
    // turn into "<". Decoding it last keeps one level of decoding.
    let decoded = stripped
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");

    // Collapse runs of blank lines and trailing whitespace.
    let mut collapsed = String::with_capacity(decoded.len());
    let mut blank = false;
    for line in decoded.lines() {
        let line = line.trim_end();
        if line.is_empty() {
            if blank {
                continue;
            }
            blank = true;
        } else {
            blank = false;
        }
        collapsed.push_str(line);
        collapsed.push('\n');
    }
    collapsed.trim().to_string()
}

/// Resolve both alternative bodies: fill in whichever part is missing.
fn resolve_bodies(email: &OutgoingEmail) -> Result<(String, String), String> {
    let text = email
        .text_body
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let html = email
        .html_body
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match (text, html) {
        (Some(t), Some(h)) => Ok((t.to_string(), h.to_string())),
        (Some(t), None) => Ok((t.to_string(), html_from_text(t))),
        (None, Some(h)) => Ok((fallback_plain_text(h), h.to_string())),
        (None, None) => Err("message has no body: provide textBody and/or htmlBody".to_string()),
    }
}

// ---------- MIME build ----------

/// Decode one wire attachment: content must be standard padded base64;
/// the MIME type falls back to application/octet-stream.
fn decode_attachment(
    attachment: &SmtpAttachment,
) -> Result<(String, Vec<u8>, ContentType), String> {
    let bytes = BASE64_STANDARD
        .decode(attachment.content_base64.trim())
        .map_err(|_| {
            format!(
                "attachment '{}' content is not valid base64",
                attachment.filename
            )
        })?;
    let content_type = attachment
        .mime_type
        .as_deref()
        .map(str::trim)
        .filter(|mime| !mime.is_empty())
        .and_then(|mime| ContentType::parse(mime).ok())
        .unwrap_or(
            ContentType::parse("application/octet-stream")
                .expect("the octet-stream fallback MIME type is always parseable"),
        );
    Ok((attachment.filename.clone(), bytes, content_type))
}

/// Build a `multipart/alternative` MIME message — wrapped in
/// `multipart/mixed` with one base64 part per attachment when any are
/// present (task 8.5). Pure: no I/O, unit-testable via `Message::formatted`.
/// Returns the message and the Message-ID it carries (the provided one or
/// the generated one — send_email must transmit exactly this id).
fn build_message(email: &OutgoingEmail) -> Result<(Message, String), String> {
    let (text_body, html_body) = resolve_bodies(email)?;
    let from_mailbox = parse_mailbox(&email.from)?;
    let message_id = resolve_message_id(email.message_id.as_deref(), &email.from.email);

    let mut builder = Message::builder()
        .from(from_mailbox)
        .subject(email.subject.clone())
        .message_id(Some(message_id.clone()))
        .date(SystemTime::now());

    for addr in &email.to {
        builder = builder.to(parse_mailbox(addr)?);
    }
    for addr in &email.cc {
        builder = builder.cc(parse_mailbox(addr)?);
    }
    for addr in &email.bcc {
        builder = builder.bcc(parse_mailbox(addr)?);
    }
    if let Some(id) = email.in_reply_to.as_deref().and_then(normalize_id_token) {
        builder = builder.in_reply_to(id);
    }
    if let Some(chain) = email.references.as_deref().and_then(normalize_id_chain) {
        builder = builder.references(chain);
    }

    let alternative = MultiPart::alternative_plain_html(text_body, html_body);
    let message = if email.attachments.is_empty() {
        builder.multipart(alternative)
    } else {
        let mut mixed = MultiPart::mixed().multipart(alternative);
        for attachment in &email.attachments {
            let (filename, bytes, content_type) = decode_attachment(attachment)?;
            mixed = mixed.singlepart(Attachment::new(filename).body(bytes, content_type));
        }
        builder.multipart(mixed)
    }
    .map_err(|e| format!("failed to build the MIME message: {e}"))?;
    Ok((message, message_id))
}

// ---------- Send ----------

/// Build the MIME message (see `build_message`) and hand it to the server.
///
/// The envelope (MAIL FROM / RCPT TO) is derived from the From/To/Cc/Bcc
/// headers; lettre drops the Bcc header from the transmitted message after
/// using it for the envelope, per RFC 5322.
///
/// `envelope_from` (task 16.2, design D10) switches to the raw-envelope
/// path: MAIL FROM becomes exactly that address (the authenticated
/// account) while the From HEADER keeps the alias the message carries.
/// RCPT TO still comes from the message's recipients, and the transmitted
/// bytes are the same `Message::formatted()` output `send` would use
/// (Bcc header dropped either way). Absent/blank → the envelope is derived
/// from the headers, unchanged.
pub async fn send_email(
    params: &SmtpParams,
    email: &OutgoingEmail,
    envelope_from: Option<&str>,
) -> Result<SendResult, String> {
    let recipients = collect_recipients(email)?;
    let (message, message_id) = build_message(email)?;

    let transport = build_transport(params)?;
    match envelope_from.map(str::trim).filter(|s| !s.is_empty()) {
        Some(sender) => {
            let from = parse_address(sender)?;
            let envelope = Envelope::new(Some(from), recipients)
                .map_err(|e| format!("failed to build the SMTP envelope: {e}"))?;
            with_timeout(
                transport.send_raw(&envelope, &message.formatted()),
                SMTP_SEND_TIMEOUT,
                &format!("SMTP send via {}:{}", params.host, params.port),
            )
            .await?;
        }
        None => {
            with_timeout(
                transport.send(message),
                SMTP_SEND_TIMEOUT,
                &format!("SMTP send via {}:{}", params.host, params.port),
            )
            .await?;
        }
    }

    Ok(SendResult { message_id })
}

// ---------- Raw send (task 18.5: PGP/MIME) ----------

/// Remove the Bcc header (and its folded continuation lines) from a raw
/// message's header block, preserving everything else byte-for-byte. SMTP
/// delivers through the envelope only, so a transmitted Bcc header would
/// leak the hidden recipients to every To/Cc recipient — the structured
/// path never does this (lettre drops Bcc at send time, per RFC 5322) and
/// Gmail's raw path matches (messages.send uses the header for delivery,
/// then strips it). Top-level headers are NOT covered by a PGP/MIME
/// signature (RFC 3156 signs the MIME entity), so stripping cannot break
/// a signed or encrypted message.
fn strip_bcc_headers(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_headers = true;
    let mut dropping_bcc = false;
    for line in raw.split_inclusive('\n') {
        if !in_headers {
            out.push_str(line);
            continue;
        }
        let without_lf = line.strip_suffix('\n').unwrap_or(line);
        let content = without_lf.strip_suffix('\r').unwrap_or(without_lf);
        if content.is_empty() {
            // The blank line separates headers from the body: from here on
            // even a literal "Bcc:" line is body text and stays.
            in_headers = false;
            dropping_bcc = false;
        } else if content
            .get(..4)
            .is_some_and(|prefix| prefix.eq_ignore_ascii_case("bcc:"))
        {
            dropping_bcc = true;
            continue;
        } else if dropping_bcc && (content.starts_with(' ') || content.starts_with('\t')) {
            // Folded continuation of the Bcc header being dropped.
            continue;
        } else {
            dropping_bcc = false;
        }
        out.push_str(line);
    }
    out
}

/// Build the raw send's envelope from explicit bare addresses: MAIL FROM is
/// the authenticated account address (design D10) and RCPT TO the
/// structured recipient list the send flow already validated — never parsed
/// back out of the raw headers. At least one recipient is required.
fn parse_raw_envelope(recipients: &[String], envelope_from: &str) -> Result<Envelope, String> {
    if recipients.is_empty() {
        return Err("no recipients: at least one of to/cc/bcc is required".to_string());
    }
    let mut rcpts = Vec::with_capacity(recipients.len());
    for addr in recipients {
        rcpts.push(parse_address(addr)?);
    }
    let from = parse_address(envelope_from)?;
    Envelope::new(Some(from), rcpts).map_err(|e| format!("failed to build the SMTP envelope: {e}"))
}

/// Transmit an ALREADY-BUILT RFC 822 message (task 18.5: the PGP/MIME the
/// composer froze into the queued send) without rebuilding it — rebuilding
/// from structured fields would unwrap the signing/encryption. The Bcc
/// header is stripped from the transmitted bytes (see `strip_bcc_headers`),
/// exactly like the structured path where lettre drops it after using it
/// for the envelope.
pub async fn send_raw_email(
    params: &SmtpParams,
    raw: &str,
    recipients: &[String],
    envelope_from: &str,
) -> Result<(), String> {
    let envelope = parse_raw_envelope(recipients, envelope_from)?;
    let body = strip_bcc_headers(raw);

    let transport = build_transport(params)?;
    with_timeout(
        transport.send_raw(&envelope, body.as_bytes()),
        SMTP_SEND_TIMEOUT,
        &format!("SMTP send via {}:{}", params.host, params.port),
    )
    .await?;
    Ok(())
}

// ---------- Connection test ----------

/// Recognized EHLO capabilities of an SMTP server, as display strings.
fn capabilities_of(info: &lettre::transport::smtp::extension::ServerInfo) -> Vec<String> {
    let mut caps = Vec::new();
    if info.supports_feature(Extension::StartTls) {
        caps.push("STARTTLS".to_string());
    }
    if info.supports_feature(Extension::EightBitMime) {
        caps.push("8BITMIME".to_string());
    }
    if info.supports_feature(Extension::SmtpUtfEight) {
        caps.push("SMTPUTF8".to_string());
    }
    for mech in [Mechanism::Plain, Mechanism::Login, Mechanism::Xoauth2] {
        if let Some(supported) = info.get_auth_mechanism(&[mech]) {
            caps.push(format!("AUTH {supported}"));
        }
    }
    caps.sort();
    caps.dedup();
    caps
}

/// Connect (implicit TLS / STARTTLS / plain), authenticate when a username is
/// given, report what the server advertised, then QUIT.
pub async fn test_connection(params: &SmtpParams) -> Result<SmtpTestResult, String> {
    with_timeout(
        test_connection_inner(params),
        SMTP_TEST_TIMEOUT,
        &format!("SMTP connection to {}:{}", params.host, params.port),
    )
    .await
}

async fn test_connection_inner(params: &SmtpParams) -> Result<SmtpTestResult, String> {
    require_plaintext_host_is_loopback(
        matches!(params.security, Security::None),
        &params.host,
    )?;
    let hello_name = ClientId::default();
    let tls_wrapper = match params.security {
        Security::Tls => Some(build_tls_parameters(&params.host)?),
        Security::Starttls | Security::None => None,
    };

    let mut conn = AsyncSmtpConnection::connect_tokio1(
        (params.host.as_str(), params.port),
        Some(TCP_CONNECT_TIMEOUT),
        &hello_name,
        tls_wrapper,
        None,
    )
    .await
    .map_err(|e| {
        format!(
            "SMTP connect to {}:{} failed: {e}",
            params.host, params.port
        )
    })?;

    if matches!(params.security, Security::Starttls) {
        let tls = build_tls_parameters(&params.host)?;
        conn.starttls(tls, &hello_name)
            .await
            .map_err(|e| format!("SMTP STARTTLS with {} failed: {e}", params.host))?;
    }

    let server_name = conn.server_info().name().to_string();
    let capabilities = capabilities_of(conn.server_info());

    let mut authenticated = false;
    if !params.username.trim().is_empty() {
        conn.auth(
            &AUTH_MECHANISMS,
            &Credentials::new(params.username.clone(), params.password.clone()),
        )
        .await
        .map_err(|e| {
            format!(
                "SMTP authentication failed for user {}: {e}",
                params.username
            )
        })?;
        authenticated = true;
    }

    let result = SmtpTestResult {
        host: params.host.clone(),
        port: params.port,
        security: params.security.as_str().to_string(),
        authenticated,
        server: server_name,
        capabilities,
    };
    let _ = conn.quit().await;
    Ok(result)
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn addr(email: &str) -> EmailAddress {
        EmailAddress {
            name: None,
            email: email.to_string(),
        }
    }

    // ----- Address parsing -----

    #[test]
    fn address_parsing() {
        assert_eq!(
            parse_address(" user@example.org ").unwrap().to_string(),
            "user@example.org"
        );
        assert!(parse_address("").is_err());
        assert!(parse_address("   ").is_err());
        assert!(parse_address("not-an-address").is_err());
        assert!(parse_address("Name <a@b.c>").is_err()); // bare addresses only
    }

    #[test]
    fn recipient_collection_requires_one() {
        let mut email = OutgoingEmail {
            from: addr("me@example.org"),
            to: vec![],
            cc: vec![],
            bcc: vec![],
            subject: "s".into(),
            html_body: Some("<p>x</p>".into()),
            text_body: Some("x".into()),
            in_reply_to: None,
            references: None,
            message_id: None,
            attachments: vec![],
        };
        assert!(collect_recipients(&email).is_err());

        email.cc.push(addr("cc@example.org"));
        email.bcc.push(addr("bcc@example.org"));
        let recipients = collect_recipients(&email).unwrap();
        assert_eq!(recipients.len(), 2);
    }

    // ----- Message-ID handling -----

    #[test]
    fn provided_message_id_is_normalized() {
        assert_eq!(
            resolve_message_id(Some("<a@b.c>"), "sender.example"),
            "<a@b.c>"
        );
        assert_eq!(
            resolve_message_id(Some(" a@b.c "), "sender.example"),
            "<a@b.c>"
        );
    }

    #[test]
    fn generated_message_id_uses_sender_domain() {
        let id = resolve_message_id(None, "me@sender.example");
        assert!(
            id.starts_with('<') && id.ends_with("@sender.example>"),
            "{id}"
        );

        // No domain -> localhost fallback.
        let id = resolve_message_id(None, "me@");
        assert!(id.ends_with("@localhost>"), "{id}");
        assert_ne!(
            resolve_message_id(None, "me@x.y"),
            resolve_message_id(None, "me@x.y")
        );
    }

    #[test]
    fn id_chain_normalization() {
        assert_eq!(normalize_id_token("<a@b> ").as_deref(), Some("<a@b>"));
        assert_eq!(normalize_id_token("a@b").as_deref(), Some("<a@b>"));
        assert_eq!(normalize_id_token("  "), None);
        assert_eq!(
            normalize_id_chain("<a@b> c@d <e@f>").as_deref(),
            Some("<a@b> <c@d> <e@f>")
        );
        assert_eq!(normalize_id_chain("   "), None);
    }

    // ----- Body derivation -----

    #[test]
    fn plain_text_fallback_strips_html() {
        let html = "<div>Hello <b>world</b></div><p>Second&nbsp;line &amp; more</p>";
        let text = fallback_plain_text(html);
        assert!(text.contains("Hello world"), "{text}");
        assert!(text.contains("Second line & more"), "{text}");
        assert!(!text.contains('<'), "{text}");
    }

    #[test]
    fn plain_text_fallback_collapses_blank_lines() {
        let text = fallback_plain_text("<p>a</p>\n\n\n<p>b</p>");
        // Runs of blank lines collapse to a single paragraph break.
        assert!(text.contains("a\n\nb"), "{text}");
    }

    #[test]
    fn html_from_text_escapes_and_breaks_lines() {
        let html = html_from_text("first\nsecond <tag>");
        assert!(
            html.contains("<p>first<br>\nsecond &lt;tag&gt;</p>"),
            "{html}"
        );
    }

    #[test]
    fn body_resolution_fills_missing_part() {
        let base = |text: Option<String>, html: Option<String>| OutgoingEmail {
            from: addr("me@example.org"),
            to: vec![addr("you@example.org")],
            cc: vec![],
            bcc: vec![],
            subject: "s".into(),
            html_body: html,
            text_body: text,
            in_reply_to: None,
            references: None,
            message_id: None,
            attachments: vec![],
        };

        let both = resolve_bodies(&base(Some("t".into()), Some("<b>h</b>".into()))).unwrap();
        assert_eq!(both, ("t".to_string(), "<b>h</b>".to_string()));

        let (text, html) = resolve_bodies(&base(Some("plain only".into()), None)).unwrap();
        assert_eq!(text, "plain only");
        assert!(html.contains("<p>plain only</p>"));

        let (text, html) = resolve_bodies(&base(None, Some("<p>html only</p>".into()))).unwrap();
        assert_eq!(text, "html only");
        assert!(html.contains("html only"));

        assert!(resolve_bodies(&base(None, None)).is_err());
    }

    // ----- Attachment MIME build (task 8.5) -----

    fn attachment(filename: &str, mime: Option<&str>, content: &[u8]) -> SmtpAttachment {
        SmtpAttachment {
            filename: filename.to_string(),
            mime_type: mime.map(str::to_string),
            content_base64: BASE64_STANDARD.encode(content),
        }
    }

    fn email_with(attachments: Vec<SmtpAttachment>) -> OutgoingEmail {
        OutgoingEmail {
            from: addr("me@example.org"),
            to: vec![addr("you@example.org")],
            cc: vec![],
            bcc: vec![],
            subject: "with file".into(),
            html_body: Some("<p>body</p>".into()),
            text_body: Some("body".into()),
            in_reply_to: None,
            references: None,
            message_id: Some("<m-1@example.org>".into()),
            attachments,
        }
    }

    /// The formatted MIME with line breaks removed (base64 wrapping makes
    /// exact-substring checks on the raw form fragile for long content).
    fn formatted(email: &OutgoingEmail) -> String {
        let (message, _) = build_message(email).unwrap();
        String::from_utf8(message.formatted())
            .unwrap()
            .replace("\r\n", "")
    }

    #[test]
    fn attachments_wrap_in_multipart_mixed() {
        // Binary contents (lettre base64-encodes them; pure-ASCII parts it
        // may send as 7bit) and a text one for the octet-stream fallback.
        let pdf_bytes = b"%PDF-1.\xff\x00hello attachment".as_slice();
        let email = email_with(vec![
            attachment("report.pdf", Some("application/pdf"), pdf_bytes),
            attachment("data.bin", None, &[0u8, 1, 2, 253, 254]),
        ]);
        let raw = formatted(&email);

        // mixed wraps the alternative bodies, not replaces them.
        assert!(raw.contains("multipart/mixed"), "{raw}");
        assert!(raw.contains("multipart/alternative"), "{raw}");
        assert!(raw.contains("Content-Disposition: attachment"), "{raw}");
        assert!(raw.contains("filename=\"report.pdf\""), "{raw}");
        assert!(raw.contains("application/pdf"), "{raw}");
        // Unknown/absent MIME type falls back to octet-stream.
        assert!(raw.contains("application/octet-stream"), "{raw}");
        // Binary attachment bodies are base64 on the wire.
        assert!(raw.contains(&BASE64_STANDARD.encode(pdf_bytes)), "{raw}");
        assert!(
            raw.contains(BASE64_STANDARD.encode([0u8, 1, 2, 253, 254]).as_str()),
            "{raw}"
        );
        // Bodies survive alongside the parts.
        assert!(raw.contains("body"), "{raw}");
    }

    #[test]
    fn no_attachments_keeps_alternative_only() {
        let raw = formatted(&email_with(vec![]));
        assert!(raw.contains("multipart/alternative"), "{raw}");
        assert!(!raw.contains("multipart/mixed"), "{raw}");
        assert!(!raw.contains("Content-Disposition: attachment"), "{raw}");
    }

    #[test]
    fn build_message_returns_the_transmitted_message_id() {
        let (message, message_id) = build_message(&email_with(vec![])).unwrap();
        assert_eq!(message_id, "<m-1@example.org>");
        let raw = String::from_utf8(message.formatted()).unwrap();
        assert!(raw.contains("Message-ID: <m-1@example.org>"), "{raw}");
    }

    #[test]
    fn invalid_attachment_base64_is_rejected() {
        let mut email = email_with(vec![SmtpAttachment {
            filename: "broken.bin".into(),
            mime_type: None,
            content_base64: "!!!not base64!!!".into(),
        }]);
        assert!(build_message(&email)
            .err()
            .unwrap()
            .contains("not valid base64"));
        // The failure is in the attachment, not the rest of the message:
        // removing it builds fine again.
        email.attachments.clear();
        assert!(build_message(&email).is_ok());
    }

    #[test]
    fn wire_attachments_deserialize_with_default() {
        // Older payloads (no attachments field) still deserialize; the
        // field itself round-trips camelCase.
        let without: OutgoingEmail = serde_json::from_str(
            r#"{"from":{"name":null,"email":"a@b.c"},"to":[],"cc":[],"bcc":[],"subject":"s","htmlBody":"<p>x</p>","textBody":null,"inReplyTo":null,"references":null,"messageId":null}"#,
        )
        .unwrap();
        assert!(without.attachments.is_empty());

        let with: OutgoingEmail = serde_json::from_str(
            r#"{"from":{"name":null,"email":"a@b.c"},"to":[],"cc":[],"bcc":[],"subject":"s","htmlBody":"<p>x</p>","textBody":null,"inReplyTo":null,"references":null,"messageId":null,"attachments":[{"filename":"f.txt","mimeType":"text/plain","contentBase64":"aGk="}]}"#,
        )
        .unwrap();
        assert_eq!(with.attachments.len(), 1);
        assert_eq!(with.attachments[0].filename, "f.txt");
        assert_eq!(with.attachments[0].content_base64, "aGk=");
    }

    // ----- Raw send (task 18.5: PGP/MIME) -----

    #[test]
    fn strip_bcc_removes_the_header_but_keeps_everything_else() {
        let raw = "From: a@b.c\r\n\
                   To: d@e.f\r\n\
                   Bcc: hidden@x.y\r\n\
                   Subject: s\r\n\
                   \r\n\
                   body\r\n";
        assert_eq!(
            strip_bcc_headers(raw),
            "From: a@b.c\r\nTo: d@e.f\r\nSubject: s\r\n\r\nbody\r\n"
        );
    }

    #[test]
    fn strip_bcc_drops_folded_continuations_and_is_case_insensitive() {
        let raw = "From: a@b.c\r\n\
                   BCC: one@x.y,\r\n two@x.y,\r\n\tthree@x.y\r\n\
                   Subject: s\r\n\
                   \r\n\
                   body\r\n";
        let stripped = strip_bcc_headers(raw);
        assert_eq!(stripped, "From: a@b.c\r\nSubject: s\r\n\r\nbody\r\n");
        assert!(!stripped.contains("one@x.y"));
        assert!(!stripped.contains("three@x.y"));
    }

    #[test]
    fn strip_bcc_tolerates_lf_endings_and_headerless_messages() {
        assert_eq!(
            strip_bcc_headers("From: a@b.c\nBcc: x@y.z\n\nbody\n"),
            "From: a@b.c\n\nbody\n"
        );
        // No blank line: everything is (still) headers.
        assert_eq!(strip_bcc_headers("Bcc: x@y.z"), "");
        // No Bcc at all: byte-identical.
        let raw = "From: a@b.c\r\n\r\nbody\r\n";
        assert_eq!(strip_bcc_headers(raw), raw);
    }

    #[test]
    fn strip_bcc_leaves_body_mentions_and_other_headers_alone() {
        let raw = "From: a@b.c\r\n\
                   X-Bcc: keep me\r\n\
                   Subject: s\r\n\
                   \r\n\
                   Bcc: not a header\r\n";
        assert_eq!(strip_bcc_headers(raw), raw);
    }

    #[test]
    fn raw_envelope_requires_recipients_and_bare_addresses() {
        assert!(parse_raw_envelope(&[], "a@b.c")
            .err()
            .unwrap()
            .contains("no recipients"));
        assert!(parse_raw_envelope(&["d@e.f".to_string()], "a@b.c").is_ok());
        assert!(parse_raw_envelope(&["not-an-address".to_string()], "a@b.c").is_err());
        assert!(parse_raw_envelope(&["d@e.f".to_string()], "broken").is_err());
    }

    #[tokio::test]
    async fn raw_send_rejects_an_empty_recipient_list_before_connecting() {
        let params = SmtpParams {
            host: "smtp.invalid".to_string(),
            port: 25,
            security: Security::None,
            username: String::new(),
            password: String::new(),
            accept_invalid_certs: false,
        };
        let error = send_raw_email(&params, "From: a@b.c\r\n\r\nx", &[], "a@b.c")
            .await
            .err()
            .unwrap();
        assert!(error.contains("no recipients"), "{error}");
    }

    // ----- Capabilities -----

    #[test]
    fn capabilities_are_sorted_and_deduped() {
        let mut caps = vec!["B".to_string(), "A".to_string(), "A".to_string()];
        caps.sort();
        caps.dedup();
        assert_eq!(caps, vec!["A".to_string(), "B".to_string()]);
    }
}
