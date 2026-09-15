import sqlite3InitModule from "@sqlite.org/sqlite-wasm"

import { MIGRATIONS, MIGRATIONS_TABLE_SQL } from "../services/db/migrations"
import { installMockHarness } from "./index"
import { seedIfEmpty } from "./seed"

/**
 * Mock @tauri-apps/plugin-sql (mock dev mode only): Database.load opens
 * an in-memory SQLite via the official wasm build, applies the real
 * migrations (statement-by-statement inside BEGIN/COMMIT, mirroring
 * connection.ts so the app's own migration runner finds them applied),
 * seeds fixture mail once, and returns a handle exposing the same two
 * methods the app uses: select(sql, params) and execute(sql, params).
 *
 * `$N` placeholders are rewritten to positional `?` exactly like
 * test-executor.ts — so query code must keep the executor.ts convention:
 * each placeholder bound once, numbers ascending by first occurrence.
 */

type Sqlite3Static = Awaited<ReturnType<typeof sqlite3InitModule>>
type WasmDb = InstanceType<Sqlite3Static["oo1"]["DB"]>

let sqlitePromise: Promise<Sqlite3Static> | null = null
let loadPromise: Promise<Database> | null = null

function getSqlite(): Promise<Sqlite3Static> {
  sqlitePromise ??= sqlite3InitModule()
  return sqlitePromise
}

/** Same rewrite the node:sqlite test executor uses. */
function translatePlaceholders(sql: string): string {
  return sql.replace(/\$(\d+)/g, "?")
}

async function openDatabase(): Promise<Database> {
  const sqlite3 = await getSqlite()
  const db = new sqlite3.oo1.DB(":memory:", "c")
  const database = new Database(db)
  await database.execute("PRAGMA foreign_keys = ON")
  await applyMigrations(database)
  // HMR / StrictMode guard: only seed a virgin database.
  const accounts = await database.select<{ count: number }>(
    "SELECT COUNT(*) AS count FROM accounts"
  )
  if ((accounts[0]?.count ?? 0) === 0) {
    await seedIfEmpty(database)
  }
  return database
}

/** Same versioned runner shape as connection.ts: one transaction per
 * migration, bookkeeping row included, all-or-nothing. */
async function applyMigrations(database: Database): Promise<void> {
  await database.execute(MIGRATIONS_TABLE_SQL)
  const applied = await database.select<{ version: number }>(
    "SELECT version FROM _migrations"
  )
  const appliedVersions = new Set(applied.map((row) => row.version))
  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue
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
      await database.execute("ROLLBACK").catch(() => {})
      throw error
    }
  }
}

export class Database {
  private readonly db: WasmDb

  constructor(db: WasmDb) {
    this.db = db
  }

  static async load(_path: string): Promise<Database> {
    void _path
    installMockHarness()
    loadPromise ??= openDatabase().catch((error: unknown) => {
      loadPromise = null
      throw error
    })
    return loadPromise
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const translated = translatePlaceholders(sql)
    // oo1 throws when an empty bind array is passed to a statement with no
    // bindable parameters, so the no-params form must stay argless.
    return params.length > 0
      ? (this.db.selectObjects(translated, params as never) as T[])
      : (this.db.selectObjects(translated) as T[])
  }

  async execute(
    sql: string,
    params: unknown[] = []
  ): Promise<{ rowsAffected: number }> {
    const statement = this.db.prepare(translatePlaceholders(sql))
    try {
      if (params.length > 0) statement.bind(params as never)
      statement.step()
    } finally {
      statement.finalize()
    }
    return { rowsAffected: this.db.changes() }
  }
}

export default Database
