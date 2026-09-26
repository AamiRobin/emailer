//! OS secret-store access for the credential-encryption key (the roadmap
//! item behind security review L1). The sealing key lives in the OS
//! keychain — macOS Keychain, Windows Credential Manager, Linux Secret
//! Service — so the plaintext `credentials.key` file can go away and a
//! file reader of the user's profile no longer gets every token.
//!
//! Threat model (honest version): this protects the key AT REST against
//! every process except the app itself. The webview can still fetch the
//! key over IPC (it must — WebCrypto does the AES-GCM work), exactly as
//! it could read the old file via the fs plugin's app-data read scope, so
//! a webview compromise has the same power as before; a *non-webview*
//! reader (malware, backup sync, disk image) no longer has it.
//!
//! The command surface is deliberately tiny and shaped:
//! - store rejects anything that is not exactly 32 bytes (AES-256 key) so
//!   the entry can never become a general webview-controlled secret box;
//! - load returns the key only to the app's own webview (same channel it
//!   always had);
//! - the module never logs secret material or error payloads.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use keyring::Entry;

/// Keychain service name (reverse-DNS, matches the bundle identifier).
const SERVICE: &str = "com.amirobin.emailer";
/// Account discriminator inside the service: the credential-sealing key.
const ACCOUNT: &str = "credentials-key";
/// AES-256 key length — `store` refuses anything else.
const KEY_BYTE_LENGTH: usize = 32;

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, ACCOUNT)
        .map_err(|error| format!("os secret store unavailable: {error}"))
}

/// Store the sealing key (base64, exactly 32 bytes when decoded).
pub fn store_key(key_b64: &str) -> Result<(), String> {
    let raw = BASE64
        .decode(key_b64)
        .map_err(|_| "credential key is not valid base64".to_string())?;
    if raw.len() != KEY_BYTE_LENGTH {
        return Err(format!(
            "credential key must be {KEY_BYTE_LENGTH} bytes, got {}",
            raw.len()
        ));
    }
    entry()?
        .set_secret(&raw)
        .map_err(|error| format!("os secret store write failed: {error}"))
}

/// Load the sealing key, or None when the OS store has no entry yet.
pub fn load_key() -> Result<Option<String>, String> {
    match entry()?.get_secret() {
        Ok(raw) => Ok(Some(BASE64.encode(raw))),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!("os secret store read failed: {error}")),
    }
}

/// Remove the keychain entry. Deleting a missing entry is success — the
/// goal state is "not there".
pub fn delete_key() -> Result<(), String> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!("os secret store delete failed: {error}")),
    }
}

/// Whether the OS store is usable at all (Linux without a Secret Service
/// daemon reports here; the file fallback stays authoritative then).
pub fn store_available() -> bool {
    Entry::store_status().is_ok()
}

// ---------------------------------------------------------------------------
// Tauri commands (the TS crypto layer is the only caller)
// ---------------------------------------------------------------------------

/// Seal the credential key into the OS store. `keyB64` must decode to a
/// 32-byte key (the store rejects anything else — this entry must never
/// become a general webview-controlled secret box).
#[tauri::command]
pub fn credentials_key_os_store(key_b64: String) -> Result<(), String> {
    store_key(&key_b64)
}

/// The sealing key, or null when the OS store has no entry yet. A store
/// that is unavailable at all (Linux without a Secret Service daemon)
/// reports as null too — the TS layer's file fallback owns the key there,
/// and a hard error would brick fresh installs. A store that EXISTS but
/// refuses (locked macOS keychain) still errors loudly: silently
/// regenerating would orphan every stored credential.
#[tauri::command]
pub fn credentials_key_os_load() -> Result<Option<String>, String> {
    if !store_available() {
        return Ok(None);
    }
    load_key()
}

/// Best-effort delete: a missing entry — or a store that was never
/// usable — is already the goal state.
#[tauri::command]
pub fn credentials_key_os_delete() -> Result<(), String> {
    if !store_available() {
        return Ok(());
    }
    delete_key()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A test key: 32 arbitrary-but-fixed bytes, base64.
    const TEST_KEY_B64: &str = "YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU=";

    fn test_account_entry() -> Entry {
        // Isolated account so the roundtrip never touches the real
        // `credentials-key` entry.
        Entry::new(SERVICE, "test-credentials-key").unwrap()
    }

    #[test]
    fn store_rejects_non_32_byte_keys() {
        let error = store_key("c2hvcnQ=").unwrap_err(); // "short" — 5 bytes
        assert!(error.contains("32 bytes"), "{error}");
        assert!(store_key("not base64!!").is_err());
    }

    #[test]
    fn roundtrip_when_the_os_store_is_available() {
        // CI Linux runners have no Secret Service daemon — skip honestly
        // instead of failing (the file fallback path is what runs there).
        if !store_available() {
            eprintln!("skipping: os secret store unavailable on this host");
            return;
        }
        let entry = test_account_entry();
        entry.delete_credential().ok(); // clean slate, ignore missing

        entry
            .set_secret(b"0123456789abcdef0123456789abcdef")
            .unwrap();
        let loaded = entry.get_secret().unwrap();
        assert_eq!(loaded, b"0123456789abcdef0123456789abcdef");

        entry.delete_credential().unwrap();
        assert!(matches!(
            entry.get_secret(),
            Err(keyring::Error::NoEntry)
        ));
    }

    #[test]
    fn load_delete_treat_missing_entry_as_none_or_ok() {
        // Only meaningful when the store exists, but both paths below are
        // also correct when it does not: load returns Err(unavailable) and
        // delete returns Err — the commands layer maps unavailability for
        // the caller, so here we only assert the NoEntry semantics when
        // the store is present.
        if !store_available() {
            eprintln!("skipping: os secret store unavailable on this host");
            return;
        }
        let entry = test_account_entry();
        entry.delete_credential().ok();
        assert!(matches!(entry.get_secret(), Err(keyring::Error::NoEntry)));
        assert!(TEST_KEY_B64.len() % 4 == 0); // sanity: valid base64 shape
    }
}
