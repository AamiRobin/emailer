import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount } from "./fixtures"
import { createTestExecutor, type TestExecutor } from "./test-executor"
import {
  assignAccountToProfile,
  createProfile,
  deleteProfile,
  listAccountColorSources,
  listProfiles,
  setAccountColorOverride,
  updateProfile,
} from "../account-profiles"

/**
 * Account profiles service tests (parity-round-2 task 4.4, design D10):
 * CRUD over account_profiles plus the assignment/override writes, against
 * the real v18 schema in node:sqlite. The spec scenarios covered:
 * "Group accounts under a profile", "Per-account override", and above all
 * "Deleting a profile — accounts keep working, no server state changes"
 * (profiles are local rows by construction, so the assertions are on the
 * accounts surviving with their references cleared and their overrides
 * intact).
 */

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
})

afterEach(() => {
  executor.close()
})

describe("account profiles service", () => {
  it("creates, lists and updates profiles", async () => {
    const created = await createProfile(executor, {
      name: "Work",
      color: "#8b5cf6",
    })
    // App-generated UUID, defaults filled.
    expect(created.id).toBeTruthy()
    expect(created).toMatchObject({ name: "Work", color: "#8b5cf6" })
    expect(created.created_at).toBeGreaterThan(0)

    await createProfile(executor, { name: "alpha", color: "#22c55e" })
    // listProfiles sorts case-insensitively by name.
    const profiles = await listProfiles(executor)
    expect(profiles.map((profile) => profile.name)).toEqual([
      "alpha",
      "Work",
    ])

    await updateProfile(executor, created.id, {
      name: "Work stuff",
      color: "#ef4444",
    })
    const renamed = await listProfiles(executor)
    expect(renamed.map((profile) => profile.name)).toEqual([
      "alpha",
      "Work stuff",
    ])
    expect(
      renamed.find((profile) => profile.id === created.id)?.color
    ).toBe("#ef4444")

    // A name-only patch leaves the color alone.
    await updateProfile(executor, created.id, { name: "Work" })
    const after = await listProfiles(executor)
    expect(
      after.find((profile) => profile.id === created.id)
    ).toMatchObject({ name: "Work", color: "#ef4444" })
  })

  it("assigns, moves and unassigns accounts, tracking overrides", async () => {
    const accountA = await createAccount(executor)
    const accountB = await createAccount(executor)
    const work = await createProfile(executor, { name: "Work", color: "#8b5cf6" })
    const personal = await createProfile(executor, {
      name: "Personal",
      color: "#22c55e",
    })

    await assignAccountToProfile(executor, accountA, work.id)
    await assignAccountToProfile(executor, accountB, work.id)
    await setAccountColorOverride(executor, accountB, "#f97316")

    let sources = await listAccountColorSources(executor)
    expect(sources).toEqual([
      {
        account_id: accountA,
        profile_id: work.id,
        color_override: null,
        profile_color: "#8b5cf6",
      },
      {
        account_id: accountB,
        profile_id: work.id,
        color_override: "#f97316",
        profile_color: "#8b5cf6",
      },
    ])

    // Moving an account between profiles is the same write.
    await assignAccountToProfile(executor, accountA, personal.id)
    sources = await listAccountColorSources(executor)
    expect(sources.find((entry) => entry.account_id === accountA)).toMatchObject(
      { profile_id: personal.id, profile_color: "#22c55e" }
    )

    // Unassign (null) and clear the override.
    await assignAccountToProfile(executor, accountB, null)
    await setAccountColorOverride(executor, accountB, null)
    sources = await listAccountColorSources(executor)
    expect(sources.find((entry) => entry.account_id === accountB)).toEqual({
      account_id: accountB,
      profile_id: null,
      color_override: null,
      profile_color: null,
    })
  })

  it("deleting a profile keeps its accounts working and clears references", async () => {
    const accountA = await createAccount(executor)
    const accountB = await createAccount(executor)
    const work = await createProfile(executor, { name: "Work", color: "#8b5cf6" })
    await assignAccountToProfile(executor, accountA, work.id)
    await assignAccountToProfile(executor, accountB, work.id)
    // The override is the account's INDIVIDUAL color — it must survive.
    await setAccountColorOverride(executor, accountA, "#f97316")

    await deleteProfile(executor, work.id)

    // The profile row is gone…
    expect(await listProfiles(executor)).toEqual([])
    // …both accounts survive with their references cleared…
    const accounts = await executor.select<{
      id: string
      profile_id: string | null
      color_override: string | null
    }>("SELECT id, profile_id, color_override FROM accounts ORDER BY id ASC")
    expect(accounts).toEqual([
      { id: accountA, profile_id: null, color_override: "#f97316" },
      { id: accountB, profile_id: null, color_override: null },
    ])
    // …and the color sources now read as unassigned (the effective color
    // falls back to the individual/generated color in the store).
    const sources = await listAccountColorSources(executor)
    expect(sources.every((entry) => entry.profile_id === null)).toBe(true)
    expect(sources.every((entry) => entry.profile_color === null)).toBe(true)
  })

  it("deleting an account leaves profiles and other accounts untouched", async () => {
    const accountA = await createAccount(executor)
    const accountB = await createAccount(executor)
    const work = await createProfile(executor, { name: "Work", color: "#8b5cf6" })
    await assignAccountToProfile(executor, accountA, work.id)
    await assignAccountToProfile(executor, accountB, work.id)

    // Account removal cascades its mail but must not delete the profile
    // (the FK is on accounts pointing at profiles, not the reverse) —
    // profiles are the stable grouping, like the reference's
    // remove_account which only detaches the deleted account.
    await executor.execute("DELETE FROM accounts WHERE id = $1", [accountA])

    expect(await listProfiles(executor)).toHaveLength(1)
    const sources = await listAccountColorSources(executor)
    expect(sources.map((entry) => entry.account_id)).toEqual([accountB])
    expect(sources[0]?.profile_id).toBe(work.id)
  })
})
