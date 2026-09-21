import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount, createMessage, createThread } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { getSenderCategory } from "../sender-categories"
import { categorizeIncomingMessages } from "../ingestion"
import { alwaysFromSender, moveThreadToCategory } from "../overrides"

/**
 * The user overrides of the automatic categorization (task 3.4, design
 * D4) against the real schema: moveThreadToCategory writes
 * threads.category UNCONDITIONALLY (a user move beats the ingestion
 * pass's keep-first), and alwaysFromSender upserts the 'user'-source
 * sender_categories row that classify.ts ranks above the header
 * heuristics — the spec's "user override becomes the rule" scenario.
 */

let executor: TestExecutor
let accountId: string

beforeEach(async () => {
  executor = createTestExecutor()
  accountId = await createAccount(executor, "gmail")
})

afterEach(() => {
  executor.close()
})

async function categoryOf(threadId: string): Promise<string | null> {
  const rows = await executor.select<{ category: string | null }>(
    "SELECT category FROM threads WHERE id = $1",
    [threadId]
  )
  return rows[0]?.category ?? null
}

/** A thread with one message from `from` (plus optional List-Id header
 * JSON in the messages.headers capture format). */
async function seedThread(
  from: string,
  options?: { headers?: Record<string, string>; date?: number }
): Promise<string> {
  const threadId = await createThread(executor, accountId, {
    subject: "Arrival",
  })
  await createMessage(executor, {
    threadId,
    accountId,
    date: options?.date ?? 1000,
    fromAddress: from,
    subject: "Arrival",
  })
  if (options?.headers) {
    await executor.execute("UPDATE messages SET headers = $1 WHERE thread_id = $2", [
      JSON.stringify(options.headers),
      threadId,
    ])
  }
  return threadId
}

/** The ingestion pass the engines run per arrival, reduced to the shape
 * the tests need (headers from the messages.headers JSON). */
async function simulateArrival(
  threadId: string,
  from: string,
  headers: Record<string, string>
): Promise<void> {
  await categorizeIncomingMessages(executor, [
    {
      messageRowId: `msg-${threadId}-${Math.random()}`,
      threadId,
      senderEmail: from,
      subject: "Arrival",
      headers,
    },
  ])
}

describe("moveThreadToCategory", () => {
  it("sets the category on an uncategorized thread", async () => {
    const threadId = await seedThread("ada@example.com")

    await moveThreadToCategory(executor, threadId, "promotions")

    expect(await categoryOf(threadId)).toBe("promotions")
  })

  it("overrides an existing category (a user move is unconditional)", async () => {
    const threadId = await seedThread("ada@example.com")
    await moveThreadToCategory(executor, threadId, "updates")

    await moveThreadToCategory(executor, threadId, "social")

    expect(await categoryOf(threadId)).toBe("social")
  })

  it("survives later ingestion arrivals (keep-first protects the move)", async () => {
    // Mirrors 3.3's keep-first test shape: the move wrote a non-NULL
    // category, and categorizeIncomingMessages' `AND category IS NULL`
    // UPDATE must never touch it — even with header evidence saying
    // otherwise.
    const threadId = await seedThread("ada@example.com")
    await moveThreadToCategory(executor, threadId, "promotions")

    await simulateArrival(threadId, "ada@example.com", {
      "list-id": "<lists.example>",
    })

    expect(await categoryOf(threadId)).toBe("promotions")
  })
})

describe("alwaysFromSender", () => {
  it("upserts a 'user'-source sender rule AND moves the thread", async () => {
    const threadId = await seedThread("News@X.Example")

    await alwaysFromSender(executor, threadId, "promotions")

    expect(await getSenderCategory(executor, "news@x.example")).toEqual({
      category: "promotions",
      source: "user",
    })
    expect(await categoryOf(threadId)).toBe("promotions")
  })

  it("future mail from the sender follows the rule (the spec scenario)", async () => {
    // "User override becomes the rule": moving a List-Id sender's mail to
    // Promotions with "always" makes FUTURE mail from that sender land in
    // Promotions — through the ingestion pass's own classify inputs.
    const first = await seedThread("news@x.example", {
      headers: { "list-id": "<x.example>" },
    })
    await alwaysFromSender(executor, first, "promotions")

    const second = await seedThread("News@X.Example", {
      headers: { "list-id": "<x.example>" },
    })
    await simulateArrival(second, "News@X.Example", {
      "list-id": "<x.example>",
    })

    expect(await categoryOf(second)).toBe("promotions")
  })

  it("re-choosing another category replaces the sender rule", async () => {
    const threadId = await seedThread("news@x.example")

    await alwaysFromSender(executor, threadId, "promotions")
    await alwaysFromSender(executor, threadId, "updates")

    expect(await getSenderCategory(executor, "news@x.example")).toEqual({
      category: "updates",
      source: "user",
    })
  })

  it("moves a thread without any message but derives no sender rule", async () => {
    const threadId = await createThread(executor, accountId, {
      subject: "Empty",
    })

    await alwaysFromSender(executor, threadId, "social")

    expect(await categoryOf(threadId)).toBe("social")
    // No sender could be derived; the override table is untouched.
    expect(await getSenderCategory(executor, "")).toBeNull()
    const rows = await executor.select(
      "SELECT sender_key FROM sender_categories"
    )
    expect(rows).toHaveLength(0)
  })

  it("skips a NULL From address and uses the newest real sender", async () => {
    const threadId = await seedThread("ghost@x.example", { date: 100 })
    // Newest message has no From; the older one does.
    await createMessage(executor, {
      threadId,
      accountId,
      date: 200,
      subject: "No sender",
    })

    await alwaysFromSender(executor, threadId, "updates")

    expect(await getSenderCategory(executor, "ghost@x.example")).toEqual({
      category: "updates",
      source: "user",
    })
  })
})
