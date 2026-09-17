import type { LabelType, SpecialUse } from "../db/labels"
import { decryptCredentials } from "../crypto/credentials"
import type {
  ConnectionTestResult,
  DeltaSyncResult,
  EmailAccount,
  EmailAddress,
  EmailFolder,
  EmailLabel,
  EmailProvider,
  FetchMessagesResult,
  FetchQuery,
  MessageFlags,
  MessageRef,
  NormalizedAttachment,
  NormalizedMessage,
  ProviderCredentials,
  SendEmailInput,
} from "./types"
import { ProviderAuthError } from "./types"
import type {
  GmailHistoryRecord,
  GmailLabel,
  GmailMessage,
  GmailMessagePart,
} from "./gmail-api"
import { GmailApiError, createGmailClient } from "./gmail-api"
import { registerProvider } from "./provider-factory"
import type { GmailTokenEnvelope } from "./token-manager"
import { createTokenSource } from "./token-manager"
import {
  buildMimeMessage,
  bytesToBase64Url,
  stringToBase64Url,
} from "./mime-builder"
import {
  leafFolderName,
  systemLabelForSpecialUse,
  userFolderLabelId,
} from "./folder-mapper"

/**
 * EmailProvider implementation for Gmail accounts (task 4.2, design
 * D2/D9): REST over the fetch patched by tauri-plugin-http, OAuth silent
 * refresh in token-manager.ts, labels instead of folders, history-based
 * delta sync.
 *
 * Folder semantics on Gmail (documented deviations from the IMAP model):
 * - Folders ARE labels. listFolders maps system labels (INBOX, SENT,
 *   DRAFT, SPAM, TRASH) to canonical system label rows and user labels to
 *   "folder-<name>" rows; UNREAD / STARRED / IMPORTANT / CATEGORY_* are
 *   not folders and are skipped.
 * - archive = remove INBOX; trash = messages.trash (the canonical API —
 *   it adds TRASH and evicts the message from other placement labels);
 *   flag = STARRED label; read = absence of UNREAD.
 * - moveToFolder = set the destination label and drop the other
 *   placement labels (INBOX/TRASH/SPAM): Gmail has no imap-style move.
 * - appendMessage = messages.insert of the raw MIME (sent-mail filing /
 *   drafts), best-effort resolving the imap folder name to a label.
 */

/** Gmail system label id → labels-table special-use role. */
const GMAIL_SPECIAL_USE: Record<string, SpecialUse> = {
  INBOX: "inbox",
  SENT: "sent",
  DRAFT: "drafts",
  SPAM: "spam",
  TRASH: "trash",
}

/** System labels that are states/flags, not folders — never listed. */
const NON_FOLDER_SYSTEM_LABELS = new Set(["UNREAD", "STARRED", "IMPORTANT"])

/** The mutually-exclusive "which list does this live in" labels. */
const PLACEMENT_LABEL_IDS = ["INBOX", "TRASH", "SPAM"]

/** Guard against runaway uidSet expansion ("1:999999" would hang a sync). */
const MAX_UID_SET_EXPANSION = 500

/** History pagination cap; after 100 pages a resync is the safer path. */
const MAX_HISTORY_PAGES = 100

// ---------------------------------------------------------------------------
// Pure mapping helpers (exported for unit tests and the later label task)
// ---------------------------------------------------------------------------

/**
 * Serialize a Gmail label color for the labels table's single `color`
 * column (the later label task decodes server colors via
 * decodeGmailColor). JSON keeps both channels — background and text.
 */
export function encodeGmailColor(
  color: GmailLabel["color"]
): string | undefined {
  if (!color || (!color.backgroundColor && !color.textColor)) return undefined
  return JSON.stringify({
    background: color.backgroundColor ?? null,
    text: color.textColor ?? null,
  })
}

/** Inverse of encodeGmailColor; malformed values decode to null. */
export function decodeGmailColor(encoded: string | null | undefined): {
  backgroundColor?: string
  textColor?: string
} | null {
  if (!encoded) return null
  try {
    const parsed = JSON.parse(encoded) as {
      background?: string | null
      text?: string | null
    }
    if (!parsed.background && !parsed.text) return null
    return {
      backgroundColor: parsed.background ?? undefined,
      textColor: parsed.text ?? undefined,
    }
  } catch {
    return null
  }
}

/** Is this label folder-ish (listed by listFolders / label sync)? */
export function isFolderishLabel(label: GmailLabel): boolean {
  if (label.type !== "system") return true
  if (NON_FOLDER_SYSTEM_LABELS.has(label.id)) return false
  return !label.id.startsWith("CATEGORY_")
}

/** Gmail label → provider folder DTO, or null for non-folder labels. */
export function gmailLabelToFolder(label: GmailLabel): EmailFolder | null {
  if (!isFolderishLabel(label)) return null
  const specialUse = GMAIL_SPECIAL_USE[label.id] ?? null
  if (specialUse) {
    const system = systemLabelForSpecialUse(specialUse)
    return {
      id: system.id,
      name: system.name,
      path: label.name,
      type: "system",
      specialUse,
      delimiter: "/",
    }
  }
  return {
    id: userFolderLabelId(label.name),
    name: leafFolderName(label.name, "/"),
    path: label.name,
    type: "user",
    specialUse: null,
    delimiter: "/",
  }
}

/** Gmail label → labels-table input (label sync for task 4.4/10.x). */
export function gmailLabelToEmailLabel(
  label: GmailLabel,
  accountId: string
): EmailLabel | null {
  const folder = gmailLabelToFolder(label)
  if (!folder) return null
  return {
    id: folder.id,
    accountId,
    name: label.name,
    gmailLabelId: label.id,
    specialUse: folder.specialUse ?? undefined,
    color: encodeGmailColor(label.color),
    type: folder.type as LabelType,
  }
}

/** Gmail labelIds → IMAP-style flags. Read is the ABSENCE of UNREAD. */
export function flagsForLabelIds(labelIds: string[]): string[] {
  const flags: string[] = []
  if (!labelIds.includes("UNREAD")) flags.push("\\Seen")
  if (labelIds.includes("STARRED")) flags.push("\\Flagged")
  if (labelIds.includes("DRAFT")) flags.push("\\Draft")
  return flags
}

/** One flag's backing gmail label; null for pass-through keywords. */
function labelForFlag(flag: string): string | null {
  switch (flag) {
    case "\\Seen":
      return "UNREAD"
    case "\\Flagged":
      return "STARRED"
    case "\\Draft":
      return "DRAFT"
    default:
      return null
  }
}

/** Flag store → modify payload. \\Seen inverts (UNREAD absence); unknown
 * flags round-trip as literal gmail label ids (imap keywords). */
export function labelChangesForFlags(
  flags: string[],
  add: boolean
): { addLabelIds: string[]; removeLabelIds: string[] } {
  const addLabelIds: string[] = []
  const removeLabelIds: string[] = []
  for (const flag of flags) {
    const label = labelForFlag(flag)
    if (label === null) {
      if (add) addLabelIds.push(flag)
      else removeLabelIds.push(flag)
    } else if (flag === "\\Seen") {
      if (add) removeLabelIds.push(label)
      else addLabelIds.push(label)
    } else {
      if (add) addLabelIds.push(label)
      else removeLabelIds.push(label)
    }
  }
  return { addLabelIds, removeLabelIds }
}

/**
 * Expand an imap-style uid set into concrete gmail message ids. Gmail ids
 * are int64 decimals, so "104:*" degrades to [104] (no mailbox high-water
 * mark to close the range); bounded ranges expand inclusively.
 */
export function parseUidSet(uidSet: string): number[] {
  const ids = new Set<number>()
  for (const token of uidSet.split(",")) {
    const trimmed = token.trim()
    if (!trimmed) continue
    const range = /^(\d+):(\d+|\*)$/.exec(trimmed)
    if (range) {
      const from = Number(range[1])
      const to = range[2] === "*" ? from : Number(range[2])
      if (Number.isNaN(from) || Number.isNaN(to)) continue
      const [low, high] = from <= to ? [from, to] : [to, from]
      if (high - low + 1 > MAX_UID_SET_EXPANSION) {
        throw new Error(
          `uidSet "${uidSet}" expands to more than ${MAX_UID_SET_EXPANSION} ids`
        )
      }
      for (let id = low; id <= high; id++) ids.add(id)
    } else {
      const id = Number(trimmed)
      if (!Number.isNaN(id)) ids.add(id)
    }
  }
  return [...ids].sort((a, b) => a - b)
}

/**
 * Gmail message id → the interface's numeric uid. FALLBACK ONLY: real
 * Gmail message ids are opaque hex-ish strings ("17bec548b2c4e7ca") that
 * do not survive Number() — those get uid 0 and the exact string rides
 * along in MessageRef.providerMessageId / NormalizedMessage.gmailId.
 * Numeric (legacy int64 decimal) ids still coerce, minus 2^53 precision.
 */
function toUid(id: string): number {
  const parsed = Number(id)
  return Number.isFinite(parsed) ? parsed : 0
}

/** MessageRef → the id string sent to the Gmail API: prefer the exact
 * providerMessageId; String(uid) only for legacy numeric-only refs. */
function refMessageId(ref: MessageRef): string {
  return ref.providerMessageId ?? String(ref.uid)
}

interface CollectedBodies {
  text?: string
  html?: string
  attachments: NormalizedAttachment[]
}

function headerValue(
  part: GmailMessagePart | undefined,
  name: string
): string | undefined {
  const header = part?.headers?.find(
    (candidate) => candidate.name.toLowerCase() === name.toLowerCase()
  )
  return header?.value
}

function base64UrlToText(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index)
  }
  return new TextDecoder("utf-8").decode(bytes)
}

/** Depth-first payload walk: first text/plain and text/html become the
 * bodies; parts with a filename + attachmentId become attachment rows
 * (content bytes are fetched on demand, D15). Nested multipart/related
 * (inline images) is traversed. */
function collectParts(part: GmailMessagePart, out: CollectedBodies): void {
  const filename = part.filename ?? ""
  const attachmentId = part.body?.attachmentId
  if (filename && attachmentId) {
    const contentId =
      headerValue(part, "Content-Id") ?? headerValue(part, "X-Attachment-Id")
    out.attachments.push({
      partId: part.partId,
      filename,
      mimeType: part.mimeType ?? "application/octet-stream",
      size: part.body?.size ?? 0,
      contentId: contentId
        ? contentId.replace(/^<|>$/g, "").replace(/^cid:/i, "")
        : undefined,
      isInline: Boolean(contentId),
    })
    return
  }
  if (part.parts?.length) {
    for (const child of part.parts) collectParts(child, out)
    return
  }
  const data = part.body?.data
  if (!data) return
  if (part.mimeType === "text/plain" && out.text === undefined) {
    out.text = base64UrlToText(data)
  } else if (part.mimeType === "text/html" && out.html === undefined) {
    out.html = base64UrlToText(data)
  }
}

function parseDateSeconds(
  dateHeader: string | undefined,
  internalDate: string | undefined
): number {
  if (dateHeader) {
    const parsed = Date.parse(dateHeader)
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000)
  }
  if (internalDate) {
    const ms = Number(internalDate)
    if (Number.isFinite(ms)) return Math.floor(ms / 1000)
  }
  return 0
}

/** "Name <a@b>" / "<a@b>" / "a@b" → participants. Naive comma split —
 * quoted display names containing commas are a known limitation. */
export function addressesFromHeader(value: string | undefined): EmailAddress[] {
  if (!value) return []
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const match = /^(.*?)\s*<([^<>]+)>\s*$/.exec(entry)
      if (!match) return { email: entry }
      const name = match[1].trim().replace(/^"|"$/g, "")
      return { name: name || undefined, email: match[2].trim() }
    })
}

/** Gmail API message → NormalizedMessage (gmail slots filled). */
export function mapGmailMessage(message: GmailMessage): NormalizedMessage {
  const payload = message.payload
  const bodies: CollectedBodies = { attachments: [] }
  if (payload) collectParts(payload, bodies)
  const labelIds = message.labelIds ?? []
  return {
    uid: toUid(message.id),
    flags: flagsForLabelIds(labelIds),
    messageId: headerValue(payload, "Message-ID"),
    inReplyTo: headerValue(payload, "In-Reply-To"),
    references: headerValue(payload, "References"),
    // List-unsubscribe capture (task 18.3, design D13): carried verbatim;
    // the sync engine stores the pair in the message's headers JSON.
    listUnsubscribe: headerValue(payload, "List-Unsubscribe"),
    listUnsubscribePost: headerValue(payload, "List-Unsubscribe-Post"),
    subject: headerValue(payload, "Subject"),
    from: addressesFromHeader(headerValue(payload, "From")),
    to: addressesFromHeader(headerValue(payload, "To")),
    cc: addressesFromHeader(headerValue(payload, "Cc")),
    bcc: addressesFromHeader(headerValue(payload, "Bcc")),
    date: parseDateSeconds(headerValue(payload, "Date"), message.internalDate),
    textBody: bodies.text,
    htmlBody: bodies.html,
    size: message.sizeEstimate ?? 0,
    attachments: bodies.attachments,
    // Gmail has no folder a message "lives in" — placement is labels.
    folder: undefined,
    gmailId: message.id,
    gmailThreadId: message.threadId,
    labelIds,
    historyId: message.historyId,
  }
}

export interface MappedHistoryDelta {
  /** Messages added within the window (fetch full bodies for these). */
  addedIds: string[]
  /** Messages deleted within the window. */
  deletedIds: string[]
  /** Flag-label flips (UNREAD / STARRED / …) for reconciliation. */
  labelChanges: {
    messageId: string
    addedLabelIds: string[]
    removedLabelIds: string[]
  }[]
}

/**
 * History records → delta, reconciled in order: a message added and then
 * deleted inside the window nets out (the sync engine never saw it), and
 * delete-then-re-add lands in addedIds only.
 */
export function mapHistoryDelta(
  records: GmailHistoryRecord[]
): MappedHistoryDelta {
  const added = new Set<string>()
  const deleted = new Set<string>()
  const labelChanges: MappedHistoryDelta["labelChanges"] = []
  for (const record of records) {
    for (const entry of record.messagesAdded ?? []) {
      added.add(entry.message.id)
      deleted.delete(entry.message.id)
    }
    for (const entry of record.messagesDeleted ?? []) {
      deleted.add(entry.message.id)
      added.delete(entry.message.id)
    }
    for (const entry of record.labelsAdded ?? []) {
      labelChanges.push({
        messageId: entry.message.id,
        addedLabelIds: entry.labelIds,
        removedLabelIds: [],
      })
    }
    for (const entry of record.labelsRemoved ?? []) {
      labelChanges.push({
        messageId: entry.message.id,
        addedLabelIds: [],
        removedLabelIds: entry.labelIds,
      })
    }
  }
  return {
    addedIds: [...added],
    deletedIds: [...deleted],
    labelChanges,
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface GmailProviderDeps {
  /** Injectable fetch (tests); default is globalThis.fetch. */
  fetchImpl?: typeof fetch
  /** Pre-resolved token envelope; when absent the encrypted
   * account.credentialsJson envelope is decrypted on first token use. */
  tokenEnvelope?: GmailTokenEnvelope | null
}

/**
 * Build the provider for one Gmail account. Throws eagerly when the
 * account has no client id; the refresh-token check happens lazily on
 * first API call (decryption is async, the factory contract is sync).
 */
export function createGmailProvider(
  account: EmailAccount,
  credentials: ProviderCredentials,
  deps: GmailProviderDeps = {}
): EmailProvider {
  // The imap-style password is unused for gmail (OAuth only); the field
  // exists so both providers share the factory contract.
  void credentials.password

  if (!account.oauthClientId) {
    throw new Error(
      `Account ${account.id} (${account.email}) has no oauth_client_id configured`
    )
  }

  const envelope: Promise<GmailTokenEnvelope | null> =
    deps.tokenEnvelope !== undefined
      ? Promise.resolve(deps.tokenEnvelope)
      : decryptCredentials<GmailTokenEnvelope>(account.credentialsJson ?? null)

  const tokenSource = createTokenSource(account, envelope, deps.fetchImpl)
  const client = createGmailClient({
    accountId: account.id,
    getToken: (force) => tokenSource.getToken(force),
    fetchImpl: deps.fetchImpl,
  })

  async function listFolders(): Promise<EmailFolder[]> {
    const labels = await client.listLabels()
    return labels
      .map(gmailLabelToFolder)
      .filter((folder): folder is EmailFolder => folder !== null)
  }

  /**
   * History-based delta sync. cursor === the persisted gmail history id.
   * A null cursor or a 404 ("HistoryId expired" — history is pruned
   * server-side after ~30 days of inactivity) demands a full sync; the
   * fresh profile historyId is returned as the cursor to persist after
   * that sync completes (full enumeration runs through fetchMessages,
   * tasks 4.3/4.4).
   */
  async function deltaSync(cursor: string | null): Promise<DeltaSyncResult> {
    if (cursor === null || cursor === "") {
      const profile = await client.getProfile()
      return {
        messages: [],
        nextCursor: profile.historyId ?? "",
        needsFullSync: true,
      }
    }

    let records: GmailHistoryRecord[]
    let nextCursor: string
    try {
      const page = await listAllHistory(cursor)
      records = page.records
      nextCursor = page.historyId ?? cursor
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) {
        const profile = await client.getProfile()
        return {
          messages: [],
          nextCursor: profile.historyId ?? "",
          needsFullSync: true,
        }
      }
      throw error
    }

    const delta = mapHistoryDelta(records)
    const messages: NormalizedMessage[] = []
    for (const id of delta.addedIds) {
      try {
        messages.push(mapGmailMessage(await client.getMessage(id)))
      } catch (error) {
        // Added then deleted before we fetched — skip, it is gone.
        if (error instanceof GmailApiError && error.status === 404) continue
        throw error
      }
    }
    return { messages, nextCursor, needsFullSync: false }
  }

  async function listAllHistory(startHistoryId: string): Promise<{
    records: GmailHistoryRecord[]
    historyId?: string
  }> {
    const records: GmailHistoryRecord[] = []
    let historyId: string | undefined
    let pageToken: string | undefined
    for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
      const response = await client.listHistory(startHistoryId, pageToken)
      records.push(...(response.history ?? []))
      historyId = response.historyId ?? historyId
      if (!response.nextPageToken) return { records, historyId }
      pageToken = response.nextPageToken
    }
    return { records, historyId }
  }

  async function fetchMessages(
    folder: string,
    query: FetchQuery
  ): Promise<FetchMessagesResult> {
    void folder // gmail placement is labels; the folder arg carries no scope
    let ids: string[]
    let exists = 0
    if (query.last !== undefined) {
      const page = await client.listMessages({ maxResults: query.last })
      ids = (page.messages ?? []).map((message) => message.id)
      exists = page.resultSizeEstimate ?? 0
    } else if (query.uidSet !== undefined) {
      ids = parseUidSet(query.uidSet).map(String)
    } else {
      throw new Error("fetchMessages requires uidSet or last")
    }
    const messages: NormalizedMessage[] = []
    for (const id of ids) {
      try {
        messages.push(mapGmailMessage(await client.getMessage(id)))
      } catch (error) {
        if (error instanceof GmailApiError && error.status === 404) continue
        throw error
      }
    }
    // Gmail exposes no mailbox counters; message ids are immutable so
    // uidValidity is the constant 1 (never invalidated).
    return {
      messages,
      folderStatus: { uidValidity: 1, uidNext: 0, exists, unseen: 0 },
    }
  }

  async function fetchFlags(
    folder: string,
    query: FetchQuery
  ): Promise<MessageFlags[]> {
    void folder
    let ids: string[]
    if (query.last !== undefined) {
      const page = await client.listMessages({ maxResults: query.last })
      ids = (page.messages ?? []).map((message) => message.id)
    } else if (query.uidSet !== undefined) {
      ids = parseUidSet(query.uidSet).map(String)
    } else {
      throw new Error("fetchFlags requires uidSet or last")
    }
    const flags: MessageFlags[] = []
    for (const id of ids) {
      try {
        const message = await client.getMessage(id, "metadata")
        flags.push({
          uid: toUid(id),
          flags: flagsForLabelIds(message.labelIds ?? []),
        })
      } catch (error) {
        if (error instanceof GmailApiError && error.status === 404) continue
        throw error
      }
    }
    return flags
  }

  async function modifyLabels(
    ref: MessageRef,
    addLabelIds: string[],
    removeLabelIds: string[]
  ): Promise<void> {
    await client.modifyMessageLabels(
      refMessageId(ref),
      addLabelIds,
      removeLabelIds
    )
  }

  return {
    accountId: account.id,
    type: "gmail",

    listFolders,

    deltaSync,

    fetchMessages,

    fetchFlags,

    async storeFlags(
      folder: string,
      uidSet: string,
      flags: string[],
      add: boolean
    ): Promise<void> {
      void folder
      const { addLabelIds, removeLabelIds } = labelChangesForFlags(flags, add)
      for (const id of parseUidSet(uidSet)) {
        await client.modifyMessageLabels(
          String(id),
          addLabelIds,
          removeLabelIds
        )
      }
    },

    async markRead(refs: MessageRef[], read: boolean): Promise<void> {
      for (const ref of refs) {
        await modifyLabels(ref, read ? [] : ["UNREAD"], read ? ["UNREAD"] : [])
      }
    },

    async markStarred(refs: MessageRef[], starred: boolean): Promise<void> {
      for (const ref of refs) {
        await modifyLabels(
          ref,
          starred ? ["STARRED"] : [],
          starred ? [] : ["STARRED"]
        )
      }
    },

    async addLabels(refs: MessageRef[], labelIds: string[]): Promise<void> {
      for (const ref of refs) await modifyLabels(ref, labelIds, [])
    },

    async removeLabels(refs: MessageRef[], labelIds: string[]): Promise<void> {
      for (const ref of refs) await modifyLabels(ref, [], labelIds)
    },

    /** Archive = drop the INBOX label (Gmail's archive semantics). */
    async archive(refs: MessageRef[]): Promise<void> {
      for (const ref of refs) await modifyLabels(ref, [], ["INBOX"])
    },

    /** Trash via the canonical messages.trash endpoint (adds TRASH and
     * clears placement labels server-side); recoverable via untrash. */
    async trash(refs: MessageRef[]): Promise<void> {
      for (const ref of refs) await client.trashMessage(refMessageId(ref))
    },

    /**
     * Gmail has no imap-style move: "moving" sets the destination label
     * and drops the other placement labels (so moving to a user label
     * archives the message out of the inbox).
     */
    async moveToFolder(
      refs: MessageRef[],
      destinationFolder: string
    ): Promise<void> {
      const destination = await resolveLabelId(destinationFolder)
      const removes = PLACEMENT_LABEL_IDS.filter(
        (labelId) => labelId !== destination
      )
      for (const ref of refs) await modifyLabels(ref, [destination], removes)
    },

    async deleteForever(refs: MessageRef[]): Promise<void> {
      for (const ref of refs) await client.deleteMessage(refMessageId(ref))
    },

    async sendMessage(input: SendEmailInput) {
      // Task 18.5 (design D11): a PGP send arrives FULLY BUILT (the
      // signed/encrypted PGP/MIME was frozen into the queued input at
      // enqueue time — the passphrase exists only there) and is
      // transmitted verbatim; rebuilding from the structured fields would
      // unwrap the protection. The fields stay for bookkeeping only.
      if (input.pgpMime) {
        await client.sendMessageRaw(stringToBase64Url(input.pgpMime))
        return { messageId: input.messageId ?? "" }
      }
      const built = buildMimeMessage(input)
      await client.sendMessageRaw(stringToBase64Url(built.mime))
      return { messageId: built.messageId }
    },

    /**
     * imap APPEND equivalent: messages.insert of the raw MIME. The folder
     * name is resolved to a gmail label when possible (Sent → SENT);
     * \\Draft maps to the DRAFT label. Gmail files sent mail into SENT
     * automatically after sendMessage, so this is mainly for drafts and
     * imports.
     */
    async appendMessage(
      folder: string,
      raw: Uint8Array,
      flags?: string[]
    ): Promise<void> {
      const labelIds = new Set<string>()
      if (flags?.includes("\\Draft")) labelIds.add("DRAFT")
      if (folder) {
        try {
          const resolved = await findLabelId(folder)
          if (resolved) labelIds.add(resolved)
        } catch {
          // Label listing failed — insert unlabeled rather than lose mail.
        }
      }
      await client.insertMessageRaw(bytesToBase64Url(raw), [...labelIds])
    },

    async testConnection(): Promise<ConnectionTestResult> {
      try {
        const profile = await client.getProfile()
        return {
          success: true,
          message: `Connected to Gmail as ${profile.emailAddress}`,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message,
          authError: error instanceof ProviderAuthError,
        }
      }
    },
  }

  /**
   * Accept a gmail label id, a label name, or a labels-table
   * "folder-<name>" id; resolve to the gmail label id. Unknown values are
   * passed through as gmail label ids (moveToFolder's caller may hold a
   * raw gmail id).
   */
  async function resolveLabelId(destination: string): Promise<string> {
    return (await findLabelId(destination)) ?? destination
  }

  /** Strict variant: null instead of passing unknown values through
   * (appendMessage must not invent labels server-side). */
  async function findLabelId(destination: string): Promise<string | null> {
    const labels = await client.listLabels()
    const lowered = destination.toLowerCase()
    const match = labels.find(
      (label) =>
        label.id.toLowerCase() === lowered ||
        label.name.toLowerCase() === lowered ||
        `folder-${label.name.toLowerCase()}` === lowered
    )
    return match?.id ?? null
  }
}

/**
 * Register the Gmail implementation in the provider factory. Called from
 * register-providers.ts (bootstrap-adjacent import) and by tests.
 */
export function registerGmailProvider(): void {
  registerProvider("gmail", (account, credentials) =>
    createGmailProvider(account, credentials)
  )
}
