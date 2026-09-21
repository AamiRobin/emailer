import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { clearAttachmentBytes, setAttachmentBytes } from "@/components/composer/attachment-bytes"
import {
  AttachmentTooLargeError,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from "@/components/composer/attachment-input"
import type { ComposerAttachment } from "@/stores/composer-store"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { createAccount } from "@/services/db/__tests__/fixtures"
import { deleteDraft, deleteDraftByKey, saveDraft } from "../drafts"
import {
  deleteDraftAttachmentBytes,
  restoreDraftAttachmentBytes,
  syncDraftAttachmentBytes,
} from "../draft-attachments"

/**
 * Draft attachment byte persistence (batch C1, fix 1): sync reconciles
 * the draft_attachments rows with the composer's attachment list (bytes
 * read from the session registry), restore decodes + validates them for
 * resume, and the draft deletions in drafts.ts take the rows with them.
 */

function attachment(
  id: string,
  name: string,
  size: number,
  mimeType?: string
): ComposerAttachment {
  return {
    id,
    name,
    size,
    ...(mimeType !== undefined ? { mimeType } : {}),
  }
}

describe("draft attachment bytes service", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor)
  })

  afterEach(() => {
    clearAttachmentBytes()
    executor.close()
  })

  async function storedRows(draftKey: string) {
    return executor.select<{
      id: string
      name: string
      mime_type: string | null
      size: number
      content_base64: string
    }>(
      `SELECT id, name, mime_type, size, content_base64
       FROM draft_attachments WHERE draft_key = $1 ORDER BY rowid`,
      [draftKey]
    )
  }

  it("persists bytes for the current list on the first sync", async () => {
    setAttachmentBytes("a1", new Uint8Array([1, 2, 3, 4]))
    setAttachmentBytes("a2", new Uint8Array([9]))
    await syncDraftAttachmentBytes(executor, accountId, "key-1", [
      attachment("a1", "report.pdf", 4, "application/pdf"),
      attachment("a2", "notes.txt", 1, "text/plain"),
    ])

    const rows = await storedRows("key-1")
    expect(rows.map((row) => row.name)).toEqual(["report.pdf", "notes.txt"])
    expect(rows[0]).toMatchObject({
      id: "a1",
      mime_type: "application/pdf",
      size: 4,
      content_base64: btoa(String.fromCharCode(1, 2, 3, 4)),
    })
  })

  it("removes the row of an attachment removed while composing", async () => {
    setAttachmentBytes("a1", new Uint8Array([1]))
    setAttachmentBytes("a2", new Uint8Array([2]))
    const withBoth = [
      attachment("a1", "a.txt", 1),
      attachment("a2", "b.txt", 1),
    ]
    await syncDraftAttachmentBytes(executor, accountId, "key-1", withBoth)

    // a1 removed from the draft: its row must go, a2 stays.
    await syncDraftAttachmentBytes(executor, accountId, "key-1", [
      withBoth[1]!,
    ])
    const rows = await storedRows("key-1")
    expect(rows.map((row) => row.id)).toEqual(["a2"])
  })

  it("skips attachments whose bytes are not registered and rewrites nothing when unchanged", async () => {
    setAttachmentBytes("a1", new Uint8Array([1, 2]))
    await syncDraftAttachmentBytes(executor, accountId, "key-1", [
      attachment("a1", "kept.txt", 2),
      attachment("ghost", "ghost.txt", 3),
    ])
    expect((await storedRows("key-1")).map((row) => row.id)).toEqual(["a1"])

    // Freeze created_at, then re-sync the identical list: an upsert would
    // reset it (INSERT OR REPLACE re-runs the DEFAULT) — a no-op sync
    // leaves it untouched.
    await executor.execute(
      "UPDATE draft_attachments SET created_at = 42 WHERE id = 'a1'"
    )
    setAttachmentBytes("a1", new Uint8Array([1, 2]))
    await syncDraftAttachmentBytes(executor, accountId, "key-1", [
      attachment("a1", "kept.txt", 2),
    ])
    const rows = await executor.select<{ created_at: number }>(
      "SELECT created_at FROM draft_attachments WHERE id = 'a1'"
    )
    expect(rows[0]?.created_at).toBe(42)
  })

  it("restores decoded bytes and metadata for a fresh session", async () => {
    const original = new Uint8Array([1, 2, 3, 4])
    setAttachmentBytes("a1", original)
    await syncDraftAttachmentBytes(executor, accountId, "key-1", [
      attachment("a1", "report.pdf", 4, "application/pdf"),
    ])

    // Session loss: the registry is gone; only the store survives.
    clearAttachmentBytes()
    const restored = await restoreDraftAttachmentBytes(
      executor,
      accountId,
      "key-1"
    )
    expect(restored.dropped).toEqual([])
    expect(restored.attachments).toHaveLength(1)
    expect(restored.attachments[0]).toMatchObject({
      id: "a1",
      name: "report.pdf",
      size: 4,
      mimeType: "application/pdf",
    })
    expect(restored.attachments[0]?.bytes).toEqual(original)
  })

  it("drops a corrupt stored payload softly, keeping the rest", async () => {
    setAttachmentBytes("good", new Uint8Array([1, 2, 3]))
    setAttachmentBytes("bad", new Uint8Array([7, 7, 7]))
    await syncDraftAttachmentBytes(executor, accountId, "key-1", [
      attachment("good", "good.txt", 3),
      attachment("bad", "bad.txt", 3),
    ])
    await executor.execute(
      "UPDATE draft_attachments SET content_base64 = '!!!not-base64!!!' WHERE id = 'bad'"
    )

    const restored = await restoreDraftAttachmentBytes(
      executor,
      accountId,
      "key-1"
    )
    expect(restored.attachments.map((a) => a.name)).toEqual(["good.txt"])
    expect(restored.dropped).toEqual(["bad.txt"])
  })

  it("drops a payload whose decoded length disagrees with its stored size", async () => {
    setAttachmentBytes("a1", new Uint8Array([1, 2, 3]))
    await syncDraftAttachmentBytes(executor, accountId, "key-1", [
      attachment("a1", "truncated.txt", 3),
    ])
    // Tampered metadata: the stored size no longer matches the bytes.
    await executor.execute(
      "UPDATE draft_attachments SET size = 99 WHERE id = 'a1'"
    )

    const restored = await restoreDraftAttachmentBytes(
      executor,
      accountId,
      "key-1"
    )
    expect(restored.attachments).toEqual([])
    expect(restored.dropped).toEqual(["truncated.txt"])
  })

  it("drops an oversized stored payload and caps the restored total", async () => {
    // An oversized row (impossible via the add-time caps) is dropped;
    // a later row that would push the total past 25 MB is dropped too.
    setAttachmentBytes("ok", new Uint8Array([1]))
    setAttachmentBytes("over", new Uint8Array([2]))
    await syncDraftAttachmentBytes(executor, accountId, "key-1", [
      attachment("ok", "ok.txt", 1),
      attachment("over", "over.txt", 1),
    ])
    await executor.execute(
      `UPDATE draft_attachments SET size = ${MAX_TOTAL_ATTACHMENT_BYTES + 1}
       WHERE id = 'over'`
    )

    const restored = await restoreDraftAttachmentBytes(
      executor,
      accountId,
      "key-1"
    )
    expect(restored.attachments.map((a) => a.name)).toEqual(["ok.txt"])
    expect(restored.dropped).toEqual(["over.txt"])
  })

  it("deletes the rows with the draft via deleteDraftByKey (send/discard)", async () => {
    setAttachmentBytes("a1", new Uint8Array([1]))
    await syncDraftAttachmentBytes(executor, accountId, "key-1", [
      attachment("a1", "a.txt", 1),
    ])
    await saveDraft(executor, {
      accountId,
      draftKey: "key-1",
      draft: {
        to: [],
        cc: [],
        bcc: [],
        subject: "with attachment",
        bodyHtml: "",
        attachments: [{ filename: "a.txt", size: 1 }],
      },
    })

    await deleteDraftByKey(executor, accountId, "key-1")
    expect(await storedRows("key-1")).toEqual([])
  })

  it("deletes the rows with the draft via deleteDraft", async () => {
    setAttachmentBytes("a1", new Uint8Array([1]))
    await syncDraftAttachmentBytes(executor, accountId, "key-2", [
      attachment("a1", "a.txt", 1),
    ])
    const saved = await saveDraft(executor, {
      accountId,
      draftKey: "key-2",
      draft: {
        to: [],
        cc: [],
        bcc: [],
        subject: "row",
        bodyHtml: "",
      },
    })

    await deleteDraft(executor, saved.id)
    expect(await storedRows("key-2")).toEqual([])
  })

  it("deleteDraftAttachmentBytes tolerates a blank key", async () => {
    await expect(
      deleteDraftAttachmentBytes(executor, accountId, "")
    ).resolves.toBeUndefined()
  })

  it("the typed single-attachment cap still governs what can be stored", () => {
    // The restore-side oversized guard mirrors this add-time bound; the
    // typed error keeps its user-facing size text.
    expect(
      new AttachmentTooLargeError("f.bin", 21 * 1024 * 1024).message
    ).toContain("20 MB")
  })
})
