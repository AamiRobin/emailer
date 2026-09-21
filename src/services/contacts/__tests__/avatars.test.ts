import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The service invokes the Rust `gravatar_fetch` command; the vitest
// runtime has no IPC, so the real core module is mocked — the mock's
// call log IS the "zero invokes while the setting is off" assertion
// target (the same approach preferences.test.ts uses).
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => null),
}))

import { invoke } from "@tauri-apps/api/core"
import {
  clearAvatarCache,
  fetchGravatarBlobUrl,
  getAvatarCacheVersion,
  setAvatarsExecutor,
  subscribeAvatarCache,
} from "../avatars"
import { setGravatarEnabledPreference } from "@/services/settings/preferences"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"

/**
 * Avatars service tests (task 2.5, design D12): the privacy gate (off →
 * null with NO invoke, corrupt rows included), the session blob-URL Map
 * (one fetch per normalized address), clearAvatarCache revocation +
 * subscriber notification, and invoke-failure tolerance.
 */

const invokeMock = vi.mocked(invoke)

let executor: TestExecutor

/** jsdom has no blob-URL plumbing; deterministic stubs make the object
 * URL observable ("blob:mock-1", "blob:mock-2", …). */
let objectUrlCounter = 0
let revokedUrls: string[] = []

beforeEach(() => {
  executor = createTestExecutor()
  setAvatarsExecutor(executor)
  clearAvatarCache()
  objectUrlCounter = 0
  revokedUrls = []
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn(() => `blob:mock-${++objectUrlCounter}`),
  })
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    writable: true,
    value: vi.fn((url: string) => {
      revokedUrls.push(url)
    }),
  })
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(null)
})

afterEach(() => {
  clearAvatarCache()
  setAvatarsExecutor(null)
  executor.close()
})

// "hello" — arbitrary non-empty bytes; the service only relays them.
const PNG_BASE64 = "aGVsbG8="

describe("fetchGravatarBlobUrl (task 2.5)", () => {
  it("returns null with ZERO invokes while the setting is off", async () => {
    // No preference row: the default is off.
    await expect(fetchGravatarBlobUrl("ada@x.com")).resolves.toBeNull()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("treats a corrupt preference row as off (privacy fail-toward-off)", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      ["contacts.gravatarEnabled", JSON.stringify("on")]
    )
    await expect(fetchGravatarBlobUrl("ada@x.com")).resolves.toBeNull()
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("invokes with the normalized address and returns a blob URL when on", async () => {
    await setGravatarEnabledPreference(executor, true)
    invokeMock.mockResolvedValue(PNG_BASE64)

    await expect(fetchGravatarBlobUrl("  Ada@X.com ")).resolves.toBe(
      "blob:mock-1"
    )
    expect(invokeMock).toHaveBeenCalledOnce()
    expect(invokeMock).toHaveBeenCalledWith("gravatar_fetch", {
      address: "ada@x.com",
    })
  })

  it("serves repeat lookups from the session cache without re-invoking", async () => {
    await setGravatarEnabledPreference(executor, true)
    invokeMock.mockResolvedValue(PNG_BASE64)
    await expect(fetchGravatarBlobUrl("ada@x.com")).resolves.toBe("blob:mock-1")

    // Same address in any casing/spacing → the cached blob URL, and the
    // mock's call log proves no second fetch happened.
    await expect(fetchGravatarBlobUrl("ADA@X.COM")).resolves.toBe("blob:mock-1")
    expect(invokeMock).toHaveBeenCalledOnce()
  })

  it("returns null when the invoke rejects (mock mode / offline)", async () => {
    await setGravatarEnabledPreference(executor, true)
    invokeMock.mockRejectedValue(new Error("no IPC in mock mode"))

    await expect(fetchGravatarBlobUrl("ada@x.com")).resolves.toBeNull()
    // And the failure is not cached: the next call tries again.
    invokeMock.mockResolvedValue(PNG_BASE64)
    await expect(fetchGravatarBlobUrl("ada@x.com")).resolves.toBe("blob:mock-1")
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })

  it("returns null when the command reports no Gravatar (null bytes)", async () => {
    await setGravatarEnabledPreference(executor, true)
    // Default mock: resolves null (the Rust command's 404 shape).
    await expect(fetchGravatarBlobUrl("ada@x.com")).resolves.toBeNull()
    expect(invokeMock).toHaveBeenCalledOnce()
  })
})

describe("clearAvatarCache (task 2.5)", () => {
  it("revokes every blob URL, notifies subscribers and empties the cache", async () => {
    await setGravatarEnabledPreference(executor, true)
    invokeMock.mockResolvedValue(PNG_BASE64)
    await expect(fetchGravatarBlobUrl("ada@x.com")).resolves.toBe("blob:mock-1")

    const versions: number[] = []
    const unsubscribe = subscribeAvatarCache(() => {
      versions.push(getAvatarCacheVersion())
    })

    const versionBefore = getAvatarCacheVersion()
    clearAvatarCache()

    expect(revokedUrls).toEqual(["blob:mock-1"])
    expect(versions).toEqual([versionBefore + 1])

    // The cache is empty: the next lookup fetches (and blobs) again.
    await expect(fetchGravatarBlobUrl("ada@x.com")).resolves.toBe("blob:mock-2")
    expect(invokeMock).toHaveBeenCalledTimes(2)

    unsubscribe()
    clearAvatarCache()
    expect(revokedUrls).toEqual(["blob:mock-1", "blob:mock-2"])
    expect(versions).toEqual([versionBefore + 1])
  })
})
