import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { deleteMessage, updateMessage } from "../messages"
import { searchThreads } from "../search"
import { recomputeThreadCaches, setThreadLabels } from "../threads"
import {
  at,
  createAccount,
  createGmailLabel,
  createMessage,
  createThread,
} from "./fixtures"
import { createTestExecutor, type TestExecutor } from "./test-executor"

describe("searchThreads", () => {
  let executor: TestExecutor
  let accountId: string
  let inboxLabelId: string
  let subjectThread: string
  let bodyThread: string
  let fromNameThread: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
    inboxLabelId = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )

    async function seedThread(
      subject: string,
      fromName: string,
      fromAddress: string,
      bodyText: string,
      date: number
    ): Promise<string> {
      const threadId = await createThread(executor, accountId, { subject })
      await createMessage(executor, {
        threadId,
        accountId,
        date,
        subject,
        fromName,
        fromAddress,
        bodyText,
        snippet: bodyText.slice(0, 40),
      })
      await setThreadLabels(executor, threadId, [inboxLabelId])
      await recomputeThreadCaches(executor, threadId)
      return threadId
    }

    // oldest → newest: t1 (subject hit), t2 (body hit), t3 (from-name hit)
    subjectThread = await seedThread(
      "Quarterly planning doc",
      "Alice Wonderland",
      "alice@wonderland.example",
      "See the attached roadmap for the third quarter.",
      at(0)
    )
    bodyThread = await seedThread(
      "Lunch on Friday",
      "Bob Sample",
      "bob@corp.example",
      "Quarterly numbers look great. Pizzazz tonight? Snapshot enclosed.",
      at(600)
    )
    fromNameThread = await seedThread(
      "Deploy status snapshot",
      "Teresa Green",
      "teresa@corp.example",
      "All checks passed on the release branch.",
      at(1200)
    )
  })

  afterEach(() => {
    executor.close()
  })

  it("finds threads by a subject word (FTS covers messages.subject)", async () => {
    const hits = await searchThreads(executor, accountId, "planning")
    expect(hits.map((thread) => thread.id)).toEqual([subjectThread])
  })

  it("finds threads by a body word (FTS covers messages.body_text)", async () => {
    expect(
      (await searchThreads(executor, accountId, "roadmap")).map((t) => t.id)
    ).toEqual([subjectThread])
    expect(
      (await searchThreads(executor, accountId, "pizzazz")).map((t) => t.id)
    ).toEqual([bodyThread])
  })

  it("finds threads by from-name (FTS covers messages.from_name)", async () => {
    expect(
      (await searchThreads(executor, accountId, "Wonderland")).map((t) => t.id)
    ).toEqual([subjectThread])
    expect(
      (await searchThreads(executor, accountId, "Teresa")).map((t) => t.id)
    ).toEqual([fromNameThread])
  })

  it("finds threads by from-address (FTS covers messages.from_address)", async () => {
    expect(
      (await searchThreads(executor, accountId, "bob@corp.example")).map(
        (t) => t.id
      )
    ).toEqual([bodyThread])
  })

  it("is case-insensitive and matches substrings (trigram)", async () => {
    expect(
      (await searchThreads(executor, accountId, "PIZZAZZ")).map((t) => t.id)
    ).toEqual([bodyThread])
  })

  it("ANDs multiple terms and orders hits by last_message_at DESC", async () => {
    // "snapshot" appears in both newer threads; ordering must be t3, t2
    expect(
      (await searchThreads(executor, accountId, "snapshot")).map((t) => t.id)
    ).toEqual([fromNameThread, bodyThread])
    expect(
      (await searchThreads(executor, accountId, "planning roadmap")).map(
        (t) => t.id
      )
    ).toEqual([subjectThread])
    expect(
      await searchThreads(executor, accountId, "planning pizzazz")
    ).toEqual([])
  })

  it("scopes results to the given account", async () => {
    const otherAccount = await createAccount(executor, "gmail")
    const foreignThread = await createThread(executor, otherAccount, {
      subject: "Quarterly planning elsewhere",
    })
    await createMessage(executor, {
      threadId: foreignThread,
      accountId: otherAccount,
      date: at(9000),
      subject: "Quarterly planning elsewhere",
      bodyText: "roadmap",
    })
    await recomputeThreadCaches(executor, foreignThread)

    const hits = await searchThreads(executor, accountId, "planning")
    expect(hits.map((thread) => thread.account_id)).toEqual([accountId])
    expect(hits.map((thread) => thread.id)).toEqual([subjectThread])
  })

  it("reflects body updates through the FTS triggers", async () => {
    const messages = await executor.select<{ id: string }>(
      "SELECT id FROM messages WHERE thread_id = $1",
      [fromNameThread]
    )
    await updateMessage(executor, messages[0]!.id, {
      bodyText: "Now mentions pizzazz for the update-upkeep test.",
    })

    const hits = await searchThreads(executor, accountId, "pizzazz")
    expect(hits.map((thread) => thread.id)).toEqual([
      fromNameThread,
      bodyThread,
    ])
  })

  it("drops threads whose messages were deleted (FTS delete trigger)", async () => {
    const messages = await executor.select<{ id: string }>(
      "SELECT id FROM messages WHERE thread_id = $1",
      [fromNameThread]
    )
    await deleteMessage(executor, messages[0]!.id)
    await recomputeThreadCaches(executor, fromNameThread)

    expect(await searchThreads(executor, accountId, "Teresa")).toEqual([])
    expect(
      (await searchThreads(executor, accountId, "pizzazz")).map((t) => t.id)
    ).toEqual([bodyThread])
  })

  it("falls back to a LIKE scan for terms shorter than 3 chars", async () => {
    // The trigram tokenizer only emits 3-char tokens, so "zz" can never
    // match via FTS5; the LIKE fallback scans message columns instead.
    expect(
      (await searchThreads(executor, accountId, "zz")).map((t) => t.id)
    ).toEqual([bodyThread])
    expect(await searchThreads(executor, accountId, "qq")).toEqual([])
  })

  it("treats double quotes in the query as literal characters", async () => {
    // The embedded quote must be escaped, not terminate the FTS string.
    expect(await searchThreads(executor, accountId, 'pizzazz"bar')).toEqual([])
    expect(await searchThreads(executor, accountId, "")).toEqual([])
  })
})
