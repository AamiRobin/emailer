//! Tauri commands exposing the IMAP client.
//!
//! All commands are stateless: each call connects, performs its work, and
//! logs out. Connection parameters are passed explicitly per call.

use crate::imap::client;
use crate::imap::types::{
    FetchResult, FlagsChangedResult, ImapFolder, ImapParams, TestResult, UidFlags,
};

/// Validate a UID set at the trust boundary: async-imap interpolates the
/// value verbatim into `UID FETCH/STORE/MOVE/COPY/EXPUNGE` command lines
/// (no quoting, no CR/LF check), so only the IMAP sequence-set charset may
/// pass. Leading/trailing/duplicate commas are harmless and allowed.
fn require_uid_set(uid_set: &str) -> Result<(), String> {
    let valid = !uid_set.is_empty()
        && uid_set
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '*' | ':' | ','));
    if valid {
        Ok(())
    } else {
        Err(
            "uid set must only contain digits, '*', ':' and ',' (e.g. \"1,5,9\" or \"104:*\")"
                .to_string(),
        )
    }
}

/// True when `s` is a non-empty IMAP atom: the RFC 3501 ATOM-CHAR set minus
/// the response-specials, i.e. anything but spaces, controls, parens,
/// brackets, `{` `%` `*` `"` `\` and CR/LF. Enough for flag keywords, which
/// must never be able to alter the surrounding STORE/APPEND command line.
fn is_imap_atom(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c))
}

/// Validate STORE/APPEND flag keywords at the trust boundary: the flag list
/// is interpolated verbatim into the command. A flag is either a system flag
/// (leading `\` + atom, e.g. `\Seen`) or a keyword atom (e.g. `$Label1`,
/// `NonJunk`); anything else (spaces, parens, brackets, CR/LF) is rejected.
/// Only spaces/tabs are trimmed first — a padded keyword (" $Label1 ") keeps
/// working, while anything containing CR/LF or other controls is rejected.
fn require_flag_keywords(flags: &[String]) -> Result<(), String> {
    for flag in flags {
        let trimmed = flag.trim_matches([' ', '\t']);
        let atom = trimmed.strip_prefix('\\').unwrap_or(trimmed);
        if !is_imap_atom(atom) {
            return Err(format!(
                "invalid flag {flag:?}: must be a system flag (e.g. \"\\\\Seen\") or a keyword without spaces or special characters"
            ));
        }
    }
    Ok(())
}

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

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn flags(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    // ----- UID set validation -----

    #[test]
    fn uid_set_accepts_sequence_sets() {
        assert!(require_uid_set("1").is_ok());
        assert!(require_uid_set("1:*").is_ok());
        assert!(require_uid_set("1,5,9").is_ok());
        assert!(require_uid_set("104:*").is_ok());
        assert!(require_uid_set("1:100,200:300").is_ok());
        // Stray commas are harmless — allowed.
        assert!(require_uid_set("1,,").is_ok());
        assert!(require_uid_set(",1,").is_ok());
    }

    #[test]
    fn uid_set_rejects_empty_and_foreign_characters() {
        assert!(require_uid_set("").is_err());
        // CR/LF injection must not reach the command line.
        assert!(require_uid_set("1:2\r\n").is_err());
        assert!(require_uid_set("1\n").is_err());
        assert!(require_uid_set("a b").is_err());
        assert!(require_uid_set("[x]").is_err());
        assert!(require_uid_set("(1:2)").is_err());
        assert!(require_uid_set("1;2").is_err());
        assert!(require_uid_set("\"1\"").is_err());
        assert!(require_uid_set("1 2").is_err());
        assert!(require_uid_set("-1").is_err());
        assert!(require_uid_set("+1").is_err());
    }

    // ----- Flag keyword validation -----

    #[test]
    fn flag_keywords_accept_system_flags_and_atoms() {
        assert!(require_flag_keywords(&flags(&["\\Seen"])).is_ok());
        assert!(require_flag_keywords(&flags(&["\\Seen", "\\Answered"])).is_ok());
        assert!(require_flag_keywords(&flags(&["$Label1"])).is_ok());
        assert!(require_flag_keywords(&flags(&["NonJunk"])).is_ok());
        assert!(require_flag_keywords(&flags(&["custom-keyword_2"])).is_ok());
        // Whitespace-padded keywords keep working (normalized downstream).
        assert!(require_flag_keywords(&flags(&[" $Label1 "])).is_ok());
    }

    #[test]
    fn flag_keywords_reject_command_shaping() {
        // Spaces would smuggle extra command tokens.
        assert!(require_flag_keywords(&flags(&["Seen ok"])).is_err());
        // `;` is outside the IMAP atom charset.
        assert!(require_flag_keywords(&flags(&["In;ject"])).is_err());
        // CR/LF injection.
        assert!(require_flag_keywords(&flags(&["Seen\r\n"])).is_err());
        assert!(require_flag_keywords(&flags(&["a\r\nb"])).is_err());
        // Brackets and parens are response-specials, not atoms.
        assert!(require_flag_keywords(&flags(&["[x]"])).is_err());
        assert!(require_flag_keywords(&flags(&["(x)"])).is_err());
        // Quotes break out of unquoted contexts.
        assert!(require_flag_keywords(&flags(&["\"x\""])).is_err());
        // A bare backslash is not a flag.
        assert!(require_flag_keywords(&flags(&["\\"])).is_err());
        // Empty string.
        assert!(require_flag_keywords(&flags(&[""])).is_err());
        assert!(require_flag_keywords(&flags(&["   "])).is_err());
    }
}
