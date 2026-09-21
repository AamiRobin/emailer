//! One-shot OAuth loopback redirect receiver (authorization-code capture).
//!
//! The TS side builds Google's authorization URL with a loopback redirect_uri
//! (`http://127.0.0.1:<port>` or `http://127.0.0.1:<port>/oauth`), opens the
//! browser, and invokes [`start_oauth_server`]. That command binds the loopback
//! port, waits for Google's redirect GET, shows a "you can close this window"
//! page, and resolves with the query parameters relayed verbatim. State
//! validation, PKCE code_verifier/challenge generation and the token exchange
//! all stay TS-side (Gmail provider task).

use std::net::Ipv4Addr;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

/// Default loopback port for the OAuth redirect (same fixed port as the
/// reference implementation). When it cannot be bound, an ephemeral port is
/// used instead and reported back in the result.
pub const DEFAULT_OAUTH_PORT: u16 = 17248;

/// How long to wait for the browser redirect before giving up.
const WAIT_TIMEOUT: Duration = Duration::from_secs(300);
/// How long a single browser connection may take to deliver its request.
const READ_TIMEOUT: Duration = Duration::from_secs(10);
/// Cap on a single request we are willing to buffer.
const MAX_REQUEST_BYTES: usize = 8 * 1024;

/// Redirect query parameters relayed to the caller (values percent-decoded).
///
/// Success: `code` + `state` are present (plus `scope`, the space-separated
/// grant list Google echoes back). Denied/failed consent: `error` (and
/// optionally `error_description`) are present instead, and `scope` is
/// `None`. The scope string is relayed verbatim — the TS side owns scope
/// policy: the mail flow's authorization URL is built without the calendar
/// scope (task 5.1, design D5), and the calendar connect checks that the
/// granted list really contains it before persisting tokens.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthCallback {
    /// The loopback port that was actually bound (differs from the request
    /// when the default port was taken and an ephemeral fallback was used).
    pub port: u16,
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
    /// Granted scopes as Google echoed them (success redirects only).
    pub scope: Option<String>,
}

// ---------- Bind / port selection ----------

struct BoundListener {
    listener: TcpListener,
    port: u16,
    /// True when the preferred/default port was taken and an ephemeral
    /// fallback port was bound instead.
    fell_back: bool,
}

async fn bind_listener(preferred: Option<u16>) -> Result<BoundListener, String> {
    let preferred = preferred.unwrap_or(DEFAULT_OAUTH_PORT);
    let (listener, fell_back) = match TcpListener::bind((Ipv4Addr::LOCALHOST, preferred)).await {
        Ok(listener) => (listener, false),
        Err(bind_err) => {
            log::warn!(
                "could not bind OAuth port {preferred}: {bind_err}; trying an ephemeral port"
            );
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
                    .await
                    .map_err(|e| {
                        format!(
                            "could not bind OAuth port {preferred} ({bind_err}) nor an ephemeral fallback port ({e})"
                        )
                    })?;
            (listener, true)
        }
    };
    let port = listener
        .local_addr()
        .map_err(|e| format!("could not read the bound OAuth port: {e}"))?
        .port();
    Ok(BoundListener {
        listener,
        port,
        fell_back,
    })
}

// ---------- Cancellation registry ----------

/// Cancel signal of the currently pending OAuth wait, if any, tagged with the
/// flow's generation. Registration and cancellation both bump the generation,
/// so a superseded flow's [`CancelGuard`] can never remove a newer flow's
/// signal (generation mismatch) — only its own.
///
/// A module-level registry keeps lib.rs free of extra `.manage()` state; one
/// pending OAuth flow at a time is enough for a desktop app.
fn pending_cancel() -> &'static Mutex<(u64, Option<oneshot::Sender<()>>)> {
    static PENDING: OnceLock<Mutex<(u64, Option<oneshot::Sender<()>>)>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new((0, None)))
}

/// Supersede any pending flow (firing its cancel signal) and register a fresh
/// one. Returns the cancel receiver plus the new flow's generation, which its
/// [`CancelGuard`] must carry.
fn register_cancel_signal() -> Result<(oneshot::Receiver<()>, u64), String> {
    let mut pending = pending_cancel()
        .lock()
        .map_err(|_| "OAuth cancel registry is poisoned".to_string())?;
    if let Some(previous) = pending.1.take() {
        let _ = previous.send(());
    }
    pending.0 = pending.0.wrapping_add(1);
    let (tx, rx) = oneshot::channel();
    pending.1 = Some(tx);
    Ok((rx, pending.0))
}

/// Removes the cancel signal when its flow ends — but only if no newer flow
/// has superseded it in the meantime (generations still match).
struct CancelGuard {
    generation: u64,
}

impl Drop for CancelGuard {
    fn drop(&mut self) {
        if let Ok(mut pending) = pending_cancel().lock() {
            if pending.0 == self.generation {
                pending.1 = None;
            }
        }
    }
}

// ---------- Commands ----------

/// Find a free loopback port for the OAuth redirect, BEFORE the browser is
/// opened. With no `preferred` port this binds `127.0.0.1:0`, reads the
/// ephemeral port and drops the listener — the Microsoft flow passes that
/// port on to [`start_oauth_server`] explicitly (Microsoft accepts any
/// localhost port for public clients, RFC 8252 §7.3, so a busy default
/// port can never black-hole the redirect). With `preferred` set (the
/// Google flow's fixed registered port) the exact port must be bound or
/// the flow cannot work at all — an occupied port comes back as an Err so
/// the TS side fails fast with an actionable message instead of letting
/// the browser redirect land nowhere and the wait time out.
#[tauri::command]
pub async fn find_free_loopback_port(preferred: Option<u16>) -> Result<u16, String> {
    match preferred {
        Some(port) => {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, port))
                .await
                .map_err(|e| {
                    format!("loopback port {port} is not available: {e}")
                })?;
            let bound = listener
                .local_addr()
                .map_err(|e| format!("could not read the bound loopback port: {e}"))?
                .port();
            drop(listener);
            Ok(bound)
        }
        None => {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
                .await
                .map_err(|e| format!("could not bind an ephemeral loopback port: {e}"))?;
            let port = listener
                .local_addr()
                .map_err(|e| format!("could not read the bound loopback port: {e}"))?
                .port();
            drop(listener);
            Ok(port)
        }
    }
}

/// Wait for Google's OAuth redirect on a localhost port and return the
/// authorization code (or the consent error) to the caller.
///
/// Binds `port` if given, else the default port 17248; when that port is
/// unavailable, an ephemeral port is bound instead (the chosen port is part of
/// the result). Resolves after the first valid redirect on `/` or `/oauth`;
/// errors on the ~5 minute timeout, on cancellation, or when nothing can be
/// bound at all.
#[tauri::command]
pub async fn start_oauth_server(port: Option<u16>) -> Result<OauthCallback, String> {
    let bound = bind_listener(port).await?;
    log::info!(
        "OAuth callback server listening on 127.0.0.1:{}{}",
        bound.port,
        if bound.fell_back { " (fallback)" } else { "" }
    );

    // Supersede any pending wait, then register our cancel signal.
    let (cancel_rx, generation) = register_cancel_signal()?;
    let _guard = CancelGuard { generation };

    serve_once(bound.listener, bound.port, cancel_rx).await
}

/// Abort a pending [`start_oauth_server`] wait (e.g. the user closed the
/// dialog). Returns whether a pending wait was actually cancelled.
#[tauri::command]
pub fn cancel_oauth_server() -> Result<bool, String> {
    let mut pending = pending_cancel()
        .lock()
        .map_err(|_| "OAuth cancel registry is poisoned".to_string())?;
    // Bump the generation so a finishing flow's guard cannot touch the
    // (already taken) entry afterwards.
    pending.0 = pending.0.wrapping_add(1);
    let sender = pending.1.take();
    Ok(sender.is_some_and(|tx| tx.send(()).is_ok()))
}

/// Serve exactly one OAuth redirect: accept connections until a callback
/// arrives, the wait is cancelled, or the timeout elapses.
async fn serve_once(
    listener: TcpListener,
    port: u16,
    cancel: oneshot::Receiver<()>,
) -> Result<OauthCallback, String> {
    tokio::select! {
        result = accept_loop(&listener, port) => result,
        _ = tokio::time::sleep(WAIT_TIMEOUT) => Err(format!(
            "OAuth sign-in timed out after {} minutes — please try again",
            WAIT_TIMEOUT.as_secs() / 60
        )),
        _ = cancel => Err("OAuth sign-in was cancelled".to_string()),
    }
}

async fn accept_loop(listener: &TcpListener, port: u16) -> Result<OauthCallback, String> {
    loop {
        let (mut stream, peer) = listener
            .accept()
            .await
            .map_err(|e| format!("OAuth callback server failed: {e}"))?;
        log::debug!("OAuth callback connection from {peer}");

        match read_request(&mut stream).await {
            Ok(request) => {
                let Some(target) = request_target(&request) else {
                    let _ = write_http(
                        &mut stream,
                        "400 Bad Request",
                        "text/plain; charset=utf-8",
                        "Bad Request\n",
                    )
                    .await;
                    continue;
                };
                let (path, query) = split_target(&target);
                if !is_callback_path(path) {
                    // e.g. favicon or scanner noise; keep waiting for Google.
                    let _ = write_http(
                        &mut stream,
                        "404 Not Found",
                        "text/plain; charset=utf-8",
                        "Not Found\n",
                    )
                    .await;
                    continue;
                }

                let params = extract_callback_params(query);
                let page = success_page_html(params.error.is_none());
                let _ = write_http(&mut stream, "200 OK", "text/html; charset=utf-8", page).await;
                return Ok(OauthCallback {
                    port,
                    code: params.code,
                    state: params.state,
                    error: params.error,
                    error_description: params.error_description,
                    scope: params.scope,
                });
            }
            Err(err) => {
                log::warn!("dropping unusable OAuth callback connection: {err}");
                let _ = stream.shutdown().await;
            }
        }
    }
}

// ---------- HTTP plumbing ----------

/// Read an HTTP request head (until the blank line, EOF or the size cap).
async fn read_request(stream: &mut TcpStream) -> Result<String, String> {
    let mut buf = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    loop {
        let n = tokio::time::timeout(READ_TIMEOUT, stream.read(&mut chunk))
            .await
            .map_err(|_| "browser request timed out".to_string())?
            .map_err(|e| format!("failed to read the redirect request: {e}"))?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
        if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() >= MAX_REQUEST_BYTES {
            break;
        }
    }
    if buf.is_empty() {
        return Err("empty request".to_string());
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Extract the request target from the request line ("GET /x?y HTTP/1.1").
fn request_target(request: &str) -> Option<String> {
    request
        .lines()
        .next()?
        .split_whitespace()
        .nth(1)
        .map(|target| target.to_string())
}

/// Split a request target into path and query ("", when absent).
fn split_target(target: &str) -> (&str, &str) {
    match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (target, ""),
    }
}

/// The redirect may arrive at the root or under /oauth.
fn is_callback_path(path: &str) -> bool {
    path == "/" || path == "/oauth" || path.starts_with("/oauth/")
}

async fn write_http(stream: &mut TcpStream, status: &str, content_type: &str, body: &str) {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.write_all(response.as_bytes()).await;
    let _ = stream.flush().await;
    let _ = stream.shutdown().await;
}

fn success_page_html(success: bool) -> &'static str {
    const SUCCESS: &str = r#"<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>emailer</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #e2e8f0;">
<div style="text-align: center;">
<h1 style="margin-bottom: 8px;">Account connected!</h1>
<p style="opacity: 0.7;">You can close this window and return to emailer.</p>
</div>
</body>
</html>"#;

    const FAILURE: &str = r#"<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>emailer</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #e2e8f0;">
<div style="text-align: center;">
<h1 style="margin-bottom: 8px;">Sign-in failed</h1>
<p style="opacity: 0.7;">Google reported an error. You can close this window and try again in emailer.</p>
</div>
</body>
</html>"#;

    if success {
        SUCCESS
    } else {
        FAILURE
    }
}

// ---------- Query parsing ----------

/// Decoded callback parameters of interest; first occurrence of each wins.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct CallbackParams {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
    scope: Option<String>,
}

fn extract_callback_params(query: &str) -> CallbackParams {
    let mut out = CallbackParams::default();
    for (key, value) in parse_query(query) {
        match key.as_str() {
            "code" if out.code.is_none() => out.code = Some(value),
            "state" if out.state.is_none() => out.state = Some(value),
            "error" if out.error.is_none() => out.error = Some(value),
            "error_description" if out.error_description.is_none() => {
                out.error_description = Some(value)
            }
            "scope" if out.scope.is_none() => out.scope = Some(value),
            _ => {}
        }
    }
    out
}

/// Split a query string into percent-decoded key/value pairs.
fn parse_query(query: &str) -> Vec<(String, String)> {
    query
        .split('&')
        .filter(|pair| !pair.is_empty())
        .map(|pair| {
            let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
            (percent_decode(key), percent_decode(value))
        })
        .collect()
}

/// Percent-decode a query component; '+' decodes to a space and invalid
/// escapes pass through unchanged. Decodes from raw bytes — slicing `input`
/// at byte offsets would panic on a `%` followed by a multi-byte UTF-8
/// char (raw TCP clients can send arbitrary bytes; panic = abort here).
fn percent_decode(input: &str) -> String {
    fn hex_val(byte: u8) -> Option<u8> {
        match byte {
            b'0'..=b'9' => Some(byte - b'0'),
            b'a'..=b'f' => Some(byte - b'a' + 10),
            b'A'..=b'F' => Some(byte - b'A' + 10),
            _ => None,
        }
    }
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' if i + 3 <= bytes.len() => {
                match (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                    (Some(hi), Some(lo)) => {
                        out.push(hi * 16 + lo);
                        i += 3;
                    }
                    _ => {
                        out.push(b'%');
                        i += 1;
                    }
                }
            }
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            byte => {
                out.push(byte);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    // ----- URL / query parsing -----

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("%2F0AVG7%2Fx"), "/0AVG7/x");
        assert_eq!(percent_decode("abc%20def"), "abc def");
        assert_eq!(percent_decode("a+b"), "a b"); // form-urlencoding space
        assert_eq!(percent_decode("plain"), "plain");
        // Invalid escapes pass through.
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("%4"), "%4");
        // Truncated at the very end.
        assert_eq!(percent_decode("a%"), "a%");
        // '%' followed by a multi-byte UTF-8 char must not panic (the
        // escape digits are read as raw bytes, never str-sliced).
        assert_eq!(percent_decode("%€"), "%€");
        assert_eq!(percent_decode("code=%é&state=x"), "code=%é&state=x");
        assert_eq!(percent_decode("%C3%A9"), "é");
    }

    #[test]
    fn query_pairs() {
        assert_eq!(
            parse_query("a=1&b=2"),
            vec![("a".into(), "1".into()), ("b".into(), "2".into())]
        );
        assert_eq!(parse_query(""), Vec::<(String, String)>::new());
        assert_eq!(
            parse_query("flag&b="),
            vec![("flag".into(), "".into()), ("b".into(), "".into())]
        );
        assert_eq!(parse_query("k=%26%3D"), vec![("k".into(), "&=".into())]);
    }

    #[test]
    fn callback_params_success() {
        let target = "/oauth?code=4%2F0AVG7e_x&state=st%2Bate&scope=https%3A%2F%2Fmail.google.com%2F&authuser=0&prompt=consent";
        let (path, query) = split_target(target);
        assert_eq!(path, "/oauth");
        let params = extract_callback_params(query);
        assert_eq!(params.code.as_deref(), Some("4/0AVG7e_x"));
        // A literal '+' means space, but an encoded %2B is a real plus.
        assert_eq!(params.state.as_deref(), Some("st+ate"));
        assert_eq!(params.error, None);
        assert_eq!(params.error_description, None);
    }

    // ----- Scope relay (task 5.1, design D5) -----
    //
    // The server never decides scope policy — the authorization URL (and
    // its scope list) is built TS-side, and this relay hands Google's
    // GRANTED scope string back verbatim so the calendar connect can verify
    // the calendar scope actually landed while the mail flow (whose URL
    // never requests it) is unaffected.

    #[test]
    fn granted_scope_is_captured_verbatim() {
        // A calendar-connect success redirect: mail + calendar grants,
        // URL-encoded, possibly in a non-canonical order. Decoded value
        // must come back exactly as Google sent it.
        let params = extract_callback_params(
            "state=s1&code=4%2F0XYZ&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar%20https%3A%2F%2Fmail.google.com%2F%20email",
        );
        assert_eq!(params.scope.as_deref(), Some(
            "https://www.googleapis.com/auth/calendar https://mail.google.com/ email"
        ));
        assert_eq!(params.code.as_deref(), Some("4/0XYZ"));
        assert_eq!(params.error, None);
    }

    #[test]
    fn mail_only_grant_relayed_without_special_casing() {
        // A plain mail flow redirect: no calendar scope was requested, so
        // none appears in the grant — relayed as-is (no scope filtering of
        // any kind lives Rust-side).
        let params = extract_callback_params(
            "code=4%2F0ABC&state=s2&scope=https%3A%2F%2Fmail.google.com%2F%20email",
        );
        assert_eq!(
            params.scope.as_deref(),
            Some("https://mail.google.com/ email")
        );
        assert!(!params
            .scope
            .as_deref()
            .unwrap_or_default()
            .contains("auth/calendar"));
    }

    #[test]
    fn consent_denial_carries_no_scope() {
        let params = extract_callback_params(
            "error=access_denied&error_description=Consent%20was%20denied&state=abc",
        );
        assert_eq!(params.error.as_deref(), Some("access_denied"));
        assert_eq!(params.scope, None);
    }

    #[test]
    fn duplicate_scope_keys_keep_first() {
        let params =
            extract_callback_params("scope=a%20b&scope=c&code=x");
        assert_eq!(params.scope.as_deref(), Some("a b"));
    }

    #[tokio::test]
    async fn round_trip_relays_the_granted_scope() {
        let bound = bind_listener(Some(0)).await.unwrap();
        let (_tx, rx) = oneshot::channel::<()>();
        let waiter = tokio::spawn(serve_once(bound.listener, bound.port, rx));

        let mut conn = TcpStream::connect((Ipv4Addr::LOCALHOST, bound.port))
            .await
            .unwrap();
        conn.write_all(
            b"GET /oauth?code=4%2F0S&state=st&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fcalendar%20email HTTP/1.1\r\nHost: x\r\n\r\n",
        )
        .await
        .unwrap();
        let callback = waiter.await.unwrap().expect("should resolve");
        assert_eq!(
            callback.scope.as_deref(),
            Some("https://www.googleapis.com/auth/calendar email")
        );
        assert_eq!(callback.code.as_deref(), Some("4/0S"));
    }

    #[test]
    fn callback_params_consent_denied() {
        let params = extract_callback_params(
            "error=access_denied&error_description=Consent%20was%20denied&state=abc",
        );
        assert_eq!(params.error.as_deref(), Some("access_denied"));
        assert_eq!(
            params.error_description.as_deref(),
            Some("Consent was denied")
        );
        assert_eq!(params.state.as_deref(), Some("abc"));
        assert_eq!(params.code, None);
    }

    #[test]
    fn callback_params_empty_query() {
        assert_eq!(extract_callback_params(""), CallbackParams::default());
    }

    #[test]
    fn duplicate_keys_keep_first() {
        let params = extract_callback_params("code=first&code=second");
        assert_eq!(params.code.as_deref(), Some("first"));
    }

    #[test]
    fn request_target_extraction() {
        let request = "GET /oauth?code=x&state=y HTTP/1.1\r\nHost: 127.0.0.1:17248\r\nUser-Agent: Mozilla/5.0\r\n\r\n";
        assert_eq!(
            request_target(request).as_deref(),
            Some("/oauth?code=x&state=y")
        );
        assert_eq!(request_target("garbage\r\n\r\n"), None);
        assert_eq!(request_target(""), None);
    }

    #[test]
    fn callback_paths() {
        assert!(is_callback_path("/"));
        assert!(is_callback_path("/oauth"));
        assert!(is_callback_path("/oauth/"));
        assert!(!is_callback_path("/favicon.ico"));
        assert!(!is_callback_path("/oauth2"));
    }

    #[test]
    fn page_mentions_closing_the_window() {
        let ok = success_page_html(true);
        assert!(ok.contains("close this window"), "{ok}");
        assert!(ok.contains("emailer"), "{ok}");
        let failed = success_page_html(false);
        assert!(failed.contains("close this window"), "{failed}");
        assert!(failed.contains("error"), "{failed}");
    }

    // ----- Cancel registry (global; this test must stay the only user) -----

    #[test]
    fn superseded_flow_guard_keeps_the_new_signal() {
        // Flow A registers.
        let (mut rx_a, gen_a) = register_cancel_signal().unwrap();
        let guard_a = CancelGuard { generation: gen_a };

        // Flow B supersedes A: A's signal fires and B's is registered.
        let (_rx_b, gen_b) = register_cancel_signal().unwrap();
        assert_ne!(gen_a, gen_b);
        // A's wait observes the supersede.
        assert!(rx_a.try_recv().is_ok());

        // A's guard dropping must NOT remove B's cancel signal.
        drop(guard_a);
        {
            let pending = pending_cancel().lock().unwrap();
            assert!(pending.1.is_some(), "superseded guard removed B's signal");
        }

        // B is still cancellable, and cancelling bumps the generation so a
        // later guard can never remove a newer flow's entry.
        let cancelled = cancel_oauth_server().unwrap();
        assert!(cancelled, "B's pending signal should have been cancelled");
        {
            let pending = pending_cancel().lock().unwrap();
            assert!(pending.1.is_none());
            assert!(pending.0 > gen_b);
        }

        // Cancelling with nothing pending reports false.
        assert!(!cancel_oauth_server().unwrap());
    }

    #[test]
    fn own_guard_removes_own_signal() {
        let (_rx, generation) = register_cancel_signal().unwrap();
        {
            let _guard = CancelGuard { generation };
            let pending = pending_cancel().lock().unwrap();
            assert!(pending.1.is_some());
        }
        // The guard removed the entry when its own flow ended.
        let pending = pending_cancel().lock().unwrap();
        assert!(pending.1.is_none());
    }

    // ----- Listener binding (hermetic: loopback, ephemeral ports) -----

    #[tokio::test]
    async fn bind_prefers_the_requested_port() {
        let bound = bind_listener(Some(0)).await.expect("port 0 always binds");
        assert!(!bound.fell_back);
        assert_ne!(bound.port, 0);
    }

    #[tokio::test]
    async fn bind_falls_back_when_port_taken() {
        // Occupy an ephemeral port, then ask for exactly that port.
        let occupant = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let taken = occupant.local_addr().unwrap().port();

        let bound = bind_listener(Some(taken))
            .await
            .expect("ephemeral fallback should bind");
        assert!(bound.fell_back);
        assert_ne!(bound.port, taken);
    }

    #[tokio::test]
    async fn default_port_binds_or_falls_back() {
        let bound = bind_listener(None)
            .await
            .expect("some loopback port should bind");
        assert!(bound.port > 0);
    }

    #[tokio::test]
    async fn free_port_probe_returns_an_ephemeral_port() {
        let port = find_free_loopback_port(None).await.expect("port 0 always binds");
        assert_ne!(port, 0);
    }

    #[tokio::test]
    async fn free_port_probe_honours_a_free_preferred_port() {
        // Occupy an ephemeral port, then pick a different one for the probe.
        let occupant = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let taken = occupant.local_addr().unwrap().port();
        let port = find_free_loopback_port(Some(0)).await.unwrap();
        assert_ne!(port, 0);
        assert_ne!(port, taken);
    }

    #[tokio::test]
    async fn free_port_probe_reports_a_taken_preferred_port() {
        let occupant = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.unwrap();
        let taken = occupant.local_addr().unwrap().port();
        let error = find_free_loopback_port(Some(taken))
            .await
            .expect_err("a bound port cannot be handed out");
        assert!(error.contains("not available"), "{error}");
    }

    // ----- Full round-trip against a real (loopback, ephemeral) listener -----

    #[tokio::test]
    async fn serves_a_redirect_and_decodes_the_code() {
        let bound = bind_listener(Some(0)).await.unwrap();
        let (_tx, rx) = oneshot::channel::<()>();
        let waiter = tokio::spawn(serve_once(bound.listener, bound.port, rx));

        let mut conn = TcpStream::connect((Ipv4Addr::LOCALHOST, bound.port))
            .await
            .unwrap();
        let request = format!(
            "GET /oauth?code=4%2F0ABC&state=s%2F1 HTTP/1.1\r\nHost: 127.0.0.1:{}\r\n\r\n",
            bound.port
        );
        conn.write_all(request.as_bytes()).await.unwrap();

        let mut response = Vec::new();
        conn.read_to_end(&mut response).await.unwrap();
        let response = String::from_utf8_lossy(&response);
        assert!(response.starts_with("HTTP/1.1 200 OK"), "{response}");
        assert!(response.contains("close this window"), "{response}");

        let callback = waiter.await.unwrap().expect("should resolve with the code");
        assert_eq!(callback.port, bound.port);
        assert_eq!(callback.code.as_deref(), Some("4/0ABC"));
        assert_eq!(callback.state.as_deref(), Some("s/1"));
        assert_eq!(callback.error, None);
    }

    #[tokio::test]
    async fn relays_consent_denial_without_code() {
        let bound = bind_listener(Some(0)).await.unwrap();
        let (_tx, rx) = oneshot::channel::<()>();
        let waiter = tokio::spawn(serve_once(bound.listener, bound.port, rx));

        let mut conn = TcpStream::connect((Ipv4Addr::LOCALHOST, bound.port))
            .await
            .unwrap();
        conn.write_all(b"GET /?error=access_denied&state=s1 HTTP/1.1\r\nHost: x\r\n\r\n")
            .await
            .unwrap();
        let mut response = Vec::new();
        conn.read_to_end(&mut response).await.unwrap();

        let callback = waiter
            .await
            .unwrap()
            .expect("denial is still a resolved result");
        assert_eq!(callback.error.as_deref(), Some("access_denied"));
        assert_eq!(callback.state.as_deref(), Some("s1"));
        assert_eq!(callback.code, None);
    }

    #[tokio::test]
    async fn cancellation_aborts_the_wait() {
        let bound = bind_listener(Some(0)).await.unwrap();
        let (tx, rx) = oneshot::channel::<()>();
        let waiter = tokio::spawn(serve_once(bound.listener, bound.port, rx));

        tx.send(()).unwrap();
        let err = waiter
            .await
            .unwrap()
            .expect_err("cancel must abort the wait");
        assert!(err.contains("cancelled"), "{err}");
    }

    #[tokio::test]
    async fn non_callback_paths_are_ignored_then_callback_still_served() {
        let bound = bind_listener(Some(0)).await.unwrap();
        let (_tx, rx) = oneshot::channel::<()>();
        let waiter = tokio::spawn(serve_once(bound.listener, bound.port, rx));

        // Noise first (favicon) — must be answered 404 and not end the wait.
        let mut noise = TcpStream::connect((Ipv4Addr::LOCALHOST, bound.port))
            .await
            .unwrap();
        noise
            .write_all(b"GET /favicon.ico HTTP/1.1\r\nHost: x\r\n\r\n")
            .await
            .unwrap();
        let mut response = Vec::new();
        noise.read_to_end(&mut response).await.unwrap();
        let response = String::from_utf8_lossy(&response);
        assert!(response.starts_with("HTTP/1.1 404"), "{response}");

        // Then the real redirect.
        let mut conn = TcpStream::connect((Ipv4Addr::LOCALHOST, bound.port))
            .await
            .unwrap();
        conn.write_all(b"GET /oauth?code=zz&state=s HTTP/1.1\r\nHost: x\r\n\r\n")
            .await
            .unwrap();
        let callback = waiter.await.unwrap().expect("should serve after noise");
        assert_eq!(callback.code.as_deref(), Some("zz"));
    }
}
