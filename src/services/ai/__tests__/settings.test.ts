import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  AI_SETTING_KEY,
  DEFAULT_SURFACE_TIERS,
  DEFAULT_SURFACES,
  addProvider,
  getActiveRuntimeConfig,
  getAiSettings,
  getTierRouting,
  isAiConfigured,
  isSurfaceEnabled,
  providerRequiresApiKey,
  removeProvider,
  resolveApiKey,
  setActiveProvider,
  setAiEnabled,
  setOutputLanguage,
  setProviderApiKey,
  setSurfaceEnabled,
  setSurfaceTier,
  setTierModel,
  updateProvider,
} from "../settings"
import { setSetting } from "@/services/db/settings"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { setDefaultKeyStore } from "@/services/crypto/key-management"
import { createInMemoryKeyStore } from "@/services/crypto/__tests__/in-memory-key-store"

/**
 * AI settings service tests (task 4.2, design D1): round-trips against
 * the real settings table (node:sqlite) plus the key-sealing contract —
 * the sealed-at-rest assertion reads the RAW row and asserts the stored
 * string is not the plaintext — and the fail-toward-off semantics for
 * corrupt rows.
 */

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
  // The credentials envelope needs a key store; the in-memory one keeps
  // the sealing path deterministic under vitest.
  setDefaultKeyStore(createInMemoryKeyStore())
})

afterEach(() => {
  setDefaultKeyStore(null)
  executor.close()
})

/** The raw stored row text (JSON as written by setSetting). */
async function rawRow(): Promise<string | undefined> {
  const rows = await executor.select<{ value: string }>(
    "SELECT value FROM settings WHERE key = $1",
    [AI_SETTING_KEY]
  )
  return rows[0]?.value
}

describe("defaults and corruption tolerance", () => {
  it("reads as disabled AI with default surfaces when no row exists", async () => {
    const settings = await getAiSettings(executor)
    expect(settings.enabled).toBe(false)
    expect(settings.activeProviderId).toBeNull()
    expect(settings.providers).toEqual([])
    expect(settings.surfaces).toEqual(DEFAULT_SURFACES)
    expect(settings.surfaces.categorizationAssist).toBe(false)
    expect(await isAiConfigured(executor)).toBe(false)
  })

  it("reads a corrupt (unparseable) row as disabled AI — fail toward off", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [AI_SETTING_KEY, "{not json at all"]
    )
    const settings = await getAiSettings(executor)
    expect(settings.enabled).toBe(false)
    expect(settings.providers).toEqual([])
    expect(await isAiConfigured(executor)).toBe(false)
  })

  it("reads a wrong-shape row (array, number) as disabled AI", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [AI_SETTING_KEY, JSON.stringify([1, 2, 3])]
    )
    expect((await getAiSettings(executor)).enabled).toBe(false)
    await executor.execute(
      "UPDATE settings SET value = $2 WHERE key = $1",
      [AI_SETTING_KEY, JSON.stringify(42)]
    )
    expect((await getAiSettings(executor)).enabled).toBe(false)
  })

  it("drops invalid provider entries but keeps the rest of the row", async () => {
    await setSetting(executor, AI_SETTING_KEY, {
      enabled: true,
      activeProviderId: "bad",
      providers: [
        { id: "bad", kind: "nope", label: "x", model: "m" },
        { id: "no-model-type", kind: "ollama", label: "y", model: 7 },
        {
          id: "keep",
          kind: "ollama",
          label: "Local",
          model: "llama3.1",
        },
      ],
      surfaces: "junk",
    })
    const settings = await getAiSettings(executor)
    expect(settings.providers.map((provider) => provider.id)).toEqual(["keep"])
    // The active pointer references a dropped entry: configured is false.
    expect(settings.activeProviderId).toBe("bad")
    expect(await isAiConfigured(executor)).toBe(false)
    // A junk surfaces blob falls back to the per-surface defaults.
    expect(settings.surfaces).toEqual(DEFAULT_SURFACES)
  })

  it("treats a blank/garbage apiKeySealed slot as no key", async () => {
    await setSetting(executor, AI_SETTING_KEY, {
      enabled: true,
      activeProviderId: "p1",
      providers: [
        {
          id: "p1",
          kind: "anthropic",
          label: "A",
          model: "claude",
          apiKeySealed: "   ",
        },
      ],
      surfaces: DEFAULT_SURFACES,
    })
    const settings = await getAiSettings(executor)
    expect(settings.providers[0]?.hasApiKey).toBe(false)
    expect(await resolveApiKey(executor, "p1")).toBeNull()
  })
})

describe("provider CRUD and key sealing", () => {
  it("adds a provider with the key sealed at rest — the raw row never holds plaintext", async () => {
    const created = await addProvider(executor, {
      kind: "anthropic",
      label: "Work",
      model: "  claude-sonnet-4-5  ",
      apiKey: "sk-plaintext-SECRET-123",
    })
    expect(created.model).toBe("claude-sonnet-4-5")
    expect(created.hasApiKey).toBe(true)

    // The view never carries key material at all.
    expect(created).not.toHaveProperty("apiKeySealed")
    expect(JSON.stringify(created)).not.toContain("sk-plaintext-SECRET-123")

    // And the raw stored row is sealed: not the plaintext anywhere.
    const raw = await rawRow()
    expect(raw).toBeDefined()
    expect(raw).not.toContain("sk-plaintext-SECRET-123")
    const stored = JSON.parse(raw!) as {
      providers: { apiKeySealed?: string }[]
    }
    const sealed = stored.providers[0]?.apiKeySealed
    expect(typeof sealed).toBe("string")
    expect(sealed).not.toBe("sk-plaintext-SECRET-123")
    expect((sealed as string).length).toBeGreaterThan(20)
  })

  it("lists providers as key-free views with hasApiKey only", async () => {
    await addProvider(executor, {
      kind: "openai",
      label: "Personal",
      model: "gpt-4.1",
      apiKey: "sk-openai-key",
    })
    await addProvider(executor, {
      kind: "ollama",
      label: "Local",
      model: "llama3.1",
    })
    const settings = await getAiSettings(executor)
    expect(settings.providers).toHaveLength(2)
    expect(settings.providers[0]).toMatchObject({
      kind: "openai",
      label: "Personal",
      model: "gpt-4.1",
      baseUrl: null,
      hasApiKey: true,
      disabled: false,
    })
    expect(settings.providers[1]?.hasApiKey).toBe(false)
    for (const provider of settings.providers) {
      expect(provider).not.toHaveProperty("apiKeySealed")
    }
  })

  it("setProviderApiKey replaces the sealed key; blank clears it", async () => {
    const created = await addProvider(executor, {
      kind: "gemini",
      label: "G",
      model: "gemini-2.5-flash",
      apiKey: "first-key",
    })
    expect(
      await setProviderApiKey(executor, created.id, "  second-key  ")
    ).toBe(true)
    expect(await resolveApiKey(executor, created.id)).toBe("second-key")

    // A blank key clears the slot entirely.
    expect(await setProviderApiKey(executor, created.id, "   ")).toBe(true)
    expect((await getAiSettings(executor)).providers[0]?.hasApiKey).toBe(false)
    expect(await resolveApiKey(executor, created.id)).toBeNull()

    // Unknown provider id: false, nothing written.
    expect(await setProviderApiKey(executor, "nope", "x")).toBe(false)
  })

  it("updateProvider edits metadata, preserves the key, and clears baseUrl with null", async () => {
    const created = await addProvider(executor, {
      kind: "custom",
      label: "Gateway",
      model: "gpt-4.1",
      baseUrl: "https://gw.example.com/v1",
      apiKey: "gateway-key",
    })
    const updated = await updateProvider(executor, created.id, {
      label: "  Work gateway  ",
      model: "  new-model  ",
      baseUrl: null,
    })
    expect(updated).toMatchObject({
      label: "Work gateway",
      model: "new-model",
      baseUrl: null,
      hasApiKey: true,
    })
    expect(await resolveApiKey(executor, created.id)).toBe("gateway-key")

    // Unknown id → null; nothing thrown.
    expect(
      await updateProvider(executor, "nope", { label: "x" })
    ).toBeNull()
  })

  it("removeProvider drops the provider and clears a dangling active pointer", async () => {
    const first = await addProvider(executor, {
      kind: "anthropic",
      label: "A",
      model: "m1",
      apiKey: "k1",
    })
    const second = await addProvider(executor, {
      kind: "ollama",
      label: "B",
      model: "m2",
    })
    await setActiveProvider(executor, second.id)
    await removeProvider(executor, second.id)
    const settings = await getAiSettings(executor)
    expect(settings.providers.map((provider) => provider.id)).toEqual([
      first.id,
    ])
    expect(settings.activeProviderId).toBeNull()
    expect(await isAiConfigured(executor)).toBe(false)
  })
})

describe("active provider and configured semantics", () => {
  it("isAiConfigured is true only when enabled AND an active provider with a model exists", async () => {
    const created = await addProvider(executor, {
      kind: "anthropic",
      label: "A",
      model: "claude",
      apiKey: "k",
    })
    // Provider exists but AI is off and nothing is active.
    expect(await isAiConfigured(executor)).toBe(false)

    await setAiEnabled(executor, true)
    expect(await isAiConfigured(executor)).toBe(false)

    await setActiveProvider(executor, created.id)
    expect(await isAiConfigured(executor)).toBe(true)

    // Blank the model: configured flips false (the spec's fail-toward-off).
    await updateProvider(executor, created.id, { model: "   " })
    expect(await isAiConfigured(executor)).toBe(false)
  })

  it("a disabled provider is never eligible as the active runtime", async () => {
    await setSetting(executor, AI_SETTING_KEY, {
      enabled: true,
      activeProviderId: "off",
      providers: [
        {
          id: "off",
          kind: "openai",
          label: "Off",
          model: "gpt",
          disabled: true,
        },
      ],
      surfaces: DEFAULT_SURFACES,
    })
    expect(await isAiConfigured(executor)).toBe(false)
    expect(await getActiveRuntimeConfig(executor)).toBeNull()
  })

  it("setActiveProvider ignores unknown ids and accepts null", async () => {
    const created = await addProvider(executor, {
      kind: "anthropic",
      label: "A",
      model: "m",
    })
    await setActiveProvider(executor, "nope")
    expect((await getAiSettings(executor)).activeProviderId).toBeNull()
    await setActiveProvider(executor, created.id)
    expect((await getAiSettings(executor)).activeProviderId).toBe(created.id)
    await setActiveProvider(executor, null)
    expect((await getAiSettings(executor)).activeProviderId).toBeNull()
  })

  it("getActiveRuntimeConfig returns the trimmed kind/model/baseUrl shape", async () => {
    await setAiEnabled(executor, true)
    const created = await addProvider(executor, {
      kind: "custom",
      label: "Gateway",
      model: "  gpt-4.1  ",
      baseUrl: "  https://gw.example.com/v1  ",
    })
    await setActiveProvider(executor, created.id)
    expect(await getActiveRuntimeConfig(executor)).toEqual({
      id: created.id,
      provider: "custom",
      model: "gpt-4.1",
      baseUrl: "https://gw.example.com/v1",
    })

    // No baseUrl → the field is absent (the client sends no override).
    const plain = await addProvider(executor, {
      kind: "anthropic",
      label: "A",
      model: "claude",
    })
    await setActiveProvider(executor, plain.id)
    const runtime = await getActiveRuntimeConfig(executor)
    expect(runtime).toEqual({
      id: plain.id,
      provider: "anthropic",
      model: "claude",
    })
    expect("baseUrl" in (runtime ?? {})).toBe(false)
  })
})

describe("surface toggles", () => {
  it("surfaces default on (categorization assist off) once AI is enabled", async () => {
    await setAiEnabled(executor, true)
    expect(await isSurfaceEnabled(executor, "summaries")).toBe(true)
    expect(await isSurfaceEnabled(executor, "categorizationAssist")).toBe(
      false
    )
    // Master switch off: every surface reads disabled, whatever the row says.
    await setAiEnabled(executor, false)
    expect(await isSurfaceEnabled(executor, "summaries")).toBe(false)
  })

  it("setSurfaceEnabled flips one surface and leaves the others", async () => {
    await setAiEnabled(executor, true)
    await setSurfaceEnabled(executor, "summaries", false)
    expect(await isSurfaceEnabled(executor, "summaries")).toBe(false)
    expect(await isSurfaceEnabled(executor, "smartReplies")).toBe(true)
    expect(await isSurfaceEnabled(executor, "composeTransform")).toBe(true)
    // Categorization assist can be opted into.
    await setSurfaceEnabled(executor, "categorizationAssist", true)
    expect(await isSurfaceEnabled(executor, "categorizationAssist")).toBe(true)
  })

  it("missing or non-boolean surface flags fall back to that surface's default", async () => {
    await setSetting(executor, AI_SETTING_KEY, {
      enabled: true,
      activeProviderId: null,
      providers: [],
      // taskExtraction missing, summaries junk, categorizationAssist absent.
      surfaces: {
        summaries: "yes",
        taskExtraction: undefined,
        categorizationAssist: undefined,
      },
    })
    expect(await isSurfaceEnabled(executor, "summaries")).toBe(true)
    expect(await isSurfaceEnabled(executor, "taskExtraction")).toBe(true)
    expect(await isSurfaceEnabled(executor, "categorizationAssist")).toBe(false)
  })
})

describe("resolveApiKey (internal, client-only)", () => {
  it("unseals the stored key for the right provider only", async () => {
    const a = await addProvider(executor, {
      kind: "anthropic",
      label: "A",
      model: "m",
      apiKey: "sk-key-A",
    })
    const b = await addProvider(executor, {
      kind: "openai",
      label: "B",
      model: "m",
      apiKey: "sk-key-B",
    })
    expect(await resolveApiKey(executor, a.id)).toBe("sk-key-A")
    expect(await resolveApiKey(executor, b.id)).toBe("sk-key-B")
    expect(await resolveApiKey(executor, "unknown")).toBeNull()
  })

  it("returns null for a legacy-plaintext or corrupt sealed slot — never the raw value", async () => {
    await setSetting(executor, AI_SETTING_KEY, {
      enabled: true,
      activeProviderId: null,
      providers: [
        {
          id: "legacy",
          kind: "anthropic",
          label: "L",
          model: "m",
          apiKeySealed: "plain-old-key",
        },
        {
          id: "corrupt",
          kind: "anthropic",
          label: "C",
          model: "m",
          apiKeySealed: "not-an-envelope-but-long",
        },
      ],
      surfaces: DEFAULT_SURFACES,
    })
    // Both fail decryption; both read as "no key" rather than exposing
    // the undecryptable value.
    expect(await resolveApiKey(executor, "legacy")).toBeNull()
    expect(await resolveApiKey(executor, "corrupt")).toBeNull()
  })
})

describe("providerRequiresApiKey", () => {
  it("the vendor kinds need keys; ollama and custom do not require one", () => {
    expect(providerRequiresApiKey("anthropic")).toBe(true)
    expect(providerRequiresApiKey("openai")).toBe(true)
    expect(providerRequiresApiKey("gemini")).toBe(true)
    expect(providerRequiresApiKey("ollama")).toBe(false)
    expect(providerRequiresApiKey("custom")).toBe(false)
  })
})

// -------------------------------------------------------------------------
// Tiers, surface tiers and output language (parity-round-2 task 2.1, D8)
// -------------------------------------------------------------------------

describe("tier envelope defaults and back-compat", () => {
  it("an absent row reads as empty tiers, default surface tiers and unset language", async () => {
    const settings = await getAiSettings(executor)
    expect(settings.tiers).toEqual({})
    expect(settings.surfaceTiers).toEqual(DEFAULT_SURFACE_TIERS)
    expect(settings.surfaceTiers.summaries).toBe("cheap")
    expect(settings.surfaceTiers.categorizationAssist).toBe("instant")
    expect(settings.surfaceTiers.askInbox).toBe("intelligent")
    expect(settings.outputLanguage).toBeNull()
    expect(await getTierRouting(executor)).toEqual({
      tiers: {},
      surfaceTiers: DEFAULT_SURFACE_TIERS,
    })
  })

  it("a pre-tier row (no new keys) keeps working — every addition defaults", async () => {
    await setSetting(executor, AI_SETTING_KEY, {
      enabled: true,
      activeProviderId: null,
      providers: [],
      surfaces: DEFAULT_SURFACES,
    })
    const settings = await getAiSettings(executor)
    expect(settings.enabled).toBe(true)
    expect(settings.tiers).toEqual({})
    expect(settings.surfaceTiers).toEqual(DEFAULT_SURFACE_TIERS)
    expect(settings.outputLanguage).toBeNull()
  })

  it("malformed tier additions fail toward the defaults, valid entries survive", async () => {
    await setSetting(executor, AI_SETTING_KEY, {
      enabled: true,
      activeProviderId: null,
      providers: [],
      surfaces: DEFAULT_SURFACES,
      tiers: "junk",
      surface_tiers: 42,
      output_language: 7,
    })
    let settings = await getAiSettings(executor)
    expect(settings.tiers).toEqual({})
    expect(settings.surfaceTiers).toEqual(DEFAULT_SURFACE_TIERS)
    expect(settings.outputLanguage).toBeNull()

    // Same row with partial junk inside otherwise-valid shapes: only the
    // valid (tier, surface) entries survive.
    await setSetting(executor, AI_SETTING_KEY, {
      enabled: true,
      activeProviderId: null,
      providers: [],
      surfaces: DEFAULT_SURFACES,
      tiers: {
        instant: "  qwen-fast  ",
        cheap: 7,
        intelligent: "   ",
        bogus: "not-a-tier-key",
      },
      surface_tiers: {
        summaries: "intelligent",
        smartReplies: "supersonic",
        askInbox: 3,
      },
      output_language: "  German  ",
    })
    settings = await getAiSettings(executor)
    expect(settings.tiers).toEqual({ instant: "qwen-fast" })
    expect(settings.surfaceTiers.summaries).toBe("intelligent")
    expect(settings.surfaceTiers.smartReplies).toBe(
      DEFAULT_SURFACE_TIERS.smartReplies
    )
    expect(settings.surfaceTiers.askInbox).toBe(DEFAULT_SURFACE_TIERS.askInbox)
    expect(settings.outputLanguage).toBe("German")
  })
})

describe("tier mutations", () => {
  it("setSurfaceTier persists one surface and leaves the others at their defaults", async () => {
    await setSurfaceTier(executor, "summaries", "intelligent")
    await setSurfaceTier(executor, "categorizationAssist", "cheap")
    const routing = await getTierRouting(executor)
    expect(routing.surfaceTiers.summaries).toBe("intelligent")
    expect(routing.surfaceTiers.categorizationAssist).toBe("cheap")
    expect(routing.surfaceTiers.smartReplies).toBe(
      DEFAULT_SURFACE_TIERS.smartReplies
    )
    // The view agrees with the routing read.
    expect((await getAiSettings(executor)).surfaceTiers).toEqual(
      routing.surfaceTiers
    )
  })

  it("setTierModel stores trimmed ids and a blank id clears the tier (fallback)", async () => {
    await setTierModel(executor, "cheap", "  claude-haiku  ")
    expect((await getAiSettings(executor)).tiers).toEqual({
      cheap: "claude-haiku",
    })
    await setTierModel(executor, "instant", "qwen-fast")
    expect((await getAiSettings(executor)).tiers).toEqual({
      cheap: "claude-haiku",
      instant: "qwen-fast",
    })
    // Blank clears only its own tier.
    await setTierModel(executor, "cheap", "   ")
    expect((await getAiSettings(executor)).tiers).toEqual({
      instant: "qwen-fast",
    })
  })

  it("setOutputLanguage trims, and clears on null or blank", async () => {
    await setOutputLanguage(executor, "  German  ")
    expect((await getAiSettings(executor)).outputLanguage).toBe("German")
    await setOutputLanguage(executor, null)
    expect((await getAiSettings(executor)).outputLanguage).toBeNull()
    await setOutputLanguage(executor, "French")
    await setOutputLanguage(executor, "   ")
    expect((await getAiSettings(executor)).outputLanguage).toBeNull()
  })

  it("tier writes keep the sealed key sealed — model ids are stored plainly, keys never", async () => {
    const created = await addProvider(executor, {
      kind: "anthropic",
      label: "Work",
      model: "claude",
      apiKey: "sk-plaintext-TIER-TEST-9",
    })
    await setActiveProvider(executor, created.id)
    await setSurfaceTier(executor, "summaries", "intelligent")
    await setTierModel(executor, "intelligent", "claude-opus")
    await setOutputLanguage(executor, "German")

    const raw = await rawRow()
    expect(raw).toBeDefined()
    expect(raw).not.toContain("sk-plaintext-TIER-TEST-9")
    // Model ids are NOT secrets: they are stored in the clear.
    expect(raw).toContain("claude-opus")
    expect(await resolveApiKey(executor, created.id)).toBe(
      "sk-plaintext-TIER-TEST-9"
    )
    expect((await getAiSettings(executor)).providers[0]?.hasApiKey).toBe(true)
  })
})
