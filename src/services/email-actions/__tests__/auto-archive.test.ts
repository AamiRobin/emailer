import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  at,
  createAccount,
  createGmailLabel,
  createImapFolderLabel,
  createMessage,
  createThread,
} from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import type { SqlExecutor } from "../../db/executor"
import {
  listOperationsByStatus,
  type PendingOperationRow,
} from "../../db/pending-operations"
import { getSetting, setSetting } from "../../db/settings"
import {
  getThread,
  getThreadWithMessages,
  listThreadsByFolder,
  recomputeThreadCaches,
  setThreadFolder,
  setThreadLabels,
} from "../../db/threads"
import { operationFromRow } from "../../queue/operation"
import { snoozeThread } from "../snooze"
import {
  AUTO_ARCHIVE_LAST_RUN_KEY,
  getAutoArchiveSetting,
  MIN_RUN_INTERVAL_SECONDS,
  runAutoArchive,
  selectAutoArchiveCandidates,
  setAutoArchiveSetting,
} from "../auto-archive"

/**
 * Task 12.3 auto-archive tests: the selection SQL (read + untouched +
 * inbox-resident, deliberate states excluded) against the real schema, and
 * the batch application through thread-actions' bulkApply (local archive
 * effect + pending archive op), plus the on/off toggle and the last-run
 * guard. No provider exists in these tests — actions only enqueue.
 */

let executor: TestExecutor
let accountId: string
let inboxLabelId: string

/** "Now" for the batch tests: 31 days in, so the 30-day cutoff is 1 day in. */
const NOW = at(31 * 24 * 60 * 60)
const CUTOFF = NOW - 30 * 24 * 60 * 60

/** Unique gmail provider ids — the archive op's MessageRefs need them. */
let gmailIdSequence = 6_000_000_000_000_000

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

/** Inbox thread with one message; caches like sync does. Gmail messages
 * carry a gmail_message_id so the queued archive op can build its refs. */
async function seedInboxThread(options: {
  accountId?: string
  inboxLabelId?: string
  date: number
  unread?: boolean
}): Promise<string> {
  const acct = options.accountId ?? accountId
  const inbox = options.inboxLabelId ?? inboxLabelId
  const threadId = await createThread(executor, acct)
  await createMessage(executor, {
    threadId,
    accountId: acct,
    date: options.date,
    gmailMessageId: String(gmailIdSequence++),
    isRead: !options.unread,
  })
  await setThreadLabels(executor, threadId, [inbox])
  await recomputeThreadCaches(executor, threadId)
  return threadId
}

/** Stamp one thread-state column directly (the selection test IS a SQL
 * test; the states' services are covered by their own suites). */
async function stampThreadState(
  threadId: string,
  column: "pinned_at" | "held_until" | "muted_at" | "done_at",
  value: number
): Promise<void> {
  await executor.execute(`UPDATE threads SET ${column} = $1 WHERE id = $2`, [
    value,
    threadId,
  ])
}

async function pendingOps(executor: SqlExecutor, acct: string) {
  const rows: PendingOperationRow[] = await listOperationsByStatus(
    executor,
    "pending",
    acct
  )
  return rows.map(operationFromRow)
}

// ---- Selection query --------------------------------------------------------

describe("selectAutoArchiveCandidates", () => {
  it("selects inbox threads that are READ and untouched past the cutoff", async () => {
    const stale = await seedInboxThread({ date: at(100) }) // read, old
    await seedInboxThread({ date: CUTOFF + 1 }) // read, recent
    await seedInboxThread({ date: at(100), unread: true }) // old, unread

    const selected = await selectAutoArchiveCandidates(executor, CUTOFF)
    expect(selected.map((row) => row.id)).toEqual([stale])
    expect(selected[0]?.account_id).toBe(accountId)
  })

  it("skips trashed, spammed and already-archived threads", async () => {
    const trash = await createGmailLabel(
      executor,
      accountId,
      "TRASH",
      "TRASH",
      "trash"
    )
    const spam = await createGmailLabel(
      executor,
      accountId,
      "SPAM",
      "SPAM",
      "spam"
    )
    const archived = await seedInboxThread({ date: at(100) })
    await setThreadLabels(executor, archived, []) // gmail absent-inbox = archived
    await recomputeThreadCaches(executor, archived)
    const trashed = await seedInboxThread({ date: at(100) })
    await setThreadLabels(executor, trashed, [trash])
    const spammed = await seedInboxThread({ date: at(100) })
    await setThreadLabels(executor, spammed, [spam])

    expect(await selectAutoArchiveCandidates(executor, CUTOFF)).toEqual([])
  })

  it("skips the deliberate thread states: pinned, snoozed, held, muted, Done", async () => {
    const pinned = await seedInboxThread({ date: at(100) })
    await stampThreadState(pinned, "pinned_at", at(200))
    const snoozed = await seedInboxThread({ date: at(100) })
    await snoozeThread(executor, snoozed, at(9999))
    const held = await seedInboxThread({ date: at(100) })
    await stampThreadState(held, "held_until", at(9999))
    const muted = await seedInboxThread({ date: at(100) })
    await stampThreadState(muted, "muted_at", at(200))
    const done = await seedInboxThread({ date: at(100) })
    await stampThreadState(done, "done_at", at(200))

    expect(await selectAutoArchiveCandidates(executor, CUTOFF)).toEqual([])
  })

  it("selects across every account (the batch is not per-account)", async () => {
    const other = await createAccount(executor, "imap")
    const otherInbox = await createImapFolderLabel(
      executor,
      other,
      "INBOX",
      "inbox"
    )
    const here = await seedInboxThread({ date: at(100) })
    const there = await seedInboxThread({
      accountId: other,
      inboxLabelId: otherInbox,
      date: at(100),
    })

    const selected = await selectAutoArchiveCandidates(executor, CUTOFF)
    expect(selected.map((row) => row.id).sort()).toEqual([here, there].sort())
  })

  it("resolves imap residency through the folder cache: an inbox-folder thread IS selected, a custom-folder thread is NOT", async () => {
    // setThreadFolder deliberately leaves is_archived = 0 for custom
    // folders — the old `is_archived = 0` selection swept those threads;
    // true inbox residency does not.
    const imap = await createAccount(executor, "imap")
    const inbox = await createImapFolderLabel(executor, imap, "INBOX", "inbox")
    const custom = await createImapFolderLabel(executor, imap, "Projects")

    async function seedInFolder(
      folderLabelId: string,
      imapFolder: string
    ): Promise<string> {
      const threadId = await createThread(executor, imap)
      await createMessage(executor, {
        threadId,
        accountId: imap,
        date: at(100),
        imapFolder,
        imapUid: imapFolder === "INBOX" ? 1 : 2,
        isRead: true,
      })
      await setThreadFolder(executor, threadId, folderLabelId)
      await recomputeThreadCaches(executor, threadId)
      return threadId
    }

    const inboxThread = await seedInFolder(inbox, "INBOX")
    const customThread = await seedInFolder(custom, "Projects")
    // Both look "unarchived" in the cache — only the inbox one is resident.
    expect((await getThread(executor, customThread))?.is_archived).toBe(0)

    const selected = await selectAutoArchiveCandidates(executor, CUTOFF)
    expect(selected.map((row) => row.id)).toEqual([inboxThread])
  })
})

// ---- Batch application --------------------------------------------------------

describe("runAutoArchive", () => {
  it("archives stale read inbox threads in a batch: local effect + queue op, across accounts", async () => {
    const other = await createAccount(executor, "gmail")
    const otherInbox = await createGmailLabel(
      executor,
      other,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const staleHere = await seedInboxThread({ date: at(100) })
    const staleThere = await seedInboxThread({
      accountId: other,
      inboxLabelId: otherInbox,
      date: at(100),
    })
    const untouched = await seedInboxThread({ date: at(100), unread: true })
    await setAutoArchiveSetting(executor, { enabled: true, days: 30 })

    const result = await runAutoArchive(executor, NOW)
    expect(result).toEqual({ archived: 2, skipped: null })

    // Local effect: out of the inbox, into the archive preset.
    expect(
      (await getThreadWithMessages(executor, staleHere))?.thread
    ).toMatchObject({ is_archived: 1, is_trashed: 0 })
    expect(
      (await getThreadWithMessages(executor, staleThere))?.thread.is_archived
    ).toBe(1)
    const inbox = await listThreadsByFolder(executor, {
      accountId,
      folder: { kind: "specialUse", specialUse: "inbox" },
    })
    expect(inbox.map((row) => row.id)).toEqual([untouched])

    // Existing archive ops: one pending `archive` per thread, per account.
    const opsHere = await pendingOps(executor, accountId)
    expect(opsHere).toEqual([
      expect.objectContaining({ kind: "archive", accountId }),
    ])
    const opsThere = await pendingOps(executor, other)
    expect(opsThere).toEqual([
      expect.objectContaining({ kind: "archive", accountId: other }),
    ])
  })

  it("archives an imap thread through the archive-role folder move", async () => {
    const imap = await createAccount(executor, "imap")
    const inbox = await createImapFolderLabel(executor, imap, "INBOX", "inbox")
    const archive = await createImapFolderLabel(
      executor,
      imap,
      "Archive",
      "archive"
    )
    const threadId = await createThread(executor, imap)
    await createMessage(executor, {
      threadId,
      accountId: imap,
      date: at(100),
      imapFolder: "INBOX",
      imapUid: 1,
      isRead: true,
    })
    await setThreadFolder(executor, threadId, inbox)
    await recomputeThreadCaches(executor, threadId)
    await setAutoArchiveSetting(executor, { enabled: true, days: 30 })

    expect(await runAutoArchive(executor, NOW)).toEqual({
      archived: 1,
      skipped: null,
    })
    expect(
      (await getThreadWithMessages(executor, threadId))?.thread
    ).toMatchObject({ is_archived: 1, folder_label_id: archive })
  })

  it("is a no-op when disabled (the default): nothing selected, guard not stamped", async () => {
    const stale = await seedInboxThread({ date: at(100) })

    expect(await runAutoArchive(executor, NOW)).toEqual({
      archived: 0,
      skipped: "disabled",
    })
    expect(
      (await getThreadWithMessages(executor, stale))?.thread.is_archived
    ).toBe(0)
    expect(await pendingOps(executor, accountId)).toEqual([])
    expect(await getSetting(executor, AUTO_ARCHIVE_LAST_RUN_KEY, 0)).toBe(0)
  })

  it("skips a pass within the last-run interval, then runs once it expires", async () => {
    const stale = await seedInboxThread({ date: at(100) })
    await setAutoArchiveSetting(executor, { enabled: true, days: 30 })
    await setSetting(executor, AUTO_ARCHIVE_LAST_RUN_KEY, NOW - 3600)

    expect(await runAutoArchive(executor, NOW)).toEqual({
      archived: 0,
      skipped: "recent-run",
    })
    expect(
      (await getThreadWithMessages(executor, stale))?.thread.is_archived
    ).toBe(0)

    // Past the 6h guard window: the pass runs and stamps the guard.
    await setSetting(
      executor,
      AUTO_ARCHIVE_LAST_RUN_KEY,
      NOW - MIN_RUN_INTERVAL_SECONDS - 1
    )
    const result = await runAutoArchive(executor, NOW)
    expect(result.archived).toBe(1)
    expect(
      await getSetting<number>(executor, AUTO_ARCHIVE_LAST_RUN_KEY, 0)
    ).toBe(NOW)
    expect(
      (await getThreadWithMessages(executor, stale))?.thread.is_archived
    ).toBe(1)
  })

  it("runs when the last-run stamp is in the future (backwards system clock)", async () => {
    // A clock moved back would otherwise suppress every pass until the
    // wall clock caught up to the stored stamp; the guard clamps it to 0.
    const stale = await seedInboxThread({ date: at(100) })
    await setAutoArchiveSetting(executor, { enabled: true, days: 30 })
    await setSetting(
      executor,
      AUTO_ARCHIVE_LAST_RUN_KEY,
      NOW + 10 * MIN_RUN_INTERVAL_SECONDS
    )

    expect(await runAutoArchive(executor, NOW)).toEqual({
      archived: 1,
      skipped: null,
    })
    expect(
      (await getThreadWithMessages(executor, stale))?.thread.is_archived
    ).toBe(1)
    // The clamped pass re-stamps with the current clock.
    expect(
      await getSetting<number>(executor, AUTO_ARCHIVE_LAST_RUN_KEY, 0)
    ).toBe(NOW)
  })
})

// ---- Setting accessors --------------------------------------------------------

describe("auto-archive setting", () => {
  it("defaults to disabled / 30 days and clamps the stored threshold", async () => {
    expect(await getAutoArchiveSetting(executor)).toEqual({
      enabled: false,
      days: 30,
    })

    await setAutoArchiveSetting(executor, { enabled: true, days: 9999 })
    expect(await getAutoArchiveSetting(executor)).toEqual({
      enabled: true,
      days: 365,
    })
    await setAutoArchiveSetting(executor, { enabled: true, days: 0 })
    expect(await getAutoArchiveSetting(executor)).toEqual({
      enabled: true,
      days: 1,
    })
  })

  it("reads a corrupt row as the disabled default", async () => {
    await setSetting(executor, "mail.autoArchive", { enabled: "yes" })
    expect(await getAutoArchiveSetting(executor)).toEqual({
      enabled: false,
      days: 30,
    })
  })
})
