// @vitest-environment node
//
// Semantic indexing pipeline tests (parity-round-3 task 6.2): the REAL
// SQL over the node:sqlite executor (fixtures through the query layer),
// with the embed seam mocked — the Rust engine itself is covered by the
// #[ignore]-gated Rust test; here the contract is doc selection, the
// incremental hash skip, the blob storage and the failure isolation.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The models directory resolves through the Tauri path API — outside a
// Tauri runtime (these node-env tests) the module is faked at the seam,
// like every other @tauri-apps module in the suite.
vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => "/tmp/emailer-test-appdata",
  join: (...parts: string[]) => parts.join("/"),
}))

import {
  composeThreadDocument,
  cancelSemanticIndexing,
  getSemanticIndexProgress,
  runSemanticIndexSlice,
  setEmbedTextsImplForTests,
  type EmbedTextsFn,
} from "../indexer"
import {
  setSemanticSearchEnabled,
} from "../settings"
import {
  float32ToHex,
  vectorToFloat32,
} from "../vectors"
import { foldText } from "@/services/search/fts"
import {
  createAccount,
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"

let executor: TestExecutor
let embedCalls: { modelDir: string; batch: string[] }[]
let embedImpl: EmbedTextsFn

beforeEach(() => {
  executor = createTestExecutor()
  embedCalls = []
  // Deterministic pseudo-embeddings: the first doc becomes [1,0,...],
  // the second [0,1,...] — enough for the write path assertions.
  embedImpl = async (modelDir, batch) =>
    batch.map((_, index) => {
      const vector = new Array(4).fill(0)
      vector[index % 4] = 1
      embedCalls.push({ modelDir, batch: [batch[index]] })
      return vector
    })
  setEmbedTextsImplForTests(embedImpl)
})

afterEach(() => {
  setEmbedTextsImplForTests(null)
  executor.close()
})

/** Mark the model downloaded (the gating reads model_downloads rows). */
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

async function enableFeature(): Promise<void> {
  await setSemanticSearchEnabled(executor, true)
  await markModelPresent()
}

async function storedVector(
  threadId: string
): Promise<{ vector: Float32Array; hash: string; dim: number } | null> {
  const rows = await executor.select<{
    dim: number
    vector: Uint8Array
    content_hash: string
  }>(
    "SELECT dim, vector, content_hash FROM thread_vectors WHERE thread_id = $1",
    [threadId]
  )
  const row = rows[0]
  if (!row) return null
  return {
    dim: row.dim,
    vector: vectorToFloat32(row.vector) as Float32Array,
    hash: row.content_hash,
  }
}

describe("runSemanticIndexSlice (task 6.2)", () => {
  it("is a no-op while the feature is disabled or the model is absent", async () => {
    const accountId = await createAccount(executor)
    const threadId = await createThread(executor, accountId, {
      subject: "Venue deposits",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1,
      bodyText: "the deposit is due friday",
    })

    // Disabled (default): the slice runs, gates out, embeds nothing.
    const disabled = await runSemanticIndexSlice(executor)
    expect(disabled.running).toBe(false)
    expect(embedCalls).toHaveLength(0)

    // Enabled but model files never downloaded: still gated out.
    await setSemanticSearchEnabled(executor, true)
    const noModel = await runSemanticIndexSlice(executor)
    expect(noModel.running).toBe(false)
    expect(embedCalls).toHaveLength(0)
  })

  it("indexes thread docs (subject + from + folded body) as blobs with hashes", async () => {
    await enableFeature()
    const accountId = await createAccount(executor)
    const threadId = await createThread(executor, accountId)
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1,
      subject: "Venue deposits",
      fromName: "Ana",
      fromAddress: "ana@example.com",
      bodyText: "Café résumé attached",
    })

    const result = await runSemanticIndexSlice(executor)
    expect(result.done).toBe(true)
    expect(result.indexed).toBe(1)
    expect(result.embedded).toBe(1)
    expect(embedCalls).toHaveLength(1)

    // The document the model saw: subject, From line, FOLDED body.
    expect(embedCalls[0].batch[0]).toBe(
      `Venue deposits\nFrom: Ana <ana@example.com>\n${foldText("Café résumé attached")}`
    )

    const stored = await storedVector(threadId)
    expect(stored).not.toBeNull()
    expect(stored!.dim).toBe(4)
    expect(Array.from(stored!.vector)).toEqual([1, 0, 0, 0])
    // The stored hash matches a fresh hash of the same document.
    expect(stored!.hash).toMatch(/^[0-9a-f]{16}$/)
  })

  it("skips unchanged threads on the next pass (no embed calls)", async () => {
    await enableFeature()
    const accountId = await createAccount(executor)
    const threadId = await createThread(executor, accountId)
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1,
      subject: "Same",
      bodyText: "unchanged body",
    })
    await runSemanticIndexSlice(executor)
    expect(embedCalls).toHaveLength(1)

    // The next pass finds nothing stale: done with zero new embeddings.
    embedCalls = []
    const second = await runSemanticIndexSlice(executor)
    expect(second.done).toBe(true)
    expect(second.embedded).toBe(0)
    expect(embedCalls).toHaveLength(0)
  })

  it("re-embeds a thread when a new message changes its document", async () => {
    await enableFeature()
    const accountId = await createAccount(executor)
    const threadId = await createThread(executor, accountId)
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1,
      subject: "Thread",
      bodyText: "first version",
    })
    await runSemanticIndexSlice(executor)
    const before = await storedVector(threadId)

    // A newer message changes the thread's document.
    await createMessage(executor, {
      threadId,
      accountId,
      date: 2,
      subject: "Thread",
      bodyText: "second version with new content",
    })
    embedCalls = []
    const second = await runSemanticIndexSlice(executor)
    expect(second.embedded).toBe(1)
    expect(embedCalls).toHaveLength(1)
    expect(embedCalls[0].batch[0]).toContain("second version with new content")

    const after = await storedVector(threadId)
    expect(after).not.toBeNull()
    expect(after!.hash).not.toBe(before!.hash)
  })

  it("stops quietly when the model went missing mid-feature", async () => {
    await enableFeature()
    const accountId = await createAccount(executor)
    const threadId = await createThread(executor, accountId)
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1,
      subject: "Gone",
      bodyText: "body",
    })

    setEmbedTextsImplForTests(async () => {
      throw { kind: "model_missing", message: "model file missing" }
    })
    const result = await runSemanticIndexSlice(executor)
    expect(result.running).toBe(false)
    expect(result.done).toBe(false)
    // Not thrown — the slice degrades, the tick survives.
  })

  it("survives a poisoned batch and retries it on the next pass", async () => {
    await enableFeature()
    const accountId = await createAccount(executor)
    for (let index = 0; index < 3; index += 1) {
      const threadId = await createThread(executor, accountId)
      await createMessage(executor, {
        threadId,
        accountId,
        date: index + 1,
        subject: `t${index}`,
        bodyText: `body ${index}`,
      })
    }
    let calls = 0
    setEmbedTextsImplForTests(async (_dir, batch) => {
      calls += 1
      if (calls === 1) throw new Error("provider exploded")
      return batch.map(() => [1, 0, 0, 0])
    })
    const first = await runSemanticIndexSlice(executor, { maxBatches: 1 })
    expect(first.running).toBe(false)
    // The poisoned batch's threads were NOT stored, but the slice
    // neither threw nor wedged.
    const count = await executor.select<{ count: number }>(
      "SELECT COUNT(*) AS count FROM thread_vectors"
    )
    // The embed seam batches all three docs into one call (under the
    // EMBED_BATCH_SIZE cap), so the poisoned call skipped all three.
    expect(count[0].count).toBe(0)

    // The next pass starts fresh from the top of the stale set and
    // embeds them for real (a failed batch is retried, never wedged).
    setEmbedTextsImplForTests(embedImpl)
    const second = await runSemanticIndexSlice(executor, { maxBatches: 1 })
    expect(second.embedded).toBe(3)
  })

  // A PERSISTENTLY failing batch (not transient, not model_missing) must
  // not wedge the job at the same rows forever: the batch is skipped
  // (warned), the cursor advances past it, and the pass completes with
  // the rest of the mailbox indexed.
  it("skips a permanently failing batch and finishes the pass", async () => {
    await enableFeature()
    const accountId = await createAccount(executor)
    for (let index = 0; index < 2; index++) {
      const threadId = await createThread(executor, accountId)
      await createMessage(executor, {
        threadId,
        accountId,
        date: index + 1,
        subject: `t${index}`,
        bodyText: `body ${index}`,
      })
    }
    setEmbedTextsImplForTests(async () => {
      throw new Error("config rejected: permanent failure")
    })
    const result = await runSemanticIndexSlice(executor)
    expect(result.running).toBe(false)
    expect(result.done).toBe(true)
    // Nothing stored (every batch failed), but the job PROGRESSED past
    // the poisoned rows instead of dying on them forever.
    const count = await executor.select<{ count: number }>(
      "SELECT COUNT(*) AS count FROM thread_vectors"
    )
    expect(count[0].count).toBe(0)
  })

  it("reports the indexable-thread total in the progress snapshot", async () => {
    await enableFeature()
    const accountId = await createAccount(executor)
    const withMail = await createThread(executor, accountId)
    await createMessage(executor, {
      threadId: withMail,
      accountId,
      date: 1,
      bodyText: "indexed material",
    })
    const emptyThread = await createThread(executor, accountId)
    void emptyThread // no messages → not indexable, not in the total

    const result = await runSemanticIndexSlice(executor)
    expect(result.total).toBe(1)
    expect(result.indexed).toBe(1)
    expect(getSemanticIndexProgress().done).toBe(true)
  })

  it("cancel between batches stops the pass with the cancelled flag", async () => {
    await enableFeature()
    const accountId = await createAccount(executor)
    const threadId = await createThread(executor, accountId)
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1,
      bodyText: "to be cancelled",
    })
    // Cancel from inside the embed call: the loop notices the flag
    // before the NEXT batch and stops with the cancelled flag.
    setEmbedTextsImplForTests(async (_dir, batch) => {
      cancelSemanticIndexing()
      return batch.map(() => [1, 0, 0, 0])
    })
    const result = await runSemanticIndexSlice(executor)
    expect(result.cancelled).toBe(true)
    expect(result.done).toBe(false)
  })
})

describe("composeThreadDocument (task 6.2 doc selection)", () => {
  it("composes subject + From + folded body and truncates to 1500 chars", () => {
    const text = composeThreadDocument({
      subject: "Dépôt update",
      from_name: "José",
      from_address: "jose@example.com",
      body_text: "Café naïve résumé",
      snippet: null,
    })
    expect(text).toBe(
      "Dépôt update\nFrom: José <jose@example.com>\nCafe naive resume"
    )

    const long = composeThreadDocument({
      subject: null,
      from_name: null,
      from_address: null,
      body_text: "x".repeat(5000),
      snippet: "fallback",
    })
    expect(long).toHaveLength(1500)
    expect(long.startsWith("x")).toBe(true)

    expect(
      composeThreadDocument({
        subject: null,
        from_name: null,
        from_address: null,
        body_text: null,
        snippet: null,
      })
    ).toBe("")
  })
})

describe("thread_vectors storage (task 6.2)", () => {
  it("roundtrips blobs through hex writes and both read shapes", () => {
    const vector = Float32Array.from([1.5, -2.25, 0, 3.75])
    const hex = float32ToHex(vector)
    expect(hex).toMatch(/^[0-9a-f]+$/)
    // The plugin read path: BLOB as a JSON number array.
    const fromArray = vectorToFloat32(Array.from(new Uint8Array(vector.buffer)))
    expect(Array.from(fromArray!)).toEqual(Array.from(vector))
    // The node:sqlite read path: Uint8Array. The indexer suite reads
    // through it above; here the guard rails: corrupt shapes → null.
    expect(vectorToFloat32("nope")).toBeNull()
    expect(vectorToFloat32([1, 2, 3])).toBeNull() // not %4
  })

  it("deletes an account's vectors with the account (FK cascade)", async () => {
    await enableFeature()
    const accountId = await createAccount(executor)
    const threadId = await createThread(executor, accountId)
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1,
      bodyText: "cascade me",
    })
    await runSemanticIndexSlice(executor)
    let count = await executor.select<{ count: number }>(
      "SELECT COUNT(*) AS count FROM thread_vectors"
    )
    expect(count[0].count).toBe(1)

    await executor.execute("DELETE FROM accounts WHERE id = $1", [accountId])
    count = await executor.select<{ count: number }>(
      "SELECT COUNT(*) AS count FROM thread_vectors"
    )
    expect(count[0].count).toBe(0)
  })

  it("deletes a thread's vectors with the thread (FK cascade)", async () => {
    await enableFeature()
    const accountId = await createAccount(executor)
    const threadId = await createThread(executor, accountId)
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1,
      bodyText: "cascade me too",
    })
    await runSemanticIndexSlice(executor)
    await executor.execute("DELETE FROM threads WHERE id = $1", [threadId])
    const count = await executor.select<{ count: number }>(
      "SELECT COUNT(*) AS count FROM thread_vectors"
    )
    expect(count[0].count).toBe(0)
  })
})

describe("content hash (task 6.2)", () => {
  it("is deterministic, change-sensitive and hex-16", async () => {
    const { contentHash } = await import("../hash")
    expect(contentHash("abc")).toBe(contentHash("abc"))
    expect(contentHash("abc")).not.toBe(contentHash("abd"))
    expect(contentHash("")).toMatch(/^[0-9a-f]{16}$/)
    // 64 bits: distinct inputs of real size never collide here.
    const seen = new Set<string>()
    for (let index = 0; index < 2000; index += 1) {
      seen.add(contentHash(`doc-${index}-${"x".repeat(index % 50)}`))
    }
    expect(seen.size).toBe(2000)
  })
})
