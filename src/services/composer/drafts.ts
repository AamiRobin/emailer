import type { SqlExecutor } from "../db/executor"
import type { ContactRef } from "../db/messages"
import { parseContacts, serializeContacts } from "../db/messages"
import { getAccount } from "../db/accounts"
import { deleteDraftAttachmentBytes } from "./draft-attachments"
import { buildMimeMessage } from "../email/mime-builder"
import type { ServerDraftRef } from "../email/types"
import { enqueueDraftDelete, enqueueDraftUpsert } from "../queue/operation"

/**
 * Local drafts service (task 8.6): CRUD over the `local_drafts` table —
 * the persistence half of composer auto-save. Each row is one composer
 * snapshot keyed per account by an app-generated `draft_key`.
 *
 * Server mirroring (design D9, task 17.x): the LOCAL draft is the source
 * of truth; a server copy (gmail Drafts API / imap APPEND) is a
 * last-write-wins mirror, never merged back. The mirror pointer lives on
 * the row (`server_draft_ref`, migration v5 — a JSON ServerDraftRef).
 * Wiring:
 *   - each autosave enqueues a `draft_upsert` (see
 *     enqueueDraftMirrorUpsert, called by use-draft-autosave) — the queue
 *     executor creates or updates the server copy through the ref;
 *   - sending or discarding routes through deleteDraft/deleteDraftByKey,
 *     which enqueue a `draft_delete` when a mirror is known to exist
 *     ("sending deletes the server draft");
 *   - drafts fetched from the server (task 17.3) come in through
 *     saveServerDraft with their ref set, so discarding them works.
 * Known trade-off: a draft discarded while its first mirror op is still
 * queued offline cannot name the server copy — the mirror op lands an
 * orphan draft that the 17.3 fetch later surfaces in Drafts again, where
 * deleting it works.
 *
 * ── Integration recipe for the composer (8.6 UI half) ────────────────
 * The autosave hook below wraps this module; the composer only needs:
 *
 *   1. Composer OPEN (new mail): `const draftKey = crypto.randomUUID()`
 *      once per open composer instance; pass it to useDraftAutosave.
 *   2. Composer OPEN (resume from Drafts): the Drafts folder lists via
 *      `listDrafts(getExecutor(), accountId)`; selecting a row calls
 *      `getDraft(getExecutor(), row.id)` and prefills the composer with
 *      `{to, cc, bcc, subject, bodyHtml}` plus its `draftKey` (so
 *      autosave keeps updating the same row). When `inReplyTo` or
 *      `threadId` is present the composer must re-enter reply mode with
 *      those values (inReplyTo is the message-id header of the message
 *      being replied to; threadId its local thread).
 *   3. While open: `useDraftAutosave(...)` (see use-draft-autosave.ts) —
 *      one line; it debounces 3s, calls saveDraft and enqueues the
 *      server-mirror upsert for you.
 *   4. SEND SUCCESS: `await deleteDraft(getExecutor(), draftId)` — the
 *      id returned by the hook's saves / getDraft (this also enqueues the
 *      server-draft delete). Also call 8.7's recordContactInteraction
 *      for the recipient addresses.
 *   5. CONFIRMED DISCARD: `await deleteDraft(getExecutor(), draftId)` or
 *      deleteDraftByKey — the server mirror is deleted with it.
 *      Discard of a non-empty draft requires confirmation first —
 *      `isDraftEmpty(draft)` implements the same emptiness rule the
 *      autosave uses (no recipients, subject, body, or attachments).
 *   6. Composer closed without discarding: nothing to do — the last
 *      autosave snapshot stays in Drafts (and on the server).
 *
 * DraftInput mirrors the composer store's draft fields 1:1 so saving is
 * a plain copy: {to, cc, bcc} serialize via the same serializeContacts
 * JSON shape ({name?, email}) the messages table uses (the store's
 * `Recipient` is structurally identical to ContactRef); attachments are
 * {filename, size} descriptors (content lives with the composer — the
 * server mirror therefore carries headers + body, not attachment bytes).
 * Field mapping from useComposerStore.getState(): to/cc/bcc → to/cc/bcc,
 * subject → subject, html → bodyHtml, mode.kind === "reply" &&
 * mode.inReplyTo → inReplyTo, mode.sourceThreadId → threadId. To resume
 * a reply draft: openWith({kind: "reply", replyAll: false, inReplyTo,
 * sourceThreadId, …}, accountId) then set the fields.
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor.
 */

/** Attachment descriptor persisted with a draft snapshot. */
export interface DraftAttachment {
  filename: string
  size: number
}

/** Full composer state snapshot — mirrors the composer store's fields. */
export interface DraftInput {
  to: ContactRef[]
  cc: ContactRef[]
  bcc: ContactRef[]
  subject: string
  bodyHtml: string
  attachments?: DraftAttachment[]
  /** message-id header of the message being replied to */
  inReplyTo?: string
  /** local thread of the message being replied to / forwarded */
  threadId?: string
}

export interface SaveDraftArgs {
  accountId: string
  draft: DraftInput
  /**
   * Stable key identifying one open composer instance (crypto.randomUUID()
   * at open; the row's draft_key when resuming). Present → the save is an
   * upsert of that composer's row; absent → each call inserts a new row.
   */
  draftKey?: string
}

export interface SavedDraft {
  id: string
  draftKey: string | null
  createdAt: number
  updatedAt: number
}

/** Fully parsed draft, ready to prefill a composer. */
export interface DraftRecord {
  id: string
  accountId: string
  draftKey: string | null
  to: ContactRef[]
  cc: ContactRef[]
  bcc: ContactRef[]
  subject: string
  bodyHtml: string
  attachments: DraftAttachment[]
  inReplyTo: string | null
  threadId: string | null
  /**
   * The server mirror pointer (migration v5), or null when the draft has
   * never been mirrored. Set by the queue's draft executor after a
   * create/append, and by saveServerDraft for fetched drafts.
   */
  serverDraftRef: ServerDraftRef | null
  createdAt: number
  updatedAt: number
}

/** Raw local_drafts row as it comes out of the executor. */
interface DraftRow {
  id: string
  account_id: string
  draft_key: string | null
  subject: string | null
  to_json: string | null
  cc_json: string | null
  bcc_json: string | null
  body_html: string | null
  attachments_json: string | null
  in_reply_to: string | null
  thread_id: string | null
  server_draft_ref: string | null
  created_at: number
  updated_at: number
}

/** ServerDraftRef → the JSON stored in server_draft_ref. */
export function serializeServerDraftRef(ref: ServerDraftRef): string {
  return JSON.stringify(ref)
}

/**
 * The stored JSON → ServerDraftRef. Tolerant like every *_json column:
 * corrupt or legacy values read as "not mirrored" (the next autosave
 * creates a fresh mirror) instead of throwing.
 */
export function parseServerDraftRef(
  json: string | null | undefined
): ServerDraftRef | null {
  if (!json) return null
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed !== "object" || parsed === null) return null
    const candidate = parsed as { provider?: unknown }
    if (candidate.provider === "gmail") {
      const ref = parsed as { draftId?: unknown }
      return typeof ref.draftId === "string" && ref.draftId !== ""
        ? { provider: "gmail", draftId: ref.draftId }
        : null
    }
    if (candidate.provider === "imap") {
      const ref = parsed as { folder?: unknown; uid?: unknown }
      return typeof ref.folder === "string" &&
        ref.folder !== "" &&
        typeof ref.uid === "number" &&
        Number.isFinite(ref.uid)
        ? { provider: "imap", folder: ref.folder, uid: ref.uid }
        : null
    }
    return null
  } catch {
    return null
  }
}

/**
 * The stable Message-ID header stamped into a draft's server mirror:
 * derived from the local row id so every autosave's MIME is recognizable
 * as the SAME draft — the imap executor matches the appended copy by it
 * (imap_append returns no UID) and the fetch-on-connect dedupe skips our
 * own mirrors by it.
 */
export function draftMessageId(draftId: string): string {
  return `<draft-${draftId}@emailer.local>`
}

/** Empty/undefined attachment lists persist as NULL, like the *_json cols. */
function serializeAttachments(
  attachments: DraftAttachment[] | undefined
): string | null {
  return attachments && attachments.length > 0
    ? JSON.stringify(attachments)
    : null
}

/** Tolerant parse of attachments_json; corrupt or NULL values yield []. */
function parseAttachments(json: string | null | undefined): DraftAttachment[] {
  if (!json) return []
  try {
    const parsed: unknown = JSON.parse(json)
    return Array.isArray(parsed) ? (parsed as DraftAttachment[]) : []
  } catch {
    return []
  }
}

function toRecord(row: DraftRow): DraftRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    draftKey: row.draft_key,
    to: parseContacts(row.to_json),
    cc: parseContacts(row.cc_json),
    bcc: parseContacts(row.bcc_json),
    subject: row.subject ?? "",
    bodyHtml: row.body_html ?? "",
    attachments: parseAttachments(row.attachments_json),
    inReplyTo: row.in_reply_to,
    threadId: row.thread_id,
    serverDraftRef: parseServerDraftRef(row.server_draft_ref),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Whether a draft snapshot carries no content at all — the emptiness rule
 * shared by autosave (never persist an empty draft) and the composer's
 * discard confirmation (confirm only when non-empty). Attachments count
 * as content so an attachment-only draft is never silently lost.
 */
export function isDraftEmpty(draft: DraftInput): boolean {
  return (
    draft.to.length === 0 &&
    draft.cc.length === 0 &&
    draft.bcc.length === 0 &&
    draft.subject.trim() === "" &&
    draft.bodyHtml.trim() === "" &&
    (draft.attachments?.length ?? 0) === 0
  )
}

/**
 * Insert-or-update one composer snapshot. With a draftKey, the existing
 * row for (account_id, draft_key) is updated in place — id, created_at
 * and draft_key stay stable, every content column is overwritten with the
 * snapshot, updated_at moves to now. Without one, a fresh row is always
 * inserted (autosave always passes a key).
 */
export async function saveDraft(
  executor: SqlExecutor,
  args: SaveDraftArgs
): Promise<SavedDraft> {
  const { accountId, draft, draftKey } = args
  // one timestamp per save; unix seconds like every schema timestamp
  const now = Math.floor(Date.now() / 1000)
  if (draftKey) {
    const existing = await executor.select<Pick<DraftRow, "id" | "created_at">>(
      `SELECT id, created_at FROM local_drafts
       WHERE account_id = $1 AND draft_key = $2 LIMIT 1`,
      [accountId, draftKey]
    )
    const row = existing[0]
    if (row) {
      await executor.execute(
        `UPDATE local_drafts SET
           subject = $1, to_json = $2, cc_json = $3, bcc_json = $4,
           body_html = $5, attachments_json = $6, in_reply_to = $7,
           thread_id = $8, updated_at = $9
         WHERE id = $10`,
        [
          draft.subject,
          serializeContacts(draft.to),
          serializeContacts(draft.cc),
          serializeContacts(draft.bcc),
          draft.bodyHtml,
          serializeAttachments(draft.attachments),
          draft.inReplyTo ?? null,
          draft.threadId ?? null,
          now,
          row.id,
        ]
      )
      return {
        id: row.id,
        draftKey,
        createdAt: row.created_at,
        updatedAt: now,
      }
    }
  }

  const id = crypto.randomUUID()
  await executor.execute(
    `INSERT INTO local_drafts (
       id, account_id, draft_key, subject, to_json, cc_json, bcc_json,
       body_html, attachments_json, in_reply_to, thread_id,
       created_at, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
     )`,
    [
      id,
      accountId,
      draftKey ?? null,
      draft.subject,
      serializeContacts(draft.to),
      serializeContacts(draft.cc),
      serializeContacts(draft.bcc),
      draft.bodyHtml,
      serializeAttachments(draft.attachments),
      draft.inReplyTo ?? null,
      draft.threadId ?? null,
      now,
      now,
    ]
  )
  return { id, draftKey: draftKey ?? null, createdAt: now, updatedAt: now }
}

/**
 * Drafts-folder listing for an account, newest edit first. rowid DESC
 * breaks same-second updated_at ties deterministically (later rows first).
 */
export async function listDrafts(
  executor: SqlExecutor,
  accountId: string
): Promise<DraftRecord[]> {
  const rows = await executor.select<DraftRow>(
    `SELECT * FROM local_drafts WHERE account_id = $1
     ORDER BY updated_at DESC, rowid DESC`,
    [accountId]
  )
  return rows.map(toRecord)
}

/** One draft by id (parsed), or null when missing. */
export async function getDraft(
  executor: SqlExecutor,
  id: string
): Promise<DraftRecord | null> {
  const rows = await executor.select<DraftRow>(
    "SELECT * FROM local_drafts WHERE id = $1",
    [id]
  )
  return rows[0] ? toRecord(rows[0]) : null
}

/**
 * One draft by its composer instance key (batch C2), or null when missing.
 * The composer pop-out addresses the row by key: the main window persists
 * the snapshot and hands ONLY the key to the new window (its label), which
 * resumes through here — the same join the resume path uses, minus the row
 * id the popout never sees.
 */
export async function getDraftByKey(
  executor: SqlExecutor,
  draftKey: string
): Promise<DraftRecord | null> {
  if (!draftKey) return null
  const rows = await executor.select<DraftRow>(
    "SELECT * FROM local_drafts WHERE draft_key = $1 ORDER BY rowid DESC LIMIT 1",
    [draftKey]
  )
  return rows[0] ? toRecord(rows[0]) : null
}

/**
 * Remove a draft (send success / confirmed discard). When the row holds a
 * server mirror, the matching `draft_delete` op is enqueued FIRST (design
 * D9: "sending deletes the server draft" — FIFO lands it after any queued
 * send), then the local row is removed.
 */
export async function deleteDraft(
  executor: SqlExecutor,
  id: string
): Promise<{ rowsAffected: number }> {
  const rows = await executor.select<{
    account_id: string
    draft_key: string | null
    server_draft_ref: string | null
  }>(
    "SELECT account_id, draft_key, server_draft_ref FROM local_drafts WHERE id = $1",
    [id]
  )
  const row = rows[0]
  if (row) {
    await enqueueServerDraftDelete(
      executor,
      row.account_id,
      row.server_draft_ref
    )
    // The persisted attachment bytes go with the draft (batch C1, fix 1) —
    // sending or discarding must leave no orphan payload rows behind.
    if (row.draft_key) {
      await deleteDraftAttachmentBytes(executor, row.account_id, row.draft_key)
    }
  }
  return executor.execute("DELETE FROM local_drafts WHERE id = $1", [id])
}

/**
 * Remove by composer key — used when the composer knows its draftKey but
 * not (yet) the row id. No-op when the key is blank or unknown. Mirrors
 * are deleted like deleteDraft (usually at most one row per key).
 */
export async function deleteDraftByKey(
  executor: SqlExecutor,
  accountId: string,
  draftKey: string
): Promise<{ rowsAffected: number }> {
  if (!draftKey) return { rowsAffected: 0 }
  const rows = await executor.select<{
    id: string
    server_draft_ref: string | null
  }>(
    `SELECT id, server_draft_ref FROM local_drafts
     WHERE account_id = $1 AND draft_key = $2`,
    [accountId, draftKey]
  )
  for (const row of rows) {
    await enqueueServerDraftDelete(executor, accountId, row.server_draft_ref)
  }
  await deleteDraftAttachmentBytes(executor, accountId, draftKey)
  return executor.execute(
    "DELETE FROM local_drafts WHERE account_id = $1 AND draft_key = $2",
    [accountId, draftKey]
  )
}

/** Enqueue the mirror delete when (and only when) a ref exists — a null
 * ref cannot name a server copy (see the module-comment trade-off). */
async function enqueueServerDraftDelete(
  executor: SqlExecutor,
  accountId: string,
  refJson: string | null
): Promise<void> {
  const ref = parseServerDraftRef(refJson)
  if (ref) {
    await enqueueDraftDelete(executor, { accountId, ref })
  }
}

// ---------------------------------------------------------------------------
// Server mirroring (design D9, task 17.x)
// ---------------------------------------------------------------------------

/**
 * Record (or clear) the draft's server mirror pointer. Called by the
 * queue's draft executor after a server create/append — NOT by the save
 * path, so an autosave never clobbers the pointer with stale state.
 */
export async function setDraftServerRef(
  executor: SqlExecutor,
  id: string,
  ref: ServerDraftRef | null
): Promise<void> {
  await executor.execute(
    "UPDATE local_drafts SET server_draft_ref = $1 WHERE id = $2",
    [ref ? serializeServerDraftRef(ref) : null, id]
  )
}

/**
 * The one autosave-side wiring point (used by use-draft-autosave): after
 * the local save committed, build the snapshot's MIME — From is the
 * account identity, Message-ID is the draft's stable draftMessageId — and
 * enqueue the `draft_upsert` that the queue replays against the server
 * Drafts. Local-first: a failed enqueue is swallowed (warned) so the
 * local save outcome is untouched; the next autosave re-mirrors.
 *
 * Fire-and-forget from the caller's perspective — awaiting it here only
 * orders the FIFO enqueue with the save that produced the content.
 */
export async function enqueueDraftMirrorUpsert(
  executor: SqlExecutor,
  accountId: string,
  saved: Pick<SavedDraft, "id">,
  draft: DraftInput
): Promise<void> {
  try {
    const account = await getAccount(executor, accountId)
    if (!account) return // account removed mid-compose: nothing to mirror
    const { mime } = buildMimeMessage({
      from: {
        email: account.email,
        ...(account.display_name ? { name: account.display_name } : {}),
      },
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      htmlBody: draft.bodyHtml,
      messageId: draftMessageId(saved.id),
    })
    await enqueueDraftUpsert(executor, {
      accountId,
      draftId: saved.id,
      mime,
    })
  } catch (error) {
    console.warn("[drafts] server-draft mirror enqueue failed", error)
  }
}

// ---------------------------------------------------------------------------
// Fetched server drafts (task 17.3)
// ---------------------------------------------------------------------------

/** The composer-shaped content of a server draft fetched on connect. */
export interface ServerDraftFields {
  to: ContactRef[]
  cc: ContactRef[]
  bcc: ContactRef[]
  subject: string
  bodyHtml: string
}

/**
 * Insert-or-update a draft row fetched from the server (task 17.3), keyed
 * per account by `draftKey` (fetch-drafts.ts derives it from the server
 * Message-ID) so a RE-fetch updates in place instead of duplicating —
 * the same upsert semantics saveDraft gives composer keys. The server ref
 * is stored with the row, so discarding a fetched draft deletes the
 * server copy. Deliberately enqueues NO mirror op: the copy came FROM the
 * server.
 */
export async function saveServerDraft(
  executor: SqlExecutor,
  args: {
    accountId: string
    draftKey: string
    ref: ServerDraftRef
    fields: ServerDraftFields
  }
): Promise<{ id: string; created: boolean }> {
  const { accountId, draftKey, ref, fields } = args
  const now = Math.floor(Date.now() / 1000)
  const existing = await executor.select<Pick<DraftRow, "id">>(
    `SELECT id FROM local_drafts
     WHERE account_id = $1 AND draft_key = $2 LIMIT 1`,
    [accountId, draftKey]
  )
  const row = existing[0]
  if (row) {
    await executor.execute(
      `UPDATE local_drafts SET
         subject = $1, to_json = $2, cc_json = $3, bcc_json = $4,
         body_html = $5, server_draft_ref = $6, updated_at = $7
       WHERE id = $8`,
      [
        fields.subject,
        serializeContacts(fields.to),
        serializeContacts(fields.cc),
        serializeContacts(fields.bcc),
        fields.bodyHtml,
        serializeServerDraftRef(ref),
        now,
        row.id,
      ]
    )
    return { id: row.id, created: false }
  }
  const id = crypto.randomUUID()
  await executor.execute(
    `INSERT INTO local_drafts (
       id, account_id, draft_key, subject, to_json, cc_json, bcc_json,
       body_html, server_draft_ref, created_at, updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id,
      accountId,
      draftKey,
      fields.subject,
      serializeContacts(fields.to),
      serializeContacts(fields.cc),
      serializeContacts(fields.bcc),
      fields.bodyHtml,
      serializeServerDraftRef(ref),
      now,
      now,
    ]
  )
  return { id, created: true }
}
