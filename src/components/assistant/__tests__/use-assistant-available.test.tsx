import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"

import { useAssistantAvailable } from "../use-assistant-available"
import { isAiConfigured, isSurfaceEnabled } from "@/services/ai/settings"

/**
 * The assistant gate (task 3.2's gate, shared by the shell and the panel
 * body): provider configured AND the assistant surface enabled. Pinned
 * here: re-gating on every open (a once-at-boot check would pin stale
 * settings forever), the synchronous reset while closed (no stale
 * "available" flash), the recheckKey re-read, and failing toward hidden.
 */

vi.mock("@/services/ai/settings", () => ({
  isAiConfigured: vi.fn(),
  isSurfaceEnabled: vi.fn(),
}))

vi.mock("@/services/db/executor", () => ({
  getExecutor: () => ({}) as Record<string, never>,
}))

const isAiConfiguredMock = vi.mocked(isAiConfigured)
const isSurfaceEnabledMock = vi.mocked(isSurfaceEnabled)

beforeEach(() => {
  isAiConfiguredMock.mockReset()
  isSurfaceEnabledMock.mockReset()
  isAiConfiguredMock.mockResolvedValue(true)
  isSurfaceEnabledMock.mockResolvedValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("useAssistantAvailable", () => {
  it("resolves available when AI is configured and the surface is enabled", async () => {
    const { result } = renderHook(() => useAssistantAvailable(true))
    await waitFor(() => expect(result.current).toBe(true))
    // Both gates run against the same executor.
    expect(isAiConfiguredMock).toHaveBeenCalledTimes(1)
    expect(isSurfaceEnabledMock).toHaveBeenCalledWith({}, "assistant")
  })

  it("stays hidden when either gate answers no", async () => {
    isAiConfiguredMock.mockResolvedValueOnce(false)
    const { result } = renderHook(() => useAssistantAvailable(true))
    await waitFor(() => expect(isAiConfiguredMock).toHaveBeenCalled())
    // A failed provider gate short-circuits — the surface is never asked.
    expect(isSurfaceEnabledMock).not.toHaveBeenCalled()
    expect(result.current).toBe(false)

    isAiConfiguredMock.mockResolvedValue(true)
    isSurfaceEnabledMock.mockResolvedValueOnce(false)
    const second = renderHook(() => useAssistantAvailable(true))
    await waitFor(() => expect(second.result.current).toBe(false))
    expect(isSurfaceEnabledMock).toHaveBeenCalledTimes(1)
  })

  it("resets synchronously while closed and re-gates on the next open", async () => {
    const { result, rerender } = renderHook(
      ({ active }: { active: boolean }) => useAssistantAvailable(active),
      { initialProps: { active: true } }
    )
    await waitFor(() => expect(result.current).toBe(true))

    // Closing resets immediately — before any async work could land.
    rerender({ active: false })
    expect(result.current).toBe(false)

    // A settings flip while closed must be honored on the next open.
    isSurfaceEnabledMock.mockResolvedValueOnce(false)
    rerender({ active: true })
    await waitFor(() => expect(result.current).toBe(false))
  })

  it("recheckKey forces a re-read across non-active changes", async () => {
    const { rerender } = renderHook(
      ({ key }: { key: unknown }) => useAssistantAvailable(true, key),
      { initialProps: { key: "inbox" as unknown } }
    )
    await waitFor(() => expect(isAiConfiguredMock).toHaveBeenCalledTimes(1))

    rerender({ key: "search" })
    await waitFor(() => expect(isAiConfiguredMock).toHaveBeenCalledTimes(2))
  })

  it("fails toward hidden when the gate query throws (shell must not break)", async () => {
    isAiConfiguredMock.mockRejectedValueOnce(new Error("db closed"))
    const { result } = renderHook(() => useAssistantAvailable(true))
    await waitFor(() => expect(isAiConfiguredMock).toHaveBeenCalled())
    expect(result.current).toBe(false)
  })
})
