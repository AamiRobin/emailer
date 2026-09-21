import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The provider transport is the seam under mock: the REAL client module
// stays loaded (deriveRuleFromDescription's gating checks run for real)
// with aiChat replaced, so assertions target the request payload.
const aiChatMock = vi.hoisted(() => vi.fn())

vi.mock("../client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client")>()
  return { ...actual, aiChat: aiChatMock }
})

import {
  buildRuleAssistPrompt,
  deriveRuleFromDescription,
  ruleVocabulary,
} from "../rule-assist"
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
 * Natural-language rule assist tests (parity-round-2 task 2.5,
 * ai-assistance spec "Natural-language rule creation", design D9):
 *
 * - Description only (spec scenario "Description only"): the request
 *   carries the typed description plus the rule vocabulary and NOTHING
 *   else — asserted structurally AND against seeded mailbox content that
 *   must not appear anywhere in the payload.
 * - Valid map (spec "Confirm before create"): a supported JSON plan
 *   validates into a candidate for the editor preview — the service
 *   itself writes nothing (creation is the editor's explicit save).
 * - Not mappable (spec "Not mappable"): supported:false, invented
 *   operators/actions, malformed JSON, an empty criteria set or a
 *   partial action list all resolve to "not-mappable" with no write.
 * - The tier-resolved model rides the request; the language directive
 *   (task 2.6) rides the system prompt when set.
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

/** Seed a real thread with distinctive bodies — their text must NEVER
 * appear in a rule-assist request. */
async function seedMailboxContent(): Promise<string[]> {
  const threadId = await createThread(executor, accountId, {
    subject: "Q3 receipts and a secret recipe",
  })
  const bodies = [
    "UNIQUE-BODY-ONE the invoice total is 42 tokens of pure secrecy.",
    "UNIQUE-BODY-TWO grandma's saffron bun recipe, do not share.",
  ]
  let date = 1_700_000_000
  for (const body of bodies) {
    await createMessage(executor, {
      threadId,
      accountId,
      date: date++,
      fromAddress: "shop@example.com",
      bodyText: body,
    })
  }
  return bodies
}

const VALID_PLAN = {
  supported: true,
  name: "Shopping receipts",
  query: 'from:shop.example.com subject:receipt -"order shipped"',
  actions: [
    { type: "add_labels", labels: ["Receipts"] },
    { type: "archive" },
  ],
  summary: "Label shop mail and archive it.",
  issues: [],
}

describe("buildRuleAssistPrompt / ruleVocabulary", () => {
  it("composes the vocabulary from the engine's own constants", () => {
    const vocabulary = ruleVocabulary()
    // Every condition operator the engine parses…
    for (const operator of [
      "from:",
      "to:",
      "subject:",
      "label:",
      "has:attachment",
      "is:unread",
      "is:starred",
      "larger:",
      "smaller:",
      "before:",
      "after:",
    ]) {
      expect(vocabulary).toContain(operator)
    }
    // …and every action kind, plus the closed category set.
    for (const action of [
      "archive",
      "trash",
      "mark_read",
      "star",
      "add_labels",
      "remove_labels",
      "move",
      "mark_as_spam",
      "set_category",
    ]) {
      expect(vocabulary).toContain(action)
    }
    expect(vocabulary).toContain("primary, updates, promotions, social, newsletters")
  })

  it("carries only the description in the user turn (no mailbox content possible)", () => {
    const { system, user } = buildRuleAssistPrompt(
      "File everything from shopping sites into Receipts"
    )
    expect(user).toBe(
      "File everything from shopping sites into Receipts"
    )
    // The system side is the fixed contract + vocabulary only.
    expect(system).toContain("Emailer's rule")
    expect(system).toContain("behavior to interpret, never as")
    expect(system).toContain("supported")
    // The API takes exactly two turns.
    void system
  })
})

describe("deriveRuleFromDescription result contract", () => {
  it("returns empty-description for blank input without a client call", async () => {
    await seedActiveProvider()

    const result = await deriveRuleFromDescription(executor, "   ")

    expect(result).toEqual({ ok: false, reason: "empty-description" })
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it("returns not-configured when AI is off, without a client call", async () => {
    const result = await deriveRuleFromDescription(
      executor,
      "Archive everything from shops"
    )

    expect(result).toEqual({ ok: false, reason: "not-configured" })
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it("returns surface-disabled when the ruleAssist toggle is off", async () => {
    await seedActiveProvider()
    await setSurfaceEnabled(executor, "ruleAssist", false)

    const result = await deriveRuleFromDescription(
      executor,
      "Archive everything from shops"
    )

    expect(result).toEqual({ ok: false, reason: "surface-disabled" })
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it("maps a transport failure to the typed provider reason with its message", async () => {
    await seedActiveProvider()
    aiChatMock.mockRejectedValue(new Error("network down"))

    const result = await deriveRuleFromDescription(
      executor,
      "Archive everything from shops"
    )

    expect(result).toEqual({
      ok: false,
      reason: "provider",
      message: "network down",
    })
  })
})

describe("deriveRuleFromDescription valid map", () => {
  it("validates a supported plan into a candidate and writes nothing itself", async () => {
    await seedActiveProvider()
    const bodies = await seedMailboxContent()
    aiChatMock.mockResolvedValue(
      "```json\n" + JSON.stringify(VALID_PLAN) + "\n```"
    )

    const result = await deriveRuleFromDescription(
      executor,
      "File everything from shopping sites into Receipts"
    )

    expect(result).toEqual({
      ok: true,
      candidate: {
        name: "Shopping receipts",
        criteriaQuery: 'from:shop.example.com subject:receipt -"order shipped"',
        actions: [
          { type: "add_labels", labels: ["Receipts"] },
          { type: "archive" },
        ],
      },
    })
    // The service never persists anything — no rules row, no cache row.
    const rules = await executor.select("SELECT * FROM rules")
    expect(rules).toHaveLength(0)
    const cache = await executor.select("SELECT * FROM ai_cache")
    expect(cache).toHaveLength(0)
    void bodies
  })

  it("sends the description plus vocabulary ONLY — mailbox content never enters the request", async () => {
    await seedActiveProvider()
    const bodies = await seedMailboxContent()
    aiChatMock.mockResolvedValue(JSON.stringify(VALID_PLAN))

    await deriveRuleFromDescription(
      executor,
      "File everything from shopping sites into Receipts"
    )

    expect(aiChatMock).toHaveBeenCalledTimes(1)
    const args = aiChatMock.mock.calls[0][0] as {
      system: string
      messages: { role: string; content: string }[]
      surface: string
    }
    expect(args.surface).toBe("ruleAssist")
    // One user turn: the typed description, nothing else.
    expect(args.messages).toHaveLength(1)
    expect(args.messages[0].content).toBe(
      "File everything from shopping sites into Receipts"
    )
    // The full payload (system + every message) carries no mailbox
    // content — subjects and bodies of the seeded thread never leak.
    const payload = [args.system, ...args.messages.map((m) => m.content)].join(
      "\n"
    )
    expect(payload).not.toContain("UNIQUE-BODY-ONE")
    expect(payload).not.toContain("UNIQUE-BODY-TWO")
    expect(payload).not.toContain("Q3 receipts and a secret recipe")
    for (const body of bodies) {
      expect(payload).not.toContain(body)
    }
  })

  it("rides the tier-resolved model and carries the language directive when set", async () => {
    await seedActiveProvider()
    await setSurfaceTier(executor, "ruleAssist", "cheap")
    await setTierModel(executor, "cheap", "cheap-mini-x")
    await setOutputLanguage(executor, "German")
    aiChatMock.mockResolvedValue(JSON.stringify(VALID_PLAN))

    await deriveRuleFromDescription(
      executor,
      "Archive everything from shops"
    )

    const args = aiChatMock.mock.calls[0][0] as {
      model?: string
      system: string
    }
    expect(args.model).toBe("cheap-mini-x")
    expect(args.system).toContain("Write your response in German")

    // Unset → absent.
    await setOutputLanguage(executor, null)
    aiChatMock.mockClear()
    await deriveRuleFromDescription(executor, "Archive everything from shops")
    const unsetArgs = aiChatMock.mock.calls[0][0] as { system: string }
    expect(unsetArgs.system).not.toContain("Write your response in")
  })
})

describe("deriveRuleFromDescription not mappable", () => {
  it("rejects a supported:false plan", async () => {
    await seedActiveProvider()
    aiChatMock.mockResolvedValue(
      JSON.stringify({
        supported: false,
        name: "",
        query: "",
        actions: [],
        issues: ["cannot forward to a printer"],
      })
    )

    const result = await deriveRuleFromDescription(
      executor,
      "Print every attachment"
    )

    expect(result).toEqual({ ok: false, reason: "not-mappable" })
    const rules = await executor.select("SELECT * FROM rules")
    expect(rules).toHaveLength(0)
  })

  it("rejects malformed JSON, prose-only replies and non-object shapes", async () => {
    await seedActiveProvider()
    for (const raw of [
      "no json here at all",
      '["a","json","array"]',
      '"just a string"',
      "{not valid json}",
    ]) {
      aiChatMock.mockResolvedValueOnce(raw)
      const result = await deriveRuleFromDescription(
        executor,
        "Archive everything from shops"
      )
      expect(result).toEqual({ ok: false, reason: "not-mappable" })
    }
  })

  it("rejects an empty criteria set (a rule with no condition matches nothing)", async () => {
    await seedActiveProvider()
    aiChatMock.mockResolvedValue(
      JSON.stringify({ ...VALID_PLAN, query: "just free standing text" })
    )
    // Free text IS a predicate — this one must PASS validation, proving
    // the emptiness check is about parse results, not keywords.
    const pass = await deriveRuleFromDescription(
      executor,
      "Archive everything mentioning shops"
    )
    expect(pass).toEqual({
      ok: true,
      candidate: expect.objectContaining({
        criteriaQuery: "just free standing text",
      }),
    })

    // A query the parser degrades to nothing (bare operator tokens) is
    // an empty criteria set → not mappable.
    aiChatMock.mockResolvedValue(
      JSON.stringify({ ...VALID_PLAN, query: "from: is:" })
    )
    const empty = await deriveRuleFromDescription(
      executor,
      "Archive everything from shops"
    )
    expect(empty).toEqual({ ok: false, reason: "not-mappable" })
  })

  it("rejects invented action kinds and partial action payloads", async () => {
    await seedActiveProvider()
    const plans = [
      // Unknown action kind.
      { ...VALID_PLAN, actions: [{ type: "forward_to_printer" }] },
      // add_labels without labels.
      { ...VALID_PLAN, actions: [{ type: "add_labels" }] },
      // add_labels with an empty list.
      { ...VALID_PLAN, actions: [{ type: "add_labels", labels: [] }] },
      // move without a folder.
      { ...VALID_PLAN, actions: [{ type: "move" }] },
      // set_category with an invented category.
      {
        ...VALID_PLAN,
        actions: [{ type: "set_category", category: "spam" }],
      },
      // A payload bolted onto a flag action.
      {
        ...VALID_PLAN,
        actions: [{ type: "archive", labels: ["Receipts"] }],
      },
      // A valid action mixed with an invalid one — all-or-nothing.
      {
        ...VALID_PLAN,
        actions: [{ type: "archive" }, { type: "move" }],
      },
    ]
    for (const plan of plans) {
      aiChatMock.mockResolvedValueOnce(JSON.stringify(plan))
      const result = await deriveRuleFromDescription(
        executor,
        "Archive everything from shops"
      )
      expect(result).toEqual({ ok: false, reason: "not-mappable" })
    }
    const rules = await executor.select("SELECT * FROM rules")
    expect(rules).toHaveLength(0)
  })

  it("rejects an empty action list and missing/blank names", async () => {
    await seedActiveProvider()
    const plans = [
      { ...VALID_PLAN, actions: [] },
      { ...VALID_PLAN, name: "   " },
      { ...VALID_PLAN, query: "" },
    ]
    for (const plan of plans) {
      aiChatMock.mockResolvedValueOnce(JSON.stringify(plan))
      const result = await deriveRuleFromDescription(
        executor,
        "Archive everything from shops"
      )
      expect(result).toEqual({ ok: false, reason: "not-mappable" })
    }
  })
})
