import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  getNotificationsEnabled,
  getSetting,
  SETTINGS_KEYS,
  setSetting,
} from "../settings"
import { createTestExecutor, type TestExecutor } from "./test-executor"

describe("settings queries", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("round-trips a value through set/get", async () => {
    await setSetting(executor, "last.folder", { path: "INBOX", page: 3 })

    const value = await getSetting(executor, "last.folder", null)

    expect(value).toEqual({ path: "INBOX", page: 3 })
  })

  it("returns the default when the key is missing", async () => {
    const value = await getSetting(executor, "missing.key", "fallback")

    expect(value).toBe("fallback")
  })

  it("returns the default for a stored value that is not JSON", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["corrupt.key", "not json {"]
    )

    expect(await getSetting(executor, "corrupt.key", 42)).toBe(42)
  })

  it("overwrites an existing key (upsert)", async () => {
    await setSetting(executor, "theme", "light")
    await setSetting(executor, "theme", "dark")

    expect(await getSetting(executor, "theme", "light")).toBe("dark")
    const rows = await executor.select<{ updated_at: number }>(
      "SELECT updated_at FROM settings WHERE key = $1",
      ["theme"]
    )
    expect(rows[0]?.updated_at).toBeGreaterThan(0)
  })

  it("stores JSON-encoded values, matching the schema contract", async () => {
    await setSetting(executor, "raw.check", true)
    const rows = await executor.select<{ value: string }>(
      "SELECT value FROM settings WHERE key = $1",
      ["raw.check"]
    )
    expect(rows[0]?.value).toBe("true")
  })

  describe("getNotificationsEnabled", () => {
    it("defaults to true when the setting has never been stored", async () => {
      expect(await getNotificationsEnabled(executor)).toBe(true)
    })

    it("round-trips an explicit off/on through setSetting", async () => {
      await setSetting(executor, SETTINGS_KEYS.notificationsEnabled, false)
      expect(await getNotificationsEnabled(executor)).toBe(false)

      await setSetting(executor, SETTINGS_KEYS.notificationsEnabled, true)
      expect(await getNotificationsEnabled(executor)).toBe(true)
    })

    it("falls back to the default when the stored value is not a boolean", async () => {
      await setSetting(executor, SETTINGS_KEYS.notificationsEnabled, "yes")

      expect(await getNotificationsEnabled(executor)).toBe(true)
    })
  })
})
