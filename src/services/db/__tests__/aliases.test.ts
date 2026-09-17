import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  AliasValidationError,
  deleteAlias,
  getSendAsAliases,
  listAliases,
  setDefaultAlias,
  updateAlias,
  upsertManualAlias,
  upsertSyncedAlias,
} from "../aliases"
import { createAccount } from "./fixtures"
import { createTestExecutor, type TestExecutor } from "./test-executor"

describe("alias queries (task 16.1, design D10)", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("upserts a manual alias with a generated id and lowercase email", async () => {
    const accountId = await createAccount(executor, "imap")

    const id = await upsertManualAlias(executor, accountId, {
      email: "Sender.Example@Gmail.com",
      displayName: "Work sender",
    })

    const rows = await listAliases(executor, accountId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id,
      account_id: accountId,
      email: "sender.example@gmail.com",
      display_name: "Work sender",
      is_default: 0,
      source: "imap",
    })
    expect(typeof rows[0]?.created_at).toBe("number")
  })

  it("rejects manual aliases with a malformed address", async () => {
    const accountId = await createAccount(executor, "imap")

    await expect(
      upsertManualAlias(executor, accountId, { email: "not-an-address" })
    ).rejects.toBeInstanceOf(AliasValidationError)
    await expect(
      upsertManualAlias(executor, accountId, { email: "a b@example.com" })
    ).rejects.toBeInstanceOf(AliasValidationError)
    await expect(
      upsertManualAlias(executor, accountId, { email: "missing@tld" })
    ).rejects.toBeInstanceOf(AliasValidationError)
    expect(await listAliases(executor, accountId)).toHaveLength(0)
  })

  it("a repeat upsert of the same email updates in place instead of duplicating", async () => {
    const accountId = await createAccount(executor, "imap")
    const first = await upsertManualAlias(executor, accountId, {
      email: "work@example.com",
      displayName: "Old name",
    })

    const second = await upsertManualAlias(executor, accountId, {
      email: "WORK@example.com",
      displayName: "New name",
    })

    expect(second).toBe(first)
    const rows = await listAliases(executor, accountId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      email: "work@example.com",
      display_name: "New name",
      source: "imap",
    })
  })

  it("setDefaultAlias leaves exactly one default per account", async () => {
    const accountId = await createAccount(executor, "imap")
    const a = await upsertManualAlias(executor, accountId, {
      email: "a@example.com",
    })
    await upsertManualAlias(executor, accountId, {
      email: "b@example.com",
      isDefault: true,
    })
    expect(
      (await getSendAsAliases(executor, accountId)).map((row) => [
        row.email,
        row.is_default,
      ])
    ).toEqual([
      ["b@example.com", 1],
      ["a@example.com", 0],
    ])

    // Moving the default clears the previous one in the same sweep.
    await setDefaultAlias(executor, accountId, a)
    const byEmail = new Map(
      (await listAliases(executor, accountId)).map((row) => [
        row.email,
        row.is_default,
      ])
    )
    // SQL order is nondeterministic within the insert second; the values
    // are what the invariant is about.
    expect(byEmail.get("a@example.com")).toBe(1)
    expect(byEmail.get("b@example.com")).toBe(0)

    // Defaults are per account: another account's rows are untouched.
    const other = await createAccount(executor, "imap")
    const otherAlias = await upsertManualAlias(executor, other, {
      email: "solo@example.com",
      isDefault: true,
    })
    await setDefaultAlias(executor, accountId, a)
    const otherRows = await listAliases(executor, other)
    expect(otherRows.map((row) => row.is_default)).toEqual([1])
    expect(otherRows[0]?.id).toBe(otherAlias)
  })

  it("getSendAsAliases orders default first, then case-insensitive alphabetical", async () => {
    const accountId = await createAccount(executor, "imap")
    const mid = await upsertManualAlias(executor, accountId, {
      email: "mid@example.com",
      isDefault: true,
    })
    await upsertManualAlias(executor, accountId, { email: "zeta@example.com" })
    await upsertManualAlias(executor, accountId, { email: "Alpha@example.com" })
    await upsertManualAlias(executor, accountId, { email: "beta@example.com" })

    expect(
      (await getSendAsAliases(executor, accountId)).map((row) => row.email)
    ).toEqual([
      "mid@example.com",
      "alpha@example.com",
      "beta@example.com",
      "zeta@example.com",
    ])
    void mid
  })

  it("updateAlias patches the display name and moves the default", async () => {
    const accountId = await createAccount(executor, "imap")
    const a = await upsertManualAlias(executor, accountId, {
      email: "a@example.com",
      isDefault: true,
    })
    const b = await upsertManualAlias(executor, accountId, {
      email: "b@example.com",
    })

    await updateAlias(executor, b, { displayName: "B team", isDefault: true })
    const byEmail = new Map(
      (await listAliases(executor, accountId)).map((row) => [row.email, row])
    )
    // Insertion order is nondeterministic within one second (random ids);
    // compare by email.
    expect(byEmail.get("a@example.com")).toMatchObject({
      display_name: null,
      is_default: 0,
    })
    expect(byEmail.get("b@example.com")).toMatchObject({
      display_name: "B team",
      is_default: 1,
    })

    // Clearing a default leaves the account with none (composer falls
    // back to the bare identity).
    await updateAlias(executor, b, { isDefault: false })
    expect(
      await listAliases(executor, accountId).then(
        (rows) => rows.filter((row) => row.is_default === 1).length
      )
    ).toBe(0)
    void a
  })

  it("deleteAlias removes the row; unknown ids are a no-op", async () => {
    const accountId = await createAccount(executor, "imap")
    const id = await upsertManualAlias(executor, accountId, {
      email: "gone@example.com",
    })
    await upsertManualAlias(executor, accountId, { email: "kept@example.com" })

    await deleteAlias(executor, id)
    await deleteAlias(executor, "missing-id")

    expect(
      (await listAliases(executor, accountId)).map((row) => row.email)
    ).toEqual(["kept@example.com"])
  })

  it("upsertSyncedAlias writes gmail rows and never modifies manual rows", async () => {
    const accountId = await createAccount(executor, "gmail")
    // A manual row squatting on the address the API will also report,
    // holding the account default.
    await upsertManualAlias(executor, accountId, {
      email: "shared@example.com",
      displayName: "Manual wins",
      isDefault: true,
    })

    const synced = await upsertSyncedAlias(executor, accountId, {
      email: "Shared@Example.com",
      displayName: "API name",
      isDefault: true,
    })

    // The collision leaves the manual row untouched (null = no gmail row):
    // name AND default all survive the sync's upsert attempt.
    expect(synced).toBeNull()
    const shared = (await listAliases(executor, accountId)).find(
      (row) => row.email === "shared@example.com"
    )
    expect(shared).toMatchObject({
      source: "imap",
      display_name: "Manual wins",
      is_default: 1,
    })

    // A fresh address becomes a gmail-sourced row.
    const created = await upsertSyncedAlias(executor, accountId, {
      email: "api@example.com",
      displayName: "From API",
    })
    const rows = await listAliases(executor, accountId, "gmail")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(created)
    expect(rows[0]).toMatchObject({
      email: "api@example.com",
      display_name: "From API",
      is_default: 0,
      source: "gmail",
    })

    // A second call updates the same gmail row (case-insensitive email).
    const updated = await upsertSyncedAlias(executor, accountId, {
      email: "API@example.com",
      displayName: "Renamed",
      isDefault: true,
    })
    expect(updated).toBe(created)
    expect(await listAliases(executor, accountId, "gmail")).toHaveLength(1)
    expect((await listAliases(executor, accountId, "gmail"))[0]).toMatchObject({
      display_name: "Renamed",
      is_default: 1,
    })
  })
})
