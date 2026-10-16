import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The permission gate is the new-mail notifier's once-per-run memo —
// stub it so tests neither prompt nor depend on the plugin.
const ensurePermissionMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/notifications/new-mail-notifier", () => ({
  ensureNotificationPermission: ensurePermissionMock,
}))

import {
  buildNotification,
  checkMeetingReminders,
  reminderWindowSeconds,
} from "../meeting-reminders"
import {
  setAccountReminderLeadMinutes,
  getAccountReminderLeadMinutes,
} from "../../db/accounts"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"

/**
 * Meeting-start reminder tests (parity-round-3 task 8.5, design D5):
 * the per-account lead (default OFF), the lead window, the
 * once-per-event guard via reminded_at, and the cancelled-event skip.
 */

async function seedSourceAndEvent(
  executor: TestExecutor,
  options: {
    accountId: string
    rowId: string
    startInSeconds: number
    status?: string | null
    summary?: string
  }
): Promise<void> {
  const existing = await executor.select<{ id: string }>(
    "SELECT id FROM calendar_sources WHERE id = 'src-1'"
  )
  if (existing.length === 0) {
    await executor.execute(
      `INSERT INTO calendar_sources (id, account_id, provider, name, config_json)
       VALUES ('src-1', $1, 'google', 'me@gmail.com', 'sealed')`,
      [options.accountId]
    )
  }
  await executor.execute(
    `INSERT INTO calendar_events (id, source_id, calendar_id, uid, ical, summary, start_at, end_at, all_day, status)
     VALUES ($1, 'src-1', 'primary', $2, '', $3, $4, $5, 0, $6)`,
    [
      options.rowId,
      options.rowId,
      options.summary ?? "Quarterly review",
      Math.floor(Date.now() / 1000) + options.startInSeconds,
      Math.floor(Date.now() / 1000) + options.startInSeconds + 1800,
      options.status ?? "confirmed",
    ]
  )
}

beforeEach(() => {
  ensurePermissionMock.mockReset()
  ensurePermissionMock.mockResolvedValue(true)
})

describe("checkMeetingReminders", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    await executor.execute(
      `INSERT INTO accounts (id, type, email, status) VALUES ('acc-1', 'gmail', 'me@example.com', 'active')`
    )
    accountId = "acc-1"
  })

  afterEach(() => {
    executor.close()
  })

  it("is OFF by default: no lead configured raises nothing", async () => {
    await seedSourceAndEvent(executor, {
      accountId,
      rowId: "ce-1",
      startInSeconds: 300,
    })
    const sent: { title: string; body: string }[] = []
    const outcome = await checkMeetingReminders(executor, accountId, {
      send: (notification) => sent.push(notification),
    })
    expect(outcome).toEqual({ due: 0, notified: 0 })
    expect(sent).toEqual([])
    const rows = await executor.select<{ reminded_at: number | null }>(
      "SELECT reminded_at FROM calendar_events WHERE id = 'ce-1'"
    )
    expect(rows[0]?.reminded_at).toBeNull()
  })

  it("fires inside the lead window and stamps reminded_at once", async () => {
    await setAccountReminderLeadMinutes(executor, accountId, 15)
    expect(await getAccountReminderLeadMinutes(executor, accountId)).toBe(15)
    await seedSourceAndEvent(executor, {
      accountId,
      rowId: "ce-1",
      startInSeconds: 5 * 60,
    })
    const sent: { title: string; body: string }[] = []
    const outcome = await checkMeetingReminders(executor, accountId, {
      send: (notification) => sent.push(notification),
    })
    expect(outcome).toEqual({ due: 1, notified: 1 })
    expect(sent).toHaveLength(1)
    expect(sent[0].title).toBe("Meeting starting soon")
    expect(sent[0].body).toContain("Quarterly review")
    const rows = await executor.select<{ reminded_at: number | null }>(
      "SELECT reminded_at FROM calendar_events WHERE id = 'ce-1'"
    )
    expect(rows[0]?.reminded_at).not.toBeNull()

    // The GUARD: a second pass (same window) never re-fires.
    const second = await checkMeetingReminders(executor, accountId, {
      send: (notification) => sent.push(notification),
    })
    expect(second).toEqual({ due: 0, notified: 0 })
    expect(sent).toHaveLength(1)
  })

  it("ignores events outside the lead window (too far, or already started)", async () => {
    await setAccountReminderLeadMinutes(executor, accountId, 10)
    await seedSourceAndEvent(executor, {
      accountId,
      rowId: "ce-far",
      startInSeconds: 30 * 60,
    })
    await seedSourceAndEvent(executor, {
      accountId,
      rowId: "ce-past",
      startInSeconds: -60,
    })
    const sent: { title: string; body: string }[] = []
    const outcome = await checkMeetingReminders(executor, accountId, {
      send: (notification) => sent.push(notification),
    })
    expect(outcome).toEqual({ due: 0, notified: 0 })
    expect(sent).toEqual([])
  })

  it("never reminds for a cancelled event", async () => {
    await setAccountReminderLeadMinutes(executor, accountId, 10)
    await seedSourceAndEvent(executor, {
      accountId,
      rowId: "ce-cancelled",
      startInSeconds: 300,
      status: "cancelled",
    })
    const sent: { title: string; body: string }[] = []
    const outcome = await checkMeetingReminders(executor, accountId, {
      send: (notification) => sent.push(notification),
    })
    expect(outcome).toEqual({ due: 0, notified: 0 })
    expect(sent).toEqual([])
  })

  it("a permission denial raises nothing (and stamps nothing)", async () => {
    await setAccountReminderLeadMinutes(executor, accountId, 10)
    await seedSourceAndEvent(executor, {
      accountId,
      rowId: "ce-1",
      startInSeconds: 300,
    })
    ensurePermissionMock.mockResolvedValue(false)
    const sent: { title: string; body: string }[] = []
    const outcome = await checkMeetingReminders(executor, accountId, {
      send: (notification) => sent.push(notification),
    })
    expect(outcome).toEqual({ due: 0, notified: 0 })
    expect(sent).toEqual([])
    const rows = await executor.select<{ reminded_at: number | null }>(
      "SELECT reminded_at FROM calendar_events WHERE id = 'ce-1'"
    )
    expect(rows[0]?.reminded_at).toBeNull()
  })
})

describe("helpers", () => {
  it("reminderWindowSeconds converts minutes", () => {
    expect(reminderWindowSeconds(15)).toBe(900)
  })

  it("buildNotification names the event and the local start time", () => {
    const startAt = new Date(2026, 8, 18, 14, 0).getTime() / 1000
    const notification = buildNotification("Quarterly sync", startAt)
    expect(notification.title).toBe("Meeting starting soon")
    expect(notification.body).toContain("Quarterly sync")
    expect(notification.body).toContain("2:00 PM")
    expect(buildNotification(null, startAt).body).toContain("Meeting —")
  })
})
