import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The transport seam is mocked — the service runs REAL against the mocked
// aiChat, so the assertions cover the prompt shape (grammar, today's
// date, strict output contract), the tolerant reply parsing, and the
// parser-validated query path.
vi.mock("../client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client")>()),
  aiChat: vi.fn(),
}))

import { parseSearchQuery, resolveDateTokens } from "@/services/search"

import { AiProviderError, aiChat } from "../client"
import { ASK_INBOX_GRAMMAR, translateQuestion } from "../ask-inbox"
import { setOutputLanguage } from "../settings"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"

/**
 * Ask My Inbox service tests (task 4.7, design D3): clean NL→query
 * mapping (the returned query parses with the REAL parser into the right
 * predicates), clarification on ambiguous/unmappable requests, fallback
 * to clarification on malformed model output, and date-token pass-through
 * (the token reaches the caller UNRESOLVED and the pipeline resolves it
 * at search time).
 */

const aiChatMock = vi.mocked(aiChat)

/** A fixed "today" (a Wednesday) so the prompt's date anchor is asserted
 * exactly — relative phrases resolve against it. */
const TODAY = new Date(2026, 8, 16, 12, 0, 0)

beforeEach(() => {
  aiChatMock.mockReset()
  aiChatMock.mockResolvedValue("QUERY: from:maria has:attachment")
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("translateQuestion (task 4.7, design D3)", () => {
  it("sends the question with the grammar, today's date and the askInbox surface", async () => {
    await translateQuestion("attachments from maria since monday", TODAY)

    expect(aiChatMock).toHaveBeenCalledTimes(1)
    const args = aiChatMock.mock.calls[0]![0]
    expect(args.surface).toBe("askInbox")
    expect(args.messages).toEqual([
      { role: "user", content: "attachments from maria since monday" },
    ])
    // The prompt carries the ONLY mail knowledge the model gets (D3):
    // the operator grammar, no message content.
    expect(args.system).toContain(ASK_INBOX_GRAMMAR)
    // Today's date anchors relative phrases ("since monday").
    expect(args.system).toContain("Wednesday, 2026-09-16")
    // The strict output contract + the date-token escape hatch.
    expect(args.system).toContain("QUERY:")
    expect(args.system).toContain("CLARIFY:")
    expect(args.system).toContain("__TODAY")
  })

  it("returns a clean mapping as a parser-valid query", async () => {
    aiChatMock.mockResolvedValue(
      "QUERY: from:maria has:attachment after:2026-09-14"
    )
    const result = await translateQuestion(
      "attachments from maria since monday",
      TODAY
    )

    expect(result).toEqual({
      kind: "query",
      query: "from:maria has:attachment after:2026-09-14",
    })
    if (result.kind !== "query") throw new Error("expected a query")
    // The exact query the pipeline will run parses into the intended
    // predicates — the validation the service itself applies.
    const parsed = parseSearchQuery(result.query)
    expect(parsed.from).toEqual(["maria"])
    expect(parsed.hasAttachment).toBe(true)
    expect(parsed.after).toHaveLength(1)
  })

  it("parses the reply tolerantly (fences, case, backticks)", async () => {
    aiChatMock.mockResolvedValue("```\nquery: `FROM:maria has:attachment`\n```")
    const result = await translateQuestion("maria attachments", TODAY)
    expect(result).toEqual({
      kind: "query",
      query: "FROM:maria has:attachment",
    })
    if (result.kind !== "query") throw new Error("expected a query")
    expect(parseSearchQuery(result.query).from).toEqual(["maria"])
  })

  it("returns the model's clarifying question verbatim", async () => {
    aiChatMock.mockResolvedValue(
      "CLARIFY: Which sender did you mean by maria?"
    )
    const result = await translateQuestion("maria", TODAY)
    expect(result).toEqual({
      kind: "clarification",
      question: "Which sender did you mean by maria?",
    })
  })

  it("falls back to a clarification on malformed model output", async () => {
    for (const malformed of [
      "Sure! from:maria has:attachment",
      "QUERY",
      "",
      "from:maria",
    ]) {
      aiChatMock.mockResolvedValue(malformed)
      const result = await translateQuestion("maria attachments", TODAY)
      expect(result.kind).toBe("clarification")
      if (result.kind !== "clarification") throw new Error("unreachable")
      expect(result.question).not.toBe("")
    }
  })

  it("falls back to a clarification when the query contributes no predicate", async () => {
    // Both parse to an empty predicate set ("-" is dropped by the
    // parser; the blank payload is empty) — never shown as results.
    for (const unusable of ["QUERY:", "QUERY: -"]) {
      aiChatMock.mockResolvedValue(unusable)
      const result = await translateQuestion("maria attachments", TODAY)
      expect(result.kind).toBe("clarification")
    }
  })

  it("passes date tokens through UNRESOLVED, ready for the pipeline", async () => {
    aiChatMock.mockResolvedValue(
      "QUERY: from:maria has:attachment after:__TODAY-3D__"
    )
    const result = await translateQuestion(
      "attachments from maria since three days ago",
      TODAY
    )

    if (result.kind !== "query") throw new Error("expected a query")
    // The token survives verbatim — the run seam (searchThreadsAcross-
    // Accounts) resolves it at query time (task 3.8), not the translator.
    expect(result.query).toContain("__TODAY-3D__")
    // And once resolved exactly as the pipeline does, it parses as a
    // real date bound — the validation the service applies.
    const parsed = parseSearchQuery(resolveDateTokens(result.query, TODAY))
    expect(parsed.after).toHaveLength(1)
    expect(parsed.from).toEqual(["maria"])
  })

  it("propagates provider failures for the caller's retry affordance", async () => {
    aiChatMock.mockRejectedValue(
      new AiProviderError("network", "Provider unreachable")
    )
    await expect(
      translateQuestion("attachments from maria", TODAY)
    ).rejects.toBeInstanceOf(AiProviderError)
  })
})

// Output language (parity-round-2 task 2.6, spec "AI output language"):
// the clarifying question is user-facing prose, so the ask-inbox prompt
// obeys the configured language like every other generative surface.
describe("translateQuestion output language (task 2.6)", () => {
  let executor: TestExecutor

  beforeEach(async () => {
    executor = createTestExecutor()
  })

  afterEach(() => {
    executor.close()
  })

  it("carries the language directive when set, additively", async () => {
    await setOutputLanguage(executor, "German")

    await translateQuestion("attachments from maria", TODAY, executor)

    const args = aiChatMock.mock.calls[0]![0]
    expect(args.system).toContain("Write your response in German")
    // Additive: the translation contract itself is intact.
    expect(args.system).toContain(ASK_INBOX_GRAMMAR)
    expect(args.system).toContain("Wednesday, 2026-09-16")
    expect(args.system).toContain("EXACTLY ONE line")
  })

  it("sends no directive when the language is unset (the model infers)", async () => {
    // Language never configured on the passed executor.
    await translateQuestion("attachments from maria", TODAY, executor)

    const args = aiChatMock.mock.calls[0]![0]
    expect(args.system).not.toContain("Write your response in")
    expect(args.system).toContain(ASK_INBOX_GRAMMAR)
  })

  it("fails toward unset when no executor is available (plain vite)", async () => {
    // No executor passed: getExecutor() throws outside Tauri and the read
    // degrades to unset instead of failing the translation.
    await translateQuestion("attachments from maria", TODAY)

    const args = aiChatMock.mock.calls[0]![0]
    expect(args.system).not.toContain("Write your response in")
    expect(args.system).toContain(ASK_INBOX_GRAMMAR)
  })
})
