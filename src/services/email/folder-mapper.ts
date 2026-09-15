import type { LabelType, SpecialUse } from "../db/labels"
import type { EmailFolder } from "./types"
import type { FolderRole, ImapFolder } from "./invoke"

/**
 * Pure IMAP folder → label-model mapping (design D14, "Folder scope
 * follows the reference's folder mapper"). No invoke, no db — the sync
 * task (4.3) owns persistence; this module only decides identity.
 *
 * Rules:
 * - Trust the server-resolved `role`: the Rust LIST already applies RFC
 *   6154 special-use attributes with a well-known-name fallback, so no
 *   name heuristics live here.
 * - Container filter: folders the server marks \NoSelect cannot be
 *   SELECTed and hold no messages (e.g. the "[Gmail]" parent) —
 *   toEmailFolder returns null for them.
 * - Role coverage: every selectable folder syncs, including the "flagged"
 *   and "all" virtual roles. They carry real messages on some servers and
 *   their roles map them to Starred/All-Mail labels; skipping them would
 *   lose that mail (D14: "sync all selectable folders, skip
 *   container-only parents").
 */

/**
 * RFC 6154 role → labels-table special-use value. Identical vocabulary
 * except imap "junk", which the schema (and gmail) call "spam".
 */
const ROLE_TO_SPECIAL_USE: Record<FolderRole, SpecialUse> = {
  inbox: "inbox",
  sent: "sent",
  drafts: "drafts",
  trash: "trash",
  junk: "spam",
  archive: "archive",
  all: "all",
  flagged: "flagged",
}

/** Canonical system label identity per special-use role. */
const SYSTEM_LABELS: Record<SpecialUse, { id: string; name: string }> = {
  inbox: { id: "INBOX", name: "Inbox" },
  sent: { id: "SENT", name: "Sent" },
  drafts: { id: "DRAFTS", name: "Drafts" },
  trash: { id: "TRASH", name: "Trash" },
  spam: { id: "SPAM", name: "Spam" },
  archive: { id: "ARCHIVE", name: "Archive" },
  all: { id: "ALL_MAIL", name: "All Mail" },
  flagged: { id: "FLAGGED", name: "Starred" },
}

/** Deterministic label id for a plain (non-system) folder path. */
export function userFolderLabelId(path: string): string {
  return `folder-${path}`
}

/** Normalize an RFC 6154 role to the labels-table special-use value. */
export function roleToSpecialUse(role: FolderRole): SpecialUse {
  return ROLE_TO_SPECIAL_USE[role]
}

/**
 * Canonical system label identity for a special-use value — the
 * role → system label helper for the labels table (insertLabel input:
 * id, name, type "system", specialUse).
 */
export function systemLabelForSpecialUse(specialUse: SpecialUse): {
  id: string
  name: string
  type: LabelType
} {
  return { ...SYSTEM_LABELS[specialUse], type: "system" }
}

/** Leaf display name: the last delimiter-separated segment of the path. */
export function leafFolderName(path: string, delimiter: string): string {
  if (!delimiter) return path
  const segments = path.split(delimiter)
  return segments[segments.length - 1] || path
}

/**
 * Map one LISTed folder to the label model. Returns null for
 * non-selectable container folders (the \NoSelect filter).
 */
export function toEmailFolder(folder: ImapFolder): EmailFolder | null {
  if (!folder.selectable) return null

  const specialUse = folder.role ? roleToSpecialUse(folder.role) : null
  if (specialUse) {
    const system = systemLabelForSpecialUse(specialUse)
    return {
      id: system.id,
      name: system.name,
      path: folder.name,
      type: "system",
      specialUse,
      delimiter: folder.delimiter,
    }
  }

  return {
    id: userFolderLabelId(folder.name),
    name: leafFolderName(folder.name, folder.delimiter),
    path: folder.name,
    type: "user",
    specialUse: null,
    delimiter: folder.delimiter,
  }
}

/** Map a LIST response, dropping container folders. */
export function toEmailFolders(folders: ImapFolder[]): EmailFolder[] {
  const mapped = folders.map(toEmailFolder)
  return mapped.filter((folder): folder is EmailFolder => folder !== null)
}

/**
 * Labels-table projection for a LISTed folder (feeds insertLabel's
 * name/type/specialUse columns; imapFolderName is the folder path).
 * Null for containers, mirroring toEmailFolder.
 */
export function toFolderLabelMapping(folder: ImapFolder): {
  labelId: string
  labelName: string
  type: LabelType
  specialUse: SpecialUse | null
  imapFolderName: string
} | null {
  const emailFolder = toEmailFolder(folder)
  if (!emailFolder) return null
  return {
    labelId: emailFolder.id,
    labelName: emailFolder.name,
    type: emailFolder.type,
    specialUse: emailFolder.specialUse,
    imapFolderName: emailFolder.path,
  }
}
