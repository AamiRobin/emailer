import type { SqlExecutor } from "../db/executor"

/**
 * AI usage accounting (parity-round-2 task 2.2, design D8) over the
 * `ai_usage` table (migration v14). One row per COMPLETED `ai_chat`
 * call, inserted by the shared client (client.ts) where the provider
 * response lands — fire-and-forget: a recording failure logs and
 * continues, it can never fail the AI call it accounts for.
 *
 * Tokens are the provider-reported numbers when the provider includes a
 * usage block (Rust passes them through on the command response); when
 * it does not, the estimate is chars/4 over the prompt text and the
 * completion (minimum 1), the same arithmetic the reference
 * implementation uses. `estimated` records which happened, so the
 * settings summary (task 2.3) can label estimated values "approx."
 * instead of presenting guesses as exact (design risk note: token
 * estimates mislead when providers omit usage).
 *
 * Rows carry no mailbox content — surface, model id, token counts and a
 * timestamp only. Deliberately not account-scoped: usage is a
 * device-level accounting trail (unlike ai_cache, whose account_id is a
 * purge key for derived content).
 *
 * Executor-first like every query module: production callers pass
 * getExecutor(); tests pass the node:sqlite test executor.
 */

/** The usage block of an `ai_chat` response — snake_case, matching the
 * Rust `ChatUsage` serialization. Every field optional: the block is
 * absent entirely when the provider did not report usage. */
export interface AiUsageWire {
  prompt_tokens?: unknown
  completion_tokens?: unknown
  total_tokens?: unknown
}

/** One `ai_usage` row, as the insert writes it. */
export interface AiUsageInput {
  /** The AI surface that made the request (AiSurface id). */
  surface: string
  /** The model that served the request (free id; null when unknown). */
  model: string | null
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** True when any side was estimated rather than provider-reported. */
  estimated: boolean
}

/** chars/4, rounding up, minimum 1 — the token estimate for one text. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

/** A provider-reported count: a finite non-negative number, else null. */
function reportedTokens(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null
}

/** The inputs `resolveUsageRecord` maps onto one row. */
export interface AiUsageRecordArgs {
  surface: string
  /** The model id the request was made with (tier-resolved or default). */
  model: string
  system?: string | null
  messages: ReadonlyArray<{ content: string }>
  /** The completion text (the response's content). */
  content: string
  /** The response's usage block, when the provider reported one. */
  usage?: AiUsageWire | null
}

/**
 * Map a completed call onto its usage row: provider-reported tokens when
 * both sides are reported, chars/4 estimates otherwise (each side
 * independently, mirroring the reference's `exact` semantics: the row is
 * exact only when BOTH sides are reported). The total is the provider's
 * total when given, else prompt + completion.
 */
export function resolveUsageRecord(args: AiUsageRecordArgs): AiUsageInput {
  const promptReported = reportedTokens(args.usage?.prompt_tokens)
  const completionReported = reportedTokens(args.usage?.completion_tokens)
  const totalReported = reportedTokens(args.usage?.total_tokens)
  const promptText = [args.system ?? "", ...args.messages.map((m) => m.content)]
    .filter((part) => part !== "")
    .join("\n")
  const promptTokens = promptReported ?? estimateTokens(promptText)
  const completionTokens = completionReported ?? estimateTokens(args.content)
  const totalTokens = totalReported ?? promptTokens + completionTokens
  return {
    surface: args.surface,
    model: args.model,
    promptTokens,
    completionTokens,
    totalTokens,
    estimated: promptReported === null || completionReported === null,
  }
}

/**
 * Insert one usage row. Never called for failed calls — only COMPLETED
 * `ai_chat` responses produce a row (a provider error has no tokens).
 */
export async function recordAiUsage(
  executor: SqlExecutor,
  input: AiUsageInput
): Promise<void> {
  await executor.execute(
    `INSERT INTO ai_usage (
       id, surface, model, prompt_tokens, completion_tokens,
       total_tokens, estimated
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      crypto.randomUUID(),
      input.surface,
      input.model,
      input.promptTokens,
      input.completionTokens,
      input.totalTokens,
      input.estimated ? 1 : 0,
    ]
  )
}

/** Per-surface aggregation, as the settings summary shows it. */
export interface AiUsageSurfaceStats {
  surface: string
  requests: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  /** How many of the aggregated rows carry estimated tokens — any
   * estimated row makes the surface's totals approximate. */
  estimatedRequests: number
}

export interface AiUsageSummary {
  totalRequests: number
  surfaces: AiUsageSurfaceStats[]
}

/** Per-surface request counts and token totals (SUM aggregation). */
export async function aiUsageSummary(
  executor: SqlExecutor
): Promise<AiUsageSummary> {
  const rows = await executor.select<{
    surface: string
    requests: number
    prompt_tokens: number | null
    completion_tokens: number | null
    total_tokens: number | null
    estimated_requests: number | null
  }>(
    `SELECT surface,
            COUNT(*) AS requests,
            COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
            COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(SUM(estimated), 0) AS estimated_requests
     FROM ai_usage
     GROUP BY surface
     ORDER BY requests DESC, surface ASC`
  )
  const surfaces = rows.map((row) => ({
    surface: row.surface,
    requests: row.requests,
    promptTokens: row.prompt_tokens ?? 0,
    completionTokens: row.completion_tokens ?? 0,
    totalTokens: row.total_tokens ?? 0,
    estimatedRequests: row.estimated_requests ?? 0,
  }))
  return {
    totalRequests: surfaces.reduce((sum, surface) => sum + surface.requests, 0),
    surfaces,
  }
}

/** Clear the whole usage trail (the settings summary's clear action). */
export async function clearAiUsage(executor: SqlExecutor): Promise<void> {
  await executor.execute("DELETE FROM ai_usage")
}
