import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { getTotalUnreadCount } from "../../db/accounts"
import { unreadCountBySpecialUse } from "../../db/folder-counts"
import {
  at,
  BASE_TIME,
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
import {
  applyDeliveryHolds,
  runIngestionRules,
  type IngestionEvent,
} from "../../rules/ingestion"
import {
  createDeliverySchedule,
  resolveDeliveryHold,
} from "../../settings/delivery-schedules"
import { DELIVERY_HOLDS_DUE_JOB, releaseDueHolds } from "../holds"

/**
 * Task 12.1 hold→release round trip. Everything upstream of the release is
 * the real chain — the ingestion hook (runIngestionRules, consulting the
 * stored delivery schedule) → the engines' hold application
 * (applyDeliveryHolds) → the query-level exclusions (inbox list, inbox
 * badge, OS unread count) → the due pass (releaseDueHolds). No provider or
 * queue exists on this path: a hold is a local timestamp (design D6),
 * nothing moves, nothing is enqueued.
 */

let executor: TestExecutor
let accountId: string
let inboxLabelId: string

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
})

afterEach(() => {
  executor.close()
})

/** Inbox thread with one (optionally unread) message; caches like sync. */
async function seedInboxThread(options: {
  date: number
  from?: string
  unread?: boolean
}): Promise<string> {
  const threadId = await createThread(executor, accountId)
  await createMessage(executor, {
    threadId,
    accountId,
    date: options.date,
    fromAddress: options.from,
    isRead: options.unread === false,
  })
  await setThreadLabels(executor, threadId, [inboxLabelId])
  await recomputeThreadCaches(executor, threadId)
  return threadId
}

/** A minimal, valid IngestionEvent (the engines build these from inputs). */
function makeEvent(
  overrides: Partial<IngestionEvent> &
    Pick<IngestionEvent, "messageRowId" | "threadId">
): IngestionEvent {
  return {
    fromAddress: null,
    fromName: null,
    toJson: null,
    ccJson: null,
    bccJson: null,
    subject: null,
    snippet: null,
    labelNames: [],
    isRead: false,
    isStarred: false,
    hasAttachments: false,
    date: 1_700_000_000,
    threadHasUserMessage: false,
    isMailingList: false,
    sizeEstimate: null,
    ...overrides,
  }
}

async function listInbox() {
  return listThreadsByFolder(executor, {
    accountId,
    folder: { kind: "specialUse", specialUse: "inbox" },
  })
}

describe("hold → release round trip", () => {
  it("ingests a matching message held, hides it from inbox/badges/unread, then the due pass releases the batch to the TOP of the inbox", async () => {
    // "Newsletters from news@x.com, Saturdays 8 AM."
    await createDeliverySchedule(executor, accountId, {
      match: { kind: "sender", value: "news@x.com" },
      window: { kind: "weekly", dayOfWeek: 6, hour: 8, minute: 0 },
    })
    const heldThread = await seedInboxThread({
      date: at(50),
      from: "news@x.com",
      unread: true,
    })
    // A regular, newer inbox thread proves both the exclusion and the
    // "released batch tops the inbox" ordering afterwards.
    const regularThread = await seedInboxThread({
      date: at(8000),
      from: "friend@x.com",
      unread: true,
    })

    // ---- Ingestion: the hook consults the STORED schedule row (no
    // preload) and reports the hold + announcement suppression.
    const now = at(1000)
    const outcomes = await runIngestionRules(
      executor,
      accountId,
      [
        makeEvent({
          messageRowId: "m-held",
          threadId: heldThread,
          fromAddress: "news@x.com",
        }),
      ],
      { now }
    )
    expect(outcomes).toHaveLength(1)
    const heldUntil = await resolveDeliveryHold(
      executor,
      accountId,
      { senderAddress: "news@x.com", labelNames: [] },
      { now }
    )
    expect(outcomes[0]?.heldUntil).toBe(heldUntil)
    expect(outcomes[0]?.suppressesNotification).toBe(true) // held mail never announces
    expect(outcomes[0]?.appliedActions).toEqual([])

    // ---- The engine seam: one UPDATE pins the hold on the thread.
    await applyDeliveryHolds(executor, outcomes)
    expect((await getThread(executor, heldThread))?.held_until).toBe(heldUntil)

    // ---- Exclusions while held: out of the inbox list and both badge
    // layers (unread message counted NOWHERE), yet visible in All Mail.
    expect((await listInbox()).map((thread) => thread.id)).toEqual([
      regularThread,
    ])
    expect((await unreadCountBySpecialUse(executor, accountId)).inbox).toBe(1)
    expect(await getTotalUnreadCount(executor)).toBe(1)
    const allMail = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "preset", preset: "all" },
    })
    expect(allMail.map((thread) => thread.id)).toEqual([
      regularThread,
      heldThread,
    ])

    // ---- Keep-first-hold: a second matching message on the SAME thread
    // (a later now → possibly a different window) does not move the hold.
    const laterNow = at(2000)
    const secondOutcomes = await runIngestionRules(
      executor,
      accountId,
      [
        makeEvent({
          messageRowId: "m-held-2",
          threadId: heldThread,
          fromAddress: "news@x.com",
        }),
      ],
      { now: laterNow }
    )
    expect(secondOutcomes[0]?.suppressesNotification).toBe(true)
    await applyDeliveryHolds(executor, secondOutcomes)
    expect((await getThread(executor, heldThread))?.held_until).toBe(heldUntil)

    // ---- The due pass before the window: nothing due, hold stays.
    expect(await releaseDueHolds(executor, (heldUntil ?? now) - 1)).toBe(0)
    expect((await getThread(executor, heldThread))?.held_until).toBe(heldUntil)

    // ---- The window opens: one batched release clears the hold and
    // stamps delivered_at = now, topping the inbox despite the thread's
    // much older last_message_at; the unread state returns untouched.
    const releaseNow = (heldUntil ?? now) + 200 // newer than the regular thread's sort key
    expect(await releaseDueHolds(executor, releaseNow)).toBe(1)
    expect(await getThread(executor, heldThread)).toMatchObject({
      held_until: null,
      delivered_at: releaseNow,
      unread_count: 1, // read state never mutated by hold/release
    })
    const inbox = await listInbox()
    expect(inbox.map((thread) => thread.id)).toEqual([
      heldThread, // delivered_at tops the COALESCE ordering
      regularThread,
    ])
    expect(inbox.map((thread) => thread.unread_count)).toEqual([1, 1])
    // Both badge layers count the held thread's message again.
    expect((await unreadCountBySpecialUse(executor, accountId)).inbox).toBe(2)
    expect(await getTotalUnreadCount(executor)).toBe(2)
  })

  it("the release handler is the registered due-job name (bootstrap contract)", () => {
    expect(DELIVERY_HOLDS_DUE_JOB).toBe("delivery-holds.release")
  })

  it("label matches hold too, and a non-matching message is never held", async () => {
    await createDeliverySchedule(executor, accountId, {
      match: { kind: "label", value: "Newsletters" },
      window: { kind: "weekly", dayOfWeek: 6, hour: 8, minute: 0 },
    })
    const threadId = await seedInboxThread({ date: at(10) })
    const now = at(100)

    const held = await runIngestionRules(
      executor,
      accountId,
      [
        makeEvent({
          messageRowId: "m1",
          threadId,
          labelNames: ["Finance/Newsletters"],
        }),
      ],
      { now }
    )
    expect(held[0]?.heldUntil).not.toBeNull()

    const plain = await runIngestionRules(
      executor,
      accountId,
      [
        makeEvent({
          messageRowId: "m2",
          threadId,
          labelNames: ["Receipts/2024"],
        }),
      ],
      { now }
    )
    expect(plain[0]?.heldUntil).toBeNull()
    expect(plain[0]?.suppressesNotification).toBe(false)
    await applyDeliveryHolds(executor, plain)
    expect((await getThread(executor, threadId))?.held_until).toBeNull()
  })

  it("an account without schedules never holds (the hook stays inert)", async () => {
    const threadId = await seedInboxThread({ date: at(10) })
    const outcomes = await runIngestionRules(
      executor,
      accountId,
      [makeEvent({ messageRowId: "m1", threadId, fromAddress: "news@x.com" })],
      { now: at(100) }
    )
    expect(outcomes[0]?.heldUntil).toBeNull()
    expect(outcomes[0]?.suppressesNotification).toBe(false)
  })

  it("held timestamps are unix seconds derived from the weekly window (BASE_TIME sanity)", async () => {
    await createDeliverySchedule(executor, accountId, {
      match: { kind: "sender", value: "news@x.com" },
      window: { kind: "weekly", dayOfWeek: 6, hour: 8, minute: 0 },
    })
    const hold = await resolveDeliveryHold(
      executor,
      accountId,
      { senderAddress: "news@x.com", labelNames: [] },
      { now: BASE_TIME }
    )
    expect(hold).not.toBeNull()
    expect(hold!).toBeGreaterThan(BASE_TIME)
  })
})
