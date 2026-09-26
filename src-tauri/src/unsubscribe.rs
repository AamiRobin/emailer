//! One-Click List-Unsubscribe (RFC 8058): the mail list layer hands the
//! `List-Unsubscribe-Post` header's URL here and the webview invokes
//! [`unsubscribe_one_click_post`] — the webview's own fetch would need a
//! CSP `connect-src` grant to an arbitrary host, so the POST lives
//! Rust-side like every other outbound protocol.
//!
//! The command is deliberately minimal and strict:
//! - the URL must be a clean `https://` URL (no userinfo, no fragment, no
//!   control characters or whitespace anywhere, a host present) — the
//!   URL comes from a mail HEADER, i.e. from a potentially hostile
//!   sender, so anything that could shape the request line is refused;
//! - the POST carries exactly RFC 8058's body
//!   (`List-Unsubscribe=One-Click`, `application/x-www-form-urlencoded`)
//!   and NO credentials or cookies of any kind;
//! - redirects are NOT followed (a 3xx status is returned as-is — the
//!   one-click POST must never be replayed against a `Location` target);
//! - the whole exchange runs under one 10 s budget, and the response
//!   read is capped (headers + a small body slice, then discarded) so a
//!   hostile endpoint cannot stream forever.
//!
//! Only the HTTP STATUS crosses back to the webview; transport failures
//! surface as `Err` text.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_native_tls::native_tls;
use tokio_native_tls::TlsConnector as TokioTlsConnector;

use crate::ai::http::parse_response;

/// Total budget for connect + TLS + request write + response read (the
/// caller keeps its UI; an unsubscribe must never hang it).
const TOTAL_TIMEOUT: Duration = Duration::from_secs(10);
/// Response read cap: response HEADERS plus a ≤64 KiB body slice, then
/// the stream is dropped. Only the status line is used — the body is
/// read solely so the exchange completes and then discarded.
const MAX_RESPONSE_BYTES: u64 = 64 * 1024 + 16 * 1024;
/// RFC 8058 §3.1's fixed POST body.
const ONE_CLICK_BODY: &str = "List-Unsubscribe=One-Click";

/// One validated unsubscribe target: where to connect and what to send.
#[derive(Debug, PartialEq, Eq)]
struct UnsubscribeTarget {
    host: String,
    port: u16,
    /// Request target: path + query.
    target: String,
}

/// Validate a List-Unsubscribe-Post URL (RFC 8058 §3.1: "a HTTPS URL").
/// The URL arrives from a mail header, so every check is about not
/// letting header bytes shape the request: `https://` only (lowercase,
/// as URLs in the wild spell it), no userinfo (`user:pass@`), no
/// fragment, no control characters or whitespace ANYWHERE, and a host
/// (with a valid port when one is spelled). Pure — no network, no I/O.
fn validate_unsubscribe_url(url: &str) -> Result<UnsubscribeTarget, String> {
    if url.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(
            "the unsubscribe URL must not contain control characters or whitespace".to_string(),
        );
    }
    if url.contains('#') {
        return Err("the unsubscribe URL must not contain a fragment".to_string());
    }
    let rest = url
        .strip_prefix("https://")
        .ok_or_else(|| "the unsubscribe URL must use the https scheme".to_string())?;
    // Authority ends at the first '/' (path) or '?' (query-only URL —
    // RFC 3986 allows `https://host?x=y`; the query becomes the target
    // with an empty path spelled as '/').
    let (authority, target) = match rest.find(|c| c == '/' || c == '?') {
        Some(index) => {
            let target = if rest.as_bytes()[index] == b'?' {
                format!("/{}", &rest[index..])
            } else {
                rest[index..].to_string()
            };
            (&rest[..index], target)
        }
        None => (rest, "/".to_string()),
    };
    if authority.contains('@') {
        return Err(
            "the unsubscribe URL must not contain userinfo (user:pass@)".to_string(),
        );
    }
    // Host[:port], with IPv6 bracket notation handled explicitly.
    let (host, port) = if let Some(stripped) = authority.strip_prefix('[') {
        let (inside, after) = stripped
            .split_once(']')
            .ok_or_else(|| "malformed IPv6 host in the unsubscribe URL".to_string())?;
        let port = match after.strip_prefix(':') {
            Some(port) => port
                .parse::<u16>()
                .map_err(|_| "invalid port in the unsubscribe URL".to_string())?,
            None if after.is_empty() => 443,
            None => return Err("malformed IPv6 host in the unsubscribe URL".to_string()),
        };
        (inside.to_string(), port)
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) => {
                let port = port
                    .parse::<u16>()
                    .map_err(|_| "invalid port in the unsubscribe URL".to_string())?;
                (host.to_string(), port)
            }
            None => (authority.to_string(), 443),
        }
    };

    if host.is_empty() {
        return Err("the unsubscribe URL must have a host".to_string());
    }
    Ok(UnsubscribeTarget {
        host,
        port,
        target,
    })
}

/// The `Host` request-header value: RFC 9110 §7.2 brackets IPv6
/// literals, and the `:port` suffix is omitted for the default port.
fn build_host_header(host: &str, port: u16) -> String {
    if host.contains(':') {
        if port == 443 {
            format!("[{host}]")
        } else {
            format!("[{host}]:{port}")
        }
    } else if port == 443 {
        host.to_string()
    } else {
        format!("{host}:{port}")
    }
}

/// Byte offset of the end of the response header block (`\r\n\r\n`),
/// if the buffered bytes contain it.
fn find_header_end(raw: &[u8]) -> Option<usize> {
    raw.windows(4).position(|window| window == b"\r\n\r\n")
}

/// Issue the one-click POST and return the HTTP status code (2xx means
/// unsubscribed per RFC 8058; 3xx is returned, NOT followed; any
/// transport/TLS/timeout failure is an `Err`).
#[tauri::command]
pub async fn unsubscribe_one_click_post(url: String) -> Result<u16, String> {
    let target = validate_unsubscribe_url(&url)?;

    let exchange = async {
        let tcp = TcpStream::connect((target.host.as_str(), target.port))
            .await
            .map_err(|error| {
                format!("unsubscribe connect to {} failed: {error}", target.host)
            })?;
        // Certificate and hostname verification stay on (the same
        // connector posture as avatar.rs / the DAV clients).
        let connector = TokioTlsConnector::from(
            native_tls::TlsConnector::builder()
                .build()
                .map_err(|error| format!("failed to create TLS connector: {error}"))?,
        );
        let mut stream = connector
            .connect(&target.host, tcp)
            .await
            .map_err(|_| format!("unsubscribe TLS handshake with {} failed", target.host))?;

        let host_header = build_host_header(&target.host, target.port);
        // Exactly RFC 8058's POST: the fixed body, the form content
        // type, and nothing else — no credentials, no cookies.
        let request = format!(
            "POST {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: emailer\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            target.target,
            host_header,
            ONE_CLICK_BODY.len(),
            ONE_CLICK_BODY
        );
        stream
            .write_all(request.as_bytes())
            .await
            .map_err(|error| format!("sending the unsubscribe request failed: {error}"))?;
        stream
            .flush()
            .await
            .map_err(|error| format!("sending the unsubscribe request failed: {error}"))?;

        // Read incrementally and stop as soon as the response HEADERS are
        // complete (`Connection: close` is a request, not an obligation —
        // a keep-alive server would otherwise hold the read open until
        // the total timeout even after a successful POST). Only the
        // status line is used; parse_response tolerates a header-only
        // prefix. The cap bounds a hostile header flood either way.
        let mut raw = Vec::new();
        let mut chunk = [0u8; 8 * 1024];
        loop {
            let read = stream
                .read(&mut chunk)
                .await
                .map_err(|error| format!("reading the unsubscribe response failed: {error}"))?;
            if read == 0 {
                break; // EOF before the header terminator — parse what we have
            }
            if raw.len() + read > MAX_RESPONSE_BYTES as usize {
                return Err("unsubscribe response exceeded the size cap".to_string());
            }
            raw.extend_from_slice(&chunk[..read]);
            if find_header_end(&raw).is_some() {
                break;
            }
        }
        let response = parse_response(&raw).map_err(|error| error.to_string())?;
        Ok::<u16, String>(response.status)
    };

    tokio::time::timeout(TOTAL_TIMEOUT, exchange)
        .await
        .map_err(|_| "unsubscribe request timed out".to_string())?
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::validate_unsubscribe_url;

    #[test]
    fn accepts_clean_https_urls_with_ports_paths_and_queries() {
        assert_eq!(
            validate_unsubscribe_url("https://example.com/unsubscribe").unwrap(),
            super::UnsubscribeTarget {
                host: "example.com".into(),
                port: 443,
                target: "/unsubscribe".into(),
            }
        );
        // Explicit port, path and query all survive.
        let target = validate_unsubscribe_url(
            "https://mail.example.com:8443/lists/u?token=abc%2Fdef",
        )
        .unwrap();
        assert_eq!(target.host, "mail.example.com");
        assert_eq!(target.port, 8443);
        assert_eq!(target.target, "/lists/u?token=abc%2Fdef");
        // No path at all → "/".
        assert_eq!(
            validate_unsubscribe_url("https://example.com").unwrap().target,
            "/"
        );
        // IPv6 hosts with and without a port.
        let target = validate_unsubscribe_url("https://[2001:db8::1]/u").unwrap();
        assert_eq!(target.host, "2001:db8::1");
        assert_eq!(target.port, 443);
        assert_eq!(
            validate_unsubscribe_url("https://[2001:db8::1]:8443/u").unwrap().port,
            8443
        );
    }

    #[test]
    fn rejects_non_https_schemes() {
        assert!(validate_unsubscribe_url("http://example.com/u").is_err());
        assert!(validate_unsubscribe_url("ftp://example.com/u").is_err());
        assert!(validate_unsubscribe_url("example.com/u").is_err());
        assert!(validate_unsubscribe_url("").is_err());
    }

    #[test]
    fn rejects_userinfo() {
        let error = validate_unsubscribe_url("https://user:pass@example.com/u").unwrap_err();
        assert!(error.contains("userinfo"), "{error}");
        assert!(validate_unsubscribe_url("https://user@example.com/u").is_err());
    }

    #[test]
    fn rejects_fragments() {
        let error = validate_unsubscribe_url("https://example.com/u#frag").unwrap_err();
        assert!(error.contains("fragment"), "{error}");
    }

    #[test]
    fn rejects_control_characters_and_whitespace_anywhere() {
        // CR/LF above all (request-line shaping), wherever they sit.
        assert!(validate_unsubscribe_url("https://example.com/u\r\nX: y").is_err());
        assert!(validate_unsubscribe_url("https://example.com/u\n").is_err());
        assert!(validate_unsubscribe_url("https://example.com/u\tb").is_err());
        assert!(validate_unsubscribe_url("https://example.com/u\u{0}b").is_err());
        // Whitespace anywhere: padded URL, space in host or path.
        assert!(validate_unsubscribe_url(" https://example.com/u").is_err());
        assert!(validate_unsubscribe_url("https://example.com/u ").is_err());
        assert!(validate_unsubscribe_url("https://example.com/a b").is_err());
        assert!(validate_unsubscribe_url("https://exa mple.com/u").is_err());
    }

    #[test]
    fn rejects_empty_hosts_and_bad_ports() {
        let error = validate_unsubscribe_url("https:///u").unwrap_err();
        assert!(error.contains("host"), "{error}");
        let error = validate_unsubscribe_url("https://:8443/u").unwrap_err();
        assert!(error.contains("host"), "{error}");
        assert!(validate_unsubscribe_url("https://example.com:notaport/u").is_err());
        assert!(validate_unsubscribe_url("https://example.com:/u").is_err());
        assert!(validate_unsubscribe_url("https://[2001:db8:1/u").is_err());
    }

    #[test]
    fn query_only_urls_keep_their_query() {
        // RFC 3986: the path may be empty when a query is present — the
        // POST target must be "/?..." not "/" (the query is the
        // unsubscribe token).
        let target = validate_unsubscribe_url("https://example.com?token=abc").unwrap();
        assert_eq!(target.host, "example.com");
        assert_eq!(target.port, 443);
        assert_eq!(target.target, "/?token=abc");
    }

    #[test]
    fn host_header_brackets_ipv6_literals() {
        assert_eq!(super::build_host_header("example.com", 443), "example.com");
        assert_eq!(
            super::build_host_header("example.com", 8443),
            "example.com:8443"
        );
        // RFC 9110 §7.2: IPv6 literals are bracketed in the Host field.
        assert_eq!(
            super::build_host_header("2001:db8::1", 443),
            "[2001:db8::1]"
        );
        assert_eq!(
            super::build_host_header("2001:db8::1", 8443),
            "[2001:db8::1]:8443"
        );
    }

    #[test]
    fn header_end_detection() {
        assert_eq!(super::find_header_end(b"HTTP/1.1 200 OK\r\n\r\n"), Some(15));
        // Headers continue — no terminator yet.
        assert_eq!(super::find_header_end(b"HTTP/1.1 200 OK\r\nX: y\r\n"), None);
        // Terminator only counts when the blank line is complete.
        assert_eq!(super::find_header_end(b"HTTP/1.1 200 OK\r\n\r"), None);
        assert_eq!(super::find_header_end(b""), None);
    }
}
