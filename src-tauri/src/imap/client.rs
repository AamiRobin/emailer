use std::fmt;
use std::future::Future;
use std::time::Duration;

use async_imap::types::{Capability, Fetch, Flag, Mailbox, Name, NameAttribute};
use async_imap::{Client, Session};
use futures::StreamExt;
use mail_parser::{MessageParser, MimeHeaders, PartType};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader, ReadBuf};
use tokio::net::TcpStream;
use tokio_native_tls::native_tls;
use tokio_native_tls::TlsConnector as TokioTlsConnector;
use tokio_native_tls::TlsStream;

use super::types::*;

// ---------- Timeouts ----------

const TCP_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const AUTH_TIMEOUT: Duration = Duration::from_secs(30);
const OVERALL_CONNECT_TIMEOUT: Duration = Duration::from_secs(60);
const IMAP_CMD_TIMEOUT: Duration = Duration::from_secs(30);
const IMAP_FETCH_TIMEOUT: Duration = Duration::from_secs(120);
/// Short cap for the best-effort LOGOUT at the end of every command: a hung
/// server must not keep the (already finished) command alive.
const LOGOUT_TIMEOUT: Duration = Duration::from_secs(5);

/// Run `fut` with a timeout, mapping elapsed timers to a readable error.
async fn with_timeout<F, T>(fut: F, dur: Duration, what: &str) -> Result<T, String>
where
    F: Future<Output = Result<T, String>>,
{
    tokio::time::timeout(dur, fut)
        .await
        .map_err(|_| format!("{what}: timed out after {}s", dur.as_secs()))?
}

// ---------- Stream wrapper ----------

/// Unifies TLS and plain TCP streams so `Session` can be generic over one type.
pub enum ImapStream {
    Tls(TlsStream<TcpStream>),
    Plain(TcpStream),
}

impl AsyncRead for ImapStream {
    fn poll_read(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ImapStream::Tls(s) => std::pin::Pin::new(s).poll_read(cx, buf),
            ImapStream::Plain(s) => std::pin::Pin::new(s).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for ImapStream {
    fn poll_write(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &[u8],
    ) -> std::task::Poll<std::io::Result<usize>> {
        match self.get_mut() {
            ImapStream::Tls(s) => std::pin::Pin::new(s).poll_write(cx, buf),
            ImapStream::Plain(s) => std::pin::Pin::new(s).poll_write(cx, buf),
        }
    }

    fn poll_flush(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ImapStream::Tls(s) => std::pin::Pin::new(s).poll_flush(cx),
            ImapStream::Plain(s) => std::pin::Pin::new(s).poll_flush(cx),
        }
    }

    fn poll_shutdown(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        match self.get_mut() {
            ImapStream::Tls(s) => std::pin::Pin::new(s).poll_shutdown(cx),
            ImapStream::Plain(s) => std::pin::Pin::new(s).poll_shutdown(cx),
        }
    }
}

// Session<T> requires T: Debug.
impl fmt::Debug for ImapStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ImapStream::Tls(_) => write!(f, "ImapStream::Tls"),
            ImapStream::Plain(_) => write!(f, "ImapStream::Plain"),
        }
    }
}

// ---------- Connection ----------

pub type ImapSession = Session<ImapStream>;

/// Best-effort LOGOUT with a short timeout; errors are ignored (the session
/// is dropped right after, closing the connection anyway).
pub async fn logout(mut session: ImapSession) {
    let _ = tokio::time::timeout(LOGOUT_TIMEOUT, session.logout()).await;
}

fn build_tls_connector(accept_invalid_certs: bool) -> Result<TokioTlsConnector, String> {
    let mut builder = native_tls::TlsConnector::builder();
    if accept_invalid_certs {
        builder.danger_accept_invalid_certs(true);
        builder.danger_accept_invalid_hostnames(true);
    }
    let connector = builder
        .build()
        .map_err(|e| format!("failed to create TLS connector: {e}"))?;
    Ok(TokioTlsConnector::from(connector))
}

async fn connect_tcp(host: &str, port: u16) -> Result<TcpStream, String> {
    tokio::time::timeout(TCP_CONNECT_TIMEOUT, TcpStream::connect((host, port)))
        .await
        .map_err(|_| {
            format!(
                "TCP connect to {host}:{port} timed out after {}s — check the server settings or network",
                TCP_CONNECT_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("TCP connect to {host}:{port} failed: {e}"))
}

async fn tls_upgrade(
    host: &str,
    tcp: TcpStream,
    accept_invalid_certs: bool,
) -> Result<TlsStream<TcpStream>, String> {
    let connector = build_tls_connector(accept_invalid_certs)?;
    tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, connector.connect(host, tcp))
        .await
        .map_err(|_| {
            format!(
                "TLS handshake with {host} timed out after {}s — check the server settings or network",
                TLS_HANDSHAKE_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("TLS handshake with {host} failed: {e}"))
}

/// Establish an IMAP connection and authenticate with username/password.
///
/// Supports implicit TLS (`Security::Tls`, port 993), STARTTLS upgrade
/// (`Security::Starttls`, port 143) and plain TCP (`Security::None`, dev only).
/// The whole connect+login sequence is wrapped in an overall timeout.
pub async fn connect(params: &ImapParams) -> Result<ImapSession, String> {
    with_timeout(
        connect_inner(params),
        OVERALL_CONNECT_TIMEOUT,
        &format!("IMAP connection to {}:{}", params.host, params.port),
    )
    .await
}

async fn connect_inner(params: &ImapParams) -> Result<ImapSession, String> {
    let stream = match params.security {
        Security::Tls => {
            let tcp = connect_tcp(&params.host, params.port).await?;
            ImapStream::Tls(tls_upgrade(&params.host, tcp, params.accept_invalid_certs).await?)
        }
        Security::Starttls => {
            let tcp = connect_tcp(&params.host, params.port).await?;
            ImapStream::Tls(starttls_upgrade(&params.host, tcp, params.accept_invalid_certs).await?)
        }
        Security::None => ImapStream::Plain(connect_tcp(&params.host, params.port).await?),
    };

    let client = Client::new(stream);
    with_timeout(
        authenticate(client, params),
        AUTH_TIMEOUT,
        &format!("IMAP login as {} on {}", params.username, params.host),
    )
    .await
}

/// Issue STARTTLS on a plain connection, then upgrade it to TLS.
///
/// Consumes any untagged lines (including the server greeting) until the
/// tagged STARTTLS response arrives, so greeting/command coalescing is handled.
async fn starttls_upgrade(
    host: &str,
    tcp: TcpStream,
    accept_invalid_certs: bool,
) -> Result<TlsStream<TcpStream>, String> {
    let mut reader = BufReader::new(tcp);
    reader
        .get_mut()
        .write_all(b"a001 STARTTLS\r\n")
        .await
        .map_err(|e| format!("failed to send STARTTLS to {host}: {e}"))?;

    let mut saw_bye = false;
    loop {
        let mut line = String::new();
        let n = tokio::time::timeout(IMAP_CMD_TIMEOUT, reader.read_line(&mut line))
            .await
            .map_err(|_| {
                format!(
                    "STARTTLS response from {host} timed out after {}s",
                    IMAP_CMD_TIMEOUT.as_secs()
                )
            })?
            .map_err(|e| format!("failed to read STARTTLS response from {host}: {e}"))?;
        if n == 0 {
            return Err(format!("{host} closed the connection during STARTTLS"));
        }
        let trimmed = line.trim_end();
        if trimmed.starts_with("a001 OK") {
            break;
        }
        if trimmed.starts_with("a001 NO")
            || trimmed.starts_with("a001 BAD")
            || trimmed.starts_with("* BYE")
        {
            saw_bye = true;
            break;
        }
        // Untagged lines (greeting, capability data) — keep reading.
    }
    if saw_bye {
        return Err(format!("{host} refused STARTTLS"));
    }

    let tcp = reader.into_inner();
    tls_upgrade(host, tcp, accept_invalid_certs).await
}

async fn authenticate(
    client: Client<ImapStream>,
    params: &ImapParams,
) -> Result<ImapSession, String> {
    client
        .login(&params.username, &params.password)
        .await
        .map_err(|(e, _)| format!("IMAP login failed for user {}: {e}", params.username))
}

// ---------- Folder listing ----------

/// Convert an async-imap attribute to its canonical wire string so role
/// resolution can stay a pure, testable function.
fn attribute_to_string(attr: &NameAttribute<'_>) -> String {
    match attr {
        NameAttribute::NoInferiors => "\\NoInferiors".to_string(),
        NameAttribute::NoSelect => "\\NoSelect".to_string(),
        NameAttribute::Marked => "\\Marked".to_string(),
        NameAttribute::Unmarked => "\\Unmarked".to_string(),
        NameAttribute::All => "\\All".to_string(),
        NameAttribute::Archive => "\\Archive".to_string(),
        NameAttribute::Drafts => "\\Drafts".to_string(),
        NameAttribute::Flagged => "\\Flagged".to_string(),
        NameAttribute::Junk => "\\Junk".to_string(),
        NameAttribute::Sent => "\\Sent".to_string(),
        NameAttribute::Trash => "\\Trash".to_string(),
        NameAttribute::Extension(s) => s.to_string(),
        // The enum is non-exhaustive; ignore attributes from future versions.
        _ => String::new(),
    }
}

/// True when the mailbox may be SELECTed (i.e. not \NoSelect / \NonExistent).
pub(crate) fn is_selectable(attrs: &[String]) -> bool {
    attrs
        .iter()
        .all(|a| !a.eq_ignore_ascii_case("\\NoSelect") && !a.eq_ignore_ascii_case("\\NonExistent"))
}

/// Resolve a folder's special-use role (RFC 6154).
///
/// 1. Check LIST attributes for a special-use flag (`\Sent`, `\Drafts`, ...).
/// 2. Fall back to well-known folder names, matching the last path segment
///    (and the full path) case-insensitively.
pub(crate) fn resolve_folder_role(attrs: &[String], name: &str) -> Option<FolderRole> {
    const ALL_ROLES: [FolderRole; 8] = [
        FolderRole::Inbox,
        FolderRole::Sent,
        FolderRole::Drafts,
        FolderRole::Trash,
        FolderRole::Junk,
        FolderRole::Archive,
        FolderRole::All,
        FolderRole::Flagged,
    ];

    for attr in attrs {
        if let Some(role) = ALL_ROLES
            .iter()
            .find(|role| attr.eq_ignore_ascii_case(role.as_attribute()))
        {
            return Some(*role);
        }
    }

    // Well-known-name fallback on the last hierarchy segment and the full name.
    let lowered = name.to_lowercase();
    let last_segment = lowered
        .rsplit(['/', '.'])
        .next()
        .unwrap_or(&lowered)
        .to_string();
    for candidate in [last_segment.as_str(), lowered.as_str()] {
        let role = match candidate {
            "inbox" => FolderRole::Inbox,
            "sent" | "sent messages" | "sent items" | "sent mail" => FolderRole::Sent,
            "drafts" | "draft" | "draftbox" => FolderRole::Drafts,
            "trash" | "deleted" | "deleted items" | "deleted messages" | "bin" => FolderRole::Trash,
            "junk" | "spam" | "junk e-mail" | "bulk mail" => FolderRole::Junk,
            "archive" | "archives" => FolderRole::Archive,
            "all mail" | "all" => FolderRole::All,
            "flagged" | "starred" => FolderRole::Flagged,
            _ => continue,
        };
        return Some(role);
    }
    None
}

/// LIST every folder the user can see, with hierarchy delimiter, selectability
/// and resolved special-use role.
pub async fn list_folders(session: &mut ImapSession) -> Result<Vec<ImapFolder>, String> {
    let stream = with_timeout(
        async {
            session
                .list(Some(""), Some("*"))
                .await
                .map_err(|e| format!("LIST failed: {e}"))
        },
        IMAP_CMD_TIMEOUT,
        "LIST",
    )
    .await?;

    let names: Vec<Name> = with_timeout(
        async { Ok(stream.collect::<Vec<_>>().await) },
        IMAP_CMD_TIMEOUT,
        "LIST response stream",
    )
    .await?
    .into_iter()
    .filter_map(|r| match r {
        Ok(n) => Some(n),
        Err(e) => {
            log::warn!("IMAP LIST stream item error: {e}");
            None
        }
    })
    .collect();

    let mut folders: Vec<ImapFolder> = names
        .iter()
        .map(|name| {
            let attrs: Vec<String> = name.attributes().iter().map(attribute_to_string).collect();
            let role = resolve_folder_role(&attrs, name.name());
            ImapFolder {
                name: name.name().to_string(),
                delimiter: name.delimiter().unwrap_or("").to_string(),
                selectable: is_selectable(&attrs),
                role,
            }
        })
        .collect();

    folders.sort_by_key(|a| a.name.to_lowercase());
    Ok(folders)
}

// ---------- Fetch ----------

fn flag_to_string(flag: &Flag<'_>) -> String {
    match flag {
        Flag::Seen => "\\Seen".to_string(),
        Flag::Answered => "\\Answered".to_string(),
        Flag::Flagged => "\\Flagged".to_string(),
        Flag::Deleted => "\\Deleted".to_string(),
        Flag::Draft => "\\Draft".to_string(),
        Flag::Recent => "\\Recent".to_string(),
        Flag::MayCreate => "\\*".to_string(),
        Flag::Custom(s) => s.to_string(),
    }
}

fn flags_to_strings<'a>(flags: impl Iterator<Item = Flag<'a>>) -> Vec<String> {
    flags.map(|f| flag_to_string(&f)).collect()
}

/// SELECT a mailbox and return its status snapshot.
async fn select_folder(session: &mut ImapSession, folder: &str) -> Result<FolderStatus, String> {
    let mailbox = with_timeout(
        async {
            session
                .select(folder)
                .await
                .map_err(|e| format!("SELECT {folder} failed: {e}"))
        },
        IMAP_CMD_TIMEOUT,
        &format!("SELECT {folder}"),
    )
    .await?;

    Ok(folder_status_from_mailbox(&mailbox, None))
}

/// SELECT a mailbox with the (CONDSTORE) parameter (RFC 7162) and return
/// its status snapshot including HIGHESTMODSEQ.
async fn select_folder_condstore(
    session: &mut ImapSession,
    folder: &str,
) -> Result<FolderStatus, String> {
    let mailbox = with_timeout(
        async {
            session
                .select_condstore(folder)
                .await
                .map_err(|e| format!("SELECT {folder} (CONDSTORE) failed: {e}"))
        },
        IMAP_CMD_TIMEOUT,
        &format!("SELECT {folder} (CONDSTORE)"),
    )
    .await?;

    let highest_modseq = mailbox_modseq(&mailbox)?;
    Ok(folder_status_from_mailbox(&mailbox, Some(highest_modseq)))
}

/// Build our FolderStatus DTO from an async-imap Mailbox. `highest_modseq`
/// is Some only on the CONDSTORE-aware SELECT path; the plain SELECT never
/// reports one.
fn folder_status_from_mailbox(mailbox: &Mailbox, highest_modseq: Option<u64>) -> FolderStatus {
    FolderStatus {
        uid_validity: mailbox.uid_validity.unwrap_or(0),
        uid_next: mailbox.uid_next.unwrap_or(0),
        exists: mailbox.exists,
        unseen: mailbox.unseen.unwrap_or(0),
        highest_modseq,
    }
}

/// Extract the mailbox mod-sequence from a CONDSTORE-aware SELECT response.
/// A server without RFC 7162 support either rejects the (CONDSTORE)
/// parameter outright (error before this point) or omits HIGHESTMODSEQ —
/// the latter gets a clear error so the TS layer can fall back.
fn mailbox_modseq(mailbox: &Mailbox) -> Result<u64, String> {
    mailbox.highest_modseq.ok_or_else(|| {
        "server did not report HIGHESTMODSEQ — CONDSTORE not supported for this mailbox".to_string()
    })
}

/// True when the capability list advertises CONDSTORE (RFC 7162).
fn supports_condstore(capabilities: &[String]) -> bool {
    capabilities
        .iter()
        .any(|c| c.eq_ignore_ascii_case("CONDSTORE"))
}

/// Build the UID FETCH query for a changed-since (MODSEQ) flags-only fetch:
/// `UID FETCH 1:* (UID FLAGS) (CHANGEDSINCE <modseq>)`.
fn changed_since_query(since_modseq: u64) -> String {
    format!("(UID FLAGS) (CHANGEDSINCE {since_modseq})")
}

/// Resolve the effective UID set for a fetch: an explicit set wins; otherwise
/// `last` selects the most recent N messages using UIDNEXT from SELECT.
fn resolve_uid_set(
    uid_set: &str,
    last: Option<u32>,
    status: &FolderStatus,
) -> Result<String, String> {
    let trimmed = uid_set.trim();
    if !trimmed.is_empty() {
        return Ok(trimmed.to_string());
    }
    last.and_then(|n| last_n_uid_set(status.uid_next, n))
        .ok_or_else(|| {
            "no messages to fetch: provide a non-empty uidSet, or a non-zero `last` on a non-empty folder"
                .to_string()
        })
}

/// Fetch messages by UID set/range (e.g. "104:*", "1:100" or "1,5,9"),
/// parsing headers, bodies and attachment metadata with mail-parser.
///
/// As an alternative to `uid_set`, `last` (Some(n)) fetches the n most recent
/// messages. Uses BODY.PEEK[] so fetching does not set \Seen. Raw attachment
/// bytes are NOT included; they can be fetched later via a dedicated command
/// using `uid` + `attachments[].part_id`.
pub async fn fetch_messages(
    session: &mut ImapSession,
    folder: &str,
    uid_set: &str,
    last: Option<u32>,
) -> Result<FetchResult, String> {
    let folder_status = select_folder(session, folder).await?;
    let uid_set = resolve_uid_set(uid_set, last, &folder_status)?;

    let raw_fetches: Vec<async_imap::error::Result<Fetch>> = with_timeout(
        async {
            let stream = session
                .uid_fetch(&uid_set, "UID FLAGS INTERNALDATE BODY.PEEK[]")
                .await
                .map_err(|e| format!("UID FETCH {folder} uids={uid_set} failed: {e}"))?;
            Ok::<_, String>(stream.collect::<Vec<_>>().await)
        },
        IMAP_FETCH_TIMEOUT,
        &format!("UID FETCH {folder} uids={uid_set}"),
    )
    .await?;

    let fetches: Vec<Fetch> = raw_fetches
        .into_iter()
        .filter_map(|r| match r {
            Ok(f) => Some(f),
            Err(e) => {
                log::warn!("IMAP fetch stream error in {folder}: {e}");
                None
            }
        })
        .collect();

    let mut messages = Vec::with_capacity(fetches.len());
    for fetch in &fetches {
        let uid = match fetch.uid {
            Some(u) => u,
            None => {
                log::warn!("IMAP FETCH {folder}: response missing UID, skipping");
                continue;
            }
        };
        let raw = match fetch.body() {
            Some(b) => b,
            None => {
                log::warn!("IMAP FETCH {folder}: UID {uid} has no body, skipping");
                continue;
            }
        };
        let flags = flags_to_strings(fetch.flags());
        let internal_date = fetch.internal_date().map(|dt| dt.timestamp());

        match parse_raw_message(raw, uid, flags, internal_date) {
            Ok(msg) => messages.push(msg),
            Err(e) => log::warn!("IMAP FETCH {folder}: failed to parse UID {uid}: {e}"),
        }
    }

    Ok(FetchResult {
        messages,
        folder_status,
    })
}

/// Flags-only fetch for a UID range (no bodies downloaded). As with
/// `fetch_messages`, `last` may be given instead of an explicit uid set.
pub async fn fetch_flags(
    session: &mut ImapSession,
    folder: &str,
    uid_set: &str,
    last: Option<u32>,
) -> Result<Vec<UidFlags>, String> {
    let folder_status = select_folder(session, folder).await?;
    let uid_set = resolve_uid_set(uid_set, last, &folder_status)?;

    let fetches: Vec<Fetch> = with_timeout(
        async {
            let stream = session
                .uid_fetch(&uid_set, "(UID FLAGS)")
                .await
                .map_err(|e| format!("UID FETCH flags {folder} uids={uid_set} failed: {e}"))?;
            Ok::<_, String>(stream.collect::<Vec<_>>().await)
        },
        IMAP_CMD_TIMEOUT,
        &format!("UID FETCH flags {folder} uids={uid_set}"),
    )
    .await?
    .into_iter()
    .filter_map(|r| match r {
        Ok(f) => Some(f),
        Err(e) => {
            log::warn!("IMAP flags stream error in {folder}: {e}");
            None
        }
    })
    .collect();

    let mut out = Vec::with_capacity(fetches.len());
    for fetch in &fetches {
        if let Some(uid) = fetch.uid {
            out.push(UidFlags {
                uid,
                flags: flags_to_strings(fetch.flags()),
            });
        }
    }
    Ok(out)
}

/// Changed-since (CONDSTORE, RFC 7162) flags-only fetch for flag
/// consistency across clients (design D14): every message whose
/// mod-sequence changed after `since_modseq`, plus the folder status
/// carrying the fresh HIGHESTMODSEQ cursor. No bodies are downloaded.
///
/// Fails with a clear error when the server does not advertise CONDSTORE;
/// the TS sync layer falls back to a window re-scan in that case.
pub async fn fetch_flags_changed(
    session: &mut ImapSession,
    folder: &str,
    since_modseq: u64,
) -> Result<FlagsChangedResult, String> {
    let caps = with_timeout(
        async {
            session
                .capabilities()
                .await
                .map_err(|e| format!("CAPABILITY failed: {e}"))
        },
        IMAP_CMD_TIMEOUT,
        "CAPABILITY",
    )
    .await?;
    let capabilities = capabilities_to_strings(caps);
    if !supports_condstore(&capabilities) {
        return Err(
            "server does not advertise CONDSTORE — changed-since flag sync unavailable".to_string(),
        );
    }

    let folder_status = select_folder_condstore(session, folder).await?;
    let query = changed_since_query(since_modseq);

    let fetches: Vec<Fetch> = with_timeout(
        async {
            let stream = session
                .uid_fetch("1:*", &query)
                .await
                .map_err(|e| format!("UID FETCH changed-flags {folder} failed: {e}"))?;
            Ok::<_, String>(stream.collect::<Vec<_>>().await)
        },
        IMAP_CMD_TIMEOUT,
        &format!("UID FETCH changed-flags {folder} since={since_modseq}"),
    )
    .await?
    .into_iter()
    .filter_map(|r| match r {
        Ok(f) => Some(f),
        Err(e) => {
            log::warn!("IMAP changed-flags stream error in {folder}: {e}");
            None
        }
    })
    .collect();

    let mut flags = Vec::with_capacity(fetches.len());
    for fetch in &fetches {
        if let Some(uid) = fetch.uid {
            flags.push(UidFlags {
                uid,
                flags: flags_to_strings(fetch.flags()),
            });
        }
    }

    Ok(FlagsChangedResult {
        flags,
        folder_status,
    })
}

// ---------- Message mutation ----------

/// Normalize a flag/keyword for use in a STORE command.
///
/// System flags are canonicalized case-insensitively ("\seen" -> "\Seen");
/// already-prefixed flags and keywords pass through unchanged.
pub(crate) fn normalize_flag(flag: &str) -> String {
    let trimmed = flag.trim();
    if trimmed.starts_with('\\') {
        return trimmed.to_string();
    }
    match trimmed.to_lowercase().as_str() {
        "seen" => "\\Seen".to_string(),
        "answered" => "\\Answered".to_string(),
        "flagged" => "\\Flagged".to_string(),
        "deleted" => "\\Deleted".to_string(),
        "draft" => "\\Draft".to_string(),
        "recent" => "\\Recent".to_string(),
        _ => trimmed.to_string(),
    }
}

/// Format flags as a parenthesized STORE list, e.g. "(\Seen \Flagged)".
pub(crate) fn format_flags_for_store(flags: &[String]) -> String {
    format!(
        "({})",
        flags
            .iter()
            .map(|f| normalize_flag(f))
            .collect::<Vec<_>>()
            .join(" ")
    )
}

/// Add (`add`) or remove flags on a UID set.
pub async fn store_flags(
    session: &mut ImapSession,
    folder: &str,
    uid_set: &str,
    flags: &[String],
    add: bool,
) -> Result<(), String> {
    if flags.is_empty() {
        return Err("no flags provided".to_string());
    }
    let op = if add { "+FLAGS" } else { "-FLAGS" };
    let query = format!("{op} {}", format_flags_for_store(flags));

    select_folder(session, folder).await?;

    with_timeout(
        async {
            let stream = session
                .uid_store(uid_set, &query)
                .await
                .map_err(|e| format!("UID STORE {folder} uids={uid_set} failed: {e}"))?;
            let _: Vec<_> = stream.collect().await;
            Ok(())
        },
        IMAP_CMD_TIMEOUT,
        &format!("UID STORE {folder} uids={uid_set}"),
    )
    .await
}

/// Move messages between folders: UID MOVE when supported, otherwise
/// COPY + \Deleted + EXPUNGE (UID EXPUNGE with a plain EXPUNGE fallback).
pub async fn move_message(
    session: &mut ImapSession,
    source_folder: &str,
    uid_set: &str,
    dest_folder: &str,
) -> Result<(), String> {
    select_folder(session, source_folder).await?;

    let uid_move = with_timeout(
        async { Ok::<_, String>(session.uid_mv(uid_set, dest_folder).await) },
        IMAP_CMD_TIMEOUT,
        &format!("UID MOVE {source_folder} -> {dest_folder} uids={uid_set}"),
    )
    .await?;

    if let Ok(()) = uid_move {
        return Ok(());
    }

    log::warn!(
        "UID MOVE {source_folder} -> {dest_folder} uids={uid_set} failed: {}; falling back to COPY+STORE+EXPUNGE",
        uid_move.unwrap_err()
    );

    with_timeout(
        async {
            session
                .uid_copy(uid_set, dest_folder)
                .await
                .map_err(|e| format!("UID COPY {source_folder} -> {dest_folder} failed: {e}"))
        },
        IMAP_CMD_TIMEOUT,
        &format!("UID COPY {source_folder} -> {dest_folder}"),
    )
    .await?;

    with_timeout(
        async {
            let stream = session
                .uid_store(uid_set, "+FLAGS (\\Deleted)")
                .await
                .map_err(|e| format!("UID STORE +Deleted in {source_folder} failed: {e}"))?;
            let _: Vec<_> = stream.collect().await;
            Ok(())
        },
        IMAP_CMD_TIMEOUT,
        &format!("UID STORE +Deleted {source_folder}"),
    )
    .await?;

    expunge_uids(session, source_folder, uid_set).await
}

/// EXPUNGE the given UIDs (UID EXPUNGE when supported, plain EXPUNGE otherwise).
async fn expunge_uids(
    session: &mut ImapSession,
    folder: &str,
    uid_set: &str,
) -> Result<(), String> {
    let uid_expunged = with_timeout(
        async { Ok(session.uid_expunge(uid_set).await.is_ok()) },
        IMAP_CMD_TIMEOUT,
        &format!("UID EXPUNGE {folder} uids={uid_set}"),
    )
    .await?;

    if uid_expunged {
        return Ok(());
    }

    // Server lacks UIDPLUS: plain EXPUNGE removes all \Deleted messages.
    log::info!("UID EXPUNGE unsupported for {folder}, falling back to EXPUNGE");
    with_timeout(
        async {
            let stream = session
                .expunge()
                .await
                .map_err(|e| format!("EXPUNGE {folder} failed: {e}"))?;
            let _: Vec<_> = stream.collect().await;
            Ok(())
        },
        IMAP_CMD_TIMEOUT,
        &format!("EXPUNGE {folder}"),
    )
    .await
}

/// Mark a UID set \Deleted and expunge it.
pub async fn delete_message(
    session: &mut ImapSession,
    folder: &str,
    uid_set: &str,
) -> Result<(), String> {
    select_folder(session, folder).await?;

    with_timeout(
        async {
            let stream = session
                .uid_store(uid_set, "+FLAGS (\\Deleted)")
                .await
                .map_err(|e| format!("UID STORE +Deleted in {folder} failed: {e}"))?;
            let _: Vec<_> = stream.collect().await;
            Ok(())
        },
        IMAP_CMD_TIMEOUT,
        &format!("UID STORE +Deleted {folder} uids={uid_set}"),
    )
    .await?;

    expunge_uids(session, folder, uid_set).await
}

/// Append a raw MIME message to a folder (e.g. filing sent mail).
/// Optionally apply flags, e.g. ["\\Seen", "\\Answered"].
pub async fn append_message(
    session: &mut ImapSession,
    folder: &str,
    raw_message: &[u8],
    flags: Option<&[String]>,
) -> Result<(), String> {
    let flags_str = flags.map(format_flags_for_store);

    with_timeout(
        async {
            session
                .append(folder, flags_str.as_deref(), None, raw_message)
                .await
                .map_err(|e| format!("APPEND to {folder} failed: {e}"))
        },
        IMAP_FETCH_TIMEOUT,
        &format!("APPEND to {folder}"),
    )
    .await
}

// ---------- Attachment content ----------

/// Encode raw bytes as standard base64 — the wire format for attachment
/// content over the Tauri JSON bridge (a `Vec<u8>` would serialize as a
/// heavy JSON number array).
pub(crate) fn encode_base64(data: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(data)
}

/// Reverse lookup for [`build_section_map`]: the mail-parser part index
/// whose IMAP MIME section path equals `part_id` (e.g. "1.2").
fn part_index_for_section(
    map: &std::collections::BTreeMap<usize, String>,
    part_id: &str,
) -> Option<usize> {
    map.iter()
        .find(|(_, section)| section.as_str() == part_id)
        .map(|(&idx, _)| idx)
}

/// Extract a part's decoded content bytes from a parsed message.
///
/// mail-parser has already undone the content-transfer-encoding, so the
/// returned bytes are the attachment's true binary content.
pub(crate) fn extract_part_bytes(
    message: &mail_parser::Message<'_>,
    part_idx: usize,
) -> Result<Vec<u8>, String> {
    let part = message
        .parts
        .get(part_idx)
        .ok_or_else(|| format!("part index {part_idx} out of range"))?;
    match &part.body {
        PartType::Binary(data) | PartType::InlineBinary(data) => Ok(data.as_ref().to_vec()),
        PartType::Text(text) => Ok(text.as_bytes().to_vec()),
        PartType::Html(html) => Ok(html.as_bytes().to_vec()),
        PartType::Message(nested) => Ok(nested.raw_message.as_ref().to_vec()),
        PartType::Multipart(_) => Err(format!(
            "part index {part_idx} is a multipart container, not a leaf part"
        )),
    }
}

/// Fetch one MIME part (attachment content) by UID and IMAP MIME section
/// path (`part_id`, e.g. "2" or "1.2" from ImapAttachment::part_id).
///
/// The full message is fetched with `BODY.PEEK[]` (no \Seen side effect),
/// parsed with mail-parser (which decodes the part's
/// content-transfer-encoding), and the requested part's bytes are returned
/// standard-base64-encoded for the JSON bridge.
pub async fn fetch_attachment(
    session: &mut ImapSession,
    folder: &str,
    uid: u32,
    part_id: &str,
) -> Result<String, String> {
    select_folder(session, folder).await?;

    let uid_str = uid.to_string();
    let fetches: Vec<Fetch> = with_timeout(
        async {
            let stream = session
                .uid_fetch(&uid_str, "BODY.PEEK[]")
                .await
                .map_err(|e| format!("UID FETCH attachment {folder} uid={uid} failed: {e}"))?;
            Ok::<_, String>(stream.collect::<Vec<_>>().await)
        },
        IMAP_FETCH_TIMEOUT,
        &format!("UID FETCH attachment {folder} uid={uid}"),
    )
    .await?
    .into_iter()
    .filter_map(|r| match r {
        Ok(f) => Some(f),
        Err(e) => {
            log::warn!("IMAP attachment stream error in {folder}: {e}");
            None
        }
    })
    .collect();

    let fetch = fetches
        .first()
        .ok_or_else(|| format!("no FETCH response for UID {uid} in {folder}"))?;
    let raw = fetch
        .body()
        .ok_or_else(|| format!("UID {uid} in {folder} has no body"))?;

    let parser = MessageParser::default();
    let message = parser
        .parse(raw)
        .ok_or_else(|| format!("failed to parse message UID {uid} in {folder}"))?;

    let section_map = build_section_map(&message);
    let part_idx = part_index_for_section(&section_map, part_id)
        .ok_or_else(|| format!("section {part_id} not found in message UID {uid}"))?;

    let data = extract_part_bytes(&message, part_idx)
        .map_err(|e| format!("section {part_id} of UID {uid}: {e}"))?;

    Ok(encode_base64(&data))
}

// ---------- Folder management (CREATE / RENAME / DELETE) ----------

/// Validate a mailbox name for the folder-management commands: non-empty
/// and free of control characters (NUL/CR/LF would break the IMAP command
/// line). Hierarchy delimiters ("/", ".") are legal and pass through —
/// the caller owns the server's delimiter convention.
pub(crate) fn validate_mailbox_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() {
        return Err("mailbox name must not be empty".to_string());
    }
    if name.chars().any(char::is_control) {
        return Err("mailbox name must not contain control characters".to_string());
    }
    Ok(())
}

/// CREATE a new mailbox (label creation for IMAP accounts). A server that
/// refuses (name exists, name invalid, no permission) surfaces its error
/// text ("ALREADYEXISTS", "TRYCREATE", ...).
pub async fn create_folder(session: &mut ImapSession, name: &str) -> Result<(), String> {
    validate_mailbox_name(name)?;
    with_timeout(
        async {
            session
                .create(name)
                .await
                .map_err(|e| format!("CREATE {name} failed: {e}"))
        },
        IMAP_CMD_TIMEOUT,
        &format!("CREATE {name}"),
    )
    .await
}

/// RENAME a mailbox (label rename for IMAP accounts). RFC 3501 servers
/// reject renaming a nonexistent source or onto an existing target; the
/// server's error text surfaces as-is.
pub async fn rename_folder(session: &mut ImapSession, from: &str, to: &str) -> Result<(), String> {
    validate_mailbox_name(from)?;
    validate_mailbox_name(to)?;
    with_timeout(
        async {
            session
                .rename(from, to)
                .await
                .map_err(|e| format!("RENAME {from} -> {to} failed: {e}"))
        },
        IMAP_CMD_TIMEOUT,
        &format!("RENAME {from} -> {to}"),
    )
    .await
}

/// DELETE a mailbox (label delete for IMAP accounts). Permanently removes
/// the mailbox and its messages (INBOX is protected by the server); a
/// server that refuses the delete (INBOX, special-use, \Noinferiors
/// parent with children on strict servers) surfaces its error text.
pub async fn delete_folder(session: &mut ImapSession, name: &str) -> Result<(), String> {
    validate_mailbox_name(name)?;
    with_timeout(
        async {
            session
                .delete(name)
                .await
                .map_err(|e| format!("DELETE {name} failed: {e}"))
        },
        IMAP_CMD_TIMEOUT,
        &format!("DELETE {name}"),
    )
    .await
}

// ---------- Connection test ----------

fn capabilities_to_strings(caps: async_imap::types::Capabilities) -> Vec<String> {
    let mut out: Vec<String> = caps
        .iter()
        .map(|c| match c {
            Capability::Imap4rev1 => "IMAP4rev1".to_string(),
            Capability::Auth(a) => format!("AUTH={a}"),
            Capability::Atom(a) => a.clone(),
        })
        .collect();
    out.sort();
    out
}

/// Connect, log in, read server capabilities and count folders, then log out.
pub async fn test_connection(params: &ImapParams) -> Result<TestResult, String> {
    let mut session = connect(params).await?;

    let result: Result<TestResult, String> = async {
        let caps = with_timeout(
            async {
                session
                    .capabilities()
                    .await
                    .map_err(|e| format!("CAPABILITY failed: {e}"))
            },
            IMAP_CMD_TIMEOUT,
            "CAPABILITY",
        )
        .await?;
        let capabilities = capabilities_to_strings(caps);

        let stream = session
            .list(Some(""), Some("*"))
            .await
            .map_err(|e| format!("LIST failed: {e}"))?;
        let folder_count = stream.collect::<Vec<_>>().await.len();

        Ok(TestResult {
            host: params.host.clone(),
            port: params.port,
            security: params.security.as_str().to_string(),
            capabilities,
            folder_count,
        })
    }
    .await;

    logout(session).await;
    result
}

// ---------- Message parsing ----------

/// Normalize a Message-ID token to bracketed "<id>" form; None when empty.
fn normalize_id_token(id: &str) -> Option<String> {
    let t = id.trim();
    if t.is_empty() {
        None
    } else {
        Some(bracket_message_id(t))
    }
}

/// mail-parser strips angle brackets from ids; restore the canonical "<id>"
/// form so threading fields match raw header text.
fn bracket_message_id(id: &str) -> String {
    if id.starts_with('<') {
        id.to_string()
    } else {
        format!("<{id}>")
    }
}

/// Parse a raw RFC 822 message into an [`ImapMessage`].
///
/// `internal_date` (IMAP INTERNALDATE, unix seconds) is used as a fallback
/// when the Date header is missing or unparseable.
pub(crate) fn parse_raw_message(
    raw: &[u8],
    uid: u32,
    flags: Vec<String>,
    internal_date: Option<i64>,
) -> Result<ImapMessage, String> {
    let parser = MessageParser::default();
    let message = parser
        .parse(raw)
        .ok_or_else(|| "failed to parse MIME message".to_string())?;

    let message_id = message
        .message_id()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(bracket_message_id);
    let subject = message.subject().map(|s| s.to_string());

    let in_reply_to = match message.in_reply_to() {
        mail_parser::HeaderValue::Text(t) => normalize_id_token(t),
        mail_parser::HeaderValue::TextList(list) => {
            list.first().and_then(|s| normalize_id_token(s.as_ref()))
        }
        _ => None,
    };

    let references = match message.references() {
        mail_parser::HeaderValue::Text(t) => normalize_id_token(t),
        mail_parser::HeaderValue::TextList(list) => {
            let ids: Vec<String> = list
                .iter()
                .filter_map(|s| normalize_id_token(s.as_ref()))
                .collect();
            if ids.is_empty() {
                None
            } else {
                Some(ids.join(" "))
            }
        }
        _ => None,
    };

    let date = message
        .date()
        .map(|d| d.to_timestamp())
        .or(internal_date)
        .unwrap_or(0);

    let text_body = message.body_text(0).map(|s| s.to_string());
    let html_body = message.body_html(0).map(|s| s.to_string());

    // Map mail-parser part indices to IMAP MIME section paths so attachment
    // content can be fetched by section later (e.g. BODY.PEEK[2]).
    let section_map = build_section_map(&message);

    let attachments = message
        .attachments
        .iter()
        .filter_map(|&part_idx| {
            let idx = part_idx as usize;
            let part = message.parts.get(idx)?;
            let part_id = section_map
                .get(&idx)
                .cloned()
                .unwrap_or_else(|| (part_idx + 1).to_string());

            let mime_type = part
                .content_type()
                .map(|ct| {
                    let ctype = ct.ctype();
                    let subtype = ct.subtype().unwrap_or("octet-stream");
                    format!("{ctype}/{subtype}")
                })
                .unwrap_or_else(|| "application/octet-stream".to_string());

            Some(ImapAttachment {
                part_id,
                filename: part.attachment_name().unwrap_or("attachment").to_string(),
                mime_type,
                size: part.len() as u32,
                content_id: part.content_id().map(|s| s.to_string()),
                is_inline: part.content_disposition().is_some_and(|cd| cd.is_inline()),
            })
        })
        .collect();

    Ok(ImapMessage {
        uid,
        flags,
        message_id,
        in_reply_to,
        references,
        subject,
        from: addresses(message.from()),
        to: addresses(message.to()),
        cc: addresses(message.cc()),
        bcc: addresses(message.bcc()),
        date,
        text_body,
        html_body,
        size: raw.len() as u32,
        attachments,
    })
}

/// Map mail-parser part indices to IMAP MIME section paths.
///
/// IMAP numbers children of multipart containers from 1 ("1", "2", "1.2", ...);
/// a non-multipart message's single body is section "1".
pub(crate) fn build_section_map(
    message: &mail_parser::Message<'_>,
) -> std::collections::BTreeMap<usize, String> {
    let mut map = std::collections::BTreeMap::new();

    fn walk(
        parts: &[mail_parser::MessagePart],
        part_idx: usize,
        prefix: &str,
        map: &mut std::collections::BTreeMap<usize, String>,
    ) {
        let Some(part) = parts.get(part_idx) else {
            return;
        };
        if let PartType::Multipart(children) = &part.body {
            for (i, &child_idx) in children.iter().enumerate() {
                let section = if prefix.is_empty() {
                    (i + 1).to_string()
                } else {
                    format!("{prefix}.{}", i + 1)
                };
                walk(parts, child_idx as usize, &section, map);
            }
        } else {
            let section = if prefix.is_empty() { "1" } else { prefix };
            map.insert(part_idx, section.to_string());
        }
    }

    if !message.parts.is_empty() {
        walk(&message.parts, 0, "", &mut map);
    }
    map
}

/// Convert a mail-parser address field into our address list.
fn addresses(addr: Option<&mail_parser::Address<'_>>) -> Vec<ImapAddress> {
    let Some(addr) = addr else {
        return Vec::new();
    };
    addr.iter()
        .map(|a| ImapAddress {
            name: a.name.as_deref().map(|s| s.to_string()),
            email: a.address.as_deref().map(|s| s.to_string()),
        })
        .collect()
}

// ---------- UID set helpers ----------

/// UID set selecting the last `count` messages of a mailbox, given the
/// mailbox's UIDNEXT (from SELECT). Returns None when the mailbox is empty
/// or `count` is 0.
pub(crate) fn last_n_uid_set(uid_next: u32, count: u32) -> Option<String> {
    if count == 0 || uid_next <= 1 {
        return None;
    }
    let start = uid_next.saturating_sub(count).max(1);
    Some(format!("{start}:*"))
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn attrs(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    // ----- Folder role mapping -----

    #[test]
    fn role_from_rfc6154_attributes() {
        assert_eq!(
            resolve_folder_role(&attrs(&["\\Sent"]), "Stuff"),
            Some(FolderRole::Sent)
        );
        assert_eq!(
            resolve_folder_role(&attrs(&["\\Drafts"]), "X"),
            Some(FolderRole::Drafts)
        );
        assert_eq!(
            resolve_folder_role(&attrs(&["\\Trash"]), "X"),
            Some(FolderRole::Trash)
        );
        assert_eq!(
            resolve_folder_role(&attrs(&["\\Junk"]), "X"),
            Some(FolderRole::Junk)
        );
        assert_eq!(
            resolve_folder_role(&attrs(&["\\Archive"]), "X"),
            Some(FolderRole::Archive)
        );
        assert_eq!(
            resolve_folder_role(&attrs(&["\\All"]), "X"),
            Some(FolderRole::All)
        );
        assert_eq!(
            resolve_folder_role(&attrs(&["\\Flagged"]), "X"),
            Some(FolderRole::Flagged)
        );
        assert_eq!(
            resolve_folder_role(&attrs(&["\\Inbox"]), "X"),
            Some(FolderRole::Inbox)
        );
    }

    #[test]
    fn role_attribute_is_case_insensitive_and_takes_priority() {
        assert_eq!(
            resolve_folder_role(&attrs(&["\\sent"]), "X"),
            Some(FolderRole::Sent)
        );
        assert_eq!(
            resolve_folder_role(&attrs(&["\\NoSelect", "\\Trash"]), "INBOX"),
            Some(FolderRole::Trash)
        );
        // A non-role attribute alone must not produce a role.
        assert_eq!(resolve_folder_role(&attrs(&["\\NoSelect"]), "Random"), None);
    }

    #[test]
    fn role_from_well_known_names() {
        assert_eq!(resolve_folder_role(&[], "INBOX"), Some(FolderRole::Inbox));
        assert_eq!(resolve_folder_role(&[], "inbox"), Some(FolderRole::Inbox));
        assert_eq!(resolve_folder_role(&[], "Sent"), Some(FolderRole::Sent));
        assert_eq!(
            resolve_folder_role(&[], "Sent Messages"),
            Some(FolderRole::Sent)
        );
        assert_eq!(
            resolve_folder_role(&[], "Sent Items"),
            Some(FolderRole::Sent)
        );
        assert_eq!(
            resolve_folder_role(&[], "[Gmail]/Sent Mail"),
            Some(FolderRole::Sent)
        );
        assert_eq!(resolve_folder_role(&[], "Drafts"), Some(FolderRole::Drafts));
        assert_eq!(
            resolve_folder_role(&[], "Deleted Items"),
            Some(FolderRole::Trash)
        );
        assert_eq!(resolve_folder_role(&[], "Bin"), Some(FolderRole::Trash));
        assert_eq!(resolve_folder_role(&[], "Spam"), Some(FolderRole::Junk));
        assert_eq!(
            resolve_folder_role(&[], "Junk E-mail"),
            Some(FolderRole::Junk)
        );
        assert_eq!(
            resolve_folder_role(&[], "Archives"),
            Some(FolderRole::Archive)
        );
        assert_eq!(
            resolve_folder_role(&[], "[Gmail]/All Mail"),
            Some(FolderRole::All)
        );
        assert_eq!(
            resolve_folder_role(&[], "Starred"),
            Some(FolderRole::Flagged)
        );
    }

    #[test]
    fn role_fallback_matches_last_segment_only() {
        assert_eq!(resolve_folder_role(&[], "Archive/2024/Stuff"), None);
        assert_eq!(
            resolve_folder_role(&[], "MailArchive/Archive"),
            Some(FolderRole::Archive)
        );
        assert_eq!(
            resolve_folder_role(&[], "Customers/Sent"),
            Some(FolderRole::Sent)
        );
    }

    #[test]
    fn role_unknown_folder_is_none() {
        assert_eq!(resolve_folder_role(&[], "Random"), None);
        assert_eq!(
            resolve_folder_role(&attrs(&["\\HasNoChildren"]), "Projects"),
            None
        );
    }

    #[test]
    fn selectability() {
        assert!(is_selectable(&attrs(&[])));
        assert!(is_selectable(&attrs(&["\\Marked"])));
        assert!(!is_selectable(&attrs(&["\\NoSelect"])));
        assert!(!is_selectable(&attrs(&["\\NonExistent"])));
    }

    #[test]
    fn role_attribute_strings() {
        assert_eq!(FolderRole::Sent.as_attribute(), "\\Sent");
        assert_eq!(FolderRole::Trash.as_attribute(), "\\Trash");
        assert_eq!(FolderRole::Inbox.as_attribute(), "\\Inbox");
    }

    // ----- UID set helpers -----

    #[test]
    fn last_n_uid_set_edges() {
        assert_eq!(last_n_uid_set(105, 20).as_deref(), Some("85:*"));
        assert_eq!(last_n_uid_set(10, 20).as_deref(), Some("1:*"));
        assert_eq!(last_n_uid_set(2, 1).as_deref(), Some("1:*"));
        assert_eq!(last_n_uid_set(105, 0), None);
        assert_eq!(last_n_uid_set(0, 5), None);
        assert_eq!(last_n_uid_set(1, 5), None); // empty mailbox
    }

    fn status(uid_next: u32) -> FolderStatus {
        FolderStatus {
            uid_validity: 1,
            uid_next,
            exists: uid_next.saturating_sub(1),
            unseen: 0,
            highest_modseq: None,
        }
    }

    // ----- CONDSTORE (RFC 7162) helpers -----

    #[test]
    fn condstore_capability_detection() {
        assert!(supports_condstore(&["CONDSTORE".to_string()]));
        assert!(supports_condstore(&[
            "IMAP4rev1".to_string(),
            "QRESYNC".to_string(),
            "CONDSTORE".to_string()
        ]));
        assert!(supports_condstore(&["condstore".to_string()]));
        assert!(!supports_condstore(&[
            "IMAP4rev1".to_string(),
            "UIDPLUS".to_string()
        ]));
        assert!(!supports_condstore(&[]));
        // "UNCONDSTORE"-style atoms must not match.
        assert!(!supports_condstore(&["CONDSTOREX".to_string()]));
    }

    #[test]
    fn changed_since_query_building() {
        assert_eq!(changed_since_query(1), "(UID FLAGS) (CHANGEDSINCE 1)");
        assert_eq!(
            changed_since_query(123_456_789),
            "(UID FLAGS) (CHANGEDSINCE 123456789)"
        );
    }

    #[test]
    fn mailbox_modseq_reporting() {
        let mut mailbox = Mailbox::default();
        assert!(mailbox_modseq(&mailbox).is_err());
        mailbox.highest_modseq = Some(4711);
        assert_eq!(mailbox_modseq(&mailbox).unwrap(), 4711);
    }

    #[test]
    fn folder_status_mapping_carries_modseq_only_when_given() {
        let mailbox = Mailbox {
            uid_validity: Some(42),
            uid_next: Some(9),
            exists: 8,
            unseen: Some(3),
            highest_modseq: Some(77),
            ..Mailbox::default()
        };

        let plain = folder_status_from_mailbox(&mailbox, None);
        assert_eq!(plain.uid_validity, 42);
        assert_eq!(plain.uid_next, 9);
        assert_eq!(plain.exists, 8);
        assert_eq!(plain.unseen, 3);
        assert_eq!(plain.highest_modseq, None);

        let condstore = folder_status_from_mailbox(&mailbox, Some(77));
        assert_eq!(condstore.highest_modseq, Some(77));
    }

    #[test]
    fn uid_set_resolution_prefers_explicit_set() {
        assert_eq!(resolve_uid_set(" 5,9 ", None, &status(100)).unwrap(), "5,9");
        // Explicit set wins even when `last` is also given.
        assert_eq!(
            resolve_uid_set("5:9", Some(3), &status(100)).unwrap(),
            "5:9"
        );
    }

    #[test]
    fn uid_set_resolution_uses_last_with_uidnext() {
        assert_eq!(resolve_uid_set("", Some(20), &status(105)).unwrap(), "85:*");
        assert_eq!(resolve_uid_set("", Some(3), &status(4)).unwrap(), "1:*");
    }

    #[test]
    fn uid_set_resolution_errors_when_nothing_to_fetch() {
        assert!(resolve_uid_set("", None, &status(100)).is_err());
        assert!(resolve_uid_set("", Some(0), &status(100)).is_err());
        assert!(resolve_uid_set("", Some(5), &status(1)).is_err());
    }

    // ----- Flag helpers -----

    #[test]
    fn flag_normalization() {
        assert_eq!(normalize_flag("seen"), "\\Seen");
        assert_eq!(normalize_flag("SEEN"), "\\Seen");
        assert_eq!(normalize_flag("Seen"), "\\Seen");
        assert_eq!(normalize_flag("\\Seen"), "\\Seen");
        assert_eq!(normalize_flag("flagged"), "\\Flagged");
        assert_eq!(normalize_flag("draft"), "\\Draft");
        assert_eq!(normalize_flag("NonJunk"), "NonJunk");
        assert_eq!(normalize_flag(" $Label1 "), "$Label1");
    }

    #[test]
    fn store_flag_formatting() {
        assert_eq!(
            format_flags_for_store(&["seen".to_string(), "NonJunk".to_string()]),
            "(\\Seen NonJunk)"
        );
        assert_eq!(format_flags_for_store(&[]), "()");
    }

    // ----- Folder management helpers -----

    #[test]
    fn mailbox_name_validation() {
        assert!(validate_mailbox_name("Work").is_ok());
        assert!(validate_mailbox_name("Archive/2024").is_ok());
        assert!(validate_mailbox_name("Sent.Drafts").is_ok());
        // Deliberate whitespace names survive; empty/blank ones do not.
        assert!(validate_mailbox_name("  Projects  ").is_ok());
        assert!(validate_mailbox_name("").is_err());
        assert!(validate_mailbox_name("   ").is_err());
        // Control characters would break the IMAP command line.
        assert!(validate_mailbox_name("Bad\nName").is_err());
        assert!(validate_mailbox_name("Bad\rName").is_err());
        assert!(validate_mailbox_name("Bad\0Name").is_err());
    }

    // ----- MIME parsing -----

    const MULTIPART_MIME: &str = concat!(
        "From: Alice Example <alice@example.com>\r\n",
        "To: Bob <bob@example.com>, carol@example.net\r\n",
        "Cc: cc@example.com\r\n",
        "Bcc: bcc@example.com\r\n",
        "Subject: Hello World\r\n",
        "Date: Mon, 13 Jan 2025 10:00:00 +0000\r\n",
        "Message-ID: <msg-1@example.com>\r\n",
        "In-Reply-To: <msg-0@example.com>\r\n",
        "References: <msg-0@example.com> <msg-0b@example.com>\r\n",
        "MIME-Version: 1.0\r\n",
        "Content-Type: multipart/mixed; boundary=\"BOUND\"\r\n",
        "\r\n",
        "--BOUND\r\n",
        "Content-Type: multipart/alternative; boundary=\"ALT\"\r\n",
        "\r\n",
        "--ALT\r\n",
        "Content-Type: text/plain; charset=utf-8\r\n",
        "\r\n",
        "Hello plain body.\r\n",
        "--ALT\r\n",
        "Content-Type: text/html; charset=utf-8\r\n",
        "\r\n",
        "<p>Hello html body.</p>\r\n",
        "--ALT--\r\n",
        "--BOUND\r\n",
        "Content-Type: application/pdf\r\n",
        "Content-Disposition: attachment; filename=\"report.pdf\"\r\n",
        "Content-Transfer-Encoding: base64\r\n",
        "Content-ID: <att-1@example.com>\r\n",
        "\r\n",
        "JVBERi0xLjQ=\r\n",
        "--BOUND--\r\n",
    );

    #[test]
    fn parse_multipart_message_headers_and_bodies() {
        let msg = parse_raw_message(MULTIPART_MIME.as_bytes(), 42, vec!["\\Seen".into()], None)
            .expect("parse should succeed");

        assert_eq!(msg.uid, 42);
        assert_eq!(msg.flags, vec!["\\Seen".to_string()]);
        assert_eq!(msg.subject.as_deref(), Some("Hello World"));
        assert_eq!(msg.message_id.as_deref(), Some("<msg-1@example.com>"));
        assert_eq!(msg.in_reply_to.as_deref(), Some("<msg-0@example.com>"));
        assert_eq!(
            msg.references.as_deref(),
            Some("<msg-0@example.com> <msg-0b@example.com>")
        );

        assert_eq!(msg.from.len(), 1);
        assert_eq!(msg.from[0].name.as_deref(), Some("Alice Example"));
        assert_eq!(msg.from[0].email.as_deref(), Some("alice@example.com"));

        assert_eq!(msg.to.len(), 2);
        assert_eq!(msg.to[0].email.as_deref(), Some("bob@example.com"));
        assert_eq!(msg.to[1].email.as_deref(), Some("carol@example.net"));
        assert_eq!(msg.cc.len(), 1);
        assert_eq!(msg.bcc.len(), 1);

        assert_eq!(msg.date, 1_736_762_400); // 2025-01-13 10:00:00 UTC
        assert_eq!(msg.text_body.as_deref(), Some("Hello plain body."));
        assert!(msg
            .html_body
            .as_deref()
            .unwrap_or("")
            .contains("Hello html body."));
        assert_eq!(msg.size, MULTIPART_MIME.len() as u32);
    }

    #[test]
    fn parse_multipart_message_attachment_metadata() {
        let msg = parse_raw_message(MULTIPART_MIME.as_bytes(), 7, vec![], None)
            .expect("parse should succeed");

        assert_eq!(msg.attachments.len(), 1);
        let att = &msg.attachments[0];
        assert_eq!(att.part_id, "2"); // second child of the root multipart
        assert_eq!(att.filename, "report.pdf");
        assert_eq!(att.mime_type, "application/pdf");
        assert!(!att.is_inline);
        assert!(att
            .content_id
            .as_deref()
            .unwrap_or("")
            .contains("att-1@example.com"));
        assert!(att.size > 0);
    }

    #[test]
    fn parse_falls_back_to_internal_date() {
        let msg = parse_raw_message(
            b"Subject: no date here\r\n\r\nbody",
            9,
            vec![],
            Some(1_700_000_000),
        )
        .expect("parse should succeed");
        assert_eq!(msg.date, 1_700_000_000);
    }

    #[test]
    fn parse_simple_message_section_map() {
        let msg = parse_raw_message(b"Subject: plain\r\n\r\njust text", 1, vec![], None)
            .expect("parse should succeed");
        assert_eq!(msg.attachments.len(), 0);
        assert_eq!(msg.text_body.as_deref(), Some("just text"));
    }

    #[test]
    fn section_map_for_nested_multipart() {
        let parser = MessageParser::default();
        let message = parser
            .parse(MULTIPART_MIME.as_bytes())
            .expect("parse should succeed");
        let map = build_section_map(&message);

        // Root (0) is multipart/mixed [1 (multipart/alternative [2, 3]), 4 (pdf)].
        assert_eq!(map.get(&0), None); // containers get no section of their own
        assert_eq!(map.get(&2).map(String::as_str), Some("1.1"));
        assert_eq!(map.get(&3).map(String::as_str), Some("1.2"));
        assert_eq!(map.get(&4).map(String::as_str), Some("2"));
    }

    // ----- Attachment content helpers -----

    #[test]
    fn part_index_lookup_by_section_path() {
        let parser = MessageParser::default();
        let message = parser
            .parse(MULTIPART_MIME.as_bytes())
            .expect("parse should succeed");
        let map = build_section_map(&message);

        assert_eq!(part_index_for_section(&map, "2"), Some(4));
        assert_eq!(part_index_for_section(&map, "1.1"), Some(2));
        assert_eq!(part_index_for_section(&map, "9"), None);
        assert_eq!(part_index_for_section(&map, ""), None);
    }

    #[test]
    fn extract_part_bytes_decodes_transfer_encoding() {
        let parser = MessageParser::default();
        let message = parser
            .parse(MULTIPART_MIME.as_bytes())
            .expect("parse should succeed");

        // The pdf part is base64 transfer-encoded; extraction must yield
        // the decoded bytes ("JVBERi0xLjQ=" is "%PDF-1.4").
        let bytes = extract_part_bytes(&message, 4).expect("extraction should succeed");
        assert_eq!(bytes, b"%PDF-1.4");

        // Text part passes through as its bytes.
        let text = extract_part_bytes(&message, 2).expect("extraction should succeed");
        assert_eq!(text, b"Hello plain body.");

        // Out-of-range part index errors instead of panicking.
        assert!(extract_part_bytes(&message, 99).is_err());
        // Multipart containers are rejected.
        assert!(extract_part_bytes(&message, 0).is_err());
    }

    #[test]
    fn base64_encoding_round_trip() {
        assert_eq!(encode_base64(b"%PDF-1.4"), "JVBERi0xLjQ=");
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        let raw: Vec<u8> = (0..=255u8).collect();
        assert_eq!(encode_base64(&raw).len() % 4, 0);
    }
}
