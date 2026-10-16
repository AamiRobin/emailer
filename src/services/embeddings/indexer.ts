import { invoke } from "@tauri-apps/api/core"

import type { SqlExecutor } from "@/services/db/executor"
import { placeholders } from "@/services/db/executor"
import { foldText } from "@/services/search/fts"
import { contentHash } from "./hash"
import { getBgeModelDir, modelFilesPresent } from "./model"
import { isSemanticSearchEnabled } from "./settings"
import {
  upsertThreadVectors,
  type ThreadVectorUpsert,
} from "./vectors"

/**
 * The semantic indexing pipeline (parity-round-3 design D1, task 6.2).
 *
 * What gets embedded (the D1 thread document): subject + From line +
 * the FOLDED plain-text body of the thread's NEWEST message, truncated
 * to ~1500 characters. Newest message = the doc the thread list shows
 * for that thread, so a thread's vector tracks what it currently looks
 * like; the fold is the SAME normalizer the FTS index uses
 * (services/search/fts.ts foldText) — one text-prep vocabulary for both
 * retrieval legs.
 *
 * Incremental skip: each document's content hash (hash.ts) is compared
 * against the stored thread_vectors.content_hash — unchanged hash, no
 * embed call. Candidate selection is pure SQL (no per-tick mailbox
 * scan): a thread is stale when it has NO vector row yet, or a message
 * in the thread is at least as new as the vector write (`<=`, biased
 * toward re-examination — messages are write-once in this app, so a
 * message newer than the vector is exactly "the document changed", and
 * a same-second false positive costs only the TS hash comparison, while
 * a false negative would lose freshness for a whole indexing cycle).
 *
 * Cadence: a due-job handler (bootstrap registers SEMANTIC_INDEX_DUE_JOB)
 * — the scheduler's due jobs drain in the same 60s pass as the sync,
 * idle-scheduled by construction, and sync completion is never delayed:
 * each tick runs ONE bounded slice (a few batches, id-cursor resumed)
 * and yields, the category-backfill convention. A large first index
 * fills over several ticks instead of blocking anything.
 *
 * Vectors land in thread_vectors as BLOBs (vectors.ts); account/thread
 * deletion removes them through the schema CASCADE. The only Rust call
 * is embed_texts (compute); every SQL statement runs here.
 *
 * Failure isolation mirrors the category backfill: a failed batch is
 * warned and skipped with the cursor still advancing — one poisoned
 * document can never wedge the job, and the next pass retries nothing
 * that succeeded. `model_missing` (files removed under a still-enabled
 * feature) stops the slice quietly; the settings section surfaces the
 * missing-model state via modelFilesPresent.
 */

/** Threads examined per batch (id-ordered, resumable). */
export const INDEX_BATCH_SIZE = 100

/** Batches one slice processes before yielding to the next tick. */
export const INDEX_MAX_BATCHES_PER_RUN = 5

/** Documents per embed_texts call (under the Rust command's 64 cap). */
export const EMBED_BATCH_SIZE = 32

/** Doc-text truncation (D1: ~1500 chars — comfortably inside the
 * model's 512-token budget after the tokenizer's own truncation). */
export const DOC_TEXT_MAX_CHARS = 1500

/** Due-jobs registry name bootstrap registers this job under. */
export const SEMANTIC_INDEX_DUE_JOB = "semantic.index"

/** The embed seam: one Rust `embed_texts` call. Tests replace it (see
 * setEmbedTextsImplForTests) instead of mocking the IPC module. */
export type EmbedTextsFn = (
  modelDir: string,
  batch: string[]
) => Promise<number[][]>

async function invokeEmbedTexts(
  modelDir: string,
  batch: string[]
): Promise<number[][]> {
  return invoke("embed_texts", { modelDir, batch })
}

let embedTextsImpl: EmbedTextsFn = invokeEmbedTexts

/** Replace the embed implementation (tests). Null restores the real
 * Rust command call. */
export function setEmbedTextsImplForTests(impl: EmbedTextsFn | null): void {
  embedTextsImpl = impl ?? invokeEmbedTexts
}

/** The typed rejection of `embed_texts` (src-tauri embeddings/mod.rs
 * serializes {kind, message}); `kind` is stable ("model_missing",
 * "config", …). */
export class EmbedTextsError extends Error {
  readonly kind: string

  constructor(kind: string, message: string) {
    super(message)
    this.name = "EmbedTextsError"
    this.kind = kind
  }
}

/** The typed `embed_texts` call (the seam wrapper) — search.ts embeds
 * its query vector through this. */
export async function embedTexts(
  modelDir: string,
  batch: string[]
): Promise<number[][]> {
  try {
    return await embedTextsImpl(modelDir, batch)
  } catch (caught) {
    const wire = caught as { kind?: unknown; message?: unknown }
    if (typeof wire?.kind === "string") {
      throw new EmbedTextsError(
        wire.kind,
        typeof wire.message === "string" ? wire.message : String(caught)
      )
    }
    throw caught
  }
}

// ---------------------------------------------------------------------------
// Progress (observable snapshot — the category-backfill pattern)
// ---------------------------------------------------------------------------

export interface SemanticIndexProgress {
  running: boolean
  /** Threads brought up to date this pass (embedded OR skipped-
   * unchanged), cumulative across slices until the pass completes. */
  indexed: number
  /** Threads with at least one message — the pass's fixed denominator
   * (snapshotted at slice start). */
  total: number
  /** Threads actually embedded this pass (the expensive subset). */
  embedded: number
  /** A slice found no stale candidates — the index is current. */
  done: boolean
  cancelled: boolean
}

const INITIAL_PROGRESS: SemanticIndexProgress = {
  running: false,
  indexed: 0,
  total: 0,
  embedded: 0,
  done: false,
  cancelled: false,
}

let progress: SemanticIndexProgress = INITIAL_PROGRESS
const progressListeners = new Set<(progress: SemanticIndexProgress) => void>()

function setProgress(patch: Partial<SemanticIndexProgress>): void {
  progress = { ...progress, ...patch }
  for (const listener of progressListeners) {
    try {
      listener(progress)
    } catch (error) {
      console.warn("[embeddings] index progress listener failed", error)
    }
  }
}

/** The current progress snapshot (stable reference between changes —
 * safe as a useSyncExternalStore snapshot). */
export function getSemanticIndexProgress(): SemanticIndexProgress {
  return progress
}

/** Observe index progress; returns the unsubscribe function. */
export function subscribeSemanticIndexProgress(
  listener: (progress: SemanticIndexProgress) => void
): () => void {
  progressListeners.add(listener)
  return () => {
    progressListeners.delete(listener)
  }
}

let cancelRequested = false
/** Resume cursor: the threads.id the next batch starts strictly after. */
let cursor = ""

/** Cancel the running pass: stops at the next batch boundary. */
export function cancelSemanticIndexing(): void {
  cancelRequested = true
}

// ---------------------------------------------------------------------------
// The slice
// ---------------------------------------------------------------------------

export interface SemanticIndexSliceOptions {
  /** Batches this call processes before yielding (default
   * INDEX_MAX_BATCHES_PER_RUN; tests shrink it). */
  maxBatches?: number
  /** Skip the enabled+model gate (tests drive the seam directly;
   * production ticks keep the gate). Default false. */
  skipGate?: boolean
}

/**
 * Run one bounded indexing slice (see the module comment for the
 * batching/resume/cancel contract). Resolves with the progress snapshot
 * after the slice — `done: true` on the slice that exhausts the stale
 * candidates. Never rejects; gating failures (feature off, model not
 * downloaded) resolve as a no-op snapshot.
 */
export async function runSemanticIndexSlice(
  executor: SqlExecutor,
  options?: SemanticIndexSliceOptions
): Promise<SemanticIndexProgress> {
  if (progress.running) return progress
  const skipGate = options?.skipGate === true
  if (
    !skipGate &&
    (!(await isSemanticSearchEnabled(executor)) ||
      !(await modelFilesPresent(executor)))
  ) {
    return progress
  }

  cancelRequested = false
  const total = await countIndexableThreads(executor).catch(() => 0)
  cursor = ""
  setProgress({ ...INITIAL_PROGRESS, running: true, total })

  const maxBatches = Math.max(
    1,
    Math.floor(options?.maxBatches ?? INDEX_MAX_BATCHES_PER_RUN)
  )
  // The models directory resolves lazily (first flush), so a fully
  // up-to-date pass never touches the path API.
  let modelDir: string | null = null
  if (skipGate) modelDir = ""

  // Accumulated writes flush at EMBED_BATCH_SIZE and at batch ends.
  let pending: IndexedDoc[] = []
  const flush = async (): Promise<void> => {
    const docs = pending
    pending = []
    if (docs.length === 0) return
    if (modelDir === null) modelDir = await getBgeModelDir()
    let vectors: number[][]
    try {
      vectors = await embedTexts(
        modelDir,
        docs.map((doc) => doc.text)
      )
    } catch (error) {
      if (error instanceof EmbedTextsError && error.kind === "model_missing") {
        // The model vanished under a still-enabled feature: stop the
        // slice quietly (the settings section shows the missing-model
        // state); progress made so far stands.
        setProgress({ running: false })
        throw new SliceStopped()
      }
      throw error
    }
    if (vectors.length !== docs.length) {
      throw new Error(
        `embed_texts returned ${vectors.length} vectors for ${docs.length} documents`
      )
    }
    const upserts: ThreadVectorUpsert[] = docs.map((doc, index) => ({
      accountId: doc.accountId,
      threadId: doc.threadId,
      vector: new Float32Array(vectors[index]),
      contentHash: doc.hash,
    }))
    await upsertThreadVectors(executor, upserts)
    bumpVectorGeneration()
    setProgress({ embedded: progress.embedded + upserts.length })
  }

  try {
    for (let batch = 0; batch < maxBatches; batch += 1) {
      if (cancelRequested) break
      const rows = await selectIndexCandidates(executor, cursor)
      if (rows.length === 0) {
        setProgress({ running: false, done: true, cancelled: false })
        return progress
      }
      // One hash lookup per batch: rows whose stored hash already
      // matches skip WITHOUT an embed call (the incremental contract).
      const storedHashes = await selectStoredHashes(
        executor,
        rows.map((row) => row.account_id),
        rows.map((row) => row.thread_id)
      )
      for (const row of rows) {
        const text = composeThreadDocument(row)
        const hash = contentHash(text)
        if (
          storedHashes.get(row.account_id + "\u0000" + row.thread_id) === hash
        ) {
          continue
        }
        pending.push({
          accountId: row.account_id,
          threadId: row.thread_id,
          text,
          hash,
        })
        if (pending.length >= EMBED_BATCH_SIZE) {
          await flush()
        }
      }
      // The batch's writes land at batch end: a slice yields with every
      // examined batch fully stored, and a cancel observed during the
      // embed stops the pass before the next batch. A failing batch still
      // advances the cursor (the poisoned-batch rule: a permanently
      // broken document must not wedge the job at the same rows forever —
      // the next PASS retries it, but the job progresses).
      try {
        await flush()
      } catch (error) {
        // model_missing stopped the pass deliberately — that is not a
        // batch to skip past. Any OTHER failure is a poisoned batch:
        // warn, keep what succeeded, advance the cursor so a permanently
        // broken document cannot wedge the job at the same rows (the
        // stale-set re-selection retries it next pass).
        if (error instanceof SliceStopped) throw error
        console.warn("[embeddings] index batch failed; skipping past it", error)
      }
      cursor = rows[rows.length - 1].thread_id
      // Every examined row is now up to date (skipped in place, or
      // queued — the flush separately counts the expensive subset as
      // `embedded`).
      setProgress({ indexed: progress.indexed + rows.length })
    }
  } catch (error) {
    if (error instanceof SliceStopped) return progress
    // Batch failure isolation: warn, keep what succeeded, yield the
    // slice. The cursor has already advanced past the failed batch
    // (the poisoned-batch rule: a permanently broken document must not
    // wedge the job) — but every PASS starts from the top of the stale
    // set, so the next tick's pass retries it from scratch.
    console.warn("[embeddings] index slice failed; resuming next tick", error)
  }
  setProgress({ running: false })
  if (cancelRequested) setProgress({ cancelled: true })
  return progress
}

/** Internal stop signal: the slice ended early (model missing) without
 * being an error. */
class SliceStopped extends Error {}

// ---------------------------------------------------------------------------
// Document selection
// ---------------------------------------------------------------------------

/** One candidate row: the thread's NEWEST message carries the body the
 * document is composed from (max date; rowid breaks ties deterministically —
 * the same newest-message rule the categorization backfill uses). */
interface IndexCandidateRow {
  account_id: string
  thread_id: string
  subject: string | null
  from_name: string | null
  from_address: string | null
  body_text: string | null
  snippet: string | null
}

/**
 * The next id-ordered batch of STALE threads (no vector yet, or a
 * newest message newer than the vector write), starting strictly after
 * `afterThreadId`. Threads without any message are excluded: there is
 * nothing to embed for them.
 */
async function selectIndexCandidates(
  executor: SqlExecutor,
  afterThreadId: string
): Promise<IndexCandidateRow[]> {
  return executor.select<IndexCandidateRow>(
    `SELECT t.account_id, t.id AS thread_id, m.subject, m.from_name,
            m.from_address, m.body_text, m.snippet
     FROM threads t
     JOIN (
       SELECT thread_id, MAX(date) AS max_date
       FROM messages
       GROUP BY thread_id
     ) latest ON latest.thread_id = t.id
     JOIN messages m
       ON m.thread_id = latest.thread_id
      AND m.date = latest.max_date
      AND m.rowid = (
        SELECT MAX(m2.rowid) FROM messages m2
        WHERE m2.thread_id = latest.thread_id AND m2.date = latest.max_date
      )
     LEFT JOIN thread_vectors tv
       ON tv.account_id = t.account_id AND tv.thread_id = t.id
     WHERE t.id > $1
       AND (
         tv.thread_id IS NULL
         OR tv.updated_at <= (
           SELECT MAX(m3.created_at) FROM messages m3 WHERE m3.thread_id = t.id
         )
       )
     ORDER BY t.id
     LIMIT $2`,
    [afterThreadId, INDEX_BATCH_SIZE]
  )
}

/**
 * Threads with at least one message — the progress denominator.
 * Deliberately NOT stale-filtered: `indexed` counts progress against
 * the whole mailbox the index covers.
 */
async function countIndexableThreads(executor: SqlExecutor): Promise<number> {
  const rows = await executor.select<{ count: number }>(
    `SELECT COUNT(*) AS count FROM threads t
     WHERE EXISTS (SELECT 1 FROM messages WHERE messages.thread_id = t.id)`
  )
  return rows[0]?.count ?? 0
}

/** Stored content hashes for a (account, thread) key batch. */
async function selectStoredHashes(
  executor: SqlExecutor,
  accountIds: string[],
  threadIds: string[]
): Promise<Map<string, string>> {
  const rows = await executor.select<{
    account_id: string
    thread_id: string
    content_hash: string
  }>(
    `SELECT account_id, thread_id, content_hash
     FROM thread_vectors
     WHERE account_id IN (${placeholders(accountIds.length)})
       AND thread_id IN (${placeholders(threadIds.length, accountIds.length + 1)})`,
    [...accountIds, ...threadIds]
  )
  return new Map(
    rows.map((row) => [
      row.account_id + "\u0000" + row.thread_id,
      row.content_hash,
    ])
  )
}

/**
 * The D1 thread document: subject, From line, then the folded plain-
 * text body (foldText — the FTS normalizer), truncated to
 * DOC_TEXT_MAX_CHARS. Missing fields contribute nothing; the fold is
 * applied ONLY to the body (subject/from stay raw for the tokenizer).
 */
export function composeThreadDocument(row: {
  subject: string | null
  from_name: string | null
  from_address: string | null
  body_text: string | null
  snippet: string | null
}): string {
  const lines: string[] = []
  const subject = row.subject?.trim()
  if (subject) lines.push(subject)
  const name = row.from_name?.trim()
  const address = row.from_address?.trim()
  const from =
    name && address
      ? `${name} <${address}>`
      : (name ?? address ?? "")
  if (from) lines.push(`From: ${from}`)
  const body = (row.body_text ?? row.snippet ?? "").trim()
  if (body) lines.push(foldText(body))
  return lines.join("\n").slice(0, DOC_TEXT_MAX_CHARS)
}

interface IndexedDoc {
  accountId: string
  threadId: string
  text: string
  hash: string
}

// ---------------------------------------------------------------------------
// Loader-cache invalidation hook (the loader lives in loader.ts; the
// generation counter here avoids a circular import).
// ---------------------------------------------------------------------------

let vectorGeneration = 0
const generationListeners = new Set<(generation: number) => void>()

/** Bump whenever stored vectors change; the per-account loader cache
 * keys on it, so the next search rebuilds the matrix. */
export function bumpVectorGeneration(): void {
  vectorGeneration += 1
  for (const listener of generationListeners) {
    try {
      listener(vectorGeneration)
    } catch (error) {
      console.warn("[embeddings] generation listener failed", error)
    }
  }
}

/** Current vector generation (loader cache key). */
export function getVectorGeneration(): number {
  return vectorGeneration
}
