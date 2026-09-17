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
import { ThreadNotFoundError } from "../thread-actions"
import {
  getSnoozePresets,
  listSnoozedThreads,
  snoozeThread,
  unsnoozeThread,
  wakeDueThreads,
} from "../snooze"

/**
 * Task 2.1 snooze service tests + the 2.5 startup-sweep integration case.
 * The layer is db-only — snooze is local state, so no provider or queue
 * exists in these tests at all (nothing to mock): the local-only
 * invariant holds by construction (no pending_operations writes) and the
 * "prior unread state" invariant by the query-level exclusion (snooze
 * never mutates unread_count — asserted via inbox lists below).
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
  unread?: boolean
}): Promise<string> {
  const threadId = await createThread(executor, options.accountId)
  await createMessage(executor, {
    threadId,
    accountId: options.accountId,
    date: options.date,
    isRead: !options.unread,
  })
  await setThreadLabels(executor, threadId, [options.inboxLabelId])
  await recomputeThreadCaches(executor, threadId)
  return threadId
}

async function listInbox(accountId: string) {
  return listThreadsByFolder(executor, {
    accountId,
    folder: { kind: "specialUse", specialUse: "inbox" },
  })
}

describe("snoozeThread / listSnoozedThreads", () => {
  it("sets snoozed_until; the snoozed list carries the wake-up time", async () => {
    const { accountId, inbox } = await seedGmailInbox()
    const threadId = await seedInboxThread({
      accountId,
      inboxLabelId: inbox,
      date: at(100),
      unread: true,
    })

    await snoozeThread(executor, threadId, at(5000))

    expect((await getThread(executor, threadId))?.snoozed_until).toBe(at(5000))
    const snoozed = await listSnoozedThreads(executor)
    expect(snoozed.map((thread) => thread.id)).toEqual([threadId])
    expect(snoozed[0]?.snoozed_until).toBe(at(5000))
  })

  it("orders the snoozed list by wake-up time, earliest first", async () => {
    const { accountId, inbox } = await seedGmailInbox()
    const later = await seedInboxThread({
      accountId,
      inboxLabelId: inbox,
      date: at(100),
    })
    const earlier = await seedInboxThread({
      accountId,
      inboxLabelId: inbox,
      date: at(200),
    })

    await snoozeThread(executor, later, at(9000))
    await snoozeThread(executor, earlier, at(4000))

    const snoozed = await listSnoozedThreads(executor)
    expect(snoozed.map((thread) => thread.id)).toEqual([earlier, later])
  })

  it("re-snoozing moves the wake-up time; a missing thread throws", async () => {
    const { accountId, inbox } = await seedGmailInbox()
    const threadId = await seedInboxThread({
      accountId,
      inboxLabelId: inbox,
      date: at(100),
    })

    await snoozeThread(executor, threadId, at(5000))
    await snoozeThread(executor, threadId, at(6000))
    expect((await getThread(executor, threadId))?.snoozed_until).toBe(at(6000))

    await expect(
      snoozeThread(executor, "no-such-thread", at(5000))
    ).rejects.toBeInstanceOf(ThreadNotFoundError)
  })
})

describe("wakeDueThreads", () => {
  it(
    "startup sweep: a thread whose snooze time passed while the app was " +
      "closed is woken on the next run, and only it",
    async () => {
      const { accountId, inbox } = await seedGmailInbox()
      // Pre-seeded overdue row (2.5): snoozed to a time already in the
      // past when the sweep runs — the launch catch-up case.
      const overdue = await seedInboxThread({
        accountId,
        inboxLabelId: inbox,
        date: at(100),
        unread: true,
      })
      const future = await seedInboxThread({
        accountId,
        inboxLabelId: inbox,
        date: at(200),
        unread: true,
      })
      const plain = await seedInboxThread({
        accountId,
        inboxLabelId: inbox,
        date: at(300),
        unread: true,
      })
      await snoozeThread(executor, overdue, at(1000))
      await snoozeThread(executor, future, at(9000))

      const woken = await wakeDueThreads(executor, at(5000))
      expect(woken).toBe(1)

      // Woken: snooze cleared, delivered_at = the sweep's now, and the
      // prior unread state untouched (never mutated by snooze/wake).
      expect(await getThread(executor, overdue)).toMatchObject({
        snoozed_until: null,
        delivered_at: at(5000),
        unread_count: 1,
      })
      // Future snooze untouched; never-snoozed thread gets no stamp.
      expect((await getThread(executor, future))?.snoozed_until).toBe(at(9000))
      expect((await getThread(executor, future))?.delivered_at).toBeNull()
      expect((await getThread(executor, plain))?.delivered_at).toBeNull()
      expect(await listSnoozedThreads(executor)).toHaveLength(1)
    }
  )

  it("returns 0 when nothing is due", async () => {
    const { accountId, inbox } = await seedGmailInbox()
    await seedInboxThread({
      accountId,
      inboxLabelId: inbox,
      date: at(100),
    })
    expect(await wakeDueThreads(executor, at(5000))).toBe(0)
  })

  it("the woken thread re-enters the inbox at the top, unread as before", async () => {
    const { accountId, inbox } = await seedGmailInbox()
    const older = await seedInboxThread({
      accountId,
      inboxLabelId: inbox,
      date: at(100),
      unread: true,
    })
    const newer = await seedInboxThread({
      accountId,
      inboxLabelId: inbox,
      date: at(8000),
      unread: true,
    })

    await snoozeThread(executor, older, at(2000))
    let rows = await listInbox(accountId)
    expect(rows.map((thread) => thread.id)).toEqual([newer])

    // The sweep runs at a later real "now" — later than any existing
    // message date, like a launch after the snooze passed.
    expect(await wakeDueThreads(executor, at(9000))).toBe(1)
    rows = await listInbox(accountId)
    // delivered_at tops the inbox despite the older last_message_at, and
    // the unread state is exactly as it was before the snooze.
    expect(rows.map((thread) => thread.id)).toEqual([older, newer])
    expect(rows.map((thread) => thread.unread_count)).toEqual([1, 1])
  })
})

describe("unsnoozeThread", () => {
  it("cancels the snooze without touching delivered_at or read state", async () => {
    const { accountId, inbox } = await seedGmailInbox()
    const threadId = await seedInboxThread({
      accountId,
      inboxLabelId: inbox,
      date: at(100),
      unread: true,
    })

    // A first wake stamps delivered_at; a later re-snooze + cancel must
    // leave that stamp (unsnooze is a plain cancel, not a wake).
    await snoozeThread(executor, threadId, at(1000))
    await wakeDueThreads(executor, at(2000))
    await snoozeThread(executor, threadId, at(9000))
    await unsnoozeThread(executor, threadId)

    expect(await getThread(executor, threadId)).toMatchObject({
      snoozed_until: null,
      delivered_at: at(2000),
      unread_count: 1,
    })
    expect(await listSnoozedThreads(executor)).toHaveLength(0)
  })
})

describe("getSnoozePresets", () => {
  it("returns future presets plus the custom-picker marker", () => {
    // Mid-morning: all three presets apply.
    const now = new Date(2026, 8, 16, 10, 30, 0) // Sep 16 2026, 10:30 local
    const { presets, showCustomPicker } = getSnoozePresets(now)

    expect(showCustomPicker).toBe(true)
    expect(presets.map((preset) => preset.id)).toEqual([
      "later_today",
      "tomorrow",
      "next_week",
    ])
    expect(presets.map((preset) => preset.label)).toEqual([
      "Later today",
      "Tomorrow 8:00",
      "Next week",
    ])
    for (const preset of presets) {
      expect(preset.until).toBeGreaterThan(Math.floor(now.getTime() / 1000))
    }
    // "Tomorrow 8:00" is exactly 8:00 local the next day.
    const tomorrow = new Date(presets[1].until * 1000)
    expect(tomorrow.getDate()).toBe(now.getDate() + 1)
    expect(tomorrow.getHours()).toBe(8)
    expect(tomorrow.getMinutes()).toBe(0)
  })

  it("drops 'Later today' once 6 PM has passed; the rest stay future", () => {
    const evening = new Date(2026, 8, 16, 20, 0, 0) // 8 PM local
    const { presets, showCustomPicker } = getSnoozePresets(evening)

    expect(showCustomPicker).toBe(true)
    expect(presets.map((preset) => preset.id)).toEqual([
      "tomorrow",
      "next_week",
    ])
    for (const preset of presets) {
      expect(preset.until).toBeGreaterThan(Math.floor(evening.getTime() / 1000))
    }
  })

  it("is pure: the same base time yields the same presets", () => {
    const now = new Date(2026, 8, 16, 9, 0, 0)
    expect(getSnoozePresets(now)).toEqual(getSnoozePresets(now))
  })
})
