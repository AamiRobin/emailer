import { describe, expect, it, vi } from "vitest"

// getAttachmentContent is the D15 seam — stub it at the module seam
// (the attachments service has its own suite). Hoisted to the module
// top level, where vitest requires mock declarations.
const getAttachmentContentMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/attachments", () => ({
  getAttachmentContent: getAttachmentContentMock,
}))

/**
 * Calendar-attachment detection tests (task 5.5): the .ics /
 * text-calendar predicate over attachment rows, the message-level
 * filter, and the content extraction through the D15 attachment seam
 * (getAttachmentContent is mocked — its own suite covers the cache).
 */

import type { AttachmentRow } from "@/services/db/messages"
import type { SqlExecutor } from "@/services/db/executor"
import type { EmailAccount } from "@/services/email/types"

import {
  findCalendarAttachments,
  icsTextFromBytes,
  isCalendarAttachment,
  readFirstCalendarIcs,
  readIcsAttachmentText,
} from "../ics-detect"

function row(overrides: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: "row-1",
    message_id: "msg-1",
    account_id: "acc-1",
    filename: null,
    mime_type: null,
    size: 1024,
    content_id: null,
    is_inline: 0,
    provider_part_id: null,
    local_path: null,
    cached_at: null,
    cache_size: null,
    ...overrides,
  }
}

describe("isCalendarAttachment", () => {
  it("matches by mime type", () => {
    expect(isCalendarAttachment({ filename: null, mime_type: "text/calendar" })).toBe(
      true
    )
    expect(
      isCalendarAttachment({ filename: null, mime_type: "application/ics" })
    ).toBe(true)
    expect(
      isCalendarAttachment({ filename: "x", mime_type: "TEXT/CALENDAR; charset=utf-8" })
    ).toBe(true)
  })

  it("matches by .ics filename extension, case-insensitively", () => {
    expect(
      isCalendarAttachment({ filename: "invite.ics", mime_type: null })
    ).toBe(true)
    expect(
      isCalendarAttachment({ filename: "INVITE.ICs", mime_type: "text/plain" })
    ).toBe(true)
    expect(
      isCalendarAttachment({ filename: "invite.p7s", mime_type: null })
    ).toBe(false)
  })

  it("rejects ordinary attachments", () => {
    expect(
      isCalendarAttachment({ filename: "photo.png", mime_type: "image/png" })
    ).toBe(false)
    expect(isCalendarAttachment({ filename: null, mime_type: null })).toBe(false)
    expect(isCalendarAttachment({ filename: "calendar", mime_type: null })).toBe(
      false
    )
  })
})

describe("findCalendarAttachments", () => {
  it("filters in order, keeping only calendar rows", () => {
    const rows = [
      row({ id: "a", filename: "notes.pdf", mime_type: "application/pdf" }),
      row({ id: "b", filename: "invite.ics" }),
      row({ id: "c", mime_type: "text/calendar" }),
      row({ id: "d", filename: "photo.png", mime_type: "image/png" }),
    ]
    expect(findCalendarAttachments(rows).map((entry) => entry.id)).toEqual([
      "b",
      "c",
    ])
    expect(findCalendarAttachments([])).toEqual([])
  })
})

describe("icsTextFromBytes", () => {
  it("decodes UTF-8 bytes", () => {
    const text = "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"
    expect(icsTextFromBytes(new TextEncoder().encode(text))).toBe(text)
  })
})

describe("readIcsAttachmentText / readFirstCalendarIcs", () => {
  const ICS = "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n"

  const account = {
    id: "acc-1",
    type: "gmail",
    email: "me@example.com",
  } as unknown as EmailAccount
  const message = {
    id: "msg-1",
    gmail_message_id: "g-1",
    imap_folder: null,
    imap_uid: null,
  }
  const executor = { marker: "executor" } as unknown as SqlExecutor

  it("decodes the fetched bytes of the exact row", async () => {
    getAttachmentContentMock.mockResolvedValue(new TextEncoder().encode(ICS))
    const text = await readIcsAttachmentText(
      executor,
      account,
      message,
      row({ id: "row-9", mime_type: "text/calendar" })
    )
    expect(text).toBe(ICS)
    expect(getAttachmentContentMock).toHaveBeenCalledWith(
      executor,
      account,
      message,
      expect.objectContaining({ id: "row-9" }),
      {}
    )
  })

  it("returns the first calendar row's text at the message level", async () => {
    const rows = [
      row({ id: "row-a", filename: "notes.pdf", mime_type: "application/pdf" }),
      row({ id: "row-b", filename: "invite.ics" }),
    ]
    const executorWithRows = {
      select: vi.fn().mockResolvedValue(rows),
      execute: vi.fn().mockResolvedValue(undefined),
    } as unknown as SqlExecutor
    getAttachmentContentMock.mockResolvedValue(new TextEncoder().encode(ICS))

    const text = await readFirstCalendarIcs(
      executorWithRows,
      account,
      message as never,
      { marker: "deps" } as never
    )
    expect(text).toBe(ICS)
    // The content fetch targets the CALENDAR row, and the injected deps
    // flow through to the D15 seam.
    expect(getAttachmentContentMock).toHaveBeenCalledWith(
      executorWithRows,
      account,
      message,
      expect.objectContaining({ id: "row-b" }),
      { marker: "deps" }
    )
  })

  it("returns null at the message level when no calendar row exists", async () => {
    const executorWithRows = {
      select: vi
        .fn()
        .mockResolvedValue([
          row({ id: "row-a", filename: "notes.pdf", mime_type: "application/pdf" }),
        ]),
      execute: vi.fn().mockResolvedValue(undefined),
    } as unknown as SqlExecutor
    expect(
      await readFirstCalendarIcs(executorWithRows, account, message as never)
    ).toBeNull()
    expect(getAttachmentContentMock).not.toHaveBeenCalled()
  })
})
