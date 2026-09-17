import { describe, expect, it } from "vitest"

import type { ThreadSortOption } from "../../db/thread-sort"
import { parseSearchQuery } from "../parser"
import { buildThreadSearchSql } from "../query-builder"

/** Collapse whitespace so assertions stay readable. */
function build(input: string, accountId = "acc-1", limit?: number) {
  const { sql, params } = buildThreadSearchSql(
    accountId,
    parseSearchQuery(input),
    limit === undefined ? undefined : { limit }
  )
  return { sql: sql.replace(/\s+/g, " ").trim(), params }
}

describe("buildThreadSearchSql", () => {
  it("always scopes to the account and excludes trash and spam", () => {
    const { sql, params } = build("pizzazz")
    expect(sql).toContain("threads.account_id = $1")
    expect(sql).toContain("threads.is_trashed = 0")
    expect(sql).toContain("threads.is_spam = 0")
    // pinned-first leads every sort; muted/done mail stays searchable
    expect(sql).toContain(
      "ORDER BY (threads.pinned_at IS NOT NULL) DESC, threads.last_message_at DESC"
    )
    expect(sql).not.toContain("muted_at")
    expect(sql).not.toContain("done_at")
    expect(sql).not.toContain("LIMIT")
    expect(params).toEqual(["acc-1", '"pizzazz"'])
  })

  it("is deterministic for identical input", () => {
    expect(build("from:a label:b xyz")).toEqual(build("from:a label:b xyz"))
  })

  it("builds a from: EXISTS matching address OR name", () => {
    const { sql, params } = build("from:alice")
    expect(sql).toContain(
      "m.from_address COLLATE NOCASE LIKE $2 ESCAPE '\\' " +
        "OR m.from_name COLLATE NOCASE LIKE $3 ESCAPE '\\'"
    )
    expect(params).toEqual(["acc-1", "%alice%", "%alice%"])
  })

  it("builds a to: EXISTS over to_json, cc_json and bcc_json", () => {
    const { sql, params } = build("to:bob@corp.example")
    expect(sql).toContain("m.to_json COLLATE NOCASE LIKE $2")
    expect(sql).toContain("m.cc_json COLLATE NOCASE LIKE $3")
    expect(sql).toContain("m.bcc_json COLLATE NOCASE LIKE $4")
    expect(params).toEqual([
      "acc-1",
      "%bob@corp.example%",
      "%bob@corp.example%",
      "%bob@corp.example%",
    ])
  })

  it("builds a subject: EXISTS over messages.subject", () => {
    const { sql, params } = build("subject:report")
    expect(sql).toContain("m.subject COLLATE NOCASE LIKE $2")
    expect(params).toEqual(["acc-1", "%report%"])
  })

  it("builds flag operators over the thread cache columns", () => {
    expect(build("has:attachment").sql).toContain("threads.has_attachments = 1")
    expect(build("is:unread").sql).toContain("threads.unread_count > 0")
    expect(build("is:starred").sql).toContain("threads.is_starred = 1")
    // flags bind no parameters
    expect(build("has:attachment is:unread is:starred").params).toEqual([
      "acc-1",
    ])
  })

  it("builds a label: EXISTS with exact and /segment-suffix matching", () => {
    const { sql, params } = build("label:receipts")
    expect(sql).toContain(
      "JOIN labels l ON l.id = tl.label_id WHERE tl.thread_id = threads.id"
    )
    expect(sql).toContain("tl.account_id = threads.account_id")
    expect(sql).toContain("l.name = $2 COLLATE NOCASE")
    expect(sql).toContain("OR l.name COLLATE NOCASE LIKE $3 ESCAPE '\\'")
    expect(params).toEqual(["acc-1", "receipts", "%/receipts"])
  })

  it("escapes LIKE wildcards in operator values", () => {
    expect(build("from:100%_done").params).toEqual([
      "acc-1",
      "%100\\%\\_done%",
      "%100\\%\\_done%",
    ])
  })

  it("routes free text of 3+ chars through one FTS MATCH", () => {
    const { sql, params } = build("planning roadmap")
    expect(sql).toContain("JOIN messages_fts ON messages_fts.rowid = m.rowid")
    expect(sql).toContain("messages_fts MATCH $2")
    // terms joined as quoted FTS5 strings (implicit AND)
    expect(params).toEqual(["acc-1", '"planning" "roadmap"'])
  })

  it("falls back to a LIKE scan for terms shorter than 3 chars", () => {
    const { sql, params } = build("zz qq")
    expect(sql).not.toContain("MATCH")
    for (const column of [
      "m.subject",
      "m.from_name",
      "m.from_address",
      "m.to_json",
      "m.body_text",
      "m.snippet",
    ]) {
      expect(sql).toContain(`${column} LIKE`)
    }
    expect(params).toEqual([
      "acc-1",
      "%zz%",
      "%zz%",
      "%zz%",
      "%zz%",
      "%zz%",
      "%zz%",
      "%qq%",
      "%qq%",
      "%qq%",
      "%qq%",
      "%qq%",
      "%qq%",
    ])
  })

  it("binds the spec's combined-operators scenario in operator order", () => {
    const { sql, params } = build("from:alice has:attachment is:unread")
    expect(sql).toContain("threads.has_attachments = 1")
    expect(sql).toContain("threads.unread_count > 0")
    // account, then the two from: LIKE patterns — nothing else
    expect(params).toEqual(["acc-1", "%alice%", "%alice%"])
  })

  it("builds negated operators as NOT over the same EXISTS shapes", () => {
    const { sql, params } = build("-from:spammer -subject:win")
    expect(sql).toContain(
      "NOT EXISTS ( SELECT 1 FROM messages m WHERE m.thread_id = threads.id " +
        "AND (m.from_address COLLATE NOCASE LIKE $2 ESCAPE '\\' " +
        "OR m.from_name COLLATE NOCASE LIKE $3 ESCAPE '\\')"
    )
    expect(sql).toContain(
      "NOT EXISTS ( SELECT 1 FROM messages m WHERE m.thread_id = threads.id " +
        "AND m.subject COLLATE NOCASE LIKE $4 ESCAPE '\\'"
    )
    expect(params).toEqual(["acc-1", "%spammer%", "%spammer%", "%win%"])
  })

  it("builds negated flags as the cache column at 0", () => {
    const { sql, params } = build("-has:attachment -is:unread -is:starred")
    expect(sql).toContain("threads.has_attachments = 0")
    expect(sql).toContain("threads.unread_count = 0")
    expect(sql).toContain("threads.is_starred = 0")
    expect(params).toEqual(["acc-1"])
  })

  it("builds a negated label as NOT EXISTS over the same join", () => {
    const { sql, params } = build("-label:receipts")
    expect(sql).toContain(
      "NOT EXISTS ( SELECT 1 FROM thread_labels tl JOIN labels l ON l.id = tl.label_id"
    )
    expect(params).toEqual(["acc-1", "receipts", "%/receipts"])
  })

  it("gives each negated free-text term its own NOT EXISTS", () => {
    const { sql, params } = build("-zz -planning")
    expect(sql.split("NOT EXISTS").length - 1).toBe(2)
    // long negated terms go through FTS, short ones through LIKE; the
    // LIKE scan binds six column params before the FTS term
    expect(sql).toContain("MATCH $8")
    expect(params).toEqual([
      "acc-1",
      "%zz%",
      "%zz%",
      "%zz%",
      "%zz%",
      "%zz%",
      "%zz%",
      '"planning"',
    ])
  })

  it("never leaks negated terms into the positive FTS MATCH", () => {
    const { sql } = build("planning -noise")
    expect(sql).toContain("MATCH $2")
    expect(sql).not.toContain('"planning" "-noise"')
    expect(sql).not.toContain('"planning" "noise"')
  })

  it("builds size predicates over messages.size_estimate", () => {
    const { sql, params } = build("larger:10m smaller:500k")
    expect(sql).toContain(
      "EXISTS ( SELECT 1 FROM messages m WHERE m.thread_id = threads.id " +
        "AND m.size_estimate > $2"
    )
    expect(sql).toContain("AND m.size_estimate < $3")
    expect(params).toEqual(["acc-1", 10 * 1024 * 1024, 500 * 1024])
  })

  it("builds date predicates over messages.date, before exclusive", () => {
    const { sql, params } = build("before:2026-01-01 after:2025/06/15")
    expect(sql).toContain("AND m.date < $2")
    expect(sql).toContain("AND m.date >= $3")
    expect(params).toEqual([
      "acc-1",
      Date.UTC(2026, 0, 1) / 1000,
      Date.UTC(2025, 5, 15) / 1000,
    ])
  })

  it("builds negated size and date bounds as NOT EXISTS mirrors", () => {
    const { sql, params } = build(
      "-larger:10m -smaller:500k -before:2026-01-01 -after:2025/06/15"
    )
    expect(sql.split("NOT EXISTS").length - 1).toBe(4)
    expect(sql).toContain(
      "NOT EXISTS ( SELECT 1 FROM messages m WHERE m.thread_id = threads.id " +
        "AND m.size_estimate > $2"
    )
    expect(sql).toContain("AND m.size_estimate < $3")
    expect(sql).toContain("AND m.date < $4")
    expect(sql).toContain("AND m.date >= $5")
    expect(params).toEqual([
      "acc-1",
      10 * 1024 * 1024,
      500 * 1024,
      Date.UTC(2026, 0, 1) / 1000,
      Date.UTC(2025, 5, 15) / 1000,
    ])
  })

  it("builds a negation-only query against every in-scope thread", () => {
    const { sql, params } = build("-from:newsletter@x.com")
    expect(sql).toContain("NOT EXISTS")
    // only the account scope and the one negated predicate bind params
    expect(params).toEqual([
      "acc-1",
      "%newsletter@x.com%",
      "%newsletter@x.com%",
    ])
  })

  it("binds the spec's label scenario in operator order", () => {
    const { sql, params } = build("label:receipts invoice")
    expect(sql).toContain("l.name = $2 COLLATE NOCASE")
    expect(sql).toContain("messages_fts MATCH $4")
    expect(params).toEqual(["acc-1", "receipts", "%/receipts", '"invoice"'])
  })

  it("appends parameters in ascending occurrence order", () => {
    const { sql, params } = build(
      "from:a to:b subject:c has:attachment is:unread label:d " +
        "longenough zq",
      "acc-9",
      25
    )
    // every $N in the SQL, in textual order, must be 1..N exactly
    const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((match) =>
      Number(match[1])
    )
    expect(placeholders).toEqual(
      Array.from({ length: params.length }, (_, index) => index + 1)
    )
    expect(params).toEqual([
      "acc-9", // account
      "%a%",
      "%a%", // from: address, name
      "%b%",
      "%b%",
      "%b%", // to: to/cc/bcc json
      "%c%", // subject:
      "d",
      "%/d", // label: exact, suffix
      '"longenough"', // free text ≥3 chars
      "%zq%",
      "%zq%",
      "%zq%",
      "%zq%",
      "%zq%",
      "%zq%", // free text <3 chars
      25, // limit
    ])
    expect(sql).toContain("LIMIT $" + params.length)
  })

  it("treats double quotes in the query as grouping syntax, not literals", () => {
    // the parser strips quotes from token values, so nothing FTS5-unsafe
    // reaches the MATCH string; toFtsMatch still doubles stray quotes as a
    // safety net (fts.ts unit semantics, exercised via the old db tests)
    expect(build('pizzazz"bar').params).toEqual(["acc-1", '"pizzazzbar"'])
  })

  it("returns the bare mailbox query for an empty parsed query", () => {
    // searchThreadsQuery short-circuits this case; the builder stays total
    const { sql, params } = build("")
    expect(sql).toContain("threads.account_id = $1")
    expect(sql).toContain("threads.is_trashed = 0")
    expect(params).toEqual(["acc-1"])
  })
})

describe("buildThreadSearchSql sort option (task 4.1)", () => {
  /** Same as build(), but with an explicit sort option. */
  function buildSorted(input: string, sort: ThreadSortOption) {
    const { sql, params } = buildThreadSearchSql(
      "acc-1",
      parseSearchQuery(input),
      { sort }
    )
    return { sql: sql.replace(/\s+/g, " ").trim(), params }
  }

  it("defaults to the date-desc order with the id tiebreaker", () => {
    const { sql } = build("pizzazz")
    expect(sql).toContain(
      "ORDER BY (threads.pinned_at IS NOT NULL) DESC, " +
        "threads.last_message_at DESC, threads.id ASC"
    )
  })

  it("maps each option to its fixed fragment after the pinned-first lead", () => {
    expect(buildSorted("pizzazz", "date_asc").sql).toContain(
      "ORDER BY (threads.pinned_at IS NOT NULL) DESC, " +
        "threads.last_message_at ASC, threads.id ASC"
    )
    expect(buildSorted("pizzazz", "sender").sql).toContain(
      "ORDER BY (threads.pinned_at IS NOT NULL) DESC, " +
        // threadSortOrderClause guards the extracts with json_valid: a bare
        // json_extract raises "malformed JSON" on a corrupt participants
        // cache row and would fail the whole query; valid rows keep the
        // COALESCE/NULLIF semantics (thread-sort.ts SENDER_TERM).
        "CASE WHEN threads.participants IS NOT NULL AND " +
        "json_valid(threads.participants) THEN " +
        "COALESCE(NULLIF(json_extract(threads.participants, '$[0].name'), ''), " +
        "json_extract(threads.participants, '$[0].email')) END " +
        "COLLATE NOCASE ASC NULLS LAST, " +
        "threads.last_message_at DESC, threads.id ASC"
    )
    expect(buildSorted("pizzazz", "subject").sql).toContain(
      "ORDER BY (threads.pinned_at IS NOT NULL) DESC, " +
        "threads.subject COLLATE NOCASE ASC NULLS LAST, " +
        "threads.last_message_at DESC, threads.id ASC"
    )
    expect(buildSorted("pizzazz", "unread_first").sql).toContain(
      "ORDER BY (threads.pinned_at IS NOT NULL) DESC, " +
        "(threads.unread_count > 0) DESC, threads.last_message_at DESC, threads.id ASC"
    )
  })

  it("search keeps the plain last_message_at date term (no delivered_at COALESCE)", () => {
    const { sql } = buildSorted("pizzazz", "date_desc")
    expect(sql).not.toContain("delivered_at")
  })

  it("the sort adds no bound parameters", () => {
    expect(buildSorted("pizzazz", "sender").params).toEqual(
      build("pizzazz").params
    )
  })
})

describe("buildThreadSearchSql account sets (task 9.1)", () => {
  /** Same as build(), but over an account-id set. */
  function buildFor(accountIds: string[], input: string, limit?: number) {
    const { sql, params } = buildThreadSearchSql(
      accountIds,
      parseSearchQuery(input),
      limit === undefined ? undefined : { limit }
    )
    return { sql: sql.replace(/\s+/g, " ").trim(), params }
  }

  it("renders an IN clause over the account set instead of = $1", () => {
    const { sql, params } = buildFor(["acc-1", "acc-2"], "from:alice")
    expect(sql).toContain("threads.account_id IN ($1, $2)")
    expect(sql).not.toContain("threads.account_id = $1")
    // ids bound first, then the operator patterns — unchanged order
    expect(params).toEqual(["acc-1", "acc-2", "%alice%", "%alice%"])
  })

  it("keeps trash/spam exclusions and the pinned-first sort for sets", () => {
    const { sql } = buildFor(["acc-1", "acc-2"], "pizzazz")
    expect(sql).toContain("threads.is_trashed = 0")
    expect(sql).toContain("threads.is_spam = 0")
    expect(sql).toContain(
      "ORDER BY (threads.pinned_at IS NOT NULL) DESC, threads.last_message_at DESC, threads.id ASC"
    )
  })

  it("numbers every placeholder ascending across set + operators + limit", () => {
    const { sql, params } = buildFor(
      ["acc-3", "acc-1", "acc-2"],
      "from:a label:d longenough",
      25
    )
    const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((match) =>
      Number(match[1])
    )
    expect(placeholders).toEqual(
      Array.from({ length: params.length }, (_, index) => index + 1)
    )
    expect(params).toEqual([
      "acc-3",
      "acc-1",
      "acc-2", // the account set
      "%a%",
      "%a%", // from:
      "d",
      "%/d", // label:
      '"longenough"', // free text
      25, // limit — one bound, applied after the merged ordering
    ])
    expect(sql).toContain("LIMIT $" + params.length)
  })

  it("renders a no-match predicate for an empty account set", () => {
    const { sql, params } = buildFor([], "from:alice")
    expect(sql).toContain("WHERE 1 = 0 AND")
    expect(sql).not.toContain("account_id IN")
    expect(params).toEqual(["%alice%", "%alice%"])
  })

  it("is the byte-identical single-account shape for a one-element set", () => {
    const setSql = buildFor(["acc-1"], "pizzazz").sql
    const singleSql = build("pizzazz").sql
    expect(setSql).toBe(singleSql.replace("= $1", "IN ($1)"))
  })
})

describe("buildThreadSearchSql countOnly option (task 11.4)", () => {
  /** Same as build(), but with the count-only projection. */
  function buildCount(input: string, accountId = "acc-1") {
    const { sql, params } = buildThreadSearchSql(
      accountId,
      parseSearchQuery(input),
      { countOnly: true }
    )
    return { sql: sql.replace(/\s+/g, " ").trim(), params }
  }

  it("swaps the select list for COUNT(*) and drops ORDER BY and LIMIT", () => {
    const { sql, params } = buildCount("from:alice pizzazz")
    expect(sql).toContain("SELECT COUNT(*) AS count FROM threads")
    expect(sql).not.toContain("threads.*")
    expect(sql).not.toContain("ORDER BY")
    expect(sql).not.toContain("LIMIT")
    // the WHERE keeps every predicate…
    expect(sql).toContain("threads.account_id = $1")
    expect(sql).toContain("threads.is_trashed = 0")
    expect(sql).toContain("threads.is_spam = 0")
    expect(sql).toContain("m.from_address COLLATE NOCASE LIKE $2")
    expect(sql).toContain("messages_fts MATCH $4")
    // …with the identical parameter list as the plain build.
    expect(params).toEqual(build("from:alice pizzazz").params)
  })

  it("ignores the limit option while counting (the count is the total)", () => {
    const { sql, params } = buildThreadSearchSql(
      "acc-1",
      parseSearchQuery("pizzazz"),
      { countOnly: true, limit: 25 }
    )
    expect(sql).not.toContain("LIMIT")
    expect(params).toEqual(["acc-1", '"pizzazz"'])
  })

  it("counts exactly the rows the plain query returns (real executor)", async () => {
    const { createTestExecutor } =
      await import("../../db/__tests__/test-executor")
    const { createAccount, createThread, createMessage } =
      await import("../../db/__tests__/fixtures")
    const executor = createTestExecutor()
    try {
      const accountId = await createAccount(executor, "gmail")
      for (const subject of [
        "Roadmap draft",
        "Roadmap follow-up",
        "Roadmap notes",
        "Lunch",
      ]) {
        const threadId = await createThread(executor, accountId, { subject })
        await createMessage(executor, {
          threadId,
          accountId,
          date: 1000,
          subject,
          snippet: subject,
          fromAddress: "boss@work.com",
        })
      }
      const parsed = parseSearchQuery("roadmap")
      const page = buildThreadSearchSql(accountId, parsed, { limit: 2 })
      const counted = buildThreadSearchSql(accountId, parsed, {
        countOnly: true,
      })
      // The page query is capped at 2 rows, but the count reports the
      // TOTAL (3) — no LIMIT may leak into the count build.
      expect((await executor.select(page.sql, page.params)).length).toBe(2)
      const rows = await executor.select<{ count: number }>(
        counted.sql,
        counted.params
      )
      expect(rows[0]?.count).toBe(3)
    } finally {
      executor.close()
    }
  })
})
