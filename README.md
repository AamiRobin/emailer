# emailer

A cross-platform desktop email client built with Tauri 2 — Gmail via the REST
API, IMAP/SMTP for other providers, with local-first storage and background
sync.

## Stack

- **Frontend:** React 19 + TypeScript + Vite, Tailwind CSS 4, shadcn/ui,
  Zustand, Tiptap (composer)
- **Backend (Rust):** `async-imap`, `lettre`, `tokio` — connections are
  stateless: each command connects, works, and logs out
- **Storage:** SQLite (tauri-plugin-sql), OS keychain-backed credential
  encryption, Rust-managed attachment cache

## Development

```bash
bun install
bun run tauri dev      # run the desktop app in dev mode
bun run test           # vitest (frontend unit tests)
cargo test             # run inside src-tauri/ (Rust unit tests)
bun run build          # typecheck + production frontend build
```

### Run in a browser with mock data

```bash
bun run dev:mock       # http://localhost:3000
```

Serves the UI in a plain browser against an in-memory SQLite (official
SQLite WASM) seeded with a realistic two-account mailbox — threads,
labels, drafts, contacts, search all work. Tauri-only surfaces are
stubbed: account add/OAuth flows and attachment downloads are disabled,
sync commands report healthy empty results, and sends file locally only.
An amber "MOCK DATA" pill marks the mode. The desktop app and production
build are unaffected (the mock wiring only activates in `--mode mock`).

## Conventions

UI conventions, design tokens, and the email-content style-isolation rules
live in [docs/ui-guide.md](docs/ui-guide.md). In-progress change plans and
task breakdowns live in `openspec/` (local only, not committed).

## Security notes

The CSP keeps `script-src 'unsafe-inline'` deliberately: besides the resize
reporter inside the sandboxed email frame, `next-themes` (the theme provider)
injects a runtime inline script whose bytes come from minified library
internals — they cannot be pinned by a stable sha256 hash, and CSP3 ignores
`'unsafe-inline'` wherever a hash is present. Revisit if the theme provider is
ever replaced.
