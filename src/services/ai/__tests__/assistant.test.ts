import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The provider transport is the seam under mock: the REAL client module
// stays loaded (runAssistantTurn's gating guard constructs
// AiUnavailableError from it) with aiChat replaced, so assertions target
// call counts and the prompt/client arguments the loop builds.
const aiChatMock = vi.hoisted(() => vi.fn())

vi.mock("../client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client")>()
  return { ...actual, aiChat: aiChatMock }
})

import {
  ASSISTANT_TOOLS,
  MAX_TOOL_ROUNDS,
  parseAssistantReply,
  runAssistantTurn,
} from "../assistant"
import { AiProviderError, AiUnavailableError } from "../client"
import { addProvider, setActiveProvider, setAiEnabled } from "../settings"
import { estimateTokens, recordAiUsage, resolveUsageRecord } from "../usage"
import {
  createAccount,
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { recomputeThreadCaches } from "@/services/db/threads"

/**
 * Assistant loop tests (ai-assistant-panel tasks 2.1–2.4, design
 * D2/D3/D4): the strict envelope parse, the tool loop over REAL database
 * lookups (search via FTS, read_thread with its body/message caps,
 * list_unread across active accounts), the touched-thread contract
 * (unsurfaced ids rejected, ids carried across turns), the hard
 * MAX_TOOL_ROUNDS cap with its forced final call, the client-side
 * chars/4 cost accumulation, error propagation, and the per-call
 * `ai_usage` rows. Transport/gating failures propagate (the dialog owns
 * Retry / hide-vs-show); the unconfigured guard is this service's own
 * throw, asserted with the client mock never called.
 */

/** The args shape the loop passes aiChat (as the assertions read it). */
interface AssistantChatArgs {
  system: string
  messages: { role: string; content: string }[]
  maxTokens?: number
  surface: string
  model?: string
}

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

/** Enable AI with an active keyed-less-config provider (no key sealing —
 * the mocked aiChat never resolves keys). */
async function seedActiveProvider(model = "claude-sonnet-4-5") {
  await setAiEnabled(executor, true)
  const created = await addProvider(executor, {
    kind: "anthropic",
    label: "Work",
    model,
  })
  await setActiveProvider(executor, created.id)
}

/** One thread with a single (unread unless `read`) message, caches
 * recomputed like sync does. Returns the thread id. */
async function seedThread(options: {
  subject?: string
  bodyText?: string
  date?: number
  fromName?: string
  fromAddress?: string
  read?: boolean
}): Promise<string> {
  const threadId = await createThread(executor, accountId, {
    subject: options.subject,
  })
  await createMessage(executor, {
    threadId,
    accountId,
    date: options.date ?? 1_700_000_000,
    subject: options.subject,
    fromName: options.fromName ?? "Alice",
    fromAddress: options.fromAddress ?? "alice@example.com",
    bodyText: options.bodyText,
    isRead: options.read,
  })
  await recomputeThreadCaches(executor, threadId)
  return threadId
}

describe("parseAssistantReply (tasks 2.1, design D2)", () => {
  it("parses a strict tool-call object with its args", () => {
    const parsed = parseAssistantReply(
      '{"tool": "search", "args": {"query": "from:alice has:attachment"}}'
    )
    expect(parsed).toEqual({
      kind: "tool",
      call: { tool: "search", args: { query: "from:alice has:attachment" } },
    })
  })

  it("treats a prose reply as the final answer", () => {
    const parsed = parseAssistantReply("Here is what I found in your mail.")
    expect(parsed).toEqual({
      kind: "answer",
      text: "Here is what I found in your mail.",
    })
  })

  it("treats malformed JSON as the final answer instead of throwing", () => {
    const parsed = parseAssistantReply('{"tool": "search", "args":')
    expect(parsed.kind).toBe("answer")
  })

  it("treats JSON without a string tool key as the final answer", () => {
    expect(parseAssistantReply('{"answer": 42}').kind).toBe("answer")
    expect(parseAssistantReply('{"tool": 42}').kind).toBe("answer")
    expect(parseAssistantReply('["tool", "search"]').kind).toBe("answer")
  })

  it("keeps an unknown tool name as a tool call for the TOOL_ERROR path", () => {
    const parsed = parseAssistantReply(
      '{"tool": "send_email", "args": {"to": "x"}}'
    )
    expect(parsed).toEqual({
      kind: "tool",
      call: { tool: "send_email", args: { to: "x" } },
    })
  })
})

describe("runAssistantTurn loop (tasks 2.2, design D2)", () => {
  it("runs a search round and returns the answer with the surfaced thread", async () => {
    await seedActiveProvider()
    const threadId = await seedThread({
      subject: "Quarterly report",
      bodyText: "The Q3 numbers are attached for review.",
    })
    aiChatMock
      .mockResolvedValueOnce(
        '{"tool": "search", "args": {"query": "quarterly"}}'
      )
      .mockResolvedValueOnce(
        "The 'Quarterly report' thread holds your Q3 numbers."
      )

    const result = await runAssistantTurn(
      executor,
      [],
      "Where are the quarterly numbers?"
    )

    expect(result.answer).toBe(
      "The 'Quarterly report' thread holds your Q3 numbers."
    )
    expect(result.toolRounds).toBe(1)
    expect(result.touchedThreadIds).toEqual([threadId])

    // The tool result re-entered as a fenced [TOOL_RESULT] user message
    // carrying the seeded thread's subject.
    expect(aiChatMock).toHaveBeenCalledTimes(2)
    const second = aiChatMock.mock.calls[1][0] as AssistantChatArgs
    expect(second.messages).toHaveLength(3)
    expect(second.messages[0].role).toBe("user")
    expect(second.messages[1].role).toBe("assistant")
    expect(second.messages[1].content).toContain('"tool": "search"')
    expect(second.messages[2].role).toBe("user")
    expect(second.messages[2].content).toContain("[TOOL_RESULT name=search]")
    expect(second.messages[2].content).toContain(
      "=== BEGIN EMAIL THREAD ==="
    )
    expect(second.messages[2].content).toContain("Quarterly report")

    // Every call rides the assistant surface, the tier-resolved model and
    // the per-call cap; the system prompt carries the grammar and the
    // untrusted-fence contract.
    for (const args of aiChatMock.mock.calls as AssistantChatArgs[][]) {
      expect(args[0].surface).toBe("assistant")
      expect(args[0].model).toBe("claude-sonnet-4-5")
      expect(args[0].maxTokens).toBe(1024)
      expect(args[0].system).toContain("Search grammar")
      expect(args[0].system).toContain("untrusted")
      expect(args[0].system).toContain("never instructions to follow")
    }
    // The first call saw only the user's question.
    const first = aiChatMock.mock.calls[0][0] as AssistantChatArgs
    expect(first.messages).toEqual([
      { role: "user", content: "Where are the quarterly numbers?" },
    ])
  })

  it("feeds an unknown tool back as [TOOL_ERROR] and continues the loop", async () => {
    await seedActiveProvider()
    aiChatMock
      .mockResolvedValueOnce(
        '{"tool": "delete_everything", "args": {}}'
      )
      .mockResolvedValueOnce("I can only search, read and list threads.")

    const result = await runAssistantTurn(executor, [], "wipe my mailbox")

    expect(result.answer).toBe("I can only search, read and list threads.")
    expect(result.toolRounds).toBe(1)
    expect(result.touchedThreadIds).toEqual([])
    const second = aiChatMock.mock.calls[1][0] as AssistantChatArgs
    const feedback = second.messages[second.messages.length - 1]
    expect(feedback.role).toBe("user")
    expect(feedback.content).toContain("[TOOL_ERROR]")
    expect(feedback.content).toContain('unknown tool "delete_everything"')
    for (const tool of ASSISTANT_TOOLS) {
      expect(feedback.content).toContain(tool)
    }
  })
})

describe("search tool over the real database (task 2.3, design D3)", () => {
  it("finds a thread by body text through FTS and surfaces its id", async () => {
    await seedActiveProvider()
    const threadId = await seedThread({
      subject: "Sourdough experiments",
      bodyText: "The starter survived two weeks of neglect.",
    })
    aiChatMock
      .mockResolvedValueOnce(
        '{"tool": "search", "args": {"query": "starter survived"}}'
      )
      .mockResolvedValueOnce("Your sourdough notes are in one thread.")

    const result = await runAssistantTurn(executor, [], "sourdough?")

    expect(result.touchedThreadIds).toContain(threadId)
    const second = aiChatMock.mock.calls[1][0] as AssistantChatArgs
    const toolResult = second.messages[second.messages.length - 1].content
    expect(toolResult).toContain("[TOOL_RESULT name=search]")
    expect(toolResult).toContain("Sourdough experiments")
  })
})

describe("read_thread tool (task 2.3, design D3)", () => {
  it("caps bodies at 4000 chars and threads at 20 messages", async () => {
    await seedActiveProvider()
    const longThreadId = await createThread(executor, accountId, {
      subject: "Warranty fine print",
    })
    const longBody = "HEAD " + "x".repeat(5000) + " TAILMARKER"
    await createMessage(executor, {
      threadId: longThreadId,
      accountId,
      date: 1_700_000_000,
      fromAddress: "legal@example.com",
      bodyText: longBody,
    })
    await recomputeThreadCaches(executor, longThreadId)

    aiChatMock
      .mockResolvedValueOnce(
        JSON.stringify({ tool: "read_thread", args: { threadId: longThreadId } })
      )
      .mockResolvedValueOnce("The warranty text is boilerplate.")

    const result = await runAssistantTurn(executor, [], "summarize", {
      touchedThreadIds: [longThreadId],
    })

    expect(result.touchedThreadIds).toEqual([longThreadId])
    const second = aiChatMock.mock.calls[1][0] as AssistantChatArgs
    const payload = second.messages[second.messages.length - 1].content
    expect(payload).toContain("[TOOL_RESULT name=read_thread]")
    expect(payload).toContain("Warranty fine print")
    // The body is hard-sliced at 4000 chars: the slice is present, the
    // tail beyond it never is.
    expect(payload).toContain(longBody.slice(0, 4000))
    expect(payload).not.toContain("TAILMARKER")

    // At most 20 numbered messages are shown, overflow stated.
    const manyThreadId = await createThread(executor, accountId, {
      subject: "Long backlog",
    })
    for (let index = 0; index < 25; index += 1) {
      await createMessage(executor, {
        threadId: manyThreadId,
        accountId,
        date: 1_700_000_000 + index,
        fromAddress: `writer${index}@example.com`,
        bodyText: `Message number ${index}.`,
      })
    }
    await recomputeThreadCaches(executor, manyThreadId)
    aiChatMock.mockReset()
    aiChatMock
      .mockResolvedValueOnce(
        JSON.stringify({
          tool: "read_thread",
          args: { threadId: manyThreadId },
        })
      )
      .mockResolvedValueOnce("A long backlog indeed.")

    await runAssistantTurn(executor, [], "how long?", {
      touchedThreadIds: [manyThreadId],
    })

    const args = aiChatMock.mock.calls[1][0] as AssistantChatArgs
    const many = args.messages[args.messages.length - 1].content
    expect(many).toContain("Messages: 25 (showing the first 20)")
    expect(many).toContain("[19]")
    expect(many).not.toContain("[20]")
  })

  it("rejects an unsurfaced id with [TOOL_ERROR] and answers on the next reply", async () => {
    await seedActiveProvider()
    aiChatMock
      .mockResolvedValueOnce(
        '{"tool": "read_thread", "args": {"threadId": "thread-never-seen"}}'
      )
      .mockResolvedValueOnce("I could not open that thread.")

    const result = await runAssistantTurn(executor, [], "open thread-never-seen")

    expect(result.answer).toBe("I could not open that thread.")
    expect(result.toolRounds).toBe(1)
    expect(result.touchedThreadIds).toEqual([])
    const second = aiChatMock.mock.calls[1][0] as AssistantChatArgs
    const feedback = second.messages[second.messages.length - 1]
    expect(feedback.role).toBe("user")
    expect(feedback.content).toContain("[TOOL_ERROR]")
    expect(feedback.content).toContain("unknown thread")
  })

  it("accepts prior-turn touched ids and passes the caller's history through", async () => {
    await seedActiveProvider()
    const threadId = await seedThread({
      subject: "Quarterly report",
      bodyText: "Q3 numbers attached.",
    })
    const firstQuestion = "Where are the quarterly numbers?"
    aiChatMock
      .mockResolvedValueOnce(
        '{"tool": "search", "args": {"query": "quarterly"}}'
      )
      .mockResolvedValueOnce("Found the Quarterly report thread.")

    const firstTurn = await runAssistantTurn(executor, [], firstQuestion)
    expect(firstTurn.touchedThreadIds).toEqual([threadId])

    // The caller accumulates history and the touched set across turns of
    // the open conversation (design D4).
    const secondQuestion = "What thread was that again?"
    aiChatMock.mockReset()
    aiChatMock
      .mockResolvedValueOnce(
        JSON.stringify({ tool: "read_thread", args: { threadId } })
      )
      .mockResolvedValueOnce("The Quarterly report thread from accounting.")

    const secondTurn = await runAssistantTurn(
      executor,
      [
        { role: "user", content: firstQuestion },
        { role: "assistant", content: firstTurn.answer },
      ],
      secondQuestion,
      { touchedThreadIds: firstTurn.touchedThreadIds }
    )

    // The history rides ahead of the new user message, verbatim.
    const first = aiChatMock.mock.calls[0][0] as AssistantChatArgs
    expect(first.messages).toEqual([
      { role: "user", content: firstQuestion },
      { role: "assistant", content: firstTurn.answer },
      { role: "user", content: secondQuestion },
    ])
    // The prior-turn id was accepted, so read_thread ran and returned the
    // thread (the union keeps the id exactly once).
    const second = aiChatMock.mock.calls[1][0] as AssistantChatArgs
    expect(second.messages[second.messages.length - 1].content).toContain(
      "Quarterly report"
    )
    expect(secondTurn.answer).toBe(
      "The Quarterly report thread from accounting."
    )
    expect(secondTurn.touchedThreadIds).toEqual([threadId])
  })
})

describe("list_unread tool (task 2.3, design D3)", () => {
  it("lists only unread threads across the active accounts, newest first", async () => {
    await seedActiveProvider()
    const secondAccountId = await createAccount(executor)
    const olderUnread = await seedThread({
      subject: "Invoice from February",
      bodyText: "Your February invoice is ready.",
      date: 1_700_000_300,
    })
    await seedThread({
      subject: "Old newsletter",
      bodyText: "Everything you missed this month.",
      date: 1_700_000_400,
      read: true,
    })
    const newerUnread = await createThread(executor, secondAccountId, {
      subject: "Receipt for order 5521",
    })
    await createMessage(executor, {
      threadId: newerUnread,
      accountId: secondAccountId,
      date: 1_700_000_500,
      fromAddress: "shop@example.com",
      bodyText: "Thanks for your order.",
    })
    await recomputeThreadCaches(executor, newerUnread)

    aiChatMock
      .mockResolvedValueOnce('{"tool": "list_unread", "args": {}}')
      .mockResolvedValueOnce("You have two unread threads.")

    const result = await runAssistantTurn(executor, [], "what's unread?")

    const second = aiChatMock.mock.calls[1][0] as AssistantChatArgs
    const payload = second.messages[second.messages.length - 1].content
    expect(payload).toContain("[TOOL_RESULT name=list_unread]")
    expect(payload).toContain("Invoice from February")
    expect(payload).toContain("Receipt for order 5521")
    expect(payload).not.toContain("Old newsletter")
    // Newest first across the merge.
    expect(payload.indexOf("Receipt for order 5521")).toBeLessThan(
      payload.indexOf("Invoice from February")
    )
    expect(result.touchedThreadIds).toEqual([newerUnread, olderUnread])
    expect(result.toolRounds).toBe(1)
  })
})

describe("tool-round cap (tasks 2.2, design D2)", () => {
  const TOOL_CALL = '{"tool": "search", "args": {"query": "quarterly"}}'

  it("answers directly when the model stops after exactly six rounds", async () => {
    await seedActiveProvider()
    await seedThread({ subject: "Quarterly report" })
    for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
      aiChatMock.mockResolvedValueOnce(TOOL_CALL)
    }
    aiChatMock.mockResolvedValueOnce("Answered after six rounds.")

    const result = await runAssistantTurn(executor, [], "quarterly?")

    expect(result.answer).toBe("Answered after six rounds.")
    expect(result.toolRounds).toBe(MAX_TOOL_ROUNDS)
    expect(aiChatMock).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 1)
    for (const call of aiChatMock.mock.calls as AssistantChatArgs[][]) {
      expect(
        call[0].messages.some((message) => message.content.includes("[TOOL_CAP]"))
      ).toBe(false)
    }
  })

  it("stops at the cap, forces a final call and returns its reply verbatim", async () => {
    await seedActiveProvider()
    await seedThread({ subject: "Quarterly report" })
    // Seven tool-call replies: six execute, the seventh hits the cap.
    for (let round = 0; round < MAX_TOOL_ROUNDS + 1; round += 1) {
      aiChatMock.mockResolvedValueOnce(TOOL_CALL)
    }
    aiChatMock.mockResolvedValueOnce("Final answer after the cap.")

    const result = await runAssistantTurn(executor, [], "quarterly?")

    expect(result.answer).toBe("Final answer after the cap.")
    expect(result.toolRounds).toBe(MAX_TOOL_ROUNDS)
    // 6 executed rounds + 1 cap-trigger + 1 forced final call.
    expect(aiChatMock).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS + 2)
    // The cap-triggering call asked for round seven; the forced call's
    // last message is the instruction, and exactly six results exist.
    const trigger = aiChatMock.mock.calls[MAX_TOOL_ROUNDS][0] as AssistantChatArgs
    const forced = aiChatMock.mock.calls[MAX_TOOL_ROUNDS + 1][
      0
    ] as AssistantChatArgs
    expect(
      trigger.messages.some((message) => message.content.includes("[TOOL_CAP]"))
    ).toBe(false)
    const lastForced = forced.messages[forced.messages.length - 1]
    expect(lastForced.role).toBe("user")
    expect(lastForced.content).toContain("[TOOL_CAP]")
    expect(lastForced.content).toContain("answer the user's question now")
    expect(
      forced.messages.filter((message) =>
        message.content.includes("[TOOL_RESULT name=search]")
      )
    ).toHaveLength(MAX_TOOL_ROUNDS)
  })
})

describe("turn cost (tasks 2.4, design D4)", () => {
  it("accumulates chars/4 over everything sent and received", async () => {
    await seedActiveProvider()
    const reply = "Sure — the contract arrives Friday."
    aiChatMock.mockResolvedValueOnce(reply)

    const userMessage = "When does the contract arrive?"
    const result = await runAssistantTurn(executor, [], userMessage)

    // The usage.ts basis: estimateTokens (chars/4, min 1) per text, over
    // the system prompt and each message content sent plus the reply.
    const args = aiChatMock.mock.calls[0][0] as AssistantChatArgs
    const expected =
      estimateTokens(args.system) +
      estimateTokens(userMessage) +
      estimateTokens(reply)
    expect(result.approxTokens).toBe(expected)
    expect(result.approxTokens).toBeGreaterThan(0)
  })
})

describe("gating and transport errors (tasks 2.2)", () => {
  it("propagates AiUnavailableError without calling the provider when unconfigured", async () => {
    await expect(
      runAssistantTurn(executor, [], "any question")
    ).rejects.toBeInstanceOf(AiUnavailableError)
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it("propagates provider errors from the loop", async () => {
    await seedActiveProvider()
    aiChatMock.mockRejectedValue(
      new AiProviderError("rate_limited", "slow down", 429)
    )
    await expect(
      runAssistantTurn(executor, [], "any question")
    ).rejects.toMatchObject({
      name: "AiProviderError",
      kind: "rate_limited",
    })
  })
})

describe("usage rows (tasks 2.4, spec: one row per completed call)", () => {
  it("records one assistant-surface row per completed aiChat call", async () => {
    await seedActiveProvider()
    await seedThread({ subject: "Quarterly report" })
    // Mirror the shared client's fire-and-forget usage insert
    // (client.ts) so the mocked transport leaves the rows a live
    // provider would — the loop itself never writes usage.
    const replies = [
      '{"tool": "search", "args": {"query": "quarterly"}}',
      "Two threads mention the quarterly numbers.",
    ]
    let call = 0
    aiChatMock.mockImplementation(async (args: AssistantChatArgs) => {
      const content = replies[call] ?? ""
      call += 1
      await recordAiUsage(
        executor,
        resolveUsageRecord({
          surface: args.surface,
          model: args.model ?? "claude-sonnet-4-5",
          system: args.system ?? null,
          messages: args.messages,
          content,
        })
      )
      return content
    })

    await runAssistantTurn(executor, [], "Where are the quarterly numbers?")

    const rows = await executor.select<{
      surface: string
      model: string
    }>("SELECT surface, model FROM ai_usage")
    expect(rows).toHaveLength(2)
    expect(
      rows.every((row) => row.surface === "assistant")
    ).toBe(true)
    expect(
      rows.every((row) => row.model === "claude-sonnet-4-5")
    ).toBe(true)
  })
})
