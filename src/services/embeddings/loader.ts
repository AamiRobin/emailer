import type { SqlExecutor } from "@/services/db/executor"
import { listThreadVectors } from "./vectors"
import { getVectorGeneration } from "./indexer"

/**
 * The per-account in-memory vector index (parity-round-3 design D1,
 * task 6.3). All of an account's thread vectors live in ONE Float32Array
 * matrix with a parallel thread-id array — 384 dims x 50k threads is
 * ~77 MB worst case, 10k threads ~15 MB (the D1 sizing) — and cosine
 * similarity is a plain dot product because every vector is
 * L2-normalized at write time (task 6.1).
 *
 * The 50k-thread cap (D1): when an account holds more, the OLDEST
 * threads (last_message_at ascending — the loader's read order) spill:
 * they are simply not loaded, and the spill is reported through the
 * status snapshot the settings section surfaces ("older threads are not
 * in the semantic index"). Ranking works on the loaded subset.
 *
 * The cache: one loaded index per account, keyed by the vector
 * generation (indexer.ts bumps it on every write), so the assistant's
 * repeated tool calls within a turn reuse the matrix and any new
 * indexing invalidates it. Cache reads stay synchronous AFTER the first
 * await of a load — but a stale-while-revalidate policy would hide
 * fresh vectors from the tool, so a generation change simply rebuilds.
 */

/** Loaded-thread cap per account (design D1). */
export const MAX_INDEX_THREADS = 50_000

/** An account's loaded matrix. `threadIds[i]` owns row `i` of `matrix`. */
export interface AccountVectorIndex {
  accountId: string
  threadIds: string[]
  /** threadIds.length x dim row-major f32s. */
  matrix: Float32Array
  dim: number
}

/** Spill/cap status for an account (the settings section's notice). */
export interface AccountIndexStatus {
  /** Vectors the account holds in SQLite. */
  threads: number
  /** Vectors actually loaded (threads - spilled). */
  loaded: number
  /** Oldest vectors dropped by the cap (0 under the cap). */
  spilled: number
}

interface CacheEntry {
  index: AccountVectorIndex | null
  status: AccountIndexStatus
  generation: number
}

const cache = new Map<string, CacheEntry>()

/**
 * Load (or reuse) the account's matrix. Returns null when the account
 * has no vectors — the caller's degradation path, never an error.
 */
export async function loadAccountIndex(
  executor: SqlExecutor,
  accountId: string
): Promise<AccountVectorIndex | null> {
  const status = await loadAccount(executor, accountId)
  return status?.index ?? null
}

/**
 * Load (or reuse) the account's matrix AND its spill status. Internal
 * shape so `getAccountIndexStatus` shares one load.
 */
async function loadAccount(
  executor: SqlExecutor,
  accountId: string
): Promise<CacheEntry | null> {
  const generation = getVectorGeneration()
  const cached = cache.get(accountId)
  if (cached && cached.generation === generation) return cached
  const rows = await listThreadVectors(executor, accountId)
  // No vectors → no index: both readers treat this as the degradation
  // path (null), never as a zero-sized matrix.
  if (rows.length === 0) return null
  // Oldest-first read order (the SQL's ORDER BY): the cap keeps the
  // LAST MAX_INDEX_THREADS rows — the NEWEST — and spills the rest.
  const dropped = Math.max(0, rows.length - MAX_INDEX_THREADS)
  const kept = rows.slice(dropped)
  const dim = kept.length > 0 ? vectorDim(kept) : 0
  const matrix = new Float32Array(kept.length * dim)
  const threadIds: string[] = []
  for (const row of kept) {
    const vector = decodeVector(row.vector)
    // A corrupt row (wrong length) is dropped, never fatal: the thread
    // falls out of the semantic index until the next re-embed.
    if (vector === null || vector.length !== dim) continue
    matrix.set(vector, threadIds.length * dim)
    threadIds.push(row.thread_id)
  }
  const entry: CacheEntry = {
    index:
      threadIds.length > 0
        ? { accountId, threadIds, matrix, dim }
        : null,
    status: {
      threads: rows.length,
      loaded: threadIds.length,
      spilled: dropped,
    },
    generation,
  }
  cache.set(accountId, entry)
  return entry
}

/**
 * The account's index status without needing the matrix (same cache,
 * same load). Null when the account has no vectors at all.
 */
export async function getAccountIndexStatus(
  executor: SqlExecutor,
  accountId: string
): Promise<AccountIndexStatus | null> {
  const entry = await loadAccount(executor, accountId)
  return entry?.status ?? null
}

/** Drop the account's cached matrix (account deletion, explicit
 * invalidation). The generation key makes this optional for writes —
 * it exists for deletions, which do not bump the write generation. */
export function invalidateAccountIndex(accountId: string): void {
  cache.delete(accountId)
}

/** The common dimensionality across the kept rows (they are all written
 * by the same model; 384 for BGE-small). */
function vectorDim(rows: { vector: unknown }[]): number {
  for (const row of rows) {
    const vector = decodeVector(row.vector)
    if (vector && vector.length > 0) return vector.length
  }
  return 0
}

/** BLOB → f32s (vectors.ts owns the conversion; re-decoded here to keep
 * loader.ts free of the import cycle the types would drag in). The
 * binary check is ArrayBuffer.isView — REALM-INDEPENDENT on purpose:
 * under vitest's jsdom the node:sqlite driver hands back ITS realm's
 * Uint8Array, which `instanceof Uint8Array` (jsdom's constructor) would
 * reject and silently drop every row. */
function decodeVector(value: unknown): Float32Array | null {
  if (value instanceof Float32Array) return value
  let bytes: Uint8Array | null = null
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView
    bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
  } else if (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "number")
  ) {
    bytes = Uint8Array.from(value as number[])
  }
  if (bytes === null || bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) {
    return null
  }
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4)
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/** One cosine hit. Scores are cosine similarities in [-1, 1]; vectors
 * being unit-length, the dot product IS the cosine. */
export interface VectorHit {
  threadId: string
  score: number
}

/**
 * Top-k cosine hits for one (L2-normalized) query vector over the
 * account's matrix. Descending score; the id tiebreak keeps the order
 * deterministic for tests and stable citations. An empty index or a
 * dimension mismatch (a stale query from another model) returns [].
 */
export function topCosine(
  index: AccountVectorIndex,
  queryVector: Float32Array,
  k: number
): VectorHit[] {
  if (k <= 0 || index.threadIds.length === 0) return []
  if (queryVector.length !== index.dim) return []
  const scored: VectorHit[] = []
  for (let row = 0; row < index.threadIds.length; row += 1) {
    const offset = row * index.dim
    let dot = 0
    for (let column = 0; column < index.dim; column += 1) {
      dot += queryVector[column] * index.matrix[offset + column]
    }
    scored.push({ threadId: index.threadIds[row], score: dot })
  }
  scored.sort(
    (a, b) => b.score - a.score || (a.threadId < b.threadId ? -1 : 1)
  )
  return scored.slice(0, k)
}

/**
 * The blend (design D2): cosine hits UNION the keyword (FTS operator)
 * hits, deduped by thread id — cosine order first (ranked by meaning),
 * then the FTS hits the cosine leg missed, in the keyword ranking's
 * order. `ftsScores` maps an FTS hit's thread id to its (optional)
 * similarity score; FTS-only hits carry null — they matched by keyword,
 * not by meaning, and inventing a number would lie. Capped at k.
 */
export function blendHits(
  cosineHits: readonly VectorHit[],
  ftsHits: readonly { threadId: string; score?: number | null }[],
  k: number
): { threadId: string; score: number | null }[] {
  const seen = new Set<string>()
  const blended: { threadId: string; score: number | null }[] = []
  for (const hit of cosineHits) {
    if (seen.has(hit.threadId)) continue
    seen.add(hit.threadId)
    blended.push({ threadId: hit.threadId, score: hit.score })
  }
  for (const hit of ftsHits) {
    if (blended.length >= k) break
    if (seen.has(hit.threadId)) continue
    seen.add(hit.threadId)
    blended.push({
      threadId: hit.threadId,
      score: typeof hit.score === "number" ? hit.score : null,
    })
  }
  return blended.slice(0, k)
}
