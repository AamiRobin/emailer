//! CalDAV transport (task 5.2, design D5): ONE generic HTTP request with
//! an arbitrary method (`PROPFIND` / `REPORT` — `ai::http::post_json` is
//! POST-only), extra headers (the Basic `Authorization` header lives
//! here) and a body, over the same hand-rolled TCP + native-tls stack.
//!
//! URL parsing and response decoding (chunked bodies, status line) are
//! REUSED from `ai::http` — those helpers are `pub(crate)`, so this file
//! only owns the connect/write/read sequence (mirroring `ai::http`'s
//! private `Conn` enum) and the CalDAV-specific caps. `net.rs` stays
//! untouched.
//!
//! Transport policy is inherited verbatim from `ai::http::parse_request_url`:
//! HTTPS everywhere except loopback hosts (which is what makes the
//! mock-server cargo tests possible without TLS). Redirects are NOT
//! followed; 3xx surfaces as a status error (see `mod.rs` — replaying
//! Basic-auth credentials to a redirect target is exactly what we must
//! not do).

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_native_tls::native_tls;
use tokio_native_tls::TlsConnector as TokioTlsConnector;

use super::CaldavError;
use crate::ai::http::{parse_request_url, parse_response, RequestUrl};

/// Connect budget (same split as the AI client).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Total budget for TLS + request write + response read. A full sync of a
/// large calendar is the slowest CalDAV call, so this is generous — but a
/// hung endpoint still fails deterministically.
const TOTAL_TIMEOUT: Duration = Duration::from_secs(120);

/// One CalDAV response: status plus body (chunked decoding applied).
/// `etag` carries the raw `ETag` response header when the server sent one
/// (parity-round-2 task 4.1: the CardDAV write flows need it; the CalDAV
/// flows never read it).
#[derive(Debug, Clone)]
pub(crate) struct RawResponse {
    pub status: u16,
    pub body: String,
    pub etag: Option<String>,
}

/// The connection: plaintext TCP or TLS-wrapped TCP (same small enum as
/// `ai::http`'s private one, so the write/read sequence reads once).
enum Conn {
    Plain(TcpStream),
    Tls(tokio_native_tls::TlsStream<TcpStream>),
}

impl Conn {
    async fn write_all(&mut self, data: &[u8]) -> std::io::Result<()> {
        match self {
            Conn::Plain(stream) => stream.write_all(data).await,
            Conn::Tls(stream) => stream.write_all(data).await,
        }
    }

    async fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Conn::Plain(stream) => stream.flush().await,
            Conn::Tls(stream) => stream.flush().await,
        }
    }

    async fn read_capped(&mut self, cap: u64) -> std::io::Result<Vec<u8>> {
        let mut out = Vec::new();
        match self {
            Conn::Plain(stream) => {
                let mut limited = stream.take(cap);
                limited.read_to_end(&mut out).await?;
            }
            Conn::Tls(stream) => {
                let mut limited = stream.take(cap);
                limited.read_to_end(&mut out).await?;
            }
        }
        Ok(out)
    }
}

/// Issue one HTTP request with an arbitrary method, body and extra
/// headers (Content-Length/Connection/Host are added here; Content-Type
/// and Authorization come in via `extra_headers`). Reads the whole
/// response with a cap of [`super::MAX_RESPONSE_BYTES`]. Never logs,
/// never embeds request bytes (and so never credentials) in errors.
pub(crate) async fn request_raw(
    method: &str,
    url: &str,
    extra_headers: &[(&str, &str)],
    body: &str,
) -> Result<RawResponse, CaldavError> {
    let parsed: RequestUrl = parse_request_url(url)?;
    let payload = body.as_bytes();

    let mut request = format!(
        "{method} {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: emailer\r\nContent-Length: {}\r\nConnection: close\r\n",
        parsed.target,
        parsed.host_header(),
        payload.len()
    );
    for (name, value) in extra_headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("\r\n");
    // The body itself — Content-Length above advertises exactly these
    // bytes.
    request.push_str(body);

    let tcp = tokio::time::timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((parsed.host.as_str(), parsed.port)),
    )
    .await
    .map_err(|_| CaldavError::Network(format!("connect to {} timed out", parsed.host)))?
    .map_err(|error| CaldavError::Network(format!("connect to {} failed: {error}", parsed.host)))?;

    let mut conn = {
        let handshake = async {
            if !parsed.https {
                return Ok(Conn::Plain(tcp));
            }
            let connector = TokioTlsConnector::from(
                native_tls::TlsConnector::builder()
                    .build()
                    .map_err(|error| {
                        CaldavError::Network(format!("failed to create TLS connector: {error}"))
                    })?,
            );
            // Certificate and hostname verification stay on unconditionally.
            let tls = connector
                .connect(&parsed.host, tcp)
                .await
                .map_err(|error| CaldavError::Network(format!("TLS handshake failed: {error}")))?;
            Ok::<Conn, CaldavError>(Conn::Tls(tls))
        };
        tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, handshake)
            .await
            .map_err(|_| CaldavError::Network("TLS handshake timed out".to_string()))??
    };

    let exchange = async {
        conn.write_all(request.as_bytes())
            .await
            .map_err(|error| CaldavError::Network(format!("sending the request failed: {error}")))?;
        conn.flush()
            .await
            .map_err(|error| CaldavError::Network(format!("flushing the request failed: {error}")))?;
        // +1 so an over-cap response is detectable instead of silently
        // truncated into a confusing parse error.
        conn.read_capped(super::MAX_RESPONSE_BYTES + 1)
            .await
            .map_err(|error| CaldavError::Network(format!("reading the response failed: {error}")))
    };
    let raw = tokio::time::timeout(TOTAL_TIMEOUT, exchange)
        .await
        .map_err(|_| CaldavError::Network("response timed out".to_string()))??;

    if raw.len() as u64 > super::MAX_RESPONSE_BYTES {
        return Err(CaldavError::Network(format!(
            "response exceeded the {} MiB cap",
            super::MAX_RESPONSE_BYTES / (1024 * 1024)
        )));
    }

    // Response decoding (status line, chunked bodies, lossy UTF-8) is the
    // shared `ai::http` logic.
    let response = parse_response(&raw)?;
    Ok(RawResponse {
        status: response.status,
        body: response.body,
        etag: response.etag,
    })
}

/// Rebuild an absolute URL for `href` (as returned in multistatus
/// responses) against the request base. Handles the three forms servers
/// actually emit: absolute URIs, absolute paths (`/dav/user/…`), and
/// (rare) relative references resolved against the base's directory.
pub(crate) fn join_url(base: &RequestUrl, href: &str) -> Result<String, CaldavError> {
    let href = href.trim();
    if href.is_empty() {
        return Err(CaldavError::Parse("empty href in multistatus".to_string()));
    }
    if href.contains("://") {
        return Ok(href.to_string());
    }
    let authority = base.host_header();
    // Path form: absolute paths as-is; relative references resolved
    // against the base target's directory (RFC 3986 §5.2, merge form —
    // the one case collections hit). Always yields a leading "/".
    let path = if let Some(stripped) = href.strip_prefix('/') {
        format!("/{stripped}")
    } else {
        let dir = match base.target.rfind('/') {
            Some(index) => &base.target[..=index],
            None => "/",
        };
        format!("{}{}", dir, href)
    };
    let scheme = if base.https { "https" } else { "http" };
    Ok(format!("{scheme}://{authority}{path}"))
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::join_url;
    use crate::ai::http::parse_request_url;

    #[test]
    fn join_url_handles_absolute_paths_and_uris() {
        let base = parse_request_url("https://dav.example.com:8443/").unwrap();
        // The dominant form (Radicale, Nextcloud, Fastmail all emit
        // absolute paths).
        assert_eq!(
            join_url(&base, "/dav/user/calendars/").unwrap(),
            "https://dav.example.com:8443/dav/user/calendars/"
        );
        // Absolute URIs pass through untouched.
        assert_eq!(
            join_url(&base, "https://other.example.com/x.ics").unwrap(),
            "https://other.example.com/x.ics"
        );
        // Default ports stay implicit.
        let base = parse_request_url("https://dav.example.com/dav/").unwrap();
        assert_eq!(
            join_url(&base, "/user/home/").unwrap(),
            "https://dav.example.com/user/home/"
        );
    }

    #[test]
    fn join_url_resolves_relative_references_against_the_base_dir() {
        let base = parse_request_url("https://dav.example.com/dav/user/").unwrap();
        assert_eq!(
            join_url(&base, "calendars/home.ics/").unwrap(),
            "https://dav.example.com/dav/user/calendars/home.ics/"
        );
    }

    #[test]
    fn join_url_rejects_empty_hrefs() {
        let base = parse_request_url("https://dav.example.com/").unwrap();
        assert!(join_url(&base, "   ").is_err());
    }
}
