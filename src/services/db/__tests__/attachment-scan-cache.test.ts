import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { getScanVerdict, putScanVerdict } from "../attachment-scan-cache"
import { createTestExecutor, type TestExecutor } from "./test-executor"

/**
 * Verdict-cache tests (task 18.9): round-trips against the real v6
 * `attachment_scan_cache` table (node:sqlite), including the upsert
 * overwrite and the CHECK-constraint verdict tiers.
 */

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
})

afterEach(() => {
  executor.close()
})

describe("getScanVerdict", () => {
  it("returns null for a hash never looked up", async () => {
    expect(await getScanVerdict(executor, "ab".repeat(32))).toBeNull()
  })

  it("round-trips the verdict with the report counts", async () => {
    await putScanVerdict(executor, "ab".repeat(32), {
      verdict: "malicious",
      maliciousCount: 12,
      totalEngines: 70,
      now: () => 1_700_000_000,
    })

    const row = await getScanVerdict(executor, "ab".repeat(32))
    expect(row).not.toBeNull()
    expect(row?.verdict).toBe("malicious")
    expect(row?.malicious_count).toBe(12)
    expect(row?.total_engines).toBe(70)
    expect(row?.looked_up_at).toBe(1_700_000_000)
  })

  it("defaults the engine counts to null (unknown-shaped reports)", async () => {
    await putScanVerdict(executor, "cd".repeat(32), { verdict: "clean" })
    const row = await getScanVerdict(executor, "cd".repeat(32))
    expect(row?.verdict).toBe("clean")
    expect(row?.malicious_count).toBeNull()
    expect(row?.total_engines).toBeNull()
  })
})

describe("putScanVerdict", () => {
  it("overwrites an existing row wholesale (fresher lookup wins)", async () => {
    const hash = "ef".repeat(32)
    await putScanVerdict(executor, hash, {
      verdict: "suspicious",
      maliciousCount: 0,
      totalEngines: 70,
      now: () => 1,
    })
    await putScanVerdict(executor, hash, {
      verdict: "clean",
      maliciousCount: 0,
      totalEngines: 71,
      now: () => 2,
    })

    const row = await getScanVerdict(executor, hash)
    expect(row?.verdict).toBe("clean")
    expect(row?.total_engines).toBe(71)
    expect(row?.looked_up_at).toBe(2)
    // Still exactly one row per hash.
    const all = await executor.select(
      "SELECT sha256 FROM attachment_scan_cache"
    )
    expect(all).toHaveLength(1)
  })

  it("rejects verdicts outside the CHECK tiers", async () => {
    await expect(
      putScanVerdict(executor, "ab".repeat(32), {
        verdict: "catastrophic" as never,
      })
    ).rejects.toThrow()
  })
})
