/// <reference types="node" />
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DatabaseSync } from "node:sqlite"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import {
  SNAPSHOT_STRIP_STATEMENTS,
  stripSnapshotDatabase,
} from "../backup-snapshot"
import { createTestExecutor, type TestExecutor } from "./test-executor"
import { createThread, createMessage, at } from "./fixtures"

/**
 * The D4 backup snapshot builder (parity-round-3 task 1.2, spike-proven
 * semantics): VACUUM INTO copies the live database, and the strip
 * statements null/empty the sealed-envelope columns in the SNAPSHOT only
 * — the live database keeps its credentials, the snapshot keeps mail.
 *
 * The plugin-side parts of createStrippedSnapshot (Database.load of the
 * snapshot path, absolute-path handling) cannot run under vitest — this
 * suite runs the exact shipped strip SQL against a node:sqlite snapshot,
 * the same split the migration suites use.
 */

/** node:sqlite handle behind the same SqlExecutor surface the production
 * caller builds with createTauriExecutor. */
function sqliteExecutor(db: DatabaseSync) {
  return {
    async select<T>(sql: string): Promise<T[]> {
      return db.prepare(sql).all() as T[]
    },
    async execute(sql: string) {
      const info = db.prepare(sql).run()
      return { rowsAffected: Number(info.changes) }
    },
  }
}

const SEALED_ACCOUNT = JSON.stringify({ v: 1, ct: "ciphertext-account" })
const SEALED_CALENDAR = JSON.stringify({ v: 1, ct: "ciphertext-calendar" })
const SEALED_CARD = JSON.stringify({ v: 1, ct: "ciphertext-carddav" })

describe("backup snapshot strip (task 1.2, design D4)", () => {
  let executor: TestExecutor
  let dir: string
  let snapshotPath: string
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    dir = mkdtempSync(join(tmpdir(), "emailer-backup-snapshot-"))
    snapshotPath = join(dir, "snapshot.db")

    // A live database with sealed envelopes on all three credential
    // carriers plus one searchable accented message.
    accountId = await createAccountWithSecrets(executor)
    const threadId = await createThread(executor, accountId, {
      subject: "Bé Dọn Dẹp",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: at(10),
      subject: "Bé Dọn Dẹp",
      fromAddress: "hoa@vn.example",
      bodyText: "Lịch họp tuần sau đã đổi.",
      snippet: "Lịch họp tuần sau đã đổi.",
    })

    // Step 1 of the export flow, through the shared executor: one
    // autocommit statement (VACUUM INTO refuses to run inside a
    // transaction — see the design.md spike notes).
    await executor.execute(`VACUUM INTO '${snapshotPath}'`)
  })

  afterEach(() => {
    executor.close()
    rmSync(dir, { recursive: true, force: true })
  })

  async function createAccountWithSecrets(
    executor: TestExecutor
  ): Promise<string> {
    const accountId = `acc-sealed-${Math.random().toString(36).slice(2)}`
    await executor.execute(
      `INSERT INTO accounts (id, type, email, credentials_json, oauth_scope)
       VALUES ($1, 'gmail', $2, $3, 'scope1 scope2')`,
      [accountId, `${accountId}@example.com`, SEALED_ACCOUNT]
    )
    await executor.execute(
      `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
       VALUES ('src-sealed', $1, 'google', 'cal', $2)`,
      [accountId, SEALED_CALENDAR]
    )
    await executor.execute(
      `INSERT INTO carddav_books (id, account_id, base_url, book_url, username, credentials_json, name)
       VALUES ('book-sealed', $1, 'https://caldav.example', 'https://caldav.example/book', 'me', $2, 'Contacts')`,
      [accountId, SEALED_CARD]
    )
    return accountId
  }

  it("strips every sealed envelope in the snapshot and leaves the live database sealed", async () => {
    const summary = await stripSnapshotDatabase(
      sqliteExecutor(new DatabaseSync(snapshotPath))
    )

    expect(summary).toEqual({
      accounts: 1,
      calendarSources: 1,
      carddavBooks: 1,
    })

    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true })
    expect(
      snapshot.prepare("SELECT credentials_json FROM accounts").get()
    ).toEqual({ credentials_json: null })
    expect(
      snapshot.prepare("SELECT config_json FROM calendar_sources").get()
    ).toEqual({ config_json: "" })
    expect(
      snapshot.prepare("SELECT credentials_json FROM carddav_books").get()
    ).toEqual({ credentials_json: "" })
    snapshot.close()

    // The LIVE database kept every envelope (the strip ran on the
    // snapshot connection only).
    const live = await executor.select<{
      credentials_json: string | null
    }>("SELECT credentials_json FROM accounts WHERE id = $1", [accountId])
    expect(live[0]?.credentials_json).toBe(SEALED_ACCOUNT)
  })

  it("the snapshot file carries no sealed-envelope material anywhere (task 5.1)", async () => {
    // Task 5.1's archive-content scan: the bytes that will ride inside
    // db.snapshot must not contain ANY sealed-envelope shape — not in the
    // stripped columns and not in a stray copy elsewhere (freelist pages,
    // other tables, index remnants). Reading the raw file catches what a
    // per-column SELECT would miss.
    await stripSnapshotDatabase(sqliteExecutor(new DatabaseSync(snapshotPath)))

    const raw = readFileSync(snapshotPath)
    expect(raw.includes(Buffer.from(SEALED_ACCOUNT, "utf8"))).toBe(false)
    expect(raw.includes(Buffer.from(SEALED_CALENDAR, "utf8"))).toBe(false)
    expect(raw.includes(Buffer.from(SEALED_CARD, "utf8"))).toBe(false)
    // The AES-GCM envelope shape itself (any ciphertext) is absent, while
    // the non-secret columns the strip keeps are still present.
    expect(raw.includes(Buffer.from('"ct":', "utf8"))).toBe(false)
    expect(raw.includes(Buffer.from("scope1 scope2", "utf8"))).toBe(true)
  })

  it("keeps the snapshot's mail searchable after the strip", async () => {
    await stripSnapshotDatabase(sqliteExecutor(new DatabaseSync(snapshotPath)))
    const snapshot = new DatabaseSync(snapshotPath, { readOnly: true })
    const fts = snapshot
      .prepare(`SELECT subject FROM messages_fts WHERE messages_fts MATCH ?`)
      .all('"don dep"')
    expect(fts).toEqual([{ subject: "Bé Dọn Dẹp" }])
    snapshot.close()
  })

  it("strip statements cover exactly the three sealed columns", () => {
    expect(SNAPSHOT_STRIP_STATEMENTS).toEqual([
      "UPDATE accounts SET credentials_json = NULL",
      "UPDATE calendar_sources SET config_json = ''",
      "UPDATE carddav_books SET credentials_json = ''",
    ])
  })
})
