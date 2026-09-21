import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createAccount, createThread } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import {
  CATEGORY_BACKFILL_BATCH_SIZE,
  cancelCategoryBackfill,
  getCategoryBackfillProgress,
  startCategoryBackfill,
  subscribeCategoryBackfillProgress,
} from "../backfill"
import { setSenderCategory } from "../sender-categories"

/**
 * The backfill job (task 3.4, design D4): NULL-category threads are
 * classified by the same deterministic engine ingestion uses (stored
 * headers + sender overrides, keep-first writes), in bounded id-ordered
 * batches that resume across slices and stop at a batch boundary on
 * cancel, with the cumulative summary observable in the module progress
 * state. Runs against the real schema.
 */

let executor: TestExecutor
let accountId: string
let warn: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  executor = createTestExecutor()
  accountId = await createAccount(executor, "gmail")
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  executor.close()
})

/** A thread (id-ordered by the fixtures' uid sequence) whose newest
 * message carries `headers` in the messages.headers JSON format. */
async function seedThread(
  options?: {
    from?: string
    headers?: Record<string, string>
    date?: number
    withMessage?: boolean
  }
): Promise<string> {
  const threadId = await createThread(executor, accountId, {
    subject: "Backfill me",
  })
  if (options?.withMessage !== false) {
    await executor.execute(
      `INSERT INTO messages (id, thread_id, account_id, date, subject,
         from_address, headers)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        `msg-${threadId}`,
        threadId,
        accountId,
        options?.date ?? 1000,
        "Backfill me",
        options?.from ?? "ada@example.com",
        options?.headers ? JSON.stringify(options.headers) : null,
      ]
    )
  }
  return threadId
}

async function categoryOf(threadId: string): Promise<string | null> {
  const rows = await executor.select<{ category: string | null }>(
    "SELECT category FROM threads WHERE id = $1",
    [threadId]
  )
  return rows[0]?.category ?? null
}

async function nullCategoryCount(): Promise<number> {
  const rows = await executor.select<{ count: number }>(
    "SELECT COUNT(*) AS count FROM threads WHERE category IS NULL"
  )
  return rows[0]?.count ?? 0
}

describe("startCategoryBackfill", () => {
  it("categorizes uncategorized mail with the ingestion engine and records the summary", async () => {
    const list = await seedThread({
      from: "news@x.example",
      headers: { "list-id": "<x.example>" },
    })
    const auto = await seedThread({
      headers: { "auto-submitted": "auto-generated" },
    })
    const plain = await seedThread({ from: "ada@example.com" })

    const snapshot = await startCategoryBackfill(executor, { fresh: true })

    expect(await categoryOf(list)).toBe("newsletters")
    expect(await categoryOf(auto)).toBe("updates")
    expect(await categoryOf(plain)).toBe("primary")
    // The progress summary the spec asks for, standing when done.
    expect(snapshot).toEqual({
      running: false,
      scanned: 3,
      categorized: 3,
      done: true,
      cancelled: false,
    })
    expect(getCategoryBackfillProgress()).toEqual(snapshot)
  })

  it("keeps already-categorized threads (keep-first) and only scans the NULL ones", async () => {
    const decided = await seedThread({ from: "ada@example.com" })
    await executor.execute("UPDATE threads SET category = $1 WHERE id = $2", [
      "promotions",
      decided,
    ])
    const pending = await seedThread({
      from: "news@x.example",
      headers: { "list-id": "<x.example>" },
    })

    const snapshot = await startCategoryBackfill(executor, { fresh: true })

    expect(await categoryOf(decided)).toBe("promotions")
    expect(await categoryOf(pending)).toBe("newsletters")
    expect(snapshot.scanned).toBe(1)
    expect(snapshot.categorized).toBe(1)
    expect(snapshot.done).toBe(true)
  })

  it("applies the user sender override like ingestion does", async () => {
    await setSenderCategory(executor, "deals@x.example", "promotions", "user")
    const thread = await seedThread({
      from: "deals@x.example",
      headers: { "list-id": "<x.example>" }, // headers would say newsletters
    })

    await startCategoryBackfill(executor, { fresh: true })

    expect(await categoryOf(thread)).toBe("promotions")
  })

  it("classifies from the thread's NEWEST message", async () => {
    // Old message was a list post; the newer personal reply decides.
    const thread = await seedThread({
      from: "list@x.example",
      headers: { "list-id": "<x.example>" },
      date: 100,
    })
    await executor.execute(
      `INSERT INTO messages (id, thread_id, account_id, date, subject,
         from_address, headers)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [`newer-${thread}`, thread, accountId, 200, "Re: Backfill me", "ada@example.com", null]
    )

    await startCategoryBackfill(executor, { fresh: true })

    expect(await categoryOf(thread)).toBe("primary")
  })

  it("degrades a corrupt headers capture to an empty record", async () => {
    const thread = await seedThread({
      from: "noreply@service.example",
    })
    await executor.execute(
      "UPDATE messages SET headers = 'not-json' WHERE id = $1",
      [`msg-${thread}`]
    )

    await startCategoryBackfill(executor, { fresh: true })

    // Headers lost — classification continues on the remaining signals.
    expect(await categoryOf(thread)).toBe("updates")
  })

  it("skips message-less threads and leaves them NULL", async () => {
    const empty = await seedThread({ withMessage: false })

    const snapshot = await startCategoryBackfill(executor, { fresh: true })

    expect(await categoryOf(empty)).toBeNull()
    expect(snapshot.scanned).toBe(0)
    expect(snapshot.done).toBe(true)
  })

  it("processes bounded batches per slice and resumes on the next call", async () => {
    // One more thread than a full batch, so two batches are needed.
    for (let index = 0; index < CATEGORY_BACKFILL_BATCH_SIZE + 5; index += 1) {
      await seedThread({ from: "ada@example.com" })
    }

    const first = await startCategoryBackfill(executor, {
      fresh: true,
      maxBatches: 1,
    })
    expect(first.scanned).toBe(CATEGORY_BACKFILL_BATCH_SIZE)
    expect(first.done).toBe(false)
    expect(first.running).toBe(false) // the slice yielded
    expect(await nullCategoryCount()).toBe(5)

    const second = await startCategoryBackfill(executor) // resume
    expect(second.done).toBe(true)
    expect(second.scanned).toBe(CATEGORY_BACKFILL_BATCH_SIZE + 5)
    expect(second.categorized).toBe(CATEGORY_BACKFILL_BATCH_SIZE + 5)
  })

  it("stops at the batch boundary on cancel; only a fresh start resumes", async () => {
    for (let index = 0; index < CATEGORY_BACKFILL_BATCH_SIZE + 5; index += 1) {
      await seedThread({ from: "ada@example.com" })
    }

    // Cancel is requested while the first batch is in flight (the slice
    // has not been awaited yet), so it stops after that batch.
    const run = startCategoryBackfill(executor, { fresh: true })
    cancelCategoryBackfill()
    const cancelled = await run

    expect(cancelled.cancelled).toBe(true)
    expect(cancelled.done).toBe(false)
    expect(cancelled.scanned).toBe(CATEGORY_BACKFILL_BATCH_SIZE)
    expect(await nullCategoryCount()).toBe(5)

    // The tick handler must not resurrect a cancelled job …
    const resumed = await startCategoryBackfill(executor)
    expect(resumed.cancelled).toBe(true)
    expect(resumed.scanned).toBe(CATEGORY_BACKFILL_BATCH_SIZE)

    // … but an explicit fresh start resets the progress and finishes.
    const restarted = await startCategoryBackfill(executor, { fresh: true })
    expect(restarted.done).toBe(true)
    expect(restarted.cancelled).toBe(false)
    expect(restarted.scanned).toBe(5) // progress was reset, not appended
    expect(await nullCategoryCount()).toBe(0)
  })

  it("resuming a done job is a no-op (the tick stays cheap)", async () => {
    await seedThread({ from: "ada@example.com" })
    const first = await startCategoryBackfill(executor, { fresh: true })
    expect(first.done).toBe(true)

    const again = await startCategoryBackfill(executor)

    expect(again).toEqual(first)
  })

  it("notifies progress subscribers and tolerates a failing listener", async () => {
    const seen: number[] = []
    const unsubscribe = subscribeCategoryBackfillProgress((snapshot) => {
      seen.push(snapshot.scanned)
    })
    subscribeCategoryBackfillProgress(() => {
      throw new Error("listener on fire")
    })

    await seedThread({ from: "ada@example.com" })
    await startCategoryBackfill(executor, { fresh: true })

    unsubscribe()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[seen.length - 1]).toBe(1)
    expect(warn).toHaveBeenCalled() // the failing listener was isolated

    await seedThread({ from: "ada@example.com" })
    await startCategoryBackfill(executor, { fresh: true })
    // Unsubscribed: no further notifications arrived.
    expect(seen[seen.length - 1]).toBe(1)
  })
})
