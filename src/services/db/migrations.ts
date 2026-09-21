/**
 * Versioned schema migrations, applied in order by the runner in
 * connection.ts. To change the schema, append a new entry to MIGRATIONS —
 * never edit an applied migration.
 *
 * Each migration carries its SQL as an array of single statements (no
 * statement splitting needed at runtime; triggers are kept whole). The
 * runner wraps every migration in a transaction and records applied
 * versions in the `_migrations` table.
 */

export interface Migration {
  version: number
  description: string
  statements: string[]
  /**
   * Run with `PRAGMA foreign_keys = OFF` on the connection (restored
   * right after COMMIT). REQUIRED for migrations that DROP a table other
   * tables reference: with FKs on, dropping a parent table executes an
   * implicit DELETE that cascades away every child row. The pragma is a
   * no-op inside a transaction, so the runner must set it before BEGIN —
   * it cannot live in `statements`.
   */
  foreignKeysOff?: boolean
}

/** DDL for the bookkeeping table the migration runner tracks itself by. */
export const MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS _migrations (
    version INTEGER PRIMARY KEY,
    description TEXT,
    applied_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    description: "Core schema: 12 mail tables plus messages FTS5 index",
    statements: [
      // All timestamps are INTEGER unix epoch seconds. IDs are app-generated
      // UUIDs stored as TEXT. JSON-encoded values are stored as TEXT.
      `
        CREATE TABLE IF NOT EXISTS accounts (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK (type IN ('gmail', 'imap')),
          email TEXT NOT NULL UNIQUE,
          display_name TEXT,
          -- IMAP/SMTP connection config (unused for gmail accounts)
          imap_host TEXT,
          imap_port INTEGER,
          imap_security TEXT CHECK (imap_security IN ('tls', 'starttls', 'none')),
          smtp_host TEXT,
          smtp_port INTEGER,
          smtp_security TEXT CHECK (smtp_security IN ('tls', 'starttls', 'none')),
          -- AES-GCM encrypted JSON envelope holding provider credentials
          -- (oauth tokens for gmail, password for imap); ciphertext is
          -- stored as TEXT. Plaintext must never be persisted.
          credentials_json TEXT,
          oauth_scope TEXT,
          oauth_client_id TEXT,
          -- Delta-sync cursors: gmail history id plus a labels-sync marker
          gmail_history_id TEXT,
          labels_synced_at INTEGER,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'auth-error')),
          last_sync_at INTEGER,
          last_full_sync_at INTEGER,
          is_active INTEGER NOT NULL DEFAULT 1,
          is_pinned INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS labels (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          -- Full label name including "/" hierarchy segments
          name TEXT NOT NULL,
          gmail_label_id TEXT,
          imap_folder_name TEXT,
          -- RFC 6154 special-use role; NULL for plain labels
          special_use TEXT CHECK (special_use IN (
            'inbox', 'sent', 'drafts', 'trash', 'spam', 'archive', 'all', 'flagged'
          )),
          color TEXT,
          type TEXT NOT NULL CHECK (type IN ('system', 'user')),
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE (account_id, name)
        )
      `,
      `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_account_gmail
          ON labels(account_id, gmail_label_id) WHERE gmail_label_id IS NOT NULL
      `,
      `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_labels_account_imap_folder
          ON labels(account_id, imap_folder_name) WHERE imap_folder_name IS NOT NULL
      `,
      `CREATE INDEX IF NOT EXISTS idx_labels_account ON labels(account_id)`,
      // Archive/trash/spam representation: the canonical state lives in the
      // joins and provider columns — gmail: thread_labels membership (e.g.
      // absent INBOX / present TRASH, SPAM label rows), imap: which folder
      // messages.imap_folder points at. is_archived/is_trashed/is_spam and
      // folder_label_id are denormalized caches for list queries, rebuilt
      // from the canonical state on launch/sync.
      `
        CREATE TABLE IF NOT EXISTS threads (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          subject TEXT,
          snippet TEXT,
          first_message_at INTEGER,
          last_message_at INTEGER,
          message_count INTEGER NOT NULL DEFAULT 0,
          unread_count INTEGER NOT NULL DEFAULT 0,
          has_attachments INTEGER NOT NULL DEFAULT 0,
          is_starred INTEGER NOT NULL DEFAULT 0,
          -- Provider identifiers: gmail thread id (unique per account when
          -- present); imap threads have no server id and are grouped by
          -- references, so this stays NULL
          gmail_thread_id TEXT,
          -- IMAP: labels.id of the folder this thread currently lives in
          folder_label_id TEXT REFERENCES labels(id) ON DELETE SET NULL,
          is_archived INTEGER NOT NULL DEFAULT 0,
          is_trashed INTEGER NOT NULL DEFAULT 0,
          is_spam INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `,
      `
        CREATE INDEX IF NOT EXISTS idx_threads_account_date
          ON threads(account_id, last_message_at DESC)
      `,
      `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_threads_account_gmail
          ON threads(account_id, gmail_thread_id) WHERE gmail_thread_id IS NOT NULL
      `,
      `
        CREATE TABLE IF NOT EXISTS thread_labels (
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
          -- Denormalized from thread/label for account-scoped joins and wipes
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          PRIMARY KEY (thread_id, label_id)
        )
      `,
      `
        CREATE INDEX IF NOT EXISTS idx_thread_labels_account_label
          ON thread_labels(account_id, label_id)
      `,
      `
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          -- Provider identifiers, mutually exclusive by account type; the
          -- partial unique indexes below enforce uniqueness only when set
          gmail_message_id TEXT,
          imap_uid INTEGER,
          imap_folder TEXT,
          -- RFC 5322 threading headers (references_header is the raw chain)
          message_id_header TEXT,
          in_reply_to TEXT,
          references_header TEXT,
          subject TEXT,
          from_name TEXT,
          from_address TEXT,
          to_json TEXT,
          cc_json TEXT,
          bcc_json TEXT,
          date INTEGER NOT NULL,
          snippet TEXT,
          body_html TEXT,
          body_text TEXT,
          headers TEXT,
          size_estimate INTEGER,
          is_read INTEGER NOT NULL DEFAULT 0,
          is_flagged INTEGER NOT NULL DEFAULT 0,
          has_attachments INTEGER NOT NULL DEFAULT 0,
          -- Parsed MIME part metadata (attachment descriptors incl. provider
          -- part ids); the attachments table is the queryable projection
          parts_json TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `,
      `
        CREATE INDEX IF NOT EXISTS idx_messages_thread_date
          ON messages(thread_id, date)
      `,
      `
        CREATE INDEX IF NOT EXISTS idx_messages_account_date
          ON messages(account_id, date DESC)
      `,
      `
        CREATE INDEX IF NOT EXISTS idx_messages_account_message_id_header
          ON messages(account_id, message_id_header)
      `,
      `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_account_gmail
          ON messages(account_id, gmail_message_id) WHERE gmail_message_id IS NOT NULL
      `,
      `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_account_folder_uid
          ON messages(account_id, imap_folder, imap_uid)
          WHERE imap_folder IS NOT NULL AND imap_uid IS NOT NULL
      `,
      `
        CREATE TABLE IF NOT EXISTS attachments (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          filename TEXT,
          mime_type TEXT,
          size INTEGER,
          -- cid: for inline references
          content_id TEXT,
          is_inline INTEGER NOT NULL DEFAULT 0,
          -- gmail attachment id or imap MIME section path
          provider_part_id TEXT,
          -- Disk cache bookkeeping (D15): content is fetched on first open
          local_path TEXT,
          cached_at INTEGER,
          cache_size INTEGER
        )
      `,
      `
        CREATE INDEX IF NOT EXISTS idx_attachments_message
          ON attachments(message_id)
      `,
      `
        CREATE INDEX IF NOT EXISTS idx_attachments_account_cached
          ON attachments(account_id, cached_at)
      `,
      // Contacts are per account so account removal cascades cleanly
      `
        CREATE TABLE IF NOT EXISTS contacts (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          email TEXT NOT NULL,
          name TEXT,
          interaction_count INTEGER NOT NULL DEFAULT 0,
          last_interaction_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE (account_id, email)
        )
      `,
      `
        CREATE INDEX IF NOT EXISTS idx_contacts_account_interactions
          ON contacts(account_id, interaction_count DESC)
      `,
      `
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          -- JSON-encoded value
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `,
      // Offline mutation queue (D10). seq is the FIFO replay order.
      `
        CREATE TABLE IF NOT EXISTS pending_operations (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          id TEXT NOT NULL UNIQUE,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          op_type TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
            'pending', 'processing', 'done', 'failed'
          )),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `,
      `
        CREATE INDEX IF NOT EXISTS idx_pending_operations_queue
          ON pending_operations(status, seq)
      `,
      // Local-only composer drafts (no server draft sync in this change)
      `
        CREATE TABLE IF NOT EXISTS local_drafts (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          draft_key TEXT,
          subject TEXT,
          to_json TEXT,
          cc_json TEXT,
          bcc_json TEXT,
          body_html TEXT,
          attachments_json TEXT,
          -- message-id header of the message being replied to
          in_reply_to TEXT,
          thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `,
      `
        CREATE INDEX IF NOT EXISTS idx_local_drafts_account_updated
          ON local_drafts(account_id, updated_at DESC)
      `,
      `
        CREATE INDEX IF NOT EXISTS idx_local_drafts_account_key
          ON local_drafts(account_id, draft_key)
      `,
      `
        CREATE TABLE IF NOT EXISTS image_allowlist (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          sender_email TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (account_id, sender_email)
        )
      `,
      // IMAP per-folder incremental sync cursors; uidvalidity change forces
      // a full folder re-sync
      `
        CREATE TABLE IF NOT EXISTS folder_sync_state (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          folder_name TEXT NOT NULL,
          uidvalidity INTEGER,
          last_seen_uid INTEGER NOT NULL DEFAULT 0,
          -- CONDSTORE cursor for flag-only delta queries (D14)
          highest_modseq INTEGER,
          last_sync_at INTEGER,
          UNIQUE (account_id, folder_name)
        )
      `,
      // FTS5 ships in v1 (external-content, trigram tokenizer for substring
      // matching per D3) so the 2.2 query layer can rely on it. The triggers
      // below keep the index in sync on every message insert/update/delete,
      // which is the index upkeep 2.2 needs. body_html is deliberately not
      // indexed — only text parts (design risk note: no raw markup in FTS).
      `
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          subject,
          from_name,
          from_address,
          to_json,
          body_text,
          snippet,
          content='messages',
          content_rowid='rowid',
          tokenize='trigram'
        )
      `,
      `
        CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts (
            rowid, subject, from_name, from_address, to_json, body_text, snippet
          )
          VALUES (
            new.rowid, new.subject, new.from_name, new.from_address,
            new.to_json, new.body_text, new.snippet
          );
        END
      `,
      `
        CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts (
            messages_fts, rowid, subject, from_name, from_address, to_json,
            body_text, snippet
          )
          VALUES (
            'delete', old.rowid, old.subject, old.from_name, old.from_address,
            old.to_json, old.body_text, old.snippet
          );
        END
      `,
      `
        CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts (
            messages_fts, rowid, subject, from_name, from_address, to_json,
            body_text, snippet
          )
          VALUES (
            'delete', old.rowid, old.subject, old.from_name, old.from_address,
            old.to_json, old.body_text, old.snippet
          );
          INSERT INTO messages_fts (
            rowid, subject, from_name, from_address, to_json, body_text, snippet
          )
          VALUES (
            new.rowid, new.subject, new.from_name, new.from_address,
            new.to_json, new.body_text, new.snippet
          );
        END
      `,
    ],
  },
  {
    // v2 (task 6.4): denormalized participants cache for the thread list —
    // rows must show the latest message's sender (+ a couple of recipients)
    // without an N+1 messages lookup per thread. JSON array of
    // {name?, email} contacts, maintained by recomputeThreadCaches like the
    // other per-thread caches.
    version: 2,
    description: "Add threads.participants JSON cache column",
    statements: ["ALTER TABLE threads ADD COLUMN participants TEXT"],
  },
  {
    // v3 (task 1.1): competitor-parity foundations from the design Migration
    // Plan — thread state as columns (D1) plus the delivery-schedule pair
    // (D6), and the ten feature tables later tasks build on.
    version: 3,
    description:
      "Parity schema: thread state columns and 10 feature tables " +
      "(snippets, saved searches, scheduled sends, follow-ups, blocked " +
      "senders, aliases, sender stats, notification rules, rules, todos)",
    statements: [
      // Thread states live directly on threads (D1) so every existing list
      // query and the pinned-first ordering stay join-free; NULL means the
      // state is inactive. held_until/delivered_at back the delivery
      // windows (D6): inbox queries exclude held threads and order by the
      // release time. One ADD COLUMN per statement — SQLite cannot batch
      // them.
      "ALTER TABLE threads ADD COLUMN snoozed_until INTEGER",
      "ALTER TABLE threads ADD COLUMN muted_at INTEGER",
      "ALTER TABLE threads ADD COLUMN pinned_at INTEGER",
      "ALTER TABLE threads ADD COLUMN done_at INTEGER",
      "ALTER TABLE threads ADD COLUMN note TEXT",
      "ALTER TABLE threads ADD COLUMN held_until INTEGER",
      "ALTER TABLE threads ADD COLUMN delivered_at INTEGER",
      // Composer text templates (task 6); deliberately global rather than
      // account-scoped so a snippet is available from every account.
      `
        CREATE TABLE IF NOT EXISTS snippets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          body TEXT NOT NULL,
          -- Optional abbreviation that expands the snippet when typed
          shortcut TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `,
      // Stored query strings re-run through the search parser and
      // query-builder (D4, task 7); position keeps the sidebar ordering
      // stable across renames.
      `
        CREATE TABLE IF NOT EXISTS saved_searches (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          query TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `,
      // Send-later jobs (D3, task 10): the fully built MIME payload means
      // firing needs no composer state, even after a restart. status moves
      // scheduled → sending → sent | failed; cancelled hides a row before
      // transmission.
      `
        CREATE TABLE IF NOT EXISTS scheduled_sends (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          mime_payload TEXT NOT NULL,
          -- JSON-encoded resolved recipients for the Scheduled view
          recipients_json TEXT NOT NULL,
          subject TEXT,
          due_at INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN (
            'scheduled', 'sending', 'sent', 'failed', 'cancelled'
          )),
          last_error TEXT,
          sent_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `,
      // Follow-up reminders attached at send time (D8, task 14.2): the
      // ingestion hook cancels one when a threaded reply arrives
      // (cancelled_at set, row kept) and the due pass resurfaces due ones.
      `
        CREATE TABLE IF NOT EXISTS followup_reminders (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          due_at INTEGER NOT NULL,
          cancelled_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `,
      `
        CREATE INDEX IF NOT EXISTS idx_followup_reminders_account_due
          ON followup_reminders(account_id, due_at)
      `,
      // Sender blocklist (task 18.2): the ingestion hook auto-files new
      // mail from these senders per `action`.
      `
        CREATE TABLE IF NOT EXISTS blocked_senders (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          sender TEXT NOT NULL,
          action TEXT NOT NULL DEFAULT 'trash' CHECK (action IN (
            'trash', 'archive'
          )),
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE (account_id, sender)
        )
      `,
      // Send-as identities (D10, task 16): gmail rows come from the SendAs
      // API, imap rows are manual. The From header carries the alias while
      // the SMTP envelope stays on the account's primary address.
      `
        CREATE TABLE IF NOT EXISTS aliases (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          email TEXT NOT NULL,
          display_name TEXT,
          is_default INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL CHECK (source IN ('gmail', 'imap')),
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE (account_id, email)
        )
      `,
      // Per-sender statistics filled at ingestion (D5, task 13): the
      // priority inbox heuristic scores reply counts, direct-to-me hits,
      // recency and mailing-list participation (D7).
      `
        CREATE TABLE IF NOT EXISTS sender_stats (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          sender TEXT NOT NULL,
          reply_count INTEGER NOT NULL DEFAULT 0,
          direct_to_me_count INTEGER NOT NULL DEFAULT 0,
          last_message_at INTEGER,
          is_mailing_list INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE (account_id, sender)
        )
      `,
      // Per-sender/per-label notification overrides (D16, task 8), checked
      // per new message before the OS notification and the badge increment.
      `
        CREATE TABLE IF NOT EXISTS notification_rules (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          match_type TEXT NOT NULL CHECK (match_type IN ('sender', 'label')),
          match_value TEXT NOT NULL,
          action TEXT NOT NULL CHECK (action IN ('always', 'never')),
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE (account_id, match_type, match_value)
        )
      `,
      // Local mail rules (D5, task 11): criteria reuse the search parser's
      // AST serialized as JSON; actions compile to existing queue op kinds.
      // position is the deterministic evaluation order; only enabled rows
      // run at ingestion.
      `
        CREATE TABLE IF NOT EXISTS rules (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          criteria_json TEXT NOT NULL,
          actions_json TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          position INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `,
      // Cross-account todo list of threads (task 15.2): position is the
      // manual ordering, completed_at marks completion.
      `
        CREATE TABLE IF NOT EXISTS todos (
          id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
          position INTEGER NOT NULL DEFAULT 0,
          completed_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE (thread_id)
        )
      `,
      // The (account_id, sender) index the design risk note calls for goes
      // on messages(from_address) — the hot path for the bundle and sort
      // queries that group by sender (D4); sender_stats already carries a
      // UNIQUE(account_id, sender) of its own.
      `
        CREATE INDEX IF NOT EXISTS idx_messages_account_from
          ON messages(account_id, from_address)
      `,
      `
        CREATE INDEX IF NOT EXISTS idx_threads_account_held
          ON threads(account_id, held_until)
      `,
      // Partial: only non-NULL wake-ups are scanned (Snoozed view, due pass)
      `
        CREATE INDEX IF NOT EXISTS idx_threads_snoozed_until
          ON threads(snoozed_until) WHERE snoozed_until IS NOT NULL
      `,
    ],
  },
  {
    // v4 (task 13.2, design D7): per-sender priority-inbox overrides. The
    // user's Important/Other call must dominate the D7 heuristic score, so
    // it lives beside the stats it overrides (one row per sender either
    // way). NULL = no override — the sender classifies purely on its score.
    // Additive and backfill-free: existing rows start unoverridden.
    version: 4,
    description: "Add sender_stats.user_class priority override column",
    statements: [
      "ALTER TABLE sender_stats ADD COLUMN user_class TEXT CHECK (user_class IN ('important', 'other'))",
    ],
  },
  {
    // v5 (task 17.x, design D9): the server-side mirror of a local draft.
    // JSON-encoded ServerDraftRef — {provider:"gmail", draftId} after a
    // Drafts API create, or {provider:"imap", folder, uid} after an
    // imap_append whose copy was located by the draft's stable Message-ID.
    // NULL = not mirrored yet (the queue's draft_upsert creates it).
    // Additive and backfill-free: existing drafts simply mirror on their
    // next autosave.
    version: 5,
    description: "Add local_drafts.server_draft_ref server-mirror column",
    statements: ["ALTER TABLE local_drafts ADD COLUMN server_draft_ref TEXT"],
  },
  {
    // v6 (task 1.3, design D18/D19): the security additions. junk_tokens is
    // the naive-Bayes tokenizer's training store (D19): one row per
    // (account, token) with spam/ham counts — probabilities are computed
    // from the counts at classification time, so training only ever updates
    // counters. Gmail accounts never train it, but the schema is shared.
    // attachment_scan_cache (D18) caches hash-lookup verdicts per SHA-256 —
    // the hash is the identity, so rows are global, not account-scoped.
    // Engine counts back the "N of M engines" report and stay nullable so
    // an 'unknown' verdict (failed lookup) can be cached too and re-checked
    // via looked_up_at instead of re-querying on every open.
    version: 6,
    description:
      "Security schema: junk_tokens token counts and " +
      "attachment_scan_cache malware verdicts",
    statements: [
      // Per-account token counts (D19, task 18.10). The composite PK is the
      // natural identity — it serves both training upserts and the
      // account-scoped token lookups classification needs, so no extra
      // index; account deletion cascades the whole store.
      `
        CREATE TABLE IF NOT EXISTS junk_tokens (
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          token TEXT NOT NULL,
          spam_count INTEGER NOT NULL DEFAULT 0,
          ham_count INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (account_id, token)
        )
      `,
      // Global verdict cache keyed by SHA-256 (D18, task 18.9): one lookup
      // per file content, shared across accounts.
      `
        CREATE TABLE IF NOT EXISTS attachment_scan_cache (
          sha256 TEXT PRIMARY KEY,
          verdict TEXT NOT NULL CHECK (verdict IN (
            'malicious', 'suspicious', 'clean', 'unknown'
          )),
          malicious_count INTEGER,
          total_engines INTEGER,
          looked_up_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `,
    ],
  },
  {
    // v7 (task 20.2, contacts spec): free-form notes on a contact, edited
    // from the Contacts browser. Additive and backfill-free: existing rows
    // simply have no notes yet (NULL = none).
    version: 7,
    description: "Add contacts.notes free-form notes column",
    statements: ["ALTER TABLE contacts ADD COLUMN notes TEXT"],
  },
  {
    // v8 (task 2.1, design D10): compact SPF/DKIM/DMARC verdicts parsed
    // from the message's Authentication-Results headers at ingestion
    // ("spf=pass;dkim=fail;dmarc=none", worst value wins per mechanism —
    // see imap::auth_results / email/auth-results.ts). The badge reads the
    // column directly instead of re-parsing the stored raw headers.
    // Additive and backfill-free: NULL = no Authentication-Results at all,
    // the spec's "no headers → no badge".
    version: 8,
    description: "Add messages.auth_results compact verdicts column",
    statements: ["ALTER TABLE messages ADD COLUMN auth_results TEXT"],
  },
  {
    // v9 (task 3.3, design D4): the automatic-categorization store.
    //
    // threads.category holds the inbox tab the thread files under — one of
    // the five spec values ('primary' | 'updates' | 'promotions' | 'social'
    // | 'newsletters'). NULL SEMANTICS: NULL means "not yet categorized" —
    // rows that predate this migration stay NULL until the user-triggered
    // backfill (task 3.4) runs; the categorization/ingestion.ts pass ALWAYS
    // writes one of the five values for newly inserted messages (unmatched
    // mail is written as 'primary', the spec's default) and never
    // overwrites a non-NULL value, so a per-thread user override (task 3.4)
    // is stable across later arrivals. The tab UI (task 3.5) renders NULL
    // and 'primary' identically in the Primary tab.
    //
    // sender_categories is the per-SENDER category override/"rule" store
    // (D4: user "always from sender" writes here — deliberately not a
    // rules-table row, to keep the rules UI unpolluted). sender_key is the
    // lowercased address (see categorization/sender-categories.ts) and the
    // natural primary key: a sender is a sender across accounts, like the
    // contacts/participant matching. source records who decided — 'user'
    // (an explicit override; the spec makes it "the rule for that sender"),
    // 'heuristic' (learned by the local rule engine, e.g. a backfill), or
    // 'ai' (the later AI assist, sender-cached per D2).
    version: 9,
    description:
      "Categorization schema: threads.category column and " +
      "sender_categories overrides table",
    statements: [
      "ALTER TABLE threads ADD COLUMN category TEXT CHECK (category IN " +
        "('primary', 'updates', 'promotions', 'social', 'newsletters'))",
      `
        CREATE TABLE IF NOT EXISTS sender_categories (
          sender_key TEXT PRIMARY KEY,
          category TEXT NOT NULL CHECK (category IN (
            'primary', 'updates', 'promotions', 'social', 'newsletters'
          )),
          source TEXT NOT NULL CHECK (source IN ('user', 'heuristic', 'ai')),
          updated_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `,
    ],
  },
  {
    // v10 (task 4.3, design D2): the AI assistance stores. ai_cache caches
    // provider results keyed by content — the services/ai layer computes
    // input_hash as sha256(provider|model|kind|input) over a JSON
    // serialization (see ai/cache.ts), so the UNIQUE triple is the cache
    // identity and the same input+model+provider always reuses its stored
    // output. kind is the AI surface ("summary", "categorization", …) —
    // deliberately open text like the table itself (no CHECK): the cache is
    // dumb storage and later surfaces add kinds without a migration.
    // account_id is PROVENANCE (the account whose mail produced the input —
    // summaries carry the summarized thread's account, categorization
    // entries the account being categorized), not part of the key: identical
    // inputs share one row across accounts, so the column is a nullable FK
    // -free attribution and the spec's "account removal clears cache"
    // scenario is an explicit DELETE by account_id (ai/purgeAiCacheForAccount,
    // hooked into removeAccount) rather than an ON DELETE CASCADE.
    // writing_style_profiles is the one-row-per-account writing-style profile
    // the smart-reply surface matches against; profile_json is opaque here —
    // its schema is owned by the style-analysis caller (task 4.5).
    version: 10,
    description:
      "AI schema: ai_cache content-hash result cache and " +
      "writing_style_profiles per-account profiles",
    statements: [
      `
        CREATE TABLE IF NOT EXISTS ai_cache (
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          input_hash TEXT NOT NULL,
          kind TEXT NOT NULL,
          output TEXT NOT NULL,
          account_id TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          UNIQUE (provider, model, input_hash)
        )
      `,
      `
        CREATE TABLE IF NOT EXISTS writing_style_profiles (
          account_id TEXT PRIMARY KEY,
          profile_json TEXT NOT NULL,
          built_at INTEGER NOT NULL,
          sample_size INTEGER NOT NULL
        )
      `,
    ],
  },
  {
    // v11 (task 5.1, design D5): the calendar foundation. calendar_sources is
    // one connected calendar account (Google now, CalDAV later); its
    // config_json carries the provider-specific connection settings — for
    // google this is the SEALED OAuth token envelope (AES-GCM via
    // encryptCredentials, like accounts.credentials_json; plaintext tokens
    // are never persisted). The envelope deliberately lives per source and
    // NOT in the mail account's credentials: the calendar consent round
    // yields its own refresh token scoped for the calendar grant, so
    // removing/re-authing a calendar source can never touch the mail
    // account's stored credentials (the spec's remove-does-not-touch-mail
    // scenario) — and vice versa.
    //
    // Tweak vs the task sketch: a nullable sync_state_json column holds the
    // per-calendar incremental-sync bookkeeping
    // ({ "<calendarId>": { nextSyncToken, lastSyncAt, lastError } }) as
    // plain JSON — sync cursors are not secrets, so they stay out of the
    // sealed envelope and refresh without a decrypt/encrypt round-trip.
    //
    // account_id is a nullable link to the mail account the source was
    // connected from (NULL for later CalDAV sources, which have none).
    // Tweak: it carries ON DELETE CASCADE so deleting a mail account cleans
    // up its calendar sources and their sealed tokens; the spec only fixes
    // the reverse direction (source removal never touches mail), which the
    // cascade leaves intact.
    //
    // calendar_events caches one event per (source, calendar, uid) with the
    // ical text (minimal RFC 5545 VEVENT rendered from the provider payload
    // — see calendar/google-calendar.ts) for the uniform iCalendar surface
    // later tasks parse. all_day is 0/1; start_at/end_at are unix epoch
    // seconds (all-day events sit at UTC midnight, end exclusive — the
    // Google `date` convention). status is Google's
    // confirmed/tentative/cancelled, recurrence the raw recurrence-rule
    // array JSON ("RRULE:..."). The UNIQUE triple is the upsert identity;
    // idx_calendar_events_start_at is the range index the month/week/day
    // views (task 5.3) query by.
    version: 11,
    description:
      "Calendar schema: calendar_sources connections and " +
      "calendar_events cached events",
    statements: [
      `
        CREATE TABLE IF NOT EXISTS calendar_sources (
          id TEXT PRIMARY KEY,
          -- The mail account this source was connected from (google);
          -- NULL for providers without a linked mail account (caldav)
          account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
          provider TEXT NOT NULL CHECK (provider IN ('google', 'caldav')),
          name TEXT NOT NULL,
          -- Provider-specific connection config; google = AES-GCM sealed
          -- OAuth token envelope (calendar-scoped refresh token), caldav =
          -- url/username/app-password-sealed (lands with task 5.2).
          -- Plaintext must never be persisted.
          config_json TEXT NOT NULL,
          -- Per-calendar incremental sync cursors (plain JSON, not a
          -- secret — kept out of the sealed config envelope)
          sync_state_json TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `,
      `
        CREATE INDEX IF NOT EXISTS idx_calendar_sources_account
          ON calendar_sources(account_id)
      `,
      `
        CREATE TABLE IF NOT EXISTS calendar_events (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES calendar_sources(id)
            ON DELETE CASCADE,
          -- The provider's stable event id (google: events.id; unique per
          -- calendar, not per account — hence the calendar_id in the key)
          uid TEXT NOT NULL,
          calendar_id TEXT NOT NULL,
          -- The event in iCalendar form (minimal VEVENT rendered from the
          -- provider payload) so downstream consumers treat every source
          -- uniformly
          ical TEXT NOT NULL,
          summary TEXT,
          location TEXT,
          description TEXT,
          start_at INTEGER NOT NULL,
          end_at INTEGER NOT NULL,
          all_day INTEGER NOT NULL DEFAULT 0,
          -- Raw recurrence-rule array JSON ("RRULE:...", "EXDATE:..."),
          -- NULL for non-recurring events
          recurrence TEXT,
          -- confirmed | tentative | cancelled
          status TEXT,
          -- The provider's last-modified timestamp (epoch seconds)
          updated_at INTEGER,
          UNIQUE (source_id, calendar_id, uid)
        )
      `,
      `
        CREATE INDEX IF NOT EXISTS idx_calendar_events_start_at
          ON calendar_events(start_at)
      `,
    ],
  },
  {
    // v12 (task 5.6, design D6): the tasks table — the local task manager
    // (tasks spec "Task management"). One ROW PER TASK INSTANCE: completing
    // a recurring task stamps the instance's completed_at (the row is KEPT
    // as the completed-history record), appends to the row's
    // completed_history_json trail, and INSERTS a NEW open row for the next
    // occurrence (due date computed FROM THE PREVIOUS DUE DATE, never the
    // completion time — see tasks/service.ts completeTask). Rows of one
    // recurring series share a generated series_id (NULL for tasks never
    // given a rule) so occurrences group; history is a JSON array of
    // {completedAt, dueAt} entries (unix seconds) on the row, oldest first,
    // capped at 50 by the service (the open instance carries the whole
    // series trail — each expansion copies it forward).
    //
    // source_* are the optional provenance back-links (manual tasks have
    // none): source_thread_id deep-links into the thread (design D6);
    // source_message_id carries the finer "link back to the source message"
    // the tasks spec requires for email conversions and AI extractions —
    // D6's column sketch omits it, but the seam contract
    // (tasks/create.ts TaskSuggestionSeed, task 4.8) hands the message id
    // over, and storing it is what makes the reading-pane jump possible.
    // origin distinguishes manual | email | ai (CHECK-enforced); tasks are
    // deliberately account-independent rows — source_account_id is
    // provenance only (NULL-able, no FK) so the list spans accounts and
    // outlives account deletion like the rest of the task data.
    version: 12,
    description: "Tasks schema: tasks instance table with recurrence, " +
      "series grouping and completed history",
    statements: [
      `
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          notes TEXT,
          -- Optional due date/time, unix epoch seconds (NULL = no due date)
          due_at INTEGER,
          -- Recurrence rule JSON (tasks/recurrence.ts RecurrenceRule),
          -- NULL for one-off tasks
          recurrence_json TEXT,
          -- Completion marker; the row is KEPT after completion as the
          -- completed-history instance (NULL = open)
          completed_at INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          -- JSON array of {completedAt, dueAt} (unix seconds), oldest
          -- first, service-capped at 50; series rows copy it forward on
          -- expansion so the open instance carries the whole trail
          completed_history_json TEXT NOT NULL DEFAULT '[]',
          -- Generated uuid grouping one recurring series' rows; NULL for
          -- tasks never given a recurrence rule
          series_id TEXT,
          -- Provenance back-links (manual tasks: all NULL). account_id is
          -- attribution, not ownership — no FK, the task survives account
          -- removal.
          source_account_id TEXT,
          source_message_id TEXT,
          source_thread_id TEXT,
          origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN (
            'manual', 'email', 'ai'
          ))
        )
      `,
      // The open-task list scans open rows ordered by due date; partial
      // index keeps completed history rows out of it.
      `
        CREATE INDEX IF NOT EXISTS idx_tasks_open_due
          ON tasks(due_at) WHERE completed_at IS NULL
      `,
      // Series grouping (future "delete series" / detail views).
      `
        CREATE INDEX IF NOT EXISTS idx_tasks_series ON tasks(series_id)
      `,
    ],
  },
  {
    // v13 (task 1.3, design D7): accent-insensitive FTS. The v1 index uses
    // the plain trigram tokenizer, which keeps diacritics — the index is
    // populated by the triggers (raw column copies), so no query-side
    // transform can make "be don dep" match "Bé Dọn Dẹp". SQLite ≥3.45's
    // trigram `remove_diacritics` option strips the same marks on BOTH the
    // index and the query side; changing a tokenizer requires recreating
    // the virtual table, and the content='messages' external-content table
    // is rebuilt from the surviving rows with the built-in 'rebuild'
    // command — the messages rows themselves are untouched and the
    // insert/update/delete triggers below are re-created verbatim (they
    // are independent of the table's tokenizer). Idempotent under the
    // versioned runner; existing installs reindex once, fresh installs
    // create v1 then immediately v13.
    version: 13,
    description: "Rebuild messages_fts with diacritic-stripping trigram",
    statements: [
      // Drop first: an FTS5 tokenizer is fixed at CREATE time. The triggers
      // live on `messages`, not on the FTS table, and simply stop matching
      // rows for the (transaction-scoped) moment the table is absent.
      "DROP TABLE IF EXISTS messages_fts",
      `
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          subject,
          from_name,
          from_address,
          to_json,
          body_text,
          snippet,
          content='messages',
          content_rowid='rowid',
          tokenize='trigram remove_diacritics 1'
        )
      `,
      `
        CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts (
            rowid, subject, from_name, from_address, to_json, body_text, snippet
          )
          VALUES (
            new.rowid, new.subject, new.from_name, new.from_address,
            new.to_json, new.body_text, new.snippet
          );
        END
      `,
      `
        CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts (
            messages_fts, rowid, subject, from_name, from_address, to_json,
            body_text, snippet
          )
          VALUES (
            'delete', old.rowid, old.subject, old.from_name, old.from_address,
            old.to_json, old.body_text, old.snippet
          );
        END
      `,
      `
        CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts (
            messages_fts, rowid, subject, from_name, from_address, to_json,
            body_text, snippet
          )
          VALUES (
            'delete', old.rowid, old.subject, old.from_name, old.from_address,
            old.to_json, old.body_text, old.snippet
          );
          INSERT INTO messages_fts (
            rowid, subject, from_name, from_address, to_json, body_text, snippet
          )
          VALUES (
            new.rowid, new.subject, new.from_name, new.from_address,
            new.to_json, new.body_text, new.snippet
          );
        END
      `,
      // One-statement full reindex from the content table (the same upkeep
      // FTS5's own tools use); a no-op on an empty messages table.
      `INSERT INTO messages_fts(messages_fts) VALUES('rebuild')`,
    ],
  },
  {
    // v14 (parity-round-2 task 2.2, design D8): per-request AI usage
    // accounting. One row per COMPLETED `ai_chat` call, written TS-side by
    // services/ai/usage.ts (Emailer's SQLite is frontend-owned via
    // tauri-plugin-sql — the Rust command stays DB-free). Tokens are the
    // provider-reported numbers when the provider includes them in the
    // response, else the chars/4 estimate computed at the call site —
    // `estimated` (0/1) records which, so the settings summary can label
    // estimated totals "approx." rather than pass guesses off as exact.
    // surface is the AiSurface id (open TEXT like ai_cache.kind — later
    // surfaces, e.g. quick replies, land without a migration); model is
    // the model that served the request (nullable — a plain id, not a
    // secret). No account scoping: usage is a device-level accounting
    // trail, deliberately free of mailbox content.
    version: 14,
    description:
      "AI usage accounting: ai_usage per-request token table",
    statements: [
      `
        CREATE TABLE IF NOT EXISTS ai_usage (
          id TEXT PRIMARY KEY,
          surface TEXT NOT NULL,
          model TEXT,
          prompt_tokens INTEGER,
          completion_tokens INTEGER,
          total_tokens INTEGER,
          -- 0 = provider-reported, 1 = chars/4 estimate
          estimated INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `,
      // The settings summary groups by surface; created_at has no reader
      // index yet (no time-window UI ships with it).
      `CREATE INDEX IF NOT EXISTS idx_ai_usage_surface ON ai_usage(surface)`,
    ],
  },
  {
    version: 15,
    description:
      "Widen accounts.type with 'microsoft' (Microsoft 365 Graph accounts): table rebuild — SQLite cannot alter a CHECK constraint",
    foreignKeysOff: true,
    statements: [
      `
        CREATE TABLE accounts_new (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK (type IN ('gmail', 'imap', 'microsoft')),
          email TEXT NOT NULL UNIQUE,
          display_name TEXT,
          imap_host TEXT,
          imap_port INTEGER,
          imap_security TEXT CHECK (imap_security IN ('tls', 'starttls', 'none')),
          smtp_host TEXT,
          smtp_port INTEGER,
          smtp_security TEXT CHECK (smtp_security IN ('tls', 'starttls', 'none')),
          credentials_json TEXT,
          oauth_scope TEXT,
          oauth_client_id TEXT,
          -- Delta-sync cursors: the gmail history id, or (microsoft) the
          -- JSON map {folderPath -> Graph deltaLink}.
          gmail_history_id TEXT,
          labels_synced_at INTEGER,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'auth-error')),
          last_sync_at INTEGER,
          last_full_sync_at INTEGER,
          is_active INTEGER NOT NULL DEFAULT 1,
          is_pinned INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `,
      // Explicit column list (never SELECT *): a restored-from-backup
      // schema with extra/missing columns copies exactly what lives here.
      `
        INSERT INTO accounts_new (
          id, type, email, display_name,
          imap_host, imap_port, imap_security,
          smtp_host, smtp_port, smtp_security,
          credentials_json, oauth_scope, oauth_client_id,
          gmail_history_id, labels_synced_at, status,
          last_sync_at, last_full_sync_at, is_active, is_pinned, created_at
        )
        SELECT
          id, type, email, display_name,
          imap_host, imap_port, imap_security,
          smtp_host, smtp_port, smtp_security,
          credentials_json, oauth_scope, oauth_client_id,
          gmail_history_id, labels_synced_at, status,
          last_sync_at, last_full_sync_at, is_active, is_pinned, created_at
        FROM accounts
      `,
      // Runs with foreign_keys OFF (the runner sets the pragma before
      // BEGIN — see foreignKeysOff above): dropping the FK parent with
      // enforcement on would cascade-delete every child table's rows.
      `DROP TABLE accounts`,
      `ALTER TABLE accounts_new RENAME TO accounts`,
    ],
  },
  {
    // v16 (parity-round-2 task 3.6): widen calendar_sources.provider with
    // 'microsoft' (Microsoft Graph calendars as a third source type beside
    // google and caldav). SQLite cannot alter a CHECK constraint, so the
    // table is rebuilt (the v15 accounts precedent) with every column and
    // constraint reproduced verbatim except the widened provider list.
    //
    // Runs with foreign_keys OFF (the runner sets the pragma before BEGIN):
    // calendar_events.source_id REFERENCES calendar_sources(id) ON DELETE
    // CASCADE, so dropping the FK parent with enforcement on would
    // cascade-delete every cached event row. calendar_events' FK names the
    // parent by table name, which matches again after the rename, so the
    // child side needs no rewrite.
    version: 16,
    description:
      "Widen calendar_sources.provider with 'microsoft' (Microsoft Graph " +
      "calendar sources): table rebuild — SQLite cannot alter a CHECK " +
      "constraint",
    foreignKeysOff: true,
    statements: [
      `
        CREATE TABLE calendar_sources_new (
          id TEXT PRIMARY KEY,
          -- The mail account this source was connected from (google,
          -- microsoft); NULL for providers without a linked mail account
          -- (caldav)
          account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
          provider TEXT NOT NULL CHECK (provider IN ('google', 'caldav', 'microsoft')),
          name TEXT NOT NULL,
          -- Provider-specific connection config; google/microsoft = AES-GCM
          -- sealed OAuth token envelope (provider-calendar-scoped refresh
          -- token — see calendar/connect.ts and calendar/connect-microsoft.ts
          -- for why the mail account's envelope cannot be reused), caldav =
          -- url/username/app-password-sealed. Plaintext must never be
          -- persisted.
          config_json TEXT NOT NULL,
          -- Per-calendar incremental sync cursors (plain JSON, not a
          -- secret — kept out of the sealed config envelope); microsoft
          -- stores the calendarView deltaLink in nextSyncToken.
          sync_state_json TEXT,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `,
      // Explicit column list (never SELECT *), the v15 precedent.
      `
        INSERT INTO calendar_sources_new (
          id, account_id, provider, name, config_json, sync_state_json,
          created_at
        )
        SELECT
          id, account_id, provider, name, config_json, sync_state_json,
          created_at
        FROM calendar_sources
      `,
      `DROP TABLE calendar_sources`,
      `ALTER TABLE calendar_sources_new RENAME TO calendar_sources`,
      // Recreated explicitly: the v11 index was dropped together with the
      // original table (DROP TABLE removes its indexes), so the source-
      // account index must be rebuilt against the new table.
      `
        CREATE INDEX IF NOT EXISTS idx_calendar_sources_account
          ON calendar_sources(account_id)
      `,
    ],
  },
  {
    // v17 (parity-round-2 task 4.2, design D4): the CardDAV address-book
    // stores. carddav_books is one connected address book (server URL +
    // username + the SEALED app-password envelope — the accounts/
    // calendar-sources credentials pattern; the plaintext password is
    // never persisted), holding the sync cursors (sync token + ctag) as
    // plain non-secret columns. account_id ties the book to the mail
    // account whose address book it syncs into — contacts rows are
    // account-scoped (UNIQUE(account_id, email)) and compose autocomplete
    // is per-account, so a book must live under one account (deleting the
    // account cascades the book and its synced contacts).
    //
    // contacts gains six additive columns: `source` ('local' | 'carddav',
    // DEFAULT 'local' so existing rows are untouched), `uid` (the vCard
    // UID — the per-book upsert identity), `href` + `etag` (the resource
    // location and the If-Match precondition for write-back),
    // `carddav_raw` (the RAW vCard as the server holds it — the row's
    // unknown-property preservation: edits re-serialize from it, so
    // PHOTO/X- extensions/extra TEL lines the UI does not show survive a
    // write-back), and `book_id` (nullable FK with ON DELETE CASCADE —
    // disconnecting a book removes its synced contacts; NULL for local
    // rows). Purely additive: no rebuild, existing local rows default.
    version: 17,
    description:
      "CardDAV schema: carddav_books connections and source/uid/href/" +
      "etag/raw/book columns on contacts",
    statements: [
      `
        CREATE TABLE IF NOT EXISTS carddav_books (
          id TEXT PRIMARY KEY,
          -- The mail account this book syncs into (contacts rows are
          -- account-scoped); deleting the account cascades the book.
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          -- The server root the user entered (all commands take it) and
          -- the discovered address-book collection URL (the sync target).
          base_url TEXT NOT NULL,
          book_url TEXT NOT NULL,
          username TEXT NOT NULL,
          -- AES-GCM sealed envelope holding the app password
          -- (crypto/credentials encryptCredentials output). Plaintext
          -- must never be persisted.
          credentials_json TEXT NOT NULL,
          name TEXT NOT NULL,
          -- Incremental sync cursors (not secrets — plain columns, like
          -- calendar_sources.sync_state_json).
          sync_token TEXT,
          ctag TEXT,
          -- The server (or a failed write) reported the book read-only.
          read_only INTEGER NOT NULL DEFAULT 0,
          last_synced_at INTEGER,
          last_error TEXT,
          -- Cards skipped by the last pass (parse failures / over the
          -- 2 MiB cap) — the settings status line warns when nonzero.
          last_skipped INTEGER,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `,
      "ALTER TABLE contacts ADD COLUMN source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'carddav'))",
      "ALTER TABLE contacts ADD COLUMN uid TEXT",
      "ALTER TABLE contacts ADD COLUMN href TEXT",
      "ALTER TABLE contacts ADD COLUMN etag TEXT",
      "ALTER TABLE contacts ADD COLUMN carddav_raw TEXT",
      // Nullable FK with NULL default: legal under ALTER TABLE ADD COLUMN
      // with foreign_keys ON. Disconnect cascades the synced contacts.
      "ALTER TABLE contacts ADD COLUMN book_id TEXT REFERENCES carddav_books(id) ON DELETE CASCADE",
      `
        CREATE INDEX IF NOT EXISTS idx_contacts_book
          ON contacts(book_id) WHERE book_id IS NOT NULL
      `,
      `
        CREATE INDEX IF NOT EXISTS idx_contacts_book_uid
          ON contacts(book_id, uid) WHERE book_id IS NOT NULL AND uid IS NOT NULL
      `,
    ],
  },
  {
    // v18 (parity-round-2 tasks 4.4/4.5, design D10): account profiles —
    // named local groups ("Work", "Personal") carrying the color the
    // thread-list markers render. account_profiles is one profile row
    // (id/name/color, the v1 conventions). Profiles are LOCAL ONLY: they
    // map to no provider object, so every CRUD path below is a plain local
    // write and servers are untouched by construction.
    //
    // accounts gains two additive columns: `profile_id` (nullable FK with
    // ON DELETE SET NULL — deleting a profile keeps its accounts working,
    // their references cleared so they fall back to their individual or
    // generated colors, exactly the accounts spec's delete-keeps-accounts
    // scenario) and `color_override` (a per-account color that WINS over
    // the profile color — the accounts spec's per-account-override
    // scenario; NULL = inherit). Purely additive: no rebuild, existing
    // rows default to unassigned/inherit.
    version: 18,
    description:
      "Account profiles: account_profiles table and profile_id/" +
      "color_override columns on accounts",
    statements: [
      `
        CREATE TABLE IF NOT EXISTS account_profiles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          -- Profile color as a CSS hex string ("#8b5cf6"), rendered as-is
          -- by the editor swatches and the thread-list markers (the
          -- label.color convention: user content, not component styling).
          color TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        )
      `,
      // Nullable FK with NULL default: legal under ALTER TABLE ADD COLUMN
      // with foreign_keys ON (the v17 contacts.book_id precedent).
      "ALTER TABLE accounts ADD COLUMN profile_id TEXT REFERENCES account_profiles(id) ON DELETE SET NULL",
      "ALTER TABLE accounts ADD COLUMN color_override TEXT",
    ],
  },
  {
    // v19 (composer batch C1, fix 1): durable attachment bytes for composer
    // drafts. local_drafts carries attachment METADATA only (attachments_json
    // descriptors), while the raw bytes used to live solely in the session
    // registry (attachment-bytes.ts) — restarting the app silently dropped
    // every resumed draft's files. One row per attachment, keyed by the
    // draft's draft_key (the same key autosave and the send/discard
    // deletions address the local_drafts row by), bytes stored base64-encoded
    // like the send payload carries them (the Velo reference draft path
    // embeds base64 the same way). The add-time caps in
    // attachment-input.ts bound a draft's attachment total to 25 MB, so the
    // worst-case stored payload is ~33 MB of base64 — well within SQLite.
    // account_id ties the rows to the account so deleting the account
    // cascades them away exactly like its local_drafts rows; the sync/
    // restore API in services/composer/draft-attachments.ts owns the rest
    // of the lifecycle (upsert on add, delete on remove/discard/send).
    version: 19,
    description:
      "Draft attachments: draft_attachments base64 byte store keyed by " +
      "draft key",
    statements: [
      `
        CREATE TABLE IF NOT EXISTS draft_attachments (
          draft_key TEXT NOT NULL,
          account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          id TEXT NOT NULL,
          name TEXT NOT NULL,
          mime_type TEXT,
          size INTEGER NOT NULL,
          -- Base64-encoded file bytes (~1.33x the raw size; the raw count
          -- is what the size column carries).
          content_base64 TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (draft_key, id)
        )
      `,
      `
        CREATE INDEX IF NOT EXISTS idx_draft_attachments_account
          ON draft_attachments(account_id)
      `,
    ],
  },
]
