import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The provider transport is the seam under mock: the REAL client module
// stays loaded (buildWritingStyleProfile's isAiConfigured gate runs for
// real) with aiChat replaced, so assertions target the prompt/surface and
// call counts.
const aiChatMock = vi.hoisted(() => vi.fn())

vi.mock("../client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client")>()
  return { ...actual, aiChat: aiChatMock }
})

import {
  buildWritingStyleProfile,
  deleteStyleProfile,
  loadStyleProfile,
} from "../style-profile"
import { addProvider, setActiveProvider, setAiEnabled } from "../settings"
import {
  saveWritingStyleProfile,
  getWritingStyleProfile,
} from "../writing-style"
import {
  createAccount,
  createGmailLabel,
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { setThreadLabels } from "@/services/db/threads"

/**
 * Style-profile builder tests (task 4.5, ai-assistance spec "Writing-style
 * smart replies"): sent-message sampling (sent-role membership through
 * thread_labels, own-author filter, trashed excluded), the prompt shape
 * (surface, capped sample blocks), tolerant profile parsing/normalization
 * (fences, prose, junk fields), the typed failure results (gate off →
 * "not-configured" with no client call, "no-sent-mail", "parse",
 * "provider"), sampleSize recording, and the delete passthrough.
 */

let executor: TestExecutor
let accountId: string
let accountEmail: string

beforeEach(async () => {
  executor = createTestExecutor()
  accountId = await createAccount(executor)
  accountEmail = `${accountId}@example.com`
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

/** A sent-role label plus two threads filed into it. Returns the label id
 * so tests can file additional threads. */
async function seedSentFolder(): Promise<string> {
  return createGmailLabel(executor, accountId, "Sent", "SENT", "sent")
}

async function fileIntoSent(threadId: string, sentLabelId: string) {
  await setThreadLabels(executor, threadId, [sentLabelId])
}

/** Two sent messages authored by the account, newest first by date. */
async function seedSentMessages(sentLabelId: string): Promise<string[]> {
  const threadId = await createThread(executor, accountId, {
    subject: "Kickoff",
  })
  await fileIntoSent(threadId, sentLabelId)
  const older = await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_000_000,
    subject: "Kickoff",
    fromAddress: accountEmail,
    bodyText: "Hi Alice, here is the plan. Thanks, Sam",
  })
  const newer = await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_100_000,
    subject: "Re: Kickoff",
    fromAddress: accountEmail,
    bodyText: "Looping in the team. Best, Sam",
  })
  return [newer, older]
}

describe("buildWritingStyleProfile sampling", () => {
  it("samples own-author sent messages, in date-desc prompt order", async () => {
    await seedActiveProvider()
    const sentLabelId = await seedSentFolder()
    await seedSentMessages(sentLabelId)
    aiChatMock.mockResolvedValue(
      JSON.stringify({
        tone: "warm, concise",
        formality: "business-casual",
        typicalLength: "short",
        greetings: ["Hi NAME"],
        signOffs: ["Thanks,"],
        phrasing: ["Looping in the team"],
      })
    )

    const result = await buildWritingStyleProfile(executor, accountId)

    expect(result).toEqual({ ok: true, sampleSize: 2 })
    expect(aiChatMock).toHaveBeenCalledTimes(1)
    const args = aiChatMock.mock.calls[0][0] as {
      system: string
      messages: { role: string; content: string }[]
      surface: string
    }
    expect(args.surface).toBe("smartReplies")
    expect(args.system).toMatch(/STRICT JSON/)
    const content = args.messages[0].content
    expect(content).toContain("Subject: Re: Kickoff")
    expect(content).toContain("Looping in the team")
    // Newest first (ORDER BY date DESC).
    expect(content.indexOf("Re: Kickoff")).toBeLessThan(
      content.indexOf("Subject: Kickoff")
    )

    // The profile persists through the 4.3 envelope with the sample size.
    const stored = await getWritingStyleProfile(executor, accountId)
    expect(stored?.profile).toMatchObject({
      version: 1,
      tone: "warm, concise",
      formality: "business-casual",
      greetings: ["Hi NAME"],
      signOffs: ["Thanks,"],
    })
    expect(stored?.sampleSize).toBe(2)
    expect(typeof stored?.builtAt).toBe("number")
  })

  it("excludes received messages in sent threads and non-sent mail", async () => {
    await seedActiveProvider()
    const sentLabelId = await seedSentFolder()
    await seedSentMessages(sentLabelId)
    // A received reply living in the SAME (sent-labeled) thread — gmail
    // labels are thread-level, so the author filter must exclude it.
    const sentThreadId = (
      await executor.select<{ thread_id: string }>(
        "SELECT thread_id FROM messages WHERE from_address = $1 LIMIT 1",
        [accountEmail]
      )
    )[0].thread_id
    await createMessage(executor, {
      threadId: sentThreadId,
      accountId,
      date: 1_700_200_000,
      fromAddress: "alice@example.com",
      bodyText: "Thanks Sam, looks good!",
    })
    // A thread never filed into Sent.
    const plainThread = await createThread(executor, accountId)
    await createMessage(executor, {
      threadId: plainThread,
      accountId,
      date: 1_700_300_000,
      fromAddress: accountEmail,
      bodyText: "Not a sent message.",
    })
    aiChatMock.mockResolvedValue('{"tone":"warm"}')

    const result = await buildWritingStyleProfile(executor, accountId)

    expect(result).toEqual({ ok: true, sampleSize: 2 })
    const content = (aiChatMock.mock.calls[0][0] as {
      messages: { content: string }[]
    }).messages[0].content
    expect(content).not.toContain("Thanks Sam, looks good!")
    expect(content).not.toContain("Not a sent message.")
  })

  it("falls back to stripped HTML when a sent message has no text body", async () => {
    await seedActiveProvider()
    const sentLabelId = await seedSentFolder()
    const threadId = await createThread(executor, accountId)
    await fileIntoSent(threadId, sentLabelId)
    await executor.execute(
      "INSERT INTO messages (id, thread_id, account_id, date, from_address, body_html, is_read) VALUES ($1, $2, $3, $4, $5, $6, 1)",
      [
        "msg-html",
        threadId,
        accountId,
        1_700_000_000,
        accountEmail,
        "<p>Hello <b>Alice</b></p>",
      ]
    )
    aiChatMock.mockResolvedValue('{"tone":"warm"}')

    await buildWritingStyleProfile(executor, accountId)

    const content = (aiChatMock.mock.calls[0][0] as {
      messages: { content: string }[]
    }).messages[0].content
    expect(content).toContain("Hello Alice")
  })

  it("excludes trashed sent threads from the sample", async () => {
    await seedActiveProvider()
    const sentLabelId = await seedSentFolder()
    await seedSentMessages(sentLabelId)
    const trashLabel = await createGmailLabel(
      executor,
      accountId,
      "Trash",
      "TRASH",
      "trash"
    )
    const trashedThread = await createThread(executor, accountId)
    await createMessage(executor, {
      threadId: trashedThread,
      accountId,
      date: 1_700_400_000,
      fromAddress: accountEmail,
      bodyText: "Deleted rambling.",
    })
    await setThreadLabels(executor, trashedThread, [trashLabel])
    aiChatMock.mockResolvedValue('{"tone":"warm"}')

    const result = await buildWritingStyleProfile(executor, accountId)

    expect(result).toEqual({ ok: true, sampleSize: 2 })
    const content = (aiChatMock.mock.calls[0][0] as {
      messages: { content: string }[]
    }).messages[0].content
    expect(content).not.toContain("Deleted rambling.")
  })
})

describe("buildWritingStyleProfile parsing", () => {
  it("parses fenced JSON with prose and drops junk fields and entries", async () => {
    await seedActiveProvider()
    const sentLabelId = await seedSentFolder()
    await seedSentMessages(sentLabelId)
    aiChatMock.mockResolvedValue(
      [
        "Here is the profile you asked for:",
        "```json",
        JSON.stringify({
          tone: " warm ",
          formality: "casual",
          typicalLength: "two sentences",
          greetings: ["Hi NAME", "", 42, "Hello"],
          signOffs: ["Best,"],
          phrasing: ["short bullet updates"],
          mystery: "dropped",
        }),
        "```",
        "Hope that helps!",
      ].join("\n")
    )

    const result = await buildWritingStyleProfile(executor, accountId)

    expect(result).toEqual({ ok: true, sampleSize: 2 })
    const stored = await getWritingStyleProfile<{
      tone?: string
      greetings: unknown[]
      phrasing: string[]
      mystery?: string
    }>(executor, accountId)
    const profile = stored?.profile
    expect(profile?.greetings).toEqual(["Hi NAME", "Hello"])
    expect(profile?.phrasing).toEqual(["short bullet updates"])
    expect(profile?.mystery).toBeUndefined()
    expect(profile?.tone).toBe("warm")
  })

  it("returns the typed parse reason and stores nothing on an unreadable reply", async () => {
    await seedActiveProvider()
    const sentLabelId = await seedSentFolder()
    await seedSentMessages(sentLabelId)
    aiChatMock.mockResolvedValue("I cannot help with that.")

    const result = await buildWritingStyleProfile(executor, accountId)

    expect(result).toEqual({ ok: false, reason: "parse" })
    expect(await getWritingStyleProfile(executor, accountId)).toBeNull()
  })

  it("treats a reply whose fields are all junk as a parse failure", async () => {
    await seedActiveProvider()
    const sentLabelId = await seedSentFolder()
    await seedSentMessages(sentLabelId)
    aiChatMock.mockResolvedValue('{"tone": 7, "greetings": "Hi"}')

    const result = await buildWritingStyleProfile(executor, accountId)

    expect(result).toEqual({ ok: false, reason: "parse" })
    expect(await getWritingStyleProfile(executor, accountId)).toBeNull()
  })
})

describe("buildWritingStyleProfile gates and failures", () => {
  it("returns the typed not-configured reason without a client call when AI is off", async () => {
    const sentLabelId = await seedSentFolder()
    await seedSentMessages(sentLabelId)

    const result = await buildWritingStyleProfile(executor, accountId)

    expect(result).toEqual({ ok: false, reason: "not-configured" })
    expect(aiChatMock).not.toHaveBeenCalled()
    expect(await getWritingStyleProfile(executor, accountId)).toBeNull()
  })

  it("returns no-sent-mail without a client call when nothing was sampled", async () => {
    await seedActiveProvider()

    const result = await buildWritingStyleProfile(executor, accountId)

    expect(result).toEqual({ ok: false, reason: "no-sent-mail" })
    expect(aiChatMock).not.toHaveBeenCalled()
  })

  it("maps a provider failure to the typed provider reason with its message", async () => {
    await seedActiveProvider()
    const sentLabelId = await seedSentFolder()
    await seedSentMessages(sentLabelId)
    aiChatMock.mockRejectedValue(new Error("provider unreachable"))

    const result = await buildWritingStyleProfile(executor, accountId)

    expect(result).toEqual({
      ok: false,
      reason: "provider",
      message: "provider unreachable",
    })
    expect(await getWritingStyleProfile(executor, accountId)).toBeNull()
  })
})

describe("rebuild and delete", () => {
  it("rebuild replaces the stored profile and sample size", async () => {
    await seedActiveProvider()
    const sentLabelId = await seedSentFolder()
    await seedSentMessages(sentLabelId)
    aiChatMock.mockResolvedValue('{"tone":"first"}')
    await buildWritingStyleProfile(executor, accountId)
    aiChatMock.mockResolvedValue('{"tone":"second"}')

    const result = await buildWritingStyleProfile(executor, accountId)

    expect(result).toEqual({ ok: true, sampleSize: 2 })
    const stored = await getWritingStyleProfile<{ tone: string }>(
      executor,
      accountId
    )
    expect(stored?.profile.tone).toBe("second")
    const rows = await executor.select(
      "SELECT * FROM writing_style_profiles"
    )
    expect(rows).toHaveLength(1)
  })

  it("deleteStyleProfile removes the stored profile", async () => {
    await saveWritingStyleProfile(executor, accountId, '{"v":1}', 3)
    expect(await loadStyleProfile(executor, accountId)).not.toBeNull()

    await deleteStyleProfile(executor, accountId)

    expect(await loadStyleProfile(executor, accountId)).toBeNull()
  })
})
