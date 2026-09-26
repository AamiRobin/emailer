//! Tauri commands exposing the IMAP client.
//!
//! All commands are stateless: each call connects, performs its work, and
//! logs out. Connection parameters are passed explicitly per call.

use crate::imap::client::{
    self, require_flag_keywords, require_folder_name, require_uid_set,
};
use crate::imap::types::{
    FetchResult, FlagsChangedResult, ImapFolder, ImapParams, TestResult, UidFlags,
};

/// The fetch commands accept either an explicit `uidSet` (e.g. "104:*",
/// "1:100", "1,5,9") or `last = n` to fetch the n most recent messages.

#[tauri::command]
pub async fn imap_test_connection(params: ImapParams) -> Result<TestResult, String> {
    client::test_connection(&params).await
}

#[tauri::command]
pub async fn imap_list_folders(params: ImapParams) -> Result<Vec<ImapFolder>, String> {
    let mut session = client::connect(&params).await?;
    let result = client::list_folders(&mut session).await;
    client::logout(session).await;
    result
}

#[tauri::command]
pub async fn imap_fetch_messages(
    params: ImapParams,
    folder: String,
    uid_set: String,
    last: Option<u32>,
) -> Result<FetchResult, String> {
    // An empty set is legal here (resolve_uid_set then derives it from
    // `last`), but a supplied set is interpolated verbatim into UID FETCH.
    if !uid_set.trim().is_empty() {
        require_uid_set(&uid_set)?;
    }
    let mut session = client::connect(&params).await?;
    let result = client::fetch_messages(&mut session, &folder, &uid_set, last).await;
    client::logout(session).await;
    result
}

#[tauri::command]
pub async fn imap_fetch_flags(
    params: ImapParams,
    folder: String,
    uid_set: String,
    last: Option<u32>,
) -> Result<Vec<UidFlags>, String> {
    if !uid_set.trim().is_empty() {
        require_uid_set(&uid_set)?;
    }
    let mut session = client::connect(&params).await?;
    let result = client::fetch_flags(&mut session, &folder, &uid_set, last).await;
    client::logout(session).await;
    result
}

/// Changed-since (CONDSTORE, RFC 7162) flags-only fetch for flag
/// consistency across clients (design D14): returns every message of
/// `folder` whose mod-sequence changed after `sinceModseq` plus the folder
/// status carrying the fresh HIGHESTMODSEQ cursor. Fails with a clear
/// error when the server lacks CONDSTORE — the TS sync layer then falls
/// back to a flags-only window re-scan.
#[tauri::command]
pub async fn imap_fetch_flags_changed(
    params: ImapParams,
    folder: String,
    since_modseq: u64,
) -> Result<FlagsChangedResult, String> {
    let mut session = client::connect(&params).await?;
    let result = client::fetch_flags_changed(&mut session, &folder, since_modseq).await;
    client::logout(session).await;
    result
}

/// Fetch one MIME part (attachment content) by UID and IMAP MIME section
/// path (camelCase `partId` on the wire, e.g. "2" or "1.2" — the
/// `part_id` of an attachment from `imap_fetch_messages`). The decoded
/// bytes come back standard-base64-encoded so they stay compact over the
/// JSON bridge; decoding happens TS-side.
#[tauri::command]
pub async fn imap_fetch_attachment(
    params: ImapParams,
    folder: String,
    uid: u32,
    part_id: String,
) -> Result<String, String> {
    let mut session = client::connect(&params).await?;
    let result = client::fetch_attachment(&mut session, &folder, uid, &part_id).await;
    client::logout(session).await;
    result
}

/// Fetch one message's complete raw RFC 822 source by UID ("View source",
/// parity-round-2 task 1.2). `BODY.PEEK[]` — the same full-message fetch
/// the body sync uses — so read state is untouched; the bytes come back
/// standard-base64-encoded (decoding happens TS-side, like the importer's
/// rawBase64).
#[tauri::command]
pub async fn imap_fetch_source(
    params: ImapParams,
    folder: String,
    uid: u32,
) -> Result<String, String> {
    let mut session = client::connect(&params).await?;
    let result = client::fetch_source(&mut session, &folder, uid).await;
    client::logout(session).await;
    result
}

/// CREATE a mailbox (folder-level label creation for IMAP accounts).
/// Server rejections (name already exists, invalid name, no permission)
/// surface as the server's error text.
#[tauri::command]
pub async fn imap_create_folder(params: ImapParams, name: String) -> Result<(), String> {
    let mut session = client::connect(&params).await?;
    let result = client::create_folder(&mut session, &name).await;
    client::logout(session).await;
    result
}

/// RENAME a mailbox (folder-level label rename). Servers reject renaming a
/// nonexistent source or onto an existing target; the error text surfaces.
#[tauri::command]
pub async fn imap_rename_folder(
    params: ImapParams,
    from: String,
    to: String,
) -> Result<(), String> {
    let mut session = client::connect(&params).await?;
    let result = client::rename_folder(&mut session, &from, &to).await;
    client::logout(session).await;
    result
}

/// DELETE a mailbox (folder-level label delete). Permanently removes the
/// mailbox and its messages server-side; servers refusing the delete
/// (e.g. INBOX, special-use folders) surface their error text.
#[tauri::command]
pub async fn imap_delete_folder(params: ImapParams, name: String) -> Result<(), String> {
    let mut session = client::connect(&params).await?;
    let result = client::delete_folder(&mut session, &name).await;
    client::logout(session).await;
    result
}

/// `flags` are system flags or keywords, e.g. ["\\Seen"] or ["$Label1"].
/// `add=false` removes the flags instead.
#[tauri::command]
pub async fn imap_store_flags(
    params: ImapParams,
    folder: String,
    uid_set: String,
    flags: Vec<String>,
    add: bool,
) -> Result<(), String> {
    require_uid_set(&uid_set)?;
    require_flag_keywords(&flags)?;
    let mut session = client::connect(&params).await?;
    let result = client::store_flags(&mut session, &folder, &uid_set, &flags, add).await;
    client::logout(session).await;
    result
}

#[tauri::command]
pub async fn imap_move_message(
    params: ImapParams,
    folder: String,
    uid_set: String,
    destination: String,
) -> Result<(), String> {
    require_folder_name(&destination)?;
    require_uid_set(&uid_set)?;
    let mut session = client::connect(&params).await?;
    let result = client::move_message(&mut session, &folder, &uid_set, &destination).await;
    client::logout(session).await;
    result
}

#[tauri::command]
pub async fn imap_delete_message(
    params: ImapParams,
    folder: String,
    uid_set: String,
) -> Result<(), String> {
    require_uid_set(&uid_set)?;
    let mut session = client::connect(&params).await?;
    let result = client::delete_message(&mut session, &folder, &uid_set).await;
    client::logout(session).await;
    result
}

/// Append a raw MIME message (bytes) to a folder, optionally with flags,
/// e.g. ["\\Seen"] (used later for filing sent mail).
#[tauri::command]
pub async fn imap_append(
    params: ImapParams,
    folder: String,
    message: Vec<u8>,
    flags: Option<Vec<String>>,
) -> Result<(), String> {
    if message.is_empty() {
        return Err("message must not be empty".to_string());
    }
    if let Some(flags) = &flags {
        require_flag_keywords(flags)?;
    }
    let mut session = client::connect(&params).await?;
    let result = client::append_message(&mut session, &folder, &message, flags.as_deref()).await;
    client::logout(session).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Boundary wiring (review L9): a folder argument with command-shaping
    /// bytes must be rejected at the command layer BEFORE any connection is
    /// attempted — the params below point at an unroutable host, so a test
    /// that attempted I/O would time out, not error fast.
    #[tokio::test]
    async fn move_message_rejects_control_characters_in_destination() {
        let params = ImapParams {
            host: "192.0.2.1".into(), // TEST-NET-1: never connects fast
            port: 1,
            security: crate::imap::types::Security::None,
            username: "u".into(),
            password: "p".into(),
            accept_invalid_certs: false,
        };
        let error = imap_move_message(
            params,
            "INBOX".into(),
            "1".into(),
            "INBOX\r\nA001 NOOP".into(),
        )
        .await
        .unwrap_err();
        assert!(
            error.contains("control characters"),
            "unexpected error: {error}"
        );
    }
}
