import { describe, expect, it } from "vitest"

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
    expect(sql).toContain("ORDER BY threads.last_message_at DESC")
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
