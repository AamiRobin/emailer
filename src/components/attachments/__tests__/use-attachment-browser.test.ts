import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"

import type { AccountAttachmentRow } from "@/services/db/attachment-search"
import {
  getAttachmentContent,
  saveAttachmentAs,
} from "@/services/attachments"
import { createTestExecutor, type TestExecutor } from "@/services/db/__tests__/test-executor"
import { createAccount } from "@/services/db/__tests__/fixtures"
import {
  fetchAttachmentPreviewBytes,
  saveAttachmentToDisk,
  setAttachmentBrowserExecutor,
} from "../use-attachment-browser"

/**
 * The browser's byte-moving flows (task 3.7, design D14), tested against
 * the REAL saveAttachmentToDisk / fetchAttachmentPreviewBytes: only the
 * underlying attachment services (getAttachmentContent — the existing
 * cache/download path; saveAttachmentAs — the OS save-dialog path) and
 * sonner are mocked. This pins the action-level contracts the component
 * tests stub out: the saved/cancelled/failed outcomes, the completion
 * toast (the spec's "the app confirms completion") and the account
 * resolution from the attachment row.
 */

vi.mock("@/services/attachments", () => ({
  getAttachmentContent: vi.fn(),
  saveAttachmentAs: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

const contentMock = vi.mocked(getAttachmentContent)
const saveAsMock = vi.mocked(saveAttachmentAs)
const toastMock = vi.mocked(toast)

let executor: TestExecutor
let accountId: string

function row(overrides: Partial<AccountAttachmentRow> = {}): AccountAttachmentRow {
  return {
    id: "att-1",
    message_id: "msg-1",
    account_id: accountId,
    filename: "report.pdf",
    mime_type: "application/pdf",
    size: 2048,
    content_id: null,
    is_inline: 0,
    provider_part_id: "0",
    local_path: null,
    cached_at: null,
    cache_size: null,
    thread_id: "thread-1",
    message_subject: "Quarterly report",
    from_name: "Boss",
    from_address: "boss@x.com",
    message_date: 100,
    gmail_message_id: "g-1",
    imap_folder: null,
    imap_uid: null,
    ...overrides,
  }
}

beforeEach(async () => {
  vi.clearAllMocks()
  executor = createTestExecutor()
  setAttachmentBrowserExecutor(executor)
  accountId = await createAccount(executor, "gmail")
})

afterEach(() => {
  setAttachmentBrowserExecutor(null)
  executor.close()
})

describe("saveAttachmentToDisk (task 3.7, D14)", () => {
  it("writes through the existing save path and confirms completion with a toast", async () => {
    contentMock.mockResolvedValue(new Uint8Array([1, 2, 3]))
    saveAsMock.mockResolvedValue("/tmp/report.pdf")

    const outcome = await saveAttachmentToDisk(row())

    expect(outcome).toBe("saved")
    // Content came from the existing cache/download service, carrying the
    // joined message location and the attachment row itself (deps default
    // to the empty production set).
    expect(contentMock).toHaveBeenCalledWith(
      executor,
      expect.objectContaining({ id: accountId, type: "gmail" }),
      expect.objectContaining({ id: "att-1" }),
      expect.objectContaining({ id: "att-1" }),
      {}
    )
    expect(saveAsMock).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "report.pdf" }),
      expect.any(Uint8Array),
      {}
    )
    // The spec's save-to-disk confirmation.
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringContaining("report.pdf")
    )
    expect(toastMock.success).toHaveBeenCalledWith(
      expect.stringContaining("/tmp/report.pdf")
    )
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it("treats a cancelled save dialog as silent, not an error", async () => {
    contentMock.mockResolvedValue(new Uint8Array([1]))
    saveAsMock.mockResolvedValue(null)

    const outcome = await saveAttachmentToDisk(row())

    expect(outcome).toBe("cancelled")
    expect(toastMock.success).not.toHaveBeenCalled()
    expect(toastMock.error).not.toHaveBeenCalled()
  })

  it("reports failures through the error toast", async () => {
    contentMock.mockRejectedValue(new Error("offline"))

    const outcome = await saveAttachmentToDisk(row())

    expect(outcome).toBe("failed")
    expect(toastMock.error).toHaveBeenCalledWith(
      expect.stringContaining("report.pdf")
    )
  })
})

describe("fetchAttachmentPreviewBytes (task 3.7, D14)", () => {
  it("resolves the entry's bytes through the existing content path", async () => {
    contentMock.mockResolvedValue(new Uint8Array([9, 9]))

    const bytes = await fetchAttachmentPreviewBytes(row())

    expect(bytes).toEqual(new Uint8Array([9, 9]))
    expect(contentMock).toHaveBeenCalledTimes(1)
  })

  it("rejects when the attachment's account row is gone", async () => {
    const orphan = row({ account_id: "acc-deleted" })

    await expect(fetchAttachmentPreviewBytes(orphan)).rejects.toThrow(
      /no longer exists/
    )
  })
})
