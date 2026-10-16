import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Same seams as the main assistant suite: the transport mock controls
// the model's replies, the Tauri path API is faked (the models dir), and
// the embed seam stands in for the Rust engine.
const aiChatMock = vi.hoisted(() => vi.fn())

vi.mock("@tauri-apps/api/path", () => ({
  appDataDir: async () => "/tmp/emailer-test-appdata",
  join: (...parts: string[]) => parts.join("/"),
}))

vi.mock("../client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client")>()
  return { ...actual, aiChat: aiChatMock }
})

import {
  ASSISTANT_TOOLS,
  SEED_MAX_THREADS,
  runAssistantTurn,
} from "../assistant"
import { setAiEnabled, addProvider, setActiveProvider } from "../settings"
import {
  bumpVectorGeneration,
  setEmbedTextsImplForTests,
  type EmbedTextsFn,
} from "@/services/embeddings/indexer"
import {
  setSemanticSearchEnabled,
} from "@/services/embeddings/settings"
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
 * Assistant semantic integration tests (parity-round-3 task 6.4, design
 * D2): the read-only semantic_search tool in the sealed registry (with
 * its citations), the inbox-scoped retrieval seed (fenced, size-capped,
 * cited), the unchanged usage accounting (the seed is not a model call),
 * and the four degradation paths (index disabled/missing → no seed, no
 * error, behavior exactly as before).
 */

interface AssistantChatArgs {
  system: string
  messages: { role: string; content: string }[]
  maxTokens?: number
  surface: string
  model?: string
}

let executor: TestExecutor
let accountId: string
let embedImpl: EmbedTextsFn

beforeEach(async () => {
  executor = createTestExecutor()
  accountId = await createAccount(executor)
  aiChatMock.mockReset()
  await setAiEnabled(executor, true)
  const created = await addProvider(executor, {
    kind: "anthropic",
    label: "Work",
    model: "claude-sonnet-4-5",
  })
  await setActiveProvider(executor, created.id)
  embedImpl = async (_dir, batch) =>
    batch.map((text) => (text.includes("deposit") ? [1, 0, 0, 0] : [0, 1, 0, 0]))
  setEmbedTextsImplForTests(embedImpl)
})

afterEach(() => {
  setEmbedTextsImplForTests(null)
  executor.close()
})

/** Enable + build the semantic index over one deposit thread and one
 * unrelated thread (the keyword leg still matches both by "deposit" —
 * the venue thread mentions deposit terms). */
async function seedIndexedThreads(): Promise<{ deposit: string; other: string }> {
  const deposit = await createThread(executor, accountId, {
    subject: "Venue deposit schedule",
  })
  await createMessage(executor, {
    threadId: deposit,
    accountId,
    date: 1,
    subject: "Venue deposit schedule",
    bodyText: "the venue coordinator confirmed the deposit is due friday",
  })
  await recomputeThreadCaches(executor, deposit)
  const other = await createThread(executor, accountId, {
    subject: "Venue booking",
  })
  await createMessage(executor, {
    threadId: other,
    accountId,
    date: 2,
    subject: "Venue booking",
    bodyText: "the venue coordinator mentioned deposit terms briefly",
  })
  await recomputeThreadCaches(executor, other)
  await executor.execute("UPDATE threads SET snippet = $1 WHERE id = $2", [
    "deposit due friday",
    deposit,
  ])
  await executor.execute("UPDATE threads SET snippet = $1 WHERE id = $2", [
    "deposit terms mentioned",
    other,
  ])

  await setSemanticSearchEnabled(executor, true)
  for (const modelId of [
    "bge-small-tokenizer",
    "bge-small-config",
    "bge-small-safetensors",
  ]) {
    await executor.execute(
      `INSERT INTO model_downloads (model_id, state, bytes_downloaded, total_bytes)
       VALUES ($1, 'completed', 1, 1)
       ON CONFLICT(model_id) DO UPDATE SET state = 'completed'`,
      [modelId]
    )
  }
  await runIndexSlice()
  return { deposit, other }
}

async function runIndexSlice(): Promise<void> {
  const { runSemanticIndexSlice } = await import(
    "@/services/embeddings/indexer"
  )
  await runSemanticIndexSlice(executor, { skipGate: true })
  bumpVectorGeneration()
}

describe("semantic_search tool (task 6.4a)", () => {
  it("is a registered tool and appears in the system prompt", async () => {
    expect(ASSISTANT_TOOLS).toContain("semantic_search")
    aiChatMock.mockResolvedValue("Answer without tools.")
    await runAssistantTurn(executor, [], "hello")
    const args = aiChatMock.mock.calls[0][0] as AssistantChatArgs
    expect(args.system).toContain("semantic_search")
    expect(args.system).toContain("SEMANTIC_CONTEXT")
  })

  it("returns cited rows with similarity scores and surfaces the ids", async () => {
    const { deposit, other } = await seedIndexedThreads()
    aiChatMock
      .mockResolvedValueOnce(
        '{"tool": "semantic_search", "args": {"query": "venue deposit"}}'
      )
      .mockResolvedValueOnce("The deposit is due Friday.")
    const result = await runAssistantTurn(executor, [], "venue deposit")

    // The tool result message carries the cited rows.
    const toolResult = (aiChatMock.mock.calls[1][0] as AssistantChatArgs)
      .messages.at(-1)!.content
    expect(toolResult).toContain("[TOOL_RESULT name=semantic_search]")
    expect(toolResult).toContain("=== BEGIN EMAIL THREAD ===")
    expect(toolResult).toContain(`id: ${deposit}`)
    expect(toolResult).toContain(`id: ${other}`)
    expect(toolResult).toMatch(/similarity \d\.\d{3}/)
    // Both hits are surfaced (citations = source chips + read_thread
    // allow-list).
    expect(result.touchedThreadIds).toContain(deposit)
    expect(result.touchedThreadIds).toContain(other)
    expect(result.toolRounds).toBe(1)
  })

  it("degrades to a plain no-error result when the index is disabled", async () => {
    // AI configured, threads exist, semantic feature OFF (default).
    const threadId = await createThread(executor, accountId, {
      subject: "Deposit",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1,
      bodyText: "deposit",
    })
    aiChatMock
      .mockResolvedValueOnce(
        '{"tool": "semantic_search", "args": {"query": "deposit"}}'
      )
      .mockResolvedValueOnce("Nothing found — the index is off.")
    const result = await runAssistantTurn(executor, [], "deposit")

    const toolResult = (aiChatMock.mock.calls[1][0] as AssistantChatArgs)
      .messages.at(-1)!.content
    // A TOOL_RESULT, not a TOOL_ERROR: the model is told to fall back,
    // no error surfaced.
    expect(toolResult).toContain("[TOOL_RESULT name=semantic_search]")
    expect(toolResult).toContain("No semantic index is available")
    expect(toolResult).not.toContain("[TOOL_ERROR]")
    expect(result.touchedThreadIds).toEqual([])
  })

  it("rejects an empty query like every other tool arg violation", async () => {
    aiChatMock
      .mockResolvedValueOnce('{"tool": "semantic_search", "args": {}}')
      .mockResolvedValueOnce("ok")
    await runAssistantTurn(executor, [], "q")
    const toolResult = (aiChatMock.mock.calls[1][0] as AssistantChatArgs)
      .messages.at(-1)!.content
    expect(toolResult).toContain("[TOOL_ERROR]")
    expect(toolResult).toContain('needs a non-empty "query"')
  })
})

describe("retrieval seed (task 6.4b)", () => {
  it("prepends a fenced cited block on the opening turn when hits exist", async () => {
    const { deposit } = await seedIndexedThreads()
    aiChatMock.mockResolvedValue("The deposit is due Friday.")
    const result = await runAssistantTurn(executor, [], "when is my deposit due")

    const args = aiChatMock.mock.calls[0][0] as AssistantChatArgs
    const firstUser = args.messages[0]
    expect(firstUser.role).toBe("user")
    expect(firstUser.content).toContain("[SEMANTIC_CONTEXT]")
    // The fence + hygiene contract applies to the seeded payload.
    expect(firstUser.content).toContain("=== BEGIN EMAIL THREAD ===")
    expect(firstUser.content).toContain("=== END EMAIL THREAD ===")
    expect(firstUser.content).toContain(`id: ${deposit}`)
    expect(firstUser.content.endsWith("when is my deposit due")).toBe(true)
    // Seeded threads are cited exactly like tool results.
    expect(result.touchedThreadIds).toContain(deposit)
    // One model call — the seed is not a call of its own.
    expect(aiChatMock).toHaveBeenCalledTimes(1)
  })

  it("only seeds the conversation's opening turn, not later turns", async () => {
    await seedIndexedThreads()
    aiChatMock.mockResolvedValue("ack")
    const history = [
      { role: "user" as const, content: "first question" },
      { role: "assistant" as const, content: "first answer" },
    ]
    await runAssistantTurn(executor, history, "follow-up about deposits")
    const args = aiChatMock.mock.calls[0][0] as AssistantChatArgs
    const lastUser = args.messages.at(-1)!
    expect(lastUser.content).toBe("follow-up about deposits")
    expect(lastUser.content).not.toContain("SEMANTIC_CONTEXT")
  })

  it("respects the inbox-scoped flag (redirected conversations get no seed)", async () => {
    await seedIndexedThreads()
    aiChatMock.mockResolvedValue("ack")
    await runAssistantTurn(executor, [], "deposit", { inboxScoped: false })
    const args = aiChatMock.mock.calls[0][0] as AssistantChatArgs
    expect(args.messages[0].content).not.toContain("SEMANTIC_CONTEXT")
  })

  it("caps the seed block size with an explicit overflow note", async () => {
    // Long SUBJECTS (not per-row capped): three well-fed rows blow the
    // 4000-char block cap, so the tail must drop whole rows WITH a note,
    // never truncate mid-row silently.
    const longSubject = "deposit ".repeat(200)
    const threads: string[] = []
    for (let index = 0; index < 6; index += 1) {
      const threadId = await createThread(executor, accountId, {
        subject: `${longSubject} ${index}`,
      })
      await createMessage(executor, {
        threadId,
        accountId,
        date: index + 1,
        subject: `${longSubject} ${index}`,
        bodyText: "deposit body",
      })
      await recomputeThreadCaches(executor, threadId)
      await executor.execute("UPDATE threads SET snippet = $1 WHERE id = $2", [
        "deposit",
        threadId,
      ])
      threads.push(threadId)
    }
    await setSemanticSearchEnabled(executor, true)
    for (const modelId of [
      "bge-small-tokenizer",
      "bge-small-config",
      "bge-small-safetensors",
    ]) {
      await executor.execute(
        `INSERT INTO model_downloads (model_id, state, bytes_downloaded, total_bytes)
         VALUES ($1, 'completed', 1, 1)
         ON CONFLICT(model_id) DO UPDATE SET state = 'completed'`,
        [modelId]
      )
    }
    await runIndexSlice()

    aiChatMock.mockResolvedValue("ack")
    await runAssistantTurn(executor, [], "deposit")
    const args = aiChatMock.mock.calls[0][0] as AssistantChatArgs
    const seeded = args.messages[0].content
    expect(seeded).toContain("[SEMANTIC_CONTEXT]")
    expect(seeded).toContain("more not shown")
    // The seed (block + question) stays bounded well under 2x the cap.
    expect(seeded.length).toBeLessThan(2 * 4000 + 200)
    void threads
  })

  it("cites at most SEED_MAX_THREADS threads", async () => {
    await seedIndexedThreads()
    aiChatMock.mockResolvedValue("ack")
    const result = await runAssistantTurn(executor, [], "deposit")
    expect(result.touchedThreadIds.length).toBeLessThanOrEqual(SEED_MAX_THREADS)
  })
})

describe("usage + tier (task 6.4c)", () => {
  it("counts the seed inside the existing turn cost, with no extra calls", async () => {
    await seedIndexedThreads()
    aiChatMock.mockResolvedValue("The deposit is due Friday.")
    const seeded = await runAssistantTurn(executor, [], "when is my deposit due")
    expect(aiChatMock).toHaveBeenCalledTimes(1)

    // The identical-shape turn with the feature OFF costs strictly less
    // (the seed text rides the same single call's char/4 accounting; no
    // extra model call exists to bill).
    await setSemanticSearchEnabled(executor, false)
    aiChatMock.mockClear()
    aiChatMock.mockResolvedValue("The deposit is due Friday.")
    const plain = await runAssistantTurn(executor, [], "when is my deposit due")
    expect(aiChatMock).toHaveBeenCalledTimes(1)
    expect(seeded.approxTokens).toBeGreaterThan(plain.approxTokens)
    // The surface stays the assistant (tier routing unchanged).
    const args = aiChatMock.mock.calls[0][0] as AssistantChatArgs
    expect(args.surface).toBe("assistant")
    expect(args.model).toBe("claude-sonnet-4-5")
  })
})

describe("degradation (task 6.4d)", () => {
  it("behaves exactly as before when the index was never built", async () => {
    // No threads, no index, no model rows — the plain answer path.
    aiChatMock.mockResolvedValue("Plain answer.")
    const result = await runAssistantTurn(executor, [], "anything")
    expect(result.answer).toBe("Plain answer.")
    expect(result.touchedThreadIds).toEqual([])
    expect(result.toolRounds).toBe(0)
    const args = aiChatMock.mock.calls[0][0] as AssistantChatArgs
    expect(args.messages[0].content).toBe("anything")
  })

  it("a seeded thread id is readable with read_thread", async () => {
    const { deposit } = await seedIndexedThreads()
    aiChatMock
      .mockResolvedValueOnce(
        `{"tool": "read_thread", "args": {"threadId": "${deposit}"}}`
      )
      .mockResolvedValueOnce("Read it.")
    const result = await runAssistantTurn(
      executor,
      [],
      "when is my deposit due"
    )
    // The seeded id passed read_thread's allow-list (citation contract).
    const toolResult = (aiChatMock.mock.calls[1][0] as AssistantChatArgs)
      .messages.at(-1)!.content
    expect(toolResult).toContain("[TOOL_RESULT name=read_thread]")
    expect(toolResult).toContain(`Thread id: ${deposit}`)
    expect(result.answer).toBe("Read it.")
  })
})
