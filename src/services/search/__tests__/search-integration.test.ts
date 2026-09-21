import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { addDays } from "date-fns"

import {
  countThreadsForQuery,
  searchThreadsWithRelaxedFallback,
  searchThreadsAcrossAccounts,
  searchThreadsQuery,
} from "../index"
import {
  recomputeThreadCaches,
  setThreadLabels,
  setThreadStarred,
} from "../../db/threads"
import { pinThread } from "../../email-actions/thread-states"
import {
  at,
  BASE_TIME,
  createAccount,
  createGmailLabel,
  createMessage,
  createThread,
} from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"

describe("searchThreadsQuery", () => {
  let executor: TestExecutor
  let accountId: string

  /** Seed a thread + one message and rebuild the thread caches. */
  async function seed(options: {
    accountId?: string
    subject?: string
    fromName?: string
    fromAddress?: string
    to?: { name?: string; email: string }[]
    bodyText?: string
    date: number
    isRead?: boolean
    hasAttachments?: boolean
  }): Promise<string> {
    const threadAccountId = options.accountId ?? accountId
    const threadId = await createThread(executor, threadAccountId, {
      subject: options.subject,
    })
    await createMessage(executor, {
      threadId,
      accountId: threadAccountId,
      date: options.date,
      subject: options.subject,
      fromName: options.fromName,
      fromAddress: options.fromAddress,
      to: options.to,
      bodyText: options.bodyText,
      snippet: options.bodyText?.slice(0, 40),
      isRead: options.isRead,
      hasAttachments: options.hasAttachments,
    })
    await recomputeThreadCaches(executor, threadId)
    return threadId
  }

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
  })

  afterEach(() => {
    executor.close()
  })

  describe("spec scenario: combined operators", () => {
    beforeEach(async () => {
      // matches: from alice, attachment, unread
      await seed({
        subject: "Blueprint attached",
        fromName: "Alice Wonderland",
        fromAddress: "alice@wonderland.example",
        bodyText: "The blueprint is attached.",
        date: at(100),
        hasAttachments: true,
      })
      // read → not unread
      await seed({
        subject: "Blueprint attached (read)",
        fromName: "Alice Wonderland",
        fromAddress: "alice@wonderland.example",
        bodyText: "Read copy of the blueprint.",
        date: at(200),
        isRead: true,
        hasAttachments: true,
      })
      // wrong sender
      await seed({
        subject: "Blueprint attached (bob)",
        fromName: "Bob Sample",
        fromAddress: "bob@corp.example",
        bodyText: "Bob's blueprint.",
        date: at(300),
        hasAttachments: true,
      })
      // no attachment
      await seed({
        subject: "Blueprint inline",
        fromName: "Alice Wonderland",
        fromAddress: "alice@wonderland.example",
        bodyText: "Blueprint pasted inline.",
        date: at(400),
      })
    })

    it("returns only unread threads from alice with attachments", async () => {
      const hits = await searchThreadsQuery(
        executor,
        accountId,
        "from:alice has:attachment is:unread"
      )
      expect(hits.map((thread) => thread.subject)).toEqual([
        "Blueprint attached",
      ])
      expect(hits[0]!.has_attachments).toBe(1)
      expect(hits[0]!.unread_count).toBeGreaterThan(0)
    })
  })

  describe("spec scenario: label operator", () => {
    let receiptsThread: string
    let nestedThread: string
    let unlabelledInvoiceThread: string
    let nonInvoiceThread: string

    beforeEach(async () => {
      const receiptsId = await createGmailLabel(
        executor,
        accountId,
        "receipts",
        "g-receipts",
        undefined,
        "user"
      )
      const nestedId = await createGmailLabel(
        executor,
        accountId,
        "Finance/receipts",
        "g-finance-receipts",
        undefined,
        "user"
      )

      receiptsThread = await seed({
        subject: "Your receipt",
        fromName: "Shop",
        fromAddress: "shop@store.example",
        bodyText: "Invoice 42 for your order.",
        date: at(100),
      })
      await setThreadLabels(executor, receiptsThread, [receiptsId])

      nestedThread = await seed({
        subject: "Finance receipt",
        fromName: "Finance",
        fromAddress: "finance@corp.example",
        bodyText: "Invoice 43 for the retainer.",
        date: at(200),
      })
      await setThreadLabels(executor, nestedThread, [nestedId])

      unlabelledInvoiceThread = await seed({
        subject: "Unlabelled invoice",
        fromName: "Shop",
        fromAddress: "shop@store.example",
        bodyText: "Invoice 44, no label.",
        date: at(300),
      })
      nonInvoiceThread = await seed({
        subject: "Labelled but unrelated",
        fromName: "Shop",
        fromAddress: "shop@store.example",
        bodyText: "A newsletter, labelled receipts.",
        date: at(400),
      })
      await setThreadLabels(executor, nonInvoiceThread, [receiptsId])
    })

    it("matches label:receipts AND the free-text term", async () => {
      const hits = await searchThreadsQuery(
        executor,
        accountId,
        "label:receipts invoice"
      )
      expect(hits.map((thread) => thread.id)).toEqual([
        nestedThread,
        receiptsThread,
      ])
    })

    it("matches label:receipts alone through both accounts' threads", async () => {
      const hits = await searchThreadsQuery(
        executor,
        accountId,
        "label:receipts"
      )
      expect(hits.map((thread) => thread.id)).toEqual([
        nonInvoiceThread,
        nestedThread,
        receiptsThread,
      ])
    })

    it("never matches the unlabelled invoice thread", async () => {
      const hits = await searchThreadsQuery(
        executor,
        accountId,
        "label:receipts invoice"
      )
      expect(hits.map((thread) => thread.id)).not.toContain(
        unlabelledInvoiceThread
      )
    })

    it("is scoped to the account — another account's receipts label leaks nothing", async () => {
      const otherAccount = await createAccount(executor, "gmail")
      const otherLabelId = await createGmailLabel(
        executor,
        otherAccount,
        "receipts",
        "g-other-receipts",
        undefined,
        "user"
      )
      const foreignThread = await seed({
        accountId: otherAccount,
        subject: "Foreign receipt",
        fromName: "Elsewhere",
        fromAddress: "elsewhere@other.example",
        bodyText: "Invoice 45 from the other account.",
        date: at(500),
      })
      await setThreadLabels(executor, foreignThread, [otherLabelId])

      const hits = await searchThreadsQuery(
        executor,
        accountId,
        "label:receipts invoice"
      )
      expect(hits.map((thread) => thread.id)).toEqual([
        nestedThread,
        receiptsThread,
      ])
      expect(hits.every((thread) => thread.account_id === accountId)).toBe(true)
    })
  })

  it("matches quoted multi-word from: values", async () => {
    const aliceThread = await seed({
      subject: "Hello",
      fromName: "Alice Wonderland",
      fromAddress: "alice@wonderland.example",
      bodyText: "Hi.",
      date: at(100),
    })
    await seed({
      subject: "Other",
      fromName: "Alice Boring",
      fromAddress: "boring@corp.example",
      bodyText: "Ho.",
      date: at(200),
    })

    const hits = await searchThreadsQuery(
      executor,
      accountId,
      'from:"Alice Wonderland"'
    )
    expect(hits.map((thread) => thread.id)).toEqual([aliceThread])
  })

  it("matches quoted multi-word subject: values", async () => {
    const reportThread = await seed({
      subject: "Annual report 2026",
      fromName: "Biz",
      fromAddress: "biz@corp.example",
      bodyText: "Numbers.",
      date: at(100),
    })
    await seed({
      subject: "Report annualized",
      fromName: "Biz",
      fromAddress: "biz@corp.example",
      bodyText: "Different.",
      date: at(200),
    })

    const hits = await searchThreadsQuery(
      executor,
      accountId,
      'subject:"annual report"'
    )
    expect(hits.map((thread) => thread.id)).toEqual([reportThread])
  })

  it("matches to: through to_json, cc_json and bcc_json", async () => {
    const toThread = await seed({
      subject: "Direct",
      fromAddress: "biz@corp.example",
      to: [{ name: "Bob Sample", email: "bob@corp.example" }],
      bodyText: "One.",
      date: at(100),
    })
    const ccThread = await seed({
      subject: "Cc'd",
      fromAddress: "biz@corp.example",
      to: [{ email: "someone@corp.example" }],
      bodyText: "Two.",
      date: at(200),
    })
    const bccThread = await seed({
      subject: "Bcc'd",
      fromAddress: "biz@corp.example",
      bodyText: "Three.",
      date: at(300),
    })
    // fixtures don't seed cc/bcc; write the json columns directly
    const ccRows = await executor.select<{ id: string }>(
      "SELECT id FROM messages WHERE thread_id = $1",
      [ccThread]
    )
    await executor.execute("UPDATE messages SET cc_json = $1 WHERE id = $2", [
      JSON.stringify([{ name: "Carol Chen", email: "carol@corp.example" }]),
      ccRows[0]!.id,
    ])
    const bccRows = await executor.select<{ id: string }>(
      "SELECT id FROM messages WHERE thread_id = $1",
      [bccThread]
    )
    await executor.execute("UPDATE messages SET bcc_json = $1 WHERE id = $2", [
      JSON.stringify([{ email: "dave@corp.example" }]),
      bccRows[0]!.id,
    ])

    expect(
      (await searchThreadsQuery(executor, accountId, "to:bob")).map(
        (thread) => thread.id
      )
    ).toEqual([toThread])
    expect(
      (await searchThreadsQuery(executor, accountId, "to:carol")).map(
        (thread) => thread.id
      )
    ).toEqual([ccThread])
    expect(
      (
        await searchThreadsQuery(executor, accountId, "to:dave@corp.example")
      ).map((thread) => thread.id)
    ).toEqual([bccThread])
  })

  it("finds threads by body text through the FTS index", async () => {
    const bodyThread = await seed({
      subject: "Lunch on Friday",
      fromName: "Bob Sample",
      fromAddress: "bob@corp.example",
      bodyText: "Pizzazz tonight? Snapshot enclosed.",
      date: at(100),
    })
    await seed({
      subject: "Unrelated",
      fromName: "Alice",
      fromAddress: "alice@corp.example",
      bodyText: "Nothing to see.",
      date: at(200),
    })

    // "pizzazz" appears only in body_text — reachable only via FTS
    expect(
      (await searchThreadsQuery(executor, accountId, "pizzazz")).map(
        (thread) => thread.id
      )
    ).toEqual([bodyThread])
    // case-insensitive trigram substring
    expect(
      (await searchThreadsQuery(executor, accountId, "PIZZAZ")).map(
        (thread) => thread.id
      )
    ).toEqual([bodyThread])
  })

  it("falls back to a LIKE scan for terms shorter than 3 chars", async () => {
    const zzThread = await seed({
      subject: "Lunch on Friday",
      fromName: "Bob Sample",
      fromAddress: "bob@corp.example",
      bodyText: "Pizzazz tonight.",
      date: at(100),
    })

    // "zz" cannot produce a trigram token; the LIKE fallback must find it
    expect(
      (await searchThreadsQuery(executor, accountId, "zz")).map(
        (thread) => thread.id
      )
    ).toEqual([zzThread])
    expect(await searchThreadsQuery(executor, accountId, "qq")).toEqual([])
  })

  it("excludes trashed and spammed threads from the mailbox search", async () => {
    const liveThread = await seed({
      subject: "Quarterly numbers",
      fromName: "Biz",
      fromAddress: "biz@corp.example",
      bodyText: "Roadmap numbers attached.",
      date: at(100),
    })
    const trashedThread = await seed({
      subject: "Quarterly numbers (trashed)",
      fromName: "Biz",
      fromAddress: "biz@corp.example",
      bodyText: "Roadmap numbers, trashed.",
      date: at(200),
    })
    const spamThread = await seed({
      subject: "Quarterly numbers (spam)",
      fromName: "Spammer",
      fromAddress: "spam@spam.example",
      bodyText: "Roadmap numbers, spammy.",
      date: at(300),
    })
    const trashLabelId = await createGmailLabel(
      executor,
      accountId,
      "TRASH",
      "g-trash",
      "trash"
    )
    const spamLabelId = await createGmailLabel(
      executor,
      accountId,
      "SPAM",
      "g-spam",
      "spam"
    )
    await setThreadLabels(executor, trashedThread, [trashLabelId])
    await setThreadLabels(executor, spamThread, [spamLabelId])

    expect(
      (await searchThreadsQuery(executor, accountId, "roadmap")).map(
        (thread) => thread.id
      )
    ).toEqual([liveThread])
    // even when the match would come from an operator instead of FTS
    expect(
      (await searchThreadsQuery(executor, accountId, "from:biz")).map(
        (thread) => thread.id
      )
    ).toEqual([liveThread])
  })

  it("returns is:starred threads only", async () => {
    const starredThread = await seed({
      subject: "Starred roadmap",
      fromName: "Biz",
      fromAddress: "biz@corp.example",
      bodyText: "Roadmap.",
      date: at(100),
    })
    await seed({
      subject: "Plain roadmap",
      fromName: "Biz",
      fromAddress: "biz@corp.example",
      bodyText: "Roadmap.",
      date: at(200),
    })
    await setThreadStarred(executor, starredThread)

    expect(
      (await searchThreadsQuery(executor, accountId, "is:starred")).map(
        (thread) => thread.id
      )
    ).toEqual([starredThread])
    expect(
      (await searchThreadsQuery(executor, accountId, "is:starred roadmap")).map(
        (thread) => thread.id
      )
    ).toEqual([starredThread])
  })

  it("never leaks another account's threads, even with identical content", async () => {
    await seed({
      subject: "Quarterly planning",
      fromName: "Alice Wonderland",
      fromAddress: "alice@wonderland.example",
      bodyText: "roadmap",
      date: at(100),
    })
    const otherAccount = await createAccount(executor, "gmail")
    await seed({
      accountId: otherAccount,
      subject: "Quarterly planning",
      fromName: "Alice Wonderland",
      fromAddress: "alice@wonderland.example",
      bodyText: "roadmap",
      date: at(9000),
    })

    for (const query of [
      "roadmap",
      "from:alice",
      "to:nothing",
      "from:alice roadmap",
    ]) {
      const hits = await searchThreadsQuery(executor, accountId, query)
      expect(hits.every((thread) => thread.account_id === accountId)).toBe(true)
    }
  })

  it("orders by last_message_at DESC and honors limit", async () => {
    for (const offset of [100, 200, 300]) {
      await seed({
        subject: `Roadmap part ${offset}`,
        fromName: "Biz",
        fromAddress: "biz@corp.example",
        bodyText: `Roadmap chapter ${offset}.`,
        date: at(offset),
      })
    }
    const hits = await searchThreadsQuery(executor, accountId, "roadmap")
    expect(hits.map((thread) => thread.last_message_at)).toEqual([
      at(300),
      at(200),
      at(100),
    ])

    const limited = await searchThreadsQuery(executor, accountId, "roadmap", {
      limit: 2,
    })
    expect(limited.map((thread) => thread.last_message_at)).toEqual([
      at(300),
      at(200),
    ])
  })

  it("returns [] for empty, whitespace, or term-less input", async () => {
    await seed({
      subject: "Anything",
      fromAddress: "biz@corp.example",
      bodyText: "content",
      date: at(100),
    })
    expect(await searchThreadsQuery(executor, accountId, "")).toEqual([])
    expect(await searchThreadsQuery(executor, accountId, "   ")).toEqual([])
    expect(await searchThreadsQuery(executor, accountId, "from:")).toEqual([])
  })

  it("runs a negation-only query against everything in scope", async () => {
    const kept = await seed({
      subject: "Real mail",
      fromAddress: "biz@corp.example",
      bodyText: "content",
      date: at(100),
    })
    await seed({
      subject: "Newsletter",
      fromAddress: "news@letters.example",
      bodyText: "content",
      date: at(101),
    })
    // a negation-only query is NOT empty: it must run, not short-circuit
    const hits = await searchThreadsQuery(executor, accountId, "-from:news@")
    expect(hits.map((thread) => thread.id)).toEqual([kept])
    // and it composes with positive terms as usual
    const none = await searchThreadsQuery(
      executor,
      accountId,
      "-from:biz@ real"
    )
    expect(none).toEqual([])
  })

  it("matches larger:/smaller: against message sizes", async () => {
    const big = await seed({
      subject: "Big attachment",
      fromAddress: "files@corp.example",
      date: at(100),
      hasAttachments: true,
    })
    const tiny = await seed({
      subject: "Tiny note",
      fromAddress: "files@corp.example",
      date: at(101),
    })
    // give both messages a size_estimate directly (createMessage leaves
    // it NULL, and NULL satisfies neither size operator)
    const sized = await executor.select<{ id: string; thread_id: string }>(
      "SELECT id, thread_id FROM messages WHERE thread_id IN ($1, $2)",
      [big, tiny]
    )
    for (const row of sized) {
      await executor.execute(
        "UPDATE messages SET size_estimate = $1 WHERE id = $2",
        [row.thread_id === big ? 20 * 1024 * 1024 : 500, row.id]
      )
    }
    const large = await searchThreadsQuery(executor, accountId, "larger:10m")
    expect(large.map((thread) => thread.id)).toEqual([big])
    const small = await searchThreadsQuery(executor, accountId, "smaller:1m")
    expect(small.map((thread) => thread.id)).toEqual([tiny])
  })

  it("matches before:/after: date windows around UTC midnight", async () => {
    const june = await seed({
      subject: "June report",
      fromAddress: "reports@corp.example",
      date: at(Date.UTC(2025, 5, 15) / 1000 - BASE_TIME),
    })
    await seed({
      subject: "March report",
      fromAddress: "reports@corp.example",
      date: at(Date.UTC(2025, 2, 1) / 1000 - BASE_TIME),
    })
    const window = await searchThreadsQuery(
      executor,
      accountId,
      "after:2025-04-01 before:2025-07-01"
    )
    expect(window.map((thread) => thread.id)).toEqual([june])
    // the boundary day itself: after: includes it, before: does not
    const onDay = await searchThreadsQuery(
      executor,
      accountId,
      "after:2025-06-15"
    )
    expect(onDay.map((thread) => thread.id)).toEqual([june])
    const beforeDay = await searchThreadsQuery(
      executor,
      accountId,
      "before:2025-06-15"
    )
    expect(beforeDay.map((thread) => thread.id)).not.toContain(june)
  })

  it("excludes threads on the wrong side of negated size/date bounds", async () => {
    const bigOld = await seed({
      subject: "Big old mail",
      fromAddress: "files@corp.example",
      date: at(Date.UTC(2025, 0, 15) / 1000 - BASE_TIME),
    })
    const smallNew = await seed({
      subject: "Small new mail",
      fromAddress: "files@corp.example",
      date: at(Date.UTC(2026, 0, 15) / 1000 - BASE_TIME),
    })
    // size_estimate directly (createMessage leaves it NULL — and NULL never
    // trips a size bound, which is also why both threads survive below)
    const sized = await executor.select<{ id: string; thread_id: string }>(
      "SELECT id, thread_id FROM messages WHERE thread_id IN ($1, $2)",
      [bigOld, smallNew]
    )
    for (const row of sized) {
      await executor.execute(
        "UPDATE messages SET size_estimate = $1 WHERE id = $2",
        [row.thread_id === bigOld ? 20 * 1024 * 1024 : 500, row.id]
      )
    }

    // the negated bound excludes exactly the offending thread
    const noBig = await searchThreadsQuery(executor, accountId, "-larger:10m")
    expect(noBig.map((thread) => thread.id)).toEqual([smallNew])
    const noSmall = await searchThreadsQuery(executor, accountId, "-smaller:1m")
    expect(noSmall.map((thread) => thread.id)).toEqual([bigOld])
    const notOld = await searchThreadsQuery(
      executor,
      accountId,
      "-before:2026-01-01"
    )
    expect(notOld.map((thread) => thread.id)).toEqual([smallNew])
    const notNew = await searchThreadsQuery(
      executor,
      accountId,
      "-after:2026-01-01"
    )
    expect(notNew.map((thread) => thread.id)).toEqual([bigOld])
  })
})

describe("searchThreadsQuery sort option (task 4.1)", () => {
  let executor: TestExecutor
  let accountId: string

  /** Seed a searchable thread with its own sender and date. */
  async function seedSorted(options: {
    subject: string
    fromName?: string
    fromAddress?: string
    date: number
  }): Promise<string> {
    const threadId = await createThread(executor, accountId, {
      subject: options.subject,
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: options.date,
      subject: options.subject,
      snippet: "s",
      bodyText: options.subject,
      fromName: options.fromName,
      fromAddress: options.fromAddress,
      isRead: true,
    })
    await recomputeThreadCaches(executor, threadId)
    return threadId
  }

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
  })

  afterEach(() => {
    executor.close()
  })

  it("sender sort applies to search results and pinned still leads", async () => {
    const zed = await seedSorted({
      subject: "roadmap zed",
      fromName: "Zed",
      fromAddress: "zed@x.com",
      date: at(300),
    })
    const alice = await seedSorted({
      subject: "roadmap alice",
      fromName: "alice",
      fromAddress: "alice@x.com",
      date: at(100),
    })
    const pinned = await seedSorted({
      subject: "roadmap pin",
      fromName: "martha",
      fromAddress: "martha@x.com",
      date: at(200),
    })
    await pinThread(executor, pinned)

    const hits = await searchThreadsQuery(executor, accountId, "roadmap", {
      sort: "sender",
    })
    // martha is pinned into first place regardless of its sender; the rest
    // order alice → zed (NOT date order, which would be zed first).
    expect(hits.map((thread) => thread.id)).toEqual([pinned, alice, zed])

    // Default stays date-desc (pinned-first still leads it).
    const byDate = await searchThreadsQuery(executor, accountId, "roadmap")
    expect(byDate.map((thread) => thread.id)).toEqual([pinned, zed, alice])
  })
})

describe("searchThreadsAcrossAccounts (task 9.1)", () => {
  let executor: TestExecutor
  let accountA: string
  let accountB: string

  /** Seed a matching thread + message on a specific account. */
  async function seed(
    accountId: string,
    subject: string,
    date: number
  ): Promise<string> {
    const threadId = await createThread(executor, accountId, { subject })
    await createMessage(executor, {
      threadId,
      accountId,
      date,
      subject,
      bodyText: "roadmap notes attached.",
      snippet: "roadmap notes attached.",
      fromName: "Biz",
      fromAddress: "biz@corp.example",
    })
    await recomputeThreadCaches(executor, threadId)
    return threadId
  }

  beforeEach(async () => {
    executor = createTestExecutor()
    accountA = await createAccount(executor, "gmail")
    accountB = await createAccount(executor, "imap")
  })

  afterEach(() => {
    executor.close()
  })

  it("merges matches from every account in the set, sorted across the merge", async () => {
    const olderA = await seed(accountA, "A roadmap", at(100))
    const newerB = await seed(accountB, "B roadmap", at(300))
    const midA = await seed(accountA, "A2 roadmap", at(200))

    const hits = await searchThreadsAcrossAccounts(
      executor,
      [accountA, accountB],
      "roadmap"
    )
    // One merged, date-desc list — NOT per-account runs concatenated.
    expect(hits.map((thread) => thread.id)).toEqual([newerB, midA, olderA])
    expect(hits.map((thread) => thread.account_id)).toEqual([
      accountB,
      accountA,
      accountA,
    ])
  })

  it("applies limit after the merge, never per account", async () => {
    await seed(accountA, "A roadmap", at(100))
    const newerB = await seed(accountB, "B roadmap", at(300))
    const midA = await seed(accountA, "A2 roadmap", at(200))

    const hits = await searchThreadsAcrossAccounts(
      executor,
      [accountA, accountB],
      "roadmap",
      { limit: 2 }
    )
    expect(hits.map((thread) => thread.id)).toEqual([newerB, midA])
  })

  it("restricts the search to the requested account subset", async () => {
    await seed(accountA, "A roadmap", at(100))
    await seed(accountB, "B roadmap", at(300))

    const hits = await searchThreadsAcrossAccounts(
      executor,
      [accountB],
      "roadmap"
    )
    expect(hits.map((thread) => thread.account_id)).toEqual([accountB])
  })

  it("returns [] for an empty account set", async () => {
    await seed(accountA, "A roadmap", at(100))
    expect(await searchThreadsAcrossAccounts(executor, [], "roadmap")).toEqual(
      []
    )
  })
})

describe("dynamic date tokens (task 3.8, design D13)", () => {
  let executor: TestExecutor
  let accountId: string

  /** Seed a thread + one message dated `date` (unix seconds, absolute). */
  async function seedDated(subject: string, date: number): Promise<string> {
    const threadId = await createThread(executor, accountId, { subject })
    await createMessage(executor, {
      threadId,
      accountId,
      date,
      subject,
      fromName: "Alice Wonderland",
      fromAddress: "alice@wonderland.example",
    })
    await recomputeThreadCaches(executor, threadId)
    return threadId
  }

  /** Real now, shifted `days` (negative = past), as unix seconds. */
  function daysFromNow(days: number): number {
    return Math.floor(addDays(new Date(), days).getTime() / 1000)
  }

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
  })

  afterEach(() => {
    executor.close()
  })

  it("resolves after:__TODAY-7D__ at query time against the current clock", async () => {
    // One message inside the rolling window (2 days ago) and one outside
    // (9 days ago). Without token resolution the query degrades to free
    // text and matches NEITHER.
    await seedDated("Inside the window", daysFromNow(-2))
    await seedDated("Outside the window", daysFromNow(-9))

    const hits = await searchThreadsAcrossAccounts(
      executor,
      [accountId],
      "after:__TODAY-7D__"
    )
    expect(hits.map((thread) => thread.subject)).toEqual(["Inside the window"])
  })

  it("resolves tokens in the count pipeline too (split tab counts)", async () => {
    await seedDated("Inside the window", daysFromNow(-2))
    await seedDated("Outside the window", daysFromNow(-9))

    expect(
      await countThreadsForQuery(executor, [accountId], "after:__TODAY-7D__")
    ).toBe(1)
  })
})

describe("accent folding + relaxed fallback (task 1.3)", () => {
  let executor: TestExecutor
  let accountId: string

  /** Seed one thread + message with the given text fields. */
  async function seed(options: {
    subject?: string
    fromName?: string
    fromAddress?: string
    bodyText?: string
    date: number
    isRead?: boolean
  }): Promise<string> {
    const threadId = await createThread(executor, accountId, {
      subject: options.subject,
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: options.date,
      subject: options.subject,
      fromName: options.fromName,
      fromAddress: options.fromAddress,
      bodyText: options.bodyText,
      snippet: options.bodyText?.slice(0, 40),
      isRead: options.isRead,
    })
    await recomputeThreadCaches(executor, threadId)
    return threadId
  }

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
  })

  afterEach(() => {
    executor.close()
  })

  describe("accent folding (the v13 index folds; the query folds too)", () => {
    beforeEach(async () => {
      await seed({
        subject: "Bé Dọn Dẹp",
        fromName: "Hoà Bình",
        fromAddress: "hoa@vn.example",
        bodyText: "Lịch họp tuần sau đã đổi.",
        date: at(100),
      })
      await seed({
        subject: "Unrelated minutes",
        fromName: "Biz",
        fromAddress: "biz@corp.example",
        bodyText: "Nothing accented here.",
        date: at(200),
      })
    })

    it("spec scenario: the strict unaccented query finds the accented thread", async () => {
      const hits = await searchThreadsQuery(executor, accountId, "be don dep")
      expect(hits.map((thread) => thread.subject)).toEqual(["Bé Dọn Dẹp"])
    })

    it("matches folded terms across every indexed column", async () => {
      // from_name, body and subject each carry a different accent class
      expect(
        (await searchThreadsQuery(executor, accountId, "hoa binh")).length
      ).toBe(1)
      expect(
        (await searchThreadsQuery(executor, accountId, "lich hop")).length
      ).toBe(1)
    })

    it("also matches accented input against accented content", async () => {
      // the fold runs on the query side as well
      expect(
        (await searchThreadsQuery(executor, accountId, "bé dọn")).length
      ).toBe(1)
    })

    it("keeps CJK search working untouched by the fold", async () => {
      const cjkThread = await seed({
        subject: "会議のお知らせ",
        bodyText: "打ち合わせの日程",
        date: at(300),
      })
      expect(
        (await searchThreadsQuery(executor, accountId, "会議のお")).map(
          (thread) => thread.id
        )
      ).toEqual([cjkThread])
    })

    it("keeps plain ASCII search working exactly as before", async () => {
      expect(
        (await searchThreadsQuery(executor, accountId, "unrelated minutes"))
          .length
      ).toBe(1)
      expect(
        (await searchThreadsQuery(executor, accountId, "be don dep unrelated"))
          .length
      ).toBe(0)
    })
  })

  describe("relaxed fallback", () => {
    beforeEach(async () => {
      await seed({
        subject: "Banking summary",
        bodyText: "Quarterly banking numbers.",
        date: at(100),
      })
      await seed({
        subject: "Roadmap review",
        bodyText: "The roadmap moved a quarter.",
        date: at(200),
      })
      await seed({
        subject: "Unrelated",
        bodyText: "Neither topic.",
        date: at(300),
      })
    })

    it("strict multi-term hit is returned unflagged", async () => {
      const result = await searchThreadsWithRelaxedFallback(
        executor,
        [accountId],
        "banking quarterly"
      )
      expect(result.relaxed).toBe(false)
      expect(result.threads.length).toBe(1)
    })

    it("spec scenario: zero strict results re-run any-term, flagged relaxed", async () => {
      const result = await searchThreadsWithRelaxedFallback(
        executor,
        [accountId],
        "banking roadmap"
      )
      // no single message carries BOTH terms — strict found nothing
      expect(
        await searchThreadsQuery(executor, accountId, "banking roadmap")
      ).toEqual([])
      // the OR retry returns each single-term match, flagged
      expect(result.relaxed).toBe(true)
      expect(result.threads.map((thread) => thread.subject).sort()).toEqual([
        "Banking summary",
        "Roadmap review",
      ])
    })

    it("operator queries NEVER fall back — even when a term would match", async () => {
      const result = await searchThreadsWithRelaxedFallback(
        executor,
        [accountId],
        "banking from:nobody@corp.example"
      )
      expect(result.threads).toEqual([])
      expect(result.relaxed).toBe(false)
    })

    it("a flag-operator query never falls back either", async () => {
      const result = await searchThreadsWithRelaxedFallback(
        executor,
        [accountId],
        "banking is:starred"
      )
      expect(result.threads).toEqual([])
      expect(result.relaxed).toBe(false)
    })

    it("a single-term zero-result query does not retry (its OR form is itself)", async () => {
      const result = await searchThreadsWithRelaxedFallback(
        executor,
        [accountId],
        "xyzzyy"
      )
      expect(result.threads).toEqual([])
      expect(result.relaxed).toBe(false)
    })

    it("a negation-only query does not retry", async () => {
      const result = await searchThreadsWithRelaxedFallback(
        executor,
        [accountId],
        "-banking -roadmap"
      )
      // matches only the "Unrelated" thread strictly (no positive terms —
      // an OR retry is meaningless), and it must not be flagged relaxed
      expect(result.threads.map((thread) => thread.subject)).toEqual([
        "Unrelated",
      ])
      expect(result.relaxed).toBe(false)
    })

    it("an OR retry that still finds nothing reports unflagged empty", async () => {
      const result = await searchThreadsWithRelaxedFallback(
        executor,
        [accountId],
        "xyzzyp xyzzzq"
      )
      expect(result.threads).toEqual([])
      expect(result.relaxed).toBe(false)
    })
  })
})
