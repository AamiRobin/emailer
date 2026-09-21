import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The provider transport is the seam under mock: the REAL client module
// stays loaded (generateQuickReplies's gating checks run for real) with
// aiChat replaced, so assertions target the prompt shape and call counts.
const aiChatMock = vi.hoisted(() => vi.fn())

vi.mock("../client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client")>()
  return { ...actual, aiChat: aiChatMock }
})

import { generateQuickReplies } from "../quick-replies"
import {
  addProvider,
  setActiveProvider,
  setAiEnabled,
  setOutputLanguage,
  setSurfaceEnabled,
  setSurfaceTier,
  setTierModel,
} from "../settings"
import {
  createAccount,
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"

/**
 * Quick-reply service tests (parity-round-2 task 2.4, ai-assistance spec
 * "AI quick reply suggestions"): the typed result contract (gate reasons /
 * no-thread / provider — never a throw), the prompt carrying the (YOU) /
 * [LAST] markers and the small max_tokens budget, the JSON-array parsing
 * (fences tolerated, blanks dropped, capped at three), and the ai_cache
 * keyed on the thread's message-id set + last message id under the
 * TIER-RESOLVED model — the single `resolveSurfaceRuntime` resolution
 * serving both the cache identity and the request.
 */

let executor: TestExecutor
let accountId: string

beforeEach(async () => {
  executor = createTestExecutor()
  accountId = await createAccount(executor)
  aiChatMock.mockReset()
})

afterEach(() => {
  executor.close()
})

/** Enable AI with an active key-less provider (the mocked aiChat never
 * resolves keys). */
async function seedActiveProvider(model = "claude-sonnet-4-5") {
  await setAiEnabled(executor, true)
  const created = await addProvider(executor, {
    kind: "anthropic",
    label: "Work",
    model,
  })
  await setActiveProvider(executor, created.id)
}

/** Two-message thread from other people; returns ids in order. */
async function seedThread(): Promise<{ threadId: string; ids: string[] }> {
  const threadId = await createThread(executor, accountId, {
    subject: "Review",
  })
  const first = await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_000_000,
    subject: "Review",
    fromName: "Alice",
    fromAddress: "alice@example.com",
    bodyText: "Can we move the review to Thursday?",
  })
  const second = await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_100_000,
    subject: "Re: Review",
    fromName: "Bob",
    fromAddress: "bob@example.com",
    bodyText: "Bumping this — we need a decision today.",
  })
  return { threadId, ids: [first, second] }
}

/** The default mock reply: a fenced JSON array (tolerated). */
function replyList(...replies: string[]): string {
  return `Sure! Here are suggestions:\n\n[${replies
    .map((reply) => JSON.stringify(reply))
    .join(", ")}]\n\nHope these help.`
}

describe("generateQuickReplies result contract", () => {
  it("returns not-configured when AI is off, without a client call", async () => {
    const { threadId } = await seedThread()

    const result = await generateQuickReplies(executor, accountId, threadId)

    expect(result).toEqual({ ok: false, reason: "not-configured" })
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it("returns surface-disabled when the quickReplies toggle is off", async () => {
    await seedActiveProvider()
    await setSurfaceEnabled(executor, "quickReplies", false)
    const { threadId } = await seedThread()

    const result = await generateQuickReplies(executor, accountId, threadId)

    expect(result).toEqual({ ok: false, reason: "surface-disabled" })
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it("returns no-thread for an unknown or empty thread", async () => {
    await seedActiveProvider()

    const result = await generateQuickReplies(
      executor,
      accountId,
      "no-such-thread"
    )

    expect(result).toEqual({ ok: false, reason: "no-thread" })
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it("maps a provider failure to the typed provider reason with its message", async () => {
    await seedActiveProvider()
    const { threadId } = await seedThread()
    aiChatMock.mockRejectedValue(new Error("rate limited"))

    const result = await generateQuickReplies(executor, accountId, threadId)

    expect(result).toEqual({
      ok: false,
      reason: "provider",
      message: "rate limited",
    })
  })

  it("treats an unparseable or empty model reply as a provider failure", async () => {
    await seedActiveProvider()
    const { threadId } = await seedThread()

    aiChatMock.mockResolvedValue("I would suggest… well, no array, sorry.")
    const unparsable = await generateQuickReplies(executor, accountId, threadId)
    expect(unparsable).toEqual({
      ok: false,
      reason: "provider",
      message: "The model returned no usable suggestions. Try again.",
    })

    aiChatMock.mockResolvedValue('["", "   "]')
    const blankOnly = await generateQuickReplies(
      executor,
      accountId,
      threadId,
      { regenerate: true }
    )
    expect(blankOnly).toEqual({
      ok: false,
      reason: "provider",
      message: "The model returned no usable suggestions. Try again.",
    })
  })
})

describe("generateQuickReplies prompt", () => {
  it("sends the thread context with (YOU) and [LAST] markers and a small token budget", async () => {
    await seedActiveProvider()
    const { threadId } = await seedThread()
    // One of the thread's messages is from the ACCOUNT's own address —
    // it must be marked (YOU) so suggestions answer the other side.
    const accountRow = await executor.select<{ email: string }>(
      "SELECT email FROM accounts WHERE id = $1",
      [accountId]
    )
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_050_000,
      subject: "Re: Review",
      fromAddress: accountRow[0]!.email,
      bodyText: "Let me check my calendar.",
    })
    aiChatMock.mockResolvedValue(replyList("Thursday works."))

    await generateQuickReplies(executor, accountId, threadId)

    expect(aiChatMock).toHaveBeenCalledTimes(1)
    const args = aiChatMock.mock.calls[0][0] as {
      system: string
      messages: { role: string; content: string }[]
      surface: string
      maxTokens?: number
    }
    expect(args.surface).toBe("quickReplies")
    // Small output budget (design D8): a chip surface stays tiny.
    expect(args.maxTokens).toBeLessThanOrEqual(256)
    // The JSON-array output contract lives in the system prompt.
    expect(args.system).toContain("JSON array")
    expect(args.system).toContain("at most 12 words")
    expect(args.system).toContain("untrusted")
    const content = args.messages[0].content
    expect(content).toContain("From: Alice <alice@example.com>")
    // The account's own message carries the (YOU) marker (nameless sender,
    // so the block is the bare address)…
    expect(content).toContain(
      `From: ${accountRow[0]!.email} (YOU)`
    )
    // …and the last message is the marked reply target.
    expect(content).toContain("From: Bob <bob@example.com> [LAST")
    expect(content).toContain("Bumping this — we need a decision today.")
  })

  it("carries the output-language directive when set and nothing when unset (task 2.6)", async () => {
    await seedActiveProvider()
    const { threadId } = await seedThread()
    aiChatMock.mockResolvedValue(replyList("Thursday works."))

    await generateQuickReplies(executor, accountId, threadId)
    const unsetArgs = aiChatMock.mock.calls[0][0] as { system: string }
    expect(unsetArgs.system).not.toContain("Write your response in")

    await setOutputLanguage(executor, "German")
    aiChatMock.mockClear()
    await generateQuickReplies(executor, accountId, threadId, {
      regenerate: true,
    })
    const setArgs = aiChatMock.mock.calls[0][0] as { system: string }
    expect(setArgs.system).toContain("Write your response in German")
  })
})

describe("generateQuickReplies parsing", () => {
  it("parses the JSON array, drops blanks and caps at three suggestions", async () => {
    await seedActiveProvider()
    const { threadId } = await seedThread()
    aiChatMock.mockResolvedValue(
      replyList(
        "Thursday works for me.",
        "",
        "   ",
        "I can't do Thursday — Wednesday?",
        "What time on Thursday?",
        "Fifth suggestion beyond the cap."
      )
    )

    const result = await generateQuickReplies(executor, accountId, threadId)

    expect(result).toEqual({
      ok: true,
      replies: [
        "Thursday works for me.",
        "I can't do Thursday — Wednesday?",
        "What time on Thursday?",
      ],
      cached: false,
    })
  })
})

describe("generateQuickReplies cache (design D8)", () => {
  it("reuses the cached suggestions without a second client call", async () => {
    await seedActiveProvider()
    const { threadId } = await seedThread()
    aiChatMock.mockResolvedValue(replyList("Thursday works for me."))

    const first = await generateQuickReplies(executor, accountId, threadId)
    expect(aiChatMock).toHaveBeenCalledTimes(1)

    aiChatMock.mockClear()
    const second = await generateQuickReplies(executor, accountId, threadId)

    expect(aiChatMock).not.toHaveBeenCalled()
    expect(second).toEqual({ ...first, cached: true })
  })

  it("invalidates on a new message (a new key, a fresh client call)", async () => {
    await seedActiveProvider()
    const { threadId } = await seedThread()
    aiChatMock.mockResolvedValue(replyList("First set."))
    await generateQuickReplies(executor, accountId, threadId)

    await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_200_000,
      fromAddress: "carol@example.com",
      bodyText: "Any update?",
    })
    aiChatMock.mockClear()
    aiChatMock.mockResolvedValue(replyList("Fresh set."))
    const result = await generateQuickReplies(executor, accountId, threadId)

    expect(aiChatMock).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      ok: true,
      replies: ["Fresh set."],
      cached: false,
    })
    const rows = await executor.select<{ kind: string; account_id: string | null }>(
      "SELECT kind, account_id FROM ai_cache"
    )
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.kind === "quick-reply")).toBe(true)
    expect(rows.every((row) => row.account_id === accountId)).toBe(true)
  })

  it("regenerate bypasses the read and overwrites the row", async () => {
    await seedActiveProvider()
    const { threadId } = await seedThread()
    aiChatMock.mockResolvedValue(replyList("First set."))
    await generateQuickReplies(executor, accountId, threadId)

    aiChatMock.mockClear()
    aiChatMock.mockResolvedValue(replyList("Second set."))
    const regenerated = await generateQuickReplies(
      executor,
      accountId,
      threadId,
      { regenerate: true }
    )
    expect(aiChatMock).toHaveBeenCalledTimes(1)
    expect(regenerated).toEqual({
      ok: true,
      replies: ["Second set."],
      cached: false,
    })

    aiChatMock.mockClear()
    const plain = await generateQuickReplies(executor, accountId, threadId)
    expect(aiChatMock).not.toHaveBeenCalled()
    expect(plain).toEqual({
      ok: true,
      replies: ["Second set."],
      cached: true,
    })
  })
})

// Tier-model cache identity (parity-round-2 task 2.2 pattern, task 2.4):
// the resolved tier model keys the cache AND rides the request via ONE
// resolveSurfaceRuntime resolution; a switch invalidates.
describe("generateQuickReplies tier-model cache identity", () => {
  it("caches under and requests with the tier model, not the default", async () => {
    await seedActiveProvider()
    await setSurfaceTier(executor, "quickReplies", "instant")
    await setTierModel(executor, "instant", "fast-mini-x")
    const { threadId } = await seedThread()
    aiChatMock.mockResolvedValue(replyList("Fast set."))

    const result = await generateQuickReplies(executor, accountId, threadId)
    expect(result).toEqual({
      ok: true,
      replies: ["Fast set."],
      cached: false,
    })
    expect(aiChatMock.mock.calls[0]?.[0]).toMatchObject({ model: "fast-mini-x" })
    const rows = await executor.select<{ model: string }>(
      "SELECT model FROM ai_cache"
    )
    expect(rows.map((row) => row.model)).toEqual(["fast-mini-x"])

    // Repeat request hits the tier-keyed cache without a call.
    aiChatMock.mockClear()
    const again = await generateQuickReplies(executor, accountId, threadId)
    expect(aiChatMock).not.toHaveBeenCalled()
    expect(again).toEqual({
      ok: true,
      replies: ["Fast set."],
      cached: true,
    })
  })

  it("a tier-model switch stops serving the old entries", async () => {
    await seedActiveProvider()
    await setSurfaceTier(executor, "quickReplies", "instant")
    await setTierModel(executor, "instant", "fast-mini-x")
    const { threadId } = await seedThread()
    aiChatMock.mockResolvedValue(replyList("X set."))
    await generateQuickReplies(executor, accountId, threadId)

    aiChatMock.mockClear()
    await setTierModel(executor, "instant", "fast-mini-y")
    aiChatMock.mockResolvedValue(replyList("Y set."))
    const result = await generateQuickReplies(executor, accountId, threadId)
    expect(aiChatMock).toHaveBeenCalledTimes(1)
    expect(result).toEqual({ ok: true, replies: ["Y set."], cached: false })
    const rows = await executor.select<{ model: string }>(
      "SELECT model FROM ai_cache"
    )
    expect(rows.map((row) => row.model).sort()).toEqual([
      "fast-mini-x",
      "fast-mini-y",
    ])
  })
})

/**
 * Untrusted-content hygiene (hardening batch): invisible smuggle
 * characters are stripped from the thread's subjects and bodies before
 * they enter the prompt.
 */
describe("generateQuickReplies invisible-character stripping", () => {
  it("strips zero-width characters from subjects and bodies in the prompt", async () => {
    await seedActiveProvider()
    const threadId = await createThread(executor, accountId, {
      subject: "Review\u200B",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_000_000,
      subject: "Re: Review\u200B",
      fromName: "Alice",
      fromAddress: "alice@example.com",
      bodyText: "Can we\u200B move the review to Thursday?",
    })
    aiChatMock.mockResolvedValue(replyList("Thursday works."))

    await generateQuickReplies(executor, accountId, threadId)

    const args = aiChatMock.mock.calls[0][0] as {
      messages: { role: string; content: string }[]
    }
    const content = args.messages[0].content
    expect(content).toContain("Can we move the review to Thursday?")
    expect(content).not.toContain("\u200B")
  })
})
