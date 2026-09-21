import { describe, expect, it } from "vitest"

import type { AccountAttachmentRow } from "@/services/db/attachment-search"
import {
  ATTACHMENT_TYPE_CATEGORIES,
  attachmentCategoryLabel,
  attachmentTypeCategory,
  filterAccountAttachments,
  matchesAttachmentSearch,
} from "../attachment-categories"

/**
 * The browser's in-process filter/search primitives (task 3.7, design
 * D14): pure mime/extension → category mapping, filename-substring
 * search and the combined narrowing, unit-tested with no DOM and no
 * database.
 */

function row(overrides: Partial<AccountAttachmentRow> = {}): AccountAttachmentRow {
  return {
    id: "att-1",
    message_id: "msg-1",
    account_id: "acc-1",
    filename: "file.bin",
    mime_type: null,
    size: 10,
    content_id: null,
    is_inline: 0,
    provider_part_id: null,
    local_path: null,
    cached_at: null,
    cache_size: null,
    thread_id: "thread-1",
    message_subject: "Subject",
    from_name: "Boss",
    from_address: "boss@x.com",
    message_date: 100,
    gmail_message_id: null,
    imap_folder: null,
    imap_uid: null,
    ...overrides,
  }
}

describe("attachmentTypeCategory (task 3.7, D14)", () => {
  it("maps the mime type first: images, pdfs, documents, spreadsheets, archives", () => {
    // images
    expect(attachmentTypeCategory(row({ mime_type: "image/png" }))).toBe(
      "images"
    )
    expect(attachmentTypeCategory(row({ mime_type: "IMAGE/JPEG" }))).toBe(
      "images"
    )
    // pdfs
    expect(attachmentTypeCategory(row({ mime_type: "application/pdf" }))).toBe(
      "pdfs"
    )
    // documents (word / text / rtf) — note text/csv must NOT land here
    expect(
      attachmentTypeCategory(row({ mime_type: "application/msword" }))
    ).toBe("documents")
    expect(
      attachmentTypeCategory(
        row({
          mime_type:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        })
      )
    ).toBe("documents")
    expect(attachmentTypeCategory(row({ mime_type: "text/plain" }))).toBe(
      "documents"
    )
    expect(attachmentTypeCategory(row({ mime_type: "application/rtf" }))).toBe(
      "documents"
    )
    // spreadsheets (excel / csv) — checked before the text/* documents
    expect(attachmentTypeCategory(row({ mime_type: "text/csv" }))).toBe(
      "spreadsheets"
    )
    expect(
      attachmentTypeCategory(row({ mime_type: "application/vnd.ms-excel" }))
    ).toBe("spreadsheets")
    expect(
      attachmentTypeCategory(
        row({
          mime_type:
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        })
      )
    ).toBe("spreadsheets")
    // archives (zip / rar / 7z / tar / gz)
    expect(attachmentTypeCategory(row({ mime_type: "application/zip" }))).toBe(
      "archives"
    )
    expect(
      attachmentTypeCategory(row({ mime_type: "application/x-7z-compressed" }))
    ).toBe("archives")
    expect(
      attachmentTypeCategory(row({ mime_type: "application/gzip" }))
    ).toBe("archives")
    expect(
      attachmentTypeCategory(row({ mime_type: "application/x-rar-compressed" }))
    ).toBe("archives")
  })

  it("falls back to the filename extension when the mime type is missing or generic", () => {
    expect(attachmentTypeCategory(row({ filename: "photo.PNG" }))).toBe("images")
    expect(attachmentTypeCategory(row({ filename: "doc.PDF" }))).toBe("pdfs")
    expect(attachmentTypeCategory(row({ filename: "notes.txt" }))).toBe(
      "documents"
    )
    expect(attachmentTypeCategory(row({ filename: "sheet.csv" }))).toBe(
      "spreadsheets"
    )
    expect(attachmentTypeCategory(row({ filename: "backup.tar.gz" }))).toBe(
      "archives"
    )
    // Generic mime + extension resolves through the fallback…
    expect(
      attachmentTypeCategory(
        row({ filename: "manual.pdf", mime_type: "application/octet-stream" })
      )
    ).toBe("pdfs")
    // …and nothing recognizable is "other".
    expect(
      attachmentTypeCategory(row({ filename: "data.xyz" }))
    ).toBe("other")
    expect(
      attachmentTypeCategory(row({ filename: null, mime_type: null }))
    ).toBe("other")
  })

  it("exposes the chip set in order with labels", () => {
    expect(ATTACHMENT_TYPE_CATEGORIES).toEqual([
      "images",
      "pdfs",
      "documents",
      "spreadsheets",
      "archives",
      "other",
    ])
    expect(attachmentCategoryLabel("all")).toBe("All")
    expect(attachmentCategoryLabel("pdfs")).toBe("PDFs")
  })
})

describe("matchesAttachmentSearch (task 3.7, D14)", () => {
  it("matches case-insensitive filename substrings; an empty query matches everything", () => {
    const attachment = row({ filename: "Q4-Contract.pdf" })
    expect(matchesAttachmentSearch(attachment, "contract")).toBe(true)
    expect(matchesAttachmentSearch(attachment, "Q4")).toBe(true)
    expect(matchesAttachmentSearch(attachment, "  contract  ")).toBe(true)
    expect(matchesAttachmentSearch(attachment, "invoice")).toBe(false)
    expect(matchesAttachmentSearch(row({ filename: null }), "")).toBe(true)
    expect(matchesAttachmentSearch(row({ filename: null }), "pdf")).toBe(false)
  })
})

describe("filterAccountAttachments (task 3.7, D14)", () => {
  const rows = [
    row({ id: "a", filename: "report.pdf", mime_type: "application/pdf", message_date: 300 }),
    row({ id: "b", filename: "chart.png", mime_type: "image/png", message_date: 200 }),
    row({ id: "c", filename: "photo.png", mime_type: "image/png", message_date: 100 }),
    row({ id: "d", filename: "backup.zip", mime_type: "application/zip", message_date: 400 }),
  ]

  it("narrows by category", () => {
    const images = filterAccountAttachments(rows, { query: "", category: "images" })
    expect(images.map((entry) => entry.id)).toEqual(["b", "c"])
  })

  it("combines the category predicate AND the text match", () => {
    const narrowed = filterAccountAttachments(rows, {
      query: "photo",
      category: "images",
    })
    expect(narrowed.map((entry) => entry.id)).toEqual(["c"])
    // A match outside the selected category is kept out.
    expect(
      filterAccountAttachments(rows, { query: "report", category: "images" })
    ).toEqual([])
  })

  it("sorts newest message first (the default order), stably", () => {
    const all = filterAccountAttachments(rows, { query: "", category: "all" })
    expect(all.map((entry) => entry.id)).toEqual(["d", "a", "b", "c"])
    // Input order for ties (stable sort) — the db query already delivers
    // this order; the helper preserves it.
    const tied = [
      row({ id: "late", message_date: 500 }),
      row({ id: "early", message_date: 1 }),
      row({ id: "late2", message_date: 500 }),
    ]
    expect(
      filterAccountAttachments(tied, { query: "", category: "all" }).map(
        (entry) => entry.id
      )
    ).toEqual(["late", "late2", "early"])
  })
})
