import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { save, ask } from "@tauri-apps/plugin-dialog"
import { openPath } from "@tauri-apps/plugin-opener"
import { writeFile as fsWriteFile } from "@tauri-apps/plugin-fs"
import { appDataDir, join } from "@tauri-apps/api/path"

import type { AttachmentRow } from "../../db/messages"
import type { EmailAccount } from "../../email/types"
import {
  openAttachment,
  openConfirmationMessage,
  saveAttachmentAs,
  type FileActionDeps,
} from "../file-actions"
import { putScanVerdict } from "../../db/attachment-scan-cache"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import type { AttachmentDeps } from "../cache"
import type { MalwareLookupDeps } from "../malware-lookup"

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(async () => null),
  ask: vi.fn(async () => false),
}))

vi.mock("@tauri-apps/plugin-opener", () => ({
  openPath: vi.fn(async () => undefined),
}))

// Used by cache.ts (untouched in these tests) and file-actions defaults.
vi.mock("@tauri-apps/plugin-fs", () => ({
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => new Uint8Array()),
  remove: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}))

vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: vi.fn(async () => "/mock/AppData"),
  join: vi.fn(async (...segments: string[]) => segments.join("/")),
}))

const saveMock = vi.mocked(save)
const askMock = vi.mocked(ask)
const openPathMock = vi.mocked(openPath)
const writeFileMock = vi.mocked(fsWriteFile)
const appDataDirMock = vi.mocked(appDataDir)
const joinMock = vi.mocked(join)

const attachment = {
  filename: "report.pdf",
} as AttachmentRow

const account: EmailAccount = {
  id: "acc",
  type: "imap",
  email: "user@example.com",
  status: "active",
  isActive: true,
  isPinned: false,
}

const cacheDeps: AttachmentDeps = {
  fs: {
    async ensureCacheDir() {},
    async writeFile() {},
    async readFile() {
      return new Uint8Array([9])
    },
    async removeFile() {},
  },
  fetchAttachment: async () => new Uint8Array([9]),
  hash: async (key) => `h(${key})`,
}

describe("saveAttachmentAs", () => {
  beforeEach(() => {
    saveMock.mockClear()
    writeFileMock.mockClear()
  })

  it("asks the system dialog for a target (suggesting the filename) and writes there", async () => {
    saveMock.mockResolvedValueOnce("/Users/me/Downloads/report.pdf")
    const writeFile = vi.fn(async () => undefined)

    const written = await saveAttachmentAs(attachment, new Uint8Array([1, 2]), {
      writeFile,
    })

    expect(written).toBe("/Users/me/Downloads/report.pdf")
    expect(saveMock).toHaveBeenCalledWith({ defaultPath: "report.pdf" })
    expect(writeFile).toHaveBeenCalledWith(
      "/Users/me/Downloads/report.pdf",
      new Uint8Array([1, 2])
    )
  })

  it("resolves null when the user cancels and never writes", async () => {
    const writeFile = vi.fn(async () => undefined)

    const written = await saveAttachmentAs(attachment, new Uint8Array(), {
      saveDialog: async () => null,
      writeFile,
    })

    expect(written).toBeNull()
    expect(writeFile).not.toHaveBeenCalled()
  })

  it("falls back to the plugin writeFile when none is injected", async () => {
    saveMock.mockResolvedValueOnce("/tmp/echo.txt")

    await saveAttachmentAs(
      { filename: "echo.txt" } as AttachmentRow,
      new Uint8Array([1]),
      {}
    )

    expect(writeFileMock).toHaveBeenCalledWith(
      "/tmp/echo.txt",
      new Uint8Array([1])
    )
  })
})

describe("openAttachment", () => {
  beforeEach(() => {
    openPathMock.mockClear()
    appDataDirMock.mockClear()
    joinMock.mockClear()
  })

  it("ensures the content is cached, then opens the resolved file with the default app", async () => {
    // Executor reads fail with a plain object; the cache layer falls back
    // to the injected row, so hand it a row with a cached path.
    const executor = {
      select: vi.fn(async () => []),
      execute: vi.fn(async () => ({ rowsAffected: 0 })),
    }
    const row = {
      id: "att-1",
      message_id: "msg-1",
      account_id: "acc",
      filename: "report.pdf",
      provider_part_id: "2",
      local_path: "attachment_cache/h.bin",
      cached_at: 1,
      cache_size: 1,
    } as AttachmentRow

    const result = await openAttachment(
      executor,
      account,
      { imap_folder: "INBOX", imap_uid: 5, gmail_message_id: null },
      row,
      {
        ...cacheDeps,
        resolveAppPath: async (relPath) => `/appdata/${relPath}`,
        openPath: vi.fn(async () => undefined),
      }
    )

    expect(result?.localPath).toBe("attachment_cache/h.bin")
    expect(result?.opened).toBe(true)
  })

  it("uses the plugin openPath and AppData join by default", async () => {
    const executor = {
      select: vi.fn(async () => []),
      execute: vi.fn(async () => ({ rowsAffected: 0 })),
    }
    const row = {
      id: "att-1",
      message_id: "msg-1",
      account_id: "acc",
      filename: "report.pdf",
      provider_part_id: "2",
      local_path: "attachment_cache/h.bin",
      cached_at: 1,
      cache_size: 1,
    } as AttachmentRow

    await openAttachment(
      executor,
      account,
      { imap_folder: "INBOX", imap_uid: 5, gmail_message_id: null },
      row,
      cacheDeps
    )

    expect(joinMock).toHaveBeenCalledWith(
      "/mock/AppData",
      "attachment_cache/h.bin"
    )
    expect(openPathMock).toHaveBeenCalledWith(
      "/mock/AppData/attachment_cache/h.bin"
    )
  })
})

// ---------------------------------------------------------------------------
// Open-path security gates (tasks 18.8/18.9, designs D17/D18)
// ---------------------------------------------------------------------------

const SOURCE = { imap_folder: "INBOX", imap_uid: 5, gmail_message_id: null }

/** Plain fake executor: reads miss, writes no-op (scan disabled in the
 * D17 tests, so the verdict cache is never touched). */
const executor = {
  select: vi.fn(async () => []),
  execute: vi.fn(async () => ({ rowsAffected: 0 })),
}

/** A cached row factory — unique ids keep the D17 first-open memory from
 * leaking between tests (the module-level Set is intentionally global). */
function row(
  id: string,
  filename: string,
  localPath = "attachment_cache/h.bin"
): AttachmentRow {
  return {
    id,
    message_id: "msg-1",
    account_id: "acc",
    filename,
    provider_part_id: "2",
    local_path: localPath,
    cached_at: 1,
    cache_size: 1,
  } as AttachmentRow
}

describe("static dangerous-attachment gate (task 18.8)", () => {
  beforeEach(() => {
    askMock.mockClear()
  })

  it("confirms before the first open of a .exe, naming the block-tier risk", async () => {
    const confirm = vi.fn(async () => true)
    const openPath = vi.fn(async () => undefined)

    const result = await openAttachment(
      executor,
      account,
      SOURCE,
      row("att-exe-1", "invoice.exe"),
      {
        ...cacheDeps,
        confirm,
        openPath,
        malwareScan: { settings: async () => ({ enabled: false, apiKey: "" }) },
      }
    )

    expect(confirm).toHaveBeenCalledWith({
      kind: "block",
      filename: "invoice.exe",
    })
    expect(openPath).toHaveBeenCalledTimes(1)
    expect(result?.opened).toBe(true)
  })

  it("aborts without opening or caching when the confirmation is declined", async () => {
    const fetchAttachment = vi.fn(async () => new Uint8Array([1]))
    const openPath = vi.fn(async () => undefined)

    const result = await openAttachment(
      executor,
      account,
      SOURCE,
      row("att-exe-2", "evil.scr"),
      {
        ...cacheDeps,
        fetchAttachment,
        confirm: async () => false,
        openPath,
        malwareScan: { settings: async () => ({ enabled: false, apiKey: "" }) },
      }
    )

    expect(result).toBeNull()
    expect(fetchAttachment).not.toHaveBeenCalled()
    expect(openPath).not.toHaveBeenCalled()
  })

  it("asks only on the FIRST open — a confirmed attachment opens freely after", async () => {
    const confirm = vi.fn(async () => true)
    const openPath = vi.fn(async () => undefined)
    const deps: FileActionDeps = {
      ...cacheDeps,
      confirm,
      openPath,
      malwareScan: { settings: async () => ({ enabled: false, apiKey: "" }) },
    }

    await openAttachment(
      executor,
      account,
      SOURCE,
      row("att-docm-1", "Q3-report.docm"),
      deps
    )
    await openAttachment(
      executor,
      account,
      SOURCE,
      row("att-docm-1", "Q3-report.docm"),
      deps
    )

    expect(confirm).toHaveBeenCalledTimes(1)
    expect(confirm).toHaveBeenCalledWith({
      kind: "caution",
      filename: "Q3-report.docm",
    })
    expect(openPath).toHaveBeenCalledTimes(2)
  })

  it("never prompts for safe documents — a PDF opens straight through", async () => {
    const confirm = vi.fn(async () => true)
    const openPath = vi.fn(async () => undefined)

    await openAttachment(
      executor,
      account,
      SOURCE,
      row("att-pdf-1", "scan.pdf"),
      {
        ...cacheDeps,
        confirm,
        openPath,
        malwareScan: { settings: async () => ({ enabled: false, apiKey: "" }) },
      }
    )

    expect(confirm).not.toHaveBeenCalled()
    expect(openPath).toHaveBeenCalledTimes(1)
  })

  it("the default confirm is the plugin-dialog native ask", async () => {
    askMock.mockResolvedValueOnce(true)

    await openAttachment(
      executor,
      account,
      SOURCE,
      row("att-exe-3", "run.bat"),
      {
        ...cacheDeps,
        openPath: vi.fn(async () => undefined),
        malwareScan: { settings: async () => ({ enabled: false, apiKey: "" }) },
      }
    )

    expect(askMock).toHaveBeenCalledWith(
      openConfirmationMessage({ kind: "block", filename: "run.bat" }),
      expect.objectContaining({ kind: "warning", okLabel: "Open anyway" })
    )
    expect(askMock.mock.calls[0]?.[0]).toContain("run.bat")
  })
})

describe("malware hash-lookup gate (task 18.9)", () => {
  let db: TestExecutor

  beforeEach(() => {
    db = createTestExecutor()
    askMock.mockClear()
  })

  afterEach(() => {
    db.close()
  })

  /** Lookup enabled deps over the REAL verdict cache (node:sqlite). */
  function scanDeps(lookup: MalwareLookupDeps["lookup"]): FileActionDeps {
    return {
      ...cacheDeps,
      malwareScan: {
        settings: async () => ({ enabled: true, apiKey: "vt-key" }),
        lookup,
      },
    }
  }

  it("blocks a malicious verdict with the report; override opens, decline does not", async () => {
    const lookup = vi.fn(async () => ({
      verdict: "malicious" as const,
      maliciousCount: 12,
      totalEngines: 70,
    }))
    const openPath = vi.fn(async () => undefined)

    // Decline: no OS open, verdict still reported for the UI chip.
    const declined = await openAttachment(
      db,
      account,
      SOURCE,
      row("att-scan-1", "invoice.pdf"),
      { ...scanDeps(lookup), openPath, confirm: async () => false }
    )
    expect(declined).toMatchObject({ opened: false })
    expect(declined?.scan).toMatchObject({
      verdict: "malicious",
      maliciousCount: 12,
      totalEngines: 70,
    })
    expect(openPath).not.toHaveBeenCalled()

    // Override: the explicit second confirmation opens the file.
    const opened = await openAttachment(
      db,
      account,
      SOURCE,
      row("att-scan-1", "invoice.pdf"),
      { ...scanDeps(lookup), openPath, confirm: async () => true }
    )
    expect(opened?.opened).toBe(true)
    expect(openPath).toHaveBeenCalledTimes(1)
  })

  it("warns on suspicious and proceeds on confirm", async () => {
    const confirm = vi.fn(async () => true)
    const lookup = vi.fn(async () => ({
      verdict: "suspicious" as const,
      maliciousCount: 2,
      totalEngines: 64,
    }))

    const result = await openAttachment(
      db,
      account,
      SOURCE,
      row("att-scan-2", "resume.pdf"),
      { ...scanDeps(lookup), confirm, openPath: vi.fn(async () => undefined) }
    )

    expect(confirm).toHaveBeenCalledWith({
      kind: "suspicious",
      filename: "resume.pdf",
      maliciousCount: 2,
      totalEngines: 64,
    })
    expect(result?.opened).toBe(true)
  })

  it("opens clean verdicts with no extra dialog", async () => {
    const confirm = vi.fn(async () => true)
    const lookup = vi.fn(async () => ({
      verdict: "clean" as const,
      maliciousCount: 0,
      totalEngines: 70,
    }))

    await openAttachment(db, account, SOURCE, row("att-scan-3", "doc.pdf"), {
      ...scanDeps(lookup),
      confirm,
      openPath: vi.fn(async () => undefined),
    })

    expect(confirm).not.toHaveBeenCalled()
  })

  it("fails open when the lookup throws — the static gate alone remains", async () => {
    const confirm = vi.fn(async () => true)
    const lookup = vi.fn(async () => {
      throw new Error("offline")
    })

    const result = await openAttachment(
      db,
      account,
      SOURCE,
      row("att-scan-4", "doc.pdf"),
      { ...scanDeps(lookup), confirm, openPath: vi.fn(async () => undefined) }
    )

    expect(result?.opened).toBe(true)
    expect(result?.scan).toMatchObject({ verdict: "unknown", error: "offline" })
    expect(confirm).not.toHaveBeenCalled()
  })

  it("serves the verdict from the attachment_scan_cache without re-looking-up", async () => {
    const lookup = vi.fn<NonNullable<MalwareLookupDeps["lookup"]>>()
    // The scan hashes the cached BYTES with WebCrypto, so seed the cache
    // with the digest of exactly those bytes ([9], from the fs fake).
    const { sha256OfBytes } = await import("../malware-lookup")
    await putScanVerdict(db, await sha256OfBytes(new Uint8Array([9])), {
      verdict: "malicious",
      maliciousCount: 40,
      totalEngines: 70,
    })

    const result = await openAttachment(
      db,
      account,
      SOURCE,
      row("att-scan-5", "cached.pdf"),
      {
        ...scanDeps(lookup),
        confirm: async () => false,
        openPath: vi.fn(async () => undefined),
      }
    )

    expect(lookup).not.toHaveBeenCalled()
    expect(result?.scan).toMatchObject({ verdict: "malicious" })
    expect(result?.opened).toBe(false)
  })
})
