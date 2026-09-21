import type { SqlExecutor } from "../db/executor"
import { placeholders } from "../db/executor"
import { classifyMessage } from "./classify"
import { getSenderCategories } from "./sender-categories"
import { storedHeadersRecord } from "../rules/ingestion"

/**
 * The category backfill job (task 3.4, design D4, mail-organization spec
 * "Automatic categorization": "Existing messages SHALL be
 * back-categorizable on demand ... with a progress summary").
 *
 * What it classifies: every thread whose `threads.category` is still NULL
 * (the migration v9 contract — NULL = not yet categorized; pre-3.3 rows
 * sit there until this job runs). Threads WITHOUT any message are skipped
 * (`EXISTS` predicate): there is nothing to classify them from and the
 * tab UI renders NULL as Primary anyway — and the predicate keeps the
 * selection meaningful (a classified thread leaves the NULL set, so each
 * pass makes progress and re-running is always safe).
 *
 * What it classifies WITH: the SAME deterministic engine ingestion uses —
 * classifyMessage over the thread's NEWEST message (headers from the
 * stored messages.headers JSON via the rules module's
 * storedHeadersRecord, subject, From address) plus a batched
 * sender_categories read. Writes go through the ingestion pass's
 * keep-first UPDATE (`AND category IS NULL`), so a per-thread user
 * override (overrides.ts) is never touched, and a thread an arrival
 * categorized mid-job is simply skipped. User RULES that name a category
 * (set_category) are deliberately NOT re-evaluated here: rule criteria
 * are per-message ingestion-event evaluations (label/read/attachment
 * state the stored rows do not fully reconstruct), so a category rule
 * applies to mail arriving AFTER it exists (the hook stamps ruleCategory —
 * rules/ingestion.ts); the backfill's job is the deterministic engine.
 *
 * Batching/resume (the DELIVERY_HOLDS_DUE_JOB / auto-archive due-job
 * convention): bootstrap registers CATEGORY_BACKFILL_DUE_JOB, every 60s
 * tick runs one SLICE of at most CATEGORY_BACKFILL_MAX_BATCHES_PER_RUN
 * batches of CATEGORY_BACKFILL_BATCH_SIZE threads (id-ordered, resuming
 * through an id cursor that ALWAYS advances past a processed batch — even
 * a failed one, so neither a poisoned row nor a flaky query can spin or
 * wedge the job; a failed batch's threads stay NULL until the next fresh
 * backfill), then yields — the next tick continues, and a huge mailbox
 * never blocks a tick. runDueJobsOnce() gives the on-demand start its
 * immediate first pickup. A slice that selects zero candidates marks the
 * job DONE and leaves the cumulative scanned/categorized totals standing
 * as the summary in the progress state below.
 *
 * Progress + cancel: a module-level observable snapshot
 * ({ running, scanned, categorized, done, cancelled }) with a tiny
 * subscribe emitter — no store dependency; the later task 3.5 UI renders
 * it through a useSyncExternalStore-style subscription.
 * cancelCategoryBackfill() sets a module flag the loop checks BETWEEN
 * batches; the run stops at the next batch boundary and reports
 * cancelled. A fresh start (fresh: true) resets the progress, the cursor
 * and the flag; a resumed start (default) refuses to restart a
 * done/cancelled job, so the tick handler cannot resurrect a cancelled
 * run — only the user re-triggering the backfill does.
 */

/** Due-jobs registry name bootstrap registers this job under (design D2). */
export const CATEGORY_BACKFILL_DUE_JOB = "categorization.backfill"

/** Threads classified per batch query (id-ordered). */
export const CATEGORY_BACKFILL_BATCH_SIZE = 200

/** Batches one tick's slice processes before yielding to the next tick. */
export const CATEGORY_BACKFILL_MAX_BATCHES_PER_RUN = 5

/** The observable job state a later task renders (task 3.5). `scanned` is
 * the number of threads examined and `categorized` the number that
 * received a category THIS job (keep-first skips excluded); both are
 * cumulative across slices until the next fresh start, and they stand as
 * the summary once `done`. */
export interface CategoryBackfillProgress {
  running: boolean
  scanned: number
  categorized: number
  done: boolean
  cancelled: boolean
}

const INITIAL_PROGRESS: CategoryBackfillProgress = {
  running: false,
  scanned: 0,
  categorized: 0,
  done: false,
  cancelled: false,
}

// Module-level job state: one backfill at a time (the scheduler is a
// singleton and the running guard makes a second concurrent start a no-op).
let progress: CategoryBackfillProgress = INITIAL_PROGRESS
let cancelRequested = false
let cursor = ""
const listeners = new Set<(progress: CategoryBackfillProgress) => void>()

function setProgress(patch: Partial<CategoryBackfillProgress>): void {
  progress = { ...progress, ...patch }
  for (const listener of listeners) {
    try {
      listener(progress)
    } catch (error) {
      console.warn("[categorization] backfill progress listener failed", error)
    }
  }
}

/** The current progress snapshot (stable reference between changes —
 * safe as a useSyncExternalStore snapshot). */
export function getCategoryBackfillProgress(): CategoryBackfillProgress {
  return progress
}

/** Observe progress changes; returns the unsubscribe function. */
export function subscribeCategoryBackfillProgress(
  listener: (progress: CategoryBackfillProgress) => void
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Cancel the running backfill: the flag is checked BETWEEN batches, so
 * the loop stops at the next batch boundary and the progress reports
 * `cancelled`. The job stays cancelled (the tick handler will not
 * restart it) until an explicit fresh start resets it.
 */
export function cancelCategoryBackfill(): void {
  cancelRequested = true
}

export interface CategoryBackfillOptions {
  /** Start a NEW job: reset progress, the resume cursor and a previous
   * cancel, then rescan. The on-demand UI entry (task 3.5). */
  fresh?: boolean
  /** Batches this call processes before yielding (default
   * CATEGORY_BACKFILL_MAX_BATCHES_PER_RUN; tests shrink it). */
  maxBatches?: number
}

/**
 * Run one bounded slice of the backfill (see the module comment for the
 * batching/resume/cancel contract). Resolves with the progress snapshot
 * after the slice — `done: true` on the slice that exhausted the
 * candidates. Never rejects: a failed classification batch is warned,
 * skipped, and left NULL for a future fresh backfill. While a slice is
 * running (or the job is done/cancelled) further calls are no-ops
 * returning the current snapshot.
 */
export async function startCategoryBackfill(
  executor: SqlExecutor,
  options?: CategoryBackfillOptions
): Promise<CategoryBackfillProgress> {
  const fresh = options?.fresh === true
  // One job at a time; a done/cancelled job only restarts via fresh.
  if (progress.running) return progress
  if (!fresh && (progress.done || progress.cancelled)) return progress

  cancelRequested = false
  if (fresh) {
    cursor = ""
    setProgress({ ...INITIAL_PROGRESS, running: true })
  } else {
    setProgress({ running: true, done: false, cancelled: false })
  }

  const maxBatches = Math.max(
    1,
    Math.floor(options?.maxBatches ?? CATEGORY_BACKFILL_MAX_BATCHES_PER_RUN)
  )
  let processed = 0
  while (processed < maxBatches && !cancelRequested) {
    let threadIds: string[]
    try {
      threadIds = await selectBackfillCandidates(executor, cursor)
    } catch (error) {
      // Candidate selection is the batch boundary: a failure here ends
      // the slice and the same batch is retried on the next tick.
      console.warn(
        "[categorization] backfill selection failed; resuming on the " +
          "next tick",
        error
      )
      break
    }
    if (threadIds.length === 0) {
      setProgress({ running: false, done: true, cancelled: false })
      return progress
    }
    setProgress({ scanned: progress.scanned + threadIds.length })
    try {
      const categorized = await classifyBatch(executor, threadIds)
      setProgress({ categorized: progress.categorized + categorized })
    } catch (error) {
      // The batch is skipped (its threads stay NULL until the next fresh
      // backfill) but the cursor still advances below — one poisoned
      // batch must never wedge the job.
      console.warn(
        "[categorization] backfill batch failed; skipping it " +
          `(${threadIds.length} threads left uncategorized)`,
        error
      )
    }
    cursor = threadIds[threadIds.length - 1] ?? cursor
    processed += 1
  }
  setProgress({ running: false })
  if (cancelRequested) {
    setProgress({ cancelled: true })
  }
  return progress
}

/**
 * The next id-ordered batch of uncategorized threads that carry at least
 * one message, starting strictly after `afterId` (the resume cursor).
 */
async function selectBackfillCandidates(
  executor: SqlExecutor,
  afterId: string
): Promise<string[]> {
  const rows = await executor.select<{ id: string }>(
    `SELECT id FROM threads
     WHERE category IS NULL AND id > $1
       AND EXISTS (SELECT 1 FROM messages WHERE messages.thread_id = threads.id)
     ORDER BY id
     LIMIT $2`,
    [afterId, CATEGORY_BACKFILL_BATCH_SIZE]
  )
  return rows.map((row) => row.id)
}

/**
 * Classify one batch: the NEWEST message per thread (max date; rowid
 * breaks ties deterministically — keep-first writes make the extra rows
 * no-ops), the stored headers JSON parsed back to the classifier's
 * record, one batched sender-override read, one keep-first write per
 * message. Returns the number of threads that received a category.
 */
async function classifyBatch(
  executor: SqlExecutor,
  threadIds: readonly string[]
): Promise<number> {
  const rows = await executor.select<{
    thread_id: string
    from_address: string | null
    subject: string | null
    headers: string | null
  }>(
    `SELECT m.thread_id, m.from_address, m.subject, m.headers
     FROM messages m
     JOIN (
       SELECT thread_id, MAX(date) AS max_date
       FROM messages
       WHERE thread_id IN (${placeholders(threadIds.length)})
       GROUP BY thread_id
     ) latest ON latest.thread_id = m.thread_id AND latest.max_date = m.date
     ORDER BY m.thread_id, m.date DESC, m.rowid DESC`,
    [...threadIds]
  )

  // One sender-override read for the batch (the ingestion pass's pattern).
  const overrides = await getSenderCategories(
    executor,
    rows.map((row) => row.from_address)
  )

  let categorized = 0
  for (const row of rows) {
    const key = row.from_address?.trim().toLowerCase() ?? ""
    const category = classifyMessage({
      senderEmail: row.from_address,
      subject: row.subject,
      headers: storedHeadersRecord(row.headers ?? undefined),
      // No ruleCategory on purpose (see the module comment): the
      // deterministic engine classifies existing mail.
      senderOverride: key === "" ? null : (overrides.get(key) ?? null),
    })
    // Keep-first (the ingestion pass's contract): never overwrite a
    // category an arrival or a user override wrote mid-job.
    const result = await executor.execute(
      "UPDATE threads SET category = $1 WHERE id = $2 AND category IS NULL",
      [category, row.thread_id]
    )
    categorized += result.rowsAffected
  }
  return categorized
}
