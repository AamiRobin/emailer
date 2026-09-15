//! Tauri commands exposing the SMTP client.
//!
//! Stateless like the IMAP commands: each call connects, performs its work,
//! and disconnects. Connection parameters are passed explicitly per call.

use crate::smtp::client;
use crate::smtp::types::{OutgoingEmail, SendResult, SmtpParams, SmtpTestResult};

/// Send an email as multipart/alternative. Returns the Message-ID that was
/// transmitted (the provided one, or the generated one).
#[tauri::command]
pub async fn smtp_send_email(
    params: SmtpParams,
    email: OutgoingEmail,
) -> Result<SendResult, String> {
    client::send_email(&params, &email).await
}

/// Connect to the server (and authenticate when a username is given), then quit.
#[tauri::command]
pub async fn smtp_test_connection(params: SmtpParams) -> Result<SmtpTestResult, String> {
    client::test_connection(&params).await
}
