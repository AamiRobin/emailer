import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  deleteWritingStyleProfile,
  getWritingStyleProfile,
  saveWritingStyleProfile,
} from "../writing-style"
import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"

/**
 * Writing-style profile tests (task 4.3, design D2): one row per account
 * against the real v10 `writing_style_profiles` table (node:sqlite). The
 * profile payload is opaque JSON here — its schema belongs to the
 * style-analysis caller (task 4.5).
 */

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
})

afterEach(() => {
  executor.close()
})

describe("getWritingStyleProfile", () => {
  it("returns null for an account with no stored profile", async () => {
    const accountId = await createAccount(executor)
    expect(await getWritingStyleProfile(executor, accountId)).toBeNull()
  })

  it("round-trips the decoded profile with builtAt and sampleSize", async () => {
    const accountId = await createAccount(executor)
    await saveWritingStyleProfile(
      executor,
      accountId,
      JSON.stringify({ tone: "direct", greetings: ["Hi"] }),
      42,
      () => 1_700_000_500
    )

    const stored = await getWritingStyleProfile<{
      tone: string
      greetings: string[]
    }>(executor, accountId)
    expect(stored).toEqual({
      profile: { tone: "direct", greetings: ["Hi"] },
      builtAt: 1_700_000_500,
      sampleSize: 42,
    })
  })

  it("treats a corrupt (non-JSON) row as absent instead of throwing", async () => {
    const accountId = await createAccount(executor)
    await executor.execute(
      "INSERT INTO writing_style_profiles (account_id, profile_json, built_at, sample_size) VALUES ($1, $2, $3, $4)",
      [accountId, "{not json", 1, 1]
    )

    expect(await getWritingStyleProfile(executor, accountId)).toBeNull()
  })
})

describe("saveWritingStyleProfile", () => {
  it("upserts: the rebuild replaces the row and keeps exactly one per account", async () => {
    const accountId = await createAccount(executor)
    await saveWritingStyleProfile(executor, accountId, '{"v":1}', 10, () => 1)
    await saveWritingStyleProfile(executor, accountId, '{"v":2}', 25, () => 2)

    const stored = await getWritingStyleProfile(executor, accountId)
    expect(stored).toEqual({
      profile: { v: 2 },
      builtAt: 2,
      sampleSize: 25,
    })
    const rows = await executor.select(
      "SELECT * FROM writing_style_profiles"
    )
    expect(rows).toHaveLength(1)
  })

  it("stores profiles per account independently", async () => {
    const first = await createAccount(executor)
    const second = await createAccount(executor)
    await saveWritingStyleProfile(executor, first, '{"who":"first"}', 3)
    await saveWritingStyleProfile(executor, second, '{"who":"second"}', 7)

    expect(
      (await getWritingStyleProfile(executor, first))?.profile
    ).toEqual({ who: "first" })
    expect(
      (await getWritingStyleProfile(executor, second))?.profile
    ).toEqual({ who: "second" })
  })
})

describe("deleteWritingStyleProfile", () => {
  it("removes the account's row and leaves other accounts untouched", async () => {
    const removed = await createAccount(executor)
    const kept = await createAccount(executor)
    await saveWritingStyleProfile(executor, removed, '{"v":1}', 1)
    await saveWritingStyleProfile(executor, kept, '{"v":2}', 2)

    await deleteWritingStyleProfile(executor, removed)

    expect(await getWritingStyleProfile(executor, removed)).toBeNull()
    expect(
      (await getWritingStyleProfile(executor, kept))?.profile
    ).toEqual({ v: 2 })
  })

  it("is a no-op when no profile is stored", async () => {
    const accountId = await createAccount(executor)
    await expect(
      deleteWritingStyleProfile(executor, accountId)
    ).resolves.toBeUndefined()
  })
})
