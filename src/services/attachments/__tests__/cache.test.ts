import { beforeEach, describe, expect, it } from "vitest"

import { ensureAttachmentRow } from "../../db/attachments"
import {
  createAccount,
  createMessage,
  createThread,
} from "../../db/__tests__/fixtures"
import type { AttachmentRow } from "../../db/messages"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import type { EmailAccount } from "../../email/types"
import {
  attachmentCachePath,
  base64ToBytes,
  base64UrlToBytes,
  defaultFetchAttachment,
  enforceCacheCap,
  ensureAttachmentCached,
  getAttachmentContent,
  sha256Hex,
  type AttachmentDeps,
  type AttachmentMessageSource,
  type CacheFs,
  type FetchAttachmentFn,
} from "../cache"

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function imapAccount(): EmailAccount {
  return {
    id: "acc-cache",
    type: "imap",
    email: "user@example.com",
    imapHost: "imap.example.com",
    imapPort: 993,
    imapSecurity: "tls",
    status: "active",
    isActive: true,
    isPinned: false,
  }
}

function messageSource(
  overrides: Partial<AttachmentMessageSource> = {}
): AttachmentMessageSource {
  return {
    gmail_message_id: "gm-1",
    imap_folder: "INBOX",
    imap_uid: 101,
    ...overrides,
  }
}

function attachmentRow(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: "att-1",
    message_id: "msg-cache",
    account_id: "acc-cache",
    filename: "report.pdf",
    mime_type: "application/pdf",
    size: 4,
    content_id: null,
    is_inline: 0,
    provider_part_id: "2",
    local_path: null,
    cached_at: null,
    cache_size: null,
    ...overrides,
  }
}

/** In-memory CacheFs double (the "disk"). */
function memFs(): CacheFs & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>()
  return {
    files,
    async ensureCacheDir() {},
    async writeFile(relPath, data) {
      files.set(relPath, data)
    },
    async readFile(relPath) {
      const data = files.get(relPath)
      if (!data) throw new Error(`ENOENT ${relPath}`)
      return data
    },
    async removeFile(relPath) {
      if (!files.delete(relPath)) throw new Error(`ENOENT ${relPath}`)
    },
  }
}

interface Harness {
  executor: TestExecutor
  accountId: string
  messageId: string
  fs: ReturnType<typeof memFs>
  fetchCalls: string[]
  now: () => number
  deps(overrides?: AttachmentDeps): AttachmentDeps
  /** Insert a real attachment row through the query layer. */
  seedRow(overrides?: Partial<AttachmentRow>): Promise<AttachmentRow>
}

async function harness(maxCacheBytes?: number): Promise<Harness> {
  const executor = createTestExecutor()
  const accountId = await createAccount(executor, "imap")
  const threadId = await createThread(executor, accountId)
  const messageId = await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_000_000,
    imapFolder: "INBOX",
    imapUid: 101,
  })

  const fs = memFs()
  const fetchCalls: string[] = []
  const fetchAttachment: FetchAttachmentFn = async (_account, _msg, row) => {
    fetchCalls.push(row.id)
    return new Uint8Array([1, 2, 3, 4])
  }
  let tick = 10
  const now = () => tick++

  async function seedRow(
    overrides: Partial<AttachmentRow> = {}
  ): Promise<AttachmentRow> {
    const row = attachmentRow({ message_id: messageId, ...overrides })
    await ensureAttachmentRow(executor, accountId, messageId, {
      id: row.id,
      filename: row.filename ?? undefined,
      mimeType: row.mime_type ?? undefined,
      size: row.size ?? undefined,
      providerPartId: row.provider_part_id ?? undefined,
    })
    return row
  }

  return {
    executor,
    accountId,
    messageId,
    fs,
    fetchCalls,
    now,
    deps: (overrides: AttachmentDeps = {}) => ({
      fetchAttachment,
      fs,
      now,
      hash: async (key) => `h(${key})`,
      ...(maxCacheBytes !== undefined ? { maxCacheBytes } : {}),
      ...overrides,
    }),
    seedRow,
  }
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

describe("attachment cache encoding helpers", () => {
  it("base64ToBytes decodes the Rust wire payload", () => {
    expect(new TextDecoder().decode(base64ToBytes("JVBERi0xLjQ="))).toBe(
      "%PDF-1.4"
    )
    expect(base64ToBytes("")).toHaveLength(0)
    expect(base64ToBytes("Zg==")[0]).toBe(102)
  })

  it("base64UrlToBytes accepts the url-safe alphabet and missing padding", () => {
    // base64 "Zm8+YmF6/w==" ↔ base64url "Zm8-YmF6_w" (padding stripped).
    const decoded = base64UrlToBytes("Zm8-YmF6_w")
    expect(Array.from(decoded)).toEqual(
      Array.from(base64ToBytes("Zm8+YmF6/w=="))
    )
  })

  it("attachmentCachePath hashes the identity tuple into a .bin path", async () => {
    const path = await attachmentCachePath(
      "acc",
      "msg",
      "1.2",
      "report.pdf",
      async (key) => `h:${key}`
    )
    expect(path).toBe("attachment_cache/h:acc|msg|1.2|report.pdf.bin")
  })

  it("sha256Hex produces a 64-char hex digest (WebCrypto)", async () => {
    const digest = await sha256Hex("abc")
    expect(digest).toMatch(/^[0-9a-f]{64}$/)
  })

  it("defaultFetchAttachment rejects early on missing provider keys", async () => {
    const gmailShell: EmailAccount = {
      id: "g",
      type: "gmail",
      email: "g@g.com",
      status: "active",
      isActive: true,
      isPinned: false,
    }
    const imapShell: EmailAccount = {
      id: "i",
      type: "imap",
      email: "u@x.com",
      status: "active",
      isActive: true,
      isPinned: false,
    }

    await expect(
      defaultFetchAttachment(
        gmailShell,
        messageSource({ gmail_message_id: null }),
        attachmentRow()
      )
    ).rejects.toThrow("missing the server message id")

    await expect(
      defaultFetchAttachment(
        imapShell,
        messageSource(),
        attachmentRow({ provider_part_id: null })
      )
    ).rejects.toThrow("no provider part id")

    await expect(
      defaultFetchAttachment(imapShell, messageSource(), attachmentRow())
    ).rejects.toThrow("missing server configuration")
  })
})

// ---------------------------------------------------------------------------
// Cache flow
// ---------------------------------------------------------------------------

describe("attachment cache flow", () => {
  let h: Harness

  beforeEach(async () => {
    h = await harness()
  })

  it("fetches on first access, caches to disk and marks the row", async () => {
    const row = await h.seedRow()

    const result = await ensureAttachmentCached(
      h.executor,
      imapAccount(),
      messageSource(),
      row,
      h.deps()
    )

    expect(result.fromCache).toBe(false)
    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4])
    expect(h.fetchCalls).toEqual([row.id])
    expect(result.localPath).toMatch(/^attachment_cache\/h\(.*\)\.bin$/)
    expect(h.fs.files.get(result.localPath)).toBeDefined()

    const stored = await h.executor.select<{
      local_path: string
      cached_at: number
      cache_size: number
    }>(
      "SELECT local_path, cached_at, cache_size FROM attachments WHERE id = $1",
      [row.id]
    )
    expect(stored[0]).toMatchObject({
      local_path: result.localPath,
      cached_at: 10,
      cache_size: 4,
    })
  })

  it("serves the second access from disk without refetching (cache hit)", async () => {
    const row = await h.seedRow()
    const deps = h.deps()

    await ensureAttachmentCached(
      h.executor,
      imapAccount(),
      messageSource(),
      row,
      deps
    )
    const second = await ensureAttachmentCached(
      h.executor,
      imapAccount(),
      messageSource(),
      row,
      deps
    )

    expect(h.fetchCalls).toHaveLength(1) // no refetch
    expect(second.fromCache).toBe(true)
    expect(Array.from(second.bytes)).toEqual([1, 2, 3, 4])
    // LRU-by-access: the hit refreshed cached_at.
    const stored = await h.executor.select<{ cached_at: number }>(
      "SELECT cached_at FROM attachments WHERE id = $1",
      [row.id]
    )
    expect(stored[0].cached_at).toBe(11)
  })

  it("refetches and re-caches when the claimed file is missing (corrupt state)", async () => {
    const row = await h.seedRow()
    const deps = h.deps()

    const first = await ensureAttachmentCached(
      h.executor,
      imapAccount(),
      messageSource(),
      row,
      deps
    )
    h.fs.files.delete(first.localPath) // file vanishes, DB still claims it

    const second = await ensureAttachmentCached(
      h.executor,
      imapAccount(),
      messageSource(),
      row,
      deps
    )

    expect(h.fetchCalls).toHaveLength(2) // refetched
    expect(second.fromCache).toBe(false)
    expect(h.fs.files.get(second.localPath)).toBeDefined() // re-cached
  })

  it("getAttachmentContent returns just the bytes", async () => {
    const row = await h.seedRow()

    const bytes = await getAttachmentContent(
      h.executor,
      imapAccount(),
      messageSource(),
      row,
      h.deps()
    )

    expect(Array.from(bytes)).toEqual([1, 2, 3, 4])
  })

  it("evicts the least recently used entry when the total cap is exceeded", async () => {
    const small = await harness(25) // three 10-byte entries overflow it
    const a = await small.seedRow({ id: "att-a", provider_part_id: "a" })
    const b = await small.seedRow({ id: "att-b", provider_part_id: "b" })
    const c = await small.seedRow({ id: "att-c", provider_part_id: "c" })

    const write = (row: AttachmentRow) =>
      ensureAttachmentCached(
        small.executor,
        imapAccount(),
        messageSource(),
        row,
        {
          ...small.deps(),
          fetchAttachment: async () => new Uint8Array(10),
        }
      )

    const first = await write(a)
    const second = await write(b)
    // Touch a AFTER b was written: b is now the least recently used.
    await ensureAttachmentCached(
      small.executor,
      imapAccount(),
      messageSource(),
      a,
      small.deps()
    )

    await write(c)

    // b evicted: file gone, cache columns cleared.
    expect(small.fs.files.has(second.localPath)).toBe(false)
    const bRow = await small.executor.select<AttachmentRow>(
      "SELECT * FROM attachments WHERE id = 'att-b'"
    )
    expect(bRow[0]).toMatchObject({
      local_path: null,
      cached_at: null,
      cache_size: null,
    })

    // a (touched) and c (just written) survive.
    expect(small.fs.files.has(first.localPath)).toBe(true)
    const survivors = await small.executor.select<{ id: string }>(
      "SELECT id FROM attachments WHERE cached_at IS NOT NULL ORDER BY id"
    )
    expect(survivors.map((row) => row.id)).toEqual(["att-a", "att-c"])
  })

  it("enforceCacheCap skips the just-written entry and stops when nothing is evictable", async () => {
    const fs = memFs()
    fs.files.set("p/only.bin", new Uint8Array(1))
    await h.executor.execute(
      `INSERT INTO attachments (id, message_id, account_id, provider_part_id,
        local_path, cached_at, cache_size)
      VALUES ('att-big', $1, $2, '1', 'p/only.bin', 1, 999)`,
      [h.messageId, h.accountId]
    )

    // Cap far below the row's size; the only candidate is the just-written
    // entry itself, so nothing is evicted and no error is thrown.
    await enforceCacheCap(h.executor, fs, { fs, maxCacheBytes: 10 }, "att-big")

    expect(fs.files.has("p/only.bin")).toBe(true)
    const row = await h.executor.select<AttachmentRow>(
      "SELECT * FROM attachments WHERE id = 'att-big'"
    )
    expect(row[0].cached_at).toBe(1)
  })
})
