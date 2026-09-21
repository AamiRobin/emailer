import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The AI transport is the seam under mock (assist.test.ts pattern): the
// REAL client module stays loaded — the tier-resolving
// resolveSurfaceRuntime runs for real — with aiChat replaced; the task
// 4.9 precedence tests assert against this mock (decided messages and a
// disabled assist must leave it untouched).
const aiChatMock = vi.hoisted(() => vi.fn())

vi.mock("../../ai/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../ai/client")>()
  return { ...actual, aiChat: aiChatMock }
})

import { createAccount, createThread } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import {
  getSenderCategory,
  setSenderCategory,
} from "../sender-categories"
import { createRule } from "../../rules/db"
import { runIngestionRules } from "../../rules/ingestion"
import {
  categorizationInputFromEvent,
  categorizeIncomingMessages,
  type IncomingCategorizationInput,
} from "../ingestion"
import type { IngestionEvent } from "../../rules/ingestion"
import { aiCacheStats } from "../../ai/cache"
import {
  addProvider,
  setActiveProvider,
  setAiEnabled,
  setSurfaceEnabled,
} from "../../ai/settings"
import { setDefaultKeyStore } from "../../crypto/key-management"
import { createInMemoryKeyStore } from "../../crypto/__tests__/in-memory-key-store"

/**
 * The categorization consumer of the ingestion-hook flow (task 3.3,
 * design D4): every new message's thread gets its category written BEFORE
 * the sync engines finalize the new-mail count (which is what the
 * scheduler forwards to notifyNewMail) — running against the real schema.
 * The keep-first UPDATE contract and the sender-override ranking are the
 * DB-level behavior under test here; the heuristics themselves are
 * covered pure in classify.test.ts.
 */

let executor: TestExecutor
let accountId: string
let warn: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  executor = createTestExecutor()
  accountId = await createAccount(executor, "imap")
  setDefaultKeyStore(createInMemoryKeyStore())
  aiChatMock.mockReset()
  aiChatMock.mockResolvedValue("newsletters")
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  setDefaultKeyStore(null)
  executor.close()
})

/** The full task 4.9 opt-in: active provider + assist surface on. */
async function enableAssist(): Promise<void> {
  await setAiEnabled(executor, true)
  const created = await addProvider(executor, {
    kind: "anthropic",
    label: "Test",
    model: "test-model",
    apiKey: "sk-test",
  })
  await setActiveProvider(executor, created.id)
  await setSurfaceEnabled(executor, "categorizationAssist", true)
}

/** An IngestionEvent the engines would hand over, with header capture. */
function eventFor(threadId: string, overrides?: Partial<IngestionEvent>): IngestionEvent {
  return {
    messageRowId: `msg-${threadId}`,
    threadId,
    fromAddress: "ada@example.com",
    fromName: null,
    toJson: null,
    ccJson: null,
    bccJson: null,
    subject: "Hello",
    date: 1000,
    snippet: null,
    labelNames: ["INBOX"],
    isRead: false,
    isStarred: false,
    hasAttachments: false,
    sizeEstimate: null,
    threadHasUserMessage: false,
    isMailingList: false,
    headers: {},
    ...overrides,
  }
}

async function seedThread(): Promise<string> {
  return createThread(executor, accountId, { subject: "Arrival" })
}

async function categoryOf(threadId: string): Promise<string | null> {
  const rows = await executor.select<{ category: string | null }>(
    "SELECT category FROM threads WHERE id = $1",
    [threadId]
  )
  return rows[0]?.category ?? null
}

function input(
  threadId: string,
  overrides?: Partial<IncomingCategorizationInput>
): IncomingCategorizationInput {
  return {
    messageRowId: `msg-${threadId}`,
    threadId,
    senderEmail: "ada@example.com",
    subject: "Hello",
    headers: {},
    ...overrides,
  }
}

describe("categorizeIncomingMessages", () => {
  it("writes the heuristic category on a new thread before returning", async () => {
    // The resolution order guarantee the engines rely on: when this
    // resolves, the category is already on the thread — and the engines
    // await it before finalizing the notification count (see the engine
    // call sites; the scheduler's notifyNewMail consumes that count).
    const threadId = await seedThread()

    await categorizeIncomingMessages(executor, [
      input(threadId, {
        headers: {
          "list-unsubscribe": "<https://lists.example.com/unsub>",
        },
      }),
    ])

    expect(await categoryOf(threadId)).toBe("newsletters")
  })

  it("stores the spec default 'primary' as a real value, not NULL", async () => {
    const threadId = await seedThread()

    await categorizeIncomingMessages(executor, [input(threadId)])

    expect(await categoryOf(threadId)).toBe("primary")
  })

  it("classifies auto-generated markers to updates end to end", async () => {
    const threadId = await seedThread()

    await categorizeIncomingMessages(executor, [
      input(threadId, { headers: { "auto-submitted": "auto-generated" } }),
    ])

    expect(await categoryOf(threadId)).toBe("updates")
  })

  it("never overwrites an already-categorized thread (override stability)", async () => {
    const decided = await seedThread()
    await executor.execute(
      "UPDATE threads SET category = $1 WHERE id = $2",
      ["promotions", decided]
    )

    await categorizeIncomingMessages(executor, [
      input(decided, {
        headers: { "list-id": "<lists.example>" }, // would say newsletters
      }),
    ])

    expect(await categoryOf(decided)).toBe("promotions")
  })

  it("keep-first within one batch: the thread's first message wins", async () => {
    const threadId = await seedThread()

    await categorizeIncomingMessages(executor, [
      input(threadId, {
        messageRowId: "m-first",
        headers: { "list-id": "<lists.example>" }, // newsletters
      }),
      input(threadId, {
        messageRowId: "m-second", // plain — would say primary; must not win
        senderEmail: "other@example.com",
      }),
    ])

    expect(await categoryOf(threadId)).toBe("newsletters")
  })

  it("a user sender override beats the headers; a learned one does not", async () => {
    const user = await seedThread()
    const learned = await seedThread()
    await setSenderCategory(executor, "news@x.example", "promotions", "user")
    await setSenderCategory(executor, "digest@y.example", "promotions", "heuristic")

    await categorizeIncomingMessages(executor, [
      input(user, {
        senderEmail: "news@x.example",
        headers: { "list-id": "<x.example>" },
      }),
      input(learned, {
        senderEmail: "digest@y.example",
        headers: { "list-id": "<y.example>" },
      }),
    ])

    // 'user' ranks with the rules (the spec: overrides "feed back as the
    // rule for that sender"); 'heuristic' ranks below the headers.
    expect(await categoryOf(user)).toBe("promotions")
    expect(await categoryOf(learned)).toBe("newsletters")
  })

  it("maps the ingestion event projection faithfully", async () => {
    const threadId = await seedThread()
    const event = eventFor(threadId, {
      fromAddress: "News@Lists.Example",
      subject: "[announce] v2",
      headers: { "list-unsubscribe": "<https://lists.example/u>" },
    })

    const mapped = categorizationInputFromEvent(event)
    expect(mapped).toEqual({
      messageRowId: event.messageRowId,
      threadId,
      senderEmail: "News@Lists.Example",
      subject: "[announce] v2",
      headers: { "list-unsubscribe": "<https://lists.example/u>" },
      ruleCategory: null, // no set_category rule stamped this event
    })

    await categorizeIncomingMessages(executor, [mapped])
    expect(await categoryOf(threadId)).toBe("newsletters")
  })

  it("a rule naming a category beats the heuristics (the task 3.4 wiring)", async () => {
    // End-to-end through the production seam: runIngestionRules stamps the
    // matching set_category rule onto the event, the engines project it
    // via categorizationInputFromEvent (the same objects, zero engine
    // changes), and classifyMessage ranks it above the header evidence.
    const threadId = await seedThread()
    await createRule(executor, {
      accountId,
      name: "receipts to updates",
      criteriaQuery: "from:receipts@x.example",
      actions: [{ type: "set_category", category: "updates" }],
    })
    const event = eventFor(threadId, {
      fromAddress: "receipts@x.example",
      headers: { "list-id": "<x.example>" }, // heuristics would say newsletters
    })

    await runIngestionRules(executor, accountId, [event])
    await categorizeIncomingMessages(executor, [
      categorizationInputFromEvent(event),
    ])

    expect(await categoryOf(threadId)).toBe("updates")
  })

  it("a rule-named category beats a user sender override too", async () => {
    // The classifier's precedence (classify.ts): ruleCategory first, then
    // the 'user' sender row — verify the wiring preserves that order.
    const threadId = await seedThread()
    await setSenderCategory(executor, "receipts@x.example", "promotions", "user")
    await createRule(executor, {
      accountId,
      name: "receipts to updates",
      criteriaQuery: "from:receipts@x.example",
      actions: [{ type: "set_category", category: "updates" }],
    })
    const event = eventFor(threadId, { fromAddress: "receipts@x.example" })

    await runIngestionRules(executor, accountId, [event])
    await categorizeIncomingMessages(executor, [
      categorizationInputFromEvent(event),
    ])

    expect(await categoryOf(threadId)).toBe("updates")
  })

  it("isolates a write failure: warns and never throws", async () => {
    const threadId = await seedThread()
    const failing = {
      select: executor.select.bind(executor),
      execute: async (): Promise<{ rowsAffected: number }> => {
        throw new Error("disk on fire")
      },
    }

    await expect(
      categorizeIncomingMessages(failing, [input(threadId)])
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    // The real executor was never involved; the thread stays uncategorized.
    expect(await categoryOf(threadId)).toBeNull()
  })

  it("is a no-op for an empty batch", async () => {
    await expect(
      categorizeIncomingMessages(executor, [])
    ).resolves.toBeUndefined()
    expect(warn).not.toHaveBeenCalled()
  })
})

describe("AI categorization assist wiring (task 4.9, design D4)", () => {
  /**
   * The ingestion-side precedence contract: the assist fires ONLY for
   * messages the tier logic reports as "default" (nothing decided), at
   * most once per sender per pass, and NEVER when the gate is closed —
   * every "no AI call" assertion below pins aiChatMock untouched.
   */

  it("assist off (the default): zero AI calls, rules alone populate the tabs", async () => {
    const first = await seedThread()
    const second = await seedThread()

    await categorizeIncomingMessages(executor, [
      input(first, { senderEmail: "one@x.example" }),
      input(second, { senderEmail: "two@x.example" }),
    ])

    expect(await categoryOf(first)).toBe("primary")
    expect(await categoryOf(second)).toBe("primary")
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it("a rule decision wins: the provider is not consulted", async () => {
    // Spec "Rule engine wins". ruleCategory is the runIngestionRules
    // stamp (the rules seam itself is exercised end-to-end above); the
    // classifier ranks it first, so the assist never sees this message.
    await enableAssist()
    const threadId = await seedThread()

    await categorizeIncomingMessages(executor, [
      input(threadId, { ruleCategory: "social" }),
    ])

    expect(await categoryOf(threadId)).toBe("social")
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it("a header heuristic decision wins: no AI call", async () => {
    await enableAssist()
    const threadId = await seedThread()

    await categorizeIncomingMessages(executor, [
      input(threadId, { headers: { "list-id": "<lists.x.example>" } }),
    ])

    expect(await categoryOf(threadId)).toBe("newsletters")
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it("an auto-generated decision wins: no AI call", async () => {
    await enableAssist()
    const threadId = await seedThread()

    await categorizeIncomingMessages(executor, [
      input(threadId, { senderEmail: "noreply@service.x.example" }),
    ])

    expect(await categoryOf(threadId)).toBe("updates")
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it("a learned sender row wins: no AI call", async () => {
    // Even a heuristic-source row that says 'primary' is a DECISION
    // (tier "learned-override") — the assist must not re-ask over it.
    await enableAssist()
    await setSenderCategory(executor, "digest@y.example", "promotions", "heuristic")
    const decided = await seedThread()
    const uncertain = await seedThread()

    await categorizeIncomingMessages(executor, [
      input(decided, { senderEmail: "digest@y.example" }),
      input(uncertain, { senderEmail: "fresh@y.example" }), // default tier
    ])

    expect(await categoryOf(decided)).toBe("promotions")
    expect(await categoryOf(uncertain)).toBe("newsletters") // the AI reply
    expect(aiChatMock).toHaveBeenCalledTimes(1)
    const prompted = (aiChatMock.mock.calls[0]![0] as { messages: { content: string }[] }).messages[0].content
    expect(prompted).toContain("fresh@y.example")
    expect(prompted).not.toContain("digest@y.example")
  })

  it("the subject-tag approximation wins: no AI call", async () => {
    await enableAssist()
    const threadId = await seedThread()

    await categorizeIncomingMessages(executor, [
      input(threadId, { subject: "[announce] v2 shipped" }),
    ])

    expect(await categoryOf(threadId)).toBe("newsletters")
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it("enabled + uncertain: one AI call per sender, its verdict overrides the default", async () => {
    await enableAssist()
    const first = await seedThread()
    const second = await seedThread()

    await categorizeIncomingMessages(executor, [
      input(first, {
        senderEmail: "News@X.Example",
        subject: "What is this?",
      }),
      input(second, {
        senderEmail: "news@x.example", // same sender, different case
        subject: "Still no idea",
      }),
    ])

    // Deduped to ONE provider call for the sender (per-pass dedupe, and
    // the ai_cache/sender_categories caches make later passes free).
    expect(aiChatMock).toHaveBeenCalledTimes(1)
    const call = aiChatMock.mock.calls[0]![0] as {
      surface: string
      system: string
      messages: { content: string }[]
    }
    expect(call.surface).toBe("categorizationAssist")
    expect(call.messages[0].content).toContain("news@x.example")
    expect(call.messages[0].content).toContain("What is this?")
    expect(call.messages[0].content).toContain("Still no idea")
    // The AI verdict overrides the default tier for BOTH messages.
    expect(await categoryOf(first)).toBe("newsletters")
    expect(await categoryOf(second)).toBe("newsletters")
    // Persisted both ways: ai_cache + the source-'ai' sender row.
    await expect(getSenderCategory(executor, "news@x.example")).resolves.toEqual({
      category: "newsletters",
      source: "ai",
    })
    expect(await aiCacheStats(executor)).toMatchObject({ total: 1 })
  })

  it("distinct senders consult separately", async () => {
    await enableAssist()
    aiChatMock
      .mockResolvedValueOnce("promotions")
      .mockResolvedValueOnce("social")
    const deals = await seedThread()
    const friends = await seedThread()

    await categorizeIncomingMessages(executor, [
      input(deals, { senderEmail: "deals@shop.example" }),
      input(friends, { senderEmail: "team@network.example" }),
    ])

    expect(aiChatMock).toHaveBeenCalledTimes(2)
    expect(await categoryOf(deals)).toBe("promotions")
    expect(await categoryOf(friends)).toBe("social")
  })

  it("a second pass for the same sender makes no second call", async () => {
    // Sender-cached (spec: "repeated mail from the same sender is not
    // re-classified") — via the ai_cache entry AND the sender_categories
    // row, whichever the next pass reads first.
    await enableAssist()
    const firstPass = await seedThread()

    await categorizeIncomingMessages(executor, [
      input(firstPass, { senderEmail: "news@x.example" }),
    ])
    expect(aiChatMock).toHaveBeenCalledTimes(1)

    const secondPass = await seedThread()
    await categorizeIncomingMessages(executor, [
      input(secondPass, { senderEmail: "news@x.example" }),
    ])
    expect(aiChatMock).toHaveBeenCalledTimes(1) // still one
    expect(await categoryOf(secondPass)).toBe("newsletters")
  })

  it("a provider failure downgrades to primary and never breaks the pass", async () => {
    await enableAssist()
    aiChatMock.mockRejectedValue(new Error("provider down"))
    const first = await seedThread()
    const second = await seedThread()

    await expect(
      categorizeIncomingMessages(executor, [
        input(first, { senderEmail: "one@x.example" }),
        input(second, { senderEmail: "two@x.example" }),
      ])
    ).resolves.toBeUndefined()

    expect(await categoryOf(first)).toBe("primary")
    expect(await categoryOf(second)).toBe("primary")
    expect(warn).toHaveBeenCalled()
  })

  it("a garbage AI reply keeps the local default (primary)", async () => {
    await enableAssist()
    aiChatMock.mockResolvedValue("Honestly, no idea!")
    const threadId = await seedThread()

    await categorizeIncomingMessages(executor, [
      input(threadId, { senderEmail: "mystery@x.example" }),
    ])

    expect(await categoryOf(threadId)).toBe("primary")
    await expect(
      getSenderCategory(executor, "mystery@x.example")
    ).resolves.toBeNull()
  })
})
