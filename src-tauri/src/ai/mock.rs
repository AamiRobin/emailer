//! Test-only loopback HTTP mock server (task 4.1). The same pattern as
//! the OAuth loopback-server tests in `oauth.rs`: a `TcpListener` on
//! `127.0.0.1:0`, one recorded request per connection, then a canned
//! response. Lets every provider client (and the custom-base-URL path)
//! be tested without any external network.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

/// One request the mock received (headers lowercased? no — preserved as
/// sent; [`RecordedRequest::header`] matches case-insensitively).
#[derive(Debug, Clone)]
pub(crate) struct RecordedRequest {
    pub method: String,
    /// Path + query as sent on the request line (Gemini's `?key=` lands
    /// here, so tests can assert the full target).
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl RecordedRequest {
    pub(crate) fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(header, _)| header.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// A running mock. Serves the same canned response to up to
/// [`MAX_SERVED`] sequential connections; records every request.
pub(crate) struct MockServer {
    addr: SocketAddr,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    handle: JoinHandle<()>,
}

/// Connections served before the mock stops accepting (tests make at
/// most a couple of calls each).
const MAX_SERVED: usize = 8;

impl MockServer {
    /// The base URL to hand to a client: loopback plaintext HTTP, which
    /// the shared transport's policy explicitly allows.
    pub(crate) fn base_url(&self) -> String {
        format!("http://{}", self.addr)
    }

    /// Copies of every recorded request so far.
    pub(crate) fn requests(&self) -> Vec<RecordedRequest> {
        self.requests
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

/// Build a response the way real providers send it (Content-Length +
/// Connection: close).
pub(crate) fn json_response(status: u16, reason: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.as_bytes().len()
    )
}

/// Spawn a mock answering every connection with the given canned
/// response.
pub(crate) async fn spawn(status: u16, reason: &str, body: &str) -> MockServer {
    spawn_raw(json_response(status, reason, body)).await
}

/// Spawn a mock answering with raw response bytes (for chunked /
/// missing-Content-Length variants).
pub(crate) async fn spawn_raw(response: String) -> MockServer {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("loopback listener binds");
    let addr = listener.local_addr().expect("listener has an address");
    let requests = Arc::new(Mutex::new(Vec::new()));
    let requests_for_task = Arc::clone(&requests);
    let handle = tokio::spawn(async move {
        for _ in 0..MAX_SERVED {
            let Ok((mut connection, _)) = listener.accept().await else {
                break;
            };
            if let Some(recorded) = read_request(&mut connection).await {
                requests_for_task
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .push(recorded);
            }
            let _ = connection.write_all(response.as_bytes()).await;
            let _ = connection.flush().await;
            // Drop closes the socket: the client's read-to-EOF ends.
            drop(connection);
        }
    });
    MockServer {
        addr,
        requests,
        handle,
    }
}

/// Read one HTTP request: headers up to CRLFCRLF, then exactly
/// Content-Length body bytes (our clients always send Content-Length, so
/// the mock never needs chunked request decoding).
async fn read_request(connection: &mut TcpStream) -> Option<RecordedRequest> {
    let mut buffer = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        let read = connection.read(&mut byte).await.ok()?;
        if read == 0 {
            return None;
        }
        buffer.push(byte[0]);
        if buffer.ends_with(b"\r\n\r\n") {
            break;
        }
        if buffer.len() > 64 * 1024 {
            return None;
        }
    }

    let head = String::from_utf8_lossy(&buffer).into_owned();
    let mut lines = head.split("\r\n");
    let request_line = lines.next()?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let mut headers = Vec::new();
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }
    let content_length = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);

    let mut body = Vec::with_capacity(content_length);
    while body.len() < content_length {
        let read = connection.read(&mut byte).await.ok()?;
        if read == 0 {
            break;
        }
        body.push(byte[0]);
    }

    Some(RecordedRequest {
        method,
        target,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai::http;

    #[tokio::test]
    async fn round_trips_a_post_and_records_it() {
        let server = spawn(200, "OK", r#"{"ok":true}"#).await;
        let response = http::post_json(
            &format!("{}/v1/test", server.base_url()),
            &[("authorization", "Bearer tok")],
            r#"{"hello":"world"}"#,
        )
        .await
        .expect("the mock answers");
        assert_eq!(response.status, 200);
        assert_eq!(response.body, r#"{"ok":true}"#);

        let requests = server.requests();
        assert_eq!(requests.len(), 1);
        let request = &requests[0];
        assert_eq!(request.method, "POST");
        assert_eq!(request.target, "/v1/test");
        assert_eq!(request.header("authorization"), Some("Bearer tok"));
        assert_eq!(request.header("content-length"), Some("17"));
        assert_eq!(request.body, r#"{"hello":"world"}"#);
    }

    #[tokio::test]
    async fn chunked_responses_are_decoded_by_the_client() {
        // No Content-Length; body arrives chunked: `{"split"` (8 bytes)
        // then `:true}` (6 bytes).
        let raw = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n\
            8\r\n{\"split\"\r\n\
            6\r\n:true}\r\n\
            0\r\n\r\n";
        let server = spawn_raw(raw.to_string()).await;
        let response = http::post_json(&server.base_url(), &[], "{}")
            .await
            .expect("answers");
        assert_eq!(response.status, 200);
        assert_eq!(response.body, r#"{"split":true}"#);
    }

    #[tokio::test]
    async fn non_2xx_statuses_pass_through_to_the_caller() {
        let server = spawn(503, "Service Unavailable", "overloaded").await;
        let response = http::post_json(&server.base_url(), &[], "{}")
            .await
            .expect("parses even on 503");
        assert_eq!(response.status, 503);
        assert_eq!(response.body, "overloaded");
    }
}

