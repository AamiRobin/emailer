import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  type RenderResult,
} from "@testing-library/react"

import { clearAttachmentBytes, setAttachmentBytes } from "../attachment-bytes"
import { AttachmentStrip } from "../attachment-strip"
import { useComposerStore } from "@/stores/composer-store"
import type { ComposerAttachment } from "@/stores/composer-store"

/**
 * Inline attachment previews (task 2.8, design D14): image chips render a
 * thumbnail from an object URL over the registered bytes, PDF chips render
 * the <object> data-URL path with the icon layered underneath, and chips
 * without previewable bytes keep the plain paperclip. jsdom has no
 * URL.createObjectURL, so it is stubbed here; the revoke assertions pin
 * the no-leak cleanup on removal and unmount.
 */

const createObjectUrl = vi.fn(() => "blob:preview-mock")
const revokeObjectUrl = vi.fn()

function stubObjectUrls(): void {
  const mutableUrl = URL as unknown as Record<string, unknown>
  mutableUrl.createObjectURL = createObjectUrl
  mutableUrl.revokeObjectURL = revokeObjectUrl
}

function unstubObjectUrls(): void {
  const mutableUrl = URL as unknown as Record<string, unknown>
  delete mutableUrl.createObjectURL
  delete mutableUrl.revokeObjectURL
}

let nextId = 0

function attachmentOf(
  overrides: Partial<ComposerAttachment> = {}
): ComposerAttachment {
  nextId += 1
  return {
    id: `att-${nextId}`,
    name: "file.bin",
    size: 3,
    ...overrides,
  }
}

function renderStripWith(
  attachment: ComposerAttachment,
  bytes?: Uint8Array
): RenderResult {
  useComposerStore.setState({ attachments: [attachment] })
  if (bytes) setAttachmentBytes(attachment.id, bytes)
  return render(<AttachmentStrip />)
}

beforeEach(() => {
  stubObjectUrls()
})

afterEach(() => {
  cleanup()
  unstubObjectUrls()
  useComposerStore.setState({ attachments: [] })
  clearAttachmentBytes()
  vi.clearAllMocks()
})

describe("AttachmentStrip previews (task 2.8)", () => {
  it("image attachment renders a thumbnail from the registered bytes", async () => {
    const attachment = attachmentOf({
      name: "photo.png",
      mimeType: "image/png",
    })
    const bytes = new Uint8Array([1, 2, 3])
    renderStripWith(attachment, bytes)

    await waitFor(() => {
      expect(createObjectUrl).toHaveBeenCalledWith(
        expect.objectContaining({ type: "image/png" })
      )
    })
    const image = screen.getByRole("img", { name: "photo.png" })
    expect(image.getAttribute("src")).toBe("blob:preview-mock")
    // Thumbnail fills the fixed 48px preview box.
    expect(image.className).toContain("object-cover")
    expect(document.querySelector(".size-12")).not.toBeNull()
    // The paperclip gave its slot to the thumbnail.
    expect(document.querySelector("svg.lucide-paperclip")).toBeNull()
  })

  it("pdf attachment renders the object data-URL path with the icon underneath", () => {
    const attachment = attachmentOf({
      name: "report.pdf",
      mimeType: "application/pdf",
    })
    renderStripWith(attachment, new Uint8Array([1, 2, 3]))

    const pdfObject = document.querySelector("object")
    expect(pdfObject).not.toBeNull()
    expect(pdfObject?.getAttribute("type")).toBe("application/pdf")
    expect(pdfObject?.getAttribute("data")).toBe(
      `data:application/pdf;base64,${btoa(String.fromCharCode(1, 2, 3))}`
    )
    // The paperclip stays layered underneath for the cannot-render case.
    expect(document.querySelector("svg.lucide-paperclip")).not.toBeNull()
    expect(screen.queryByRole("img")).toBeNull()
  })

  it("non-previewable attachments and unregistered bytes keep the icon fallback", () => {
    renderStripWith(
      attachmentOf({ name: "notes.txt", mimeType: "text/plain" }),
      new Uint8Array([1])
    )
    expect(document.querySelector("svg.lucide-paperclip")).not.toBeNull()
    expect(screen.queryByRole("img")).toBeNull()
    expect(document.querySelector("object")).toBeNull()
    expect(createObjectUrl).not.toHaveBeenCalled()

    cleanup()
    // Metadata-only attachment (draft restored from persistence): the
    // image kind qualifies but the session has no bytes to preview from.
    renderStripWith(
      attachmentOf({ name: "restored.jpg", mimeType: "image/jpeg" })
    )
    expect(screen.queryByRole("img")).toBeNull()
    expect(createObjectUrl).not.toHaveBeenCalled()
  })

  it("removing an image attachment revokes its object URL", async () => {
    const attachment = attachmentOf({
      name: "photo.png",
      mimeType: "image/png",
    })
    renderStripWith(attachment, new Uint8Array([9, 9]))

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "photo.png" })).toBeTruthy()
    })
    expect(revokeObjectUrl).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole("button", { name: "Remove photo.png" }))
    expect(useComposerStore.getState().attachments).toEqual([])
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:preview-mock")
  })

  it("unmounting the strip revokes the object URL too", async () => {
    const attachment = attachmentOf({
      name: "photo.png",
      mimeType: "image/png",
    })
    const { unmount } = renderStripWith(attachment, new Uint8Array([9, 9]))

    await waitFor(() => {
      expect(screen.getByRole("img", { name: "photo.png" })).toBeTruthy()
    })
    unmount()
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:preview-mock")
  })
})
