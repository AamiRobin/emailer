//! Tauri commands exposing the SMTP client.
//!
//! Stateless like the IMAP commands: each call connects, performs its work,
//! and disconnects. Connection parameters are passed explicitly per call.

use crate::smtp::client;
use crate::smtp::types::{OutgoingEmail, SendResult, SmtpParams, SmtpTestResult};

/// Send an email as multipart/alternative. Returns the Message-ID that was
/// transmitted (the provided one, or the generated one).
///
/// `envelope_from` (task 16.2, design D10) overrides MAIL FROM while the
/// From HEADER stays whatever the message carries: when the header From is
/// an alias, the caller passes the authenticated account address here so
/// the envelope does not change with the header. `Option<String>` is
/// backward-compatible by itself — Tauri deserializes a missing invoke key
/// as `None`, so older callers (no `envelopeFrom`) keep the previous
/// header-derived-envelope behavior.
#[tauri::command]
pub async fn smtp_send_email(
    params: SmtpParams,
    email: OutgoingEmail,
    envelope_from: Option<String>,
) -> Result<SendResult, String> {
    client::send_email(&params, &email, envelope_from.as_deref()).await
}

/// Transmit an ALREADY-BUILT RFC 822 message verbatim (task 18.5, design
/// D11): the PGP send path — send.ts builds and signs/encrypts the full
/// message at composer send time (the passphrase exists only in that
/// scope), so the queued op carries the finished bytes and this command
/// must NOT rebuild the MIME from structured fields (that would unwrap the
/// protection). The envelope mirrors `smtp_send_email`'s alias rules
/// (design D10): MAIL FROM is exactly `envelope_from` (the authenticated
/// account address) and RCPT TO is the caller-supplied `recipients` list —
/// never parsed back out of the raw headers. The Bcc header is stripped
/// from the transmitted bytes, like lettre does on the structured path.
#[tauri::command]
pub async fn smtp_send_raw_email(
    params: SmtpParams,
    raw: String,
    recipients: Vec<String>,
    envelope_from: String,
) -> Result<(), String> {
    client::send_raw_email(&params, &raw, &recipients, &envelope_from).await
}

/// Connect to the server (and authenticate when a username is given), then quit.
#[tauri::command]
pub async fn smtp_test_connection(params: SmtpParams) -> Result<SmtpTestResult, String> {
    client::test_connection(&params).await
}
