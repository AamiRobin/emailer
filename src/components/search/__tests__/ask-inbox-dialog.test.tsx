import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

// The gate + transport seams are mocked; everything between them (the
// dialog, the real translateQuestion, the real parser validation) runs
// for real, so the QUERY assertions cover the production path.
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
    surface === "askInbox"
  ),
}))

vi.mock("@/services/ai/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/ai/client")>()),
  aiChat: vi.fn(),
}))

import { AiProviderError, aiChat } from "@/services/ai/client"
import {
  isAiConfigured,
  isSurfaceEnabled,
} from "@/services/ai/settings"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { AskInboxButton } from "../ask-inbox-dialog"

/**
 * Ask My Inbox dialog tests (task 4.7, design D3): gated rendering, the
 * QUERY path (interpreted query shown prefilled + editable, Search
 * entering the normal search view through ui-store's setView — the same
 * seam a search-field submit uses), the clarification loop, and the
 * inline-error + retry path.
 */

const aiChatMock = vi.mocked(aiChat)
const isAiConfiguredMock = vi.mocked(isAiConfigured)
const isSurfaceEnabledMock = vi.mocked(isSurfaceEnabled)

const QUESTION = "attachments from maria since monday"
const QUERY = "from:maria has:attachment after:2026-09-14"

function resetUiStore(): void {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    previousView: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
  })
}

beforeEach(() => {
  resetUiStore()
  vi.clearAllMocks()
  // Pin the gate open — the negative gating tests override with
  // mockResolvedValue, which survives clearAllMocks, so every test
  // states its own expectation instead of inheriting one.
  isAiConfiguredMock.mockResolvedValue(true)
  isSurfaceEnabledMock.mockResolvedValue(true)
  aiChatMock.mockResolvedValue(`QUERY: ${QUERY}`)
})

afterEach(() => {
  cleanup()
  resetUiStore()
})

async function openDialog(): Promise<void> {
  render(<AskInboxButton />)
  fireEvent.click(
    await screen.findByTestId("ask-inbox-button")
  )
  await screen.findByRole("dialog")
}

describe("AskInboxButton gating (task 4.7)", () => {
  it("hides the entry point when the askInbox surface is disabled", async () => {
    isSurfaceEnabledMock.mockResolvedValue(false)
    render(<AskInboxButton />)
    // The gate resolves before the decision renders — wait for it.
    await waitFor(() => expect(isSurfaceEnabledMock).toHaveBeenCalled())
    expect(screen.queryByTestId("ask-inbox-button")).toBeNull()
  })

  it("hides the entry point when no provider is configured", async () => {
    isAiConfiguredMock.mockResolvedValue(false)
    render(<AskInboxButton />)
    await waitFor(() => expect(isAiConfiguredMock).toHaveBeenCalled())
    expect(screen.queryByTestId("ask-inbox-button")).toBeNull()
  })
})

describe("AskInboxDialog (task 4.7, design D3)", () => {
  it("shows the interpreted query prefilled and searchable", async () => {
    await openDialog()

    fireEvent.change(
      screen.getByLabelText("Your question"),
      { target: { value: QUESTION } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Ask" }))

    // The translation comes back as an EDITABLE input, pre-filled.
    const queryInput = (await screen.findByLabelText(
      "Interpreted query"
    )) as HTMLInputElement
    expect(queryInput.value).toBe(QUERY)
    // The model received exactly the question (nothing else leaves the
    // machine — design D3).
    expect(aiChatMock).toHaveBeenCalledTimes(1)
    expect(aiChatMock.mock.calls[0]![0].messages).toEqual([
      { role: "user", content: QUESTION },
    ])

    // Search runs the query through the normal search seam and closes.
    fireEvent.click(screen.getByTestId("ask-inbox-search"))
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeNull()
    )
    expect(useUiStore.getState().view).toEqual({ kind: "search", query: QUERY })
  })

  it("runs the EDITED query, not the original translation", async () => {
    await openDialog()
    fireEvent.change(
      screen.getByLabelText("Your question"),
      { target: { value: QUESTION } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Ask" }))
    const queryInput = await screen.findByLabelText("Interpreted query")

    // The user corrects the interpreted query before searching (spec:
    // "showing the interpreted query so the user can correct it").
    fireEvent.change(queryInput, {
      target: { value: "from:maria has:attachment after:2026-09-07" },
    })
    fireEvent.click(screen.getByTestId("ask-inbox-search"))
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeNull()
    )
    expect(useUiStore.getState().view).toEqual({
      kind: "search",
      query: "from:maria has:attachment after:2026-09-07",
    })
  })

  it("loops on a clarification instead of showing results", async () => {
    // Once only: the refined re-ask falls back to the QUERY default.
    aiChatMock.mockResolvedValueOnce("CLARIFY: Which sender did you mean?")
    await openDialog()
    fireEvent.change(
      screen.getByLabelText("Your question"),
      { target: { value: "maria" } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Ask" }))

    // The model's question is shown; no interpreted query appears.
    expect(
      (await screen.findByTestId("ask-inbox-clarification")).textContent
    ).toContain("Which sender did you mean?")
    expect(screen.queryByLabelText("Interpreted query")).toBeNull()

    // The input stays for refining; asking again re-translates.
    fireEvent.change(
      screen.getByLabelText("Refine your question"),
      { target: { value: "attachments from maria reyes" } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Ask" }))
    expect(await screen.findByLabelText("Interpreted query")).toBeTruthy()
    expect(aiChatMock).toHaveBeenCalledTimes(2)
    expect(aiChatMock.mock.calls[1]![0].messages).toEqual([
      { role: "user", content: "attachments from maria reyes" },
    ])
  })

  it("shows provider errors inline with a working Retry", async () => {
    aiChatMock.mockRejectedValueOnce(
      new AiProviderError("network", "Provider unreachable")
    )
    await openDialog()
    fireEvent.change(
      screen.getByLabelText("Your question"),
      { target: { value: QUESTION } }
    )
    fireEvent.click(screen.getByRole("button", { name: "Ask" }))

    expect(
      (await screen.findByTestId("ask-inbox-error")).textContent
    ).toContain("Provider unreachable")
    expect(screen.queryByLabelText("Interpreted query")).toBeNull()

    // Retry re-runs the last question through the transport.
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByLabelText("Interpreted query")).toBeTruthy()
    expect(aiChatMock).toHaveBeenCalledTimes(2)
    expect(aiChatMock.mock.calls[1]![0].messages).toEqual([
      { role: "user", content: QUESTION },
    ])
  })
})
