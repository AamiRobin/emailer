import type { SqlExecutor } from "../db/executor"
import type { ContactRef } from "../db/messages"
import { parseContacts, serializeContacts } from "../db/messages"

/**
 * Local drafts service (task 8.6): CRUD over the `local_drafts` table —
 * the persistence half of composer auto-save. Drafts are local-only in
 * this change (no server draft sync); each row is one composer snapshot
 * keyed per account by an app-generated `draft_key`.
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
 *      one line; it debounces 3s and calls saveDraft for you.
 *   4. SEND SUCCESS: `await deleteDraft(getExecutor(), draftId)` — the
 *      id returned by the hook's saves / getDraft. Also call 8.7's
 *      recordContactInteraction for the recipient addresses.
 *   5. CONFIRMED DISCARD: `await deleteDraft(getExecutor(), draftId)`.
 *      Discard of a non-empty draft requires confirmation first —
 *      `isDraftEmpty(draft)` implements the same emptiness rule the
 *      autosave uses (no recipients, subject, body, or attachments).
 *   6. Composer closed without discarding: nothing to do — the last
 *      autosave snapshot stays in Drafts.
 *
 * DraftInput mirrors the composer store's draft fields 1:1 so saving is
 * a plain copy: {to, cc, bcc} serialize via the same serializeContacts
 * JSON shape ({name?, email}) the messages table uses (the store's
 * `Recipient` is structurally identical to ContactRef); attachments are
 * {filename, size} descriptors (content lives with the composer). Field
 * mapping from useComposerStore.getState(): to/cc/bcc → to/cc/bcc,
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
  created_at: number
  updated_at: number
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

/** Remove a draft (send success / confirmed discard). */
export async function deleteDraft(
  executor: SqlExecutor,
  id: string
): Promise<{ rowsAffected: number }> {
  return executor.execute("DELETE FROM local_drafts WHERE id = $1", [id])
}

/**
 * Remove by composer key — used when the composer knows its draftKey but
 * not (yet) the row id. No-op when the key is blank or unknown.
 */
export async function deleteDraftByKey(
  executor: SqlExecutor,
  accountId: string,
  draftKey: string
): Promise<{ rowsAffected: number }> {
  if (!draftKey) return { rowsAffected: 0 }
  return executor.execute(
    "DELETE FROM local_drafts WHERE account_id = $1 AND draft_key = $2",
    [accountId, draftKey]
  )
}
