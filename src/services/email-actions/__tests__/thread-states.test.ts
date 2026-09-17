import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  at,
  createAccount,
  createGmailLabel,
  createMessage,
  createThread,
} from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import {
  getThread,
  listThreadsByFolder,
  recomputeThreadCaches,
  setThreadLabels,
} from "../../db/threads"
import { buildThreadSearchSql, searchThreadsQuery } from "../../search"
import { parseSearchQuery } from "../../search/parser"
import { ThreadNotFoundError } from "../thread-actions"
import {
  markThreadDone,
  muteThread,
  pinThread,
  unmarkThreadDone,
  unmuteThread,
  unpinThread,
} from "../thread-states"

/**
 * Task 3.1/3.2 thread-state service tests (mute / pin / Done). The layer
 * is db-only — all three states are local flags, so no provider or queue
 * exists in these tests at all (nothing to mock): no pending_operations
 * writes, no provider calls. The inbox/badge/notification side of mute is
 * asserted at the query level here (list exclusions, search untouched);
 * the count exclusions live in the db/store test suites and the sync
 * engines' own gating tests.
 */

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
})

afterEach(() => {
  executor.close()
})

/** One gmail account + its INBOX label, seeded fresh per test. */
async function seedGmailInbox(): Promise<{ accountId: string; inbox: string }> {
  const accountId = await createAccount(executor, "gmail")
  const inbox = await createGmailLabel(
    executor,
    accountId,
    "INBOX",
    "INBOX",
    "inbox"
  )
  return { accountId, inbox }
}

/** Inbox thread with one message; caches the counts like sync does. */
async function seedInboxThread(options: {
  accountId: string
  inboxLabelId: string
  date: number
  subject?: string
  unread?: boolean
}): Promise<string> {
  const threadId = await createThread(executor, options.accountId)
  await createMessage(executor, {
    threadId,
    accountId: options.accountId,
    date: options.date,
    subject: options.subject,
    isRead: !options.unread,
  })
  await setThreadLabels(executor, threadId, [options.inboxLabelId])
  await recomputeThreadCaches(executor, threadId)
  return threadId
}

async function listFolder(
  accountId: string,
  folder: Parameters<typeof listThreadsByFolder>[1]["folder"]
) {
  return listThreadsByFolder(executor, { accountId, folder })
}

describe("muteThread / unmuteThread", () => {
  it("sets muted_at; unmute clears it", async () => {
    const { accountId, inbox } = await seedGmailInbox()
    const threadId = await seedInboxThread({
      accountId,
      inboxLabelId: inbox,
      date: at(100),
    })

    await muteThread(executor, threadId)
    const muted = await getThread(executor, threadId)
    expect(muted?.muted_at).toBeGreaterThan(0)

    await unmuteThread(executor, threadId)
    expect((await getThread(executor, threadId))?.muted_at).toBeNull()
  })

  it("muting a missing thread throws the shared ThreadNotFoundError", async () => {
    await expect(muteThread(executor, "no-such-thread")).rejects.toBeInstanceOf(
      ThreadNotFoundError
    )
  })
})

describe("pinThread / unpinThread", () => {
  it("sets pinned_at; unpin clears it", async () => {
    const { accountId, inbox } = await seedGmailInbox()
    const threadId = await seedInboxThread({
      accountId,
      inboxLabelId: inbox,
      date: at(100),
    })

    await pinThread(executor, threadId)
    expect((await getThread(executor, threadId))?.pinned_at).toBeGreaterThan(0)

    await unpinThread(executor, threadId)
    expect((await getThread(executor, threadId))?.pinned_at).toBeNull()
  })

  it("pinning a missing thread throws the shared ThreadNotFoundError", async () => {
    await expect(pinThread(executor, "no-such-thread")).rejects.toBeInstanceOf(
      ThreadNotFoundError
    )
  })
})

describe("markThreadDone / unmarkThreadDone", () => {
  it("sets done_at; undo clears it — without touching is_archived", async () => {
    const { accountId, inbox } = await seedGmailInbox()
    const threadId = await seedInboxThread({
      accountId,
      inboxLabelId: inbox,
      date: at(100),
    })

    await markThreadDone(executor, threadId)
    // Done "leaves the inbox like archive" but is a distinct local state:
    // the archive cache must stay untouched.
    expect(await getThread(executor, threadId)).toMatchObject({
      done_at: expect.any(Number),
      is_archived: 0,
    })

    await unmarkThreadDone(executor, threadId)
    expect((await getThread(executor, threadId))?.done_at).toBeNull()
  })

  it("marking Done on a missing thread throws the shared ThreadNotFoundError", async () => {
    await expect(
      markThreadDone(executor, "no-such-thread")
    ).rejects.toBeInstanceOf(ThreadNotFoundError)
  })
})

describe("inbox exclusion (tasks 3.1/3.2)", () => {
  it("a muted thread leaves the inbox (both selectors) and returns after unmute; All Mail and its label keep listing it", async () => {
    const { accountId, inbox } = await seedGmailInbox()
    const work = await createGmailLabel(
      executor,
      accountId,
      "Work",
      "Label_work",
      undefined,
      "user"
    )
    const muted = await seedInboxThread({
      accountId,
      inboxLabelId: inbox,
      date: at(100),
    })
    const newer = await seedInboxThread({
      accountId,
      inboxLabelId: inbox,
      date: at(500),
    })
    await setThreadLabels(executor, muted, [inbox, work])

    await muteThread(executor, muted)

    // Both inbox selector paths hide the muted thread…
    const presetInbox = await listFolder(accountId, {
      kind: "preset",
      preset: "inbox",
    })
    expect(presetInbox.map((thread) => thread.id)).toEqual([newer])
    const specialUseInbox = await listFolder(accountId, {
      kind: "specialUse",
      specialUse: "inbox",
    })
    expect(specialUseInbox.map((thread) => thread.id)).toEqual([newer])

    // …while All Mail and the thread's own label keep it listed.
    const allRows = await listFolder(accountId, {
      kind: "preset",
      preset: "all",
    })
    expect(allRows.map((thread) => thread.id)).toEqual([newer, muted])
    const labelRows = await listFolder(accountId, {
      kind: "labelId",
      labelId: work,
    })
    expect(labelRows.map((thread) => thread.id)).toEqual([muted])

    await unmuteThread(executor, muted)
    const afterUnmute = await listFolder(accountId, {
      kind: "preset",
      preset: "inbox",
    })
    expect(afterUnmute.map((thread) => thread.id)).toEqual([newer, muted])
  })

  it("a Done thread leaves the inbox and returns after undo; All Mail keeps listing it", async () => {
    const { accountId, inbox } = await seedGmailInbox()
    const done = await seedInboxThread({
      accountId,
      inboxLabelId: inbox,
      date: at(100),
    })
    const newer = await seedInboxThread({
      accountId,
      inboxLabelId: inbox,
      date: at(500),
    })

    await markThreadDone(executor, done)

    const inboxRows = await listFolder(accountId, {
      kind: "specialUse",
      specialUse: "inbox",
    })
    expect(inboxRows.map((thread) => thread.id)).toEqual([newer])

    // Done mail stays in All Mail (and its labels/search), like archive.
    const allRows = await listFolder(accountId, {
      kind: "preset",
      preset: "all",
    })
    expect(allRows.map((thread) => thread.id)).toEqual([newer, done])

    await unmarkThreadDone(executor, done)
    const afterUndo = await listFolder(accountId, {
      kind: "specialUse",
      specialUse: "inbox",
    })
    expect(afterUndo.map((thread) => thread.id)).toEqual([newer, done])
  })

  it("the search SQL neither filters muted/done threads nor loses pinned-first ordering", () => {
    const { sql } = buildThreadSearchSql("acc-1", parseSearchQuery("hello"), {
      limit: 20,
    })
    // Mute/Done hide a thread from the inbox and the badges only — the
    // spec keeps muted/Done mail reachable via search, so no muted_at/
    // done_at predicate may appear in the search query.
    expect(sql).not.toContain("muted_at")
    expect(sql).not.toContain("done_at")
    // Search results are a list too: the pinned-first term leads the sort.
    expect(sql).toContain("ORDER BY (threads.pinned_at IS NOT NULL) DESC")
  })
})

describe("pinned-first ordering (task 3.2)", () => {
  it("puts the pinned (oldest) thread first in the inbox, other folders and executed search results", async () => {
    const { accountId, inbox } = await seedGmailInbox()
    const work = await createGmailLabel(
      executor,
      accountId,
      "Work",
      "Label_work",
      undefined,
      "user"
    )
    const oldest = await seedInboxThread({
      accountId,
      inboxLabelId: inbox,
      date: at(100),
      subject: "seed",
    })
    const middle = await seedInboxThread({
      accountId,
      inboxLabelId: inbox,
      date: at(500),
      subject: "seed",
    })
    const newest = await seedInboxThread({
      accountId,
      inboxLabelId: inbox,
      date: at(900),
      subject: "seed",
    })
    // Also carry the Work label so the labelId selector branch is covered.
    for (const threadId of [oldest, middle, newest]) {
      await setThreadLabels(executor, threadId, [inbox, work])
    }

    // Pin the OLDEST thread: without pinning it would sort last.
    await pinThread(executor, oldest)
    const expected = [oldest, newest, middle]

    const inboxRows = await listFolder(accountId, {
      kind: "specialUse",
      specialUse: "inbox",
    })
    expect(inboxRows.map((thread) => thread.id)).toEqual(expected)

    const allRows = await listFolder(accountId, {
      kind: "preset",
      preset: "all",
    })
    expect(allRows.map((thread) => thread.id)).toEqual(expected)

    const labelRows = await listFolder(accountId, {
      kind: "labelId",
      labelId: work,
    })
    expect(labelRows.map((thread) => thread.id)).toEqual(expected)

    const hits = await searchThreadsQuery(executor, accountId, "subject:seed")
    expect(hits.map((thread) => thread.id)).toEqual(expected)
  })

  it("unpinning restores the natural last_message_at order", async () => {
    const { accountId, inbox } = await seedGmailInbox()
    const older = await seedInboxThread({
      accountId,
      inboxLabelId: inbox,
      date: at(100),
    })
    const newer = await seedInboxThread({
      accountId,
      inboxLabelId: inbox,
      date: at(500),
    })

    await pinThread(executor, older)
    await unpinThread(executor, older)

    const rows = await listFolder(accountId, {
      kind: "preset",
      preset: "inbox",
    })
    expect(rows.map((thread) => thread.id)).toEqual([newer, older])
  })
})
