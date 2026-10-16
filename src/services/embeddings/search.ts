import { searchThreadsAcrossAccounts } from "@/services/search"
import { placeholders } from "@/services/db/executor"
import type { SqlExecutor } from "@/services/db/executor"
import { EmbedTextsError, embedTexts } from "./indexer"
import {
  blendHits,
  loadAccountIndex,
  topCosine,
} from "./loader"
import { getBgeModelDir, modelFilesPresent } from "./model"
import { isSemanticSearchEnabled } from "./settings"

/**
 * The semantic search entry (parity-round-3 design D1/D2, tasks 6.3/
 * 6.4): a natural-language query becomes one embedded vector (the BGE
 * query-side instruction prefixed — the upstream v1.5 retrieval recipe),
 * cosine-ranked per active account over the in-memory matrices (task
 * 6.3), then BLENDED with the existing FTS operator hits (cosine ∪
 * keyword, deduped by thread) so meaning-based and exact-word matches
 * both surface. This is what the assistant's `semantic_search` tool and
 * the inbox seed block consume.
 *
 * Degradation is a first-class result, never an error (spec "Feature
 * disabled"): feature off, model missing, no vectors, an unusable model
 * mid-call — all resolve to [], and the assistant behaves exactly as
 * before. Only unexpected rejections (an executor failure) propagate to
 * the tool layer's own degradation handling.
 */

/** BGE v1.5's query-side instruction (upstream retrieval recipe): the
 * short query becomes retrieval-shaped; documents are embedded bare. */
export const QUERY_INSTRUCTION =
  "Represent this sentence for searching relevant passages: "

/** Default result count for the assistant tool. */
export const DEFAULT_SEMANTIC_K = 8

/** One blended hit, with the thread's display fields resolved (ONE
 * threads lookup for the whole blend) so both prompt consumers — the
 * tool payload and the seed block — format rows the same way. */
export interface SemanticSearchHit {
  threadId: string
  score: number | null
  subject: string | null
  snippet: string | null
}

export interface SemanticSearchOptions {
  /** Max blended hits (default DEFAULT_SEMANTIC_K). */
  k?: number
  /** Include the keyword leg (default true — the D2 blend; tests may
   * isolate the cosine leg). */
  withKeywordLeg?: boolean
}

/**
 * Whether the semantic index can answer right now (feature enabled AND
 * the model downloaded) — the degradation gate as a public read, so the
 * assistant's tool payload can say WHICH zero it got ("no matches" vs
 * "no index — fall back to the keyword tools") without re-running the
 * search.
 */
export async function isSemanticIndexAvailable(
  executor: SqlExecutor
): Promise<boolean> {
  return (
    (await isSemanticSearchEnabled(executor)) &&
    (await modelFilesPresent(executor))
  )
}

/**
 * Search the semantic index across the given accounts, blended with the
 * operator-grammar FTS hits for the same query. Empty query or empty
 * account set → [] (the FTS leg's own rule).
 */
export async function semanticSearchThreads(
  executor: SqlExecutor,
  accountIds: string[],
  query: string,
  options?: SemanticSearchOptions
): Promise<SemanticSearchHit[]> {
  const k = Math.max(1, Math.floor(options?.k ?? DEFAULT_SEMANTIC_K))
  const trimmed = query.trim()
  if (trimmed === "" || accountIds.length === 0) return []

  // Degradation gates: feature off or model absent → the caller sees [].
  if (
    !(await isSemanticSearchEnabled(executor)) ||
    !(await modelFilesPresent(executor))
  ) {
    return []
  }

  // The keyword leg FIRST (cheap, local): its rows double as the blend's
  // second source AND a snippet provider.
  const ftsRows =
    options?.withKeywordLeg === false
      ? []
      : await searchThreadsAcrossAccounts(executor, accountIds, trimmed, {
          limit: k,
        }).catch(() => []) // a keyword-leg failure degrades, never throws
  const ftsById = new Map(ftsRows.map((row) => [row.id, row]))

  // The cosine leg: one query embed, top-k per account, cross-account
  // ranking (highest similarity first, id tiebreak — the loader's own
  // sort rule applied across accounts).
  const cosine: { threadId: string; score: number }[] = []
  try {
    const modelDir = await getBgeModelDir()
    const [queryVector] = await embedTexts(modelDir, [
      QUERY_INSTRUCTION + trimmed,
    ])
    if (queryVector) {
      const vector = new Float32Array(queryVector)
      for (const accountId of accountIds) {
        const index = await loadAccountIndex(executor, accountId)
        if (!index) continue
        cosine.push(...topCosine(index, vector, k))
      }
      cosine.sort(
        (a, b) => b.score - a.score || (a.threadId < b.threadId ? -1 : 1)
      )
    }
  } catch (error) {
    if (
      error instanceof EmbedTextsError &&
      (error.kind === "model_missing" || error.kind === "config")
    ) {
      // Model gone / unusable under a still-enabled feature: degrade to
      // the keyword leg (or nothing), never an error surface.
      return ftsRows.map((row) => ({
        threadId: row.id,
        score: null,
        subject: row.subject,
        snippet: row.snippet,
      }))
    }
    throw error
  }

  const blended = blendHits(
    cosine,
    ftsRows.map((row) => ({ threadId: row.id })),
    k
  )

  // Resolve subject + snippet for every blended hit in ONE threads
  // query (the keyword rows carry theirs; cosine-only threads read the
  // thread row here).
  const blendedIds = blended.map((hit) => hit.threadId)
  if (blendedIds.length === 0) return []
  const threadRows = new Map(
    (
      await executor.select<{
        id: string
        subject: string | null
        snippet: string | null
      }>(
        `SELECT id, subject, snippet FROM threads
         WHERE id IN (${placeholders(blendedIds.length)})`,
        blendedIds
      )
    ).map((row) => [row.id, row])
  )
  return blended.map((hit) => {
    const row = threadRows.get(hit.threadId)
    const ftsRow = ftsById.get(hit.threadId)
    return {
      threadId: hit.threadId,
      score: hit.score,
      subject: ftsRow?.subject ?? row?.subject ?? null,
      snippet: ftsRow?.snippet ?? row?.snippet ?? null,
    }
  })
}
