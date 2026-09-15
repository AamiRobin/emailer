/**
 * Ambient types for the built-in node:sqlite module.
 *
 * The pinned @types/node@20 predates node:sqlite typings (they arrived in
 * @types/node 22.5+), so this declaration lets the vitest-only test
 * executor import it under strict TypeScript. Production code never
 * imports node:sqlite — only src/services/db/__tests__/test-executor.ts
 * does. Remove this file when @types/node is upgraded past 22.5.
 */
declare module "node:sqlite" {
  export interface StatementSync {
    run(...anonymousParameters: unknown[]): {
      changes: number | bigint
      lastInsertRowid: number | bigint
    }
    all(...anonymousParameters: unknown[]): Record<string, unknown>[]
  }

  export class DatabaseSync {
    constructor(path: string)
    exec(sql: string): void
    prepare(sql: string): StatementSync
    close(): void
  }
}
