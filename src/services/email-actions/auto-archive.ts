import type { SqlExecutor } from "../db/executor"
import { getSetting, setSetting } from "../db/settings"
import { bulkApply } from "./thread-actions"

/**
 * Auto-archive stale threads (task 12.3, spec "Auto-archive stale
 * threads"): a due-pass batch job that archives inbox threads whose
 * newest message is READ and older than N days ("read + untouched for N
 * days" — last_message_at is the thread's latest activity, so it covers
 * both "read" and "nothing new since").
 *
 * Setting (the on/off toggle + the day threshold): ONE global JSON row in
 * the settings table under `mail.autoArchive`
 * (`{ enabled: boolean, days: number }`). GLOBAL, not per-account: the
 * spec models one user-facing toggle, the selection query is uniform
 * across accounts, and the stale-ness clock does not vary by provider.
 * `days` is clamped to 1–365 on both read and write; a corrupt row reads
 * as the disabled default (`{ enabled: false, days: 30 }`), never a crash.
 * The settings-UI toggle is a later task's consumer of these accessors.
 *
 * Selection (`selectAutoArchiveCandidates`): threads that are
 * inbox-resident (membership in an inbox-role label — either placement
 * model: the gmail thread_labels rows or the imap folder cache — the same
 * residency predicate blocked-senders.ts's cleanup uses; NOT the
 * `is_archived = 0` cache, which also matches IMAP threads filed in
 * custom/sent/drafts folders, since setThreadFolder deliberately leaves
 * is_archived = 0 there), not trashed/spam, fully read
 * (unread_count = 0, the recomputeThreadCaches cache), untouched
 * (last_message_at <= now - days), and NOT in a deliberate thread state —
 * pinned, snoozed, muted, Done or delivery-held threads are skipped
 * (conservative: those columns mean the user or a feature made an explicit
 * placement decision; auto-archive must not fight it). The read/old/inbox
 * conditions make the pass idempotent — archived threads no longer match —
 * so re-running is always safe.
 *
 * Application reuses the user-facing archive path (email-actions/
 * thread-actions.ts bulkApply with the "archive" action): per thread it is
 * the standard D10 sequence — local effect (gmail drops the inbox label /
 * imap moves to the archive folder) + queue op for the server + the usual
 * list-change event — exactly the "existing archive ops" the design calls
 * for. Candidates are grouped per account and applied with bulkApply per
 * account (its fail-fast-per-account semantics preserved); one failing
 * account is logged and skipped so the others still archive. Archiving is
 * silent by construction — no notification exists on this path (spec:
 * "archives in batches without notifications"). Auto-archived threads
 * remain in All Mail, their labels and search (is_archived only removes
 * them from the inbox).
 *
 * Scheduling (design D2): bootstrap registers the "auto-archive.run"
 * due-job handler; every 60s tick fires it and runDueJobsOnce() provides
 * the launch pass. A last-run guard (settings key `mail.autoArchiveLastRun`,
 * unix seconds; a pass that actually ran stamps it) skips a run within
 * MIN_RUN_INTERVAL_SECONDS (6h) of the previous one — stale threads are
 * days old, so 6h granularity is far below the feature's resolution and
 * the tick-driven handler stays a no-op in practice. The guard is stamped
 * AFTER the batch completes; a crashed pass re-runs next tick (the
 * selection is idempotent). All timestamps are unix epoch SECONDS.
 */

/** Settings key holding the global auto-archive toggle + threshold. */
export const AUTO_ARCHIVE_SETTING_KEY = "mail.autoArchive"

/** Settings key of the last-run guard (unix seconds of the last pass that
 * actually selected and applied a batch — disabled/skipped runs don't
 * stamp it). */
export const AUTO_ARCHIVE_LAST_RUN_KEY = "mail.autoArchiveLastRun"

/** Minimum wall-clock distance between two auto-archive passes (6h). */
export const MIN_RUN_INTERVAL_SECONDS = 6 * 60 * 60

export const DEFAULT_AUTO_ARCHIVE_DAYS = 30

/** Due-jobs registry name bootstrap registers this batch under. */
export const AUTO_ARCHIVE_DUE_JOB = "auto-archive.run"

/** The stored setting shape; `enabled = false` is the default. */
export interface AutoArchiveSetting {
  enabled: boolean
  /** Staleness threshold in days, clamped 1–365. */
  days: number
}

const MIN_DAYS = 1
const MAX_DAYS = 365

function clampDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_AUTO_ARCHIVE_DAYS
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.floor(days)))
}

/** The effective setting: the stored row with `days` clamped, or the
 * disabled default when the row is missing/parseable-but-invalid. */
export async function getAutoArchiveSetting(
  executor: SqlExecutor
): Promise<AutoArchiveSetting> {
  const stored = await getSetting<unknown>(
    executor,
    AUTO_ARCHIVE_SETTING_KEY,
    null
  )
  if (
    typeof stored !== "object" ||
    stored === null ||
    typeof (stored as Record<string, unknown>).enabled !== "boolean" ||
    typeof (stored as Record<string, unknown>).days !== "number"
  ) {
    return { enabled: false, days: DEFAULT_AUTO_ARCHIVE_DAYS }
  }
  const row = stored as { enabled: boolean; days: number }
  return { enabled: row.enabled, days: clampDays(row.days) }
}

/** Persist the toggle + threshold (the settings UI's write path; days is
 * clamped so a stale/hand-edited control cannot store nonsense). */
export async function setAutoArchiveSetting(
  executor: SqlExecutor,
  setting: AutoArchiveSetting
): Promise<void> {
  await setSetting(executor, AUTO_ARCHIVE_SETTING_KEY, {
    enabled: setting.enabled === true,
    days: clampDays(setting.days),
  })
}

// ---------------------------------------------------------------------------
// The due-pass batch job
// ---------------------------------------------------------------------------

/** One candidate row: enough to group the bulk archive per account. */
export interface AutoArchiveCandidate {
  id: string
  account_id: string
}

/**
 * The selection behind runAutoArchive, exported for direct testing:
 * inbox-resident (inbox-role label membership, per blocked-senders.ts's
 * residency definition — NOT is_archived, which misses the imap
 * custom-folder distinction), fully read, untouched since the cutoff
 * (unix seconds), and not pinned/snoozed/held/muted/Done (the deliberate
 * states — see the module comment). Idempotent: an archived (or
 * trashed/spammed) thread never matches again — archived threads are no
 * longer inbox-resident.
 */
export async function selectAutoArchiveCandidates(
  executor: SqlExecutor,
  cutoff: number
): Promise<AutoArchiveCandidate[]> {
  // Every inbox-role label across all accounts (the batch is not
  // per-account). Without any, nothing is inbox-resident.
  const inboxLabels = await executor.select<{ id: string }>(
    "SELECT id FROM labels WHERE special_use = 'inbox'"
  )
  if (!inboxLabels.length) return []
  const inboxIds = inboxLabels.map((row) => row.id)
  // Each list bound separately; $1 (the cutoff) comes FIRST in the SQL
  // text — placeholder numbers must ascend by first occurrence (see
  // executor.ts; the positional $N→? rewrite binds out of order otherwise)
  // — then the two label-id lists.
  const list = (firstIndex: number): string =>
    inboxIds.map((_, index) => `$${firstIndex + index}`).join(", ")
  return executor.select<AutoArchiveCandidate>(
    `SELECT threads.id, threads.account_id FROM threads
     WHERE threads.is_trashed = 0
       AND threads.is_spam = 0
       AND threads.unread_count = 0
       AND threads.last_message_at IS NOT NULL
       AND threads.last_message_at <= $1
       AND (threads.folder_label_id IN (${list(2)}) OR EXISTS (
         SELECT 1 FROM thread_labels tl
         WHERE tl.thread_id = threads.id AND tl.label_id IN (${list(2 + inboxIds.length)}))
       )
       AND threads.pinned_at IS NULL
       AND threads.snoozed_until IS NULL
       AND threads.held_until IS NULL
       AND threads.muted_at IS NULL
       AND threads.done_at IS NULL`,
    [cutoff, ...inboxIds, ...inboxIds]
  )
}

/** What one run reports: how many threads were archived, or why nothing
 * ran (`skipped` — "nothing matched" is just archived = 0, skipped null). */
export interface AutoArchiveRunResult {
  archived: number
  skipped: "disabled" | "recent-run" | null
}

/**
 * One auto-archive pass: read the setting (no-op when disabled), respect
 * the last-run guard, select the stale read inbox threads across ALL
 * accounts, archive them per account through thread-actions' bulkApply,
 * then stamp the last-run guard. Returns the archived count (0 with
 * `skipped` set when the pass was intentionally skipped).
 */
export async function runAutoArchive(
  executor: SqlExecutor,
  now: number = Math.floor(Date.now() / 1000)
): Promise<AutoArchiveRunResult> {
  const setting = await getAutoArchiveSetting(executor)
  if (!setting.enabled) {
    return { archived: 0, skipped: "disabled" }
  }
  const storedLastRun = await getSetting<number>(
    executor,
    AUTO_ARCHIVE_LAST_RUN_KEY,
    0
  )
  // Clamp a backwards system clock: a last-run stamp in the future would
  // otherwise suppress every pass until the clock catches up to it.
  const lastRun = storedLastRun > now ? 0 : storedLastRun
  if (typeof lastRun === "number" && now - lastRun < MIN_RUN_INTERVAL_SECONDS) {
    return { archived: 0, skipped: "recent-run" }
  }

  const cutoff = now - setting.days * 24 * 60 * 60
  const candidates = await selectAutoArchiveCandidates(executor, cutoff)
  const byAccount = new Map<string, string[]>()
  for (const candidate of candidates) {
    const ids = byAccount.get(candidate.account_id)
    if (ids) ids.push(candidate.id)
    else byAccount.set(candidate.account_id, [candidate.id])
  }

  let archived = 0
  for (const [accountId, threadIds] of byAccount) {
    try {
      // The user-facing archive action, batched (D10 local-first per
      // thread: local effect + queue op + one change event per account).
      await bulkApply(executor, accountId, threadIds, "archive")
      archived += threadIds.length
    } catch (error) {
      // bulkApply is fail-fast per account; isolate the failure here so
      // the other accounts still archive and the due job never rejects.
      console.warn(
        `[auto-archive] batch for account ${accountId} failed; ` +
          `${threadIds.length} threads skipped this pass`,
        error
      )
    }
  }

  // Stamp only a pass that actually ran (after the batch — a crashed pass
  // re-runs next tick; the selection is idempotent).
  await setSetting(executor, AUTO_ARCHIVE_LAST_RUN_KEY, now)
  return { archived, skipped: null }
}
