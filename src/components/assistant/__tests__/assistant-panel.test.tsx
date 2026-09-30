import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

// The gate, transport-loop and DB-row seams are mocked; everything
// between them (the panel, the assistant-store's turn commit, the chip
// resolution) runs for real — the assistant-dialog test's exact approach.
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
    surface === "assistant"
  ),
}))

vi.mock("@/services/ai/assistant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/ai/assistant")>()),
  runAssistantTurn: vi.fn(),
}))

vi.mock("@/services/db/threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/db/threads")>()),
  getThread: vi.fn(),
}))

import {
  AiProviderError,
  AiUnavailableError,
} from "@/services/ai/client"
import {
  runAssistantTurn,
  type AssistantTurnResult,
} from "@/services/ai/assistant"
import { isAiConfigured, isSurfaceEnabled } from "@/services/ai/settings"
import { getThread, type ThreadRow } from "@/services/db/threads"
import { useAssistantStore } from "@/stores/assistant-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { AssistantPanel } from "../assistant-panel"

/**
 * Assistant panel tests (ai-assistant-panel tasks 7.1–7.3, design D1
 * revised): the gating (spec "Assistant gating and entry points"), the
 * conversation loop through the real assistant-store (send → committed
 * turns, accumulated ≈cost, tool-activity line), the empty state's
 * prompt chips (spec "Empty-state guidance"), regenerate (spec
 * "Regeneration"), the source chips (a chip opens the thread and the
 * panel STAYS OPEN — the docked UX), the inline provider error with
 * Retry, the New-conversation reset, and the close. The shell-level
 * mount (task 7.3) is exactly this component reading
 * ui-store.assistantOpen — asserted here against the real store rather
 * than duplicating a full MailShell render.
 */

const runTurnMock = vi.mocked(runAssistantTurn)
const getThreadMock = vi.mocked(getThread)
const isAiConfiguredMock = vi.mocked(isAiConfigured)
const isSurfaceEnabledMock = vi.mocked(isSurfaceEnabled)

/** The executor sentinel every service call must receive. */
const EXECUTOR = { test: "executor" }

function turnResult(
  overrides: Partial<AssistantTurnResult> = {}
): AssistantTurnResult {
  return {
    answer: "",
    touchedThreadIds: [],
    approxTokens: 0,
    toolRounds: 0,
    ...overrides,
  }
}

function threadRow(id: string, subject: string): ThreadRow {
  return { id, subject, account_id: "acc-1" } as unknown as ThreadRow
}

function resetUiStore(): void {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    previousView: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    assistantOpen: false,
    helpCenterOpen: false,
  })
}

beforeEach(() => {
  resetUiStore()
  useAssistantStore.getState().resetConversation()
  vi.clearAllMocks()
  executorHolder.current = EXECUTOR
  // Pin the gates open — the negative gating tests override with
  // mockResolvedValue, which survives clearAllMocks, so every test
  // states its own expectation instead of inheriting one.
  isAiConfiguredMock.mockResolvedValue(true)
  isSurfaceEnabledMock.mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  resetUiStore()
  useAssistantStore.getState().resetConversation()
  executorHolder.current = null
})

// The auto-scroll effect calls scrollIntoView; jsdom does not implement it.
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {}
})

afterAll(() => {
  // Leave a pristine environment for other suites in the worker.
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView
})

function typeMessage(message: string): void {
  fireEvent.change(screen.getByTestId("assistant-input"), {
    target: { value: message },
  })
}

function send(): void {
  fireEvent.click(screen.getByRole("button", { name: "Send" }))
}

async function renderOpen(): Promise<HTMLElement> {
  act(() => {
    useUiStore.getState().setAssistantOpen(true)
  })
  render(<AssistantPanel />)
  return screen.findByTestId("assistant-panel")
}

describe("AssistantPanel gating (spec: hidden when gated)", () => {
  it("renders nothing when no provider is configured", async () => {
    isAiConfiguredMock.mockResolvedValue(false)
    useUiStore.setState({ assistantOpen: true })
    render(<AssistantPanel />)
    // The gate resolves before the decision renders — wait for it.
    await waitFor(() => expect(isAiConfiguredMock).toHaveBeenCalled())
    expect(screen.queryByTestId("assistant-panel")).toBeNull()
  })

  it("renders nothing when the assistant surface is disabled", async () => {
    isSurfaceEnabledMock.mockResolvedValue(false)
    useUiStore.setState({ assistantOpen: true })
    render(<AssistantPanel />)
    await waitFor(() => expect(isSurfaceEnabledMock).toHaveBeenCalled())
    expect(screen.queryByTestId("assistant-panel")).toBeNull()
  })
})

describe("AssistantPanel empty state (spec: empty-state guidance)", () => {
  it("renders from the store flag with the hint and the suggested prompt chips", async () => {
    await renderOpen()
    const empty = screen.getByTestId("assistant-empty")
    expect(empty.textContent).toContain("Ask about your mailbox")
    const chips = screen.getAllByTestId("assistant-prompt-chip")
    expect(chips).toHaveLength(3)
    expect(chips[0]!.textContent).toBe("Find my flight confirmations")
    expect(screen.getByTestId("assistant-token-cost").textContent).toContain(
      "≈ 0 tokens"
    )
  })

  it("activating a prompt chip sends it as the user message", async () => {
    runTurnMock.mockResolvedValueOnce(
      turnResult({ answer: "Two flights.", approxTokens: 20 })
    )
    await renderOpen()
    fireEvent.click(
      screen.getAllByTestId("assistant-prompt-chip")[0]!
    )

    expect(runTurnMock).toHaveBeenCalledTimes(1)
    const call = runTurnMock.mock.calls[0]!
    expect(call[0]).toBe(EXECUTOR)
    expect(call[1]).toEqual([])
    expect(call[2]).toBe("Find my flight confirmations")
    expect(call[3]).toEqual({ touchedThreadIds: [] })
    expect(
      (await screen.findByTestId("assistant-answer-turn")).textContent
    ).toContain("Two flights.")
  })
})

describe("AssistantPanel conversation (task 7.2)", () => {
  it("sends a message, is busy until the turn resolves, then shows both turns", async () => {
    let resolveTurn!: (result: AssistantTurnResult) => void
    runTurnMock.mockImplementationOnce(
      () =>
        new Promise<AssistantTurnResult>((resolve) => {
          resolveTurn = resolve
        })
    )
    await renderOpen()
    typeMessage("find my flight confirmations")
    send()

    // The service got exactly the fresh conversation's inputs: empty
    // history, the trimmed message, the empty touched set.
    expect(runTurnMock).toHaveBeenCalledTimes(1)
    const firstCall = runTurnMock.mock.calls[0]!
    expect(firstCall[0]).toBe(EXECUTOR)
    expect(firstCall[1]).toEqual([])
    expect(firstCall[2]).toBe("find my flight confirmations")
    expect(firstCall[3]).toEqual({ touchedThreadIds: [] })

    // Busy while the turn runs: indicator up, input and chips gone.
    expect(screen.getByTestId("assistant-busy").textContent).toContain(
      "Looking in your mailbox"
    )
    expect(
      (screen.getByTestId("assistant-input") as HTMLTextAreaElement).disabled
    ).toBe(true)

    resolveTurn(
      turnResult({ answer: "You have two flights next week.", approxTokens: 42 })
    )
    expect(
      (await screen.findByTestId("assistant-answer-turn")).textContent
    ).toContain("You have two flights next week.")
    expect(screen.getByTestId("assistant-user-turn").textContent).toBe(
      "find my flight confirmations"
    )
    expect(screen.queryByTestId("assistant-busy")).toBeNull()
    expect(screen.getByTestId("assistant-token-cost").textContent).toContain(
      "42"
    )
  })

  it("shows the tool-activity line when the turn used tools", async () => {
    runTurnMock.mockResolvedValueOnce(
      turnResult({ answer: "Found them.", toolRounds: 2 })
    )
    await renderOpen()
    typeMessage("unread from this week")
    send()

    const activity = await screen.findByTestId("assistant-tool-activity")
    expect(activity.textContent).toContain("2 lookups")
  })

  it("accumulates the ≈cost and the wire history across two turns via Enter", async () => {
    runTurnMock.mockResolvedValueOnce(
      turnResult({ answer: "First answer.", approxTokens: 30 })
    )
    await renderOpen()
    typeMessage("first question")
    fireEvent.keyDown(screen.getByTestId("assistant-input"), {
      key: "Enter",
    })
    await screen.findByText("First answer.")

    runTurnMock.mockResolvedValueOnce(
      turnResult({ answer: "Second answer.", approxTokens: 12 })
    )
    typeMessage("and the follow-up?")
    fireEvent.keyDown(screen.getByTestId("assistant-input"), {
      key: "Enter",
    })
    await screen.findByText("Second answer.")

    // Enter (without Shift) submitted both times, and the second turn
    // extended the wire history with the first turn.
    expect(runTurnMock).toHaveBeenCalledTimes(2)
    expect(runTurnMock.mock.calls[1]![1]).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "First answer." },
    ])
    // The cost line accumulated both turns.
    expect(screen.getByTestId("assistant-token-cost").textContent).toContain(
      "≈ 42 tokens"
    )
  })
})

describe("AssistantPanel regenerate (spec: Regeneration)", () => {
  it("re-runs the same message against the history before it and replaces the answer", async () => {
    runTurnMock.mockResolvedValueOnce(
      turnResult({ answer: "First take.", approxTokens: 30 })
    )
    await renderOpen()
    typeMessage("what did I promise?")
    send()
    await screen.findByText("First take.")

    runTurnMock.mockResolvedValueOnce(
      turnResult({ answer: "Better take.", approxTokens: 12 })
    )
    fireEvent.click(screen.getByTestId("assistant-regenerate"))

    expect(
      (await screen.findByTestId("assistant-answer-turn")).textContent
    ).toContain("Better take.")
    expect(screen.queryByText("First take.")).toBeNull()
    expect(runTurnMock).toHaveBeenCalledTimes(2)
    // The regeneration re-sent the same message against the history
    // BEFORE the last pair (empty here).
    expect(runTurnMock.mock.calls[1]![1]).toEqual([])
    expect(runTurnMock.mock.calls[1]![2]).toBe("what did I promise?")
  })

  it("hides the regenerate control while a turn is in flight", async () => {
    let resolveTurn!: (result: AssistantTurnResult) => void
    runTurnMock.mockImplementationOnce(
      () =>
        new Promise<AssistantTurnResult>((resolve) => {
          resolveTurn = resolve
        })
    )
    await renderOpen()
    typeMessage("hello")
    send()
    expect(screen.queryByTestId("assistant-regenerate")).toBeNull()

    resolveTurn(turnResult({ answer: "Done." }))
    await screen.findByTestId("assistant-answer-turn")
    expect(screen.getByTestId("assistant-regenerate")).toBeTruthy()
  })
})

describe("AssistantPanel sources (task 7.2, design D4)", () => {
  it("resolves chip subjects; a chip opens the thread and the panel stays open", async () => {
    runTurnMock.mockResolvedValueOnce(
      turnResult({
        answer: "Found two threads.",
        touchedThreadIds: ["t1", "t2"],
        approxTokens: 55,
      })
    )
    getThreadMock.mockImplementation(async (_executor, threadId) =>
      threadId === "t1"
        ? threadRow("t1", "Flight to Lisbon")
        : threadRow("t2", "Hotel receipt")
    )
    await renderOpen()
    typeMessage("travel plans")
    send()

    // Chips render immediately with the placeholder subject while the
    // subjects resolve — wait for the SUBJECT text, not the chips, or
    // the assertion races the placeholder render under load.
    await screen.findByText("Flight to Lisbon", {}, { timeout: 3000 })
    await screen.findByText("Hotel receipt")
    const chips = screen.getAllByTestId("assistant-source-chip")
    expect(chips).toHaveLength(2)
    expect(chips[0]!.textContent).toContain("Flight to Lisbon")
    expect(chips[1]!.textContent).toContain("Hotel receipt")

    // Activating a chip opens that thread in the mailbox; the panel STAYS
    // open beside it — the docked UX (design D1 revised).
    fireEvent.click(chips[0]!)
    await waitFor(() =>
      expect(useUiStore.getState().activeThread).toBe("t1")
    )
    expect(useUiStore.getState().assistantOpen).toBe(true)
    expect(screen.queryByTestId("assistant-panel")).toBeTruthy()
  })

  it("degrades a vanished thread's chip to the placeholder", async () => {
    runTurnMock.mockResolvedValueOnce(
      turnResult({ answer: "Done.", touchedThreadIds: ["gone"] })
    )
    getThreadMock.mockResolvedValue(null)
    await renderOpen()
    typeMessage("anything")
    send()

    const chip = await screen.findByTestId("assistant-source-chip")
    expect(chip.textContent).toContain("(no subject)")
  })
})

describe("AssistantPanel errors and controls (task 7.2)", () => {
  it("shows provider errors inline and Retry re-runs the same message", async () => {
    runTurnMock.mockRejectedValueOnce(
      new AiProviderError("network", "Provider unreachable")
    )
    await renderOpen()
    typeMessage("find receipts")
    send()

    expect(
      (await screen.findByTestId("assistant-error")).textContent
    ).toContain("Provider unreachable")
    // The failed turn committed nothing.
    expect(screen.queryByTestId("assistant-answer-turn")).toBeNull()

    runTurnMock.mockResolvedValueOnce(turnResult({ answer: "Recovered." }))
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(
      (await screen.findByTestId("assistant-answer-turn")).textContent
    ).toContain("Recovered.")
    expect(runTurnMock).toHaveBeenCalledTimes(2)
    // Retry re-sends the same message against the same (still empty)
    // history — the failed turn appended nothing to it.
    expect(runTurnMock.mock.calls[1]![1]).toEqual([])
    expect(runTurnMock.mock.calls[1]![2]).toBe("find receipts")
  })

  it("closes the panel on an AiUnavailableError instead of erroring", async () => {
    // A mid-conversation gate close is hide-vs-show (the client's
    // contract), not an inline failure.
    runTurnMock.mockRejectedValueOnce(
      new AiUnavailableError("surface-disabled")
    )
    await renderOpen()
    typeMessage("hello")
    send()
    await waitFor(() =>
      expect(screen.queryByTestId("assistant-panel")).toBeNull()
    )
    expect(useUiStore.getState().assistantOpen).toBe(false)
    expect(screen.queryByTestId("assistant-error")).toBeNull()
  })

  it("starts a fresh conversation from the New conversation control", async () => {
    runTurnMock.mockResolvedValueOnce(
      turnResult({ answer: "Answer one.", approxTokens: 30 })
    )
    await renderOpen()
    typeMessage("first")
    send()
    await screen.findByText("Answer one.")

    fireEvent.click(screen.getByTestId("assistant-new-conversation"))

    // Fresh conversation: the empty state is back, no turns, no cost.
    expect(screen.getByTestId("assistant-empty")).toBeTruthy()
    expect(screen.queryByTestId("assistant-answer-turn")).toBeNull()
    expect(screen.getByTestId("assistant-token-cost").textContent).toContain(
      "≈ 0 tokens"
    )

    // And the next send runs against an empty wire history again.
    runTurnMock.mockResolvedValueOnce(turnResult({ answer: "Answer two." }))
    typeMessage("second")
    send()
    await screen.findByText("Answer two.")
    expect(runTurnMock).toHaveBeenCalledTimes(2)
    expect(runTurnMock.mock.calls[1]![1]).toEqual([])
  })

  it("persists the conversation across a close/reopen of the panel", async () => {
    runTurnMock.mockResolvedValueOnce(
      turnResult({ answer: "Answer one.", approxTokens: 30 })
    )
    await renderOpen()
    typeMessage("first")
    send()
    await screen.findByText("Answer one.")

    act(() => {
      useUiStore.getState().setAssistantOpen(false)
    })
    await waitFor(() =>
      expect(screen.queryByTestId("assistant-panel")).toBeNull()
    )

    act(() => {
      useUiStore.getState().setAssistantOpen(true)
    })
    await screen.findByTestId("assistant-panel")
    // The conversation SURVIVED the close (spec "Conversation persists")
    // — the store, not the DOM, owns it now.
    expect(screen.getByTestId("assistant-answer-turn").textContent).toContain(
      "Answer one."
    )
    expect(screen.getByTestId("assistant-token-cost").textContent).toContain(
      "≈ 30 tokens"
    )

    // And a follow-up builds on it.
    runTurnMock.mockResolvedValueOnce(turnResult({ answer: "Answer two." }))
    typeMessage("second")
    send()
    await screen.findByText("Answer two.")
    expect(runTurnMock).toHaveBeenCalledTimes(2)
    expect(runTurnMock.mock.calls[1]![1]).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "Answer one." },
    ])
  })

  it("closes from the header X by clearing the store flag", async () => {
    await renderOpen()
    fireEvent.click(screen.getByTestId("assistant-close"))
    expect(useUiStore.getState().assistantOpen).toBe(false)
    await waitFor(() =>
      expect(screen.queryByTestId("assistant-panel")).toBeNull()
    )
  })
})
