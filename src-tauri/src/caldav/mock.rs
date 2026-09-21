//! Test-only loopback ROUTING mock server (task 5.2). The `ai::mock`
//! pattern (a `TcpListener` on `127.0.0.1:0`, one recorded request per
//! connection, a canned response) extended with a route table: CalDAV
//! discovery/sync are MULTI-request flows (principal → home → listing;
//! REPORT variants), so tests key canned responses on
//! method + target (+ optional `Depth` header / body substring).
//! Plaintext loopback HTTP is exactly what the shared transport policy
//! allows (see `caldav/http.rs`).

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::task::JoinHandle;

/// One request the mock received (headers preserved as sent; matching is
/// case-insensitive via [`RecordedRequest::header`]).
#[derive(Debug, Clone)]
pub(crate) struct RecordedRequest {
    pub method: String,
    /// Path + query as sent on the request line.
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

/// One canned route: `method` + `target` (exact match), optionally
/// narrowed by a `Depth` header value and/or a body substring (the two
/// REPORT bodies share a target), optionally consumed after a number of
/// matches (`.once()` — lets a test sequence DIFFERENT answers for
/// otherwise-identical requests, e.g. a 412 PUT followed by a retry).
#[derive(Debug, Clone)]
pub(crate) struct Route {
    pub method: &'static str,
    pub target: &'static str,
    pub depth: Option<&'static str>,
    pub body_marker: Option<&'static str>,
    /// `Some(n)` = this route stops matching after n answered requests.
    pub remaining: Option<usize>,
    pub response: String,
}

impl Route {
    pub(crate) fn new(method: &'static str, target: &'static str, response: String) -> Route {
        Route {
            method,
            target,
            depth: None,
            body_marker: None,
            remaining: None,
            response,
        }
    }

    /// Only match requests with this exact `Depth` header.
    pub(crate) fn with_depth(mut self, depth: u8) -> Route {
        self.depth = Some(match depth {
            0 => "0",
            1 => "1",
            other => Box::leak(format!("{other}").into_boxed_str()),
        });
        self
    }

    /// Only match requests whose body contains this substring.
    pub(crate) fn with_body_marker(mut self, marker: &'static str) -> Route {
        self.body_marker = Some(marker);
        self
    }

    /// Consume this route after ONE answered request (CardDAV tests
    /// sequence 412-then-retry flows with it).
    pub(crate) fn once(mut self) -> Route {
        self.remaining = Some(1);
        self
    }

    fn matches(&self, request: &RecordedRequest) -> bool {
        if self.remaining == Some(0) {
            return false;
        }
        if !self.method.eq_ignore_ascii_case(&request.method)
            || self.target != request.target
        {
            return false;
        }
        if let Some(depth) = self.depth {
            if request.header("depth") != Some(depth) {
                return false;
            }
        }
        if let Some(marker) = self.body_marker {
            if !request.body.contains(marker) {
                return false;
            }
        }
        true
    }
}

/// A running routing mock. Serves up to [`MAX_SERVED`] sequential
/// connections; records every request.
pub(crate) struct RouteMock {
    addr: SocketAddr,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    handle: JoinHandle<()>,
}

/// Connections served before the mock stops accepting (the flows under
/// test make at most a handful of calls each).
const MAX_SERVED: usize = 16;

const NOT_FOUND: &str = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

impl RouteMock {
    /// The base URL to hand to a client: loopback plaintext HTTP, which
    /// the shared transport policy explicitly allows.
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

/// Build a raw response the way real servers send it (Content-Length +
/// Connection: close) with an arbitrary header line.
pub(crate) fn raw_response(
    status: u16,
    reason: &str,
    header: &str,
    body: &str,
) -> String {
    format!(
        "HTTP/1.1 {status} {reason}\r\n{header}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.as_bytes().len()
    )
}

/// A 2xx response with an XML body (what PROPFIND/REPORT answers look
/// like; Radicale sends `application/xml; charset=utf-8`).
pub(crate) fn xml_response(status: u16, reason: &str, body: &str) -> String {
    raw_response(
        status,
        reason,
        "Content-Type: application/xml; charset=utf-8",
        body,
    )
}

/// A bare status with an empty body (401/403/404/440/3xx cases).
pub(crate) fn raw_status(status: u16, reason: &str) -> String {
    raw_response(status, reason, "Content-Type: text/plain", "")
}

/// Spawn a mock answering each connection with the FIRST matching route
/// (depth-/marker-constrained routes win over unconstrained ones; a
/// route consumed by `.once()` stops matching), or 404 when nothing
/// matches.
pub(crate) async fn spawn_routes(routes: Vec<Route>) -> RouteMock {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("loopback listener binds");
    let addr = listener.local_addr().expect("listener has an address");
    let routes = Arc::new(Mutex::new(routes));
    let requests = Arc::new(Mutex::new(Vec::new()));
    let requests_for_task = Arc::clone(&requests);
    let routes_for_task = Arc::clone(&routes);    let handle = tokio::spawn(async move {
        for _ in 0..MAX_SERVED {
            let Ok((mut connection, _)) = listener.accept().await else {
                break;
            };
            let Some(recorded) = read_request(&mut connection).await else {
                let _ = connection.write_all(NOT_FOUND.as_bytes()).await;
                continue;
            };
            requests_for_task
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .push(recorded.clone());
            // Constrained routes take precedence over catch-alls; each
            // match decrements a consumed route's remaining budget.
            let mut matched: Option<String> = None;
            {
                let mut routes = routes_for_task
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let find = |filter: &dyn Fn(&Route) -> bool| {
                    routes
                        .iter()
                        .position(|route| filter(route))
                };
                let position = find(&|route| route.matches(&recorded) && route.depth.is_some())
                    .or_else(|| {
                        find(&|route| route.matches(&recorded) && route.body_marker.is_some())
                    })
                    .or_else(|| find(&|route| route.matches(&recorded)));
                if let Some(position) = position {
                    matched = Some(routes[position].response.clone());
                    if routes[position].remaining.is_some() {
                        routes[position].remaining =
                            Some(routes[position].remaining.unwrap_or(1) - 1);
                    }
                }
            }
            let response = matched.unwrap_or_else(|| NOT_FOUND.to_string());
            let _ = connection.write_all(response.as_bytes()).await;
            let _ = connection.flush().await;
            // Drop closes the socket: the client's read-to-EOF ends.
            drop(connection);
        }
    });
    RouteMock {
        addr,
        requests,
        handle,
    }
}

/// Read one HTTP request: headers up to CRLFCRLF, then exactly
/// Content-Length body bytes (our client always sends Content-Length, so
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

impl Drop for RouteMock {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::caldav::http::request_raw;

    #[tokio::test]
    async fn routes_by_method_target_depth_and_marker() {
        let server = spawn_routes(vec![
            Route::new("PROPFIND", "/x/", raw_status(401, "Unauthorized")).with_depth(1),
            Route::new("REPORT", "/x/", raw_status(403, "Forbidden")).with_body_marker("sync"),
            Route::new("PROPFIND", "/x/", xml_response(207, "Multi-Status", "<m/>")),
        ])
        .await;
        let base = server.base_url();

        // Depth-1 hits the constrained route (precedence over the
        // unconstrained catch-all).
        let response = request_raw("PROPFIND", &format!("{base}/x/"), &[("depth", "1")], "<b/>")
            .await
            .expect("answered");
        assert_eq!(response.status, 401);
        // Depth-0 falls to the unconstrained route.
        let response = request_raw("PROPFIND", &format!("{base}/x/"), &[("depth", "0")], "<b/>")
            .await
            .expect("answered");
        assert_eq!(response.status, 207);
        assert_eq!(response.body, "<m/>");
        // The matching marker route wins over the catch-all.
        let response = request_raw("REPORT", &format!("{base}/x/"), &[], "sync-collection")
            .await
            .expect("answered");
        assert_eq!(response.status, 403);
        // A request no route matches → 404.
        let response = request_raw("GET", &format!("{base}/y/"), &[], "")
            .await
            .expect("answered");
        assert_eq!(response.status, 404);

        let requests = server.requests();
        assert_eq!(requests.len(), 4);
        assert_eq!(requests[0].header("depth"), Some("1"));
        assert_eq!(requests[3].method, "GET");
    }
}
