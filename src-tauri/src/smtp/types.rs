use serde::{Deserialize, Serialize};

/// Transport security used for the SMTP connection.
///
/// Mirrors `crate::imap::types::Security`; kept as a separate type so each
/// module's wire contract stays self-contained.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Security {
    /// Implicit TLS, typically port 465 (SMTPS).
    Tls,
    /// Plain connect, then upgrade via the STARTTLS command, typically port 587.
    Starttls,
    /// No encryption. Dev/testing only — credentials travel in clear text.
    None,
}

impl Security {
    pub fn as_str(&self) -> &'static str {
        match self {
            Security::Tls => "tls",
            Security::Starttls => "starttls",
            Security::None => "none",
        }
    }
}

/// Explicit per-call connection parameters (stateless: connect, work, quit).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtpParams {
    pub host: String,
    pub port: u16,
    pub security: Security,
    pub username: String,
    pub password: String,
    /// Accept invalid/self-signed certificates (e.g. local mail bridges). Dev only.
    #[serde(default)]
    pub accept_invalid_certs: bool,
}

/// A message participant (display name optional).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EmailAddress {
    pub name: Option<String>,
    pub email: String,
}

/// One attachment part of an outgoing message (task 8.5). The content
/// arrives standard-padded base64-encoded — it crosses the Tauri JSON
/// bridge and the offline queue's `payload_json` that way — and is decoded
/// before the MIME build (lettre re-encodes it, wrapped, per RFC 2045).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtpAttachment {
    pub filename: String,
    /// MIME type; `None` falls back to application/octet-stream.
    #[serde(default)]
    pub mime_type: Option<String>,
    /// Standard padded base64 of the raw file bytes.
    pub content_base64: String,
}

/// An outgoing email, sent as MIME `multipart/alternative` (plain text +
/// HTML), or `multipart/mixed` wrapping that alternative when attachments
/// are present (task 8.5).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingEmail {
    pub from: EmailAddress,
    #[serde(default)]
    pub to: Vec<EmailAddress>,
    #[serde(default)]
    pub cc: Vec<EmailAddress>,
    #[serde(default)]
    pub bcc: Vec<EmailAddress>,
    pub subject: String,
    /// HTML body; when absent, one is generated from `text_body`.
    pub html_body: Option<String>,
    /// Plain-text body; when absent, one is derived from `html_body`.
    pub text_body: Option<String>,
    /// Message-ID being replied to, e.g. "<msg-0@example.com>".
    pub in_reply_to: Option<String>,
    /// Space-separated References chain, oldest first.
    pub references: Option<String>,
    /// Send with a specific Message-ID; when absent one is generated.
    pub message_id: Option<String>,
    /// Attachment parts; empty keeps the plain multipart/alternative wire
    /// format (field added with `#[serde(default)]`, so older payloads
    /// without it still deserialize).
    #[serde(default)]
    pub attachments: Vec<SmtpAttachment>,
}

/// Result of a successful send: the Message-ID that was transmitted
/// (the one provided in the request, or the generated one).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResult {
    pub message_id: String,
}

/// Summary returned by a successful connection test.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmtpTestResult {
    pub host: String,
    pub port: u16,
    pub security: String,
    /// True when credentials were supplied and AUTH succeeded.
    pub authenticated: bool,
    /// Server banner name reported in its greeting.
    pub server: String,
    /// Well-known EHLO capabilities we recognize.
    pub capabilities: Vec<String>,
}
