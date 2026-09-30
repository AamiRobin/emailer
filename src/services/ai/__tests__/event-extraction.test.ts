import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The provider transport is the seam under mock: the REAL client module
// stays loaded (extractEvents' gating guard constructs AiUnavailableError
// from it) with aiChat replaced, so assertions target call counts and the
// prompt/client arguments extractEvents builds.
const aiChatMock = vi.hoisted(() => vi.fn())

vi.mock("../client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client")>()
  return { ...actual, aiChat: aiChatMock }
})

import { extractEvents } from "../event-extraction"
import {
  addProvider,
  setActiveProvider,
  setAiEnabled,
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
 * Event-extraction service tests (tasks 2.1/2.2, design D1): tolerant
 * parsing of the model reply (strict JSON object, fences, prose, bad
 * events), the messageIndex → real-message mapping (out-of-range
 * dropped), date validation (calendar-plausible components, year window,
 * backwards ends, all-day normalization), the prompt shape (markers,
 * surface, system, model), and the event-extraction cache keyed on the
 * thread's message-id set — a cache hit must avoid the client call
 * entirely (asserted on the mock). Transport failures simply propagate
 * (the dialog owns Retry); gating is client.ts's contract, not re-tested
 * here.
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

/** Two-message thread; returns the message ids in chronological order. */
async function seedThread(): Promise<{ threadId: string; ids: string[] }> {
  const threadId = await createThread(executor, accountId, {
    subject: "Workshop",
  })
  const first = await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_000_000,
    subject: "Workshop",
    fromName: "Alice",
    fromAddress: "alice@example.com",
    bodyText: "Let's meet for the workshop planning call.",
  })
  const second = await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_100_000,
    subject: "Re: Workshop",
    fromName: "Bob",
    fromAddress: "bob@example.com",
    bodyText: "The offsite is on the 6th — block the whole day.",
  })
  return { threadId, ids: [first, second] }
}

describe("extractEvents parsing", () => {
  it("maps valid model JSON onto real message ids with sender/date", async () => {
    await seedActiveProvider()
    const { threadId, ids } = await seedThread()
    aiChatMock.mockResolvedValue(
      JSON.stringify({
        events: [
          {
            title: "Workshop planning call",
            start: "2026-03-02 14:30",
            end: "2026-03-02 15:30",
            allDay: false,
            location: "Room 4",
            notes: "Bring the draft agenda",
            messageIndex: 0,
          },
          {
            title: "Offsite day",
            start: "2026-03-06 00:00",
            end: null,
            allDay: true,
            location: null,
            notes: null,
            messageIndex: 1,
          },
        ],
      })
    )

    const result = await extractEvents(executor, threadId)

    expect(result.warning).toBeUndefined()
    expect(result.suggestions).toEqual([
      {
        title: "Workshop planning call",
        startAt: new Date(2026, 2, 2, 14, 30).getTime() / 1000,
        endAt: new Date(2026, 2, 2, 15, 30).getTime() / 1000,
        allDay: false,
        location: "Room 4",
        notes: "Bring the draft agenda",
        messageId: ids[0],
        messageDate: 1_700_000_000,
        messageFrom: "Alice <alice@example.com>",
      },
      {
        title: "Offsite day",
        startAt: new Date(2026, 2, 6).getTime() / 1000,
        allDay: true,
        messageId: ids[1],
        messageDate: 1_700_100_000,
        messageFrom: "Bob <bob@example.com>",
      },
    ])
  })

  it("parses fenced JSON and prose around the object", async () => {
    await seedActiveProvider()
    const { threadId } = await seedThread()
    aiChatMock.mockResolvedValue(
      'Here are the events I found:\n```json\n{"events": [{"title": "Planning call", "start": "2026-03-02 14:30", "end": null, "allDay": false, "location": null, "notes": null, "messageIndex": 0}]}\n```\nHope that helps!'
    )

    const result = await extractEvents(executor, threadId)

    expect(result.warning).toBeUndefined()
    expect(result.suggestions).toHaveLength(1)
    expect(result.suggestions[0]).toMatchObject({ title: "Planning call" })
  })

  it("drops invalid starts, out-of-range indexes and malformed items without failing the batch", async () => {
    await seedActiveProvider()
    const { threadId, ids } = await seedThread()
    aiChatMock.mockResolvedValue(
      JSON.stringify({
        events: [
          {
            title: "Real event",
            start: "2026-03-02 10:00",
            end: null,
            allDay: false,
            location: null,
            notes: null,
            messageIndex: 1,
          },
          {
            title: "Month 13",
            start: "2026-13-01 10:00",
            end: null,
            allDay: false,
            location: null,
            notes: null,
            messageIndex: 0,
          },
          {
            title: "Year out of window",
            start: "2201-05-05 10:00",
            end: null,
            allDay: false,
            location: null,
            notes: null,
            messageIndex: 0,
          },
          {
            title: "Not a date",
            start: "next friday",
            end: null,
            allDay: false,
            location: null,
            notes: null,
            messageIndex: 0,
          },
          {
            title: "From nowhere",
            start: "2026-03-02 10:00",
            end: null,
            allDay: false,
            location: null,
            notes: null,
            messageIndex: 7,
          },
          {
            start: "2026-03-02 10:00",
            messageIndex: 0,
          },
          {
            title: "   ",
            start: "2026-03-02 10:00",
            messageIndex: 0,
          },
          "not an object",
        ],
      })
    )

    const result = await extractEvents(executor, threadId)

    expect(result.suggestions).toHaveLength(1)
    expect(result.suggestions[0]).toMatchObject({
      title: "Real event",
      messageId: ids[1],
    })
  })

  it("keeps the event and drops an invalid, backwards or zero-length end", async () => {
    await seedActiveProvider()
    const { threadId, ids } = await seedThread()
    aiChatMock.mockResolvedValue(
      JSON.stringify({
        events: [
          {
            title: "Bad format end",
            start: "2026-03-02 10:00",
            end: "next friday",
            allDay: false,
            messageIndex: 0,
          },
          {
            title: "Bad month end",
            start: "2026-03-02 10:00",
            end: "2026-13-01 10:00",
            allDay: false,
            messageIndex: 0,
          },
          {
            title: "Hour 25 end",
            start: "2026-03-02 10:00",
            end: "2026-03-02 25:00",
            allDay: false,
            messageIndex: 0,
          },
          {
            title: "End before start",
            start: "2026-03-03 12:00",
            end: "2026-03-03 09:00",
            allDay: false,
            messageIndex: 0,
          },
          {
            title: "Zero-length end",
            start: "2026-03-03 12:00",
            end: "2026-03-03 12:00",
            allDay: false,
            messageIndex: 0,
          },
          {
            title: "Valid end",
            start: "2026-03-03 12:00",
            end: "2026-03-03 13:00",
            allDay: false,
            messageIndex: 1,
          },
        ],
      })
    )

    const result = await extractEvents(executor, threadId)

    expect(result.warning).toBeUndefined()
    expect(result.suggestions).toHaveLength(6)
    expect(result.suggestions[0]).toMatchObject({ messageId: ids[0] })
    expect(result.suggestions[0].endAt).toBeUndefined()
    expect(result.suggestions[1].endAt).toBeUndefined()
    expect(result.suggestions[2].endAt).toBeUndefined()
    expect(result.suggestions[3].endAt).toBeUndefined()
    expect(result.suggestions[4].endAt).toBeUndefined()
    expect(result.suggestions[5].endAt).toBe(
      new Date(2026, 2, 3, 13, 0).getTime() / 1000
    )
  })

  it("normalizes all-day events to a local-midnight start with no end", async () => {
    await seedActiveProvider()
    const { threadId, ids } = await seedThread()
    aiChatMock.mockResolvedValue(
      JSON.stringify({
        events: [
          {
            title: "Offsite",
            start: "2026-03-06 17:45",
            end: "2026-03-06 23:00",
            allDay: true,
            messageIndex: 1,
          },
        ],
      })
    )

    const result = await extractEvents(executor, threadId)

    expect(result.warning).toBeUndefined()
    expect(result.suggestions).toEqual([
      {
        title: "Offsite",
        startAt: new Date(2026, 2, 6).getTime() / 1000,
        allDay: true,
        messageId: ids[1],
        messageDate: 1_700_100_000,
        messageFrom: "Bob <bob@example.com>",
      },
    ])
  })

  it("resolves empty with a warning when the reply has no JSON object", async () => {
    await seedActiveProvider()
    const { threadId } = await seedThread()
    aiChatMock.mockResolvedValue("Sorry, I cannot help with that.")

    const result = await extractEvents(executor, threadId)

    expect(result.suggestions).toEqual([])
    expect(result.warning).toBeTruthy()
    expect(typeof result.warning).toBe("string")
  })

  it("warns when the parsed object lacks the events envelope", async () => {
    await seedActiveProvider()
    const { threadId } = await seedThread()
    aiChatMock.mockResolvedValue('{"note": "nothing to see"}')

    const result = await extractEvents(executor, threadId)

    expect(result.suggestions).toEqual([])
    expect(result.warning).toBeTruthy()
  })

  it("warns when the model claimed events but none map to a message", async () => {
    await seedActiveProvider()
    const { threadId } = await seedThread()
    aiChatMock.mockResolvedValue(
      JSON.stringify({
        events: [
          {
            title: "Ghost event",
            start: "2026-03-02 10:00",
            end: null,
            allDay: false,
            location: null,
            notes: null,
            messageIndex: 9,
          },
        ],
      })
    )

    const result = await extractEvents(executor, threadId)

    expect(result.suggestions).toEqual([])
    expect(result.warning).toBeTruthy()
  })

  it("returns an empty result without a warning when there are no events", async () => {
    await seedActiveProvider()
    const { threadId } = await seedThread()
    aiChatMock.mockResolvedValue('{"events": []}')

    const result = await extractEvents(executor, threadId)

    expect(result).toEqual({ suggestions: [] })
  })
})

describe("extractEvents prompt", () => {
  it("calls the client with the eventExtraction surface, model and marked messages", async () => {
    await seedActiveProvider()
    const { threadId } = await seedThread()
    aiChatMock.mockResolvedValue('{"events": []}')

    await extractEvents(executor, threadId)

    expect(aiChatMock).toHaveBeenCalledTimes(1)
    const args = aiChatMock.mock.calls[0][0] as {
      system: string
      messages: { role: string; content: string }[]
      surface: string
      model?: string
      maxTokens?: number
    }
    expect(args.surface).toBe("eventExtraction")
    // The request rides the same tier-resolved model the cache identity
    // is built from (task 2.2).
    expect(args.model).toBe("claude-sonnet-4-5")
    expect(args.system).toMatch(/STRICT JSON object/)
    expect(args.messages).toHaveLength(1)
    expect(args.messages[0].role).toBe("user")
    expect(args.messages[0].content).toContain("[0] From: Alice <alice@example.com>")
    expect(args.messages[0].content).toContain("[1] From: Bob <bob@example.com>")
    expect(args.messages[0].content).toContain("workshop planning call")
  })
})

describe("extractEvents cache (task 2.2, design D1)", () => {
  it("reuses the cached raw reply without a second client call", async () => {
    await seedActiveProvider()
    const { threadId } = await seedThread()
    aiChatMock.mockResolvedValue(
      JSON.stringify({
        events: [
          {
            title: "Workshop planning call",
            start: "2026-03-02 14:30",
            end: null,
            allDay: false,
            location: null,
            notes: null,
            messageIndex: 0,
          },
        ],
      })
    )

    const first = await extractEvents(executor, threadId)
    expect(aiChatMock).toHaveBeenCalledTimes(1)

    aiChatMock.mockClear()
    const second = await extractEvents(executor, threadId)

    expect(aiChatMock).not.toHaveBeenCalled()
    expect(second).toEqual(first)
  })

  it("misses the cache when a message is added (the message-id set changed)", async () => {
    await seedActiveProvider()
    const { threadId } = await seedThread()
    aiChatMock.mockResolvedValue('{"events": []}')
    await extractEvents(executor, threadId)

    await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_200_000,
      fromAddress: "carol@example.com",
      bodyText: "Following up.",
    })
    aiChatMock.mockClear()
    await extractEvents(executor, threadId)
    expect(aiChatMock).toHaveBeenCalledTimes(1)

    // Each identity lived as its own row: original set, post-arrival set.
    const rows = await executor.select<{ kind: string }>(
      "SELECT kind FROM ai_cache"
    )
    expect(rows).toHaveLength(2)
    expect(rows.every((row) => row.kind === "event-extraction")).toBe(true)
  })

  it("attributes cache rows to the thread's account (removal purge scope)", async () => {
    await seedActiveProvider()
    const { threadId } = await seedThread()
    aiChatMock.mockResolvedValue('{"events": []}')

    await extractEvents(executor, threadId)

    const rows = await executor.select<{ account_id: string | null }>(
      "SELECT account_id FROM ai_cache"
    )
    expect(rows[0]?.account_id).toBe(accountId)
  })

  it("answers empty without a client call or cache write on an empty thread", async () => {
    await seedActiveProvider()
    const threadId = await createThread(executor, accountId)

    const result = await extractEvents(executor, threadId)

    expect(result).toEqual({ suggestions: [] })
    expect(aiChatMock).not.toHaveBeenCalled()
    const rows = await executor.select("SELECT 1 FROM ai_cache")
    expect(rows).toHaveLength(0)
  })
})
