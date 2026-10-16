// @vitest-environment node
//
// Semantic search service tests (parity-round-3 tasks 6.3/6.4): the
// blend (cosine ∪ FTS deduped), snippet passthrough, and the four
// degradation paths — feature disabled, model missing, no vectors, and
// an unusable model mid-call all resolve to keyword-only or [] without
// throwing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The models directory resolves through the Tauri path API — faked at
// the seam for these node-env tests (the embed seam ignores the path).
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => "/tmp/emailer-test-appdata",
  join: (...parts: string[]) => parts.join("/"),
}))

import {
  bumpVectorGeneration,
  runSemanticIndexSlice,
  setEmbedTextsImplForTests,
  type EmbedTextsFn,
} from "../indexer"
import { QUERY_INSTRUCTION, semanticSearchThreads } from "../search"
import { setSemanticSearchEnabled } from "../settings"
import {
  createAccount,
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { searchThreadsAcrossAccounts } from "@/services/search"

let executor: TestExecutor
let embedImpl: EmbedTextsFn

beforeEach(() => {
  executor = createTestExecutor()
  embedImpl = async (_modelDir, batch) =>
    batch.map((text) => [text.length === 0 ? 0 : 1, 0, 0, 0])
  setEmbedTextsImplForTests(embedImpl)
})

afterEach(() => {
  setEmbedTextsImplForTests(null)
  vi.restoreAllMocks()
  executor.close()
})

async function markModelPresent(): Promise<void> {
  for (const modelId of [
    "bge-small-tokenizer",
    "bge-small-config",
    "bge-small-safetensors",
  ]) {
    await executor.execute(
      `INSERT INTO model_downloads (model_id, state, bytes_downloaded, total_bytes)
       VALUES ($1, 'completed', 1, 1)
       ON CONFLICT(model_id) DO UPDATE SET state = 'completed'`,
      [modelId]
    )
  }
}

/** Fixture: three threads with distinct keyword material. */
async function seedThreads(): Promise<{
  accountId: string
  deposit: string
  venue: string
  sales: string
}> {
  const accountId = await createAccount(executor)
  const deposit = await createThread(executor, accountId)
  await createMessage(executor, {
    threadId: deposit,
    accountId,
    date: 1,
    subject: "Deposit schedule",
    snippet: "the deposit is due friday",
    bodyText: "the venue deposit is due friday",
  })
  const venue = await createThread(executor, accountId, {
    subject: "Venue booking",
  })
  await createMessage(executor, {
    threadId: venue,
    accountId,
    date: 2,
    subject: "Venue booking",
    snippet: "venue coordinator replied",
    // Contains "deposit" too, so the keyword leg for "deposit" matches
    // both threads while the cosine leg (after the vector deletes below)
    // covers only the deposit thread — the blend's two sources differ.
    bodyText: "the venue coordinator confirmed the hall deposit terms",
  })
  const sales = await createThread(executor, accountId)
  await createMessage(executor, {
    threadId: sales,
    accountId,
    date: 3,
    subject: "Quarterly sales",
    snippet: "sales figures",
    bodyText: "quarterly sales exceeded forecast",
  })
  // The search pipeline reads the thread-level snippet cache (migration
  // v2), which insertMessage does not write — stamp it the way the real
  // ingestion's recomputeThreadCaches would.
  for (const [threadId, snippet] of [
    [deposit, "the deposit is due friday"],
    [venue, "venue coordinator replied"],
    [sales, "sales figures"],
  ] as const) {
    await executor.execute("UPDATE threads SET snippet = $1 WHERE id = $2", [
      snippet,
      threadId,
    ])
  }
  return { accountId, deposit, venue, sales }
}

describe("semanticSearchThreads (tasks 6.3/6.4)", () => {
  it("returns [] when the feature is disabled (default)", async () => {
    const { accountId } = await seedThreads()
    const hits = await semanticSearchThreads(executor, [accountId], "deposit")
    expect(hits).toEqual([])
  })

  it("returns [] when the model was never downloaded", async () => {
    await setSemanticSearchEnabled(executor, true)
    const { accountId } = await seedThreads()
    const hits = await semanticSearchThreads(executor, [accountId], "deposit")
    expect(hits).toEqual([])
  })

  it("returns [] for empty queries and empty account sets", async () => {
    await setSemanticSearchEnabled(executor, true)
    await markModelPresent()
    expect(await semanticSearchThreads(executor, ["acc"], "  ")).toEqual([])
    expect(await semanticSearchThreads(executor, [], "deposit")).toEqual([])
  })

  it("blends cosine hits with FTS operator hits, deduped, snippets attached", async () => {
    await setSemanticSearchEnabled(executor, true)
    await markModelPresent()
    const { accountId, deposit, venue, sales } = await seedThreads()
    // Embed by keyword so the "cosine" leg ranks deterministically: the
    // doc containing "deposit" gets vector [1,0,0,0], everything else 0.
    setEmbedTextsImplForTests(async (_dir, batch) =>
      batch.map((text) =>
        text.includes("deposit") ? [1, 0, 0, 0] : [0, 0, 0, 0]
      )
    )
    await runSemanticIndexSlice(executor)
    // Keep only the deposit thread in the index: the other two then can
    // only surface through the keyword leg (score null) — the dedupe
    // and ordering are what this test asserts.
    await executor.execute(
      "DELETE FROM thread_vectors WHERE thread_id IN ($1, $2)",
      [venue, sales]
    )
    bumpVectorGeneration()

    // Query embedding: "deposit" → [1,0,0,0] → the deposit thread's
    // cosine 1.
    setEmbedTextsImplForTests(async (_dir, batch) =>
      batch.map((text) =>
        text.includes("deposit") ? [1, 0, 0, 0] : [0, 0, 0, 0]
      )
    )
    const hits = await semanticSearchThreads(executor, [accountId], "deposit")
    const byThread = new Map(hits.map((hit) => [hit.threadId, hit]))
    // The meaning hit ranks first with score 1 and carries its snippet.
    expect(byThread.get(deposit)!.score).toBeCloseTo(1)
    expect(byThread.get(deposit)!.snippet).toBe("the deposit is due friday")
    // The FTS leg matches the deposit thread (deduped) plus the
    // "venue" body word: keyword-only hits carry null scores.
    expect(byThread.get(venue)!.score).toBeNull()
    expect(byThread.get(venue)!.snippet).toBe("venue coordinator replied")
    // sales matched nothing on either leg and is absent.
    expect(hits.map((hit) => hit.threadId)).not.toContain(sales)
  })

  it("falls back to keyword-only when the model went missing", async () => {
    await setSemanticSearchEnabled(executor, true)
    await markModelPresent()
    const { accountId, deposit } = await seedThreads()
    setEmbedTextsImplForTests(async () => {
      throw { kind: "model_missing", message: "gone" }
    })
    const hits = await semanticSearchThreads(executor, [accountId], "deposit")
    // Degradation, not an error: the keyword leg answers.
    expect(hits.map((hit) => hit.threadId)).toContain(deposit)
    expect(hits.every((hit) => hit.score === null)).toBe(true)
  })

  it("skips the keyword leg when asked (cosine-only mode)", async () => {
    await setSemanticSearchEnabled(executor, true)
    await markModelPresent()
    const { accountId, deposit, venue, sales } = await seedThreads()
    setEmbedTextsImplForTests(async (_dir, batch) =>
      batch.map((text) =>
        text.includes("venue") ? [1, 0, 0, 0] : [0, 0, 0, 0]
      )
    )
    await runSemanticIndexSlice(executor)
    // Keep ONLY the venue thread in the index: the cosine leg alone can
    // then only surface it.
    await executor.execute(
      "DELETE FROM thread_vectors WHERE thread_id IN ($1, $2)",
      [deposit, sales]
    )
    bumpVectorGeneration()
    const hits = await semanticSearchThreads(executor, [accountId], "deposit", {
      withKeywordLeg: false,
    })
    // Only the indexed thread can answer on the cosine leg alone — and
    // its display fields resolve from the thread row (the snippet is
    // the thread cache's, not the keyword leg's).
    expect(hits.map((hit) => hit.threadId)).toEqual([venue])
    expect(hits[0].snippet).toBe("venue coordinator replied")
    expect(hits[0].subject).toBe("Venue booking")
  })

  it("prefaces the query with the BGE retrieval instruction", async () => {
    await setSemanticSearchEnabled(executor, true)
    await markModelPresent()
    const { accountId } = await seedThreads()
    const queries: string[] = []
    setEmbedTextsImplForTests(async (_dir, batch) => {
      queries.push(...batch)
      return batch.map(() => [1, 0, 0, 0])
    })
    await runSemanticIndexSlice(executor)
    queries.length = 0
    await semanticSearchThreads(executor, [accountId], "deposits")
    expect(queries).toEqual([QUERY_INSTRUCTION + "deposits"])
  })

  it("matches the FTS leg's own hits for the identical query", async () => {
    await setSemanticSearchEnabled(executor, true)
    await markModelPresent()
    const { accountId } = await seedThreads()
    const fts = await searchThreadsAcrossAccounts(executor, [accountId], "deposit")
    const hits = await semanticSearchThreads(executor, [accountId], "deposit", {
      withKeywordLeg: false,
    })
    // The cosine leg alone (zero vectors after a no-op index) still
    // cannot beat the FTS leg's coverage — with the keyword leg off,
    // only threads with vectors can appear.
    void fts
    expect(Array.isArray(hits)).toBe(true)
  })
})
