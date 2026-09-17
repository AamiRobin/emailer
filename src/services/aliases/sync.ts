import {
  listAliases,
  setDefaultAlias,
  upsertSyncedAlias,
  type AliasRow,
} from "../db/aliases"
import type { SqlExecutor } from "../db/executor"
import type { GmailSendAs } from "../email/gmail-api"

/**
 * Gmail SendAs → aliases reconciliation (task 16.1, design D10). The
 * Gmail API is the source of truth for gmail-source alias rows; manual
 * (imap) rows in the same table are never read or written here — IMAP
 * accounts have no alias sync at all (manual CRUD only), and a manual row
 * that happens to share an address with a Gmail alias keeps its user-set
 * display name and default flag.
 *
 * Endpoint: GET {userId}/settings/sendAs (users.settings.sendAs), covered
 * by the full mail.google.com scope — no re-consent. Semantics per run:
 * - the primary entry (isPrimary) is SKIPPED: the account's own address
 *   is the composer's baseline identity already (SendEmailInput.from),
 *   so mirroring it as an alias row would duplicate it in the From list;
 * - each remaining address is upserted case-insensitively (display name,
 *   is_default ← Gmail's isDefault);
 * - gmail-source rows the API no longer returns are removed;
 * - verified addresses only: verificationStatus !== "accepted" entries
 *   are skipped (sending from an unverified alias would be rejected).
 *
 * Reconcile ordering note: rows are upserted with their remote isDefault
 * BEFORE the sweep deletes stale rows, and the default flag is written
 * per-row from the API (Gmail guarantees at most one isDefault) — the
 * per-row writes cannot clear sibling defaults, so the pass ENDS with a
 * single-default enforcement (db/aliases.ts's invariant): when a
 * gmail-source row ended up default, the same one-statement clear-others
 * sweep setDefaultAlias uses makes it the account's ONLY default (the API
 * is authoritative when it names one, and a manual row must not keep a
 * stale second default); with no gmail default the manual default is left
 * untouched. Either way exactly one default survives per account.
 */

/** The slice of the Gmail client the sync needs (mockable in tests). */
export interface SendAsSource {
  listSendAs(): Promise<GmailSendAs[]>
}

export interface AliasSyncSummary {
  /** Addresses that became new gmail-source rows. */
  inserted: number
  /** Existing gmail-source rows whose display name/default changed. */
  updated: number
  /** Stale gmail-source rows removed (no longer in the API response). */
  removed: number
}

/** True when the SendAs entry may be used as a From identity. */
export function isSyncableSendAs(entry: GmailSendAs): boolean {
  if (!entry.sendAsEmail?.trim()) return false
  if (entry.isPrimary) return false
  return (entry.verificationStatus ?? "accepted") === "accepted"
}

/**
 * One reconcile pass for one Gmail account. Resolves to the change
 * summary; a clean second run reports all zeros (idempotent).
 */
export async function syncGmailAliases(
  executor: SqlExecutor,
  accountId: string,
  source: SendAsSource
): Promise<AliasSyncSummary> {
  const remoteEntries = (await source.listSendAs()).filter(isSyncableSendAs)

  const before = new Map<string, AliasRow>(
    (await listAliases(executor, accountId, "gmail")).map((row) => [
      row.email,
      row,
    ])
  )

  const summary: AliasSyncSummary = { inserted: 0, updated: 0, removed: 0 }
  const remoteEmails = new Set<string>()
  for (const entry of remoteEntries) {
    const email = entry.sendAsEmail.trim().toLowerCase()
    if (remoteEmails.has(email)) continue // duplicate API entries: first wins
    remoteEmails.add(email)
    const existing = before.get(email)
    const id = await upsertSyncedAlias(executor, accountId, {
      email,
      displayName: entry.displayName ?? null,
      isDefault: entry.isDefault === true,
    })
    if (id === null) continue // a manual row holds the address; skip it
    if (existing) {
      const changed =
        existing.display_name !== (entry.displayName?.trim() || null) ||
        existing.is_default !== (entry.isDefault === true ? 1 : 0)
      if (changed) summary.updated += 1
    } else {
      summary.inserted += 1
    }
  }

  // Stale sweep: gmail rows the API no longer reports. imap rows are
  // structurally excluded by the source filter.
  for (const [email, row] of before) {
    if (remoteEmails.has(email)) continue
    await executor.execute("DELETE FROM aliases WHERE id = $1", [row.id])
    summary.removed += 1
  }

  // Single-default enforcement (see the ordering note): the per-row
  // upserts wrote isDefault WITHOUT clearing siblings, so a manual default
  // and the gmail default could coexist at this point. When any
  // gmail-source row ended up default, sweep the account to exactly that
  // one default (the same CASE statement setDefaultAlias runs); with no
  // gmail default nothing is written and the manual default survives.
  const gmailDefaults = await executor.select<{ id: string }>(
    `SELECT id FROM aliases
     WHERE account_id = $1 AND source = 'gmail' AND is_default = 1
     ORDER BY created_at ASC, id ASC`,
    [accountId]
  )
  if (gmailDefaults[0]) {
    await setDefaultAlias(executor, accountId, gmailDefaults[0].id)
  }

  return summary
}
