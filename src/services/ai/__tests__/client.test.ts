import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The transport seam: the invoke mock stands in for @tauri-apps/api/core
// (the preferences.test.ts pattern), so the assertions target the exact
// wire arguments the client builds and how rejections normalize.
const invokeMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}))

const executorHolder = vi.hoisted(() => ({
  current: null as unknown,
}))

vi.mock("@/services/db/executor", () => ({
  getExecutor: () => {
    const executor = executorHolder.current
    if (!executor) throw new Error("test executor not set")
    return executor
  },
  placeholders: (count: number, firstIndex = 1): string =>
    Array.from({ length: count }, (_, index) => `$${index + firstIndex}`).join(
      ", "
    ),
}))

import {
  AiProviderError,
  AiUnavailableError,
  aiChat,
  resolveSurfaceModel,
  resolveSurfaceRuntime,
  testAiConnection,
} from "../client"
import {
  addProvider,
  getTierRouting,
  setActiveProvider,
  setAiEnabled,
  setSurfaceEnabled,
  setSurfaceTier,
  setTierModel,
  type AiTierRouting,
} from "../settings"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { setDefaultKeyStore } from "@/services/crypto/key-management"
import { createInMemoryKeyStore } from "@/services/crypto/__tests__/in-memory-key-store"

/**
 * AI client tests (task 4.2, design D1): gating (not-configured /
 * surface-disabled), the exact `ai_chat` wire call (unsealed key,
 * surface wire names), structured-error normalization, and the
 * connection test's specific success/failure reports. The settings
 * service runs REAL against node:sqlite, so the key path is the
 * production one: sealed at rest, unsealed only into the invoke args.
 *
 * Tier routing + usage (parity-round-2 task 2.2, D8): the model argument
 * is resolved surface → tier → tier model id (provider default on any
 * gap), and every completed call writes one `ai_usage` row — through the
 * REAL usage service here, so the row assertions cover the insert too.
 */

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
  executorHolder.current = executor
  setDefaultKeyStore(createInMemoryKeyStore())
  invokeMock.mockReset()
  invokeMock.mockResolvedValue({ content: "hello", model: "the-model" })
})

afterEach(() => {
  vi.restoreAllMocks()
  setDefaultKeyStore(null)
  executorHolder.current = null
  executor.close()
})

/** Enable AI, add a keyed provider, and make it active (the happy path). */
async function seedActiveProvider(
  overrides: Partial<Parameters<typeof addProvider>[1]> = {}
): Promise<string> {
  await setAiEnabled(executor, true)
  const created = await addProvider(executor, {
    kind: "anthropic",
    label: "Work",
    model: "claude-sonnet-4-5",
    apiKey: "sk-live-key-123",
    ...overrides,
  })
  await setActiveProvider(executor, created.id)
  return created.id
}

describe("aiChat gating", () => {
  it("throws not-configured and never invokes when nothing is configured", async () => {
    await expect(
      aiChat({ messages: [{ role: "user", content: "hi" }], surface: "summaries" })
    ).rejects.toMatchObject({
      name: "AiUnavailableError",
      reason: "not-configured",
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("throws not-configured when enabled but no provider is active", async () => {
    await setAiEnabled(executor, true)
    await addProvider(executor, {
      kind: "anthropic",
      label: "Work",
      model: "claude",
      apiKey: "k",
    })
    await expect(
      aiChat({ messages: [{ role: "user", content: "hi" }], surface: "summaries" })
    ).rejects.toMatchObject({ reason: "not-configured" })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("throws surface-disabled when the invoking surface's toggle is off", async () => {
    await seedActiveProvider()
    await setSurfaceEnabled(executor, "summaries", false)
    await expect(
      aiChat({ messages: [{ role: "user", content: "hi" }], surface: "summaries" })
    ).rejects.toMatchObject({
      name: "AiUnavailableError",
      reason: "surface-disabled",
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })
})

describe("aiChat transport", () => {
  it("invokes ai_chat with the runtime config, the UNSEALED key and the surface wire name", async () => {
    await seedActiveProvider()
    const content = await aiChat({
      system: "Be concise.",
      messages: [{ role: "user", content: "Summarize this" }],
      maxTokens: 256,
      surface: "summaries",
    })
    expect(content).toBe("hello")
    expect(invokeMock).toHaveBeenCalledTimes(1)
    const [command, args] = invokeMock.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ]
    expect(command).toBe("ai_chat")
    expect(args).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      system: "Be concise.",
      messages: [{ role: "user", content: "Summarize this" }],
      maxTokens: 256,
      surface: "summaries",
    })
    // The key arrives UNSEALED (the invoke is its only consumer) — never
    // the stored envelope string.
    expect(args.apiKey).toBe("sk-live-key-123")
    expect(args.baseUrl).toBeNull()
  })

  it("maps each surface id to its wire name (rate-limiter bucket)", async () => {
    await seedActiveProvider()
    // Categorization assist is the opt-in surface (default off).
    await setSurfaceEnabled(executor, "categorizationAssist", true)
    await aiChat({
      messages: [{ role: "user", content: "x" }],
      surface: "categorizationAssist",
    })
    await aiChat({
      messages: [{ role: "user", content: "x" }],
      surface: "smartReplies",
    })
    const surfaces = invokeMock.mock.calls.map(
      (call) => (call[1] as Record<string, unknown>).surface
    )
    expect(surfaces).toEqual(["categorization-assist", "smart-replies"])
  })

  it("sends the custom provider's base URL", async () => {
    await seedActiveProvider({
      kind: "custom",
      baseUrl: "https://gw.example.com/v1",
    })
    await aiChat({
      messages: [{ role: "user", content: "x" }],
      surface: "askInbox",
    })
    const args = invokeMock.mock.calls[0]![1] as Record<string, unknown>
    expect(args.provider).toBe("custom")
    expect(args.baseUrl).toBe("https://gw.example.com/v1")
    expect(args.surface).toBe("ask-inbox")
  })

  it("omits maxTokens/system when not given (Rust defaults apply)", async () => {
    await seedActiveProvider({ kind: "ollama", apiKey: undefined })
    await aiChat({
      messages: [{ role: "user", content: "x" }],
      surface: "taskExtraction",
    })
    const args = invokeMock.mock.calls[0]![1] as Record<string, unknown>
    expect(args.maxTokens).toBeNull()
    expect(args.system).toBeNull()
    // Ollama runs keyless: no key resolves, none is sent.
    expect(args.apiKey).toBeNull()
  })
})

describe("aiChat error normalization", () => {
  it("surfaces the structured Rust error as a typed AiProviderError", async () => {
    await seedActiveProvider()
    invokeMock.mockRejectedValue({
      kind: "rate_limited",
      message: "rate limited; retry in 30s",
    })
    const error = await aiChat({
      messages: [{ role: "user", content: "x" }],
      surface: "summaries",
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AiProviderError)
    expect(error).toMatchObject({
      name: "AiProviderError",
      kind: "rate_limited",
      message: "rate limited; retry in 30s",
    })
    expect((error as AiProviderError).status).toBeUndefined()
  })

  it("carries the HTTP status when the Rust error includes one", async () => {
    await seedActiveProvider()
    invokeMock.mockRejectedValue({
      kind: "status",
      message: "provider returned HTTP 401: invalid key",
      status: 401,
    })
    const error = await aiChat({
      messages: [{ role: "user", content: "x" }],
      surface: "summaries",
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AiProviderError)
    expect((error as AiProviderError).kind).toBe("status")
    expect((error as AiProviderError).status).toBe(401)
  })

  it("wraps an unstructured rejection (IPC failure) as kind network", async () => {
    await seedActiveProvider()
    invokeMock.mockRejectedValue(new Error("no IPC bridge"))
    const error = await aiChat({
      messages: [{ role: "user", content: "x" }],
      surface: "summaries",
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AiProviderError)
    expect((error as AiProviderError).kind).toBe("network")
    expect((error as AiProviderError).message).toBe("no IPC bridge")
  })

  it("does not throw AiProviderError for the gating failures (typed unavailable)", async () => {
    const error = await aiChat({
      messages: [{ role: "user", content: "x" }],
      surface: "summaries",
    }).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AiUnavailableError)
    expect(error).not.toBeInstanceOf(AiProviderError)
  })
})

describe("testAiConnection", () => {
  it("reports ok with a 1-token ping on the test surface", async () => {
    const id = await seedActiveProvider()
    const result = await testAiConnection(id)
    expect(result).toEqual({ ok: true })
    const [command, args] = invokeMock.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ]
    expect(command).toBe("ai_chat")
    expect(args).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 1,
      surface: "test",
    })
  })

  it("reports the specific structured failure reason without throwing", async () => {
    const id = await seedActiveProvider()
    invokeMock.mockRejectedValue({
      kind: "status",
      message: "provider returned HTTP 401: invalid x-api-key",
      status: 401,
    })
    const result = await testAiConnection(id)
    expect(result).toEqual({
      ok: false,
      reason: "provider returned HTTP 401: invalid x-api-key",
    })
  })

  it("reports local configuration gaps without a network round-trip", async () => {
    expect(await testAiConnection("nope")).toEqual({
      ok: false,
      reason: "This provider no longer exists.",
    })
    expect(invokeMock).not.toHaveBeenCalled()

    await setAiEnabled(executor, true)
    const noModel = await addProvider(executor, {
      kind: "anthropic",
      label: "A",
      model: "",
    })
    expect(await testAiConnection(noModel.id)).toEqual({
      ok: false,
      reason: "Choose a model id first.",
    })

    const noKey = await addProvider(executor, {
      kind: "openai",
      label: "B",
      model: "gpt-4.1",
    })
    expect(await testAiConnection(noKey.id)).toEqual({
      ok: false,
      reason: "Add an API key first.",
    })

    const noUrl = await addProvider(executor, {
      kind: "custom",
      label: "C",
      model: "m",
    })
    expect(await testAiConnection(noUrl.id)).toEqual({
      ok: false,
      reason: "Add the endpoint base URL first.",
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("tests a non-active provider too (test before activating)", async () => {
    await setAiEnabled(executor, true)
    const created = await addProvider(executor, {
      kind: "ollama",
      label: "Local",
      model: "llama3.1",
    })
    // Nothing active yet — the test still targets the given provider.
    const result = await testAiConnection(created.id)
    expect(result).toEqual({ ok: true })
    const args = invokeMock.mock.calls[0]![1] as Record<string, unknown>
    expect(args.provider).toBe("ollama")
    expect(args.apiKey).toBeNull()
    // Ollama's default endpoint is applied Rust-side; none is sent.
    expect(args.baseUrl).toBeNull()
  })
})

describe("tier routing (parity-round-2 task 2.2)", () => {
  /** The default routing (no tiers configured). */
  const defaultRouting: AiTierRouting = {
    tiers: {},
    surfaceTiers: {
      summaries: "cheap",
      smartReplies: "cheap",
      composeTransform: "intelligent",
      askInbox: "intelligent",
      taskExtraction: "cheap",
      categorizationAssist: "instant",
      quickReplies: "instant",
      ruleAssist: "cheap",
      eventExtraction: "cheap",
      translation: "cheap",
      folderDigest: "cheap",
      assistant: "intelligent",
    },
  }

  it("resolveSurfaceModel prefers the tier's model id and falls back to the default", () => {
    const routing: AiTierRouting = {
      tiers: { cheap: "qwen-cheap" },
      surfaceTiers: { ...defaultRouting.surfaceTiers, summaries: "cheap" },
    }
    expect(resolveSurfaceModel("summaries", routing, "claude-default")).toBe(
      "qwen-cheap"
    )
    // A tier with no model id → the provider's default (spec "Tier
    // fallback").
    expect(
      resolveSurfaceModel("askInbox", routing, "claude-default")
    ).toBe("claude-default")
    // A blank id behaves like no id.
    expect(
      resolveSurfaceModel("summaries", { ...routing, tiers: { cheap: "  " } }, "claude-default")
    ).toBe("claude-default")
  })

  it("uses the provider default model when no tiers are configured", async () => {
    await seedActiveProvider()
    await aiChat({
      messages: [{ role: "user", content: "x" }],
      surface: "summaries",
    })
    const args = invokeMock.mock.calls[0]![1] as Record<string, unknown>
    expect(args.model).toBe("claude-sonnet-4-5")
  })

  it("routes the surface through its configured tier model", async () => {
    await seedActiveProvider()
    // Spec scenario "Route by surface": summaries on intelligent with
    // model Y while another surface stays on the default.
    await setSurfaceTier(executor, "summaries", "intelligent")
    await setTierModel(executor, "intelligent", "claude-opus-y")
    await setTierModel(executor, "cheap", "claude-haiku-x")
    await aiChat({
      messages: [{ role: "user", content: "x" }],
      surface: "summaries",
    })
    await aiChat({
      messages: [{ role: "user", content: "x" }],
      surface: "taskExtraction",
    })
    const models = invokeMock.mock.calls.map(
      (call) => (call[1] as Record<string, unknown>).model
    )
    expect(models).toEqual(["claude-opus-y", "claude-haiku-x"])
  })

  it("falls back to the provider default when the tier has no model id", async () => {
    await seedActiveProvider()
    await setSurfaceTier(executor, "summaries", "intelligent")
    // No intelligent model id: the default model still serves the surface.
    await aiChat({
      messages: [{ role: "user", content: "x" }],
      surface: "summaries",
    })
    const args = invokeMock.mock.calls[0]![1] as Record<string, unknown>
    expect(args.model).toBe("claude-sonnet-4-5")
  })

  it("an unknown stored tier drops to the default tier mapping", async () => {
    await seedActiveProvider()
    await setTierModel(executor, "cheap", "claude-haiku-x")
    // A hand-edited row with an invalid tier: invalid entries drop on
    // decode, so summaries keeps its default (cheap) tier.
    await executor.execute(
      "UPDATE settings SET value = json_set(value, '$.surface_tiers.summaries', json('\"bogus\"')) WHERE key = 'ai.config'"
    )
    const routing = await getTierRouting(executor)
    expect(routing.surfaceTiers.summaries).toBe("cheap")
    await aiChat({
      messages: [{ role: "user", content: "x" }],
      surface: "summaries",
    })
    const args = invokeMock.mock.calls[0]![1] as Record<string, unknown>
    expect(args.model).toBe("claude-haiku-x")
  })

  it("resolveSurfaceRuntime returns the provider config with the tier-resolved model", async () => {
    await seedActiveProvider({ baseUrl: "https://gw.example.com/v1", kind: "custom" })
    // No tiers: the provider's default model.
    const plain = await resolveSurfaceRuntime(executor, "summaries")
    expect(plain).toMatchObject({
      provider: "custom",
      model: "claude-sonnet-4-5",
      baseUrl: "https://gw.example.com/v1",
    })
    // With a tier model configured, THAT is the resolved model.
    await setSurfaceTier(executor, "summaries", "intelligent")
    await setTierModel(executor, "intelligent", "claude-opus-y")
    const resolved = await resolveSurfaceRuntime(executor, "summaries")
    expect(resolved?.model).toBe("claude-opus-y")
    // A different surface on the default tier still gets the default.
    expect(
      (await resolveSurfaceRuntime(executor, "smartReplies"))?.model
    ).toBe("claude-sonnet-4-5")
    // Gate closed → null (the surfaces' fail-toward-off guard).
    await setAiEnabled(executor, false)
    expect(await resolveSurfaceRuntime(executor, "summaries")).toBeNull()
  })

  it("an explicitly passed model (the cache-identity value) is used verbatim", async () => {
    await seedActiveProvider()
    await setSurfaceTier(executor, "summaries", "intelligent")
    await setTierModel(executor, "intelligent", "claude-opus-y")
    // The surface resolved BEFORE the tier change: the passed value wins
    // over a re-resolution, so identity and request cannot diverge.
    await aiChat({
      messages: [{ role: "user", content: "x" }],
      surface: "summaries",
      model: "claude-opus-y",
    })
    const args = invokeMock.mock.calls[0]![1] as Record<string, unknown>
    expect(args.model).toBe("claude-opus-y")
  })
})

describe("usage recording (parity-round-2 task 2.2)", () => {
  async function usageRows(): Promise<
    {
      surface: string
      model: string | null
      prompt_tokens: number | null
      completion_tokens: number | null
      total_tokens: number | null
      estimated: number
    }[]
  > {
    // The insert is fire-and-forget: wait until the row lands (or a
    // warn is about to be printed).
    await vi.waitFor(
      async () => {
        const rows = await executor.select("SELECT * FROM ai_usage")
        expect(rows.length).toBeGreaterThan(0)
      },
      { timeout: 1000 }
    )
    return executor.select(
      "SELECT surface, model, prompt_tokens, completion_tokens, total_tokens, estimated FROM ai_usage"
    )
  }

  it("records provider-reported usage on the surface's resolved model", async () => {
    await seedActiveProvider()
    await setSurfaceTier(executor, "summaries", "intelligent")
    await setTierModel(executor, "intelligent", "claude-opus-y")
    invokeMock.mockResolvedValue({
      content: "hello",
      model: "claude-opus-y",
      usage: { prompt_tokens: 120, completion_tokens: 80, total_tokens: 200 },
    })
    await aiChat({
      system: "Be brief.",
      messages: [{ role: "user", content: "Summarize" }],
      surface: "summaries",
    })
    const rows = await usageRows()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      surface: "summaries",
      model: "claude-opus-y",
      prompt_tokens: 120,
      completion_tokens: 80,
      total_tokens: 200,
      estimated: 0,
    })
  })

  it("estimates chars/4 (min 1) and flags the row when the provider omits usage", async () => {
    await seedActiveProvider()
    await aiChat({
      system: "Be brief.",
      messages: [{ role: "user", content: "Summarize this thread" }],
      surface: "summaries",
    })
    const rows = await usageRows()
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.estimated).toBe(1)
    expect(row.surface).toBe("summaries")
    expect(row.model).toBe("the-model")
    const promptText = "Be brief.\nSummarize this thread"
    expect(row.prompt_tokens).toBe(Math.ceil(promptText.length / 4))
    expect(row.completion_tokens).toBe(Math.ceil("hello".length / 4))
    expect(row.total_tokens).toBe(
      (row.prompt_tokens ?? 0) + (row.completion_tokens ?? 0)
    )
  })

  it("a usage-recording failure never fails the AI call", async () => {
    await seedActiveProvider()
    // The usage service runs real here; dropping its table is the most
    // honest way to make the insert fail.
    await executor.execute("DROP TABLE ai_usage")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(
      aiChat({
        messages: [{ role: "user", content: "x" }],
        surface: "summaries",
      })
    ).resolves.toBe("hello")
    await vi.waitFor(() => expect(warn).toHaveBeenCalled(), { timeout: 1000 })
    expect(warn.mock.calls[0]?.[0]).toBe("[ai] failed to record the usage row")
  })
})
