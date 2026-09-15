import type Database from "@tauri-apps/plugin-sql"

import { getDb } from "./connection"

/**
 * Minimal database surface the query layer (messages.ts, threads.ts,
 * labels.ts, search.ts) is written against. Keeping queries behind this
 * interface lets tests run the exact same SQL against an in-memory SQLite
 * (see src/services/db/__tests__/test-executor.ts) — tauri-plugin-sql
 * cannot execute under vitest, but the SQL, the v1 schema and the FTS5
 * triggers are identical in both environments.
 *
 * Parameter convention: SQLite-style positional placeholders `$1, $2, …`
 * bound by a flat params array, matching the tauri-plugin-sql API. Both
 * drivers bind by order of occurrence in the SQL text, NOT by the number
 * in the token — so placeholder numbers must ascend by first occurrence
 * (`SET a = $1 WHERE id = $2`, never `SET a = $2 WHERE id = $1`). The
 * production executor passes the tokens through; the test executor
 * rewrites them to `?` for node:sqlite.
 */
export interface SqlExecutor {
  select<T>(sql: string, params?: unknown[]): Promise<T[]>
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected: number }>
}

/** Adapt a loaded tauri-plugin-sql Database handle to SqlExecutor. */
export function createTauriExecutor(database: Database): SqlExecutor {
  return {
    async select<T>(sql: string, params?: unknown[]): Promise<T[]> {
      return database.select<T[]>(sql, params)
    },
    async execute(sql: string, params?: unknown[]) {
      const result = await database.execute(sql, params)
      return { rowsAffected: result.rowsAffected }
    },
  }
}

let sharedExecutor: SqlExecutor | null = null

/**
 * Executor bound to the shared app database. getDb() throws when
 * initDatabase() has not completed, so this is only usable after startup.
 */
export function getExecutor(): SqlExecutor {
  sharedExecutor ??= createTauriExecutor(getDb())
  return sharedExecutor
}

/** `$1, $2, … $count` — for building IN lists. */
export function placeholders(count: number, firstIndex = 1): string {
  return Array.from(
    { length: count },
    (_, index) => `$${index + firstIndex}`
  ).join(", ")
}
