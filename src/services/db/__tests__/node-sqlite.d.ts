/**
 * Ambient types for the built-in node:sqlite module.
 *
 * The pinned @types/node@20 predates node:sqlite typings (they arrived in
 * @types/node 22.5+), so this declaration lets the vitest-only test
 * executor import it under strict TypeScript. Production code never
 * imports node:sqlite — only the suites under src/services/db/__tests__/
 * do. Remove this file when @types/node is upgraded past 22.5.
 */
declare module "node:sqlite" {
  export interface StatementSync {
    run(...anonymousParameters: unknown[]): {
      changes: number | bigint
      lastInsertRowid: number | bigint
    }
    get(...anonymousParameters: unknown[]): Record<string, unknown> | undefined
    all(...anonymousParameters: unknown[]): Record<string, unknown>[]
  }

  export interface DatabaseSyncOptions {
    open?: boolean
    readOnly?: boolean
    enableForeignKeyConstraints?: boolean
    allowExtension?: boolean
  }

  export class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions)
    exec(sql: string): void
    prepare(sql: string): StatementSync
    close(): void
  }
}
