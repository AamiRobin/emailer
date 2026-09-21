import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  aiCacheStats,
  cacheKey,
  clearAiCache,
  clearAiCacheAll,
  getAiCache,
  putAiCache,
  purgeAiCacheForAccount,
  removeAiCacheEntry,
  sha256Hex,
  type CacheKeyHasher,
} from "../cache"
import { saveWritingStyleProfile } from "../writing-style"
import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"

/**
 * AI cache tests (task 4.3, design D2): round-trips against the real v10
 * `ai_cache` table (node:sqlite). The reuse contract is proven here at the
 * storage level — the same identity reads back its stored output with no
 * second put; the no-second-provider-call guarantee itself lives in the
 * callers' suites, which stub the provider command and assert on call
 * counts.
 */

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
})

afterEach(() => {
  executor.close()
})

/**
 * Deterministic stand-in for sha-256 (tiny FNV-1a): all the cache
 * contract needs is "same serialized identity in, same digest out", which
 * the stub pins without depending on WebCrypto availability.
 */
const stubHasher: CacheKeyHasher = async (key) => {
  let hash = 0x811c9dc5
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

describe("cacheKey", () => {
  it("is deterministic for identical identity fields", async () => {
    const parts = {
      provider: "anthropic",
      model: "claude-sonnet",
      kind: "summary",
      input: "message-ids: [a, b]",
    }
    expect(await cacheKey(parts, stubHasher)).toBe(
      await cacheKey(parts, stubHasher)
    )
  })

  it("defaults to sha-256 (64-char lowercase hex)", async () => {
    const key = await cacheKey({
      provider: "openai",
      model: "gpt",
      kind: "categorization",
      input: "sender@example.com",
    })
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })

  it("matches the sha-256 test vector through the default hasher", async () => {
    // sha256("abc") — guards against an accidentally-weakened default.
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    )
  })

  it("differs when only the kind differs (collision-free identity)", async () => {
    const base = {
      provider: "anthropic",
      model: "claude-sonnet",
      input: "same-input",
    }
    expect(await cacheKey({ ...base, kind: "summary" }, stubHasher)).not.toBe(
      await cacheKey({ ...base, kind: "reply" }, stubHasher)
    )
  })

  it("differs when only the input, model or provider differs", async () => {
    const base = { provider: "p", model: "m", kind: "k", input: "in" }
    const variants = [
      { ...base, provider: "q" },
      { ...base, model: "n" },
      { ...base, input: "out" },
    ]
    const baseKey = await cacheKey(base, stubHasher)
    for (const variant of variants) {
      expect(await cacheKey(variant, stubHasher)).not.toBe(baseKey)
    }
  })

  it("keeps the \x1f join collision-free when fields contain the separator", async () => {
    // JSON escapes control characters, so a raw \x1f can never occur
    // inside a serialized field — shifted separator placements cannot
    // alias.
    const aliasedA = await cacheKey(
      { provider: "a", model: "b\x1fc", kind: "k", input: "x" },
      stubHasher
    )
    const aliasedB = await cacheKey(
      { provider: "a\x1fb", model: "c", kind: "k", input: "x" },
      stubHasher
    )
    expect(aliasedA).not.toBe(aliasedB)
  })
})

describe("getAiCache / putAiCache", () => {
  const identity = {
    provider: "anthropic",
    model: "claude-sonnet",
    kind: "summary",
    input: "thread: m1,m2",
  }

  it("returns null for an identity never stored", async () => {
    expect(await getAiCache(executor, identity, stubHasher)).toBeNull()
  })

  it("stores an output and reuses it on an identical identity", async () => {
    await putAiCache(executor, { ...identity, output: "the summary" }, stubHasher)

    // Reuse contract: the second read returns the stored output with no
    // second put in between.
    expect(await getAiCache(executor, identity, stubHasher)).toBe("the summary")
    expect(await getAiCache(executor, identity, stubHasher)).toBe("the summary")
  })

  it("misses when model, kind, provider or input differ", async () => {
    await putAiCache(executor, { ...identity, output: "cached" }, stubHasher)

    expect(
      await getAiCache(
        executor,
        { ...identity, model: "claude-haiku" },
        stubHasher
      )
    ).toBeNull()
    expect(
      await getAiCache(executor, { ...identity, kind: "reply" }, stubHasher)
    ).toBeNull()
    expect(
      await getAiCache(
        executor,
        { ...identity, provider: "openai" },
        stubHasher
      )
    ).toBeNull()
    expect(
      await getAiCache(executor, { ...identity, input: "other" }, stubHasher)
    ).toBeNull()
  })

  it("keeps one row per identity, replacing the output on a re-put", async () => {
    await putAiCache(
      executor,
      { ...identity, output: "v1", accountId: null, now: () => 100 },
      stubHasher
    )
    await putAiCache(
      executor,
      { ...identity, output: "v2", now: () => 200 },
      stubHasher
    )

    expect(await getAiCache(executor, identity, stubHasher)).toBe("v2")
    const rows = await executor.select<{ created_at: number }>(
      "SELECT created_at FROM ai_cache"
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.created_at).toBe(200)
  })

  it("round-trips the account provenance without it affecting the key", async () => {
    const accountId = await createAccount(executor)
    await putAiCache(
      executor,
      { ...identity, output: "cached", accountId, now: () => 5 },
      stubHasher
    )

    const rows = await executor.select<{ account_id: string | null }>(
      "SELECT account_id FROM ai_cache"
    )
    expect(rows[0]?.account_id).toBe(accountId)
    // Same identity, different account context: still a hit — the key is
    // pure content.
    expect(await getAiCache(executor, identity, stubHasher)).toBe("cached")
  })
})

describe("removeAiCacheEntry", () => {
  it("removes exactly the referenced row", async () => {
    const a = {
      provider: "anthropic",
      model: "m",
      kind: "summary",
      input: "a",
    }
    const b = { ...a, input: "b" }
    await putAiCache(executor, { ...a, output: "A" }, stubHasher)
    await putAiCache(executor, { ...b, output: "B" }, stubHasher)

    await removeAiCacheEntry(executor, {
      provider: a.provider,
      model: a.model,
      inputHash: await cacheKey(a, stubHasher),
    })

    expect(await getAiCache(executor, a, stubHasher)).toBeNull()
    expect(await getAiCache(executor, b, stubHasher)).toBe("B")
  })

  it("is a no-op for an unknown hash", async () => {
    await expect(
      removeAiCacheEntry(executor, {
        provider: "p",
        model: "m",
        inputHash: "missing",
      })
    ).resolves.toBeUndefined()
  })
})

describe("clearAiCache / clearAiCacheAll", () => {
  it("clears only the given account's rows, keeping others and unattributed rows", async () => {
    const removed = await createAccount(executor)
    const kept = await createAccount(executor)
    await putAiCache(
      executor,
      {
        provider: "p",
        model: "m",
        kind: "summary",
        input: "removed",
        output: "r",
        accountId: removed,
      },
      stubHasher
    )
    await putAiCache(
      executor,
      {
        provider: "p",
        model: "m",
        kind: "summary",
        input: "kept",
        output: "k",
        accountId: kept,
      },
      stubHasher
    )
    await putAiCache(
      executor,
      {
        provider: "p",
        model: "m",
        kind: "categorization",
        input: "sender@x",
        output: "primary",
      },
      stubHasher
    )

    await clearAiCache(executor, removed)

    const rows = await executor.select<{ output: string }>(
      "SELECT output FROM ai_cache ORDER BY output ASC"
    )
    expect(rows.map((row) => row.output)).toEqual(["k", "primary"])
  })

  it("clears every row when no account is given", async () => {
    await putAiCache(
      executor,
      {
        provider: "p",
        model: "m",
        kind: "summary",
        input: "a",
        output: "A",
      },
      stubHasher
    )
    await clearAiCache(executor)
    expect(await aiCacheStats(executor)).toMatchObject({ total: 0 })
  })

  it("clears every row via the explicit bulk entry point", async () => {
    await putAiCache(
      executor,
      { provider: "p", model: "m", kind: "summary", input: "a", output: "A" },
      stubHasher
    )
    await clearAiCacheAll(executor)
    const rows = await executor.select("SELECT * FROM ai_cache")
    expect(rows).toHaveLength(0)
  })
})

describe("aiCacheStats", () => {
  it("reports zero totals on an empty cache", async () => {
    expect(await aiCacheStats(executor)).toEqual({ total: 0, byKind: [] })
  })

  it("aggregates counts and the created_at range per kind", async () => {
    await putAiCache(
      executor,
      {
        provider: "p",
        model: "m",
        kind: "summary",
        input: "a",
        output: "A",
        now: () => 100,
      },
      stubHasher
    )
    await putAiCache(
      executor,
      {
        provider: "p",
        model: "m",
        kind: "summary",
        input: "b",
        output: "B",
        now: () => 300,
      },
      stubHasher
    )
    await putAiCache(
      executor,
      {
        provider: "p",
        model: "m",
        kind: "categorization",
        input: "sender@x",
        output: "primary",
        now: () => 200,
      },
      stubHasher
    )

    const stats = await aiCacheStats(executor)
    expect(stats.total).toBe(3)
    // Ordered by count desc, then kind asc.
    expect(stats.byKind).toEqual([
      { kind: "summary", count: 2, oldest_at: 100, newest_at: 300 },
      { kind: "categorization", count: 1, oldest_at: 200, newest_at: 200 },
    ])
  })
})

describe("purgeAiCacheForAccount", () => {
  it("deletes the account's cache rows and style profile, leaving others intact", async () => {
    const removed = await createAccount(executor)
    const kept = await createAccount(executor)
    await putAiCache(
      executor,
      {
        provider: "p",
        model: "m",
        kind: "summary",
        input: "removed-thread",
        output: "r",
        accountId: removed,
      },
      stubHasher
    )
    await putAiCache(
      executor,
      {
        provider: "p",
        model: "m",
        kind: "summary",
        input: "kept-thread",
        output: "k",
        accountId: kept,
      },
      stubHasher
    )
    await saveWritingStyleProfile(executor, removed, '{"tone":"formal"}', 3)
    await saveWritingStyleProfile(executor, kept, '{"tone":"casual"}', 5)

    await purgeAiCacheForAccount(executor, removed)

    const cacheRows = await executor.select<{ output: string }>(
      "SELECT output FROM ai_cache"
    )
    expect(cacheRows.map((row) => row.output)).toEqual(["k"])
    const profiles = await executor.select<{ account_id: string }>(
      "SELECT account_id FROM writing_style_profiles"
    )
    expect(profiles.map((row) => row.account_id)).toEqual([kept])
  })

  it("keeps unattributed cache rows (no account provenance)", async () => {
    await putAiCache(
      executor,
      {
        provider: "p",
        model: "m",
        kind: "categorization",
        input: "sender@x",
        output: "newsletters",
      },
      stubHasher
    )

    await purgeAiCacheForAccount(executor, "no-such-account")

    expect(await aiCacheStats(executor)).toMatchObject({ total: 1 })
  })
})
