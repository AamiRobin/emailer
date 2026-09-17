import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { DraftInput } from "../drafts"
import {
  deleteDraft,
  deleteDraftByKey,
  draftMessageId,
  enqueueDraftMirrorUpsert,
  getDraft,
  isDraftEmpty,
  listDrafts,
  parseServerDraftRef,
  saveDraft,
  saveServerDraft,
  setDraftServerRef,
} from "../drafts"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { createAccount, createThread } from "@/services/db/__tests__/fixtures"
import { listPendingOperations } from "@/services/db/pending-operations"
import { operationFromRow } from "@/services/queue/operation"

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
        serverDraftRef: null,
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

describe("draft server mirroring (task 17.x, design D9)", () => {
  let executor: TestExecutor
  let accountId: string
  let consoleWarn: ReturnType<typeof vi.spyOn>

  function draftInput(overrides?: Partial<DraftInput>): DraftInput {
    return {
      to: [{ email: "alice@x.com" }],
      cc: [],
      bcc: [],
      subject: "Hello",
      bodyHtml: "<p>Hi</p>",
      ...overrides,
    }
  }

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor)
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  afterEach(() => {
    consoleWarn.mockRestore()
    executor.close()
  })

  async function queuedOps() {
    const rows = await listPendingOperations(executor)
    return rows.map(operationFromRow)
  }

  it("stores, preserves, and clears the server mirror ref on the row", async () => {
    const saved = await saveDraft(executor, {
      accountId,
      draftKey: "k",
      draft: draftInput(),
    })
    expect((await getDraft(executor, saved.id))?.serverDraftRef).toBeNull()

    await setDraftServerRef(executor, saved.id, {
      provider: "gmail",
      draftId: "draft-1",
    })
    // A content autosave (draft_key upsert) must NOT clobber the ref.
    await saveDraft(executor, {
      accountId,
      draftKey: "k",
      draft: draftInput({ subject: "v2" }),
    })
    expect((await getDraft(executor, saved.id))?.serverDraftRef).toEqual({
      provider: "gmail",
      draftId: "draft-1",
    })

    await setDraftServerRef(executor, saved.id, {
      provider: "imap",
      folder: "Drafts",
      uid: 12,
    })
    expect((await getDraft(executor, saved.id))?.serverDraftRef).toEqual({
      provider: "imap",
      folder: "Drafts",
      uid: 12,
    })

    await setDraftServerRef(executor, saved.id, null)
    expect((await getDraft(executor, saved.id))?.serverDraftRef).toBeNull()
  })

  it("parses refs tolerantly (corrupt or unknown shapes read as not mirrored)", () => {
    expect(parseServerDraftRef(null)).toBeNull()
    expect(parseServerDraftRef("not json")).toBeNull()
    expect(parseServerDraftRef('{"provider":"carrier"}')).toBeNull()
    expect(parseServerDraftRef('{"provider":"gmail"}')).toBeNull()
    expect(
      parseServerDraftRef('{"provider":"imap","folder":"Drafts"}')
    ).toBeNull()
    expect(parseServerDraftRef('{"provider":"gmail","draftId":"d-1"}')).toEqual(
      { provider: "gmail", draftId: "d-1" }
    )
  })

  it("enqueueDraftMirrorUpsert queues a draft_upsert with the stable Message-ID MIME", async () => {
    const saved = await saveDraft(executor, {
      accountId,
      draftKey: "k",
      draft: draftInput(),
    })
    await enqueueDraftMirrorUpsert(executor, accountId, saved, draftInput())

    const ops = await queuedOps()
    expect(ops).toHaveLength(1)
    expect(ops[0]).toMatchObject({
      kind: "draft_upsert",
      accountId,
      draftId: saved.id,
    })
    if (ops[0].kind !== "draft_upsert") return
    expect(ops[0].mime).toContain(`Message-ID: ${draftMessageId(saved.id)}`)
    expect(ops[0].mime).toContain("Subject: Hello")
    expect(ops[0].mime).toContain("alice@x.com")
  })

  it("enqueueDraftMirrorUpsert is a silent no-op when the account is gone", async () => {
    await enqueueDraftMirrorUpsert(
      executor,
      "missing-account",
      { id: "row" },
      draftInput()
    )
    expect(await queuedOps()).toHaveLength(0)
    expect(consoleWarn).not.toHaveBeenCalled()
  })

  it("deleteDraft enqueues draft_delete for a mirrored row and none for a plain row", async () => {
    const mirrored = await saveDraft(executor, {
      accountId,
      draftKey: "mirrored",
      draft: draftInput(),
    })
    await setDraftServerRef(executor, mirrored.id, {
      provider: "gmail",
      draftId: "draft-9",
    })
    const plain = await saveDraft(executor, {
      accountId,
      draftKey: "plain",
      draft: draftInput(),
    })

    await deleteDraft(executor, plain.id)
    expect(await queuedOps()).toHaveLength(0)

    await deleteDraft(executor, mirrored.id)
    const ops = await queuedOps()
    expect(ops).toEqual([
      {
        accountId,
        kind: "draft_delete",
        ref: { provider: "gmail", draftId: "draft-9" },
      },
    ])
    expect(await getDraft(executor, mirrored.id)).toBeNull()
  })

  it("deleteDraftByKey enqueues the mirror delete for the composer's discard path", async () => {
    const saved = await saveDraft(executor, {
      accountId,
      draftKey: "k",
      draft: draftInput(),
    })
    await setDraftServerRef(executor, saved.id, {
      provider: "imap",
      folder: "Drafts",
      uid: 44,
    })

    await deleteDraftByKey(executor, accountId, "k")

    expect(await queuedOps()).toEqual([
      {
        accountId,
        kind: "draft_delete",
        ref: { provider: "imap", folder: "Drafts", uid: 44 },
      },
    ])
  })

  it("saveServerDraft upserts fetched drafts by key with their ref (no mirror ops)", async () => {
    const first = await saveServerDraft(executor, {
      accountId,
      draftKey: "server:<fetched-1@x.com>",
      ref: { provider: "gmail", draftId: "srv-1" },
      fields: {
        to: [{ email: "bob@x.com" }],
        cc: [],
        bcc: [],
        subject: "From the web",
        bodyHtml: "<p>remote</p>",
      },
    })
    expect(first.created).toBe(true)

    // Re-fetch of the same server draft: same key updates in place.
    const second = await saveServerDraft(executor, {
      accountId,
      draftKey: "server:<fetched-1@x.com>",
      ref: { provider: "gmail", draftId: "srv-1" },
      fields: {
        to: [{ email: "bob@x.com" }],
        cc: [],
        bcc: [],
        subject: "From the web (edited elsewhere)",
        bodyHtml: "<p>remote v2</p>",
      },
    })
    expect(second).toEqual({ id: first.id, created: false })

    const drafts = await listDrafts(executor, accountId)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({
      draftKey: "server:<fetched-1@x.com>",
      subject: "From the web (edited elsewhere)",
      bodyHtml: "<p>remote v2</p>",
      serverDraftRef: { provider: "gmail", draftId: "srv-1" },
    })
    // Fetching never pushes back to the server.
    expect(await queuedOps()).toHaveLength(0)
  })
})
