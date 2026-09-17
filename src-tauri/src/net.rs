//! Small network helpers shared by the IMAP and SMTP clients.

/// True when `host` refers to this machine (loopback). Used to gate the
/// plaintext (`Security::None`) transport: credentials in clear text are
/// acceptable only for local mail bridges, never across a network.
pub fn is_loopback_host(host: &str) -> bool {
    // Strip IPv6 bracket notation ("[::1]:993" style hosts arrive bare, but
    // be lenient) and surrounding whitespace.
    let host = host.trim().trim_start_matches('[').trim_end_matches(']');
    host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<std::net::Ipv4Addr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
        || host
            .parse::<std::net::Ipv6Addr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false)
}

/// Reject plaintext transports (`Security::None`) for non-loopback hosts:
/// credentials must never cross a network in clear text. TLS/STARTTLS pass
/// unconditionally.
pub fn require_plaintext_host_is_loopback(plaintext: bool, host: &str) -> Result<(), String> {
    if !plaintext || is_loopback_host(host) {
        return Ok(());
    }
    Err(format!(
        "unencrypted connections are only allowed to localhost/127.0.0.1 — use TLS or STARTTLS for {host}"
    ))
}

#[cfg(test)]
mod tests {
    use super::{is_loopback_host, require_plaintext_host_is_loopback};

    #[test]
    fn loopback_hosts_are_recognized() {
        assert!(is_loopback_host("localhost"));
        assert!(is_loopback_host("LOCALHOST"));
        assert!(is_loopback_host("127.0.0.1"));
        assert!(is_loopback_host("127.9.9.9"));
        assert!(is_loopback_host("::1"));
        assert!(is_loopback_host("[::1]"));
        assert!(is_loopback_host(" localhost "));
    }

    #[test]
    fn remote_hosts_are_rejected() {
        assert!(!is_loopback_host("imap.example.com"));
        assert!(!is_loopback_host("192.168.1.10"));
        assert!(!is_loopback_host("10.0.0.1"));
        assert!(!is_loopback_host("::2"));
        assert!(!is_loopback_host("::ffff:127.0.0.1"));
        assert!(!is_loopback_host(""));
    }

    #[test]
    fn plaintext_gate() {
        // TLS always passes, plaintext passes only on loopback.
        assert!(require_plaintext_host_is_loopback(false, "imap.example.com").is_ok());
        assert!(require_plaintext_host_is_loopback(true, "localhost").is_ok());
        assert!(require_plaintext_host_is_loopback(true, "127.0.0.1").is_ok());
        let err = require_plaintext_host_is_loopback(true, "imap.example.com").unwrap_err();
        assert!(err.contains("unencrypted connections"));
    }
}
