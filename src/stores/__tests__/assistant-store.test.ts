import { beforeEach, describe, expect, it, vi } from "vitest"

// The turn service and the executor are the store's only seams; both are
// mocked and the conversation-state machine between them runs for real —
// the assistant-dialog test's exact approach.
const executorHolder = vi.hoisted(() => ({ current: null as unknown }))

vi.mock("@/services/db/executor", () => ({
  getExecutor: () => executorHolder.current ?? {},
}))

vi.mock("@/services/ai/assistant", () => ({
  runAssistantTurn: vi.fn(),
}))

import {
  AiProviderError,
  AiUnavailableError,
} from "@/services/ai/client"
import {
  runAssistantTurn,
  type AssistantTurnResult,
} from "@/services/ai/assistant"
import { useAssistantStore } from "../assistant-store"

/**
 * Assistant conversation store tests (ai-assistant-panel task 7.1, design
 * D1): the turn commit (display turns + wire history + touched-id union +
 * ≈cost accumulation), the busy flag spanning the in-flight turn, the
 * all-or-nothing provider failure (turnError set, nothing committed, the
 * same message retryable against the unchanged history), the
 * AiUnavailableError one-shot signal, regenerate re-running the last user
 * message against the history BEFORE it, and the full reset.
 */

const runTurnMock = vi.mocked(runAssistantTurn)

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

beforeEach(() => {
  vi.clearAllMocks()
  executorHolder.current = EXECUTOR
  useAssistantStore.getState().resetConversation()
})

describe("assistant store sendTurn (task 7.1)", () => {
  it("commits the user and answer turns, wire history, touched-id union and cost", async () => {
    // t1 was already touched before this turn; the result's t2/t1 must
    // union into ["t1", "t2"] — existing ids keep first-surfaced order.
    useAssistantStore.setState({ touchedThreadIds: ["t1"] })
    runTurnMock.mockResolvedValueOnce(
      turnResult({
        answer: "Two flights next week.",
        touchedThreadIds: ["t2", "t1"],
        approxTokens: 42,
        toolRounds: 3,
      })
    )

    await useAssistantStore.getState().sendTurn(" find my flights ")

    const state = useAssistantStore.getState()
    expect(state.turns).toEqual([
      { role: "user", content: "find my flights" },
      {
        role: "assistant",
        content: "Two flights next week.",
        toolRounds: 3,
      },
    ])
    expect(state.wireHistory).toEqual([
      { role: "user", content: "find my flights" },
      { role: "assistant", content: "Two flights next week." },
    ])
    expect(state.touchedThreadIds).toEqual(["t1", "t2"])
    expect(state.approxTokens).toBe(42)
    expect(state.busy).toBe(false)
    expect(state.turnError).toBeNull()

    // The service got the executor, the (unchanged) history, the trimmed
    // message and the pre-turn touched set.
    expect(runTurnMock).toHaveBeenCalledTimes(1)
    const call = runTurnMock.mock.calls[0]!
    expect(call[0]).toBe(EXECUTOR)
    expect(call[1]).toEqual([])
    expect(call[2]).toBe("find my flights")
    expect(call[3]).toEqual({ touchedThreadIds: ["t1"] })
  })

  it("is busy for the duration of the turn and accumulates across turns", async () => {
    let resolveFirst!: (result: AssistantTurnResult) => void
    runTurnMock.mockImplementationOnce(
      () =>
        new Promise<AssistantTurnResult>((resolve) => {
          resolveFirst = resolve
        })
    )

    const pending = useAssistantStore.getState().sendTurn("first question")
    expect(useAssistantStore.getState().busy).toBe(true)
    // A second send during the in-flight turn is a no-op.
    await useAssistantStore.getState().sendTurn("queued?")
    expect(runTurnMock).toHaveBeenCalledTimes(1)

    resolveFirst(turnResult({ answer: "First answer.", approxTokens: 30 }))
    await pending
    expect(useAssistantStore.getState().busy).toBe(false)

    runTurnMock.mockResolvedValueOnce(
      turnResult({ answer: "Second answer.", approxTokens: 12 })
    )
    await useAssistantStore.getState().sendTurn("follow-up")
    const state = useAssistantStore.getState()
    expect(runTurnMock).toHaveBeenCalledTimes(2)
    // The second turn extends the first turn's wire history…
    expect(runTurnMock.mock.calls[1]![1]).toEqual([
      { role: "user", content: "first question" },
      { role: "assistant", content: "First answer." },
    ])
    // …and the cost line accumulated both turns.
    expect(state.approxTokens).toBe(42)
  })

  it("commits nothing on a provider failure but keeps the message retryable", async () => {
    useAssistantStore.setState({ touchedThreadIds: ["t1"], approxTokens: 7 })
    runTurnMock.mockRejectedValueOnce(
      new AiProviderError("network", "Provider unreachable")
    )

    await useAssistantStore.getState().sendTurn("find receipts")

    const state = useAssistantStore.getState()
    expect(state.turnError).toBe("Provider unreachable")
    expect(state.busy).toBe(false)
    // The failed turn committed nothing: no turns, no history, no touched
    // growth, no cost.
    expect(state.turns).toEqual([])
    expect(state.wireHistory).toEqual([])
    expect(state.touchedThreadIds).toEqual(["t1"])
    expect(state.approxTokens).toBe(7)
    // The failed message is the Retry target.
    expect(state.lastUserMessage).toBe("find receipts")

    // The retry runs against the exact same (unchanged) history.
    runTurnMock.mockResolvedValueOnce(turnResult({ answer: "Recovered." }))
    await useAssistantStore.getState().sendTurn("find receipts")
    expect(runTurnMock.mock.calls[1]![1]).toEqual([])
    expect(runTurnMock.mock.calls[1]![2]).toBe("find receipts")
    expect(useAssistantStore.getState().turnError).toBeNull()
    expect(useAssistantStore.getState().turns).toHaveLength(2)
  })

  it("raises the one-shot unavailable signal on AiUnavailableError instead of turnError", async () => {
    runTurnMock.mockRejectedValueOnce(new AiUnavailableError("not-configured"))

    await useAssistantStore.getState().sendTurn("hello")

    const state = useAssistantStore.getState()
    expect(state.unavailable).toBe(true)
    expect(state.turnError).toBeNull()
    expect(state.turns).toEqual([])
    expect(state.busy).toBe(false)

    // The panel clears the signal after consuming it (closing itself), so
    // a later reopen after re-enabling the gate is not re-closed.
    useAssistantStore.getState().clearUnavailable()
    expect(useAssistantStore.getState().unavailable).toBe(false)
  })

  it("ignores empty messages", async () => {
    await useAssistantStore.getState().sendTurn("   ")
    expect(runTurnMock).not.toHaveBeenCalled()
    expect(useAssistantStore.getState().busy).toBe(false)
  })
})

describe("assistant store regenerateLast (task 7.1, spec \"Regeneration\")", () => {
  it("re-runs the last user message against the history before it", async () => {
    runTurnMock.mockResolvedValueOnce(
      turnResult({ answer: "First take.", approxTokens: 30 })
    )
    await useAssistantStore.getState().sendTurn("what did I promise?")

    runTurnMock.mockResolvedValueOnce(
      turnResult({
        answer: "Better take.",
        touchedThreadIds: ["t9"],
        approxTokens: 12,
      })
    )
    await useAssistantStore.getState().regenerateLast()

    // The regeneration dropped the old answer pair and re-sent the same
    // message against the history BEFORE it (empty here).
    expect(runTurnMock).toHaveBeenCalledTimes(2)
    expect(runTurnMock.mock.calls[1]![1]).toEqual([])
    expect(runTurnMock.mock.calls[1]![2]).toBe("what did I promise?")
    const state = useAssistantStore.getState()
    expect(state.turns).toEqual([
      { role: "user", content: "what did I promise?" },
      { role: "assistant", content: "Better take.", toolRounds: 0 },
    ])
    expect(state.wireHistory).toEqual([
      { role: "user", content: "what did I promise?" },
      { role: "assistant", content: "Better take." },
    ])
    // The regeneration really ran: its cost accrues and its touched ids
    // join the set.
    expect(state.approxTokens).toBe(42)
    expect(state.touchedThreadIds).toEqual(["t9"])
  })

  it("re-runs only the last pair of a multi-turn conversation", async () => {
    runTurnMock.mockResolvedValueOnce(
      turnResult({ answer: "One.", approxTokens: 10 })
    )
    await useAssistantStore.getState().sendTurn("first")
    runTurnMock.mockResolvedValueOnce(
      turnResult({ answer: "Two.", approxTokens: 10 })
    )
    await useAssistantStore.getState().sendTurn("second")

    runTurnMock.mockResolvedValueOnce(
      turnResult({ answer: "Two, again.", approxTokens: 10 })
    )
    await useAssistantStore.getState().regenerateLast()

    // History BEFORE the last pair: exactly the first exchange.
    expect(runTurnMock.mock.calls[2]![1]).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "One." },
    ])
    expect(runTurnMock.mock.calls[2]![2]).toBe("second")
    expect(useAssistantStore.getState().turns).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "One.", toolRounds: 0 },
      { role: "user", content: "second" },
      { role: "assistant", content: "Two, again.", toolRounds: 0 },
    ])
  })

  it("is a no-op with no turns or while busy", async () => {
    await useAssistantStore.getState().regenerateLast()
    expect(runTurnMock).not.toHaveBeenCalled()

    let resolveTurn!: (result: AssistantTurnResult) => void
    runTurnMock.mockImplementationOnce(
      () =>
        new Promise<AssistantTurnResult>((resolve) => {
          resolveTurn = resolve
        })
    )
    const pending = useAssistantStore.getState().sendTurn("in flight")
    await useAssistantStore.getState().regenerateLast()
    expect(runTurnMock).toHaveBeenCalledTimes(1)
    resolveTurn(turnResult({ answer: "Done." }))
    await pending
  })
})

describe("assistant store resetConversation (task 7.1)", () => {
  it("clears every piece of conversation state", async () => {
    runTurnMock.mockResolvedValueOnce(
      turnResult({
        answer: "Answer.",
        touchedThreadIds: ["t1"],
        approxTokens: 30,
      })
    )
    await useAssistantStore.getState().sendTurn("hello")
    useAssistantStore.setState({ turnError: "stale", unavailable: true })

    useAssistantStore.getState().resetConversation()

    const state = useAssistantStore.getState()
    expect(state.turns).toEqual([])
    expect(state.wireHistory).toEqual([])
    expect(state.touchedThreadIds).toEqual([])
    expect(state.approxTokens).toBe(0)
    expect(state.busy).toBe(false)
    expect(state.turnError).toBeNull()
    expect(state.lastUserMessage).toBeNull()
    expect(state.unavailable).toBe(false)

    // The next send runs against an empty history again.
    runTurnMock.mockResolvedValueOnce(turnResult({ answer: "Fresh." }))
    await useAssistantStore.getState().sendTurn("again")
    expect(runTurnMock.mock.calls[1]![1]).toEqual([])
  })
})
