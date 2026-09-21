import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { getTotalUnreadCount } from "../../db/accounts"
import {
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
import { runIngestionRules, type IngestionEvent } from "../../rules/ingestion"
import { setFollowUpDaysPreference } from "../../settings/preferences"
import {
  attachReplyFollowUp,
  cancelFollowUpsOnArrivals,
  createFollowUpReminder,
  FOLLOWUPS_DUE_JOB,
  runDueFollowUps,
} from "../followups"

/**
 * Follow-up reminders (task 14.2, design D8 — "follow-ups are rows").
 * Both spec outcomes verified at the DB level: a due reminder resurfaces
 * its thread (delivered_at tops the inbox) and is marked terminal; a
 * threaded reply arriving through the ingestion hook cancels the reminder
 * first. The attach decision (reply-only, at send acceptance) is tested
 * here against attachReplyFollowUp directly and in the composer's send
 * tests through the real sendComposerDraft path.
 */

const DAY = 24 * 60 * 60
const NOW = 1_750_000_000

let executor: TestExecutor
let accountId: string
let accountEmail: string
let inboxLabelId: string

beforeEach(async () => {
  executor = createTestExecutor()
  accountId = await createAccount(executor, "gmail")
  accountEmail = (
    await executor.select<{ email: string }>(
      "SELECT email FROM accounts WHERE id = $1",
      [accountId]
    )
  )[0]!.email
  inboxLabelId = await createGmailLabel(
    executor,
    accountId,
    "INBOX",
    "INBOX",
    "inbox"
  )
})

afterEach(() => {
  executor.close()
})

async function seedInboxThread(options: {
  date: number
  from?: string
}): Promise<string> {
  const threadId = await createThread(executor, accountId)
  await createMessage(executor, {
    threadId,
    accountId,
    date: options.date,
    fromAddress: options.from ?? "alice@example.com",
  })
  await setThreadLabels(executor, threadId, [inboxLabelId])
  await recomputeThreadCaches(executor, threadId)
  return threadId
}

async function reminders(threadId?: string) {
  return executor.select<{
    id: string
    thread_id: string
    due_at: number
    cancelled_at: number | null
    created_at: number
  }>(
    threadId
      ? "SELECT * FROM followup_reminders WHERE thread_id = $1"
      : "SELECT * FROM followup_reminders",
    threadId ? [threadId] : []
  )
}

function makeEvent(
  overrides: Partial<IngestionEvent> & Pick<IngestionEvent, "threadId">
): IngestionEvent {
  return {
    messageRowId: `m-${overrides.threadId}`,
    fromAddress: "bob@example.com",
    fromName: null,
    toJson: null,
    ccJson: null,
    bccJson: null,
    subject: null,
    date: NOW,
    snippet: null,
    labelNames: [],
    isRead: false,
    isStarred: false,
    hasAttachments: false,
    threadHasUserMessage: false,
    isMailingList: false,
    headers: {},
    sizeEstimate: null,
    ...overrides,
  }
}

describe("attach at send time (attachReplyFollowUp)", () => {
  it("attaches to the source thread of a REPLY, due = accept time + interval", async () => {
    const threadId = await seedInboxThread({ date: NOW - 100 })
    const attached = await attachReplyFollowUp(
      executor,
      accountId,
      { kind: "reply", sourceThreadId: threadId },
      NOW
    )
    expect(attached).toBe(true)
    const rows = await reminders(threadId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      account_id: accountId,
      thread_id: threadId,
      due_at: NOW + 3 * DAY, // the default interval
      cancelled_at: null,
    })
  })

  it("honors the configured interval (mail.followUpDays)", async () => {
    const threadId = await seedInboxThread({ date: NOW - 100 })
    await setFollowUpDaysPreference(executor, 7)
    await attachReplyFollowUp(
      executor,
      accountId,
      { kind: "reply", sourceThreadId: threadId },
      NOW
    )
    expect((await reminders(threadId))[0]?.due_at).toBe(NOW + 7 * DAY)
  })

  it("attaches nothing for fresh composes, forwards, or linkage-less replies", async () => {
    const threadId = await seedInboxThread({ date: NOW - 100 })
    expect(await attachReplyFollowUp(executor, accountId, undefined, NOW)).toBe(
      false
    )
    expect(
      await attachReplyFollowUp(executor, accountId, { kind: "new" }, NOW)
    ).toBe(false)
    expect(
      await attachReplyFollowUp(
        executor,
        accountId,
        { kind: "forward", sourceThreadId: threadId },
        NOW
      )
    ).toBe(false)
    expect(
      await attachReplyFollowUp(executor, accountId, { kind: "reply" }, NOW)
    ).toBe(false)
    expect(await reminders()).toEqual([])
  })

  it("never throws when the thread is gone mid-compose (FK failure swallowed)", async () => {
    const attached = await attachReplyFollowUp(
      executor,
      accountId,
      { kind: "reply", sourceThreadId: "no-such-thread" },
      NOW
    )
    expect(attached).toBe(false)
    expect(await reminders()).toEqual([])
  })
})

describe("due-pass resurfacing (runDueFollowUps)", () => {
  it("resurfaces a due reminder: thread delivered_at set, reminder terminal, inbox topped", async () => {
    // An old thread with a due reminder, and a newer regular inbox thread
    // it must overtake once resurfaced.
    const oldThread = await seedInboxThread({ date: NOW - 10 * DAY })
    const newerThread = await seedInboxThread({ date: NOW - 100 })
    await createFollowUpReminder(executor, accountId, oldThread, NOW - 5)

    const resurfaced = await runDueFollowUps(executor, NOW)
    expect(resurfaced).toBe(1)
    expect(await getThread(executor, oldThread)).toMatchObject({
      delivered_at: NOW,
    })
    expect((await reminders(oldThread))[0]?.cancelled_at).toBe(NOW)

    const inbox = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "specialUse", specialUse: "inbox" },
    })
    expect(inbox.map((thread) => thread.id)).toEqual([oldThread, newerThread])
    // The unread badge is untouched by a resurface (no read mutation).
    expect(await getTotalUnreadCount(executor)).toBe(2)
  })

  it("future and already-terminal reminders are untouched; the pass is idempotent", async () => {
    const futureThread = await seedInboxThread({ date: NOW - 100 })
    const cancelledThread = await seedInboxThread({ date: NOW - 100 })
    const dueThread = await seedInboxThread({ date: NOW - 100 })
    await createFollowUpReminder(executor, accountId, futureThread, NOW + DAY)
    await createFollowUpReminder(
      executor,
      accountId,
      cancelledThread,
      NOW - DAY
    )
    await executor.execute(
      "UPDATE followup_reminders SET cancelled_at = $1 WHERE thread_id = $2",
      [NOW - 2 * DAY, cancelledThread]
    )
    await createFollowUpReminder(executor, accountId, dueThread, NOW)

    expect(await runDueFollowUps(executor, NOW)).toBe(1) // only the due one
    expect((await getThread(executor, futureThread))?.delivered_at).toBeNull()
    expect((await reminders(futureThread))[0]?.cancelled_at).toBeNull()
    expect(
      (await getThread(executor, cancelledThread))?.delivered_at
    ).toBeNull()
    expect((await reminders(cancelledThread))[0]?.cancelled_at).toBe(
      NOW - 2 * DAY
    )

    // Idempotent: closed rows no longer match the predicate.
    expect(await runDueFollowUps(executor, NOW + 1)).toBe(0)
  })

  it("the due handler is the registered due-job name (bootstrap contract)", () => {
    expect(FOLLOWUPS_DUE_JOB).toBe("followups.run")
  })
})

describe("cancellation on a threaded reply", () => {
  it("cancels pending reminders on the arrival's thread, but not the account's OWN echo", async () => {
    const repliedThread = await seedInboxThread({ date: NOW - 100 })
    const ownEchoThread = await seedInboxThread({ date: NOW - 100 })
    const untouchedThread = await seedInboxThread({ date: NOW - 100 })
    await createFollowUpReminder(executor, accountId, repliedThread, NOW + DAY)
    await createFollowUpReminder(executor, accountId, ownEchoThread, NOW + DAY)
    await createFollowUpReminder(
      executor,
      accountId,
      untouchedThread,
      NOW + DAY
    )

    const cancelled = await cancelFollowUpsOnArrivals(
      executor,
      accountEmail,
      [
        // A real reply from someone else…
        { threadId: repliedThread, fromAddress: "bob@example.com" },
        // …and the user's own sent copy syncing back — must NOT cancel.
        { threadId: ownEchoThread, fromAddress: accountEmail },
      ],
      NOW
    )
    expect(cancelled).toBe(1)
    expect((await reminders(repliedThread))[0]?.cancelled_at).toBe(NOW)
    expect((await reminders(ownEchoThread))[0]?.cancelled_at).toBeNull()
    expect((await reminders(untouchedThread))[0]?.cancelled_at).toBeNull()
  })

  it("the ingestion hook runs the consumer even with no rules or schedules configured", async () => {
    const threadId = await seedInboxThread({ date: NOW - 100 })
    await createFollowUpReminder(executor, accountId, threadId, NOW + DAY)

    const outcomes = await runIngestionRules(
      executor,
      accountId,
      [makeEvent({ threadId })],
      { now: NOW }
    )
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]?.heldUntil).toBeNull() // outcomes untouched
    expect((await reminders(threadId))[0]?.cancelled_at).toBe(NOW)
  })

  it("the hook skips the account's own sent-copy arrival (the just-attached reminder survives)", async () => {
    const threadId = await seedInboxThread({ date: NOW - 100 })
    await createFollowUpReminder(executor, accountId, threadId, NOW + DAY)

    await runIngestionRules(
      executor,
      accountId,
      [makeEvent({ threadId, fromAddress: accountEmail })],
      { now: NOW }
    )
    expect((await reminders(threadId))[0]?.cancelled_at).toBeNull()
  })
})
