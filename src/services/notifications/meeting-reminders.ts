import { sendNotification } from "@tauri-apps/plugin-notification"

import {
  getAccountReminderLeadMinutes,
} from "../db/accounts"
import type { SqlExecutor } from "../db/executor"
import { ensureNotificationPermission } from "./new-mail-notifier"

/**
 * Meeting-start reminders (parity-round-3 task 8.5, design D5): the
 * new-mail notifier's sibling on the calendar side. The sync scheduler
 * calls {@link checkMeetingReminders} per account after a pass (same
 * fire-and-forget posture as notifyNewMail — the scheduler stays dumb):
 *
 * - the per-account lead (accounts.reminder_lead_minutes, migration
 *   v20) DEFAULTS TO OFF — a null/absent/invalid value raises nothing;
 * - a meeting whose start falls inside [now, now + lead) raises ONE
 *   notification (title "Meeting starting soon", the event title and
 *   the local start time in the body — no location/organizer content
 *   beyond the title, matching the new-mail "no message content" rule);
 * - the ONCE-PER-EVENT guard is `calendar_events.reminded_at`: the
 *   column is stamped the moment the notification is handed over, so a
 *   later pass can never re-fire the same event;
 * - cancelled events never remind.
 *
 * Every failure is swallowed (a reminder may never break a sync pass);
 * the notification permission gate is the new-mail notifier's (shared
 * once-per-run resolution — no second mid-sync prompt).
 */

export interface MeetingReminderEvent {
  rowId: string
  summary: string | null
  /** Epoch seconds (all-day events sit at UTC midnight). */
  startAt: number
}

export interface MeetingReminderOutcome {
  /** Events found inside the lead window (before the guard filtered
   * already-reminded ones out). */
  due: number
  /** Notifications actually raised (and stamped). */
  notified: number
}

/** Injectable seams (tests): the OS notification transport. */
export interface MeetingReminderDeps {
  send?: (notification: { title: string; body: string }) => void
}

/** The reminder window's upper bound: `lead` minutes from now. */
export function reminderWindowSeconds(leadMinutes: number): number {
  return leadMinutes * 60
}

/**
 * Raise the due meeting reminders for one account. Never rejects.
 */
export async function checkMeetingReminders(
  executor: SqlExecutor,
  accountId: string,
  deps: MeetingReminderDeps = {}
): Promise<MeetingReminderOutcome> {
  try {
    const leadMinutes = await getAccountReminderLeadMinutes(executor, accountId)
    // OFF (the default) — nothing is scheduled, nothing is scanned.
    if (leadMinutes === null) return { due: 0, notified: 0 }
    // The shared once-per-run permission gate (a denial sticks for the
    // app run and never re-prompts — checked AFTER the off-gate so an
    // opted-out account can never trigger a prompt).
    if (!(await ensureNotificationPermission())) {
      return { due: 0, notified: 0 }
    }

    const now = Math.floor(Date.now() / 1000)
    const until = now + reminderWindowSeconds(leadMinutes)
    const rows = await executor.select<{
      id: string
      summary: string | null
      start_at: number
    }>(
      `SELECT ce.id, ce.summary, ce.start_at
         FROM calendar_events ce
         JOIN calendar_sources cs ON cs.id = ce.source_id
        WHERE cs.account_id = $1
          AND ce.reminded_at IS NULL
          AND (ce.status IS NULL OR ce.status != 'cancelled')
          AND ce.start_at >= $2
          AND ce.start_at <= $3
        ORDER BY ce.start_at ASC`,
      [accountId, now, until]
    )
    let notified = 0
    for (const row of rows) {
      try {
        const notification = buildNotification(row.summary, row.start_at)
        if (deps.send) deps.send(notification)
        else sendNotification(notification)
      } catch (error) {
        // No OS notification center / plugin failure — skip the stamp so
        // a later pass can try again while the app lives.
        console.warn("[meeting-reminders] notification failed", error)
        continue
      }
      // The once-per-event guard: stamp BEFORE counting further work so
      // a crash between send and stamp is the only re-fire window, and
      // a stamped-but-crashed run never spams (send-then-stamp, the
      // same hand-over order the new-mail coalescing uses).
      await executor.execute(
        "UPDATE calendar_events SET reminded_at = $1 WHERE id = $2",
        [now, row.id]
      )
      notified += 1
    }
    return { due: rows.length, notified }
  } catch (error) {
    console.warn("[meeting-reminders] check failed", error)
    return { due: 0, notified: 0 }
  }
}

/** "Meeting starting soon" + the local start time (12-hour clock). */
export function buildNotification(
  summary: string | null,
  startAt: number
): { title: string; body: string } {
  const title = summary?.trim() || "Meeting"
  const time = new Date(startAt * 1000).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  })
  return {
    title: "Meeting starting soon",
    body: `${title} — starts at ${time}`,
  }
}
