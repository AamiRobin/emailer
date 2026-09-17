import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount } from "./fixtures"
import { createTestExecutor, type TestExecutor } from "./test-executor"

/**
 * Migration v3 (task 1.1): the thread-state columns (D1/D6), the ten
 * parity feature tables, and the sender/hold/snooze indexes must all land
 * when the real migrations run on a fresh database. Migration v4 (task
 * 13.2): the sender_stats.user_class priority override column (D7).
 * Migration v5 (task 17.x, D9): the local_drafts.server_draft_ref
 * server-mirror column. Migration v6 (task 1.3, D18/D19): the
 * junk_tokens and attachment_scan_cache security tables. Migration v7
 * (task 20.2): the contacts.notes free-form notes column.
 */

const NEW_THREAD_COLUMNS = [
  "snoozed_until",
  "muted_at",
  "pinned_at",
  "done_at",
  "note",
  "held_until",
  "delivered_at",
] as const

const NEW_TABLES = [
  "snippets",
  "saved_searches",
  "scheduled_sends",
  "followup_reminders",
  "blocked_senders",
  "aliases",
  "sender_stats",
  "notification_rules",
  "rules",
  "todos",
] as const

const NEW_INDEXES = [
  "idx_messages_account_from",
  "idx_threads_account_held",
  "idx_threads_snoozed_until",
] as const

describe("migration v3 schema", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("adds the seven nullable thread state columns", async () => {
    const columns = await executor.select<{
      name: string
      notnull: number
    }>("PRAGMA table_info(threads)")
    const byName = new Map(columns.map((column) => [column.name, column]))
    for (const name of NEW_THREAD_COLUMNS) {
      const column = byName.get(name)
      expect(column, `threads.${name} should exist`).toBeDefined()
      expect(column?.notnull, `threads.${name} should be nullable`).toBe(0)
    }
  })

  it("creates the ten parity feature tables", async () => {
    const rows = await executor.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    )
    const names = rows.map((row) => row.name)
    for (const table of NEW_TABLES) {
      expect(names, `${table} table should exist`).toContain(table)
    }
  })

  it("creates the required sender/hold/snooze indexes", async () => {
    const rows = await executor.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index'"
    )
    const names = rows.map((row) => row.name)
    for (const index of NEW_INDEXES) {
      expect(names, `${index} should exist`).toContain(index)
    }
  })

  it("accepts smoke inserts with defaults and account FKs", async () => {
    const accountId = await createAccount(executor)

    await executor.execute(
      "INSERT INTO snippets (id, name, body, shortcut) VALUES ($1, $2, $3, $4)",
      ["snip-1", "Intro", "Hi there,", "intro"]
    )
    const snippets = await executor.select<{ created_at: number }>(
      "SELECT created_at FROM snippets WHERE id = $1",
      ["snip-1"]
    )
    // created_at comes from the unixepoch() default, not the insert
    expect(snippets[0]?.created_at).toBeGreaterThan(0)

    await executor.execute(
      `INSERT INTO scheduled_sends (
        id, account_id, mime_payload, recipients_json, subject, due_at
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      ["sched-1", accountId, "MIME payload", "[]", "Hello later", 1_700_001_000]
    )
    const sends = await executor.select<{
      status: string
      created_at: number
    }>("SELECT status, created_at FROM scheduled_sends WHERE id = $1", [
      "sched-1",
    ])
    expect(sends[0]).toMatchObject({ status: "scheduled" })
    expect(sends[0]?.created_at).toBeGreaterThan(0)
  })
})

describe("migration v4 schema (task 13.2)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("adds the nullable sender_stats.user_class override column", async () => {
    const columns = await executor.select<{ name: string; notnull: number }>(
      "PRAGMA table_info(sender_stats)"
    )
    const column = columns.find((entry) => entry.name === "user_class")
    expect(column, "sender_stats.user_class should exist").toBeDefined()
    expect(column?.notnull, "user_class should be nullable").toBe(0)
  })

  it("accepts NULL and the two class values, rejecting anything else", async () => {
    const accountId = await createAccount(executor)
    for (const value of [null, "important", "other"]) {
      await executor.execute(
        `INSERT INTO sender_stats (
           id, account_id, sender, reply_count, direct_to_me_count,
           last_message_at, is_mailing_list, user_class
         ) VALUES ($1, $2, $3, 0, 0, NULL, 0, $4)`,
        [`stat-${String(value)}`, accountId, `s-${String(value)}@x.com`, value]
      )
    }
    const rows = await executor.select<{ user_class: string | null }>(
      "SELECT user_class FROM sender_stats ORDER BY sender ASC"
    )
    // ASC sender order: s-important@…, s-null@…, s-other@…
    expect(rows.map((row) => row.user_class)).toEqual([
      "important",
      null,
      "other",
    ])

    await expect(
      executor.execute(
        `INSERT INTO sender_stats (
           id, account_id, sender, reply_count, direct_to_me_count,
           last_message_at, is_mailing_list, user_class
         ) VALUES ($1, $2, $3, 0, 0, NULL, 0, $4)`,
        ["stat-bad", accountId, "bad@x.com", "spam"]
      )
    ).rejects.toThrow()
  })
})

describe("migration v5 schema (task 17.x, D9)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("adds the nullable local_drafts.server_draft_ref mirror column", async () => {
    const columns = await executor.select<{ name: string; notnull: number }>(
      "PRAGMA table_info(local_drafts)"
    )
    const column = columns.find((entry) => entry.name === "server_draft_ref")
    expect(column, "local_drafts.server_draft_ref should exist").toBeDefined()
    expect(column?.notnull, "server_draft_ref should be nullable").toBe(0)
  })
})

describe("migration v6 schema (task 1.3, D18/D19)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("creates the junk_tokens and attachment_scan_cache tables", async () => {
    const rows = await executor.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    )
    const names = rows.map((row) => row.name)
    for (const table of ["junk_tokens", "attachment_scan_cache"]) {
      expect(names, `${table} table should exist`).toContain(table)
    }
  })

  it("gives junk_tokens the per-account token count columns", async () => {
    const columns = await executor.select<{ name: string; notnull: number }>(
      "PRAGMA table_info(junk_tokens)"
    )
    const names = columns.map((column) => column.name)
    for (const name of [
      "account_id",
      "token",
      "spam_count",
      "ham_count",
      "updated_at",
    ]) {
      expect(names, `junk_tokens.${name} should exist`).toContain(name)
    }
  })

  it("gives attachment_scan_cache the per-hash verdict columns", async () => {
    const columns = await executor.select<{ name: string; notnull: number }>(
      "PRAGMA table_info(attachment_scan_cache)"
    )
    const names = columns.map((column) => column.name)
    for (const name of [
      "sha256",
      "verdict",
      "malicious_count",
      "total_engines",
      "looked_up_at",
    ]) {
      expect(names, `attachment_scan_cache.${name} should exist`).toContain(
        name
      )
    }
  })

  it("accepts smoke inserts with defaults and enforces the verdict check", async () => {
    const accountId = await createAccount(executor)

    await executor.execute(
      `INSERT INTO junk_tokens (account_id, token, spam_count, ham_count)
       VALUES ($1, $2, 3, 1)`,
      [accountId, "winner"]
    )
    const tokens = await executor.select<{
      spam_count: number
      ham_count: number
      updated_at: number
    }>(
      "SELECT spam_count, ham_count, updated_at FROM junk_tokens " +
        "WHERE account_id = $1 AND token = $2",
      [accountId, "winner"]
    )
    expect(tokens[0]).toMatchObject({ spam_count: 3, ham_count: 1 })
    // updated_at comes from the unixepoch() default, not the insert
    expect(tokens[0]?.updated_at).toBeGreaterThan(0)

    await executor.execute(
      `INSERT INTO attachment_scan_cache (
        sha256, verdict, malicious_count, total_engines
      ) VALUES ($1, 'malicious', 5, 70)`,
      ["a".repeat(64)]
    )
    const scans = await executor.select<{
      verdict: string
      looked_up_at: number
    }>(
      "SELECT verdict, looked_up_at FROM attachment_scan_cache WHERE sha256 = $1",
      ["a".repeat(64)]
    )
    expect(scans[0]).toMatchObject({ verdict: "malicious" })
    expect(scans[0]?.looked_up_at).toBeGreaterThan(0)

    await expect(
      executor.execute(
        "INSERT INTO attachment_scan_cache (sha256, verdict) VALUES ($1, $2)",
        ["b".repeat(64), "probably-fine"]
      )
    ).rejects.toThrow()
  })
})

describe("migration v7 schema (task 20.2)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("adds the nullable contacts.notes column", async () => {
    const columns = await executor.select<{ name: string; notnull: number }>(
      "PRAGMA table_info(contacts)"
    )
    const column = columns.find((entry) => entry.name === "notes")
    expect(column, "contacts.notes should exist").toBeDefined()
    expect(column?.notnull, "notes should be nullable").toBe(0)
  })

  it("accepts NULL and free-form text alongside the existing contact rows", async () => {
    const accountId = await createAccount(executor)
    await executor.execute(
      `INSERT INTO contacts (id, account_id, email, name, interaction_count, notes)
       VALUES ($1, $2, $3, $4, 0, $5)`,
      ["c-1", accountId, "bob@x.com", "Bob", "Met at the conference"]
    )
    await executor.execute(
      `INSERT INTO contacts (id, account_id, email, interaction_count)
       VALUES ($1, $2, $3, 0)`,
      ["c-2", accountId, "anon@x.com"]
    )
    const rows = await executor.select<{ email: string; notes: string | null }>(
      "SELECT email, notes FROM contacts ORDER BY email ASC"
    )
    expect(rows).toEqual([
      { email: "anon@x.com", notes: null },
      { email: "bob@x.com", notes: "Met at the conference" },
    ])
  })
})
