import Database from "@tauri-apps/plugin-sql"

import { MIGRATIONS, MIGRATIONS_TABLE_SQL, type Migration } from "./migrations"

const DB_URL = "sqlite:emailer.db"

let db: Database | null = null
let initPromise: Promise<void> | null = null

/**
 * Return the shared database handle.
 *
 * Throws if initDatabase() has not completed — app startup runs it before
 * any feature init (src/services/bootstrap.ts), so reaching this error
 * means a feature was initialized out of order.
 */
export function getDb(): Database {
  if (!db) {
    throw new Error(
      "Database not initialized: getDb() called before initDatabase() completed. " +
        "initDatabase() runs at app startup via src/services/bootstrap.ts and " +
        "must resolve before any feature initializes."
    )
  }
  return db
}

/**
 * Open the database and apply pending migrations exactly once.
 *
 * Idempotent: concurrent or repeated calls share the same in-flight run,
 * and already-applied versions recorded in _migrations are never re-run.
 * Safe to call again after a failure — the failed attempt is discarded so
 * initialization can be retried.
 */
export function initDatabase(): Promise<void> {
  initPromise ??= doInit().catch((error) => {
    initPromise = null
    db = null
    throw error
  })
  return initPromise
}

async function doInit(): Promise<void> {
  const database = await Database.load(DB_URL)
  // Foreign-key enforcement is per-connection; sqlx enables it by default,
  // but setting it here makes the guarantee explicit on the connection we
  // actually use, independent of pool behaviour.
  await database.execute("PRAGMA foreign_keys = ON")
  db = database
  await runMigrations(database)
}

/**
 * Close the shared database handle and forget it (task 1.7): the
 * "delete all local data" flow closes the plugin's pool BEFORE the Rust
 * wipe deletes the file — an open SQLite file cannot be unlinked on
 * Windows — and the app relaunches into first-run right after. A
 * subsequent getDb() throws until initDatabase() runs again (the
 * delete-all flow's failure path re-inits explicitly).
 */
export async function closeDatabase(): Promise<void> {
  if (!db) return
  const database = db
  db = null
  initPromise = null
  await database.close()
}

/**
 * Generic versioned runner: applies MIGRATIONS entries in order, skipping
 * versions already recorded in _migrations. Each migration runs inside one
 * transaction together with its bookkeeping row so it is all-or-nothing.
 * New schema versions are appended to the array — nothing else changes.
 */
async function runMigrations(database: Database): Promise<void> {
  await database.execute(MIGRATIONS_TABLE_SQL)

  const applied = await database.select<{ version: number }[]>(
    "SELECT version FROM _migrations"
  )
  const appliedVersions = new Set(applied.map((row) => row.version))

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue
    await applyMigration(database, migration)
  }
}

async function applyMigration(
  database: Database,
  migration: Migration
): Promise<void> {
  // FK-off window (see Migration.foreignKeysOff): the pragma cannot run
  // inside a transaction, so it is toggled on the connection around the
  // migration's own BEGIN/COMMIT — and restored best-effort afterwards.
  const foreignKeysOff = migration.foreignKeysOff === true
  if (foreignKeysOff) {
    await database.execute("PRAGMA foreign_keys = OFF")
  }
  await database.execute("BEGIN")
  try {
    for (const statement of migration.statements) {
      await database.execute(statement)
    }
    await database.execute(
      "INSERT INTO _migrations (version, description) VALUES ($1, $2)",
      [migration.version, migration.description]
    )
    await database.execute("COMMIT")
  } catch (error) {
    // Guarded rollback: the transaction may already be gone if the failure
    // was fatal to the connection
    await database.execute("ROLLBACK").catch(() => {})
    throw error
  } finally {
    if (foreignKeysOff) {
      await database.execute("PRAGMA foreign_keys = ON").catch(() => {
        // Restoring is best-effort; the next init retries it anyway.
      })
    }
  }
}
