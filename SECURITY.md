# Security Policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Use GitHub's
[private vulnerability reporting](https://github.com/AamiRobin/emailer/security/advisories/new)
to report directly to the maintainer, and include a description, the
affected version/commit, and reproduction steps.

## Scope notes

- emailer is local-first: messages, credentials and settings live in a
  local SQLite database. Account passwords and OAuth tokens are stored
  encrypted (keychain-backed); the malware hash-lookup feature sends only
  SHA-256 hashes of attachments to VirusTotal, and only when explicitly
  enabled in Settings → Attachment security.
- Updates are distributed via GitHub Releases and verified against a
  minisign public key baked into the app (`plugins.updater.pubkey` in
  `src-tauri/tauri.conf.json`). Do not trust installers from anywhere else.
