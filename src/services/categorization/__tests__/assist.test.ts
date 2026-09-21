import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The provider transport is the seam under mock: the REAL client module
// stays loaded (classifySenderWithAi's gate and the tier-resolving
// resolveSurfaceRuntime run for real) with aiChat replaced — the
// zero-call guarantee is asserted against this mock: a gated-off assist
// must leave it untouched.
const aiChatMock = vi.hoisted(() => vi.fn())

vi.mock("../../ai/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ai/client")>()
  return { ...actual, aiChat: aiChatMock }
})

import { classifySenderWithAi } from "../assist"
import { getAiCache, putAiCache, aiCacheStats } from "../../ai/cache"
import {
  addProvider,
  setActiveProvider,
  setAiEnabled,
  setSurfaceEnabled,
  setSurfaceTier,
  setTierModel,
} from "../../ai/settings"
import { getSenderCategory } from "../sender-categories"
import { createTestExecutor, type TestExecutor } from "../../db/__tests__/test-executor"
import { setDefaultKeyStore } from "../../crypto/key-management"
import { createInMemoryKeyStore } from "../../crypto/__tests__/in-memory-key-store"

/**
 * AI categorization assist unit tests (task 4.9, design D4): the gate
 * (zero provider calls when AI is unconfigured or the categorizationAssist
 * toggle is off — its default), the metadata-only prompt shape, the
 * sender cache (ai_cache kind "categorize-sender"), the sender_categories
 * row with source 'ai', reply validation and failure degradation. The
 * settings, cache and sender-categories services run REAL against
 * node:sqlite; only the transport is mocked.
 */

const SENDER = "news@x.example"

let executor: TestExecutor
let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  executor = createTestExecutor()
  setDefaultKeyStore(createInMemoryKeyStore())
  aiChatMock.mockReset()
  aiChatMock.mockResolvedValue("newsletters")
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  setDefaultKeyStore(null)
  executor.close()
})

/** AI enabled with an active keyed provider; assist toggle still OFF. */
async function seedActiveProvider(): Promise<string> {
  await setAiEnabled(executor, true)
  const created = await addProvider(executor, {
    kind: "anthropic",
    label: "Test",
    model: "test-model",
    apiKey: "sk-test",
  })
  await setActiveProvider(executor, created.id)
  return created.id
}

/** The full opt-in: provider active AND the assist surface on. */
async function enableAssist(): Promise<void> {
  await seedActiveProvider()
  await setSurfaceEnabled(executor, "categorizationAssist", true)
}

function lastCallArgs(): Record<string, unknown> {
  expect(aiChatMock).toHaveBeenCalled()
  return aiChatMock.mock.calls.at(-1)![0] as Record<string, unknown>
}

describe("the zero-call gate", () => {
  it("returns null and never invokes the provider when AI is unconfigured", async () => {
    await expect(
      classifySenderWithAi(executor, SENDER)
    ).resolves.toBeNull()
    // THE zero-call guarantee (spec "AI assist off"): the client mock is
    // untouched — no invoke was even attempted.
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it("returns null when the assist toggle is off (its default)", async () => {
    await seedActiveProvider() // categorizationAssist defaults to false
    await expect(
      classifySenderWithAi(executor, SENDER)
    ).resolves.toBeNull()
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it("returns null when AI is on but no provider is active", async () => {
    await setAiEnabled(executor, true)
    await setSurfaceEnabled(executor, "categorizationAssist", true)
    await expect(
      classifySenderWithAi(executor, SENDER)
    ).resolves.toBeNull()
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it("returns null for an empty sender without any call", async () => {
    await enableAssist()
    for (const empty of ["", "   "]) {
      await expect(classifySenderWithAi(executor, empty)).resolves.toBeNull()
    }
    expect(aiChatMock).not.toHaveBeenCalled()
  })
})

describe("classification, prompt and caching", () => {
  it("classifies the sender with a metadata-only prompt", async () => {
    await enableAssist()
    aiChatMock.mockResolvedValue("promotions")

    await expect(
      classifySenderWithAi(executor, SENDER, [
        "Weekly digest",
        "",
        "Weekly digest", // deduped
        "[announce] v2",
      ])
    ).resolves.toBe("promotions")

    const args = lastCallArgs()
    expect(args.surface).toBe("categorizationAssist")
    expect(args.maxTokens).toBeLessThanOrEqual(32)
    // Strict system prompt: bare id out, the five category ids named.
    const system = args.system as string
    expect(system).toContain("EXACTLY one word")
    for (const id of [
      "primary",
      "updates",
      "promotions",
      "social",
      "newsletters",
    ]) {
      expect(system).toContain(id)
    }
    // The user turn carries the sender + subject hints — metadata ONLY
    // (the spec's consent boundary). Assert the exact built prompt.
    expect(args.messages).toEqual([
      {
        role: "user",
        content: [
          `Sender address: ${SENDER}`,
          "Recent subject lines from this sender:",
          "- Weekly digest",
          "- [announce] v2",
          "Which category id? Reply with the bare id.",
        ].join("\n"),
      },
    ])
  })

  it("caps the prompt hints at five subjects", async () => {
    await enableAssist()
    await classifySenderWithAi(executor, SENDER, [
      "s1",
      "s2",
      "s3",
      "s4",
      "s5",
      "s6",
      "s7",
    ])
    const content = (lastCallArgs().messages as { content: string }[])[0]
      .content
    expect(content.match(/^- /gm)).toHaveLength(5)
  })

  it("stores the decision in ai_cache and in sender_categories with source 'ai'", async () => {
    await enableAssist()
    aiChatMock.mockResolvedValue("promotions")
    await classifySenderWithAi(executor, SENDER)

    const stats = await aiCacheStats(executor)
    expect(stats.total).toBe(1)
    expect(stats.byKind[0]).toMatchObject({
      kind: "categorize-sender",
      count: 1,
    })
    // The sender row the classifier's learned-override tier reads — the
    // decision survives assist being disabled later.
    await expect(getSenderCategory(executor, SENDER)).resolves.toEqual({
      category: "promotions",
      source: "ai",
    })
  })

  it("a repeat sender hits the cache — no second provider call", async () => {
    await enableAssist()
    await classifySenderWithAi(executor, SENDER, ["first subject"])
    await classifySenderWithAi(executor, SENDER, ["a different subject"])
    expect(aiChatMock).toHaveBeenCalledTimes(1)
    await expect(getSenderCategory(executor, SENDER)).resolves.toMatchObject({
      category: "newsletters",
    })
  })

  it("a corrupt cached value is a miss: re-asked and repaired", async () => {
    await enableAssist()
    await putAiCache(executor, {
      provider: "anthropic",
      model: "test-model",
      kind: "categorize-sender",
      input: SENDER,
      output: "banana", // corrupt: not a category
    })

    await expect(classifySenderWithAi(executor, SENDER)).resolves.toBe(
      "newsletters"
    )
    expect(aiChatMock).toHaveBeenCalledTimes(1)
    // The fresh decision overwrote the corrupt row.
    await expect(
      getAiCache(executor, {
        provider: "anthropic",
        model: "test-model",
        kind: "categorize-sender",
        input: SENDER,
      })
    ).resolves.toBe("newsletters")
  })

  it("tolerates quoted, cased and padded replies", async () => {
    await enableAssist()
    for (const [reply, expected] of [
      ['"Newsletters".', "newsletters"],
      ["  SOCIAL  ", "social"],
      ["Updates", "updates"],
      ["primary", "primary"],
    ] as const) {
      aiChatMock.mockResolvedValue(reply)
      await expect(
        classifySenderWithAi(executor, `${expected}-sender@x.example`)
      ).resolves.toBe(expected)
    }
  })

  it("a garbage reply returns null and writes nothing", async () => {
    await enableAssist()
    aiChatMock.mockResolvedValue(
      "I'd say this looks like promotions, hope that helps!"
    )
    await expect(classifySenderWithAi(executor, SENDER)).resolves.toBeNull()
    expect(aiChatMock).toHaveBeenCalledTimes(1) // the call was made...
    expect(await aiCacheStats(executor)).toMatchObject({ total: 0 }) // ...nothing cached
    await expect(getSenderCategory(executor, SENDER)).resolves.toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  it("a provider failure degrades to null without throwing", async () => {
    await enableAssist()
    aiChatMock.mockRejectedValue(new Error("provider down"))
    await expect(classifySenderWithAi(executor, SENDER)).resolves.toBeNull()
    await expect(getSenderCategory(executor, SENDER)).resolves.toBeNull()
    expect(warn).toHaveBeenCalled()
  })

  it("a cache-read failure degrades to a miss, not an error", async () => {
    await enableAssist()
    const failing = {
      select: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
        // Only the ai_cache lookups fail — the settings reads (the gate)
        // stay real, isolating the cache-miss degradation.
        if (sql.includes("ai_cache")) throw new Error("cache table missing")
        return executor.select<T>(sql, params)
      },
      execute: executor.execute.bind(executor),
    }
    await expect(
      classifySenderWithAi(failing, SENDER)
    ).resolves.toBe("newsletters")
    expect(aiChatMock).toHaveBeenCalledTimes(1)
  })
})

// Tier-model cache identity (parity-round-2 task 2.2): the resolved tier
// model keys the sender cache AND rides the request; a switch invalidates.
describe("classifySenderWithAi tier-model cache identity", () => {
  it("caches under and requests with the tier model, not the default", async () => {
    await enableAssist()
    await setSurfaceTier(executor, "categorizationAssist", "cheap")
    await setTierModel(executor, "cheap", "claude-haiku-x")

    const category = await classifySenderWithAi(executor, SENDER)
    expect(category).toBe("newsletters")
    expect(aiChatMock.mock.calls[0]?.[0]).toMatchObject({
      model: "claude-haiku-x",
    })
    const rows = await executor.select<{ model: string }>(
      "SELECT model FROM ai_cache"
    )
    expect(rows.map((row) => row.model)).toEqual(["claude-haiku-x"])

    // Repeat mail from the sender hits the tier-keyed cache.
    aiChatMock.mockClear()
    await classifySenderWithAi(executor, SENDER)
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it("a tier-model switch re-asks instead of serving the old entries", async () => {
    await enableAssist()
    await setSurfaceTier(executor, "categorizationAssist", "cheap")
    await setTierModel(executor, "cheap", "claude-haiku-x")
    aiChatMock.mockResolvedValue("newsletters")
    await classifySenderWithAi(executor, SENDER)

    aiChatMock.mockClear()
    await setTierModel(executor, "cheap", "claude-haiku-y")
    aiChatMock.mockResolvedValue("promotions")
    const category = await classifySenderWithAi(executor, SENDER)
    expect(aiChatMock).toHaveBeenCalledTimes(1)
    expect(category).toBe("promotions")
    const rows = await executor.select<{ model: string }>(
      "SELECT model FROM ai_cache"
    )
    expect(rows.map((row) => row.model).sort()).toEqual([
      "claude-haiku-x",
      "claude-haiku-y",
    ])
  })
})
