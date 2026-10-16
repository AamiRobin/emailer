// @vitest-environment node
//
// Per-account in-memory vector index tests (parity-round-3 task 6.3):
// ranking order, the 50k cap with oldest-first spill, blend dedupe, and
// the generation-based cache invalidation.

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  blendHits,
  getAccountIndexStatus,
  invalidateAccountIndex,
  loadAccountIndex,
  MAX_INDEX_THREADS,
  topCosine,
  type AccountVectorIndex,
} from "../loader"
import { bumpVectorGeneration } from "../indexer"
import {
  createAccount,
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import type { SqlExecutor } from "@/services/db/executor"

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
})

afterEach(() => {
  executor.close()
})

/** Store one vector row directly (the loader reads whatever is in the
 * table; the indexer's write path is covered by its own suite). */
async function storeVector(
  executor: SqlExecutor,
  accountId: string,
  threadId: string,
  vector: number[],
  lastMessageAt: number | null
): Promise<void> {
  const bytes = new Uint8Array(
    Float32Array.from(vector).buffer
  )
  await executor.execute(
    `INSERT INTO thread_vectors
       (account_id, thread_id, dim, vector, content_hash, updated_at)
     VALUES ($1, $2, $3, unhex($4), 'hash', 100)`,
    [
      accountId,
      threadId,
      vector.length,
      Array.from(bytes)
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    ]
  )
  if (lastMessageAt !== null) {
    await executor.execute(
      "UPDATE threads SET last_message_at = $1 WHERE id = $2",
      [lastMessageAt, threadId]
    )
  }
}

function syntheticIndex(dim: number, rows: [string, number[]][]): AccountVectorIndex {
  const matrix = new Float32Array(rows.length * dim)
  rows.forEach(([, vector], index) =>
    matrix.set(vector, index * dim)
  )
  return {
    accountId: "acc",
    threadIds: rows.map(([id]) => id),
    matrix,
    dim,
  }
}

describe("topCosine (task 6.3 ranking)", () => {
  it("ranks by descending cosine with a deterministic tiebreak", () => {
    // Unit 2-dim vectors; the query (1,0).
    const index = syntheticIndex(2, [
      ["t-b", [1, 0]], // cos 1
      ["t-c", [0, 1]], // cos 0
      ["t-a", [1, 0]], // cos 1 — ties with t-b, id breaks it
      ["t-d", [-1, 0]], // cos -1
    ])
    const hits = topCosine(index, Float32Array.from([1, 0]), 4)
    expect(hits.map((hit) => hit.threadId)).toEqual(["t-a", "t-b", "t-c", "t-d"])
    expect(hits[0].score).toBeCloseTo(1)
    expect(hits[3].score).toBeCloseTo(-1)
  })

  it("caps at k and rejects dimension mismatches", () => {
    const index = syntheticIndex(2, [
      ["t-1", [1, 0]],
      ["t-2", [0.6, 0.8]],
      ["t-3", [0, 1]],
    ])
    const hits = topCosine(index, Float32Array.from([1, 0]), 2)
    expect(hits.map((hit) => hit.threadId)).toEqual(["t-1", "t-2"])

    // A query from a different model (dim 3 vs index dim 2) → nothing.
    expect(topCosine(index, Float32Array.from([1, 0, 0]), 2)).toEqual([])
    expect(
      topCosine(syntheticIndex(2, []), Float32Array.from([1, 0]), 2)
    ).toEqual([])
  })
})

describe("blendHits (task 6.3 blend)", () => {
  it("unions cosine and FTS hits deduped by thread, cosine order first", () => {
    const blended = blendHits(
      [
        { threadId: "cos-1", score: 0.9 },
        { threadId: "both", score: 0.5 },
      ],
      [
        { threadId: "both" },
        { threadId: "fts-1" },
        { threadId: "fts-2" },
      ],
      10
    )
    expect(blended.map((hit) => hit.threadId)).toEqual([
      "cos-1",
      "both",
      "fts-1",
      "fts-2",
    ])
    // Cosine hits keep their score; keyword-only hits carry null.
    expect(blended.find((hit) => hit.threadId === "both")!.score).toBeCloseTo(0.5)
    expect(blended.find((hit) => hit.threadId === "fts-1")!.score).toBeNull()
  })

  it("caps the blend at k", () => {
    const blended = blendHits(
      [
        { threadId: "cos-1", score: 0.9 },
        { threadId: "cos-2", score: 0.8 },
      ],
      [{ threadId: "fts-1" }, { threadId: "fts-2" }],
      3
    )
    expect(blended).toHaveLength(3)
    expect(blended.map((hit) => hit.threadId)).toEqual([
      "cos-1",
      "cos-2",
      "fts-1",
    ])
  })
})

describe("loadAccountIndex (task 6.3 loader)", () => {
  it("loads vectors as a matrix with a thread-id index", async () => {
    const accountId = await createAccount(executor)
    const first = await createThread(executor, accountId)
    const second = await createThread(executor, accountId)
    await createMessage(executor, {
      threadId: first,
      accountId,
      date: 1,
      bodyText: "x",
    })
    await createMessage(executor, {
      threadId: second,
      accountId,
      date: 1,
      bodyText: "y",
    })
    await storeVector(executor, accountId, first, [1, 0, 0, 1], 10)
    await storeVector(executor, accountId, second, [0, 1, 0, 1], 20)

    const index = await loadAccountIndex(executor, accountId)
    expect(index).not.toBeNull()
    expect(index!.threadIds.sort()).toEqual([first, second].sort())
    expect(index!.dim).toBe(4)
    expect(index!.matrix).toBeInstanceOf(Float32Array)
    expect(index!.matrix.length).toBe(8)

    // The query (1,0,0,1) hits the first thread hardest.
    const hits = topCosine(index!, Float32Array.from([1, 0, 0, 1]), 1)
    expect(hits[0].threadId).toBe(first)
  })

  it("returns null for an account with no vectors", async () => {
    const accountId = await createAccount(executor)
    expect(await loadAccountIndex(executor, accountId)).toBeNull()
    expect(await getAccountIndexStatus(executor, accountId)).toBeNull()
  })

  it("caps at 50k threads spilling the OLDEST first", async () => {
    const accountId = await createAccount(executor)
    // dim-1 vectors keep the fixture small; MAX_INDEX_THREADS + 5 rows.
    for (let index = 0; index < MAX_INDEX_THREADS + 5; index += 1) {
      const threadId = await createThread(executor, accountId)
      await createMessage(executor, {
        threadId,
        accountId,
        date: 1,
        bodyText: "x",
      })
      await storeVector(executor, accountId, threadId, [index % 2], index)
    }
    const status = await getAccountIndexStatus(executor, accountId)
    expect(status).toEqual({
      threads: MAX_INDEX_THREADS + 5,
      loaded: MAX_INDEX_THREADS,
      spilled: 5,
    })
    const index = await loadAccountIndex(executor, accountId)
    expect(index!.threadIds).toHaveLength(MAX_INDEX_THREADS)
    // The five OLDEST threads (last_message_at 0..4) are the spilled ones.
    const withOld = await executor.select<{ id: string }>(
      `SELECT id FROM threads WHERE account_id = $1
       ORDER BY last_message_at LIMIT 5`,
      [accountId]
    )
    for (const row of withOld) {
      expect(index!.threadIds).not.toContain(row.id)
    }
  }, 30_000)

  it("drops corrupt vector rows instead of failing the account", async () => {
    const accountId = await createAccount(executor)
    const good = await createThread(executor, accountId)
    const corrupt = await createThread(executor, accountId)
    await createMessage(executor, { threadId: good, accountId, date: 1 })
    await createMessage(executor, { threadId: corrupt, accountId, date: 1 })
    await storeVector(executor, accountId, good, [1, 2], 10)
    // Not a multiple of 4 bytes → undecodable.
    await executor.execute(
      `INSERT INTO thread_vectors
         (account_id, thread_id, dim, vector, content_hash, updated_at)
       VALUES ($1, $2, 3, unhex('aabbcc'), 'hash', 100)`,
      [accountId, corrupt]
    )
    const index = await loadAccountIndex(executor, accountId)
    expect(index!.threadIds).toEqual([good])
  })

  it("rebuilds after a generation bump and drops on invalidate", async () => {
    const accountId = await createAccount(executor)
    const threadId = await createThread(executor, accountId)
    await createMessage(executor, { threadId, accountId, date: 1 })
    await storeVector(executor, accountId, threadId, [1], 10)
    const first = await loadAccountIndex(executor, accountId)
    expect(first!.threadIds).toEqual([threadId])

    // New vectors land (generation bump) → the cached matrix rebuilds.
    const another = await createThread(executor, accountId)
    await createMessage(executor, { threadId: another, accountId, date: 2 })
    await storeVector(executor, accountId, another, [0], 20)
    bumpVectorGeneration()
    const second = await loadAccountIndex(executor, accountId)
    expect(second!.threadIds.sort()).toEqual([threadId, another].sort())

    invalidateAccountIndex(accountId)
    // A subsequent load still works (rebuild from the table).
    const third = await loadAccountIndex(executor, accountId)
    expect(third!.threadIds).toHaveLength(2)
  })
})
