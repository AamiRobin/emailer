import type { SqlExecutor } from "../db/executor"
import {
  getDraft,
  saveServerDraft,
  setDraftServerRef,
  type ServerDraftFields,
} from "../composer/drafts"
import type { ServerDraftRef } from "../email/types"
import {
  fetchServerDrafts,
  type DraftMirrorDeps,
  type FetchedServerDraft,
} from "../queue/draft-mirror"

/**
 * Drafts-elsewhere fetch on account connect (task 17.3, design D9): pull
 * the account's latest server drafts into local_drafts so they appear in
 * the existing Drafts view (thread-list-store lists local_drafts rows for
 * the drafts-role view — no UI change needed).
 *
 * One-way by design: D9 makes the LOCAL draft the source of truth and
 * explicitly excludes bidirectional merge — fetched drafts are inserted/
 * refreshed as new local rows, and nothing is pushed back (saveServerDraft
 * enqueues no mirror op).
 *
 * Dedupe:
 * - Drafts authored elsewhere carry a Message-ID header — the local row
 *   is keyed `server:<bare-message-id>`, so a RE-connect updates the same
 *   row instead of duplicating it.
 * - Our OWN mirrors carry the deterministic draftMessageId derived from
 *   the local row id; when that row still exists we skip the content
 *   entirely (local wins) and only heal a missing/stale server_draft_ref.
 * - Without any Message-ID (rare), the key falls back to the ref identity.
 *
 * The fetch is capped at the draft-mirror's FETCH_DRAFTS_LIMIT (50)
 * newest drafts — enough for the "authored elsewhere on my phone this
 * morning" scenario; it is a connect-time convenience, not a full-sync.
 *
 * Never throws for individual drafts; transport failures propagate to the
 * caller, which treats the whole fetch as best-effort (a connect must not
 * fail because drafts could not be read).
 */

export interface FetchDraftsSummary {
  /** Server drafts seen (before dedupe). */
  fetched: number
  /** New local_drafts rows created. */
  created: number
  /** Existing rows refreshed (or refs healed). */
  updated: number
  /** Own mirrors skipped (local content kept). */
  skipped: number
}

/** The local row id when the Message-ID is one of our own mirrors. */
export function ownMirrorDraftId(
  messageIdHeader: string | undefined
): string | null {
  const match =
    /^<draft-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@emailer\.local>$/i.exec(
      (messageIdHeader ?? "").trim()
    )
  return match ? match[1] : null
}

/** Draft-key for a fetched draft: stable across reconnects. */
export function serverDraftKey(draft: {
  messageIdHeader?: string
  ref: ServerDraftRef
}): string {
  const bare = (draft.messageIdHeader ?? "")
    .trim()
    .replace(/^<+/, "")
    .replace(/>+$/, "")
    .trim()
  if (bare) return `server:${bare}`
  return draft.ref.provider === "gmail"
    ? `server:gmail:${draft.ref.draftId}`
    : `server:imap:${draft.ref.folder}:${draft.ref.uid}`
}

function fieldsOf(draft: FetchedServerDraft): ServerDraftFields {
  return {
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    bodyHtml: draft.bodyHtml,
  }
}

/** Same mirror pointer? (JSON compare — refs are small, fixed-key objects.) */
function sameRef(a: ServerDraftRef | null, b: ServerDraftRef): boolean {
  return a !== null && JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Fetch and file the account's server drafts (see the module comment).
 * Returns the outcome counts for logging/tests.
 */
export async function fetchDraftsOnConnect(
  executor: SqlExecutor,
  accountId: string,
  deps: DraftMirrorDeps = {}
): Promise<FetchDraftsSummary> {
  const server = await fetchServerDrafts(executor, accountId, deps)
  const summary: FetchDraftsSummary = {
    fetched: server.length,
    created: 0,
    updated: 0,
    skipped: 0,
  }

  for (const draft of server) {
    // Our own mirror: keep the local content (source of truth), heal the
    // ref only when it is missing or points somewhere else.
    const ownId = ownMirrorDraftId(draft.messageIdHeader)
    if (ownId) {
      const existing = await getDraft(executor, ownId)
      if (existing) {
        if (!sameRef(existing.serverDraftRef, draft.ref)) {
          await setDraftServerRef(executor, ownId, draft.ref)
          summary.updated += 1
        } else {
          summary.skipped += 1
        }
        continue
      }
    }

    const { created } = await saveServerDraft(executor, {
      accountId,
      draftKey: serverDraftKey(draft),
      ref: draft.ref,
      fields: fieldsOf(draft),
    })
    if (created) summary.created += 1
    else summary.updated += 1
  }
  return summary
}
