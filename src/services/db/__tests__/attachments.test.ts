import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  clearCacheEntry,
  ensureAttachmentRow,
  getAttachment,
  getAttachmentsForMessage,
  listCachedForAccount,
  listCachedOldestFirst,
  markCached,
  nowSeconds,
  touchCacheAccess,
  totalCacheSize,
  type AttachmentMetadataInput,
} from "../attachments"
import type { AttachmentRow } from "../messages"
import { createAccount, createMessage, createThread, uid } from "./fixtures"
import { createTestExecutor, type TestExecutor } from "./test-executor"

describe("attachments queries", () => {
  let executor: TestExecutor
  let accountId: string
  let messageId: string
  let attachmentId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "imap")
    const threadId = await createThread(executor, accountId)
    messageId = await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_000_000,
      subject: "with attachment",
      attachments: [
        {
          id: uid("att"),
          filename: "report.pdf",
          mimeType: "application/pdf",
          size: 4,
          providerPartId: "2",
        },
      ],
    })
    attachmentId = (await getAttachmentsForMessage(executor, messageId))[0].id
  })

  afterEach(() => {
    executor.close()
  })

  function seedSecondAttachment(
    partId: string,
    filename: string
  ): Promise<void> {
    return ensureAttachmentRow(executor, accountId, messageId, {
      filename,
      providerPartId: partId,
    })
  }

  it("lists a message's attachments in insertion order", async () => {
    await seedSecondAttachment("1.2", "nested.bin")

    const rows = await getAttachmentsForMessage(executor, messageId)

    expect(rows.map((row) => row.provider_part_id)).toEqual(["2", "1.2"])
    expect(rows[0]).toMatchObject({
      message_id: messageId,
      account_id: accountId,
      filename: "report.pdf",
      mime_type: "application/pdf",
      size: 4,
      is_inline: 0,
      local_path: null,
      cached_at: null,
      cache_size: null,
    })
    // ensureAttachmentRow derives `<messageId>-<partId>` ids.
    expect(rows[1].id).toBe(`${messageId}-1.2`)
  })

  it("returns an empty list for a message without attachments", async () => {
    expect(await getAttachmentsForMessage(executor, "missing")).toEqual([])
  })

  it("gets one attachment by id and null when missing", async () => {
    expect((await getAttachment(executor, attachmentId))?.filename).toBe(
      "report.pdf"
    )
    expect(await getAttachment(executor, "nope")).toBeNull()
  })

  describe("ensureAttachmentRow", () => {
    const part = (
      overrides: AttachmentMetadataInput = {}
    ): AttachmentMetadataInput => ({
      filename: "extra.zip",
      mimeType: "application/zip",
      size: 10,
      isInline: false,
      providerPartId: "3",
      ...overrides,
    })

    it("inserts a missing part and derives the row id", async () => {
      await ensureAttachmentRow(executor, accountId, messageId, part())

      expect(await getAttachment(executor, `${messageId}-3`)).toMatchObject({
        message_id: messageId,
        account_id: accountId,
        filename: "extra.zip",
        mime_type: "application/zip",
        size: 10,
        provider_part_id: "3",
        cache_size: null,
      })
    })

    it("is idempotent by message_id + provider_part_id: metadata refreshes, cache columns survive", async () => {
      await markCached(
        executor,
        attachmentId,
        "attachment_cache/x.bin",
        4,
        () => 50
      )

      await ensureAttachmentRow(executor, accountId, messageId, {
        filename: "renamed.pdf",
        size: 99,
        providerPartId: "2",
      })

      const updated = await getAttachment(executor, attachmentId)
      expect(updated?.filename).toBe("renamed.pdf")
      expect(updated?.size).toBe(99)
      expect(updated).toMatchObject({
        local_path: "attachment_cache/x.bin",
        cached_at: 50,
        cache_size: 4,
      })
    })

    it("does not duplicate rows when called twice", async () => {
      await ensureAttachmentRow(executor, accountId, messageId, part())
      await ensureAttachmentRow(executor, accountId, messageId, part())

      expect(await getAttachmentsForMessage(executor, messageId)).toHaveLength(
        2 // seeded "2" + the single "3"
      )
      expect(
        (await getAttachmentsForMessage(executor, messageId)).filter(
          (row: AttachmentRow) => row.provider_part_id === "3"
        )
      ).toHaveLength(1)
    })
  })

  describe("cache bookkeeping", () => {
    it("markCached records path, stamp and size at the given time", async () => {
      await markCached(
        executor,
        attachmentId,
        "attachment_cache/a.bin",
        4,
        () => 42
      )

      expect(await getAttachment(executor, attachmentId)).toMatchObject({
        local_path: "attachment_cache/a.bin",
        cached_at: 42,
        cache_size: 4,
      })
    })

    it("touchCacheAccess refreshes only the LRU stamp", async () => {
      await markCached(
        executor,
        attachmentId,
        "attachment_cache/a.bin",
        4,
        () => 42
      )

      await touchCacheAccess(executor, attachmentId, () => 77)

      expect(await getAttachment(executor, attachmentId)).toMatchObject({
        cached_at: 77,
        local_path: "attachment_cache/a.bin",
        cache_size: 4,
      })
    })

    it("nowSeconds is unix seconds", () => {
      expect(nowSeconds()).toBeLessThanOrEqual(Date.now() / 1000 + 1)
      expect(nowSeconds()).toBeGreaterThan(1_600_000_000)
    })

    it("clearCacheEntry nulls the cache columns", async () => {
      await markCached(
        executor,
        attachmentId,
        "attachment_cache/a.bin",
        4,
        () => 42
      )

      await clearCacheEntry(executor, attachmentId)

      expect(await getAttachment(executor, attachmentId)).toMatchObject({
        local_path: null,
        cached_at: null,
        cache_size: null,
      })
    })
  })

  describe("eviction listing and totals", () => {
    async function seedCachedOnOtherAccount(
      cachedAt: number
    ): Promise<AttachmentRow> {
      const otherAccount = await createAccount(executor, "gmail")
      const otherThread = await createThread(executor, otherAccount)
      const otherMessage = await createMessage(executor, {
        threadId: otherThread,
        accountId: otherAccount,
        date: 1_700_000_000,
        attachments: [{ id: uid("att"), filename: "b.bin", size: 8 }],
      })
      const row = (await getAttachmentsForMessage(executor, otherMessage))[0]
      await markCached(executor, row.id, "p/b.bin", 8, () => cachedAt)
      return row
    }

    it("lists cached entries oldest-first, globally", async () => {
      await markCached(executor, attachmentId, "p/a.bin", 4, () => 30)
      await seedCachedOnOtherAccount(20)

      expect(
        (await listCachedOldestFirst(executor)).map((row) => row.local_path)
      ).toEqual(["p/b.bin", "p/a.bin"])
    })

    it("listCachedForAccount filters by account", async () => {
      await markCached(executor, attachmentId, "p/a.bin", 4, () => 30)
      await seedCachedOnOtherAccount(20)

      const own = await listCachedForAccount(executor, accountId)
      expect(own).toHaveLength(1)
      expect(own[0]).toMatchObject({ local_path: "p/a.bin", cached_at: 30 })
    })

    it("respects the candidate limit", async () => {
      await markCached(executor, attachmentId, "p/a.bin", 4, () => 30)
      await seedCachedOnOtherAccount(20)

      expect(await listCachedOldestFirst(executor, 1)).toHaveLength(1)
    })

    it("totalCacheSize sums globally and ignores uncached rows", async () => {
      expect(await totalCacheSize(executor)).toBe(0)

      await markCached(executor, attachmentId, "p/a.bin", 4, () => 30)
      await seedCachedOnOtherAccount(20)

      expect(await totalCacheSize(executor)).toBe(12)
    })
  })
})
