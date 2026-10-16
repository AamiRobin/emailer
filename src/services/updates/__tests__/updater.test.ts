import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { invoke } from "@tauri-apps/api/core"

import { createTestExecutor, type TestExecutor } from "@/services/db/__tests__/test-executor"
import {
  UPDATE_DOWNLOAD_FINISHED_EVENT,
  UPDATE_DOWNLOAD_PROGRESS_EVENT,
  checkForUpdate,
  downloadAndInstallUpdate,
  getUpdateChannel,
  setUpdateChannel,
} from "../updater"

/**
 * Release-channel contract (task 20.5, docs/releases.md). The channel is
 * a plain settings row; the Tauri `invoke` wrappers are the settings
 * section's only path to the updater plugin, so the events exported here
 * ARE the wire names the Rust side emits.
 */

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}))

const invokeMock = vi.mocked(invoke)

describe("update channel", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
    invokeMock.mockReset()
  })

  afterEach(() => {
    executor.close()
  })

  it("defaults to stable when the setting was never written", async () => {
    expect(await getUpdateChannel(executor)).toBe("stable")
  })

  it("round-trips the beta channel through the settings row", async () => {
    await setUpdateChannel(executor, "beta")
    expect(await getUpdateChannel(executor)).toBe("beta")
  })

  it("fails a corrupt stored value toward stable", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["updates.channel", '"nightly"']
    )
    expect(await getUpdateChannel(executor)).toBe("stable")
  })
})

describe("updater Tauri bridge", () => {
  it("passes the channel through to check_for_update", async () => {
    invokeMock.mockResolvedValueOnce({
      version: "0.2.0",
      currentVersion: "0.1.0",
      notes: "bugfix release",
    })
    const metadata = await checkForUpdate("beta")
    expect(invokeMock).toHaveBeenCalledWith("check_for_update", {
      channel: "beta",
    })
    expect(metadata).toEqual({
      version: "0.2.0",
      currentVersion: "0.1.0",
      notes: "bugfix release",
    })
  })

  it("surfaces the null no-update answer untouched", async () => {
    invokeMock.mockResolvedValueOnce(null)
    expect(await checkForUpdate("stable")).toBeNull()
  })

  it("routes the install through download_and_install_update", async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    await downloadAndInstallUpdate()
    expect(invokeMock).toHaveBeenCalledWith("download_and_install_update")
  })

  it("exports the progress/finished event names the Rust side emits", () => {
    expect(UPDATE_DOWNLOAD_PROGRESS_EVENT).toBe("updates://download-progress")
    expect(UPDATE_DOWNLOAD_FINISHED_EVENT).toBe("updates://download-finished")
  })
})
