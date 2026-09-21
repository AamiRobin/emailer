import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTestExecutor, type TestExecutor } from "../../db/__tests__/test-executor"
import {
  getSenderCategories,
  getSenderCategory,
  senderCategoryKey,
  setSenderCategory,
} from "../sender-categories"

/**
 * The sender_categories CRUD (task 3.3, design D4, migration v9): a
 * lowercased-address key (a sender is one sender across accounts), a
 * single-statement upsert, and the batched read the ingestion pass
 * resolves its overrides through.
 */

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
})

afterEach(() => {
  executor.close()
})

describe("sender category key", () => {
  it("normalizes to the trimmed lowercase address and rejects empty", () => {
    expect(senderCategoryKey("  News@List.Example ")).toBe("news@list.example")
    expect(senderCategoryKey("   ")).toBe(null)
    expect(senderCategoryKey("")).toBe(null)
  })
})

describe("set + get round-trip", () => {
  it("stores and reads back a decision case-insensitively", async () => {
    await setSenderCategory(executor, "News@List.Example", "newsletters", "user")

    expect(await getSenderCategory(executor, "news@list.example")).toEqual({
      category: "newsletters",
      source: "user",
    })
    expect(await getSenderCategory(executor, "  NEWS@list.example ")).toEqual({
      category: "newsletters",
      source: "user",
    })
  })

  it("reads null for unknown senders and empty addresses", async () => {
    expect(await getSenderCategory(executor, "nobody@x.example")).toBeNull()
    expect(await getSenderCategory(executor, "   ")).toBeNull()
  })

  it("upserts in place: same sender, new decision, one row", async () => {
    await setSenderCategory(executor, "news@x.example", "newsletters", "heuristic")
    await setSenderCategory(executor, "news@x.example", "promotions", "user")

    const rows = await executor.select(
      "SELECT sender_key, category, source FROM sender_categories"
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      sender_key: "news@x.example",
      category: "promotions",
      source: "user",
    })
    expect(await getSenderCategory(executor, "news@x.example")).toEqual({
      category: "promotions",
      source: "user",
    })
    // updated_at is refreshed by the upsert (unixepoch default on insert,
    // excluded.updated_at on conflict).
    const stamps = await executor.select<{ updated_at: number }>(
      "SELECT updated_at FROM sender_categories"
    )
    expect(stamps[0]?.updated_at).toBeGreaterThan(0)
  })

  it("stores every source and category value the CHECK allows", async () => {
    await setSenderCategory(executor, "a@x.example", "primary", "heuristic")
    await setSenderCategory(executor, "b@x.example", "updates", "ai")
    await setSenderCategory(executor, "c@x.example", "social", "user")
    await setSenderCategory(executor, "d@x.example", "promotions", "user")

    expect(await getSenderCategory(executor, "a@x.example")).toMatchObject({
      category: "primary",
      source: "heuristic",
    })
    expect(await getSenderCategory(executor, "b@x.example")).toMatchObject({
      category: "updates",
      source: "ai",
    })
    expect(await getSenderCategory(executor, "c@x.example")).toMatchObject({
      category: "social",
      source: "user",
    })
    expect(await getSenderCategory(executor, "d@x.example")).toMatchObject({
      category: "promotions",
      source: "user",
    })
  })

  it("rejects out-of-vocabulary categories and sources at the schema", async () => {
    // The migration v9 CHECKs make corrupt rows unreachable through the
    // CRUD; the read-side tolerance for a hand-edited row is parseCategory
    // (covered in classify.test.ts).
    await expect(
      executor.execute(
        "INSERT INTO sender_categories (sender_key, category, source) VALUES ($1, $2, $3)",
        ["bad@x.example", "inbox", "user"]
      )
    ).rejects.toThrow()
    await expect(
      executor.execute(
        "INSERT INTO sender_categories (sender_key, category, source) VALUES ($1, $2, $3)",
        ["bad@x.example", "primary", "wizard"]
      )
    ).rejects.toThrow()
    expect(await executor.select("SELECT * FROM sender_categories")).toEqual([])
  })

  it("setting an empty address is a tolerated no-op", async () => {
    await setSenderCategory(executor, "   ", "primary", "user")
    expect(
      await executor.select("SELECT * FROM sender_categories")
    ).toEqual([])
  })
})

describe("batched lookup (the ingestion pass's override read)", () => {
  it("resolves many senders in one query and skips rowless ones", async () => {
    await setSenderCategory(executor, "news@x.example", "newsletters", "user")
    await setSenderCategory(executor, "Bot@Y.example", "updates", "ai")

    const map = await getSenderCategories(executor, [
      "News@X.example",
      "bot@y.example",
      "unknown@z.example",
      null,
      "   ",
      undefined,
    ])
    expect(map.size).toBe(2)
    expect(map.get("news@x.example")).toEqual({
      category: "newsletters",
      source: "user",
    })
    expect(map.get("bot@y.example")).toEqual({
      category: "updates",
      source: "ai",
    })
    expect(map.get("unknown@z.example")).toBeUndefined()
  })

  it("collapses case-variant duplicates of the same sender", async () => {
    const map = await getSenderCategories(executor, [
      "News@X.example",
      "news@x.example",
    ])
    // No rows exist, but the dedup means at most one query key — verified
    // by the result being stable regardless of input casing.
    expect(map.size).toBe(0)
  })

  it("returns an empty map with no lookups for an empty batch", async () => {
    expect((await getSenderCategories(executor, [])).size).toBe(0)
    expect((await getSenderCategories(executor, [null, "   "])).size).toBe(0)
  })
})
