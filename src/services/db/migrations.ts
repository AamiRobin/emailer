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
]
