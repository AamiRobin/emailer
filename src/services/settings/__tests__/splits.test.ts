import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  createSplit,
  deleteSplit,
  listSplits,
  moveSplit,
  renameSplit,
  setSplitHidden,
  SPLITS_SETTING_KEY,
} from "../splits"

/**
 * Splits CRUD tests (task 9.3): round-trips against the real settings
 * table (node:sqlite) — one JSON row under `mail.splits`, read back
 * through the same validating reader the tab bar uses.
 */

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
})

afterEach(() => {
  executor.close()
})

async function names(): Promise<string[]> {
  return (await listSplits(executor)).map((split) => split.name)
}

describe("splits CRUD (task 9.3)", () => {
  it("defaults to no splits", async () => {
    expect(await listSplits(executor)).toEqual([])
  })

  it("creates splits appended in tab order with dense positions", async () => {
    const first = await createSplit(executor, {
      name: "Unread",
      query: "is:unread",
    })
    const second = await createSplit(executor, {
      name: "Boss",
      query: "from:boss@work.com",
      accountId: "acc-1",
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    expect(await listSplits(executor)).toEqual([
      {
        id: first.ok ? first.split.id : "",
        name: "Unread",
        query: "is:unread",
        position: 0,
      },
      {
        id: second.ok ? second.split.id : "",
        name: "Boss",
        query: "from:boss@work.com",
        accountId: "acc-1",
        position: 1,
      },
    ])
  })

  it("rejects duplicate names case-insensitively (hidden ones too) and empty names", async () => {
    const created = await createSplit(executor, {
      name: "Unread",
      query: "is:unread",
    })
    expect(await createSplit(executor, { name: "unread", query: "x" })).toEqual(
      { ok: false, error: "name-taken" }
    )
    expect(
      await createSplit(executor, { name: "  UNREAD ", query: "x" })
    ).toEqual({ ok: false, error: "name-taken" })
    expect(await createSplit(executor, { name: "   ", query: "x" })).toEqual({
      ok: false,
      error: "name-required",
    })
    expect(await createSplit(executor, { name: "", query: "x" })).toEqual({
      ok: false,
      error: "name-required",
    })

    // Hidden splits keep claiming their name: unhiding must not produce
    // a duplicate tab name.
    if (!created.ok) throw new Error("seed failed")
    await setSplitHidden(executor, created.split.id, true)
    expect(await createSplit(executor, { name: "Unread", query: "x" })).toEqual(
      { ok: false, error: "name-taken" }
    )
  })

  it("renames in place, keeping order and enforcing uniqueness", async () => {
    const a = await createSplit(executor, { name: "A", query: "qa" })
    const b = await createSplit(executor, { name: "B", query: "qb" })
    if (!a.ok || !b.ok) throw new Error("seed failed")

    const renamed = await renameSplit(executor, b.split.id, "  Bee  ")
    expect(renamed).toEqual({
      ok: true,
      split: { ...b.split, name: "Bee" },
    })
    expect(await names()).toEqual(["A", "Bee"])

    expect(await renameSplit(executor, b.split.id, "a")).toEqual({
      ok: false,
      error: "name-taken",
    })
    expect(await renameSplit(executor, b.split.id, " ")).toEqual({
      ok: false,
      error: "name-required",
    })
  })

  it("hides and unhides without losing the tab order", async () => {
    const a = await createSplit(executor, { name: "A", query: "qa" })
    const b = await createSplit(executor, { name: "B", query: "qb" })
    const c = await createSplit(executor, { name: "C", query: "qc" })
    if (!a.ok || !b.ok || !c.ok) throw new Error("seed failed")

    await setSplitHidden(executor, a.split.id, true)
    const stored = await listSplits(executor)
    expect(stored.map((split) => [split.name, split.hidden])).toEqual([
      ["A", true],
      ["B", undefined],
      ["C", undefined],
    ])
    // The reader keeps positions, so unhiding restores the original slot.
    await setSplitHidden(executor, a.split.id, false)
    expect(await names()).toEqual(["A", "B", "C"])
  })

  it("moves left/right within the visible tabs, skipping hidden neighbours", async () => {
    const a = await createSplit(executor, { name: "A", query: "qa" })
    const b = await createSplit(executor, { name: "B", query: "qb" })
    const c = await createSplit(executor, { name: "C", query: "qc" })
    if (!a.ok || !b.ok || !c.ok) throw new Error("seed failed")

    // Edge moves are no-ops.
    await moveSplit(executor, a.split.id, -1)
    expect(await names()).toEqual(["A", "B", "C"])
    await moveSplit(executor, c.split.id, 1)
    expect(await names()).toEqual(["A", "B", "C"])

    await moveSplit(executor, b.split.id, 1)
    expect(await names()).toEqual(["A", "C", "B"])
    await moveSplit(executor, b.split.id, -1)
    expect(await names()).toEqual(["A", "B", "C"])

    // A hidden neighbour is skipped: hiding C leaves [A, B] visible and
    // moving A right swaps it with B, not with the hidden C.
    await setSplitHidden(executor, c.split.id, true)
    await moveSplit(executor, a.split.id, 1)
    expect(await names()).toEqual(["B", "A", "C"])
  })

  it("deletes a split and leaves the others intact", async () => {
    const a = await createSplit(executor, { name: "A", query: "qa" })
    const b = await createSplit(executor, { name: "B", query: "qb" })
    if (!a.ok || !b.ok) throw new Error("seed failed")

    await deleteSplit(executor, a.split.id)
    const remaining = await listSplits(executor)
    expect(remaining.map((split) => split.name)).toEqual(["B"])
    expect(remaining[0]!.position).toBe(0)
    expect(await listSplits(executor)).toHaveLength(1)

    // Deleting an unknown id is a no-op.
    await deleteSplit(executor, "nope")
    expect(await names()).toEqual(["B"])
  })

  it("drops corrupt stored entries instead of throwing", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [
        SPLITS_SETTING_KEY,
        JSON.stringify([
          { id: "s-1", name: "Good", query: "is:unread", position: 0 },
          { id: 42, name: "Bad id" },
          null,
          { id: "s-3", name: "Bad position", query: "q", position: "zero" },
        ]),
      ]
    )
    expect(await names()).toEqual(["Good"])

    // A non-array row means "no splits", not a crash.
    await executor.execute("UPDATE settings SET value = $1 WHERE key = $2", [
      JSON.stringify({ oops: true }),
      SPLITS_SETTING_KEY,
    ])
    expect(await listSplits(executor)).toEqual([])
  })
})
