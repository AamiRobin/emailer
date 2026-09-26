# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/AamiRobin/emailer/security/advisories/new)
to report directly to the maintainer, and include a description, the
affected version/commit, and reproduction steps.

## Scope notes

- Emailer is local-first: messages, credentials and settings live in a
  local SQLite database. Account passwords and OAuth tokens are stored
  AES-256-GCM encrypted inside that database. The sealing key lives in
  the OS secret store (macOS Keychain, Windows Credential Manager,
  Linux Secret Service); hosts without a usable OS store fall back to
  a `credentials.key` file in the app-data directory with owner-only
  file permissions on Unix (best-effort). This protects against casual
  file access; on fallback hosts a determined attacker with full read
  access to your user profile could still recover the key. The malware
  hash-lookup feature sends only SHA-256 hashes of attachments to
  VirusTotal, and only when explicitly enabled in Settings → Attachment
  security.
- One-click List-Unsubscribe (RFC 8058) requests are issued by the app's
  Rust backend, which validates the target URL (HTTPS, no credentials,
  no redirects) before contacting the mailing-list server.
- Updates are distributed via GitHub Releases and verified against a
  minisign public key baked into the app (`plugins.updater.pubkey` in
  `src-tauri/tauri.conf.json`). Do not trust installers from anywhere else.
