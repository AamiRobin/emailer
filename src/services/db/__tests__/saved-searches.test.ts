import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createSavedSearch,
  deleteSavedSearch,
  listSavedSearches,
  moveSavedSearch,
  updateSavedSearch,
} from "../saved-searches"
import { createTestExecutor, type TestExecutor } from "./test-executor"

describe("saved-search queries", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("creates a saved search with a generated id, position and timestamp", async () => {
    const id = await createSavedSearch(executor, {
      name: "Unread from client",
      query: "is:unread from:client.com",
    })

    expect(id).toBeTruthy()
    const rows = await listSavedSearches(executor)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id,
      name: "Unread from client",
      query: "is:unread from:client.com",
      position: 1,
    })
    expect(typeof rows[0]!.created_at).toBe("number")
  })

  it("appends new searches at the end of the ordering", async () => {
    await createSavedSearch(executor, { name: "First", query: "a" })
    await createSavedSearch(executor, { name: "Second", query: "b" })
    await createSavedSearch(executor, { name: "Third", query: "c" })

    const names = (await listSavedSearches(executor)).map((row) => row.name)
    expect(names).toEqual(["First", "Second", "Third"])
  })

  it("keeps the order stable after a rename", async () => {
    const first = await createSavedSearch(executor, { name: "A", query: "a" })
    await createSavedSearch(executor, { name: "B", query: "b" })

    await updateSavedSearch(executor, first, { name: "Zzz" })

    const names = (await listSavedSearches(executor)).map((row) => row.name)
    expect(names).toEqual(["Zzz", "B"])
  })

  it("updates only the provided fields", async () => {
    const id = await createSavedSearch(executor, {
      name: "Old name",
      query: "from:a.example",
    })

    await updateSavedSearch(executor, id, { query: "from:b.example" })
    let row = (await listSavedSearches(executor))[0]!
    expect(row).toMatchObject({ name: "Old name", query: "from:b.example" })

    await updateSavedSearch(executor, id, { name: "New name" })
    row = (await listSavedSearches(executor))[0]!
    expect(row).toMatchObject({ name: "New name", query: "from:b.example" })
  })

  it("an empty update patch is a no-op", async () => {
    const id = await createSavedSearch(executor, {
      name: "Keep",
      query: "is:unread",
    })

    await updateSavedSearch(executor, id, {})

    const row = (await listSavedSearches(executor))[0]!
    expect(row).toMatchObject({ name: "Keep", query: "is:unread" })
  })

  it("moves a search one slot by swapping positions with the neighbor", async () => {
    const first = await createSavedSearch(executor, { name: "A", query: "a" })
    await createSavedSearch(executor, { name: "B", query: "b" })
    const third = await createSavedSearch(executor, { name: "C", query: "c" })

    await moveSavedSearch(executor, first, 1)
    expect((await listSavedSearches(executor)).map((r) => r.name)).toEqual([
      "B",
      "A",
      "C",
    ])

    await moveSavedSearch(executor, third, -1)
    expect((await listSavedSearches(executor)).map((r) => r.name)).toEqual([
      "B",
      "C",
      "A",
    ])
  })

  it("moving at the ends of the list is a no-op", async () => {
    const first = await createSavedSearch(executor, { name: "A", query: "a" })
    await createSavedSearch(executor, { name: "B", query: "b" })

    await moveSavedSearch(executor, first, -1)
    await moveSavedSearch(executor, "missing-id", 1)
    expect((await listSavedSearches(executor)).map((r) => r.name)).toEqual([
      "A",
      "B",
    ])
  })

  it("deletes a saved search", async () => {
    const id = await createSavedSearch(executor, { name: "Gone", query: "a" })
    await createSavedSearch(executor, { name: "Stays", query: "b" })

    await deleteSavedSearch(executor, id)

    const names = (await listSavedSearches(executor)).map((row) => row.name)
    expect(names).toEqual(["Stays"])
    // Deleting an unknown id is a no-op, not an error.
    await deleteSavedSearch(executor, "missing-id")
    expect(await listSavedSearches(executor)).toHaveLength(1)
  })
})
