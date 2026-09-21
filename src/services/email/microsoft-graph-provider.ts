import type { SpecialUse } from "../db/labels"
import { decryptCredentials } from "../crypto/credentials"
import { encryptCredentials } from "../crypto/credentials"
import { getExecutor } from "../db/executor"
import { updateCredentials } from "../db/accounts"
import type {
  ConnectionTestResult,
  DeltaSyncResult,
  EmailAccount,
  EmailAddress,
  EmailFolder,
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
import { parseAuthResults } from "./auth-results"
import {
  GraphApiError,
  createGraphClient,
  validatedGraphLink,
} from "./graph-api"
import type {
  GraphFolder,
  GraphMessage,
  GraphMessageBody,
  GraphProfile,
  GraphRecipient,
} from "./graph-api"
import { registerProvider } from "./provider-factory"
import type { MicrosoftTokenEnvelope } from "./microsoft-token-manager"
import { createMicrosoftTokenSource } from "./microsoft-token-manager"
import { buildMimeMessage } from "./mime-builder"
import {
  leafFolderName,
  systemLabelForSpecialUse,
  userFolderLabelId,
} from "./folder-mapper"

/**
 * EmailProvider implementation for Microsoft 365 / Outlook.com accounts
 * (parity-round-2 tasks 3.1–3.4, design D1/D2/D3): REST over the fetch
 * patched by tauri-plugin-http, silent refresh in
 * microsoft-token-manager.ts, REAL folders instead of labels, and
 * per-folder /messages/delta synchronization.
 *
 * Folder semantics on Graph (documented deviations from the IMAP model):
 * - Folders are real mailbox folders; the well-known roles (inbox,
 *   sentitems, drafts, deleteditems, archive, junkemail) are resolved by
 *   their well-known NAMES — display names are locale-dependent, the
 *   addressable names are not. A missing well-known folder (older
 *   mailboxes) simply carries no role.
 * - archive = move to the `archive` well-known folder, falling back to
 *   Deleted Items when the mailbox has no Archive folder; trash = move to
 *   `deleteditems` (recoverable); deleteForever = move to Deleted Items
 *   then DELETE (the purge); moveToFolder resolves the destination by
 *   folder path, well-known name, or raw Graph id.
 * - Graph has no server-side labels: addLabels/removeLabels are no-ops
 *   (labels are local-only for these accounts, design D3) and flags map
 *   to the message's isRead / flag.flagStatus / isDraft state.
 *
 * Send semantics: sends go through the documented raw-MIME path
 * (createDraft → PUT …/$value → POST …/send) rather than the structured
 * sendMail action, because Graph's sendMail cannot carry the Message-ID /
 * In-Reply-To / References headers the app's send flow depends on
 * (offline dedupe, provisional-sent reconciliation, threading). The sent
 * copy is filed in Sent Items by default — the sendMail action (with
 * saveToSentItems) stays on the client for structured one-shot sends.
 */

/** Graph well-known folder name → labels-table special-use role. */
const WELL_KNOWN_SPECIAL_USE: Record<string, SpecialUse> = {
  inbox: "inbox",
  sentitems: "sent",
  drafts: "drafts",
  deleteditems: "trash",
  junkemail: "spam",
  archive: "archive",
}

/** The well-known folder names resolved for special-use detection. */
const WELL_KNOWN_NAMES = Object.keys(WELL_KNOWN_SPECIAL_USE)

/** Well-known names used as move destinations. */
const DELETED_ITEMS = "deleteditems"
const ARCHIVE = "archive"

/** Delta pagination cap; past it a pass returns what it accumulated plus
 * a continuation cursor (never throws the work away). */
const MAX_DELTA_PAGES = 200
/** Explicit page size for delta feeds. Without it Graph's default page is
 * ≈10 entries, so a large initial pull burns the page cap long before it
 * converges. */
const DELTA_PAGE_SIZE = 50

// ---------------------------------------------------------------------------
// Pure mapping helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** Well-known name for a listed folder (matched by its addressable id
 * suffix is impossible — Graph ids are opaque — so the resolution happens
 * at listFolders time, not here). Pure display: leaf name of a path. */
export function graphFolderSpecialUse(
  wellKnownName: string | null
): SpecialUse | null {
  return wellKnownName ? WELL_KNOWN_SPECIAL_USE[wellKnownName] ?? null : null
}

/** Graph folder → provider folder DTO (path = display-name chain). */
export function graphFolderToFolder(
  wellKnownName: string | null,
  path: string
): EmailFolder {
  const specialUse = graphFolderSpecialUse(wellKnownName)
  if (specialUse) {
    const system = systemLabelForSpecialUse(specialUse)
    return {
      id: system.id,
      name: system.name,
      path,
      type: "system",
      specialUse,
      delimiter: "/",
    }
  }
  return {
    id: userFolderLabelId(path),
    name: leafFolderName(path, "/"),
    path,
    type: "user",
    specialUse: null,
    delimiter: "/",
  }
}

/** Graph flag state → IMAP-style flags. Read IS the isRead property. */
export function flagsForGraphMessage(message: {
  isRead?: boolean
  flag?: { flagStatus?: string }
  isDraft?: boolean
}): string[] {
  const flags: string[] = []
  if (message.isRead) flags.push("\\Seen")
  if (message.flag?.flagStatus === "flagged") flags.push("\\Flagged")
  if (message.isDraft) flags.push("\\Draft")
  return flags
}

/** One flag's effect on the message patch; null for ignored keywords. */
export function patchForFlag(
  flag: string,
  add: boolean
): { isRead?: boolean; flag?: { flagStatus: string } } | null {
  switch (flag) {
    case "\\Seen":
      // Read = the SEEN flag; unread = the flag's absence.
      return { isRead: add }
    case "\\Flagged":
      return { flag: { flagStatus: add ? "flagged" : "notFlagged" } }
    default:
      // Graph messages carry no keyword store (isDraft is not PATCHable);
      // pass-through keywords are ignored, exactly like gmail's
      // non-label flags.
      return null
  }
}

/** Flag store → the per-flag patches (order preserved for tests). */
export function patchesForFlags(
  flags: string[],
  add: boolean
): { isRead?: boolean; flag?: { flagStatus: string } }[] {
  const patches: { isRead?: boolean; flag?: { flagStatus: string } }[] = []
  for (const flag of flags) {
    const patch = patchForFlag(flag, add)
    if (patch) patches.push(patch)
  }
  return patches
}

/** Graph emailAddress (`{ name?, address }`) → `{ name?, email }`. */
export function recipientToAddress(
  recipient: { name?: string; address: string } | undefined
): EmailAddress | null {
  const email = recipient?.address
  if (!email) return null
  const name = recipient?.name
  return name ? { name, email } : { email }
}

function recipientsToAddresses(
  recipients: GraphRecipient[] | undefined
): EmailAddress[] {
  const addresses: EmailAddress[] = []
  for (const recipient of recipients ?? []) {
    const address = recipientToAddress(recipient?.emailAddress)
    if (address) addresses.push(address)
  }
  return addresses
}

/** ISO 8601 (e.g. "2023-11-14T22:13:20Z") → unix seconds (0 fallback). */
export function graphDateToSeconds(iso: string | undefined): number {
  if (!iso) return 0
  const ms = Date.parse(iso)
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000)
}

function headerValues(
  message: GraphMessage,
  name: string
): string[] {
  return (message.internetMessageHeaders ?? [])
    .filter((header) => header.name.toLowerCase() === name.toLowerCase())
    .map((header) => header.value)
}

function firstHeaderValue(
  message: GraphMessage,
  name: string
): string | undefined {
  return headerValues(message, name)[0]
}

interface CollectedGraphBodies {
  text?: string
  html?: string
}

/** The single Graph body (Outlook stores one rendering) → body fields. */
function collectBody(
  body: GraphMessageBody | undefined,
  out: CollectedGraphBodies
): void {
  if (!body?.content) return
  if (body.contentType === "html") {
    if (out.html === undefined) out.html = body.content
  } else if (out.text === undefined) {
    out.text = body.content
  }
}

function collectAttachments(
  message: GraphMessage
): NormalizedAttachment[] {
  const attachments: NormalizedAttachment[] = []
  for (const attachment of message.attachments ?? []) {
    if (!attachment.id) continue
    attachments.push({
      partId: attachment.id,
      filename: attachment.name ?? "attachment",
      mimeType: attachment.contentType ?? "application/octet-stream",
      size: attachment.size ?? 0,
      contentId: attachment.contentId
        ? attachment.contentId.replace(/^<|>$/g, "").replace(/^cid:/i, "")
        : undefined,
      isInline: attachment.isInline === true,
    })
  }
  return attachments
}

/** Fallback octet estimate: Graph exposes no message size. */
function estimateSize(message: GraphMessage): number {
  const body = message.body?.content ?? ""
  return body.length + (message.bodyPreview?.length ?? 0)
}

/** Graph API message → NormalizedMessage (graph slots filled). */
export function mapGraphMessage(message: GraphMessage): NormalizedMessage {
  const bodies: CollectedGraphBodies = {}
  collectBody(message.body, bodies)
  return {
    uid: 0, // Graph ids are opaque — providerMessageId/graphId carry identity
    flags: flagsForGraphMessage(message),
    messageId: message.internetMessageId,
    inReplyTo: firstHeaderValue(message, "In-Reply-To"),
    references: firstHeaderValue(message, "References"),
    // List-unsubscribe capture (task 18.3, design D13) — same contract as
    // the gmail/imap mappers.
    listUnsubscribe: firstHeaderValue(message, "List-Unsubscribe"),
    listUnsubscribePost: firstHeaderValue(message, "List-Unsubscribe-Post"),
    // TS-side REST (like Gmail): parse Authentication-Results HERE at
    // ingestion with the shared compact grammar (design D10).
    authResults: parseAuthResults(headerValues(message, "Authentication-Results")),
    subject: message.subject,
    from: message.from
      ? [recipientToAddress(message.from.emailAddress)].filter(
          (address): address is EmailAddress => address !== null
        )
      : [],
    to: recipientsToAddresses(message.toRecipients),
    cc: recipientsToAddresses(message.ccRecipients),
    bcc: recipientsToAddresses(message.bccRecipients),
    date: graphDateToSeconds(message.receivedDateTime),
    textBody: bodies.text,
    htmlBody: bodies.html,
    size: estimateSize(message),
    attachments: collectAttachments(message),
    folder: undefined,
    graphId: message.id,
    graphThreadId: message.conversationId,
    graphFolderId: message.parentFolderId,
  }
}

/** MessageRef → the id string sent to the Graph API (like the gmail
 * provider: prefer the exact providerMessageId; uid as legacy fallback). */
function refMessageId(ref: MessageRef): string {
  return ref.providerMessageId ?? String(ref.uid)
}

// ---------------------------------------------------------------------------
// Delta mapping
// ---------------------------------------------------------------------------

/** One folder's delta feed, reduced for the sync engine. */
export interface MappedFolderDelta {
  /** Full messages to upsert (added AND changed — server wins). */
  messages: NormalizedMessage[]
  /** Tombstoned message ids (@removed). */
  removedIds: string[]
  /** The deltaLink to persist for the next pass (null when absent). */
  nextDeltaLink: string | null
}

/**
 * Delta entries → ids. Removed entries (`@removed`) never carry message
 * state; everything else is re-fetched in full by the caller (the delta
 * feed's property set is not the full message — headers and attachments
 * need the single-message GET, the same trade the gmail engine makes).
 */
export function mapDeltaPageEntries(
  entries: (GraphMessage | { id: string; "@removed"?: unknown })[]
): { addedOrChangedIds: string[]; removedIds: string[] } {
  const addedOrChangedIds: string[] = []
  const removedIds: string[] = []
  for (const entry of entries) {
    if (!entry?.id) continue
    if ((entry as { "@removed"?: unknown })["@removed"] !== undefined) {
      removedIds.push(entry.id)
    } else {
      addedOrChangedIds.push(entry.id)
    }
  }
  return { addedOrChangedIds, removedIds }
}

// ---------------------------------------------------------------------------
// Outgoing message building
// ---------------------------------------------------------------------------

/** EmailAddress → Graph recipient; null when the entry has no address. */
export function addressToRecipient(
  address: EmailAddress
): GraphRecipient | null {
  if (!address.email) return null
  return {
    emailAddress: {
      address: address.email,
      ...(address.name ? { name: address.name } : {}),
    },
  }
}

function recipientList(
  addresses: EmailAddress[] | undefined
): GraphRecipient[] | undefined {
  const recipients = (addresses ?? [])
    .map(addressToRecipient)
    .filter((recipient): recipient is GraphRecipient => recipient !== null)
  return recipients.length > 0 ? recipients : undefined
}

/**
 * SendEmailInput → the structured Graph message (the sendMail shape).
 * Used by the client-level sendMail action; the provider's sendMessage
 * rides the raw-MIME draft path (see the module comment for why).
 */
export function graphMessageFromSendInput(input: SendEmailInput): Record<string, unknown> {
  const message: Record<string, unknown> = {
    subject: input.subject,
    toRecipients: recipientList(input.to),
    body: {
      contentType: input.htmlBody ? "html" : "text",
      content: input.htmlBody ?? input.textBody ?? "",
    },
  }
  const cc = recipientList(input.cc)
  if (cc) message.ccRecipients = cc
  const bcc = recipientList(input.bcc)
  if (bcc) message.bccRecipients = bcc
  if (input.attachments?.length) {
    message.attachments = input.attachments.map((attachment) => ({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: attachment.filename,
      contentType: attachment.mimeType ?? "application/octet-stream",
      contentBytes: attachment.contentBase64,
    }))
  }
  return message
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface MicrosoftGraphProviderDeps {
  /** Injectable fetch (tests); default is globalThis.fetch. */
  fetchImpl?: typeof fetch
  /** Injectable wait (tests record Retry-After backoff instead of sleeping). */
  delayImpl?: (ms: number) => Promise<void>
  /** Pre-resolved token envelope; when absent the encrypted
   * account.credentialsJson envelope is decrypted on first token use. */
  tokenEnvelope?: MicrosoftTokenEnvelope | null
}

/** The delta cursor map persisted per account (JSON-encoded): folder
 * path → the folder's stored deltaLink. A missing entry means the folder
 * has never been synced (initial pull). */
export type GraphDeltaCursorMap = Record<string, string>

/** Parse a stored cursor (accounts.gmail_history_id TEXT) or null. */
export function parseGraphDeltaCursor(cursor: string | null): GraphDeltaCursorMap {
  if (!cursor) return {}
  try {
    const parsed = JSON.parse(cursor) as unknown
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const map: GraphDeltaCursorMap = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") map[key] = value
      }
      return map
    }
  } catch {
    // A corrupt cursor forces the folder's initial pull — safe.
  }
  return {}
}

export interface FolderDeltaResult {
  messages: NormalizedMessage[]
  removedIds: string[]
  /** The deltaLink to persist; null when the feed ended without one. */
  nextDeltaLink: string | null
  /** True when the stored deltaLink was rejected (410/400) — the folder
   * needs a full re-pull and a fresh link. */
  needsFullSync: boolean
}

/**
 * Build the provider for one Microsoft account. Throws eagerly when the
 * account has no client id; the refresh-token check happens lazily on
 * first API call (decryption is async, the factory contract is sync).
 */
export function createMicrosoftGraphProvider(
  account: EmailAccount,
  credentials: ProviderCredentials,
  deps: MicrosoftGraphProviderDeps = {}
): EmailProvider & {
  /** Per-folder delta (the dedicated sync engine's seam, task 3.2). */
  syncFolderDelta(
    folder: string,
    deltaLink: string | null
  ): Promise<FolderDeltaResult>
} {
  // OAuth-only: the imap-style password is unused (same as gmail).
  void credentials.password

  if (!account.oauthClientId) {
    throw new Error(
      `Account ${account.id} (${account.email}) has no oauth_client_id configured`
    )
  }

  const envelope: Promise<MicrosoftTokenEnvelope | null> =
    deps.tokenEnvelope !== undefined
      ? Promise.resolve(deps.tokenEnvelope)
      : decryptCredentials<MicrosoftTokenEnvelope>(
          account.credentialsJson ?? null
        )

  // Entra rotates refresh tokens; re-seal the rotated envelope best
  // effort (a sealed write that fails leaves the in-memory token valid
  // for the session — the next refresh retries the write).
  const tokenSource = createMicrosoftTokenSource(
    account,
    envelope,
    deps.fetchImpl,
    {
      persist: async (rotated) => {
        try {
          const credentialsJson = await encryptCredentials(rotated)
          await updateCredentials(getExecutor(), account.id, credentialsJson)
        } catch {
          // No database binding (tests/dev) or transient write failure.
        }
      },
    }
  )
  const client = createGraphClient({
    accountId: account.id,
    getToken: (force) => tokenSource.getToken(force),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.delayImpl ? { delayImpl: deps.delayImpl } : {}),
  })

  // Lazily-resolved well-known folder ids for special-use detection
  // (addressable names are locale-independent; display names are not).
  // A mailbox missing a well-known folder (older on-prem targets) simply
  // contributes no role.
  let wellKnownIds: Map<string, string> | null = null
  async function resolveWellKnownIds(): Promise<Map<string, string>> {
    if (wellKnownIds) return wellKnownIds
    const resolved = await Promise.all(
      WELL_KNOWN_NAMES.map(async (name) => {
        try {
          const folder = await client.getWellKnownFolder(name)
          return [name, folder.id] as const
        } catch {
          return null
        }
      })
    )
    wellKnownIds = new Map(
      resolved.filter((entry): entry is readonly [string, string] => entry !== null)
    )
    return wellKnownIds
  }

  /**
   * The folder list with display-name-chain paths and special-use roles.
   * Each well-known folder is resolved once per provider instance; user
   * folders get "Parent/Child" paths from the parentFolderId chains.
   */
  async function listFolders(): Promise<EmailFolder[]> {
    const [listed, wellKnown] = await Promise.all([
      client.listFolders(),
      resolveWellKnownIds(),
    ])
    const byId = new Map(listed.map((folder) => [folder.id, folder]))
    const wellKnownNameById = new Map(
      [...wellKnown.entries()].map(([name, id]) => [id, name])
    )

    function pathOf(folder: GraphFolder): string {
      const segments: string[] = []
      let current: GraphFolder | undefined = folder
      const guard = new Set<string>()
      while (current && !guard.has(current.id)) {
        guard.add(current.id)
        segments.unshift(current.displayName ?? current.id)
        current = current.parentFolderId ? byId.get(current.parentFolderId) : undefined
      }
      return segments.join("/")
    }

    return listed
      .filter((folder) => folder.displayName)
      .map((folder) =>
        graphFolderToFolder(
          wellKnownNameById.get(folder.id) ?? null,
          pathOf(folder)
        )
      )
  }

  /**
   * Per-folder delta (task 3.2, the sync engine's seam). `deltaLink ===
   * null` starts the folder's INITIAL pull (every message); otherwise the
   * stored link is replayed and a rejection (410 Gone / 400 — the link is
   * expired or malformed) demands a full re-pull via needsFullSync. A pass
   * that exhausts MAX_DELTA_PAGES does NOT fail: it returns what it
   * accumulated plus the last nextLink as the continuation cursor.
   * `folder` is the folder PATH the engine keys its cursors by (resolved
   * to the Graph id through the same resolution the move actions use).
   */
  async function syncFolderDelta(
    folder: string,
    deltaLink: string | null
  ): Promise<FolderDeltaResult> {
    const removedIds: string[] = []
    const messages: NormalizedMessage[] = []

    let url: string | null = deltaLink ? validatedGraphLink(deltaLink) : null
    if (deltaLink && !url) {
      // A stored link that no longer parses: full re-pull.
      return { messages, removedIds, nextDeltaLink: null, needsFullSync: true }
    }
    if (!url) {
      // `folder` is the folder PATH (the engine's cursor key), a
      // well-known name, a labels-table id, or a raw Graph id. An explicit
      // $top keeps the initial pull's pages full (Graph's default page is
      // small enough to exhaust the page cap on large mailboxes).
      const folderId = await resolveFolderId(folder)
      url =
        `me/mailFolders/${encodeURIComponent(folderId)}/messages/delta` +
        `?$top=${DELTA_PAGE_SIZE}`
    }

    // The last nextLink seen before the pass ended; on page-cap exhaustion
    // it becomes the stored continuation cursor.
    let continuation: string | null = null
    try {
      for (let page = 0; page < MAX_DELTA_PAGES; page++) {
        const response = await client.messageDeltaPage(url)
        const entries = response.value ?? []
        const mapped = mapDeltaPageEntries(entries)
        removedIds.push(...mapped.removedIds)
        for (const id of mapped.addedOrChangedIds) {
          try {
            messages.push(mapGraphMessage(await client.getMessage(id)))
          } catch (error) {
            // Changed then deleted before the full fetch — skip.
            if (error instanceof GraphApiError && error.status === 404) continue
            throw error
          }
        }
        const delta = response["@odata.deltaLink"]
        if (delta) {
          return {
            messages,
            removedIds,
            nextDeltaLink: validatedGraphLink(delta),
            needsFullSync: false,
          }
        }
        const next = response["@odata.nextLink"]
        if (!next) {
          // No deltaLink and no nextLink: the feed ended without a cursor
          // (unusual) — the caller keeps the previous link.
          return { messages, removedIds, nextDeltaLink: null, needsFullSync: false }
        }
        continuation = validatedGraphLink(next)
        if (!continuation) {
          return { messages, removedIds, nextDeltaLink: null, needsFullSync: false }
        }
        url = continuation
      }
      // Page-cap exhaustion WITHOUT the feed converging: the accumulated
      // messages stand and the last nextLink is returned as the
      // continuation cursor, so the next pass RESUMES from where this one
      // stopped instead of restarting (or throwing the work away).
      return { messages, removedIds, nextDeltaLink: continuation, needsFullSync: false }
    } catch (error) {
      // 410 Gone (sync token expired) or a rejected link → full re-pull.
      if (error instanceof GraphApiError && (error.status === 410 || error.status === 400)) {
        return { messages: [], removedIds: [], nextDeltaLink: null, needsFullSync: true }
      }
      throw error
    }
  }

  /**
   * Interface-compliance delta sync: the cursor is the JSON
   * {folderPath → deltaLink} map. null starts a full sync; each mapped
   * folder's delta is applied and the fresh map returned as the cursor.
   * Deletions and newly created folders are not expressible in
   * DeltaSyncResult — the dedicated microsoft-sync engine (task 3.2)
   * handles them through syncFolderDelta directly.
   */
  async function deltaSync(cursor: string | null): Promise<DeltaSyncResult> {
    if (cursor === null || cursor === "") {
      return { messages: [], nextCursor: "", needsFullSync: true }
    }
    const stored = parseGraphDeltaCursor(cursor)
    const updated: GraphDeltaCursorMap = {}
    const messages: NormalizedMessage[] = []
    for (const [folderPath, link] of Object.entries(stored)) {
      const result = await syncFolderDelta(folderPath, link)
      if (result.needsFullSync) {
        return { messages: [], nextCursor: "", needsFullSync: true }
      }
      messages.push(...result.messages)
      if (result.nextDeltaLink) updated[folderPath] = result.nextDeltaLink
    }
    return {
      messages,
      nextCursor: JSON.stringify(updated),
      needsFullSync: false,
    }
  }

  /** Interface fetch surface: a folder's recent window ($top, newest first). */
  async function fetchMessages(
    folder: string,
    query: FetchQuery
  ): Promise<FetchMessagesResult> {
    if (query.last === undefined) {
      throw new Error(
        "fetchMessages on microsoft supports only {last} (a recent window)"
      )
    }
    const folderId = await resolveFolderId(folder)
    const page = await client.messageDeltaPage(
      `me/mailFolders/${encodeURIComponent(folderId)}/messages?$top=${query.last}&$orderBy=receivedDateTime desc`
    )
    const messages: NormalizedMessage[] = []
    for (const entry of page.value ?? []) {
      // Plain lists carry no tombstones, but the guard is free.
      if (!entry.id || (entry as { "@removed"?: unknown })["@removed"] !== undefined) {
        continue
      }
      messages.push(mapGraphMessage(await client.getMessage(entry.id)))
    }
    // Graph exposes no mailbox counters; ids are immutable (uidValidity 1).
    return {
      messages,
      folderStatus: {
        uidValidity: 1,
        uidNext: 0,
        exists: messages.length,
        unseen: 0,
      },
    }
  }

  async function fetchFlags(
    folder: string,
    query: FetchQuery
  ): Promise<MessageFlags[]> {
    if (query.last === undefined) {
      throw new Error("fetchFlags on microsoft supports only {last}")
    }
    const folderId = await resolveFolderId(folder)
    const page = await client.messageDeltaPage(
      `me/mailFolders/${encodeURIComponent(folderId)}/messages?$top=${query.last}&$orderBy=receivedDateTime desc&$select=id,isRead,flag`
    )
    const flags: MessageFlags[] = []
    for (const entry of page.value ?? []) {
      const message = entry as GraphMessage
      if (!message.id || (entry as { "@removed"?: unknown })["@removed"] !== undefined) {
        continue
      }
      flags.push({
        uid: 0,
        providerMessageId: message.id,
        flags: flagsForGraphMessage(message),
      })
    }
    return flags
  }

  /**
   * Resolve a destination folder value to a Graph folder id: a well-known
   * name ("deleteditems"), a stored path ("Inbox", "Work/Projects"), a
   * labels-table id ("folder-Work/Projects"), or a raw Graph id.
   */
  async function resolveFolderId(destination: string): Promise<string> {
    const lowered = destination.toLowerCase()
    // Well-known names address folders directly (also in URL paths).
    if (WELL_KNOWN_SPECIAL_USE[lowered]) return lowered
    const stripped = lowered.startsWith("folder-")
      ? lowered.slice("folder-".length)
      : lowered
    const [listed, wellKnown] = await Promise.all([
      client.listFolders(),
      resolveWellKnownIds(),
    ])
    const byId = new Map(listed.map((folder) => [folder.id, folder]))
    const wellKnownIdByName = new Map(
      [...wellKnown.entries()].map(([name, id]) => [id, name])
    )
    function pathOf(folder: GraphFolder): string {
      const segments: string[] = []
      let current: GraphFolder | undefined = folder
      const guard = new Set<string>()
      while (current && !guard.has(current.id)) {
        guard.add(current.id)
        segments.unshift(current.displayName ?? current.id)
        current = current.parentFolderId
          ? byId.get(current.parentFolderId)
          : undefined
      }
      return segments.join("/").toLowerCase()
    }
    for (const folder of listed) {
      if (!folder.displayName) continue
      const name = folder.displayName.toLowerCase()
      if (name === stripped || `folder-${name}` === lowered) return folder.id
      if (pathOf(folder) === stripped) return folder.id
      const wellKnownName = wellKnownIdByName.get(folder.id)
      if (wellKnownName && wellKnownName === stripped) return folder.id
    }
    // Pass-through: the caller may hold a raw Graph folder id.
    return destination
  }

  async function moveRefs(refs: MessageRef[], destinationId: string): Promise<void> {
    for (const ref of refs) {
      await client.moveMessage(refMessageId(ref), destinationId)
    }
  }

  return {
    accountId: account.id,
    type: "microsoft",

    listFolders,
    deltaSync,
    syncFolderDelta,
    fetchMessages,
    fetchFlags,

    async storeFlags(
      _folder: string,
      uidSet: string,
      flags: string[],
      add: boolean
    ): Promise<void> {
      // uidSet holds Graph message ids here (the engine passes the refs'
      // provider ids); numeric-only sets (legacy) are passed through.
      const patches = patchesForFlags(flags, add)
      for (const id of uidSet.split(",").map((part) => part.trim()).filter(Boolean)) {
        for (const patch of patches) {
          await client.updateMessage(id, patch)
        }
      }
    },

    async markRead(refs: MessageRef[], read: boolean): Promise<void> {
      for (const ref of refs) {
        await client.updateMessage(refMessageId(ref), { isRead: read })
      }
    },

    async markStarred(refs: MessageRef[], starred: boolean): Promise<void> {
      for (const ref of refs) {
        await client.updateMessage(refMessageId(ref), {
          flag: { flagStatus: starred ? "flagged" : "notFlagged" },
        })
      }
    },

    /** Graph has no server-side labels — local-only (design D3). */
    async addLabels(): Promise<void> {},

    /** Graph has no server-side labels — local-only (design D3). */
    async removeLabels(): Promise<void> {},

    /**
     * Archive = move to the archive well-known folder; a mailbox without
     * one falls back to Deleted Items (the reference engines' mapping).
     */
    async archive(refs: MessageRef[]): Promise<void> {
      for (const ref of refs) {
        const id = refMessageId(ref)
        try {
          await client.moveMessage(id, ARCHIVE)
        } catch (error) {
          if (error instanceof GraphApiError && error.status === 404) {
            await client.moveMessage(id, DELETED_ITEMS)
            continue
          }
          throw error
        }
      }
    },

    /** Trash = move to Deleted Items (recoverable). */
    async trash(refs: MessageRef[]): Promise<void> {
      await moveRefs(refs, DELETED_ITEMS)
    },

    async moveToFolder(
      refs: MessageRef[],
      destinationFolder: string
    ): Promise<void> {
      const destinationId = await resolveFolderId(destinationFolder)
      await moveRefs(refs, destinationId)
    },

    /**
     * Hard delete: move to Deleted Items, then DELETE the copy there
     * (Graph's purge semantics — the second DELETE on a Deleted Items
     * message is permanent).
     */
    async deleteForever(refs: MessageRef[]): Promise<void> {
      for (const ref of refs) {
        const id = refMessageId(ref)
        const moved = await client.moveMessage(id, DELETED_ITEMS)
        await client.deleteMessage(moved.id)
      }
    },

    /**
     * Raw source (design D6): GET /me/messages/{id}/$value — the complete
     * RFC 822 message. One request per call, nothing cached.
     */
    async getMessageSource(ref: MessageRef): Promise<string> {
      const source = await client.getMessageSource(refMessageId(ref))
      if (!source) {
        throw new Error(
          `Graph returned no raw source for message ${refMessageId(ref)}`
        )
      }
      return source
    },

    async sendMessage(input: SendEmailInput) {
      // The raw-MIME draft path preserves EVERY header the app's send
      // flow depends on (Message-ID dedupe, In-Reply-To/References
      // threading, frozen PGP/MIME) — see the module comment for the
      // sendMail trade-off. /send files the sent copy in Sent Items.
      const mime = input.pgpMime ?? buildMimeMessage(input).mime
      const draft = await client.createDraft()
      await client.setDraftMime(draft.id, mime)
      await client.sendDraft(draft.id)
      return { messageId: input.messageId ?? "" }
    },

    /**
     * Graph APPEND equivalent: an empty draft, the raw MIME value PUT,
     * then a move into the destination folder. The message keeps
     * isDraft=true (natural \\Draft semantics) unless the caller files it
     * elsewhere (sent-mail filing).
     */
    async appendMessage(
      folder: string,
      raw: Uint8Array,
      flags?: string[]
    ): Promise<void> {
      // Graph drafts are naturally \Draft; the \Seen keyword would need
      // a follow-up PATCH the callers never rely on.
      void flags
      const mime = new TextDecoder("utf-8").decode(raw)
      const draft = await client.createDraft()
      await client.setDraftMime(draft.id, mime)
      if (folder) {
        const destinationId = await resolveFolderId(folder)
        await client.moveMessage(draft.id, destinationId)
      }
    },

    async testConnection(): Promise<ConnectionTestResult> {
      try {
        const profile: GraphProfile = await client.getProfile()
        return {
          success: true,
          message: `Connected to Microsoft 365 as ${profile.mail ?? profile.userPrincipalName ?? account.email}`,
        }
      } catch (error) {
        // The Graph error text VERBATIM — never the token (design D2).
        const message = error instanceof Error ? error.message : String(error)
        return {
          success: false,
          message,
          authError: error instanceof ProviderAuthError,
        }
      }
    },
  }
}

/**
 * Register the Microsoft implementation in the provider factory. Called
 * from register-providers.ts (bootstrap-adjacent import) and by tests.
 */
export function registerMicrosoftGraphProvider(): void {
  registerProvider("microsoft", (account, credentials) =>
    createMicrosoftGraphProvider(account, credentials)
  )
}
