import { DatabaseSync } from "node:sqlite"

import type { SqlExecutor } from "../executor"
import { MIGRATIONS, MIGRATIONS_TABLE_SQL } from "../migrations"

/**
 * Vitest-only SqlExecutor over Node's built-in SQLite (node:sqlite). Runs
 * the real v1 schema and FTS5 triggers in a throwaway in-memory database
 * so query modules are exercised against the exact SQL they ship.
 *
 * tauri-plugin-sql uses `$1, $2, …` placeholders; node:sqlite uses `?`.
 * `$N` is rewritten to plain `?` positionally, so query code must keep
 * placeholder numbers ascending by first occurrence in the SQL text and
 * bind each parameter exactly once (see executor.ts for the convention).
 * Production code must never import this module.
 */
export interface TestExecutor extends SqlExecutor {
  close(): void
  /** Apply one migration's statements verbatim (tests only — the v13
   * upgrade-path suite seeds pre-migration rows on a ≤v12 database, then
   * drives the migration by hand). */
  applyMigration(version: number): void
}

export function createTestExecutor(options?: {
  /** Stop after this migration version (default: apply them all). */
  upToVersion?: number
}): TestExecutor {
  const db = new DatabaseSync(":memory:")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec(MIGRATIONS_TABLE_SQL)
  for (const migration of MIGRATIONS) {
    if (
      options?.upToVersion !== undefined &&
      migration.version > options.upToVersion
    ) {
      continue
    }
    runMigrationStatements(migration)
  }

  /** FK-off window shared with the production runner (connection.ts): a
   * migration that drops a referenced table must not cascade children. */
  function runMigrationStatements(migration: (typeof MIGRATIONS)[number]): void {
    if (migration.foreignKeysOff === true) {
      db.exec("PRAGMA foreign_keys = OFF")
    }
    try {
      for (const statement of migration.statements) {
        db.exec(statement)
      }
    } finally {
      if (migration.foreignKeysOff === true) {
        db.exec("PRAGMA foreign_keys = ON")
      }
    }
  }

  const translate = (sql: string) => sql.replace(/\$(\d+)/g, "?")

  return {
    async select<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      return db.prepare(translate(sql)).all(...params) as T[]
    },
    async execute(sql: string, params: unknown[] = []) {
      const info = db.prepare(translate(sql)).run(...params)
      return { rowsAffected: Number(info.changes) }
    },
    applyMigration(version: number): void {
      const migration = MIGRATIONS.find((entry) => entry.version === version)
      if (!migration) throw new Error(`no such migration: v${version}`)
      runMigrationStatements(migration)
    },
    close() {
      db.close()
    },
  }
}
