import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"

/**
 * AI settings section tests (task 4.2). Same executor-injection pattern
 * as the other settings suites: the executor module is mocked to hand
 * the section a seeded node:sqlite executor and the REAL 4.2 services
 * run — row assertions read back through getAiSettings/the raw settings
 * table. The `ai_chat` invoke is mocked at the core-module seam to
 * control connection-test outcomes.
 */

const executorHolder = vi.hoisted(() => ({
  current: null as unknown,
}))

const invokeHolder = vi.hoisted(() => ({
  invoke: vi.fn(),
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

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeHolder.invoke,
}))

// The style-profile builder (task 4.5) is mocked at its module seam: the
// block's UI contract (status, consent copy, rebuild completion report,
// delete) is under test here — the builder itself has its own suite.
const styleProfileMocks = vi.hoisted(() => ({
  loadStyleProfile: vi.fn(),
  buildWritingStyleProfile: vi.fn(),
  deleteStyleProfile: vi.fn(),
}))

vi.mock("@/services/ai/style-profile", () => ({
  loadStyleProfile: styleProfileMocks.loadStyleProfile,
  buildWritingStyleProfile: styleProfileMocks.buildWritingStyleProfile,
  deleteStyleProfile: styleProfileMocks.deleteStyleProfile,
}))

import { aiCacheStats, putAiCache } from "@/services/ai/cache"
import {
  getAiSettings,
  addProvider,
  getTierRouting,
  isSurfaceEnabled,
  setAiEnabled,
  AI_SETTING_KEY,
} from "@/services/ai/settings"
import { aiUsageSummary, recordAiUsage } from "@/services/ai/usage"
import { useAccountStore } from "@/stores/account-store"
import { setSetting } from "@/services/db/settings"
import { setDefaultKeyStore } from "@/services/crypto/key-management"
import { createInMemoryKeyStore } from "@/services/crypto/__tests__/in-memory-key-store"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { AiSection } from "../ai-section"

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
  executorHolder.current = executor
  setDefaultKeyStore(createInMemoryKeyStore())
  invokeHolder.invoke.mockReset()
  invokeHolder.invoke.mockResolvedValue({ content: "pong", model: "m" })
})

afterEach(() => {
  cleanup()
  executorHolder.current = null
  setDefaultKeyStore(null)
  executor.close()
})

async function rawRow(): Promise<string | undefined> {
  const rows = await executor.select<{ value: string }>(
    "SELECT value FROM settings WHERE key = $1",
    [AI_SETTING_KEY]
  )
  return rows[0]?.value
}

/** Base UI Select ignores synthetic clicks that did not start with a
 * pointerdown on the item (drag-select guard), so send both. */
async function chooseOption(name: string): Promise<void> {
  const option = await screen.findByRole("option", { name })
  fireEvent.pointerDown(option)
  fireEvent.click(option)
}

function masterSwitch(): HTMLElement {
  return screen.getByRole("switch", { name: "AI assistance" })
}

describe("AiSection (task 4.2)", () => {
  it("renders off by default with everything behind the note", async () => {
    render(<AiSection />)
    expect(
      await screen.findByRole("heading", { name: "AI assistance" })
    ).toBeTruthy()
    await waitFor(() =>
      expect(masterSwitch().getAttribute("aria-checked")).toBe("false")
    )
    // No provider affordances while AI is off — the note explains why.
    expect(screen.queryByRole("button", { name: "Add provider" })).toBeNull()
    expect(screen.queryByTestId("ai-provider-row")).toBeNull()
    expect(screen.getByText(/Turn AI assistance on to configure/)).toBeTruthy()
    // The off copy states the consent posture.
    expect(
      screen.getByText(/nothing is ever sent to a provider/i)
    ).toBeTruthy()
    expect(await getAiSettings(executor)).toMatchObject({
      enabled: false,
      activeProviderId: null,
      providers: [],
    })
  })

  it("enabling persists and reveals the empty list, surface toggles and cache", async () => {
    render(<AiSection />)
    await waitFor(() =>
      expect(masterSwitch().getAttribute("aria-checked")).toBe("false")
    )
    fireEvent.click(masterSwitch())

    expect(await screen.findByText(/No providers configured yet/)).toBeTruthy()
    await waitFor(async () => {
      expect((await getAiSettings(executor)).enabled).toBe(true)
    })

    // All eleven surface toggles render; all default ON except
    // categorization assist, the opt-in one (off). The parity-round-2
    // additions (quick replies, natural-language rules) and the
    // add-ai-surfaces additions (event extraction, translate, digest)
    // register like the originals: default ON, individually toggleable.
    for (const [name, checked] of [
      ["Thread summaries", "true"],
      ["Smart replies", "true"],
      ["Compose transforms", "true"],
      ["Ask My Inbox", "true"],
      ["Task extraction", "true"],
      ["Categorization assist (opt-in)", "false"],
      ["Quick replies", "true"],
      ["Natural-language rules", "true"],
      ["Event extraction", "true"],
      ["Translate", "true"],
      ["Catch-me-up digest", "true"],
    ] as const) {
      const toggle = screen.getByRole("switch", { name })
      expect(toggle.getAttribute("aria-checked")).toBe(checked)
    }
    expect(screen.getByTestId("ai-cache-stats").textContent).toContain(
      "0 cached results"
    )
  })

  it("the add flow creates a keyed provider — sealed at rest, plaintext only in the form", async () => {
    render(<AiSection />)
    fireEvent.click(await screen.findByRole("switch", { name: "AI assistance" }))
    fireEvent.click(await screen.findByRole("button", { name: "Add provider" }))

    const dialog = await screen.findByTestId("ai-provider-dialog")
    const nameInput = within(dialog).getByLabelText("Name") as HTMLInputElement
    expect(nameInput.value).toBe("Anthropic")
    const keyInput = within(dialog).getByLabelText("API key") as HTMLInputElement
    expect((keyInput as HTMLInputElement).type).toBe("password")

    const saveButton = within(dialog).getByRole("button", {
      name: "Add provider",
    }) as HTMLButtonElement
    // Model + key are required for a vendor kind: Save stays disabled.
    expect(saveButton.disabled).toBe(true)

    fireEvent.change(within(dialog).getByLabelText("Model id"), {
      target: { value: "claude-sonnet-4-5" },
    })
    expect(saveButton.disabled).toBe(true)
    fireEvent.change(keyInput, { target: { value: "sk-form-only-123" } })
    expect(saveButton.disabled).toBe(false)
    fireEvent.click(saveButton)

    await waitFor(() => {
      expect(screen.queryByTestId("ai-provider-dialog")).toBeNull()
    })
    const row = await screen.findByTestId("ai-provider-row")
    expect(row.textContent).toContain("Anthropic")
    expect(row.textContent).toContain("claude-sonnet-4-5")
    expect(row.textContent).toContain("key saved")

    // Stored configured with a key; the raw row holds no plaintext.
    const settings = await getAiSettings(executor)
    expect(settings.providers[0]).toMatchObject({
      kind: "anthropic",
      model: "claude-sonnet-4-5",
      hasApiKey: true,
    })
    const raw = await rawRow()
    expect(raw).not.toContain("sk-form-only-123")
    expect(JSON.stringify(settings)).not.toContain("sk-form-only-123")
  })

  it("the add flow for Ollama hides the key field and shows the local note", async () => {
    render(<AiSection />)
    fireEvent.click(await screen.findByRole("switch", { name: "AI assistance" }))
    fireEvent.click(await screen.findByRole("button", { name: "Add provider" }))
    const dialog = await screen.findByTestId("ai-provider-dialog")

    fireEvent.click(
      within(dialog).getByRole("combobox", { name: "Provider type" })
    )
    await chooseOption("Ollama (local)")

    // Keyless: no key field, the local-only note instead.
    expect(within(dialog).queryByLabelText("API key")).toBeNull()
    expect(
      within(dialog).getByText(/never leave your computer/i)
    ).toBeTruthy()

    fireEvent.change(within(dialog).getByLabelText("Model id"), {
      target: { value: "llama3.1" },
    })
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Add provider" }) as HTMLButtonElement
    )

    const row = await screen.findByTestId("ai-provider-row")
    expect(row.textContent).toContain("Ollama (local)")
    expect(row.textContent).toContain("no key needed")
    expect((await getAiSettings(executor)).providers[0]?.hasApiKey).toBe(false)
  })

  it("the custom kind requires a base URL and stores it", async () => {
    render(<AiSection />)
    fireEvent.click(await screen.findByRole("switch", { name: "AI assistance" }))
    fireEvent.click(await screen.findByRole("button", { name: "Add provider" }))
    const dialog = await screen.findByTestId("ai-provider-dialog")

    fireEvent.click(
      within(dialog).getByRole("combobox", { name: "Provider type" })
    )
    await chooseOption("Custom (OpenAI-compatible)")

    expect(
      within(dialog).getByLabelText(/Base URL/)
    ).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText("Model id"), {
      target: { value: "gpt-4.1" },
    })
    const saveButton = within(dialog).getByRole("button", {
      name: "Add provider",
    }) as HTMLButtonElement
    // Base URL is required for the custom kind — key is optional there.
    expect(saveButton.disabled).toBe(true)
    fireEvent.change(within(dialog).getByLabelText(/Base URL/), {
      target: { value: "https://gw.example.com/v1" },
    })
    expect(saveButton.disabled).toBe(false)
    fireEvent.click(saveButton)

    await screen.findByTestId("ai-provider-row")
    const provider = (await getAiSettings(executor)).providers[0]
    expect(provider).toMatchObject({
      kind: "custom",
      baseUrl: "https://gw.example.com/v1",
      hasApiKey: false,
    })
  })

  it("the active-provider radio persists and reflects the stored state", async () => {
    await setAiEnabled(executor, true)
    await addProvider(executor, {
      kind: "anthropic",
      label: "Work",
      model: "claude",
      apiKey: "k1",
    })
    const local = await addProvider(executor, {
      kind: "ollama",
      label: "Local",
      model: "llama3.1",
    })
    render(<AiSection />)

    await screen.findByRole("radio", { name: "Use Work for AI" })
    const localRadio = screen.getByRole("radio", {
      name: "Use Local for AI",
    }) as HTMLInputElement
    expect(localRadio.checked).toBe(false)

    fireEvent.click(localRadio)
    await waitFor(async () => {
      expect((await getAiSettings(executor)).activeProviderId).toBe(local.id)
    })
    expect(
      (screen.getByRole("radio", { name: "Use Local for AI" }) as HTMLInputElement)
        .checked
    ).toBe(true)
  })

  it("surface toggles persist per surface", async () => {
    await setAiEnabled(executor, true)
    render(<AiSection />)
    const summaries = await screen.findByRole("switch", {
      name: "Thread summaries",
    })
    await waitFor(() =>
      expect(summaries.getAttribute("aria-checked")).toBe("true")
    )
    fireEvent.click(summaries)
    await waitFor(async () => {
      expect(await isSurfaceEnabled(executor, "summaries")).toBe(false)
    })
    expect(await isSurfaceEnabled(executor, "smartReplies")).toBe(true)
  })

  it("the connection test reports a specific failure inline", async () => {
    await setAiEnabled(executor, true)
    await addProvider(executor, {
      kind: "anthropic",
      label: "Work",
      model: "claude",
      apiKey: "k",
    })
    invokeHolder.invoke.mockRejectedValue({
      kind: "status",
      message: "provider returned HTTP 401: invalid x-api-key",
      status: 401,
    })
    render(<AiSection />)
    const row = await screen.findByTestId("ai-provider-row")
    fireEvent.click(
      within(row).getByRole("button", { name: "Test connection" })
    )

    const outcome = await screen.findByRole("alert")
    expect(outcome.getAttribute("data-testid")).toBe("ai-connection-result")
    expect(outcome.textContent).toBe(
      "provider returned HTTP 401: invalid x-api-key"
    )
    // The test went through the client for the right provider.
    expect(invokeHolder.invoke).toHaveBeenCalledTimes(1)
    expect(
      (invokeHolder.invoke.mock.calls[0] as unknown[])[0]
    ).toBe("ai_chat")
  })

  it("the connection test reports success inline", async () => {
    await setAiEnabled(executor, true)
    await addProvider(executor, {
      kind: "ollama",
      label: "Local",
      model: "llama3.1",
    })
    render(<AiSection />)
    const row = await screen.findByTestId("ai-provider-row")
    fireEvent.click(
      within(row).getByRole("button", { name: "Test connection" })
    )
    const outcome = await screen.findByRole("status")
    expect(outcome.textContent).toBe("Connection OK.")
  })

  it("cache management shows stats and clears everything after the confirm step", async () => {
    await setAiEnabled(executor, true)
    await putAiCache(executor, {
      provider: "anthropic",
      model: "claude",
      kind: "summary",
      input: "thread-a",
      output: "s",
    })
    await putAiCache(executor, {
      provider: "anthropic",
      model: "claude",
      kind: "categorization",
      input: "sender@example.com",
      output: "c",
    })
    render(<AiSection />)

    const stats = await screen.findByTestId("ai-cache-stats")
    expect(stats.textContent).toContain("2 cached results")
    expect(stats.textContent).toContain("summary: 1")
    expect(stats.textContent).toContain("categorization: 1")
    // The account-removal guarantee is stated where the cache is managed.
    expect(
      screen.getByText(/Removing an account automatically deletes/i)
    ).toBeTruthy()

    // Two-step confirm: the first click only asks (the outline button is
    // replaced by the confirm row, so the name stays unique).
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }))
    expect(screen.getByText(/Clear all 2 cached results\?/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Clear all" }))

    await waitFor(async () => {
      expect((await aiCacheStats(executor)).total).toBe(0)
    })
    await waitFor(() => {
      expect(screen.getByTestId("ai-cache-stats").textContent).toContain(
        "0 cached results"
      )
    })
  })

  it("states the export-safety guarantee in the fine print", async () => {
    render(<AiSection />)
    expect(
      await screen.findByText(/never\s+included in exported data/i)
    ).toBeTruthy()
  })

  it("settings rows written by hand never crash the section (corrupt row)", async () => {
    await executor.execute(
      "INSERT INTO settings (key, value) VALUES ($1, $2)",
      [AI_SETTING_KEY, "totally not json"]
    )
    render(<AiSection />)
    // Corrupt reads as disabled-AI: the off note, no crash.
    expect(
      await screen.findByText(/Turn AI assistance on to configure/)
    ).toBeTruthy()
  })

  it("seeding via setSetting keeps the section working against the raw row", async () => {
    await setSetting(executor, AI_SETTING_KEY, {
      enabled: true,
      activeProviderId: null,
      providers: [],
      surfaces: undefined,
    })
    render(<AiSection />)
    expect(
      await screen.findByText(/No providers configured yet/)
    ).toBeTruthy()
    // surfaces absent → per-surface defaults apply (all on but opt-in).
    await waitFor(async () => {
      expect(await isSurfaceEnabled(executor, "summaries")).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// Tiers + output language (parity-round-2 task 2.1) and usage summary (2.3)
// ---------------------------------------------------------------------------

/** Enable AI and wait for the enabled configuration (the tiers block) to
 * render. */
async function enableAi(): Promise<void> {
  await setAiEnabled(executor, true)
  render(<AiSection />)
  await screen.findByRole("combobox", { name: "Tier for Thread summaries" })
}

describe("AiSection model tiers + output language (parity-round-2 task 2.1)", () => {
  it("renders a tier selector per surface with the default tier", async () => {
    await enableAi()

    const summariesTier = await screen.findByRole("combobox", {
      name: "Tier for Thread summaries",
    })
    expect(summariesTier.textContent).toContain("Cheap")
    expect(
      screen.getByRole("combobox", { name: "Tier for Ask My Inbox" })
        .textContent
    ).toContain("Intelligent")
    expect(
      screen.getByRole("combobox", {
        name: "Tier for Categorization assist (opt-in)",
      }).textContent
    ).toContain("Instant")
    // The parity-round-2 surfaces' defaults (task 2.4/2.5): the latency
    // surface rides instant, the rule translator rides cheap.
    expect(
      screen.getByRole("combobox", { name: "Tier for Quick replies" })
        .textContent
    ).toContain("Instant")
    expect(
      screen.getByRole("combobox", {
        name: "Tier for Natural-language rules",
      }).textContent
    ).toContain("Cheap")
    // The add-ai-surfaces surfaces' defaults: click-initiated, short
    // outputs — all ride cheap.
    expect(
      screen.getByRole("combobox", { name: "Tier for Event extraction" })
        .textContent
    ).toContain("Cheap")
    expect(
      screen.getByRole("combobox", { name: "Tier for Translate" }).textContent
    ).toContain("Cheap")
    expect(
      screen.getByRole("combobox", { name: "Tier for Catch-me-up digest" })
        .textContent
    ).toContain("Cheap")
  })

  it("changing a surface tier persists it", async () => {
    await enableAi()
    fireEvent.click(
      await screen.findByRole("combobox", { name: "Tier for Thread summaries" })
    )
    await chooseOption("Intelligent")

    await waitFor(async () => {
      expect((await getTierRouting(executor)).surfaceTiers.summaries).toBe(
        "intelligent"
      )
    })
    // The other surfaces keep their defaults.
    expect((await getTierRouting(executor)).surfaceTiers.smartReplies).toBe(
      "cheap"
    )
  })

  it("per-tier model ids persist on blur; a blank id clears the tier", async () => {
    await enableAi()
    const instant = screen.getByLabelText("Instant model id") as HTMLInputElement
    fireEvent.change(instant, { target: { value: "  qwen-flash  " } })
    fireEvent.blur(instant)

    await waitFor(async () => {
      expect((await getAiSettings(executor)).tiers.instant).toBe("qwen-flash")
    })

    // The persisted (trimmed) value re-mounts the field — re-query it.
    const reQueried = screen.getByLabelText(
      "Instant model id"
    ) as HTMLInputElement
    expect(reQueried.value).toBe("qwen-flash")
    fireEvent.change(reQueried, { target: { value: "   " } })
    fireEvent.blur(reQueried)
    await waitFor(async () => {
      expect((await getAiSettings(executor)).tiers).toEqual({})
    })
  })

  it("the output language persists on blur and clears when blanked", async () => {
    await enableAi()
    const language = screen.getByLabelText("Output language") as HTMLInputElement
    fireEvent.change(language, { target: { value: "  German  " } })
    fireEvent.blur(language)
    await waitFor(async () => {
      expect((await getAiSettings(executor)).outputLanguage).toBe("German")
    })

    const reQueried = screen.getByLabelText(
      "Output language"
    ) as HTMLInputElement
    expect(reQueried.value).toBe("German")
    fireEvent.change(reQueried, { target: { value: "" } })
    fireEvent.blur(reQueried)
    await waitFor(async () => {
      expect((await getAiSettings(executor)).outputLanguage).toBeNull()
    })
  })
})

describe("AiSection usage summary (parity-round-2 task 2.3)", () => {
  it("refreshes on open and shows per-surface counts and tokens, approx-labeled", async () => {
    await enableAi()
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

    // Re-render with the rows in place: the block loads them on open.
    cleanup()
    await enableAi()

    const stats = await screen.findByTestId("ai-usage-stats")
    expect(stats.textContent).toContain("Thread summaries: 2 requests")
    expect(stats.textContent).toContain("234 total tokens")
    // Any estimated row makes that surface's totals approximate.
    expect(stats.textContent).toContain("(approx.)")
    // The all-reported surface is NOT labeled approximate (its line has
    // no approx. marker while summaries' does).
    const askLine = within(stats).getByText(/Ask My Inbox/)
    expect(askLine.textContent).toContain("60 total tokens")
    expect(askLine.textContent).not.toContain("(approx.)")

    expect((await aiUsageSummary(executor)).totalRequests).toBe(3)
  })

  it("shows the empty state when nothing was recorded", async () => {
    await enableAi()
    expect((await screen.findByTestId("ai-usage-stats")).textContent).toBe(
      "No usage recorded yet."
    )
    expect(screen.queryByRole("button", { name: "Clear usage" })).toBeNull()
  })

  it("clears the usage trail after the confirm step", async () => {
    await recordAiUsage(executor, {
      surface: "summaries",
      model: "m",
      promptTokens: 12,
      completionTokens: 8,
      totalTokens: 20,
      estimated: false,
    })
    await enableAi()

    // Two-step confirm: the first click only asks (the outline button is
    // replaced by the confirm row, so the name stays unique).
    fireEvent.click(
      await screen.findByRole("button", { name: "Clear usage" })
    )
    expect(screen.getByText(/Clear the recorded usage/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Clear usage" }))

    await waitFor(async () => {
      expect((await aiUsageSummary(executor)).totalRequests).toBe(0)
    })
    await waitFor(() => {
      expect(screen.getByTestId("ai-usage-stats").textContent).toBe(
        "No usage recorded yet."
      )
    })
  })
})

// ---------------------------------------------------------------------------
// Writing-style block (task 4.5, "Writing-style smart replies")
// ---------------------------------------------------------------------------

describe("AiSection writing-style block (task 4.5)", () => {
  const ACCOUNT_ID = "acc-1"

  const envelope = {
    profile: {
      version: 1 as const,
      tone: "warm",
      formality: "business-casual",
      typicalLength: "short",
      greetings: ["Hi NAME"],
      signOffs: ["Best,"],
      phrasing: [],
    },
    builtAt: Math.floor(Date.now() / 1000) - 3600,
    sampleSize: 24,
  }

  beforeEach(() => {
    styleProfileMocks.loadStyleProfile.mockReset()
    styleProfileMocks.buildWritingStyleProfile.mockReset()
    styleProfileMocks.deleteStyleProfile.mockReset()
    styleProfileMocks.loadStyleProfile.mockResolvedValue(null)
    useAccountStore.setState({
      accounts: [],
      activeAccountId: ACCOUNT_ID,
      loaded: true,
    })
  })

  /** Render with AI enabled — the block lives behind the master switch. */
  async function enableAi(): Promise<void> {
    render(<AiSection />)
    fireEvent.click(
      await screen.findByRole("switch", { name: "AI assistance" })
    )
    await screen.findByTestId("writing-style-block")
  }

  it("is hidden while AI is off", async () => {
    render(<AiSection />)
    await waitFor(() =>
      expect(masterSwitch().getAttribute("aria-checked")).toBe("false")
    )
    expect(screen.queryByTestId("writing-style-block")).toBeNull()
  })

  it("states the sent-mail consent and shows the empty status", async () => {
    await enableAi()

    const block = screen.getByTestId("writing-style-block")
    // Consent copy: building analyzes recent sent messages; nothing
    // sends automatically.
    expect(block.textContent).toMatch(/analyzes your recent sent messages/)
    expect(block.textContent).toMatch(/nothing is ever sent automatically/i)
    expect(
      screen.getByTestId("writing-style-status").textContent
    ).toBe("No profile yet.")
    expect(
      screen.getByRole("button", { name: "Build profile" })
    ).toBeTruthy()
  })

  it("shows the built status with when it was built and the sample size", async () => {
    styleProfileMocks.loadStyleProfile.mockResolvedValue(envelope)
    await enableAi()

    await waitFor(() =>
      expect(
        screen.getByTestId("writing-style-status").textContent
      ).toContain("24 samples")
    )
    expect(
      screen.getByTestId("writing-style-status").textContent
    ).toMatch(/^Built .* ago/)
  })

  it("rebuild re-analyzes and reports completion with the sample size", async () => {
    styleProfileMocks.loadStyleProfile.mockResolvedValue(envelope)
    styleProfileMocks.buildWritingStyleProfile.mockResolvedValue({
      ok: true,
      sampleSize: 30,
    })
    await enableAi()
    await screen.findByTestId("writing-style-rebuild")

    fireEvent.click(screen.getByTestId("writing-style-rebuild"))

    expect(styleProfileMocks.buildWritingStyleProfile).toHaveBeenCalledWith(
      executor,
      ACCOUNT_ID
    )
    expect(
      (await screen.findByTestId("writing-style-notice")).textContent
    ).toContain("Profile rebuilt from 30 sent messages.")
  })

  it("renders rebuild failures inline as an alert", async () => {
    await enableAi()
    styleProfileMocks.buildWritingStyleProfile.mockResolvedValue({
      ok: false,
      reason: "no-sent-mail",
    })

    fireEvent.click(screen.getByTestId("writing-style-rebuild"))

    const notice = await screen.findByTestId("writing-style-notice")
    expect(notice.getAttribute("role")).toBe("alert")
    expect(notice.textContent).toContain(
      "No recent sent messages were found to analyze."
    )
  })

  it("delete removes the profile and empties the status", async () => {
    styleProfileMocks.loadStyleProfile.mockResolvedValue(envelope)
    await enableAi()
    await waitFor(() =>
      expect(
        screen.getByTestId("writing-style-status").textContent
      ).toContain("24 samples")
    )

    fireEvent.click(
      screen.getByLabelText("Delete writing-style profile")
    )

    expect(styleProfileMocks.deleteStyleProfile).toHaveBeenCalledWith(
      executor,
      ACCOUNT_ID
    )
    await waitFor(() =>
      expect(
        screen.getByTestId("writing-style-status").textContent
      ).toBe("No profile yet.")
    )
  })
})
