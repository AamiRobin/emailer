import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The transport seam is mocked (the client.test.ts pattern) so the
// assertions target exactly what transformDraftText passes to aiChat —
// prompt construction, mode mapping, and error pass-through. The real
// client module is still imported for its error classes.
const aiChatMock = vi.hoisted(() => vi.fn())

vi.mock("../client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  aiChat: aiChatMock,
}))

import {
  AiProviderError,
  AiUnavailableError,
} from "../client"
import {
  COMPOSE_TRANSFORM_MODES,
  transformDraftText,
} from "../compose-transform"

/**
 * Compose transform service tests (task 4.6, design D1): the per-mode
 * system prompts (with quote-instruction hygiene), the user text carried
 * verbatim as the message on the composeTransform surface, trimming, and
 * that gating/provider errors propagate unchanged (the UI maps them to
 * hide/inline-retry, the service must not swallow them).
 */

beforeEach(() => {
  aiChatMock.mockReset()
  aiChatMock.mockResolvedValue("transformed text")
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("transformDraftText (task 4.6)", () => {
  it("sends the text verbatim as the sole user message on the composeTransform surface", async () => {
    await transformDraftText({
      text: "Please review the attached deck.\n\nThanks!",
      mode: "improve",
    })

    expect(aiChatMock).toHaveBeenCalledTimes(1)
    const args = aiChatMock.mock.calls[0]![0] as Record<string, unknown>
    expect(args.surface).toBe("composeTransform")
    expect(args.messages).toEqual([
      { role: "user", content: "Please review the attached deck.\n\nThanks!" },
    ])
    expect(args.maxTokens).toBe(2048)
  })

  it("maps each mode to a distinct system prompt with the output contract", async () => {
    await transformDraftText({ text: "x", mode: "improve" })
    await transformDraftText({ text: "x", mode: "shorten" })
    await transformDraftText({ text: "x", mode: "formalize" })

    const systems = aiChatMock.mock.calls.map(
      (call) => (call[0] as Record<string, unknown>).system as string
    )
    // Per-mode intent is present in its own prompt…
    expect(systems[0]).toContain("Improve")
    expect(systems[1]).toContain("Condense")
    expect(systems[2]).toContain("formal, professional")
    // …and every prompt carries the quote-instruction hygiene: the reply
    // is spliced verbatim into the draft, so ONLY the text may come back.
    for (const system of systems) {
      expect(system).toContain("Return ONLY")
      // The landed prompt's phrasing ("do not wrap it in quotation
      // marks") — aligned with compose-transform.ts's OUTPUT_CONTRACT.
      expect(system).toContain("quotation marks")
    }
    expect(new Set(systems).size).toBe(COMPOSE_TRANSFORM_MODES.length)
  })

  it("resolves with the trimmed provider content", async () => {
    aiChatMock.mockResolvedValue("  Trimmed reply.\n")
    await expect(
      transformDraftText({ text: "x", mode: "shorten" })
    ).resolves.toBe("Trimmed reply.")
  })

  it("propagates AiProviderError unchanged (the bar shows it with Retry)", async () => {
    const failure = new AiProviderError("rate_limited", "rate limited")
    aiChatMock.mockRejectedValue(failure)
    const error = await transformDraftText({ text: "x", mode: "formalize" }).catch(
      (caught: unknown) => caught
    )
    expect(error).toBe(failure)
  })

  it("propagates AiUnavailableError unchanged (the affordance hides)", async () => {
    const unavailable = new AiUnavailableError("surface-disabled")
    aiChatMock.mockRejectedValue(unavailable)
    const error = await transformDraftText({ text: "x", mode: "improve" }).catch(
      (caught: unknown) => caught
    )
    expect(error).toBe(unavailable)
  })
})

/**
 * Untrusted-content hygiene (hardening batch): the selected/drafted span
 * can quote other people's mail, so invisible smuggle characters are
 * stripped before it enters the prompt (ordinary text rides verbatim).
 */
describe("transformDraftText invisible-character stripping", () => {
  it("strips zero-width characters from the transformed text, keeping everything else", async () => {
    await transformDraftText({
      text: "Please\u200B review the attached deck.\u00AD Thanks!",
      mode: "improve",
    })

    const args = aiChatMock.mock.calls[0]![0] as {
      messages: { role: string; content: string }[]
    }
    expect(args.messages).toEqual([
      { role: "user", content: "Please review the attached deck. Thanks!" },
    ])
  })
})
