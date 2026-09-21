//! Shared HTTP plumbing for the AI provider clients (task 4.1, design D1).
//!
//! One `POST` with a JSON body over the same hand-rolled TCP +
//! native-tls stack as `avatar.rs` (no reqwest/hyper — design D1 keeps
//! the dependency footprint). `Connection: close`, response read to EOF
//! with a size cap, chunked transfer decoding, and a hard timeout.
//!
//! Transport policy: HTTPS everywhere EXCEPT explicit loopback hosts —
//! Ollama's `http://localhost:11434` is plaintext by design and the spec
//! requires Ollama traffic to stay on the local machine, so plaintext
//! HTTP to any non-loopback host is rejected outright (`ai_chat`'s
//! arbitrary user-configured base URLs get the same gate).

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_native_tls::native_tls;
use tokio_native_tls::TlsConnector as TokioTlsConnector;

use super::AiError;
use crate::net::is_loopback_host;

/// Connect budget (same split as the avatar fetcher).
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Total budget for TLS + request write + response read: a chat
/// completion can take tens of seconds on a slow local model, so this is
/// generous — but a hung endpoint still fails deterministically.
const TOTAL_TIMEOUT: Duration = Duration::from_secs(60);

/// One parsed provider URL: where to connect and what to send.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RequestUrl {
    pub host: String,
    pub port: u16,
    /// Request target: path + query (Gemini carries `?key=` here).
    pub target: String,
    pub https: bool,
}

impl RequestUrl {
    /// Value for the `Host` header (default ports omitted, per custom).
    // pub(crate) so the CalDAV transport (task 5.2) can reuse it when it
    // rebuilds absolute URLs from multistatus hrefs — no logic change.
    pub(crate) fn host_header(&self) -> String {
        let default_port = (self.https && self.port == 443) || (!self.https && self.port == 80);
        if default_port {
            self.host.clone()
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

/// Parse an absolute `http(s)://…` URL, enforcing the transport policy:
/// `https` always; `http` only when the host is loopback (Ollama-style
/// local endpoints). Any other scheme, or plaintext to a remote host, is
/// a [`AiError::Config`]. Error messages never include the URL — for
/// Gemini it contains the API key.
pub(crate) fn parse_request_url(url: &str) -> Result<RequestUrl, AiError> {
    let invalid = || AiError::Config("AI provider URL must be absolute http(s)".to_string());

    let (scheme, rest) = url.split_once("://").ok_or_else(invalid)?;
    let https = match scheme.to_ascii_lowercase().as_str() {
        "https" => true,
        "http" => false,
        _ => {
            return Err(AiError::Config(
                "AI provider URL scheme must be http or https".to_string(),
            ))
        }
    };

    let (authority, target) = match rest.find('/') {
        Some(index) => (&rest[..index], &rest[index..]),
        None => (rest, "/"),
    };
    if authority.is_empty() {
        return Err(invalid());
    }

    // Host[:port], with IPv6 bracket notation handled explicitly.
    let (host, port) = if let Some(rest) = authority.strip_prefix('[') {
        let (inside, after) = rest
            .split_once(']')
            .ok_or_else(|| AiError::Config("unterminated IPv6 host".to_string()))?;
        let port = match after.strip_prefix(':') {
            Some(port) => port
                .parse::<u16>()
                .map_err(|_| AiError::Config("invalid port in AI provider URL".to_string()))?,
            None => 0,
        };
        (inside.to_string(), port)
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) => {
                let port = port
                    .parse::<u16>()
                    .map_err(|_| AiError::Config("invalid port in AI provider URL".to_string()))?;
                (host.to_string(), port)
            }
            None => (authority.to_string(), 0),
        }
    };
    let port = if port == 0 {
        if https {
            443
        } else {
            80
        }
    } else {
        port
    };

    if !https && !is_loopback_host(&host) {
        return Err(AiError::Config(
            "plaintext HTTP is only allowed for loopback hosts (e.g. a local Ollama); \
             use HTTPS for remote AI endpoints"
                .to_string(),
        ));
    }

    Ok(RequestUrl {
        host,
        port,
        target: target.to_string(),
        https,
    })
}

/// One HTTP response: status, `Retry-After` seconds (429 handling), and
/// the body (chunked decoding already applied, lossy UTF-8).
#[derive(Debug, Clone)]
pub(crate) struct HttpResponse {
    pub status: u16,
    pub retry_after_secs: Option<u64>,
    pub body: String,
    /// The raw `ETag` header when the server sent one (parity-round-2 task
    /// 4.1: the CardDAV client's If-Match/If-None-Match write discipline
    /// needs the entity tag off the PUT/GET response; AI/CalDAV callers
    /// ignore it).
    pub etag: Option<String>,
}

/// The connection: plaintext TCP or TLS-wrapped TCP. One small enum so
/// the write/read sequence below is written once.
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

/// Issue one `POST {url}` with a JSON body and the given extra headers
/// (auth headers differ per provider). Reads the whole response with a
/// cap of 8 MiB. Never logs, never embeds request bytes in errors.
pub(crate) async fn post_json(
    url: &str,
    extra_headers: &[(&str, &str)],
    body: &str,
) -> Result<HttpResponse, AiError> {
    let parsed = parse_request_url(url)?;
    let payload = body.as_bytes();

    let mut request = format!(
        "POST {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: emailer\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
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

    // Connect (short budget), then TLS + write + read under one total
    // budget so a slow-loris endpoint cannot hold the task forever.
    let tcp = tokio::time::timeout(
        CONNECT_TIMEOUT,
        TcpStream::connect((parsed.host.as_str(), parsed.port)),
    )
    .await
    .map_err(|_| AiError::Network(format!("connect to {} timed out", parsed.host)))?
    .map_err(|error| AiError::Network(format!("connect to {} failed: {error}", parsed.host)))?;

    let mut conn = {
        let handshake = async {
            if !parsed.https {
                return Ok(Conn::Plain(tcp));
            }
            let connector = TokioTlsConnector::from(
                native_tls::TlsConnector::builder()
                    .build()
                    .map_err(|error| {
                        AiError::Network(format!("failed to create TLS connector: {error}"))
                    })?,
            );
            // Certificate and hostname verification stay on unconditionally.
            let tls = connector
                .connect(&parsed.host, tcp)
                .await
                .map_err(|error| AiError::Network(format!("TLS handshake failed: {error}")))?;
            Ok::<Conn, AiError>(Conn::Tls(tls))
        };
        tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, handshake)
            .await
            .map_err(|_| AiError::Network("TLS handshake timed out".to_string()))??
    };

    let exchange = async {
        conn.write_all(request.as_bytes())
            .await
            .map_err(|error| AiError::Network(format!("sending the request failed: {error}")))?;
        conn.flush()
            .await
            .map_err(|error| AiError::Network(format!("flushing the request failed: {error}")))?;
        // +1 so an over-cap response is detectable instead of silently
        // truncated into a confusing parse error.
        conn.read_capped(super::MAX_RESPONSE_BYTES + 1)
            .await
            .map_err(|error| AiError::Network(format!("reading the response failed: {error}")))
    };
    let raw = tokio::time::timeout(TOTAL_TIMEOUT, exchange)
        .await
        .map_err(|_| AiError::Network("response timed out".to_string()))??;

    if raw.len() as u64 > super::MAX_RESPONSE_BYTES {
        return Err(AiError::Network(format!(
            "response exceeded the {} MiB cap",
            super::MAX_RESPONSE_BYTES / (1024 * 1024)
        )));
    }

    parse_response(&raw)
}

/// Split a raw response into status / headers / body at the first CRLF
/// CRLF; decodes a chunked body when `Transfer-Encoding: chunked`.
// pub(crate) so the CalDAV transport (task 5.2, design D5) reuses the
// exact same response decoding (status line, chunked bodies) instead of
// duplicating it — no logic change.
pub(crate) fn parse_response(raw: &[u8]) -> Result<HttpResponse, AiError> {
    let header_end = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| AiError::Parse("malformed HTTP response (no header terminator)".into()))?;
    let headers = String::from_utf8_lossy(&raw[..header_end]);
    let mut lines = headers.split("\r\n");
    let status_line = lines.next().ok_or_else(|| {
        AiError::Parse("malformed HTTP response (empty status line)".to_string())
    })?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| AiError::Parse(format!("malformed HTTP status line: {status_line}")))?;

    let mut retry_after_secs: Option<u64> = None;
    let mut chunked = false;
    let mut etag: Option<String> = None;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name == "retry-after" {
            // Seconds form only; the HTTP-date form is not worth a time
            // parser here and is ignored.
            retry_after_secs = value.parse::<u64>().ok();
        } else if name == "transfer-encoding"
            && value.to_ascii_lowercase().contains("chunked")
        {
            chunked = true;
        } else if name == "etag" {
            etag = Some(value.to_string());
        }
    }

    let mut body = raw[header_end + 4..].to_vec();
    if chunked {
        body = decode_chunked(&body);
    }
    Ok(HttpResponse {
        status,
        retry_after_secs,
        body: String::from_utf8_lossy(&body).into_owned(),
        etag: etag.filter(|etag| !etag.is_empty()),
    })
}

/// Decode a chunked transfer-encoded body (sizes in hex, CRLF-framed,
/// terminated by a 0-size chunk). Same shape as the avatar fetcher's
/// decoder; truncated input yields what arrived (the JSON parse then
/// reports a specific failure).
fn decode_chunked(mut body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let Some(line_end) = body.windows(2).position(|window| window == b"\r\n") else {
            break;
        };
        let size_line = String::from_utf8_lossy(&body[..line_end]);
        // Chunk extensions (";name=value") are ignored, per RFC 9112.
        let size = usize::from_str_radix(size_line.split(';').next().unwrap_or("").trim(), 16)
            .unwrap_or(0);
        body = &body[line_end + 2..];
        if size == 0 {
            break;
        }
        if body.len() < size {
            out.extend_from_slice(body);
            break;
        }
        out.extend_from_slice(&body[..size]);
        body = &body[size..];
        if body.starts_with(b"\r\n") {
            body = &body[2..];
        }
    }
    out
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::{decode_chunked, parse_request_url, parse_response, RequestUrl};

    #[test]
    fn parses_https_urls_with_default_port_and_target() {
        assert_eq!(
            parse_request_url("https://api.anthropic.com/v1/messages").unwrap(),
            RequestUrl {
                host: "api.anthropic.com".into(),
                port: 443,
                target: "/v1/messages".into(),
                https: true,
            }
        );
        // No path at all → "/".
        assert_eq!(
            parse_request_url("https://api.openai.com").unwrap().target,
            "/"
        );
        // Explicit non-default port survives; the Host header keeps it.
        let url = parse_request_url("https://gateway.example.com:8443/v1/chat/completions")
            .unwrap();
        assert_eq!(url.port, 8443);
        assert_eq!(url.host_header(), "gateway.example.com:8443");
        // Query strings are part of the request target (Gemini's ?key=).
        let url = parse_request_url("https://x.com/a?key=1").unwrap();
        assert_eq!(url.target, "/a?key=1");
        // Default ports are omitted from the Host header.
        assert_eq!(
            parse_request_url("https://x.com/a").unwrap().host_header(),
            "x.com"
        );
    }

    #[test]
    fn allows_plaintext_http_only_for_loopback() {
        // Ollama's default endpoint.
        let url = parse_request_url("http://localhost:11434/v1/chat/completions").unwrap();
        assert!(!url.https);
        assert_eq!(url.port, 11434);
        assert!(parse_request_url("http://127.0.0.1:1/x").is_ok());
        assert!(parse_request_url("http://[::1]:1/x").is_ok());
        // Any other host must use HTTPS.
        assert!(parse_request_url("http://api.example.com/v1").is_err());
        assert!(parse_request_url("http://192.168.1.10:11434/v1").is_err());
    }

    #[test]
    fn rejects_other_schemes_and_garbage() {
        assert!(parse_request_url("ftp://example.com/x").is_err());
        assert!(parse_request_url("file:///etc/passwd").is_err());
        assert!(parse_request_url("api.anthropic.com/v1").is_err());
        assert!(parse_request_url("https:///path-only").is_err());
        assert!(parse_request_url("https://host:notaport/x").is_err());
        assert!(parse_request_url("https://[::1/x").is_err());
    }

    fn raw_response(head: &str, body: &[u8]) -> Vec<u8> {
        let mut raw = format!("HTTP/1.1 {head}\r\n\r\n").into_bytes();
        raw.extend_from_slice(body);
        raw
    }

    #[test]
    fn parses_status_and_body() {
        let raw = raw_response(
            "200 OK\r\nContent-Type: application/json",
            br#"{"ok":true}"#,
        );
        let parsed = parse_response(&raw).unwrap();
        assert_eq!(parsed.status, 200);
        assert_eq!(parsed.retry_after_secs, None);
        assert_eq!(parsed.body, r#"{"ok":true}"#);
    }

    #[test]
    fn parses_retry_after_seconds() {
        let raw = raw_response(
            "429 Too Many Requests\r\nRetry-After: 42",
            b"{}",
        );
        let parsed = parse_response(&raw).unwrap();
        assert_eq!(parsed.status, 429);
        assert_eq!(parsed.retry_after_secs, Some(42));
        // The HTTP-date form is ignored rather than misread.
        let raw = raw_response(
            "429 Too Many Requests\r\nRetry-After: Wed, 21 Oct 2026 07:28:00 GMT",
            b"{}",
        );
        assert_eq!(parse_response(&raw).unwrap().retry_after_secs, None);
    }

    #[test]
    fn decodes_chunked_bodies() {
        assert_eq!(decode_chunked(b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n"), b"Wikipedia");
        // Chunk extensions are ignored.
        assert_eq!(decode_chunked(b"3;ext=1\r\nabc\r\n0\r\n\r\n"), b"abc");
        // Truncated input yields the bytes that arrived.
        assert_eq!(decode_chunked(b"5\r\nab"), b"ab");
        assert_eq!(decode_chunked(b"0\r\n\r\n"), b"");
    }

    #[test]
    fn rejects_malformed_responses() {
        assert!(parse_response(b"not http at all").is_err());
        assert!(parse_response(b"HTTP/1.1 200 OK\r\nno terminator").is_err());
        assert!(parse_response(b"HTTP/1.1 nonsense\r\n\r\n{}").is_err());
    }
}
