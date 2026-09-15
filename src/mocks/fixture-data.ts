import type { SpecialUse } from "../services/db/labels"
import type { ContactRef } from "../services/db/messages"
import type { FolderRole } from "../services/email/invoke"

/**
 * Shared fixture constants for the mock harness. tauri-core.ts (IMAP
 * command stubs), gmail-fetch.ts (Gmail REST stubs) and seed.ts (the
 * database seeder) all read from here so the seeded rows, the folder
 * statuses the sync engine compares against, and the stubbed server
 * responses always agree — a uidvalidity mismatch or unknown label would
 * trigger full re-syncs and pollute the demo mailbox.
 */

export const GMAIL_ACCOUNT_ID = "acc-mock-gmail"
export const IMAP_ACCOUNT_ID = "acc-mock-imap"

/** Delta-sync cursor seeded into accounts.gmail_history_id. */
export const GMAIL_HISTORY_ID = 918273

export const ME_GMAIL: ContactRef = {
  name: "Amir Robin",
  email: "amir@robinlabs.dev",
}
export const ME_IMAP: ContactRef = {
  name: "Amir Robin",
  email: "amir@fastmail.com",
}

// ---------------------------------------------------------------------------
// People (fixture contacts — every address is fake)
// ---------------------------------------------------------------------------

export interface MockPerson extends ContactRef {
  /** Autocomplete ranking weight (interaction_count). */
  interactions: number
  /** Also seeded into the imap account's address book. */
  shared: boolean
}

export const PEOPLE: MockPerson[] = [
  {
    name: "Maya Lindholm",
    email: "maya.lindholm@northwind-analytics.com",
    interactions: 23,
    shared: false,
  },
  {
    name: "Daniel Okafor",
    email: "d.okafor@brightlane.io",
    interactions: 18,
    shared: false,
  },
  {
    name: "Priya Raghavan",
    email: "priya@fernwoodlabs.com",
    interactions: 12,
    shared: true,
  },
  {
    name: "Tomás Herrera",
    email: "tomas@casacoding.com",
    interactions: 9,
    shared: true,
  },
  {
    name: "Ingrid Weiss",
    email: "ingrid.weiss@stahl-nord.de",
    interactions: 7,
    shared: false,
  },
  {
    name: "Marcus Bell",
    email: "marcus@quartzmail.com",
    interactions: 6,
    shared: true,
  },
  {
    name: "Sofia Petrov",
    email: "sofia@lumen-press.co",
    interactions: 5,
    shared: false,
  },
  {
    name: "Amelia Clarke",
    email: "amelia@papercrane.studio",
    interactions: 4,
    shared: true,
  },
  {
    name: "Jonas Vermeulen",
    email: "jonas@veldpay.com",
    interactions: 3,
    shared: false,
  },
  {
    name: "Clara Nilsen",
    email: "clara@oslofjordtravel.no",
    interactions: 3,
    shared: false,
  },
  {
    name: "Rafael Duarte",
    email: "rafael.duarte@meridianlegal.pt",
    interactions: 3,
    shared: false,
  },
  {
    name: "Noah Kim",
    email: "noah.kim@pinecrest.dev",
    interactions: 2,
    shared: true,
  },
  {
    name: "GitHub",
    email: "notifications@github.com",
    interactions: 8,
    shared: false,
  },
  {
    name: "Fastmail",
    email: "service@fastmail.com",
    interactions: 4,
    shared: true,
  },
  {
    name: "Dev Weekly",
    email: "digest@devweekly.dev",
    interactions: 6,
    shared: true,
  },
  {
    name: "React Radar",
    email: "hello@reactradar.dev",
    interactions: 5,
    shared: false,
  },
  {
    name: "Elin Sørensen",
    email: "elin@sorensen-foto.dk",
    interactions: 4,
    shared: false,
  },
  {
    name: "Oskar Lindqvist",
    email: "oskar.l@nordiskdev.se",
    interactions: 2,
    shared: false,
  },
]

export const GITHUB: ContactRef = {
  name: "GitHub",
  email: "notifications@github.com",
}
export const FASTMAIL: ContactRef = {
  name: "Fastmail",
  email: "service@fastmail.com",
}
export const DEVWEEKLY: ContactRef = {
  name: "Dev Weekly",
  email: "digest@devweekly.dev",
}
export const REACTRADAR: ContactRef = {
  name: "React Radar",
  email: "hello@reactradar.dev",
}

// ---------------------------------------------------------------------------
// Gmail labels (account 1)
// ---------------------------------------------------------------------------

export interface MockGmailLabel {
  /** Gmail label id on the wire; also the display name of system labels. */
  id: string
  specialUse: SpecialUse | null
  /** labels.color (plain CSS color the sidebar renders verbatim). */
  color?: string
}

/** System labels use the account-namespaced id `<accountId>:<SYSTEM_ID>`. */
export function gmailSystemLabelId(specialUse: SpecialUse): string {
  const systemIds: Record<string, string> = {
    inbox: "INBOX",
    sent: "SENT",
    drafts: "DRAFT",
    spam: "SPAM",
    trash: "TRASH",
  }
  return `${GMAIL_ACCOUNT_ID}:${systemIds[specialUse]}`
}

/** Plain labels use the folder-mapper identity: `<accountId>:folder-<name>`. */
export function gmailUserLabelId(name: string): string {
  return `${GMAIL_ACCOUNT_ID}:folder-${name}`
}

export const GMAIL_SYSTEM_LABELS: MockGmailLabel[] = [
  { id: "INBOX", specialUse: "inbox" },
  { id: "SENT", specialUse: "sent" },
  { id: "DRAFT", specialUse: "drafts" },
  { id: "SPAM", specialUse: "spam" },
  { id: "TRASH", specialUse: "trash" },
  { id: "ARCHIVE", specialUse: "archive" },
]

export const GMAIL_USER_LABELS: MockGmailLabel[] = [
  { id: "Work", specialUse: null, color: "#818cf8" },
  { id: "Personal", specialUse: null, color: "#34d399" },
  { id: "Finance", specialUse: null, color: "#fbbf24" },
  { id: "Travel", specialUse: null, color: "#38bdf8" },
  { id: "Newsletters", specialUse: null, color: "#c084fc" },
]

/** Every gmail label the stubbed /labels endpoint reports (no colors —
 * absent server colors leave the locally seeded values alone). */
export const ALL_GMAIL_LABELS: MockGmailLabel[] = [
  ...GMAIL_SYSTEM_LABELS,
  ...GMAIL_USER_LABELS,
]

// ---------------------------------------------------------------------------
// IMAP folders (account 2) — paths, roles and the sync cursors the mock
// imap_* commands report. The seeder writes these into folder_sync_state
// verbatim, so a delta pass sees matching uidvalidity and no new mail.
// ---------------------------------------------------------------------------

export interface MockImapFolder {
  /** Full mailbox path, exactly as the server would LIST it. */
  path: string
  role: FolderRole
  uidValidity: number
  /** Highest UID on the server (== folder_sync_state.last_seen_uid). */
  lastSeenUid: number
  highestModseq: number
  unseen: number
}

export const IMAP_FOLDERS: MockImapFolder[] = [
  {
    path: "INBOX",
    role: "inbox",
    uidValidity: 1726012801,
    lastSeenUid: 16,
    highestModseq: 5107,
    unseen: 4,
  },
  {
    path: "Sent Messages",
    role: "sent",
    uidValidity: 1726012802,
    lastSeenUid: 9,
    highestModseq: 1204,
    unseen: 0,
  },
  {
    path: "Drafts",
    role: "drafts",
    uidValidity: 1726012803,
    lastSeenUid: 0,
    highestModseq: 1,
    unseen: 0,
  },
  {
    path: "Archive",
    role: "archive",
    uidValidity: 1726012804,
    lastSeenUid: 3,
    highestModseq: 512,
    unseen: 0,
  },
  {
    path: "Spam",
    role: "junk",
    uidValidity: 1726012805,
    lastSeenUid: 2,
    highestModseq: 208,
    unseen: 1,
  },
  {
    path: "Trash",
    role: "trash",
    uidValidity: 1726012806,
    lastSeenUid: 4,
    highestModseq: 310,
    unseen: 0,
  },
]

/** labels.id of an imap folder label (`<accountId>:<SYSTEM_ID>` — the
 * folder-mapper identity scheme the imap sync engine also computes). */
export function imapFolderLabelId(folder: MockImapFolder): string {
  const systemIds: Record<FolderRole, string> = {
    inbox: "INBOX",
    sent: "SENT",
    drafts: "DRAFTS",
    trash: "TRASH",
    junk: "SPAM",
    archive: "ARCHIVE",
    all: "ALL_MAIL",
    flagged: "FLAGGED",
  }
  return `${IMAP_ACCOUNT_ID}:${systemIds[folder.role]}`
}

export function imapFolderByPath(path: string): MockImapFolder | undefined {
  return IMAP_FOLDERS.find((folder) => folder.path === path)
}
