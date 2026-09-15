use serde::{Deserialize, Serialize};

/// Transport security used for the IMAP connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Security {
    /// Implicit TLS, typically port 993.
    Tls,
    /// Plain connect, then upgrade via the STARTTLS command, typically port 143.
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

/// Explicit per-call connection parameters (stateless: connect, work, logout).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImapParams {
    pub host: String,
    pub port: u16,
    pub security: Security,
    pub username: String,
    pub password: String,
    /// Accept invalid/self-signed certificates (e.g. local mail bridges). Dev only.
    #[serde(default)]
    pub accept_invalid_certs: bool,
}

/// Special-use role of a folder (RFC 6154), resolved from LIST attributes
/// with a well-known-name fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FolderRole {
    Inbox,
    Sent,
    Drafts,
    Trash,
    Junk,
    Archive,
    All,
    Flagged,
}

impl FolderRole {
    /// The RFC 6154 attribute string for this role ("\Sent" etc.).
    /// INBOX has no attribute; it is identified by the reserved name "INBOX".
    pub fn as_attribute(&self) -> &'static str {
        match self {
            FolderRole::Inbox => "\\Inbox",
            FolderRole::Sent => "\\Sent",
            FolderRole::Drafts => "\\Drafts",
            FolderRole::Trash => "\\Trash",
            FolderRole::Junk => "\\Junk",
            FolderRole::Archive => "\\Archive",
            FolderRole::All => "\\All",
            FolderRole::Flagged => "\\Flagged",
        }
    }
}

/// A mailbox returned by LIST.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImapFolder {
    /// Full mailbox path exactly as the server reports it (IMAP-modified UTF-7).
    pub name: String,
    /// Hierarchy delimiter ("/" for most servers, "." for others; "" when flat).
    pub delimiter: String,
    /// False when the server marks the mailbox \NoSelect (cannot be SELECTed).
    pub selectable: bool,
    /// Resolved special-use role, if any.
    pub role: Option<FolderRole>,
}

/// A parsed email address.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImapAddress {
    pub name: Option<String>,
    pub email: Option<String>,
}

/// Attachment metadata. Content bytes are fetched separately (future task)
/// using `part_id` (the IMAP MIME section path, e.g. "1.2") and `uid`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImapAttachment {
    pub part_id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: u32,
    pub content_id: Option<String>,
    /// True when Content-Disposition is inline (e.g. embedded cid images).
    pub is_inline: bool,
}

/// A parsed message. Bodies are decoded text/html; no raw attachment bytes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImapMessage {
    pub uid: u32,
    pub flags: Vec<String>,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    /// Space-separated References chain, newest last.
    pub references: Option<String>,
    pub subject: Option<String>,
    pub from: Vec<ImapAddress>,
    pub to: Vec<ImapAddress>,
    pub cc: Vec<ImapAddress>,
    pub bcc: Vec<ImapAddress>,
    /// Date header as a unix timestamp (seconds), falling back to INTERNALDATE, else 0.
    pub date: i64,
    pub text_body: Option<String>,
    pub html_body: Option<String>,
    /// Size of the raw RFC 822 source in octets.
    pub size: u32,
    pub attachments: Vec<ImapAttachment>,
}

/// Snapshot of the selected mailbox state (from SELECT).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderStatus {
    pub uid_validity: u32,
    pub uid_next: u32,
    pub exists: u32,
    pub unseen: u32,
    /// CONDSTORE (RFC 7162) mailbox mod-sequence — Some only when the
    /// folder was selected with the (CONDSTORE) parameter and the server
    /// supports it; null otherwise (flag-consistency falls back to a
    /// window re-scan, D14).
    #[serde(default)]
    pub highest_modseq: Option<u64>,
}

/// Result of fetching messages from a folder.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchResult {
    pub messages: Vec<ImapMessage>,
    pub folder_status: FolderStatus,
}

/// Flags for a single message (flags-only fetch, no bodies).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UidFlags {
    pub uid: u32,
    pub flags: Vec<String>,
}

/// Changed-since (CONDSTORE) flags fetch: every message whose mod-sequence
/// is greater than the requested one, plus the folder status carrying the
/// new HIGHESTMODSEQ cursor (RFC 7162, design D14).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlagsChangedResult {
    pub flags: Vec<UidFlags>,
    pub folder_status: FolderStatus,
}

/// Summary returned by a successful connection test.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub host: String,
    pub port: u16,
    pub security: String,
    pub capabilities: Vec<String>,
    pub folder_count: usize,
}
