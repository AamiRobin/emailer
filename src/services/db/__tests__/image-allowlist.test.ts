import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount } from "./fixtures"
import { createTestExecutor, type TestExecutor } from "./test-executor"
import {
  allowSender,
  isSenderAllowed,
  normalizeSenderEmail,
  removeSender,
} from "../image-allowlist"

/**
 * Query-module tests for the remote-image sender allowlist (task 7.3),
 * run against the real v1 schema on the node:sqlite test executor.
 */

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
})

afterEach(() => {
  executor.close()
})

describe("normalizeSenderEmail", () => {
  it("lowercases and trims the address", () => {
    expect(normalizeSenderEmail("  News@EXAMPLE.com ")).toBe("news@example.com")
  })
})

describe("image_allowlist", () => {
  it("blocks senders by default (no row = not allowed)", async () => {
    const accountId = await createAccount(executor)
    await expect(
      isSenderAllowed(executor, accountId, "news@example.com")
    ).resolves.toBe(false)
  })

  it("allowSender persists the choice and isSenderAllowed finds it", async () => {
    const accountId = await createAccount(executor)
    await allowSender(executor, accountId, "news@example.com")
    await expect(
      isSenderAllowed(executor, accountId, "news@example.com")
    ).resolves.toBe(true)
  })

  it("lookup is case-insensitive across write and read", async () => {
    const accountId = await createAccount(executor)
    await allowSender(executor, accountId, "News@Example.com")
    await expect(
      isSenderAllowed(executor, accountId, "news@example.com")
    ).resolves.toBe(true)
    await expect(
      isSenderAllowed(executor, accountId, "NEWS@EXAMPLE.COM")
    ).resolves.toBe(true)
  })

  it("allowSender is idempotent (no constraint error on repeat)", async () => {
    const accountId = await createAccount(executor)
    await allowSender(executor, accountId, "news@example.com")
    await allowSender(executor, accountId, "news@example.com")
    await expect(
      isSenderAllowed(executor, accountId, "news@example.com")
    ).resolves.toBe(true)
    const rows = await executor.select(
      "SELECT * FROM image_allowlist WHERE account_id = $1",
      [accountId]
    )
    expect(rows).toHaveLength(1)
  })

  it("scopes the choice per account", async () => {
    const accountA = await createAccount(executor)
    const accountB = await createAccount(executor)
    await allowSender(executor, accountA, "news@example.com")
    await expect(
      isSenderAllowed(executor, accountA, "news@example.com")
    ).resolves.toBe(true)
    await expect(
      isSenderAllowed(executor, accountB, "news@example.com")
    ).resolves.toBe(false)
  })

  it("removeSender revokes the choice (no-op when absent)", async () => {
    const accountId = await createAccount(executor)
    await allowSender(executor, accountId, "news@example.com")
    await removeSender(executor, accountId, "news@example.com")
    await expect(
      isSenderAllowed(executor, accountId, "news@example.com")
    ).resolves.toBe(false)
    // Revoking an absent sender does not throw.
    await removeSender(executor, accountId, "never-allowed@example.com")
  })
})
