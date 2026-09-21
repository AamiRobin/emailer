import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

import { setDefaultKeyStore } from "../../crypto/key-management"
import { createInMemoryKeyStore } from "../../crypto/__tests__/in-memory-key-store"
import {
  decryptCredentials,
  encryptCredentials,
} from "../../crypto/credentials"
import {
  clearMicrosoftTokenCache,
} from "../../email/microsoft-token-manager"
import {
  getAttachmentContent,
  defaultFetchAttachment,
  base64ToBytes,
  type AttachmentDeps,
  type CacheFs,
} from "../cache"
import type { AttachmentRow } from "../../db/messages"
import type { EmailAccount } from "../../email/types"
import { ProviderAuthError } from "../../email/types"
import { createFetchMock } from "../../email/__tests__/gmail-fixtures"
import {
  b64,
  microsoftAccount,
  mockEntraTokenSuccess,
} from "../../email/__tests__/microsoft-fixtures"
import { updateCredentials } from "../../db/accounts"

vi.mock("../../db/accounts", () => ({
  updateCredentials: vi.fn(async () => {}),
}))

vi.mock("../../db/executor", () => ({
  getExecutor: () => ({ select: async () => [], execute: async () => ({ rowsAffected: 0 }) }),
}))

/**
 * Microsoft attachment bytes (parity-round-2 task 3.4): the Graph
 * contentBytes download rides the SAME cache flow as gmail/imap — the
 * production default fetch dispatches on the account type, decodes the
 * base64 contentBytes, and the D15 cache writes the bytes to disk.
 */

function microsoftRow(): { account: EmailAccount; message: { gmail_message_id: string; imap_folder: string | null; imap_uid: number | null } } {
  return {
    account: microsoftAccount(),
    message: {
      gmail_message_id: "AAMkatt==",
      imap_folder: "Inbox",
      imap_uid: null,
    },
  }
}

function attachmentRow(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: "att-1",
    message_id: "msg-1",
    account_id: "acc-m",
    filename: "report.pdf",
    mime_type: "application/pdf",
    size: 4,
    content_id: null,
    is_inline: 0,
    provider_part_id: "att-x1",
    local_path: null,
    cached_at: null,
    cache_size: null,
    ...overrides,
  }
}

function memFs(): CacheFs {
  const files = new Map<string, Uint8Array>()
  return {
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

describe("microsoft attachment fetch (task 3.4)", () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    setDefaultKeyStore(createInMemoryKeyStore())
  })

  afterAll(() => {
    setDefaultKeyStore(null)
    globalThis.fetch = originalFetch
  })

  it("decodes contentBytes through the default dispatch and caches them", async () => {
    const mock = createFetchMock()
    mockEntraTokenSuccess(mock)
    mock.on(
      "GET",
      "/me/messages/AAMkatt%3D%3D/attachments/att-x1",
      () => ({
        json: {
          id: "att-x1",
          name: "report.pdf",
          contentType: "application/pdf",
          contentBytes: b64("%PDF"),
        },
      })
    )
    globalThis.fetch = mock.fetch

    const { account, message } = microsoftRow()
    const credentialsJson = await encryptCredentials({
      refreshToken: "ms-rt-1",
    })
    const sealed: EmailAccount = { ...account, credentialsJson }

    // The cache re-reads the row (and stamps the LRU) through the
    // executor; an empty stub falls back to the passed metadata.
    const executor = {
      select: async () => [],
      execute: async () => ({ rowsAffected: 0 }),
    }
    const deps: AttachmentDeps = { fs: memFs(), now: () => 10 }
    const bytes = await getAttachmentContent(
      executor,
      sealed,
      message,
      attachmentRow(),
      deps
    )
    // The bytes decoded from Graph's base64 contentBytes.
    expect(new TextDecoder().decode(bytes)).toBe("%PDF")
    // The bearer token rode the attachment call; the token never leaks.
    const call = mock.calls.find((entry) =>
      entry.url.includes("/attachments/")
    )
    expect(call?.headers.authorization).toBe("Bearer ms-at-1")
  })

  it("rejects rows without the provider ids before any network call", async () => {
    globalThis.fetch = vi.fn()
    const { account, message } = microsoftRow()
    await expect(
      defaultFetchAttachment(
        account,
        { ...message, gmail_message_id: null },
        attachmentRow()
      )
    ).rejects.toThrow("missing the server message id")
    await expect(
      defaultFetchAttachment(
        account,
        message,
        attachmentRow({ provider_part_id: null })
      )
    ).rejects.toThrow("no provider part id")
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it("surfaces a missing sealed envelope as ProviderAuthError", async () => {
    globalThis.fetch = vi.fn()
    const { account, message } = microsoftRow()
    const error = await defaultFetchAttachment(
      { ...account, credentialsJson: undefined },
      message,
      attachmentRow()
    ).then(
      () => null,
      (thrown: unknown) => thrown
    )
    expect(error).toBeInstanceOf(ProviderAuthError)
  })

  it("falls back to the raw $value endpoint when contentBytes is absent (>3 MB)", async () => {
    const mock = createFetchMock()
    mockEntraTokenSuccess(mock)
    // A large file attachment: no contentBytes on the single-GET shape.
    mock.on("GET", "/me/messages/AAMkatt%3D%3D/attachments/att-x1", () => ({
      json: {
        id: "att-x1",
        name: "big.pdf",
        contentType: "application/pdf",
        size: 5 * 1024 * 1024,
      },
    }))
    mock.on(
      "GET",
      "/me/messages/AAMkatt%3D%3D/attachments/att-x1/$value",
      () => ({ text: "%PDF-large-raw" })
    )
    globalThis.fetch = mock.fetch

    const { account, message } = microsoftRow()
    const credentialsJson = await encryptCredentials({
      refreshToken: "ms-rt-1",
    })
    const sealed: EmailAccount = { ...account, credentialsJson }
    const executor = {
      select: async () => [],
      execute: async () => ({ rowsAffected: 0 }),
    }
    const bytes = await getAttachmentContent(
      executor,
      sealed,
      message,
      attachmentRow({ size: 5 * 1024 * 1024 }),
      { fs: memFs(), now: () => 10 }
    )
    expect(new TextDecoder().decode(bytes)).toBe("%PDF-large-raw")
    const valueCall = mock.calls.find((entry) =>
      entry.url.includes("/$value")
    )
    expect(valueCall?.headers.authorization).toBe("Bearer ms-at-1")
  })

  it("ignores inline contentBytes when the declared size exceeds the 3 MB guard", async () => {
    const mock = createFetchMock()
    mockEntraTokenSuccess(mock)
    mock.on("GET", "/me/messages/AAMkatt%3D%3D/attachments/att-x1", () => ({
      json: {
        id: "att-x1",
        contentBytes: b64("truncated-stub"),
        size: 4 * 1024 * 1024,
      },
    }))
    mock.on(
      "GET",
      "/me/messages/AAMkatt%3D%3D/attachments/att-x1/$value",
      () => ({ text: "%PDF-full" })
    )
    globalThis.fetch = mock.fetch

    const { account, message } = microsoftRow()
    const credentialsJson = await encryptCredentials({
      refreshToken: "ms-rt-1",
    })
    const sealed: EmailAccount = { ...account, credentialsJson }
    const executor = {
      select: async () => [],
      execute: async () => ({ rowsAffected: 0 }),
    }
    const bytes = await getAttachmentContent(
      executor,
      sealed,
      message,
      attachmentRow({ size: 4 * 1024 * 1024 }),
      { fs: memFs(), now: () => 10 }
    )
    expect(new TextDecoder().decode(bytes)).toBe("%PDF-full")
  })

  it("re-seals a rotated refresh token during the attachment fetch", async () => {
    clearMicrosoftTokenCache("acc-m") // earlier tests cached a token for this id
    const mock = createFetchMock()
    // Entra rotated the refresh token on this refresh grant.
    mockEntraTokenSuccess(mock, "at-att", { refreshToken: "rt-rotated-2" })
    mock.on("GET", "/me/messages/AAMkatt%3D%3D/attachments/att-x1", () => ({
      json: { id: "att-x1", contentBytes: b64("DATA") },
    }))
    globalThis.fetch = mock.fetch

    const { account, message } = microsoftRow()
    const credentialsJson = await encryptCredentials({
      refreshToken: "ms-rt-1",
    })
    const sealed: EmailAccount = { ...account, credentialsJson }
    const executor = {
      select: async () => [],
      execute: async () => ({ rowsAffected: 0 }),
    }
    const bytes = await getAttachmentContent(
      executor,
      sealed,
      message,
      attachmentRow(),
      { fs: memFs(), now: () => 10 }
    )
    expect(new TextDecoder().decode(bytes)).toBe("DATA")

    // The rotation was re-sealed through updateCredentials — same hook the
    // mail provider wires — as ciphertext, never plaintext.
    const updateMock = vi.mocked(updateCredentials)
    expect(updateMock).toHaveBeenCalledTimes(1)
    const sealedJson = updateMock.mock.calls[0]?.[2] as string
    expect(sealedJson).not.toContain("rt-rotated-2")
    const envelope = await decryptCredentials<{ refreshToken: string }>(
      sealedJson
    )
    expect(envelope?.refreshToken).toBe("rt-rotated-2")
  })

  it("base64ToBytes decodes the Graph contentBytes payload", () => {
    expect(new TextDecoder().decode(base64ToBytes(b64("PDF")))).toBe("PDF")
  })
})
