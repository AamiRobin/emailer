import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createAccount,
  createGmailLabel,
  createMessage,
  createThread,
} from "./fixtures"
import { createTestExecutor, type TestExecutor } from "./test-executor"
import { getAccount } from "../accounts"
import type { ContactRef } from "../messages"
import { countNudges, listNudges } from "../nudges"
import { recomputeThreadCaches, setThreadLabels } from "../threads"

/**
 * The nudges detection query (task 14.1, design D8 — "nudges are a
 * query"): every clause of db/nudges.ts exercised at the DB level,
 * including the spec's named cases — the forgotten direct question,
 * already-replied, too recent — plus the threshold boundary, the
 * addressing/mention requirement, the exclusion set and the
 * across-accounts scoping.
 */

const DAY = 24 * 60 * 60
const NOW = 1_750_000_000

describe("nudges detection query", () => {
  let executor: TestExecutor
  let accountId: string
  let accountEmail: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
    accountEmail = (await getAccount(executor, accountId))!.email
  })

  afterEach(() => {
    executor.close()
  })

  /** A thread whose LATEST message is seeded per the options; caches are
   * recomputed like the sync engines leave them. */
  async function seedThread(options: {
    /** Unix seconds of the newest message. */
    date: number
    from?: string
    to?: ContactRef[]
    cc?: ContactRef[]
    bodyText?: string
    subject?: string
    state?: "muted" | "done" | "snoozed" | "held" | "trashed" | "spam"
    archived?: boolean
    pinned?: boolean
  }): Promise<string> {
    const threadId = await createThread(executor, accountId, {
      subject: options.subject,
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: options.date,
      fromAddress: options.from ?? "alice@example.com",
      to: options.to ?? [{ email: accountEmail }],
      bodyText: options.bodyText,
      snippet: options.bodyText,
      subject: options.subject,
    })
    // The fixtures have no cc option; write the Cc contacts directly.
    if (options.cc) {
      await executor.execute(
        "UPDATE messages SET cc_json = $1 WHERE thread_id = $2",
        [JSON.stringify(options.cc), threadId]
      )
    }
    await recomputeThreadCaches(executor, threadId)
    const sets: string[] = []
    const values: unknown[] = []
    if (options.state === "muted") {
      sets.push("muted_at = ?")
      values.push(NOW)
    }
    if (options.state === "done") {
      sets.push("done_at = ?")
      values.push(NOW)
    }
    if (options.state === "snoozed") {
      sets.push("snoozed_until = ?")
      values.push(NOW)
    }
    if (options.state === "held") {
      sets.push("held_until = ?")
      values.push(NOW + DAY)
    }
    if (options.state === "trashed") sets.push("is_trashed = 1")
    if (options.state === "spam") sets.push("is_spam = 1")
    if (options.archived) sets.push("is_archived = 1")
    if (options.pinned) {
      sets.push("pinned_at = ?")
      values.push(NOW)
    }
    if (sets.length > 0) {
      await executor.execute(
        `UPDATE threads SET ${sets.join(", ")} WHERE id = ?`,
        [...values, threadId]
      )
    }
    return threadId
  }

  function list(options?: {
    thresholdDays?: number
    accountIds?: string[] | null
  }) {
    return listNudges(executor, {
      now: NOW,
      thresholdDays: options?.thresholdDays ?? 3,
      ...(options?.accountIds !== undefined
        ? { accountIds: options.accountIds }
        : {}),
    })
  }

  it("detects the forgotten direct question (spec scenario): addressed, unanswered, past the threshold", async () => {
    const threadId = await seedThread({
      date: NOW - 5 * DAY,
      from: "alice@example.com",
      to: [{ email: accountEmail }],
      bodyText: "Can you send the report by Friday?",
    })
    const nudges = await list()
    expect(nudges.map((row) => row.id)).toEqual([threadId])
    expect(nudges[0]?.has_question).toBe(1)
    expect(await countNudges(executor, { now: NOW, thresholdDays: 3 })).toBe(1)
  })

  it("excludes already-replied threads: the user sent the latest message", async () => {
    // The account's own address is the newest sender — nothing is awaited
    // FROM the user anymore (follow-up reminders own that direction).
    await seedThread({
      date: NOW - 5 * DAY,
      from: accountEmail,
      to: [{ email: "alice@example.com" }],
      bodyText: "Done, sent it over.",
    })
    expect(await list()).toEqual([])
    expect(await countNudges(executor, { now: NOW, thresholdDays: 3 })).toBe(0)
  })

  it("excludes too-recent threads: within the threshold is not a nudge", async () => {
    await seedThread({
      date: NOW - 2 * DAY,
      bodyText: "Any update? Please advise soon.",
    })
    expect(await list({ thresholdDays: 3 })).toEqual([])
  })

  it("the threshold is strict: exactly N days old is NOT a nudge, one second older is", async () => {
    // At the boundary (last_message_at == now - N days): not "older than".
    await seedThread({ date: NOW - 3 * DAY, bodyText: "Boundary question?" })
    const pastBoundary = await seedThread({
      date: NOW - 3 * DAY - 1,
      bodyText: "One second too old to ignore?",
    })
    expect((await list({ thresholdDays: 3 })).map((row) => row.id)).toEqual([
      pastBoundary,
    ])
  })

  it("requires addressing: not addressed and not mentioned is out, a body mention is in, Cc counts", async () => {
    // To someone else entirely, no mention → not a nudge.
    await seedThread({
      date: NOW - 5 * DAY,
      to: [{ email: "someoneelse@example.com" }],
      bodyText: "FYI, shipping tomorrow.",
    })
    expect(await list()).toEqual([])

    // Same shape but the body mentions the user's address → nudge.
    const mentioned = await seedThread({
      date: NOW - 5 * DAY,
      to: [{ email: "someoneelse@example.com" }],
      bodyText: `Looping in ${accountEmail} here — can you confirm?`,
    })
    expect((await list()).map((row) => row.id)).toEqual([mentioned])

    // Cc-addressing counts as addressed. It ranks below "mentioned"
    // there: that body asks a question ("can you confirm?") and the
    // has-question lead ranks it first.
    const ccEd = await seedThread({
      date: NOW - 5 * DAY + 60,
      to: [{ email: "someoneelse@example.com" }],
      cc: [{ email: accountEmail }],
      bodyText: "Keeping you in the loop.",
    })
    expect((await list()).map((row) => row.id)).toEqual([mentioned, ccEd])
  })

  it("matching is case-insensitive against the account address", async () => {
    const threadId = await seedThread({
      date: NOW - 5 * DAY,
      to: [{ email: accountEmail.toUpperCase() }],
      bodyText: "Please review?",
    })
    expect((await list()).map((row) => row.id)).toEqual([threadId])
  })

  it("an address substring does not match: the To/Cc pattern is delimited", async () => {
    // The To JSON contains the account address as a SUBSTRING only
    // ("attacker-<address>") — the `"email":"…"`-delimited pattern must
    // not match it, and the body carries no mention either.
    await seedThread({
      date: NOW - 5 * DAY,
      to: [{ email: `attacker-${accountEmail}` }],
      bodyText: "Unrelated text with no mention.",
    })
    expect(await list()).toEqual([])
  })

  it("excludes snoozed, muted, Done, held, trashed and spam threads", async () => {
    for (const state of [
      "muted",
      "done",
      "snoozed",
      "held",
      "trashed",
      "spam",
    ] as const) {
      await seedThread({
        date: NOW - 5 * DAY,
        bodyText: "Still on for tomorrow?",
        state,
      })
    }
    expect(await list()).toEqual([])
  })

  it("archived threads still nudge (an archived conversation can still await a reply)", async () => {
    const threadId = await seedThread({
      date: NOW - 5 * DAY,
      bodyText: "Did you see my note below?",
      archived: true,
    })
    expect((await list()).map((row) => row.id)).toEqual([threadId])
  })

  it("question threads rank first, then pinned, then recency", async () => {
    const question = await seedThread({
      date: NOW - 9 * DAY,
      bodyText: "Could you look at this today?",
    })
    const recentPlain = await seedThread({
      date: NOW - 4 * DAY,
      bodyText: "A statement of your account.",
    })
    const pinnedPlain = await seedThread({
      date: NOW - 8 * DAY,
      bodyText: "Meeting notes attached.",
      pinned: true,
    })
    expect((await list()).map((row) => row.id)).toEqual([
      question, // the has-question lead
      pinnedPlain, // then the pinned-first term
      recentPlain, // then the date-desc sort
    ])
  })

  it("a resurfaced thread (delivered_at set) tops the list, like the inbox orders it", async () => {
    const newer = await seedThread({
      date: NOW - 4 * DAY,
      bodyText: "A plain statement.",
    })
    // A follow-up reminder resurfacing an OLD conversation: delivered_at
    // stamped recently while last_message_at stays days old.
    const resurfaced = await seedThread({
      date: NOW - 9 * DAY,
      bodyText: "Still waiting on this one.",
    })
    await executor.execute(
      "UPDATE threads SET delivered_at = $1 WHERE id = $2",
      [NOW - 60, resurfaced]
    )

    // The delivered_at COALESCE (the inbox's date term) puts the
    // resurfaced thread first even though its last_message_at is older;
    // a plain last_message_at sort would get this backwards.
    const rows = await list()
    expect(rows.map((row) => row.id)).toEqual([resurfaced, newer])
  })

  it("scopes to the given accounts; null lists every account", async () => {
    const otherAccount = await createAccount(executor, "imap")
    const otherEmail = (await getAccount(executor, otherAccount))!.email
    const inbox = await createGmailLabel(
      executor,
      otherAccount,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const otherThread = await createThread(executor, otherAccount)
    await createMessage(executor, {
      threadId: otherThread,
      accountId: otherAccount,
      date: NOW - 5 * DAY,
      fromAddress: "bob@example.com",
      to: [{ email: otherEmail }],
      bodyText: "Did this land?",
    })
    await recomputeThreadCaches(executor, otherThread)
    await setThreadLabels(executor, otherThread, [inbox])

    const ownThread = await seedThread({ date: NOW - 6 * DAY })

    const all = await list({ accountIds: null })
    expect(all.map((row) => row.id).sort()).toEqual(
      [ownThread, otherThread].sort()
    )
    expect(
      (await list({ accountIds: [accountId] })).map((row) => row.id)
    ).toEqual([ownThread])
    // The row carries the account identity the across-accounts view and
    // the detection matched against.
    expect(all.find((row) => row.id === otherThread)?.account_email).toBe(
      otherEmail
    )
  })

  it("counts agree with the list (the sidebar marker reads the same detection)", async () => {
    await seedThread({ date: NOW - 5 * DAY, bodyText: "Yes or no?" })
    await seedThread({ date: NOW - 4 * DAY, bodyText: "A plain reminder." })
    await seedThread({ date: NOW - 1 * DAY, bodyText: "Too recent?" })
    expect(await countNudges(executor, { now: NOW, thresholdDays: 3 })).toBe(2)
    expect(await list()).toHaveLength(2)
  })
})
