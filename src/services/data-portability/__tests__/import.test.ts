import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Import tests (task 19.3). The Rust parse commands and every side effect
 * (provider upload, attachment-cache disk) are injected fakes, the
 * executor is the real node:sqlite schema — the assertions cover the
 * fixture-mbox scenario: folder creation by name, message + attachment
 * persistence in the target folder (read state, threading, FTS), Message-
 * ID dedupe on re-import, per-entry failure reports that never abort the
 * batch, and the optional server upload receiving the raw source bytes.
 */

const executorHolder = vi.hoisted(() => ({
  current: null as unknown,
}))

// The module imports the Tauri invoke/plugin surfaces for its defaults —
// tests inject fakes, so the bridges only need to exist.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => {
    throw new Error("rust invoke not expected in tests")
  }),
}))

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
}))

import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import type { ParsedEml } from "../../email/invoke"
import type { CacheFs } from "../../attachments/cache"
import { importFiles, pickImportFiles, type ImportDeps } from "../import"
import { open } from "@tauri-apps/plugin-dialog"

let executor: TestExecutor

const ACCOUNT = "acc-1"

/** A fully-populated parsed message (the shape mail_import.rs returns). */
function parsedMessage(overrides: Partial<ParsedEml> = {}): ParsedEml {
  return {
    messageId: "<m@example.com>",
    inReplyTo: null,
    references: null,
    listUnsubscribe: null,
    listUnsubscribePost: null,
    subject: "Imported",
    from: [{ name: "Alice", email: "alice@example.com" }],
    to: [{ name: null, email: "bob@example.com" }],
    cc: [],
    bcc: [],
    date: 1_700_000_100,
    textBody: "Hello Bob.",
    htmlBody: null,
    attachments: [],
    size: 256,
    rawBase64: "RnJvbTogYWxpY2VAZXhhbXBsZS5jb20=",
    ...overrides,
  }
}

/** Two messages: a root and its reply (references chain), plus one
 * attachment-carrying message — the fixture mbox's content. */
function fixtureMboxEntries(): ParsedEml[] {
  return [
    parsedMessage({
      messageId: "<root@example.com>",
      subject: "Thread root",
      date: 1_700_000_100,
    }),
    parsedMessage({
      messageId: "<reply@example.com>",
      inReplyTo: "<root@example.com>",
      subject: "Re: Thread root",
      date: 1_700_000_200,
    }),
    parsedMessage({
      messageId: "<with-attachment@example.com>",
      subject: "Invoice",
      date: 1_700_000_300,
      attachments: [
        {
          filename: "invoice.pdf",
          contentType: "application/pdf",
          contentId: null,
          isInline: false,
          size: 9,
          base64Bytes: "JVBERi0xLjQK",
        },
      ],
    }),
  ]
}

/** In-memory CacheFs recording writes; reads return the written bytes. */
function fakeCacheFs(): CacheFs & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>()
  return {
    files,
    ensureCacheDir: async () => {},
    writeFile: async (relPath, data) => {
      files.set(relPath, data)
    },
    readFile: async (relPath) => {
      const bytes = files.get(relPath)
      if (!bytes) throw new Error(`missing ${relPath}`)
      return bytes
    },
    removeFile: async (relPath) => {
      files.delete(relPath)
    },
  }
}

/** Deps whose parseMbox yields the given entries and whose upload
 * recordings are observable. */
function fakeDeps(mboxEntries: ParsedEml[]): {
  deps: ImportDeps
  uploads: { folder: string; raw: string }[]
  cacheFs: ReturnType<typeof fakeCacheFs>
} {
  const uploads: { folder: string; raw: string }[] = []
  const cacheFs = fakeCacheFs()
  return {
    uploads,
    cacheFs,
    deps: {
      parseEml: vi.fn(async () => mboxEntries[0]),
      parseMbox: vi.fn(async () =>
        mboxEntries.map((message, index) => ({ index, error: null, message }))
      ),
      uploadMessage: async (folder, raw) => {
        uploads.push({
          folder,
          raw: new TextDecoder().decode(raw),
        })
      },
      cacheFs,
    },
  }
}

async function importMbox(
  destination: Parameters<typeof importFiles>[1]["destination"],
  mboxEntries: ParsedEml[],
  options: Partial<Parameters<typeof importFiles>[1]> = {},
  depsOverride: Partial<ImportDeps> = {}
) {
  const { deps } = fakeDeps(mboxEntries)
  return importFiles(
    executor,
    {
      accountId: ACCOUNT,
      destination,
      filePaths: ["/picked/backup.mbox"],
      ...options,
    },
    { ...deps, ...depsOverride }
  )
}

beforeEach(async () => {
  executor = createTestExecutor()
  executorHolder.current = executor
  await executor.execute(
    "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
    [ACCOUNT, "imap", `${ACCOUNT}@example.com`]
  )
})

afterEach(() => {
  executor.close()
  vi.clearAllMocks()
})

describe("importFiles destination", () => {
  it("creates a new folder by name (canonical label id + server create queued)", async () => {
    const summary = await importMbox(
      { kind: "folderName", name: "Archive/2024" },
      fixtureMboxEntries()
    )

    expect(summary.status).toBe("complete")
    expect(summary.imported).toBe(3)
    const rows = await executor.select<{
      id: string
      name: string
      imap_folder_name: string | null
      type: string
    }>(
      "SELECT id, name, imap_folder_name, type FROM labels WHERE account_id = $1",
      [ACCOUNT]
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: `${ACCOUNT}:folder-Archive/2024`,
      name: "Archive/2024",
      imap_folder_name: "Archive/2024",
      type: "user",
    })
    // The server-side folder create rides the existing queue vocabulary.
    const ops = await executor.select<{ op_type: string }>(
      "SELECT op_type FROM pending_operations WHERE account_id = $1",
      [ACCOUNT]
    )
    expect(ops.map((op) => op.op_type)).toEqual(["create_folder"])
  })

  it("reuses an existing folder and never modifies it", async () => {
    await executor.execute(
      `INSERT INTO labels (id, account_id, name, imap_folder_name, type)
       VALUES ($1, $2, $3, $3, 'user')`,
      ["label-existing", ACCOUNT, "Receipts"]
    )
    const summary = await importMbox(
      { kind: "folderId", folderId: "label-existing" },
      fixtureMboxEntries()
    )
    expect(summary.folderLabelId).toBe("label-existing")
    expect(summary.folderName).toBe("Receipts")
    const ops = await executor.select<{ op_type: string }>(
      "SELECT op_type FROM pending_operations WHERE account_id = $1",
      [ACCOUNT]
    )
    expect(ops).toHaveLength(0)
  })

  it("rejects a folderId from another account", async () => {
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      ["acc-2", "imap", "two@example.com"]
    )
    await executor.execute(
      `INSERT INTO labels (id, account_id, name, imap_folder_name, type)
       VALUES ($1, $2, $3, $3, 'user')`,
      ["label-other", "acc-2", "Other"]
    )
    await expect(
      importMbox({ kind: "folderId", folderId: "label-other" }, [])
    ).rejects.toThrow("destination folder not found")
  })
})

describe("importFiles persistence", () => {
  it("inserts messages into the target folder, read, threaded, FTS-searchable", async () => {
    const summary = await importMbox(
      { kind: "folderName", name: "Backup" },
      fixtureMboxEntries()
    )

    const rows = await executor.select<{
      subject: string | null
      imap_folder: string | null
      is_read: number
      thread_id: string
      message_id_header: string | null
      snippet: string | null
    }>(
      "SELECT subject, imap_folder, is_read, thread_id, message_id_header, snippet FROM messages WHERE account_id = $1 ORDER BY date ASC",
      [ACCOUNT]
    )
    expect(rows).toHaveLength(3)
    for (const row of rows) {
      expect(row.imap_folder).toBe("Backup")
      // Imported backup mail is READ (module docs).
      expect(row.is_read).toBe(1)
    }
    // The reply joined the root's thread (references chain), the
    // attachment message got its own.
    expect(rows[0].thread_id).toBe(rows[1].thread_id)
    expect(rows[2].thread_id).not.toBe(rows[0].thread_id)
    expect(rows[0].snippet).toBe("Hello Bob.")

    // Thread folder stamping + cache recompute (counts update).
    const threads = await executor.select<{
      folder_label_id: string | null
      message_count: number
      unread_count: number
    }>(
      "SELECT folder_label_id, message_count, unread_count FROM threads WHERE account_id = $1",
      [ACCOUNT]
    )
    expect(threads).toHaveLength(2)
    for (const thread of threads) {
      expect(thread.folder_label_id).toBe(summary.folderLabelId)
      expect(thread.unread_count).toBe(0)
    }
    expect(threads.map((t) => t.message_count).sort()).toEqual([1, 2])

    // FTS indexing fired via the insert triggers (external-content
    // trigram index — the search module's join shape).
    const hits = await executor.select<{ subject: string }>(
      `SELECT m.subject FROM messages m
       JOIN messages_fts ON messages_fts.rowid = m.rowid
       WHERE messages_fts MATCH 'Invoice'`
    )
    expect(hits).toEqual([{ subject: "Invoice" }])
  })

  it("caches attachment bytes under the D15 cache layout", async () => {
    const { deps, cacheFs } = fakeDeps(fixtureMboxEntries())
    await importFiles(
      executor,
      {
        accountId: ACCOUNT,
        destination: { kind: "folderName", name: "Backup" },
        filePaths: ["/picked/backup.mbox"],
      },
      deps
    )

    const attachments = await executor.select<{
      filename: string | null
      local_path: string | null
      cache_size: number | null
      provider_part_id: string | null
      size: number | null
    }>(
      "SELECT filename, local_path, cache_size, provider_part_id, size FROM attachments WHERE account_id = $1",
      [ACCOUNT]
    )
    expect(attachments).toHaveLength(1)
    expect(attachments[0].filename).toBe("invoice.pdf")
    expect(attachments[0].local_path).toMatch(
      /^attachment_cache\/[0-9a-f]{64}\.bin$/
    )
    expect(attachments[0].cache_size).toBe(9)
    const bytes = cacheFs.files.get(attachments[0].local_path ?? "")
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe(
      "%PDF-1.4\n"
    )
  })

  it("stores no imap folder and no provider id for gmail accounts", async () => {
    await executor.execute("UPDATE accounts SET type = 'gmail' WHERE id = $1", [
      ACCOUNT,
    ])
    await importMbox({ kind: "folderName", name: "Backup" }, [parsedMessage()])
    const rows = await executor.select<{
      imap_folder: string | null
      gmail_message_id: string | null
    }>(
      "SELECT imap_folder, gmail_message_id FROM messages WHERE account_id = $1",
      [ACCOUNT]
    )
    expect(rows[0]).toEqual({ imap_folder: null, gmail_message_id: null })
  })
})

describe("importFiles dedupe (duplicate suppression scenario)", () => {
  it("skips every message when the same mbox imports into the same folder again", async () => {
    const first = await importMbox(
      { kind: "folderName", name: "Backup" },
      fixtureMboxEntries()
    )
    expect(first.imported).toBe(3)
    expect(first.skippedDuplicates).toBe(0)

    const second = await importMbox(
      { kind: "folderName", name: "Backup" },
      fixtureMboxEntries()
    )
    expect(second.status).toBe("complete")
    expect(second.imported).toBe(0)
    expect(second.skippedDuplicates).toBe(3)
    expect(second.failed).toBe(0)

    const count = await executor.select<{ n: number }>(
      "SELECT COUNT(*) AS n FROM messages WHERE account_id = $1",
      [ACCOUNT]
    )
    expect(count[0].n).toBe(3)
  })

  it("inserts again when the Message-ID exists only in another folder (cross-folder copy)", async () => {
    await importMbox({ kind: "folderName", name: "Backup" }, [
      parsedMessage({
        messageId: "<root@example.com>",
        subject: "Thread root",
      }),
    ])
    const second = await importMbox({ kind: "folderName", name: "Other" }, [
      parsedMessage({
        messageId: "<root@example.com>",
        subject: "Thread root",
      }),
    ])
    expect(second.imported).toBe(1)
    expect(second.skippedDuplicates).toBe(0)
    // The copy joins the original's conversation.
    const rows = await executor.select<{
      thread_id: string
      imap_folder: string
    }>(
      "SELECT thread_id, imap_folder FROM messages WHERE account_id = $1 ORDER BY date ASC",
      [ACCOUNT]
    )
    expect(rows).toHaveLength(2)
    expect(rows[0].thread_id).toBe(rows[1].thread_id)
  })
})

describe("importFiles safe failure", () => {
  it("reports failed entries per file without aborting the batch", async () => {
    const good = parsedMessage()
    const deps = {
      parseEml: vi.fn(async (path: string) => {
        if (path === "/picked/broken.eml") {
          throw new Error("could not read /picked/broken.eml: not mail")
        }
        return good
      }),
      parseMbox: vi.fn(async () => [
        { index: 0, error: null, message: good },
        {
          index: 1,
          error:
            "no subject or participant header found — not an RFC 822 message",
          message: null,
        },
        {
          index: 2,
          error: null,
          message: parsedMessage({ messageId: "<m2@example.com>" }),
        },
      ]),
      cacheFs: fakeCacheFs(),
    }
    const summary = await importFiles(
      executor,
      {
        accountId: ACCOUNT,
        destination: { kind: "folderName", name: "Backup" },
        filePaths: ["/picked/broken.eml", "/picked/mixed.mbox"],
      },
      deps
    )

    expect(summary.status).toBe("complete")
    expect(summary.imported).toBe(2)
    expect(summary.failed).toBe(2)
    const emlFile = summary.files.find((file) => file.kind === "eml")
    const mboxFile = summary.files.find((file) => file.kind === "mbox")
    expect(emlFile?.failed).toHaveLength(1)
    expect(mboxFile?.failed).toEqual([
      { index: 1, error: expect.stringContaining("not an RFC 822 message") },
    ])
    // The good entries around the bad one landed.
    const count = await executor.select<{ n: number }>(
      "SELECT COUNT(*) AS n FROM messages WHERE account_id = $1",
      [ACCOUNT]
    )
    expect(count[0].n).toBe(2)
  })

  it("an insert failure surfaces as a per-entry failure, the batch continues", async () => {
    const { deps } = fakeDeps([
      parsedMessage(),
      parsedMessage({ messageId: "<m2@example.com>" }),
    ])
    // Fail exactly one messages INSERT at the executor seam (module
    // namespaces are frozen — the executor is this test's own object).
    const original = executor.execute.bind(executor)
    let seenMessageInserts = 0
    executor.execute = async (sql, params) => {
      if (sql.includes("INSERT INTO messages") && ++seenMessageInserts === 1) {
        throw new Error("boom")
      }
      return original(sql, params)
    }
    const summary = await importFiles(
      executor,
      {
        accountId: ACCOUNT,
        destination: { kind: "folderName", name: "Backup" },
        filePaths: ["/picked/backup.mbox"],
      },
      deps
    )
    executor.execute = original
    expect(summary.imported).toBe(1)
    expect(summary.failed).toBe(1)
    expect(summary.files[0].failed[0].error).toBe("boom")
    // The second entry still landed.
    const count = await executor.select<{ n: number }>(
      "SELECT COUNT(*) AS n FROM messages WHERE account_id = $1",
      [ACCOUNT]
    )
    expect(count[0].n).toBe(1)
  })
})

describe("importFiles optional upload", () => {
  it("appends each imported raw message to the folder when enabled", async () => {
    const entries = fixtureMboxEntries()
    const { deps, uploads } = fakeDeps(entries)
    const summary = await importFiles(
      executor,
      {
        accountId: ACCOUNT,
        destination: { kind: "folderName", name: "Backup" },
        filePaths: ["/picked/backup.mbox"],
        uploadToServer: true,
      },
      deps
    )
    expect(uploads.map((upload) => upload.folder)).toEqual([
      "Backup",
      "Backup",
      "Backup",
    ])
    // The RAW source rides along (no reconstruction).
    for (const entry of entries) {
      expect(
        uploads.some((upload) => upload.raw === atob(entry.rawBase64))
      ).toBe(true)
    }
    expect(summary.uploaded).toBe(3)
    expect(summary.uploadFailures).toBe(0)
  })

  it("keeps the local import and reports per-entry upload failures offline", async () => {
    const { deps } = fakeDeps([parsedMessage()])
    const summary = await importFiles(
      executor,
      {
        accountId: ACCOUNT,
        destination: { kind: "folderName", name: "Backup" },
        filePaths: ["/picked/backup.mbox"],
        uploadToServer: true,
      },
      {
        ...deps,
        uploadMessage: async () => {
          throw new Error("network unreachable")
        },
      }
    )
    expect(summary.imported).toBe(1)
    expect(summary.uploaded).toBe(0)
    expect(summary.uploadFailures).toBe(1)
    expect(summary.files[0].uploadFailures[0].error).toBe("network unreachable")
    const count = await executor.select<{ n: number }>(
      "SELECT COUNT(*) AS n FROM messages WHERE account_id = $1",
      [ACCOUNT]
    )
    expect(count[0].n).toBe(1)
  })

  it("never invokes upload when the option is off", async () => {
    const { deps, uploads } = fakeDeps([parsedMessage()])
    await importFiles(
      executor,
      {
        accountId: ACCOUNT,
        destination: { kind: "folderName", name: "Backup" },
        filePaths: ["/picked/backup.mbox"],
      },
      deps
    )
    expect(uploads).toHaveLength(0)
  })
})

describe("importFiles progress and cancel", () => {
  it("reports (0, total) up front and one step per entry", async () => {
    const progress: Array<[number, number]> = []
    await importMbox(
      { kind: "folderName", name: "Backup" },
      fixtureMboxEntries(),
      { onProgress: (done, total) => progress.push([done, total]) }
    )
    expect(progress).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ])
  })

  it("stops between entries on the signal and reports cancelled", async () => {
    const controller = new AbortController()
    const { deps } = fakeDeps(fixtureMboxEntries())
    const summary = await importFiles(
      executor,
      {
        accountId: ACCOUNT,
        destination: { kind: "folderName", name: "Backup" },
        filePaths: ["/picked/backup.mbox"],
        uploadToServer: true,
        signal: controller.signal,
      },
      {
        ...deps,
        uploadMessage: () => {
          controller.abort()
          return Promise.reject(new Error("stop after the first"))
        },
      }
    )
    // First entry inserted+uploaded, then the abort; no throw escapes.
    expect(summary.status).toBe("cancelled")
    expect(summary.imported).toBe(1)
  })
})

describe("importFiles account guard", () => {
  it("rejects an unknown account", async () => {
    await expect(
      importMbox({ kind: "folderName", name: "Backup" }, [], {
        accountId: "ghost",
      })
    ).rejects.toThrow("does not exist")
  })
})

describe("pickImportFiles", () => {
  it("opens the dialog with an .eml/.mbox multi-select filter", async () => {
    vi.mocked(open).mockResolvedValue(["/picked/a.eml", "/picked/b.mbox"])
    const picked = await pickImportFiles()
    expect(picked).toEqual(["/picked/a.eml", "/picked/b.mbox"])
    expect(open).toHaveBeenCalledWith({
      multiple: true,
      title: "Choose email files to import",
      filters: [{ name: "Email files", extensions: ["eml", "mbox"] }],
    })
  })
})
