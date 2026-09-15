import type { LucideIcon } from "lucide-react"
import {
  Archive,
  FileText,
  Inbox,
  OctagonAlert,
  Send,
  Star,
  Trash,
} from "lucide-react"

import type { FolderCountKey } from "@/services/db/folder-counts"
import type { FolderSelection } from "@/stores/ui-store"

/**
 * The seven system folders of the mailbox UI (task 6.7) — THE shared
 * constant. The command palette (task 6.7) and the sidebar (task 6.3,
 * which adopted this constant in the cleanup that resolved its earlier
 * duplicate) both render from it: same order, icons, titles and
 * ViewSelection payloads, so the two surfaces can never drift.
 */
export interface FolderEntry {
  /** Key into FolderUnreadCounts (badge data, unused by the palette). */
  countKey: FolderCountKey
  title: string
  icon: LucideIcon
  /** ViewSelection folder payload (see ui-store's query mapping). */
  folder: FolderSelection
}

export const FOLDER_ITEMS: FolderEntry[] = [
  {
    countKey: "inbox",
    title: "Inbox",
    icon: Inbox,
    folder: { kind: "specialUse", specialUse: "inbox" },
  },
  {
    countKey: "starred",
    title: "Starred",
    icon: Star,
    folder: { kind: "starred" },
  },
  {
    countKey: "sent",
    title: "Sent",
    icon: Send,
    folder: { kind: "specialUse", specialUse: "sent" },
  },
  {
    countKey: "drafts",
    title: "Drafts",
    icon: FileText,
    folder: { kind: "specialUse", specialUse: "drafts" },
  },
  {
    countKey: "archive",
    title: "Archive",
    icon: Archive,
    folder: { kind: "specialUse", specialUse: "archive" },
  },
  {
    countKey: "spam",
    title: "Spam",
    icon: OctagonAlert,
    folder: { kind: "specialUse", specialUse: "spam" },
  },
  {
    countKey: "trash",
    title: "Trash",
    icon: Trash,
    folder: { kind: "specialUse", specialUse: "trash" },
  },
]
