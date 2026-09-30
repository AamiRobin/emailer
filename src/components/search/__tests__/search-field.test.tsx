import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

// The gate + transport seams are mocked exactly like the ask-inbox-dialog
// suite: the executor is a stand-in and the settings gates are mocked, so
// the search field's own gating decisions run against a deterministic
// seam (no DB, no Tauri).
const executorHolder = vi.hoisted(() => ({ current: null as unknown }))

vi.mock("@/services/db/executor", () => ({
  getExecutor: () => executorHolder.current ?? {},
  placeholders: (count: number, firstIndex = 1): string =>
    Array.from({ length: count }, (_, index) => `$${index + firstIndex}`).join(
      ", "
    ),
}))

vi.mock("@/services/ai/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/ai/settings")>()),
  isAiConfigured: vi.fn(async () => true),
  isSurfaceEnabled: vi.fn(async (_executor: unknown, surface: string) =>
    surface === "assistant" || surface === "askInbox"
  ),
}))

vi.mock("@/services/ai/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/ai/client")>()),
  aiChat: vi.fn(),
}))

import {
  isAiConfigured,
  isSurfaceEnabled,
} from "@/services/ai/settings"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { SearchField } from "../search-field"

/**
 * Search-field tests (task 3.2, design D6): the self-gating AssistantButton
 * that sits beside Ask My Inbox — hidden while AI is unconfigured or the
 * assistant surface is disabled (the ask-inbox gating precedent), visible
 * otherwise, and its click only flips ui-store.assistantOpen (the dialog
 * is mounted at the mail-shell level, a later task).
 */

const isAiConfiguredMock = vi.mocked(isAiConfigured)
const isSurfaceEnabledMock = vi.mocked(isSurfaceEnabled)

function resetStores(): void {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    previousView: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    assistantOpen: false,
  })
}

beforeEach(() => {
  resetStores()
  vi.clearAllMocks()
  // Pin both AI gates open; the negative tests override per-test (the
  // overrides survive clearAllMocks only via mockResolvedValue resets
  // here, so every test states its own expectation).
  isAiConfiguredMock.mockResolvedValue(true)
  isSurfaceEnabledMock.mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  resetStores()
})

describe("SearchField AssistantButton gating (task 3.2, design D6)", () => {
  it("hides the entry point when the assistant surface is disabled", async () => {
    isSurfaceEnabledMock.mockImplementation(
      async (_executor: unknown, surface: string) => surface === "askInbox"
    )
    render(<SearchField />)
    // The gate resolves before the decision renders — wait for it.
    await waitFor(() => expect(isSurfaceEnabledMock).toHaveBeenCalled())
    expect(screen.queryByTestId("assistant-button")).toBeNull()
  })

  it("hides the entry point when no provider is configured", async () => {
    isAiConfiguredMock.mockResolvedValue(false)
    render(<SearchField />)
    await waitFor(() => expect(isAiConfiguredMock).toHaveBeenCalled())
    expect(screen.queryByTestId("assistant-button")).toBeNull()
  })

  it("shows the Sparkles button when configured and enabled", async () => {
    render(<SearchField />)
    const button = await screen.findByTestId("assistant-button")
    expect(button.getAttribute("aria-label")).toBe("AI assistant")
    expect(button.getAttribute("title")).toBe("AI assistant")
  })

  it("clicking the button sets ui-store.assistantOpen", async () => {
    render(<SearchField />)
    expect(useUiStore.getState().assistantOpen).toBe(false)
    fireEvent.click(await screen.findByTestId("assistant-button"))
    expect(useUiStore.getState().assistantOpen).toBe(true)
  })
})
