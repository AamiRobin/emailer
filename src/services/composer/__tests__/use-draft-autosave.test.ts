import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createAccount } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { listPendingOperations } from "@/services/db/pending-operations"
import { operationFromRow } from "@/services/queue/operation"
import type { DraftInput } from "../drafts"
import { listDrafts } from "../drafts"
import {
  DRAFT_AUTOSAVE_DEBOUNCE_MS,
  useDraftAutosave,
  type UseDraftAutosaveArgs,
} from "../use-draft-autosave"

/**
 * Drives the real hook against the real node:sqlite executor with fake
 * timers: the poll observes JSON-diffed changes, the 3s debounce coalesces
 * them, and saves land in local_drafts through saveDraft itself.
 */

function emptyDraft(): DraftInput {
  return { to: [], cc: [], bcc: [], subject: "", bodyHtml: "" }
}

describe("useDraftAutosave", () => {
  let executor: TestExecutor
  let accountId: string
  let currentInput: DraftInput

  function renderAutosave(overrides?: Partial<UseDraftAutosaveArgs>) {
    return renderHook(
      (props: UseDraftAutosaveArgs) => useDraftAutosave(props),
      {
        initialProps: {
          accountId,
          draftKey: "composer-1",
          getDraftInput: () => currentInput,
          executor,
          ...overrides,
        },
      }
    )
  }

  /** Advance the clock (polls + debounce + async writes) inside act. */
  async function advance(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor)
    currentInput = emptyDraft()
    vi.useFakeTimers()
  })

  afterEach(async () => {
    // unmount first, then let any post-unmount flush finish before the
    // executor closes
    cleanup()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    vi.useRealTimers()
    executor.close()
  })

  it("saves once after the debounce window following rapid changes", async () => {
    const { result } = renderAutosave()
    await advance(1_000) // first poll primes the baseline

    for (let version = 1; version <= 5; version += 1) {
      currentInput = { ...currentInput, subject: `v${version}` }
      await advance(300) // change again well inside the debounce window
    }

    // nothing before the quiet period, exactly one row after it
    await advance(DRAFT_AUTOSAVE_DEBOUNCE_MS - 100)
    expect(await listDrafts(executor, accountId)).toHaveLength(0)
    await advance(2_000)
    const drafts = await listDrafts(executor, accountId)
    expect(drafts).toHaveLength(1)
    expect(drafts[0].subject).toBe("v5")
    expect(drafts[0].draftKey).toBe("composer-1")
    expect(result.current.lastSavedAt).toBe(drafts[0].updatedAt)

    // quiescence saves nothing further
    const updatedAt = drafts[0].updatedAt
    await advance(10_000)
    expect(await listDrafts(executor, accountId)).toHaveLength(1)
    expect((await listDrafts(executor, accountId))[0].updatedAt).toBe(updatedAt)
  })

  it("does not save while the composer stays untouched", async () => {
    renderAutosave()
    await advance(30_000)
    expect(await listDrafts(executor, accountId)).toEqual([])
  })

  it("never saves an empty snapshot, even after typing and clearing", async () => {
    renderAutosave()
    await advance(1_000)

    currentInput = { ...currentInput, subject: "temp" }
    await advance(1_000)
    currentInput = emptyDraft() // cleared before the debounce fires
    await advance(5_000)

    expect(await listDrafts(executor, accountId)).toEqual([])
  })

  it("does not re-save when content reverts to the last saved state", async () => {
    const { result } = renderAutosave()
    await advance(1_000)
    currentInput = { ...currentInput, subject: "kept" }
    await advance(DRAFT_AUTOSAVE_DEBOUNCE_MS + 1_000)
    const savedAt = result.current.lastSavedAt
    expect(savedAt).not.toBeNull()

    currentInput = { ...currentInput, subject: "edited" }
    await advance(1_000)
    currentInput = { ...currentInput, subject: "kept" } // reverted in time
    await advance(DRAFT_AUTOSAVE_DEBOUNCE_MS + 1_000)

    expect(result.current.lastSavedAt).toBe(savedAt)
    const drafts = await listDrafts(executor, accountId)
    expect(drafts).toHaveLength(1)
    expect(drafts[0].updatedAt).toBe(savedAt)
  })

  it("does not rewrite a resumed draft until it is edited", async () => {
    // resume: the draft content is already on disk under the same key
    currentInput = { ...currentInput, subject: "resumed", bodyHtml: "<p>x</p>" }
    renderAutosave()
    await advance(30_000)
    expect(await listDrafts(executor, accountId)).toEqual([])

    // an actual edit does save
    currentInput = { ...currentInput, subject: "resumed (edited)" }
    await advance(DRAFT_AUTOSAVE_DEBOUNCE_MS + 2_000)
    const drafts = await listDrafts(executor, accountId)
    expect(drafts).toHaveLength(1)
    expect(drafts[0].subject).toBe("resumed (edited)")
  })

  it("flushes the pending snapshot on unmount", async () => {
    const { unmount } = renderAutosave()
    await advance(1_000)
    currentInput = { ...currentInput, subject: "closing soon" }
    await advance(1_000) // observed, debounce armed — then unmount
    unmount()
    await advance(0)

    const drafts = await listDrafts(executor, accountId)
    expect(drafts).toHaveLength(1)
    expect(drafts[0].subject).toBe("closing soon")
  })

  it("saveNow writes immediately without waiting for the debounce", async () => {
    const { result } = renderAutosave()
    await advance(1_000)
    currentInput = { ...currentInput, subject: "now" }
    await advance(1_000)

    await act(async () => {
      await result.current.saveNow()
    })
    const drafts = await listDrafts(executor, accountId)
    expect(drafts.map((draft) => draft.subject)).toEqual(["now"])
    expect(result.current.lastSavedAt).toBe(drafts[0].updatedAt)

    // saveNow on unchanged content is a no-op
    await act(async () => {
      await result.current.saveNow()
    })
    expect(await listDrafts(executor, accountId)).toHaveLength(1)
  })

  it("skips saving entirely while disabled", async () => {
    const { rerender } = renderAutosave({ enabled: false })
    await advance(1_000)
    currentInput = { ...currentInput, subject: "offline-ish" }
    await advance(10_000)
    expect(await listDrafts(executor, accountId)).toEqual([])

    // enabling starts watching and saves after the debounce
    rerender({
      accountId,
      draftKey: "composer-1",
      getDraftInput: () => currentInput,
      executor,
      enabled: true,
    })
    await advance(1_000) // baseline poll
    currentInput = { ...currentInput, subject: "enabled edit" }
    await advance(DRAFT_AUTOSAVE_DEBOUNCE_MS + 1_000)
    const drafts = await listDrafts(executor, accountId)
    expect(drafts.map((draft) => draft.subject)).toEqual(["enabled edit"])
  })

  it("flushes the old key's draft when the draft key changes", async () => {
    const { rerender } = renderAutosave({ draftKey: "key-a" })
    await advance(1_000)
    currentInput = { ...currentInput, subject: "belongs to a" }
    await advance(1_000)

    rerender({
      accountId,
      draftKey: "key-b",
      getDraftInput: () => currentInput,
      executor,
    })
    await advance(DRAFT_AUTOSAVE_DEBOUNCE_MS + 1_000)

    const drafts = await listDrafts(executor, accountId)
    expect(drafts).toHaveLength(1)
    expect(drafts[0].draftKey).toBe("key-a")
    expect(drafts[0].subject).toBe("belongs to a")
  })

  it("retries after a failed save instead of dropping the draft", async () => {
    let failFirstWrite = true
    const flakyExecutor: TestExecutor = {
      select: <T>(sql: string, params?: unknown[]) =>
        executor.select<T>(sql, params),
      execute: async (sql, params) => {
        if (failFirstWrite) {
          failFirstWrite = false
          throw new Error("simulated disk error")
        }
        return executor.execute(sql, params)
      },
      close: () => executor.close(),
    }
    renderAutosave({ executor: flakyExecutor })
    await advance(1_000)
    currentInput = { ...currentInput, subject: "must survive" }
    await advance(DRAFT_AUTOSAVE_DEBOUNCE_MS + 1_000) // first attempt fails
    expect(await listDrafts(executor, accountId)).toEqual([])

    await advance(DRAFT_AUTOSAVE_DEBOUNCE_MS + 1_000) // retry succeeds
    const drafts = await listDrafts(executor, accountId)
    expect(drafts.map((draft) => draft.subject)).toEqual(["must survive"])
  })

  it("coalesces the pending draft_upsert mirror op to the newest save (design D9, task 17.x)", async () => {
    renderAutosave()
    await advance(1_000) // prime the baseline
    currentInput = { ...currentInput, subject: "mirror me" }
    await advance(DRAFT_AUTOSAVE_DEBOUNCE_MS + 1_000)

    // The local save is accompanied by exactly one queued server-mirror
    // upsert, carrying the saved content and the row id.
    const rows = await listPendingOperations(executor)
    expect(rows).toHaveLength(1)
    const op = operationFromRow(rows[0])
    expect(op).toMatchObject({ accountId, kind: "draft_upsert" })
    if (op.kind !== "draft_upsert") return
    expect(op.mime).toContain("Subject: mirror me")
    const drafts = await listDrafts(executor, accountId)
    expect(op.draftId).toBe(drafts[0].id)

    // A second save COALESCES rather than stacks: the mirror is
    // last-write-wins, so the still-pending upsert for the same draft is
    // replaced and at most one full-MIME op waits for replay — carrying
    // the newest snapshot.
    currentInput = { ...currentInput, subject: "mirror me again" }
    await advance(DRAFT_AUTOSAVE_DEBOUNCE_MS + 1_000)
    const rows2 = await listPendingOperations(executor)
    expect(rows2).toHaveLength(1)
    expect(rows2[0].op_type).toBe("draft_upsert")
    const op2 = operationFromRow(rows2[0])
    if (op2.kind !== "draft_upsert") return
    expect(op2.mime).toContain("Subject: mirror me again")
    expect(op2.mime).not.toContain("Subject: mirror me\r\n")
  })
})
