/**
 * Dev-only verification for the migration set — not part of the app bundle.
 *
 * Applies every migration from src/services/db/migrations.ts to a throwaway
 * SQLite file using bun's built-in SQLite driver (same embedded SQLite
 * engine family the Tauri plugin uses), then prints the resulting tables
 * and runs an FTS5 round-trip so schema correctness can be verified without
 * launching the Tauri shell.
 *
 * Usage: bun run scripts/verify-migrations.ts
 */
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { MIGRATIONS, MIGRATIONS_TABLE_SQL } from "../src/services/db/migrations"

const dir = mkdtempSync(join(tmpdir(), "emailer-migrations-"))
const db = new Database(join(dir, "verify.db"))
db.exec("PRAGMA foreign_keys = ON")
// Same bookkeeping DDL the app runner applies before migrations
db.exec(MIGRATIONS_TABLE_SQL)

function cleanup() {
  db.close()
  rmSync(dir, { recursive: true, force: true })
}

for (const migration of MIGRATIONS) {
  db.exec("BEGIN")
  try {
    for (const statement of migration.statements) {
      db.exec(statement)
    }
    db.run("INSERT INTO _migrations (version, description) VALUES (?, ?)", [
      migration.version,
      migration.description,
    ])
    db.exec("COMMIT")
    console.log(`applied v${migration.version}: ${migration.description}`)
  } catch (error) {
    db.exec("ROLLBACK")
    console.error(`migration v${migration.version} failed:`, error)
    cleanup()
    process.exit(1)
  }
}

const tables = db
  .query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  )
  .all() as { name: string }[]

console.log("\nTables after migrations:")
for (const table of tables) {
  console.log(`  ${table.name}`)
}

// v2 check (task 6.4): the threads.participants display cache column must
// exist. The value round-trip runs below, after the FTS section seeds a
// thread row.
const threadColumns = db.query("PRAGMA table_info(threads)").all() as {
  name: string
}[]
console.log(`\nthreads columns: ${threadColumns.map((c) => c.name).join(", ")}`)
if (!threadColumns.some((column) => column.name === "participants")) {
  console.error("migration v2 did not add the threads.participants column")
  cleanup()
  process.exit(1)
}

// FTS5 round-trip: seed one message and confirm the external-content index
// (kept in sync by the v1 triggers) is searchable.
db.run(
  "INSERT INTO accounts (id, type, email) VALUES ('acc-1', 'gmail', 'test@example.com')"
)
db.run("INSERT INTO threads (id, account_id) VALUES ('th-1', 'acc-1')")
db.run(
  `INSERT INTO messages (id, thread_id, account_id, subject, body_text, date)
   VALUES ('msg-1', 'th-1', 'acc-1', 'Quarterly report', 'Hello FTS world', 1700000000)`
)
const hits = db
  .query("SELECT subject FROM messages_fts WHERE messages_fts MATCH 'hello'")
  .all() as { subject: string }[]

console.log(`\nFTS5 MATCH 'hello' hits: ${hits.length}`)
if (hits.length === 0) {
  console.error("FTS5 index did not return the seeded message")
  cleanup()
  process.exit(1)
}

// v2 round-trip: the participants cache column accepts and returns JSON.
db.run("UPDATE threads SET participants = ? WHERE id = ?", [
  '[{"name":"Ada","email":"ada@example.com"}]',
  "th-1",
])
const participants = db
  .query("SELECT participants FROM threads WHERE id = 'th-1'")
  .all() as { participants: string | null }[]
console.log(`threads.participants round-trip: ${participants[0]?.participants}`)
if (!participants[0]?.participants) {
  console.error("threads.participants round-trip failed")
  cleanup()
  process.exit(1)
}

console.log("\nAll migrations applied cleanly; FTS5 is usable.")
cleanup()
