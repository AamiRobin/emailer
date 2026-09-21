import type { SqlExecutor } from "../db/executor"
import { getAttachmentsForMessage } from "../db/attachments"
import type { AttachmentRow, MessageRow } from "../db/messages"
import type { EmailAccount } from "../email/types"
import {
  getAttachmentContent,
  type AttachmentDeps,
  type AttachmentMessageSource,
} from "../attachments"

/**
 * Calendar-attachment detection (task 5.5, design D5) — which rows of a
 * message's attachment list carry iCalendar data, and pulling their text
 * through the existing attachment-content seam (design D15:
 * getAttachmentContent fetches server-side on first access and serves
 * the disk cache afterwards).
 *
 * A row counts as a calendar attachment when its MIME type is
 * `text/calendar` or `application/ics`, or its filename ends with
 * `.ics` (case-insensitive) — senders disagree on which of the three is
 * set. Inline `text/calendar` parts land as attachment rows exactly like
 * this (sync projects every non-viewed MIME part into `attachments`),
 * so the same predicate covers both the explicit .ics attachment and
 * the invitation part of a METHOD:REQUEST invite.
 *
 * Pure functions here (no db access) are `isCalendarAttachment` /
 * `findCalendarAttachments`; the content getters are thin promises over
 * the D15 seam and never parse — the typed parser lives in ./ics.ts.
 */

const CALENDAR_MIME_TYPES = new Set(["text/calendar", "application/ics"])

/**
 * True when the row's mime_type or filename marks iCalendar content.
 * Accepts the full AttachmentRow or any subset carrying the two fields.
 * The mime type is compared without its parameters ("text/calendar;
 * charset=utf-8" matches text/calendar).
 */
export function isCalendarAttachment(row: {
  filename: string | null
  mime_type: string | null
}): boolean {
  const mime = (row.mime_type ?? "").split(";")[0]?.trim().toLowerCase() ?? ""
  if (CALENDAR_MIME_TYPES.has(mime)) return true
  const filename = (row.filename ?? "").trim().toLowerCase()
  return filename.endsWith(".ics")
}

/** The subset of `attachments` that carries iCalendar data, in order. */
export function findCalendarAttachments(
  attachments: AttachmentRow[]
): AttachmentRow[] {
  return attachments.filter((row) => isCalendarAttachment(row))
}

/**
 * Decode attachment bytes into .ics text (UTF-8). The parser tolerates a
 * BOM and CRLF line endings, so no further normalization happens here.
 */
export function icsTextFromBytes(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes)
}

/**
 * Fetch one attachment's content through the D15 seam and decode it to
 * .ics text. Rejects when the content cannot be fetched (no account, or
 * the provider fetch failed) — callers surface that as "could not load".
 */
export async function readIcsAttachmentText(
  executor: SqlExecutor,
  account: EmailAccount,
  message: AttachmentMessageSource,
  attachment: AttachmentRow,
  deps: AttachmentDeps = {}
): Promise<string> {
  const bytes = await getAttachmentContent(
    executor,
    account,
    message,
    attachment,
    deps
  )
  return icsTextFromBytes(bytes)
}

/**
 * Message-level convenience: the .ics text of the message's FIRST
 * calendar attachment (messageId → attachment rows → content seam), or
 * null when the message carries none. Used by flows that know only the
 * message (and by the tests as the message-level entry point); the
 * attachment-list UI uses {@link readIcsAttachmentText} on the exact row
 * the user clicked.
 */
export async function readFirstCalendarIcs(
  executor: SqlExecutor,
  account: EmailAccount,
  message: MessageRow,
  deps: AttachmentDeps = {}
): Promise<string | null> {
  const rows = await getAttachmentsForMessage(executor, message.id)
  const calendarRow = findCalendarAttachments(rows)[0]
  if (!calendarRow) return null
  return readIcsAttachmentText(
    executor,
    account,
    message,
    calendarRow,
    deps
  )
}
