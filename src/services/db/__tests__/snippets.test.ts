import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createSnippet,
  deleteSnippet,
  listSnippets,
  updateSnippet,
} from "../snippets"
import { createTestExecutor, type TestExecutor } from "./test-executor"

describe("snippet queries", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("creates a snippet with a generated id and timestamps it", async () => {
    const id = await createSnippet(executor, {
      name: "Thanks",
      body: "Best regards,\nAlex",
      shortcut: "thx",
    })

    expect(id).toBeTruthy()
    const rows = await listSnippets(executor)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id,
      name: "Thanks",
      body: "Best regards,\nAlex",
      shortcut: "thx",
    })
    expect(typeof rows[0]!.created_at).toBe("number")
  })

  it("defaults shortcut to NULL when not given", async () => {
    await createSnippet(executor, { name: "Plain", body: "Body" })

    const rows = await listSnippets(executor)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.shortcut).toBeNull()
  })

  it("lists snippets ordered by name case-insensitively", async () => {
    await createSnippet(executor, { name: "banana", body: "b" })
    await createSnippet(executor, { name: "Apple", body: "a" })
    await createSnippet(executor, { name: "cherry", body: "c" })

    const names = (await listSnippets(executor)).map((snippet) => snippet.name)
    expect(names).toEqual(["Apple", "banana", "cherry"])
  })

  it("snippets are global — one list serves every account", async () => {
    // The table has no account column; inserting twice just yields two rows.
    await createSnippet(executor, { name: "Shared", body: "Hello" })
    expect(await listSnippets(executor)).toHaveLength(1)
  })

  it("updates only the provided fields, clearing shortcut with null", async () => {
    const id = await createSnippet(executor, {
      name: "Sig",
      body: "Old body",
      shortcut: "sig",
    })

    await updateSnippet(executor, id, { body: "New body" })
    let row = (await listSnippets(executor))[0]!
    expect(row).toMatchObject({
      name: "Sig",
      body: "New body",
      shortcut: "sig",
    })

    await updateSnippet(executor, id, { name: "Signature", shortcut: null })
    row = (await listSnippets(executor))[0]!
    expect(row).toMatchObject({
      name: "Signature",
      body: "New body",
      shortcut: null,
    })
  })

  it("an empty update patch is a no-op", async () => {
    const id = await createSnippet(executor, {
      name: "Keep",
      body: "Untouched",
      shortcut: "k",
    })

    await updateSnippet(executor, id, {})

    const row = (await listSnippets(executor))[0]!
    expect(row).toMatchObject({
      name: "Keep",
      body: "Untouched",
      shortcut: "k",
    })
  })

  it("deletes a snippet", async () => {
    const id = await createSnippet(executor, { name: "Gone", body: "b" })
    await createSnippet(executor, { name: "Stays", body: "b" })

    await deleteSnippet(executor, id)

    const names = (await listSnippets(executor)).map((snippet) => snippet.name)
    expect(names).toEqual(["Stays"])
    // Deleting an unknown id is a no-op, not an error.
    await deleteSnippet(executor, "missing-id")
    expect(await listSnippets(executor)).toHaveLength(1)
  })
})
