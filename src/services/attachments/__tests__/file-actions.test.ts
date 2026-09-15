import { beforeEach, describe, expect, it, vi } from "vitest"

import { save } from "@tauri-apps/plugin-dialog"
import { openPath } from "@tauri-apps/plugin-opener"
import { writeFile as fsWriteFile } from "@tauri-apps/plugin-fs"
import { appDataDir, join } from "@tauri-apps/api/path"

import type { AttachmentRow } from "../../db/messages"
import type { EmailAccount } from "../../email/types"
import { openAttachment, saveAttachmentAs } from "../file-actions"
import type { AttachmentDeps } from "../cache"

vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: vi.fn(async () => null),
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

    const localPath = await openAttachment(
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

    expect(localPath).toBe("attachment_cache/h.bin")
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
