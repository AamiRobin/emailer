//! Opt-in Gravatar avatars (task 2.5, design D12).
//!
//! The webview never talks to gravatar.com directly — that would need a
//! CSP `connect-src`/`img-src` grant and would make the opt-in leaky.
//! Instead the TS layer invokes [`gravatar_fetch`]: the address is
//! normalized (trim + lowercase), SHA-256-hashed here, and looked up at
//! `https://gravatar.com/avatar/<hash>?d=404&s=128` (`d=404` = "no
//! image" answers HTTP 404 rather than a placeholder). Successful bytes
//! are cached on disk under `<app_data>/avatars/<hash>.png`, so an
//! address is fetched from the network ONCE; every later render is
//! served from disk without any network traffic. The command returns the
//! bytes base64-encoded and the webview renders a blob URL from them.
//!
//! The HTTP client is the same hand-rolled TCP + native-tls stack the
//! IMAP/SMTP clients use (no reqwest, no extra HTTP crate): one HTTPS
//! GET with `Connection: close`, response read to EOF, chunked transfer
//! decoding and redirect following (gravatar.com may bounce to a
//! regional host) kept deliberately small.
//!
//! Privacy posture (contacts spec "Contact avatars"): fetching is
//! opt-in and enforced TS-side BEFORE this command is ever invoked, so
//! with the setting off nothing here runs at all.

use std::path::PathBuf;
use std::time::Duration;

use base64::Engine as _;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_native_tls::native_tls;
use tokio_native_tls::TlsConnector as TokioTlsConnector;

/// The only host the initial lookup goes to; redirects may move to
/// regional *.gravatar.com mirrors (see [`split_https_url`]).
const GRAVATAR_HOST: &str = "gravatar.com";
const GRAVATAR_PORT: u16 = 443;

/// Timeout budgets for one request, matching the IMAP client's split.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const TLS_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(15);

/// A 128px PNG is a few KB; anything near this cap is wrong, and the cap
/// keeps a hostile/misbehaving server from streaming forever.
const MAX_AVATAR_BYTES: u64 = 1024 * 1024;

/// Original request + at most this many redirects.
const MAX_REDIRECTS: usize = 3;

/// SHA-256 hex of the normalized (trimmed, lowercased) address — the
/// Gravatar lookup key. Normalization per the Gravatar spec: whitespace
/// around the address never changes the hash, and casing never does
/// either, so "Ada@X.com" and "  ada@x.com " share one cache entry.
pub fn gravatar_hash(address: &str) -> String {
    let normalized = address.trim().to_lowercase();
    let digest = Sha256::digest(normalized.as_bytes());
    let mut hex = String::with_capacity(digest.len() * 2);
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    hex
}

/// The avatar-cache file for a hash: `<app_data>/avatars/<hash>.png`
/// (design D12: "bytes cached in the avatar cache dir").
fn cache_path<R: Runtime>(app: &AppHandle<R>, hash: &str) -> Result<PathBuf, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not resolve the app data dir: {e}"))?;
    Ok(data_dir.join("avatars").join(format!("{hash}.png")))
}

// ---------- Hand-rolled HTTPS GET (the net.rs/imaps TLS approach) ----------

fn build_tls_connector() -> Result<TokioTlsConnector, String> {
    // Same connector the IMAP client builds: certificate and hostname
    // verification stay on unconditionally — a release app handling user
    // data never bypasses TLS validation.
    let connector = native_tls::TlsConnector::builder()
        .build()
        .map_err(|e| format!("failed to create TLS connector: {e}"))?;
    Ok(TokioTlsConnector::from(connector))
}

/// One parsed HTTP response: status, `Location` header (redirects), and
/// the body (chunked transfer decoding already applied).
#[derive(Debug)]
struct HttpResponse {
    status: u16,
    location: Option<String>,
    body: Vec<u8>,
}

/// Issue one HTTPS GET `https://{host}{path}` and read the whole
/// response. Uses `Connection: close`, so the body ends at EOF — no
/// Content-Length bookkeeping needed.
async fn https_get(host: &str, path: &str) -> Result<HttpResponse, String> {
    let tcp = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, GRAVATAR_PORT)))
        .await
        .map_err(|_| format!("connect to {host} timed out"))?
        .map_err(|e| format!("connect to {host} failed: {e}"))?;
    let connector = build_tls_connector()?;
    let mut stream = tokio::time::timeout(TLS_HANDSHAKE_TIMEOUT, connector.connect(host, tcp))
        .await
        .map_err(|_| format!("TLS handshake with {host} timed out"))?
        .map_err(|e| format!("TLS handshake with {host} failed: {e}"))?;

    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: emailer\r\nAccept: image/*\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .await
        .map_err(|e| format!("sending the request to {host} failed: {e}"))?;
    stream
        .flush()
        .await
        .map_err(|e| format!("flushing the request to {host} failed: {e}"))?;

    let mut raw = Vec::new();
    let mut limited = (&mut stream).take(MAX_AVATAR_BYTES);
    tokio::time::timeout(RESPONSE_TIMEOUT, limited.read_to_end(&mut raw))
        .await
        .map_err(|_| format!("response from {host} timed out"))?
        .map_err(|e| format!("reading the response from {host} failed: {e}"))?;
    parse_response(&raw)
}

/// Split a raw response into status / headers / body at the first CRLF
/// CRLF; decodes a chunked body when `Transfer-Encoding: chunked`.
fn parse_response(raw: &[u8]) -> Result<HttpResponse, String> {
    let header_end = raw
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| "malformed HTTP response (no header terminator)".to_string())?;
    let headers = String::from_utf8_lossy(&raw[..header_end]);
    let mut lines = headers.split("\r\n");
    let status_line = lines.next().ok_or("empty HTTP response")?;
    let status = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| format!("malformed HTTP status line: {status_line}"))?;

    let mut location: Option<String> = None;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim().to_ascii_lowercase();
        let value = value.trim();
        if name == "location" {
            location = Some(value.to_string());
        } else if name == "transfer-encoding"
            && value.to_ascii_lowercase().contains("chunked")
        {
            chunked = true;
        }
    }

    let mut body = raw[header_end + 4..].to_vec();
    if chunked {
        body = decode_chunked(&body);
    }
    Ok(HttpResponse {
        status,
        location,
        body,
    })
}

/// Decode a chunked transfer-encoded body (sizes in hex, CRLF-framed,
/// terminated by a 0-size chunk). Truncated input yields what arrived —
/// the webview just fails to render a partial PNG and the initials
/// fallback stays.
fn decode_chunked(mut body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let Some(line_end) = body.windows(2).position(|window| window == b"\r\n") else {
            break;
        };
        let size_line = String::from_utf8_lossy(&body[..line_end]);
        // Chunk extensions (";name=value") are ignored, per RFC 9112.
        let size = usize::from_str_radix(
            size_line.split(';').next().unwrap_or("").trim(),
            16,
        )
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

/// Split an absolute https URL into (host, path); `None` for anything
/// else — redirects are only followed to HTTPS origins.
fn split_https_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("https://")?;
    Some(match rest.find('/') {
        Some(index) => (rest[..index].to_string(), rest[index..].to_string()),
        None => (rest.to_string(), "/".to_string()),
    })
}

/// Fetch the avatar bytes for a hash from the network: 200 → bytes,
/// 404 (`d=404` "no gravatar") → `None`, redirects followed (HTTPS only),
/// anything else is an error. Network failures surface as `Err` — the
/// TS layer treats those the same as "no avatar" and keeps the initials.
async fn fetch_gravatar_bytes(hash: &str) -> Result<Option<Vec<u8>>, String> {
    let mut host = GRAVATAR_HOST.to_string();
    let mut path = format!("/avatar/{hash}?d=404&s=128");
    for _ in 0..MAX_REDIRECTS {
        let response = https_get(&host, &path).await?;
        match response.status {
            200 if !response.body.is_empty() => return Ok(Some(response.body)),
            // An empty 200 body would cache/render as nothing; treat it
            // like a missing avatar.
            200 => return Ok(None),
            404 => return Ok(None),
            301 | 302 | 303 | 307 | 308 => {
                let Some(location) = response.location else {
                    return Err(format!("gravatar redirect without Location header ({host}{path})"));
                };
                let Some((next_host, next_path)) = split_https_url(&location) else {
                    return Err(format!("refusing non-HTTPS gravatar redirect: {location}"));
                };
                host = next_host;
                path = next_path;
            }
            status => return Err(format!("gravatar returned HTTP {status} for {host}{path}")),
        }
    }
    Err(format!("gravatar redirect chain exceeded {MAX_REDIRECTS} hops"))
}

/// Fetch (or load from the local cache) the Gravatar for `address` and
/// return the image bytes base64-encoded, or `None` when the address has
/// no Gravatar (`d=404`).
///
/// The TS layer only invokes this AFTER the user opted in (contacts spec
/// "Contact avatars" — the setting is off by default because it discloses
/// the address hash to an external service), so this command never runs
/// while the privacy toggle is off.
#[tauri::command]
pub async fn gravatar_fetch<R: Runtime>(
    app: AppHandle<R>,
    address: String,
) -> Result<Option<String>, String> {
    // Nothing to look up: refuse before hashing or any I/O.
    if address.trim().is_empty() {
        return Ok(None);
    }
    let hash = gravatar_hash(&address);

    // Disk cache first (spec: "loaded avatars SHALL be cached locally"
    // and fetched once): a cache hit performs ZERO network I/O.
    let cache_file = cache_path(&app, &hash)?;
    if let Ok(bytes) = std::fs::read(&cache_file) {
        if !bytes.is_empty() {
            return Ok(Some(encode_base64(&bytes)));
        }
    }

    let Some(bytes) = fetch_gravatar_bytes(&hash).await? else {
        return Ok(None);
    };

    // Best-effort cache write (task 2.5): a full disk or read-only data
    // dir must never fail the command — the avatar still renders for this
    // session and the next run simply refetches.
    if let Some(parent) = cache_file.parent() {
        if let Err(error) = std::fs::create_dir_all(parent) {
            log::warn!("avatar cache dir unavailable: {error}");
        }
    }
    if let Err(error) = std::fs::write(&cache_file, &bytes) {
        log::warn!("avatar cache write failed: {error}");
    }

    Ok(Some(encode_base64(&bytes)))
}

/// Standard-alphabet base64, the same engine the IMAP attachment path
/// uses (imap/client.rs encode_base64) — bytes cross the JSON bridge.
fn encode_base64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::{decode_chunked, gravatar_hash, parse_response, split_https_url};

    #[test]
    fn hash_matches_known_sha256_vectors() {
        // Well-known SHA-256 vectors via `echo -n … | shasum -a 256`.
        assert_eq!(
            gravatar_hash(""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            gravatar_hash("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn hash_normalizes_case_and_surrounding_whitespace() {
        // The Gravatar normalization: trim + lowercase, so every spelling
        // of one address maps to one lookup key (and one cache file).
        let canonical = gravatar_hash("ada@x.com");
        assert_eq!(gravatar_hash("ADA@X.COM"), canonical);
        assert_eq!(gravatar_hash("  Ada@X.com \n\t"), canonical);
        // Interior text still matters.
        assert_ne!(gravatar_hash("ada@x.org"), canonical);
    }

    fn response(status: &str, headers: &str, body: &[u8]) -> Vec<u8> {
        let mut raw = format!("HTTP/1.1 {status}\r\n{headers}\r\n\r\n").into_bytes();
        raw.extend_from_slice(body);
        raw
    }

    #[test]
    fn parse_response_reads_status_headers_and_body() {
        let raw = response(
            "200 OK",
            "Content-Type: image/png\r\nContent-Length: 4",
            b"PNG!",
        );
        let parsed = parse_response(&raw).expect("parses");
        assert_eq!(parsed.status, 200);
        assert_eq!(parsed.location, None);
        assert_eq!(parsed.body, b"PNG!");
    }

    #[test]
    fn parse_response_reads_location_and_chunked_body() {
        let raw = response(
            "302 Found",
            "Location: https://0.gravatar.com/avatar/abc\r\nTransfer-Encoding: chunked",
            b"3\r\nabc\r\n0\r\n\r\n",
        );
        let parsed = parse_response(&raw).expect("parses");
        assert_eq!(parsed.status, 302);
        assert_eq!(
            parsed.location.as_deref(),
            Some("https://0.gravatar.com/avatar/abc")
        );
        assert_eq!(parsed.body, b"abc");
    }

    #[test]
    fn parse_response_rejects_garbage() {
        assert!(parse_response(b"not http at all").is_err());
        assert!(parse_response(b"HTTP/1.1\r\n\r\n").is_err());
        // Header terminator missing entirely.
        assert!(parse_response(b"HTTP/1.1 200 OK\r\nno terminator").is_err());
    }

    #[test]
    fn decodes_chunked_bodies() {
        assert_eq!(decode_chunked(b"4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n"), b"Wikipedia");
        // Chunk extensions are ignored.
        assert_eq!(
            decode_chunked(b"3;ext=1\r\nabc\r\n0\r\n\r\n"),
            b"abc"
        );
        // Truncated input yields the bytes that arrived.
        assert_eq!(decode_chunked(b"5\r\nab"), b"ab");
        // Empty body decodes to empty.
        assert_eq!(decode_chunked(b"0\r\n\r\n"), b"");
    }

    #[test]
    fn splits_https_urls_only() {
        assert_eq!(
            split_https_url("https://0.gravatar.com/avatar/abc?d=404"),
            Some(("0.gravatar.com".into(), "/avatar/abc?d=404".into()))
        );
        assert_eq!(
            split_https_url("https://gravatar.com"),
            Some(("gravatar.com".into(), "/".into()))
        );
        // Redirects are only followed over HTTPS.
        assert_eq!(split_https_url("http://gravatar.com/avatar/x"), None);
        assert_eq!(split_https_url("/avatar/abc"), None);
        assert_eq!(split_https_url(""), None);
    }
}
