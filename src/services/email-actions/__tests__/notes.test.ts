import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount, createThread } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { getThread } from "../../db/threads"
import { ThreadNotFoundError } from "../thread-actions"
import { setThreadNote } from "../notes"

/**
 * Thread notes (task 15.1) service tests. Local-only by design: the note
 * is a plain threads.note write over the seeded node:sqlite database, so
 * "persistence" here is the real store — set → getThread (a fresh SELECT)
 * returns the note, and it stays readable after subsequent queries the
 * way a restart would re-read it. No queue or provider exists in these
 * tests at all (nothing to mock).
 */

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
})

afterEach(() => {
  executor.close()
})

async function seedThread(): Promise<{ accountId: string; threadId: string }> {
  const accountId = await createAccount(executor, "gmail")
  const threadId = await createThread(executor, accountId, {
    subject: "Noteworthy",
  })
  return { accountId, threadId }
}

describe("setThreadNote", () => {
  it("persists the note on the thread row", async () => {
    const { threadId } = await seedThread()

    await setThreadNote(executor, threadId, "Approved by legal on Monday")

    const thread = await getThread(executor, threadId)
    expect(thread?.note).toBe("Approved by legal on Monday")
  })

  it("overwrites a previous note in place", async () => {
    const { threadId } = await seedThread()
    await setThreadNote(executor, threadId, "First take")

    await setThreadNote(executor, threadId, "Second take")

    expect((await getThread(executor, threadId))?.note).toBe("Second take")
  })

  it("clearing (null) removes the note", async () => {
    const { threadId } = await seedThread()
    await setThreadNote(executor, threadId, "To remove")

    await setThreadNote(executor, threadId, null)

    expect((await getThread(executor, threadId))?.note).toBeNull()
  })

  it("whitespace-only input is treated as removal (stored NULL)", async () => {
    const { threadId } = await seedThread()

    await setThreadNote(executor, threadId, "   \n\t  ")

    expect((await getThread(executor, threadId))?.note).toBeNull()
  })

  it("trims surrounding whitespace when persisting", async () => {
    const { threadId } = await seedThread()

    await setThreadNote(executor, threadId, "  padded note  ")

    expect((await getThread(executor, threadId))?.note).toBe("padded note")
  })

  it("notes are per thread — other threads are untouched", async () => {
    const { threadId } = await seedThread()
    const other = await seedThread()

    await setThreadNote(executor, threadId, "Only here")

    expect((await getThread(executor, threadId))?.note).toBe("Only here")
    expect((await getThread(executor, other.threadId))?.note).toBeNull()
  })

  it("setting a note on a missing thread throws the shared ThreadNotFoundError", async () => {
    await expect(
      setThreadNote(executor, "no-such-thread", "orphan")
    ).rejects.toBeInstanceOf(ThreadNotFoundError)
  })
})
