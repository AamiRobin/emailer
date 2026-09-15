import { afterEach, beforeEach, describe, expect, it } from "vitest"

import type { DraftInput } from "../drafts"
import {
  deleteDraft,
  deleteDraftByKey,
  getDraft,
  isDraftEmpty,
  listDrafts,
  saveDraft,
} from "../drafts"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { createAccount, createThread } from "@/services/db/__tests__/fixtures"

function draftInput(overrides?: Partial<DraftInput>): DraftInput {
  return {
    to: [{ email: "alice@x.com", name: "Alice" }],
    cc: [],
    bcc: [],
    subject: "Hello",
    bodyHtml: "<p>Hi</p>",
    ...overrides,
  }
}

describe("drafts service", () => {
  let executor: TestExecutor

  beforeEach(() => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  describe("saveDraft / getDraft round-trip", () => {
    it("persists and restores every field", async () => {
      const accountId = await createAccount(executor)
      const threadId = await createThread(executor, accountId)
      const saved = await saveDraft(executor, {
        accountId,
        draftKey: "key-1",
        draft: draftInput({
          cc: [{ email: "bob@x.com" }],
          bcc: [{ email: "carol@x.com" }],
          attachments: [{ filename: "notes.txt", size: 128 }],
          inReplyTo: "<msg-1@x.com>",
          threadId,
        }),
      })

      const draft = await getDraft(executor, saved.id)
      expect(draft).toEqual({
        id: saved.id,
        accountId,
        draftKey: "key-1",
        to: [{ email: "alice@x.com", name: "Alice" }],
        cc: [{ email: "bob@x.com" }],
        bcc: [{ email: "carol@x.com" }],
        subject: "Hello",
        bodyHtml: "<p>Hi</p>",
        attachments: [{ filename: "notes.txt", size: 128 }],
        inReplyTo: "<msg-1@x.com>",
        threadId,
        createdAt: saved.createdAt,
        updatedAt: saved.updatedAt,
      })
      expect(saved.createdAt).toBeGreaterThan(0)
    })

    it("stores empty recipient lists and optional fields as absent", async () => {
      const accountId = await createAccount(executor)
      const saved = await saveDraft(executor, {
        accountId,
        draftKey: "key-1",
        draft: draftInput({
          to: [],
          subject: "",
          bodyHtml: "",
        }),
      })

      const draft = await getDraft(executor, saved.id)
      expect(draft?.to).toEqual([])
      expect(draft?.attachments).toEqual([])
      expect(draft?.inReplyTo).toBeNull()
      expect(draft?.threadId).toBeNull()
      expect(draft?.subject).toBe("")
    })

    it("returns null for an unknown id", async () => {
      expect(await getDraft(executor, "nope")).toBeNull()
    })
  })

  describe("upsert by draft key", () => {
    it("updates the same row instead of duplicating it", async () => {
      const accountId = await createAccount(executor)
      const first = await saveDraft(executor, {
        accountId,
        draftKey: "composer-1",
        draft: draftInput({ subject: "v1" }),
      })
      const second = await saveDraft(executor, {
        accountId,
        draftKey: "composer-1",
        draft: draftInput({
          subject: "v2",
          to: [],
          bodyHtml: "<p>rewritten</p>",
        }),
      })

      expect(second.id).toBe(first.id)
      expect(second.createdAt).toBe(first.createdAt)
      expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt)

      const drafts = await listDrafts(executor, accountId)
      expect(drafts).toHaveLength(1)
      expect(drafts[0].subject).toBe("v2")
      expect(drafts[0].to).toEqual([])
      expect(drafts[0].bodyHtml).toBe("<p>rewritten</p>")
    })

    it("keeps the same draft_key distinct per account", async () => {
      const accountId = await createAccount(executor)
      const otherId = await createAccount(executor)
      await saveDraft(executor, {
        accountId,
        draftKey: "shared-key",
        draft: draftInput({ subject: "mine" }),
      })
      await saveDraft(executor, {
        accountId: otherId,
        draftKey: "shared-key",
        draft: draftInput({ subject: "theirs" }),
      })
      // third save on the first account must hit only its own row
      await saveDraft(executor, {
        accountId,
        draftKey: "shared-key",
        draft: draftInput({ subject: "mine-2" }),
      })

      const mine = await listDrafts(executor, accountId)
      const theirs = await listDrafts(executor, otherId)
      expect(mine.map((draft) => draft.subject)).toEqual(["mine-2"])
      expect(theirs.map((draft) => draft.subject)).toEqual(["theirs"])
    })

    it("inserts a new row per call when no draft key is given", async () => {
      const accountId = await createAccount(executor)
      await saveDraft(executor, { accountId, draft: draftInput() })
      await saveDraft(executor, { accountId, draft: draftInput() })
      expect(await listDrafts(executor, accountId)).toHaveLength(2)
    })
  })

  describe("listDrafts", () => {
    it("orders by last update, newest first", async () => {
      const accountId = await createAccount(executor)
      const a = await saveDraft(executor, {
        accountId,
        draftKey: "a",
        draft: draftInput({ subject: "older-edit" }),
      })
      const b = await saveDraft(executor, {
        accountId,
        draftKey: "b",
        draft: draftInput({ subject: "newer-edit" }),
      })
      // same-second saves tie-break by insertion order (rowid DESC)
      expect((await listDrafts(executor, accountId)).map((d) => d.id)).toEqual([
        b.id,
        a.id,
      ])

      // backdate b so a is unambiguously the most recently edited
      await executor.execute(
        "UPDATE local_drafts SET updated_at = 1000 WHERE id = ?",
        [b.id]
      )
      const drafts = await listDrafts(executor, accountId)
      expect(drafts.map((draft) => draft.subject)).toEqual([
        "older-edit",
        "newer-edit",
      ])
    })

    it("never lists another account's drafts", async () => {
      const accountId = await createAccount(executor)
      const otherId = await createAccount(executor)
      await saveDraft(executor, {
        accountId,
        draftKey: "a",
        draft: draftInput(),
      })
      await saveDraft(executor, {
        accountId: otherId,
        draftKey: "b",
        draft: draftInput(),
      })
      expect(await listDrafts(executor, accountId)).toHaveLength(1)
    })
  })

  describe("deletion", () => {
    it("deleteDraft removes by row id", async () => {
      const accountId = await createAccount(executor)
      const saved = await saveDraft(executor, {
        accountId,
        draftKey: "a",
        draft: draftInput(),
      })
      const result = await deleteDraft(executor, saved.id)
      expect(result.rowsAffected).toBe(1)
      expect(await getDraft(executor, saved.id)).toBeNull()
      expect(await deleteDraft(executor, "missing")).toEqual({
        rowsAffected: 0,
      })
    })

    it("deleteDraftByKey removes the composer's row only", async () => {
      const accountId = await createAccount(executor)
      await saveDraft(executor, {
        accountId,
        draftKey: "a",
        draft: draftInput({ subject: "keep-target" }),
      })
      const b = await saveDraft(executor, {
        accountId,
        draftKey: "b",
        draft: draftInput({ subject: "survivor" }),
      })

      const result = await deleteDraftByKey(executor, accountId, "a")
      expect(result.rowsAffected).toBe(1)
      const drafts = await listDrafts(executor, accountId)
      expect(drafts.map((draft) => draft.id)).toEqual([b.id])
      expect(await deleteDraftByKey(executor, accountId, "")).toEqual({
        rowsAffected: 0,
      })
      expect(await deleteDraftByKey(executor, accountId, "zzz")).toEqual({
        rowsAffected: 0,
      })
    })
  })

  describe("isDraftEmpty", () => {
    it("is true only when nothing at all is set", async () => {
      expect(
        isDraftEmpty(draftInput({ to: [], subject: "", bodyHtml: "" }))
      ).toBe(true)
      expect(
        isDraftEmpty(
          draftInput({ to: [], subject: "   ", bodyHtml: "  <br>  " })
        )
      ).toBe(false) // non-whitespace body
      expect(
        isDraftEmpty(
          draftInput({
            to: [],
            subject: "",
            bodyHtml: "",
            cc: [{ email: "c@x.com" }],
          })
        )
      ).toBe(false)
      expect(
        isDraftEmpty(
          draftInput({
            to: [],
            subject: "",
            bodyHtml: "",
            attachments: [{ filename: "f", size: 1 }],
          })
        )
      ).toBe(false)
      expect(
        isDraftEmpty(draftInput({ to: [], subject: "Subject", bodyHtml: "" }))
      ).toBe(false)
    })
  })
})
