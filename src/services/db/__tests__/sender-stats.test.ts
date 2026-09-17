import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount } from "./fixtures"
import { createTestExecutor, type TestExecutor } from "./test-executor"
import {
  getSenderStat,
  listSenderStats,
  setUserSenderClass,
  upsertSenderStat,
  type SenderStatRow,
} from "../sender-stats"

/**
 * Sender-stats db layer (task 13.1/13.2, design D5/D7): the accumulating
 * upsert the ingestion hook feeds (counts add, recency keeps the max,
 * the list marker ORs, overrides untouched) plus the per-sender override
 * setter the priority view defers to.
 */

describe("sender stats", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
  })

  afterEach(() => {
    executor.close()
  })

  async function statRow(sender: string): Promise<SenderStatRow | null> {
    return getSenderStat(executor, accountId, sender)
  }

  it("creates a row on first sight and accumulates counts on repeats", async () => {
    await upsertSenderStat(executor, accountId, "Alice@Example.com", {
      isReply: true,
      date: 1000,
    })
    await upsertSenderStat(executor, accountId, "alice@example.com", {
      isDirectToMe: true,
      date: 2000,
    })
    await upsertSenderStat(executor, accountId, "ALICE@example.com", {
      date: 1500, // an older backfilled message must not rewind recency
    })

    const row = await statRow("alice@example.com")
    expect(row).toMatchObject({
      sender: "alice@example.com", // canonical lowercased key
      reply_count: 1,
      direct_to_me_count: 1,
      last_message_at: 2000, // MAX, not the last write
      is_mailing_list: 0,
      user_class: null,
    })
    // Case-insensitive identity: one row total for the account.
    expect(await listSenderStats(executor, [accountId])).toHaveLength(1)
  })

  it("OR-accumulates the mailing-list marker and keeps senders isolated", async () => {
    await upsertSenderStat(executor, accountId, "news@list.dev", {
      isMailingList: true,
      date: 100,
    })
    await upsertSenderStat(executor, accountId, "news@list.dev", {
      date: 200,
    })
    await upsertSenderStat(executor, accountId, "peer@work.dev", {
      date: 300,
    })

    expect(await statRow("news@list.dev")).toMatchObject({
      is_mailing_list: 1,
      reply_count: 0,
    })
    expect(await statRow("peer@work.dev")).toMatchObject({
      is_mailing_list: 0,
      last_message_at: 300,
    })
    expect(await listSenderStats(executor, [accountId])).toHaveLength(2)
  })

  it("scopes rows per account", async () => {
    const otherAccount = await createAccount(executor, "imap")
    await upsertSenderStat(executor, accountId, "shared@x.com", { date: 100 })
    await upsertSenderStat(executor, otherAccount, "shared@x.com", {
      date: 200,
    })

    expect(
      await getSenderStat(executor, accountId, "shared@x.com")
    ).toMatchObject({ account_id: accountId, last_message_at: 100 })
    expect(
      await getSenderStat(executor, otherAccount, "shared@x.com")
    ).toMatchObject({ account_id: otherAccount, last_message_at: 200 })
    expect(await listSenderStats(executor, [accountId])).toHaveLength(1)
    // null / empty = every account
    expect(await listSenderStats(executor, null)).toHaveLength(2)
    expect(await listSenderStats(executor, [])).toHaveLength(2)
  })

  it("returns null for unknown or blank senders", async () => {
    expect(await getSenderStat(executor, accountId, "ghost@x.com")).toBeNull()
    expect(await getSenderStat(executor, accountId, "   ")).toBeNull()
  })

  it("skips blank senders on upsert instead of writing a junk row", async () => {
    await upsertSenderStat(executor, accountId, "", { date: 1 })
    await upsertSenderStat(executor, accountId, "   ", { date: 1 })
    expect(await listSenderStats(executor, null)).toHaveLength(0)
  })
})

describe("user sender class overrides (task 13.2)", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
  })

  afterEach(() => {
    executor.close()
  })

  it("sets, flips and clears the override on an existing stat row", async () => {
    await upsertSenderStat(executor, accountId, "bulk@x.com", {
      isMailingList: true,
      date: 1000,
    })

    await setUserSenderClass(executor, accountId, "BULK@x.com", "important")
    expect(
      await getSenderStat(executor, accountId, "bulk@x.com")
    ).toMatchObject(
      { user_class: "important", reply_count: 0 } // stats untouched
    )

    await setUserSenderClass(executor, accountId, "bulk@x.com", "other")
    expect(
      await getSenderStat(executor, accountId, "bulk@x.com")
    ).toMatchObject({ user_class: "other" })

    await setUserSenderClass(executor, accountId, "bulk@x.com", null)
    expect(
      await getSenderStat(executor, accountId, "bulk@x.com")
    ).toMatchObject({ user_class: null })
  })

  it("creates a zero-stat row when the user classifies an unseen sender", async () => {
    await setUserSenderClass(executor, accountId, "vip@x.com", "important")
    expect(await getSenderStat(executor, accountId, "vip@x.com")).toMatchObject(
      {
        sender: "vip@x.com",
        reply_count: 0,
        direct_to_me_count: 0,
        last_message_at: null,
        is_mailing_list: 0,
        user_class: "important",
      }
    )
  })

  it("is scoped per account and ignores blank senders", async () => {
    const otherAccount = await createAccount(executor, "imap")
    await setUserSenderClass(executor, accountId, "a@x.com", "important")
    expect(await getSenderStat(executor, otherAccount, "a@x.com")).toBeNull()

    await setUserSenderClass(executor, accountId, "  ", "important")
    expect(await listSenderStats(executor, null)).toHaveLength(1)
  })
})
