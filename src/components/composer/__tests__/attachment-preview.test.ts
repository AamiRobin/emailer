import { describe, expect, it } from "vitest"

import {
  attachmentPdfDataUrl,
  attachmentPreviewKind,
} from "../attachment-preview"

/**
 * Preview classification (task 2.8, design D14): MIME type wins, the
 * file-name extension is the fallback, everything else is the icon case.
 */
describe("attachmentPreviewKind", () => {
  it("classifies image and PDF MIME types first", () => {
    expect(
      attachmentPreviewKind({ name: "photo.bin", mimeType: "image/png" })
    ).toBe("image")
    expect(
      attachmentPreviewKind({ name: "doc.bin", mimeType: "application/pdf" })
    ).toBe("pdf")
  })

  it("is case-insensitive on the MIME type", () => {
    expect(attachmentPreviewKind({ name: "x", mimeType: "IMAGE/PNG" })).toBe(
      "image"
    )
    expect(
      attachmentPreviewKind({ name: "x", mimeType: "Application/PDF" })
    ).toBe("pdf")
  })

  it("falls back to the extension when the MIME type is not previewable", () => {
    expect(
      attachmentPreviewKind({
        name: "photo.png",
        mimeType: "application/octet-stream",
      })
    ).toBe("image")
    expect(attachmentPreviewKind({ name: "report.pdf" })).toBe("pdf")
    expect(attachmentPreviewKind({ name: "report.PDF" })).toBe("pdf")
  })

  it("returns other for everything else", () => {
    expect(
      attachmentPreviewKind({ name: "notes.txt", mimeType: "text/plain" })
    ).toBe("other")
    expect(
      attachmentPreviewKind({
        name: "archive.zip",
        mimeType: "application/zip",
      })
    ).toBe("other")
    expect(attachmentPreviewKind({ name: "no-extension" })).toBe("other")
  })
})

describe("attachmentPdfDataUrl", () => {
  it("encodes the bytes as a base64 PDF data URL", () => {
    expect(attachmentPdfDataUrl(new Uint8Array([1, 2, 3]))).toBe(
      `data:application/pdf;base64,${btoa(String.fromCharCode(1, 2, 3))}`
    )
  })

  it("handles byte counts beyond one String.fromCharCode call", () => {
    const bytes = new Uint8Array(0x8000 + 5).fill(7)
    const url = attachmentPdfDataUrl(bytes)
    const encoded = url.slice("data:application/pdf;base64,".length)
    expect(atob(encoded)).toBe(String.fromCharCode(...bytes))
  })
})
