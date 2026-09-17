import type { SqlExecutor } from "../db/executor"
import type { ContactRef } from "../db/messages"
import { findLabelsBySpecialUse } from "../db/labels"
import { toEmailAccount, type AccountRow } from "../db/accounts"
import { invoke } from "@tauri-apps/api/core"
import {
  CredentialDecryptError,
  decryptCredentials,
} from "../crypto/credentials"
import {
  GmailApiError,
  createGmailClient,
  type GmailClient,
} from "../email/gmail-api"
import type { ImapFetchResult, ImapMessage, ImapParams } from "../email/invoke"
import {
  base64ToBytes,
  decomposeMimeMessage,
  stringToBase64Url,
} from "../email/mime-builder"
import type {
  EmailAddress,
  ProviderCredentials,
  ServerDraftRef,
} from "../email/types"
import { ProviderAuthError } from "../email/types"
import type { GmailTokenEnvelope } from "../email/token-manager"
import { createTokenSource } from "../email/token-manager"
import { getImapDraftsFolderOverride } from "../settings/preferences"
import type { DraftDeleteOperation, DraftUpsertOperation } from "./operation"
import { parseServerDraftRef, setDraftServerRef } from "../composer/drafts"

/**
 * The server-side half of draft mirroring (design D9, task 17.x): the
 * local draft is the source of truth, and the queue's `draft_upsert` /
 * `draft_delete` ops replay through this module against the account's
 * server Drafts. Like the prebuilt-MIME send (executeSendMime in
 * processor.ts), the per-account-type execution lives beside the queue —
 * the EmailProvider surface has no draft methods, and the ops need
 * more than a provider: they read and write the local draft row's
 * `server_draft_ref` mirror pointer (migration v5).
 *
 * Per account type:
 * - gmail: Drafts API (drafts.create/update/delete via gmail-api). The
 *   ref's draft id decides create vs update; a 404 on update (mirror
 *   deleted server-side) falls back to create with a fresh ref.
 * - imap: `imap_append` into the account's Drafts folder — resolved as
 *   the per-account settings override (`mail.imapDraftsFolder:<id>`,
 *   task 17.2), else the mapped drafts-role folder (labels special_use
 *   "drafts"), else the literal fallback folder "Drafts". imap_append
 *   returns nothing, so the appended copy's UID is recovered by fetching
 *   the folder's newest messages and matching the draft's stable
 *   Message-ID header (drafts.ts draftMessageId); that UID becomes the
 *   ref. A successful re-append removes the superseded copy
 *   (imap_delete_message = UID STORE +\Deleted + EXPUNGE).
 *
 * `draft_delete` deletes by the ref alone (gmail drafts.delete; imap
 * delete-message on folder+uid) — the local row is already gone at
 * replay; server-side "already gone" rejections count as applied.
 *
 * Test seams: the transports are injectable (fetchImpl for the Gmail
 * REST client, invokeImpl for the Rust imap commands) via the
 * processor's `draftMirrorForTest` option, so replay tests run the real
 * execution path against mocked wire calls.
 */

/** Folder name used when the account exposes no drafts-role mapping. */
export const IMAP_DRAFTS_FALLBACK_FOLDER = "Drafts"

/** Cap on the server drafts fetched at once (task 17.3) and on the
 * newest-messages window searched for an appended draft's UID. */
export const FETCH_DRAFTS_LIMIT = 50

/** Injectable transports for the draft ops (tests; production uses the
 * real fetch / Tauri invoke). */
export interface DraftMirrorDeps {
  fetchImpl?: typeof fetch
  invokeImpl?: (
    command: string,
    args: Record<string, unknown>
  ) => Promise<unknown>
}

/** One server draft pulled down by fetchServerDrafts (task 17.3), ready
 * to become a local_drafts row. */
export interface FetchedServerDraft {
  ref: ServerDraftRef
  /** RFC 5322 Message-ID header (angle brackets as stored), when present. */
  messageIdHeader?: string
  to: ContactRef[]
  cc: ContactRef[]
  bcc: ContactRef[]
  subject: string
  bodyHtml: string
  /** unix epoch seconds; 0 when the server gave no usable date. */
  date: number
}

// ---------------------------------------------------------------------------
// Account/transport construction (label-admin.ts / sendGmailRawMime pattern)
// ---------------------------------------------------------------------------

interface MirrorContext {
  account: AccountRow
  credentials: ProviderCredentials
}

/**
 * Load the account row and decrypt its credentials. Auth-shaped failures
 * throw ProviderAuthError so the processor's account-pause semantics
 * apply unchanged to draft ops.
 */
async function buildMirrorContext(
  executor: SqlExecutor,
  accountId: string
): Promise<MirrorContext> {
  const rows = await executor.select<AccountRow>(
    "SELECT * FROM accounts WHERE id = $1",
    [accountId]
  )
  const account = rows[0]
  if (!account) {
    throw new Error(`draft mirror: account ${accountId} no longer exists`)
  }
  if (account.status === "auth-error") {
    throw new ProviderAuthError(
      accountId,
      account.type,
      "account is in auth-error state; queued operations paused"
    )
  }
  let credentials: ProviderCredentials | null
  try {
    credentials = await decryptCredentials<ProviderCredentials>(
      account.credentials_json
    )
  } catch (error) {
    if (error instanceof CredentialDecryptError) {
      throw new ProviderAuthError(
        accountId,
        account.type,
        "stored credentials could not be decrypted"
      )
    }
    throw error
  }
  if (!credentials) {
    throw new ProviderAuthError(
      accountId,
      account.type,
      "account has no stored credentials; queued operations paused"
    )
  }
  return { account, credentials }
}

/** Gmail REST client over the account's decrypted OAuth envelope. */
async function gmailClientFor(
  account: AccountRow,
  deps: DraftMirrorDeps
): Promise<GmailClient> {
  if (!account.oauth_client_id) {
    throw new Error(
      `Account ${account.email} (${account.id}) has no oauth_client_id configured`
    )
  }
  const envelope = decryptCredentials<GmailTokenEnvelope>(
    account.credentials_json
  ).catch((error: unknown) => {
    if (error instanceof CredentialDecryptError) {
      throw new ProviderAuthError(
        account.id,
        "gmail",
        "stored credentials could not be decrypted"
      )
    }
    throw error
  })
  const tokenSource = createTokenSource(
    toEmailAccount(account),
    envelope,
    deps.fetchImpl
  )
  return createGmailClient({
    accountId: account.id,
    getToken: (force) => tokenSource.getToken(force),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  })
}

/** The account's IMAP connection params (label-admin's imapParamsOf). */
function imapParamsOf(
  account: AccountRow,
  credentials: ProviderCredentials
): ImapParams {
  if (!account.imap_host || !account.imap_port || !account.imap_security) {
    throw new ProviderAuthError(
      account.id,
      "imap",
      "imap account is missing server configuration"
    )
  }
  return {
    host: account.imap_host,
    port: account.imap_port,
    security: account.imap_security,
    username: account.email,
    password: credentials.password,
    acceptInvalidCerts: false,
  }
}

function invokerOf(deps: DraftMirrorDeps) {
  return (
    deps.invokeImpl ??
    (async (command: string, args: Record<string, unknown>) =>
      invoke(command, args))
  )
}

// ---------------------------------------------------------------------------
// Small MIME helpers (self-contained: the drafts we mirror/fetch are plain
// RFC 822 with the shape mime-builder emits)
// ---------------------------------------------------------------------------

/** One header of a message this app wrote: lowercased name → trimmed value. */
function storedHeader(mime: string, name: string): string | undefined {
  for (const line of mime.split(/\r\n/)) {
    if (line === "") return undefined // end of headers
    const colon = line.indexOf(":")
    if (colon !== -1 && line.slice(0, colon).trim().toLowerCase() === name) {
      return line.slice(colon + 1).trim()
    }
  }
  return undefined
}

/** base64url (Gmail wire encoding) → UTF-8 text. */
function base64UrlToText(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4)
  return new TextDecoder("utf-8").decode(base64ToBytes(padded))
}

/** `{name?, email?}` wire addresses → ContactRef (email required locally). */
function toContactRefs(addresses: EmailAddress[]): ContactRef[] {
  return addresses
    .filter((address): address is EmailAddress & { email: string } =>
      Boolean(address.email)
    )
    .map((address) => ({
      email: address.email,
      ...(address.name !== undefined ? { name: address.name } : {}),
    }))
}

function imapAddressRefs(addresses: ImapMessage["to"]): ContactRef[] {
  return toContactRefs(
    addresses.map((address) => ({
      name: address.name ?? undefined,
      email: address.email ?? undefined,
    }))
  )
}

/** Date header → unix seconds (0 when absent/unparseable). */
function dateHeaderSeconds(mime: string): number {
  const header = storedHeader(mime, "date")
  if (!header) return 0
  const parsed = Date.parse(header)
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000)
}

// ---------------------------------------------------------------------------
// IMAP drafts-folder resolution (task 17.2: override → mapped → fallback)
// ---------------------------------------------------------------------------

/**
 * Where this IMAP account's drafts live: the per-account settings
 * override wins, then the mapped drafts-role folder (labels special_use
 * "drafts", written by folder sync), then the literal fallback "Drafts"
 * (design risk note: "fall back to a folder named Drafts").
 */
export async function resolveImapDraftsFolder(
  executor: SqlExecutor,
  accountId: string
): Promise<string> {
  const override = await getImapDraftsFolderOverride(executor, accountId)
  if (override) return override
  const draftLabels = await findLabelsBySpecialUse(
    executor,
    accountId,
    "drafts"
  )
  const mapped = draftLabels.find((label) => label.imap_folder_name)
  if (mapped?.imap_folder_name) return mapped.imap_folder_name
  return IMAP_DRAFTS_FALLBACK_FOLDER
}

// ---------------------------------------------------------------------------
// Replay execution (the processor's dispatch targets)
// ---------------------------------------------------------------------------

/**
 * Replay a draft_upsert: mirror the frozen MIME to the account's server
 * Drafts and record the mirror pointer on the local row. A local row
 * discarded between enqueue and replay makes this a no-op (the delete
 * path owns the server copy through its own enqueued op).
 */
export async function executeDraftUpsert(
  executor: SqlExecutor,
  op: DraftUpsertOperation,
  deps: DraftMirrorDeps = {}
): Promise<void> {
  const rows = await executor.select<{
    server_draft_ref: string | null
  }>(
    "SELECT server_draft_ref FROM local_drafts WHERE id = $1 AND account_id = $2",
    [op.draftId, op.accountId]
  )
  if (rows.length === 0) return // discarded before replay — nothing to mirror

  const { account, credentials } = await buildMirrorContext(
    executor,
    op.accountId
  )
  if (account.type === "gmail") {
    await upsertGmailDraft(
      executor,
      account,
      rows[0].server_draft_ref,
      op,
      deps
    )
    return
  }
  await upsertImapDraft(
    executor,
    account,
    credentials,
    rows[0].server_draft_ref,
    op,
    deps
  )
}

/** Gmail Drafts API: update through the stored ref, create (and store the
 * fresh ref) when there is none or the server copy vanished (404). */
async function upsertGmailDraft(
  executor: SqlExecutor,
  account: AccountRow,
  refJson: string | null,
  op: DraftUpsertOperation,
  deps: DraftMirrorDeps
): Promise<void> {
  const client = await gmailClientFor(account, deps)
  const raw = stringToBase64Url(op.mime)
  const existing = parseServerDraftRef(refJson)
  if (existing?.provider === "gmail") {
    try {
      await client.updateDraft(existing.draftId, raw)
      return
    } catch (error) {
      // Mirror deleted server-side while we held its id — recreate it.
      if (!(error instanceof GmailApiError && error.status === 404)) {
        throw error
      }
    }
  }
  const created = await client.createDraft(raw)
  await setDraftServerRef(executor, op.draftId, {
    provider: "gmail",
    draftId: created.id,
  })
}

/**
 * IMAP APPEND into the resolved drafts folder, then locate the appended
 * copy (stable Message-ID match over the folder's newest messages) to
 * store its UID as the ref. The previously mirrored copy — now superseded
 * by this append — is removed, so a draft keeps exactly one server copy.
 */
async function upsertImapDraft(
  executor: SqlExecutor,
  account: AccountRow,
  credentials: ProviderCredentials,
  refJson: string | null,
  op: DraftUpsertOperation,
  deps: DraftMirrorDeps
): Promise<void> {
  const invoke = invokerOf(deps)
  const params = imapParamsOf(account, credentials)
  const previousRef = parseServerDraftRef(refJson)
  const folder = await resolveImapDraftsFolder(executor, op.accountId)

  await invoke("imap_append", {
    params,
    folder,
    message: Array.from(new TextEncoder().encode(op.mime)),
    flags: ["\\Draft"],
  })

  // imap_append returns no UID — find our copy among the newest messages
  // by the draft's stable Message-ID header.
  const messageId = storedHeader(op.mime, "message-id")
  let appendedUid: number | null = null
  if (messageId) {
    const result = (await invoke("imap_fetch_messages", {
      params,
      folder,
      uidSet: "",
      last: FETCH_DRAFTS_LIMIT,
    })) as ImapFetchResult
    const match = result.messages.find(
      (message) => (message.messageId ?? "").trim() === messageId
    )
    if (match) appendedUid = match.uid
  }

  if (appendedUid !== null) {
    await setDraftServerRef(executor, op.draftId, {
      provider: "imap",
      folder,
      uid: appendedUid,
    })
  } else if (previousRef?.provider === "imap") {
    // Lookup failed (server lag, header rewrite): keep the stale ref so
    // the delete path can still address SOME copy; the next autosave
    // retries. The just-appended duplicate is accepted (documented
    // last-write-wins trade-off).
    return
  }

  // Remove the superseded copy from the previous autosave.
  if (
    previousRef?.provider === "imap" &&
    (appendedUid === null ||
      previousRef.folder !== folder ||
      previousRef.uid !== appendedUid)
  ) {
    await invoke("imap_delete_message", {
      params,
      folder: previousRef.folder,
      uidSet: String(previousRef.uid),
    })
  }
}

/**
 * Replay a draft_delete: remove the server copy the ref names. "Already
 * gone" rejections count as applied (idempotent replay).
 */
export async function executeDraftDelete(
  executor: SqlExecutor,
  op: DraftDeleteOperation,
  deps: DraftMirrorDeps = {}
): Promise<void> {
  const { account, credentials } = await buildMirrorContext(
    executor,
    op.accountId
  )
  if (op.ref.provider === "gmail") {
    const client = await gmailClientFor(account, deps)
    try {
      await client.deleteDraft(op.ref.draftId)
    } catch (error) {
      if (!(error instanceof GmailApiError && error.status === 404)) {
        throw error
      }
    }
    return
  }
  const invoke = invokerOf(deps)
  try {
    await invoke("imap_delete_message", {
      params: imapParamsOf(account, credentials),
      folder: op.ref.folder,
      uidSet: String(op.ref.uid),
    })
  } catch (error) {
    if (!isNotFoundError(error)) throw error
  }
}

/** IMAP "NONEXISTENT" / plain-text equivalent — the copy is already gone. */
function isNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /NONEXISTENT|does not exist/i.test(message)
}

// ---------------------------------------------------------------------------
// Server-draft fetch (task 17.3: drafts authored elsewhere, on connect)
// ---------------------------------------------------------------------------

/**
 * Fetch the account's latest server drafts, decomposed into local-draft
 * fields. gmail: drafts.list (capped at FETCH_DRAFTS_LIMIT) then
 * drafts.get format=raw so ONE code path — decomposeMimeMessage over the
 * raw MIME — serves both providers. imap: a fetch over the resolved
 * drafts folder (the Rust side already parsed the fields). Throws on
 * transport/auth failures — the caller decides whether a connect flow
 * tolerates that.
 */
export async function fetchServerDrafts(
  executor: SqlExecutor,
  accountId: string,
  deps: DraftMirrorDeps = {}
): Promise<FetchedServerDraft[]> {
  const { account, credentials } = await buildMirrorContext(executor, accountId)

  if (account.type === "gmail") {
    const client = await gmailClientFor(account, deps)
    const page = await client.listDrafts({ maxResults: FETCH_DRAFTS_LIMIT })
    const fetched: FetchedServerDraft[] = []
    for (const draft of page.drafts ?? []) {
      const full = await client.getDraft(draft.id, "raw")
      const raw = full.message?.raw
      if (!raw) continue
      const mime = base64UrlToText(raw)
      const decomposed = decomposeMimeMessage(mime)
      fetched.push({
        ref: { provider: "gmail", draftId: draft.id },
        messageIdHeader: storedHeader(mime, "message-id"),
        to: toContactRefs(decomposed.to),
        cc: toContactRefs(decomposed.cc),
        bcc: toContactRefs(decomposed.bcc),
        subject: decomposed.subject ?? "",
        bodyHtml: decomposed.htmlBody ?? "",
        date: dateHeaderSeconds(mime),
      })
    }
    return fetched
  }

  const invoke = invokerOf(deps)
  const params = imapParamsOf(account, credentials)
  const folder = await resolveImapDraftsFolder(executor, accountId)
  const result = (await invoke("imap_fetch_messages", {
    params,
    folder,
    uidSet: "",
    last: FETCH_DRAFTS_LIMIT,
  })) as ImapFetchResult
  return result.messages.map((message) => ({
    ref: { provider: "imap", folder, uid: message.uid },
    messageIdHeader: message.messageId ?? undefined,
    to: imapAddressRefs(message.to),
    cc: imapAddressRefs(message.cc),
    bcc: imapAddressRefs(message.bcc),
    subject: message.subject ?? "",
    bodyHtml: message.htmlBody ?? "",
    date: message.date,
  }))
}
