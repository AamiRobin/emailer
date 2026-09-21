import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  aiUsageSummary,
  clearAiUsage,
  estimateTokens,
  recordAiUsage,
  resolveUsageRecord,
} from "../usage"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"

/**
 * AI usage service tests (parity-round-2 task 2.2, design D8): the
 * chars/4 estimate math, the reported-vs-estimated mapping, real inserts
 * against the migrated `ai_usage` table (node:sqlite), the per-surface
 * SUM aggregation, and the clear action.
 */

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
})

afterEach(() => {
  executor.close()
})

describe("estimateTokens", () => {
  it("rounds chars/4 up and never returns less than 1", () => {
    expect(estimateTokens("")).toBe(1)
    expect(estimateTokens("a")).toBe(1)
    expect(estimateTokens("abcd")).toBe(1)
    expect(estimateTokens("abcde")).toBe(2)
    expect(estimateTokens("x".repeat(400))).toBe(100)
  })
})

describe("resolveUsageRecord", () => {
  const baseArgs = {
    surface: "summaries",
    model: "claude-haiku",
    system: "Be brief.",
    messages: [{ content: "Summarize this" }],
    content: "A short summary.",
  }

  it("uses the provider-reported tokens and marks the row exact when both sides are reported", () => {
    const record = resolveUsageRecord({
      ...baseArgs,
      usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
    })
    expect(record).toEqual({
      surface: "summaries",
      model: "claude-haiku",
      promptTokens: 120,
      completionTokens: 80,
      totalTokens: 200,
      estimated: false,
    })
    // A missing total is computed from the reported sides — still exact.
    expect(
      resolveUsageRecord({
        ...baseArgs,
        usage: { prompt_tokens: 120, completion_tokens: 80 },
      })
    ).toMatchObject({
      promptTokens: 120,
      completionTokens: 80,
      totalTokens: 200,
      estimated: false,
    })
  })

  it("estimates with chars/4 (min 1) when the provider omits usage — estimated stays true", () => {
    const record = resolveUsageRecord({ ...baseArgs, usage: undefined })
    // Prompt text is system + message contents.
    const promptText = "Be brief.\nSummarize this"
    expect(record.promptTokens).toBe(estimateTokens(promptText))
    expect(record.completionTokens).toBe(estimateTokens("A short summary."))
    expect(record.totalTokens).toBe(
      record.promptTokens + record.completionTokens
    )
    expect(record.estimated).toBe(true)

    // Any single missing side makes the whole row estimated.
    expect(
      resolveUsageRecord({
        ...baseArgs,
        usage: { prompt_tokens: 120 },
      })
    ).toMatchObject({ estimated: true, promptTokens: 120 })
  })

  it("treats malformed usage fields as absent (estimates instead)", () => {
    const record = resolveUsageRecord({
      ...baseArgs,
      usage: {
        prompt_tokens: "lots",
        completion_tokens: -5,
        total_tokens: Number.NaN,
      },
    })
    expect(record.estimated).toBe(true)
    expect(record.promptTokens).toBe(estimateTokens("Be brief.\nSummarize this"))
    expect(record.completionTokens).toBe(estimateTokens("A short summary."))
  })
})

describe("recordAiUsage / aiUsageSummary / clearAiUsage", () => {
  it("writes one row per completed call and aggregates per surface", async () => {
    await recordAiUsage(executor, {
      surface: "summaries",
      model: "claude-haiku",
      promptTokens: 120,
      completionTokens: 80,
      totalTokens: 200,
      estimated: false,
    })
    await recordAiUsage(executor, {
      surface: "summaries",
      model: "claude-haiku",
      promptTokens: 30,
      completionTokens: 4,
      totalTokens: 34,
      estimated: true,
    })
    await recordAiUsage(executor, {
      surface: "askInbox",
      model: "claude-sonnet-4-5",
      promptTokens: 40,
      completionTokens: 20,
      totalTokens: 60,
      estimated: false,
    })

    const summary = await aiUsageSummary(executor)
    expect(summary.totalRequests).toBe(3)
    // Ordered by requests DESC, then surface ASC.
    expect(summary.surfaces).toEqual([
      {
        surface: "summaries",
        requests: 2,
        promptTokens: 150,
        completionTokens: 84,
        totalTokens: 234,
        estimatedRequests: 1,
      },
      {
        surface: "askInbox",
        requests: 1,
        promptTokens: 40,
        completionTokens: 20,
        totalTokens: 60,
        estimatedRequests: 0,
      },
    ])
  })

  it("reads an empty table as zero requests", async () => {
    expect(await aiUsageSummary(executor)).toEqual({
      totalRequests: 0,
      surfaces: [],
    })
  })

  it("clear removes every row", async () => {
    await recordAiUsage(executor, {
      surface: "summaries",
      model: "m",
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      estimated: true,
    })
    await clearAiUsage(executor)
    expect(await aiUsageSummary(executor)).toEqual({
      totalRequests: 0,
      surfaces: [],
    })
  })
})
