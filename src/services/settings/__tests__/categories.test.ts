import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { getSetting } from "@/services/db/settings"
import {
  CATEGORIES_ENABLED_SETTING_KEY,
  getCategoriesEnabled,
  setCategoriesEnabled,
} from "../categories"

/**
 * The category tab row's visibility setting (task 3.5): default off, a
 * round-trip through the settings table, and corrupt-row safety — the
 * "hideable row" the mailbox-ui spec names lives on this one boolean.
 */

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
})

afterEach(() => {
  executor.close()
})

describe("organization.categoriesEnabled (task 3.5)", () => {
  it("defaults to off on a fresh database (the tabs are opt-in)", async () => {
    expect(await getCategoriesEnabled(executor)).toBe(false)
  })

  it("round-trips an enable/disable cycle", async () => {
    await setCategoriesEnabled(executor, true)
    expect(await getCategoriesEnabled(executor)).toBe(true)
    expect(
      (await getSetting(executor, CATEGORIES_ENABLED_SETTING_KEY, null)) ===
        true
    ).toBe(true)

    await setCategoriesEnabled(executor, false)
    expect(await getCategoriesEnabled(executor)).toBe(false)
  })

  it("reads a corrupt or wrongly-typed row as off", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [CATEGORIES_ENABLED_SETTING_KEY, "not-json"]
    )
    expect(await getCategoriesEnabled(executor)).toBe(false)

    await setCategoriesEnabled(executor, true)
    await executor.execute("UPDATE settings SET value = $1 WHERE key = $2", [
      '"yes"',
      CATEGORIES_ENABLED_SETTING_KEY,
    ])
    expect(await getCategoriesEnabled(executor)).toBe(false)
  })
})
