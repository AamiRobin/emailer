import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { searchThreadsQuery } from "../../search/index"
import { at, createAccount, createMessage, createThread } from "./fixtures"
import { createTestExecutor, type TestExecutor } from "./test-executor"

/**
 * Migration v3 (task 1.1): the thread-state columns (D1/D6), the ten
 * parity feature tables, and the sender/hold/snooze indexes must all land
 * when the real migrations run on a fresh database. Migration v4 (task
 * 13.2): the sender_stats.user_class priority override column (D7).
 * Migration v5 (task 17.x, D9): the local_drafts.server_draft_ref
 * server-mirror column. Migration v6 (task 1.3, D18/D19): the
 * junk_tokens and attachment_scan_cache security tables. Migration v7
 * (task 20.2): the contacts.notes free-form notes column. Migration v10
 * (task 4.3, D2): the ai_cache and writing_style_profiles AI tables.
 * Migration v13 (task 1.3, D7): the accent-insensitive FTS upgrade path —
 * pre-v13 rows are found by the folded query after the swap and the
 * triggers keep the index in sync. Migration v14 (parity-round-2 task
 * 2.2, D8): the ai_usage per-request token table.
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

describe("migration v11 schema (task 5.1, design D5)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("creates the calendar_sources and calendar_events tables", async () => {
    const rows = await executor.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    )
    const names = rows.map((row) => row.name)
    for (const table of ["calendar_sources", "calendar_events"]) {
      expect(names, `${table} table should exist`).toContain(table)
    }
  })

  it("creates the event range index and the account index", async () => {
    const rows = await executor.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index'"
    )
    const names = rows.map((row) => row.name)
    expect(names).toContain("idx_calendar_events_start_at")
    expect(names).toContain("idx_calendar_sources_account")
  })

  it("gives calendar_sources the provider columns with a nullable account link", async () => {
    const columns = await executor.select<{
      name: string
      notnull: number
      dflt_value: string | null
    }>("PRAGMA table_info(calendar_sources)")
    const byName = new Map(columns.map((column) => [column.name, column]))

    // Note: SQLite's table_info does not flag TEXT PRIMARY KEY columns as
    // notnull, so "id" is only checked for existence (same as v10).
    for (const name of ["provider", "name", "config_json"]) {
      const column = byName.get(name)
      expect(column, `calendar_sources.${name} should exist`).toBeDefined()
      expect(
        column?.notnull,
        `calendar_sources.${name} should be NOT NULL`
      ).toBe(1)
    }
    // account_id links the mail account (google) — nullable for later
    // caldav sources; sync_state_json is optional bookkeeping.
    expect(byName.get("account_id")?.notnull).toBe(0)
    expect(byName.get("sync_state_json")?.notnull).toBe(0)
    // created_at comes from the unixepoch() default.
    expect(byName.get("created_at")?.dflt_value).toContain("unixepoch")
  })

  it("enforces the provider check on calendar_sources", async () => {
    await executor.execute(
      `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
       VALUES ('src-1', NULL, 'google', 'me@gmail.com', 'sealed')`
    )
    await expect(
      executor.execute(
        `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
         VALUES ('src-2', NULL, 'icloud', 'x', 'y')`
      )
    ).rejects.toThrow()
  })

  it("gives calendar_events the event columns and the source/calendar/uid identity", async () => {
    const columns = await executor.select<{
      name: string
      notnull: number
      dflt_value: string | null
    }>("PRAGMA table_info(calendar_events)")
    const byName = new Map(columns.map((column) => [column.name, column]))
    for (const name of [
      "source_id",
      "calendar_id",
      "uid",
      "ical",
      "start_at",
      "end_at",
    ]) {
      const column = byName.get(name)
      expect(column, `calendar_events.${name} should exist`).toBeDefined()
      expect(
        column?.notnull,
        `calendar_events.${name} should be NOT NULL`
      ).toBe(1)
    }
    // Nullable/descriptive columns.
    for (const name of [
      "summary",
      "location",
      "description",
      "recurrence",
      "status",
      "updated_at",
    ]) {
      expect(byName.get(name)?.notnull, `calendar_events.${name}`).toBe(0)
    }
    // all_day is NOT NULL with a 0 default.
    expect(byName.get("all_day")?.notnull).toBe(1)
    expect(byName.get("all_day")?.dflt_value).toBe("0")
  })

  it("accepts a smoke insert with defaults and enforces the (source, calendar, uid) uniqueness", async () => {
    const accountId = await createAccount(executor)
    await executor.execute(
      `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
       VALUES ('src-1', $1, 'google', 'me@gmail.com', 'sealed')`,
      [accountId]
    )
    await executor.execute(
      `INSERT INTO calendar_events (
         id, source_id, calendar_id, uid, ical, summary, start_at, end_at,
         all_day, recurrence, status
       ) VALUES ('e-1', 'src-1', 'cal-1', 'uid-1', 'BEGIN:VEVENT', 'Lunch',
                 100, 200, 0, '["RRULE:FREQ=DAILY"]', 'confirmed')`
    )
    const events = await executor.select<{
      all_day: number
      recurrence: string
      created_default: number
    }>("SELECT all_day, recurrence, updated_at FROM calendar_events WHERE id = 'e-1'")
    expect(events[0]).toMatchObject({
      all_day: 0,
      recurrence: '["RRULE:FREQ=DAILY"]',
    })

    // The same uid on the same calendar is rejected — the upsert identity.
    await expect(
      executor.execute(
        `INSERT INTO calendar_events (
           id, source_id, calendar_id, uid, ical, start_at, end_at
         ) VALUES ('e-2', 'src-1', 'cal-1', 'uid-1', 'x', 0, 0)`
      )
    ).rejects.toThrow()
    // A different calendar accepts the same uid.
    await executor.execute(
      `INSERT INTO calendar_events (
         id, source_id, calendar_id, uid, ical, start_at, end_at
       ) VALUES ('e-3', 'src-1', 'cal-2', 'uid-1', 'x', 0, 0)`
    )
  })

  it("cascades calendar data when the owning mail account is removed", async () => {
    const accountId = await createAccount(executor)
    await executor.execute(
      `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
       VALUES ('src-1', $1, 'google', 'me@gmail.com', 'sealed')`,
      [accountId]
    )
    await executor.execute(
      `INSERT INTO calendar_events (
         id, source_id, calendar_id, uid, ical, start_at, end_at
       ) VALUES ('e-1', 'src-1', 'cal-1', 'uid-1', 'x', 0, 0)`
    )

    await executor.execute("DELETE FROM accounts WHERE id = $1", [accountId])
    const sources = await executor.select<{ id: string }>(
      "SELECT id FROM calendar_sources"
    )
    const events = await executor.select<{ id: string }>(
      "SELECT id FROM calendar_events"
    )
    expect(sources).toEqual([])
    expect(events).toEqual([])
  })
})

describe("migration v10 schema (task 4.3, D2)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("creates the ai_cache and writing_style_profiles tables", async () => {
    const rows = await executor.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    )
    const names = rows.map((row) => row.name)
    for (const table of ["ai_cache", "writing_style_profiles"]) {
      expect(names, `${table} table should exist`).toContain(table)
    }
  })

  it("gives ai_cache the content-hash cache columns with nullable provenance", async () => {
    const columns = await executor.select<{ name: string; notnull: number }>(
      "PRAGMA table_info(ai_cache)"
    )
    const byName = new Map(columns.map((column) => [column.name, column]))
    for (const name of [
      "provider",
      "model",
      "input_hash",
      "kind",
      "output",
    ]) {
      const column = byName.get(name)
      expect(column, `ai_cache.${name} should exist`).toBeDefined()
      expect(column?.notnull, `ai_cache.${name} should be NOT NULL`).toBe(1)
    }
    // Provenance attribution, not part of the key — NULL is allowed.
    expect(byName.get("account_id")?.notnull).toBe(0)
  })

  it("enforces the (provider, model, input_hash) cache identity", async () => {
    await executor.execute(
      `INSERT INTO ai_cache (provider, model, input_hash, kind, output)
       VALUES ('p', 'm', 'hash', 'summary', 'out')`
    )
    await expect(
      executor.execute(
        `INSERT INTO ai_cache (provider, model, input_hash, kind, output)
         VALUES ('p', 'm', 'hash', 'summary', 'other')`
      )
    ).rejects.toThrow()
  })

  it("gives writing_style_profiles one primary-keyed row per account", async () => {
    const columns = await executor.select<{
      name: string
      notnull: number
      pk: number
    }>("PRAGMA table_info(writing_style_profiles)")
    const byName = new Map(columns.map((column) => [column.name, column]))
    const accountColumn = byName.get("account_id")
    expect(accountColumn, "account_id should exist").toBeDefined()
    expect(accountColumn?.pk, "account_id should be the primary key").toBe(1)
    for (const name of ["profile_json", "built_at", "sample_size"]) {
      const column = byName.get(name)
      expect(column, `writing_style_profiles.${name} should exist`).toBeDefined()
      expect(
        column?.notnull,
        `writing_style_profiles.${name} should be NOT NULL`
      ).toBe(1)
    }

    const accountId = await createAccount(executor)
    await executor.execute(
      `INSERT INTO writing_style_profiles (
         account_id, profile_json, built_at, sample_size
       ) VALUES ($1, '{}', 1, 2)`,
      [accountId]
    )
    // The account_id primary key rejects a second row for the account.
    await expect(
      executor.execute(
        `INSERT INTO writing_style_profiles (
           account_id, profile_json, built_at, sample_size
         ) VALUES ($1, '{}', 3, 4)`,
        [accountId]
      )
    ).rejects.toThrow()
  })
})

describe("migration v13 upgrade path (task 1.3, D7)", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    // ONLY the migrations ≤ v12: the pre-v13 install whose FTS index uses
    // the plain trigram tokenizer (keeps diacritics).
    executor = createTestExecutor({ upToVersion: 12 })
    accountId = await createAccount(executor, "gmail")
  })

  afterEach(() => {
    executor.close()
  })

  it("reindexes pre-existing accented rows and keeps trigger upkeep after the swap", async () => {
    // Seeded BEFORE v13: the rows land in messages and the v12 (diacritic-
    // keeping) index via the then-current triggers.
    const threadId = await createThread(executor, accountId, {
      subject: "Bé Dọn Dẹp",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: at(100),
      subject: "Bé Dọn Dẹp",
      fromName: "Hoà Bình",
      fromAddress: "hoa@vn.example",
      bodyText: "Lịch họp tuần sau đã đổi.",
      snippet: "Lịch họp tuần sau đã đổi.",
    })

    // The upgrade: v13 drops the old virtual table, re-creates it with
    // `remove_diacritics 1` and rebuilds the index from the surviving
    // rows — messages untouched, triggers re-created verbatim.
    executor.applyMigration(13)

    // (a) The spec's strict unaccented query finds the accented rows that
    // predate the swap — the trigram index through the rebuilt FTS
    // ("lich hop" can only come from the index) and the sub-trigram scan.
    expect(
      (await searchThreadsQuery(executor, accountId, "be don dep")).map(
        (thread) => thread.subject
      )
    ).toEqual(["Bé Dọn Dẹp"])
    expect(
      (await searchThreadsQuery(executor, accountId, "lich hop")).map(
        (thread) => thread.subject
      )
    ).toEqual(["Bé Dọn Dẹp"])

    // (b) The insert/update/delete triggers still sync the index after
    // the swap — every change is visible through the same folded queries.
    const secondThread = await createThread(executor, accountId, {
      subject: "Phở Hà Nội",
    })
    await createMessage(executor, {
      threadId: secondThread,
      accountId,
      date: at(200),
      subject: "Phở Hà Nội",
      fromAddress: "an@vn.example",
      bodyText: "Menu bữa trưa.",
      snippet: "Menu bữa trưa.",
    })
    expect(
      (await searchThreadsQuery(executor, accountId, "pho ha")).map(
        (thread) => thread.subject
      )
    ).toEqual(["Phở Hà Nội"])

    const rows = await executor.select<{ id: string }>(
      "SELECT id FROM messages WHERE thread_id = $1",
      [threadId]
    )
    await executor.execute("UPDATE messages SET subject = $1 WHERE id = $2", [
      "Báo cáo đã duyệt",
      rows[0]!.id,
    ])
    expect(await searchThreadsQuery(executor, accountId, "be don dep")).toEqual(
      []
    )
    // The thread matches again through its message's NEW subject (the
    // threads row's denormalized subject is untouched by the raw update —
    // assert on the id).
    expect(
      (await searchThreadsQuery(executor, accountId, "bao cao")).map(
        (thread) => thread.id
      )
    ).toEqual([threadId])

    await executor.execute("DELETE FROM messages WHERE id = $1", [rows[0]!.id])
    expect(await searchThreadsQuery(executor, accountId, "bao cao")).toEqual([])
  })
})

describe("migration v14 schema (parity-round-2 task 2.2, D8)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("creates the ai_usage table with the per-request usage columns", async () => {
    const rows = await executor.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    )
    expect(rows.map((row) => row.name)).toContain("ai_usage")

    const columns = await executor.select<{
      name: string
      notnull: number
      dflt_value: string | null
      pk: number
    }>("PRAGMA table_info(ai_usage)")
    const byName = new Map(columns.map((column) => [column.name, column]))
    // id is the app-generated UUID primary key (the v1 convention).
    expect(byName.get("id")?.pk).toBe(1)
    for (const name of ["surface", "estimated", "created_at"]) {
      const column = byName.get(name)
      expect(column, `ai_usage.${name} should exist`).toBeDefined()
      expect(column?.notnull, `ai_usage.${name} should be NOT NULL`).toBe(1)
    }
    // Tokens and the model id are nullable: providers that omit usage
    // leave the choice to the call site, and the model is optional.
    for (const name of [
      "model",
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
    ]) {
      expect(byName.get(name)?.notnull, `ai_usage.${name}`).toBe(0)
    }
    expect(byName.get("estimated")?.dflt_value).toBe("0")
    expect(byName.get("created_at")?.dflt_value).toContain("unixepoch")
  })

  it("creates the per-surface aggregation index", async () => {
    const rows = await executor.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index'"
    )
    expect(rows.map((row) => row.name)).toContain("idx_ai_usage_surface")
  })

  it("accepts reported and estimated rows and defaults created_at/estimated", async () => {
    await executor.execute(
      `INSERT INTO ai_usage (
         id, surface, model, prompt_tokens, completion_tokens, total_tokens, estimated
       ) VALUES ('u-1', 'summaries', 'claude-haiku', 120, 80, 200, 0)`,
    )
    await executor.execute(
      `INSERT INTO ai_usage (id, surface, model, prompt_tokens, completion_tokens, total_tokens, estimated)
       VALUES ('u-2', 'askInbox', NULL, 8, 4, 12, 1)`
    )
    const rows = await executor.select<{
      surface: string
      model: string | null
      prompt_tokens: number
      total_tokens: number
      estimated: number
      created_at: number
    }>("SELECT * FROM ai_usage ORDER BY id ASC")
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      surface: "summaries",
      model: "claude-haiku",
      prompt_tokens: 120,
      total_tokens: 200,
      estimated: 0,
    })
    expect(rows[1]).toMatchObject({
      surface: "askInbox",
      model: null,
      estimated: 1,
    })
    for (const row of rows) {
      // created_at comes from the unixepoch() default, not the insert.
      expect(row.created_at).toBeGreaterThan(0)
    }

    // surface NOT NULL is enforced.
    await expect(
      executor.execute(
        "INSERT INTO ai_usage (id, surface) VALUES ('u-3', NULL)"
      )
    ).rejects.toThrow()
  })

  it("aggregates per surface with SUM over the token columns", async () => {
    for (const [id, surface, prompt, completion, total, estimated] of [
      ["u-1", "summaries", 100, 50, 150, 0],
      ["u-2", "summaries", 10, 5, 15, 1],
      ["u-3", "askInbox", 40, 20, 60, 0],
    ] as const) {
      await executor.execute(
        `INSERT INTO ai_usage (
           id, surface, prompt_tokens, completion_tokens, total_tokens, estimated
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, surface, prompt, completion, total, estimated]
      )
    }
    const rows = await executor.select<{
      surface: string
      requests: number
      total_tokens: number
      estimated_requests: number
    }>(
      `SELECT surface, COUNT(*) AS requests,
              COALESCE(SUM(total_tokens), 0) AS total_tokens,
              COALESCE(SUM(estimated), 0) AS estimated_requests
       FROM ai_usage GROUP BY surface ORDER BY surface ASC`
    )
    expect(rows).toEqual([
      { surface: "askInbox", requests: 1, total_tokens: 60, estimated_requests: 0 },
      { surface: "summaries", requests: 2, total_tokens: 165, estimated_requests: 1 },
    ])
  })
})

describe("migration v15 upgrade path (parity-round-2, task 3.1)", () => {
  let executor: TestExecutor
  let gmailAccountId: string

  beforeEach(async () => {
    // ONLY the migrations ≤ v14: the pre-v15 install whose accounts.type
    // CHECK still rejects 'microsoft'.
    executor = createTestExecutor({ upToVersion: 14 })
    gmailAccountId = await createAccount(executor, "gmail")
    // A child row proves the rebuild does not cascade anything away.
    const threadId = await createThread(executor, gmailAccountId, {
      subject: "Survives",
    })
    await createMessage(executor, {
      threadId,
      accountId: gmailAccountId,
      date: at(10),
      subject: "Survives",
    })
  })

  afterEach(() => {
    executor.close()
  })

  it("widens the type CHECK, keeps every existing row and child row intact", async () => {
    executor.applyMigration(15)

    // The existing account (and its messages/threads) survived the
    // rebuild — with FK enforcement back ON.
    const kept = await executor.select<{ id: string; type: string }>(
      "SELECT id, type FROM accounts"
    )
    expect(kept).toEqual([{ id: gmailAccountId, type: "gmail" }])
    const children = await executor.select<{ one: number }>(
      "SELECT 1 AS one FROM messages WHERE account_id = $1",
      [gmailAccountId]
    )
    expect(children.length).toBeGreaterThan(0)

    // A microsoft account row now inserts cleanly.
    await executor.execute(
      "INSERT INTO accounts (id, type, email, status) VALUES ($1, $2, $3, $4)",
      ["acc-ms", "microsoft", "me@outlook.com", "active"]
    )
    const types = await executor.select<{ type: string }>(
      "SELECT type FROM accounts ORDER BY type ASC"
    )
    expect(types.map((row) => row.type)).toEqual(["gmail", "microsoft"])

    // The widened table still rejects unknown types.
    await expect(
      executor.execute(
        "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
        ["acc-bad", "exchange", "x@y.example"]
      )
    ).rejects.toThrow()
  })
})

describe("migration v16 upgrade path (parity-round-2, task 3.6)", () => {
  let executor: TestExecutor
  let gmailAccountId: string

  beforeEach(async () => {
    // ONLY the migrations ≤ v15: the pre-v16 install whose
    // calendar_sources.provider CHECK still rejects 'microsoft'.
    executor = createTestExecutor({ upToVersion: 15 })
    gmailAccountId = await createAccount(executor, "gmail")
    // A google source with a cached event proves the rebuild keeps both.
    await executor.execute(
      `INSERT INTO calendar_sources (id, account_id, provider, name, config_json, sync_state_json)
       VALUES ('src-kept', $1, 'google', 'me@gmail.com', 'sealed', '{"cal-1":{"nextSyncToken":"tok-1"}}')`,
      [gmailAccountId]
    )
    await executor.execute(
      `INSERT INTO calendar_events (
         id, source_id, calendar_id, uid, ical, summary, start_at, end_at
       ) VALUES ('ev-kept', 'src-kept', 'cal-1', 'uid-1', 'BEGIN:VEVENT', 'Kept', 0, 0)`
    )
  })

  afterEach(() => {
    executor.close()
  })

  it("widens the provider CHECK, keeps every existing row, event and index", async () => {
    executor.applyMigration(16)

    // The existing source (and its cached event) survived the rebuild —
    // with FK enforcement back ON and the sync-state blob intact.
    const kept = await executor.select<{
      id: string
      provider: string
      sync_state_json: string | null
    }>(
      "SELECT id, provider, sync_state_json FROM calendar_sources"
    )
    expect(kept).toEqual([
      {
        id: "src-kept",
        provider: "google",
        sync_state_json: '{"cal-1":{"nextSyncToken":"tok-1"}}',
      }
    ])
    const events = await executor.select<{ id: string }>(
      "SELECT id FROM calendar_events WHERE source_id = 'src-kept'"
    )
    expect(events).toEqual([{ id: "ev-kept" }])
    // The account FK still resolves (the child rows reference by name).
    const accounts = await executor.select<{ id: string }>(
      "SELECT id FROM accounts WHERE id = $1",
      [gmailAccountId]
    )
    expect(accounts).toEqual([{ id: gmailAccountId }])
    // The v11 source-account index was rebuilt with the table.
    const indexes = await executor.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'calendar_sources'"
    )
    expect(indexes.map((row) => row.name)).toContain(
      "idx_calendar_sources_account"
    )

    // A microsoft source row now inserts cleanly, and an unknown provider
    // is still rejected by the widened CHECK.
    await executor.execute(
      `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
       VALUES ('src-ms', $1, 'microsoft', 'me@outlook.com', 'sealed')`,
      [gmailAccountId]
    )
    await expect(
      executor.execute(
        `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
         VALUES ('src-bad', NULL, 'icloud', 'x', 'y')`
      )
    ).rejects.toThrow()
  })
})

describe("migration v18 schema (parity-round-2 tasks 4.4/4.5, D10)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("creates the account_profiles table with the profile columns", async () => {
    const tables = await executor.select<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table'"
    )
    expect(tables.map((row) => row.name)).toContain("account_profiles")

    const columns = await executor.select<{
      name: string
      notnull: number
      pk: number
      dflt_value: string | null
    }>("PRAGMA table_info(account_profiles)")
    const byName = new Map(columns.map((column) => [column.name, column]))
    // id is the app-generated UUID primary key (the v1 convention).
    expect(byName.get("id")?.pk).toBe(1)
    for (const name of ["name", "color"]) {
      const column = byName.get(name)
      expect(column, `account_profiles.${name} should exist`).toBeDefined()
      expect(
        column?.notnull,
        `account_profiles.${name} should be NOT NULL`
      ).toBe(1)
    }
    expect(byName.get("created_at")?.dflt_value).toContain("unixepoch")
  })

  it("adds the nullable accounts.profile_id FK and color_override columns", async () => {
    const columns = await executor.select<{
      name: string
      notnull: number
      dflt_value: string | null
    }>("PRAGMA table_info(accounts)")
    const byName = new Map(columns.map((column) => [column.name, column]))
    for (const name of ["profile_id", "color_override"]) {
      const column = byName.get(name)
      expect(column, `accounts.${name} should exist`).toBeDefined()
      expect(column?.notnull, `accounts.${name} should be nullable`).toBe(0)
      expect(column?.dflt_value, `accounts.${name} should default to NULL`)
        .toBeNull()
    }
    // profile_id is a real FK to account_profiles (ON DELETE SET NULL).
    const foreignKeys = await executor.select<{
      from: string
      table: string
      to: string | null
      on_delete: string
    }>("PRAGMA foreign_key_list(accounts)")
    const profileFk = foreignKeys.find((key) => key.from === "profile_id")
    expect(profileFk).toMatchObject({
      table: "account_profiles",
      to: "id",
      on_delete: "SET NULL",
    })
  })

  it("accepts smoke inserts and nulls profile_id when the profile is deleted", async () => {
    const accountId = await createAccount(executor)
    await executor.execute(
      "INSERT INTO account_profiles (id, name, color) VALUES ($1, $2, $3)",
      ["prof-1", "Work", "#8b5cf6"]
    )
    await executor.execute(
      "UPDATE accounts SET profile_id = $1, color_override = $2 WHERE id = $3",
      ["prof-1", "#f97316", accountId]
    )
    const assigned = await executor.select<{
      profile_id: string | null
      color_override: string | null
    }>("SELECT profile_id, color_override FROM accounts WHERE id = $1", [
      accountId,
    ])
    expect(assigned[0]).toEqual({ profile_id: "prof-1", color_override: "#f97316" })

    // Delete the profile: the account KEEPS WORKING (delete-keeps-
    // accounts) — profile_id nulled by the FK action, the per-account
    // override untouched, no mail data involved.
    await executor.execute("DELETE FROM account_profiles WHERE id = $1", [
      "prof-1",
    ])
    const kept = await executor.select<{
      id: string
      profile_id: string | null
      color_override: string | null
    }>("SELECT id, profile_id, color_override FROM accounts WHERE id = $1", [
      accountId,
    ])
    expect(kept[0]).toEqual({
      id: accountId,
      profile_id: null,
      color_override: "#f97316",
    })

    // A dangling profile_id is rejected by the FK.
    await expect(
      executor.execute(
        "UPDATE accounts SET profile_id = $1 WHERE id = $2",
        ["prof-missing", accountId]
      )
    ).rejects.toThrow()
  })
})

describe("migration v18 upgrade path (parity-round-2, task 4.4)", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    // ONLY the migrations ≤ v17: the pre-v18 install without profiles.
    executor = createTestExecutor({ upToVersion: 17 })
    accountId = await createAccount(executor)
    // Existing mail survives the purely additive step.
    await createThread(executor, accountId, { subject: "Survives" })
  })

  afterEach(() => {
    executor.close()
  })

  it("adds the profile columns additively and keeps every existing row", async () => {
    executor.applyMigration(18)

    // The pre-existing account and its threads are untouched; the new
    // columns read NULL (unassigned / inherit).
    const rows = await executor.select<{
      id: string
      profile_id: string | null
      color_override: string | null
    }>("SELECT id, profile_id, color_override FROM accounts WHERE id = $1", [
      accountId,
    ])
    expect(rows[0]).toEqual({
      id: accountId,
      profile_id: null,
      color_override: null,
    })
    const threads = await executor.select<{ one: number }>(
      "SELECT 1 AS one FROM threads WHERE account_id = $1",
      [accountId]
    )
    expect(threads.length).toBeGreaterThan(0)

    // And a profile + assignment round-trips on the upgraded schema.
    await executor.execute(
      "INSERT INTO account_profiles (id, name, color) VALUES ($1, $2, $3)",
      ["prof-new", "Personal", "#22c55e"]
    )
    await executor.execute(
      "UPDATE accounts SET profile_id = $1 WHERE id = $2",
      ["prof-new", accountId]
    )
    const assigned = await executor.select<{ profile_id: string | null }>(
      "SELECT profile_id FROM accounts WHERE id = $1",
      [accountId]
    )
    expect(assigned[0]?.profile_id).toBe("prof-new")
  })
})
