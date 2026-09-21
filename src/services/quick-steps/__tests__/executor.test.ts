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
  getThreadWithMessages,
  recomputeThreadCaches,
  setThreadFolder,
  setThreadLabels,
} from "../../db/threads"
import {
  listOperationsByStatus,
  type PendingOperationRow,
} from "../../db/pending-operations"
import { operationFromRow, type QueueOperation } from "../../queue/operation"
import type { MessageRef } from "../../email/types"
import { runQuickStep, type QuickStepRunResult } from "../executor"
import type { QuickStep, QuickStepAction } from "../../settings/quick-steps"

/**
 * Quick-step executor tests (task 3.1). Same seam as thread-actions'
 * own suite: db + queue only, no provider exists in these tests at all
 * (nothing to mock) — the offline invariant is asserted via the
 * pending_operations rows, ordering via their FIFO order.
 */

function step(name: string, actions: QuickStepAction[]): QuickStep {
  return { id: `step-${name}`, name, actions, order: 0 }
}

/** Enqueued (pending) ops for the account, deserialized, FIFO order. */
async function enqueuedOps(
  executor: SqlExecutor,
  accountId: string
): Promise<QueueOperation[]> {
  const rows: PendingOperationRow[] = await listOperationsByStatus(
    executor,
    "pending",
    accountId
  )
  return rows.map(operationFromRow)
}

/** Numeric gmail message ids, unique across the suite. */
let gmailIdSequence = 9_000_000_000_000_000

interface GmailFixture {
  accountId: string
  inbox: string
  newsletters: string
}

/** One gmail account with INBOX plus a user label both named for the
 * per-account test (every account gets a "Newsletters" label). */
async function seedGmailAccount(
  executor: SqlExecutor,
  newslettersName = "Newsletters"
): Promise<GmailFixture> {
  const accountId = await createAccount(executor, "gmail")
  return {
    accountId,
    inbox: await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    ),
    newsletters: await createGmailLabel(
      executor,
      accountId,
      newslettersName,
      newslettersName,
      undefined,
      "user"
    ),
  }
}

/** A two-message unread gmail thread sitting in Inbox. */
async function seedGmailInboxThread(
  executor: SqlExecutor,
  fixture: GmailFixture,
  options?: { withoutProviderIds?: boolean }
): Promise<{ threadId: string; refs: MessageRef[] }> {
  const accountId = fixture.accountId
  const threadId = await createThread(executor, accountId, {
    subject: "Hello",
  })
  await setThreadLabels(executor, threadId, [fixture.inbox])
  const ids = [gmailIdSequence + 1, gmailIdSequence + 2].map(String)
  gmailIdSequence += 2
  let offset = 0
  for (const gmailMessageId of ids) {
    await createMessage(executor, {
      threadId,
      accountId,
      date: at(offset),
      ...(options?.withoutProviderIds ? {} : { gmailMessageId }),
      snippet: `body ${offset}`,
    })
    offset += 60
  }
  await recomputeThreadCaches(executor, threadId)
  return {
    threadId,
    refs: ids.map((id) => ({
      folder: "",
      uid: Number(id),
      providerMessageId: id,
    })),
  }
}

interface ImapFixture {
  accountId: string
  inbox: string
  archive: string
}

/** One imap account with INBOX and Archive folders. */
async function seedImapAccount(executor: SqlExecutor): Promise<ImapFixture> {
  const accountId = await createAccount(executor, "imap")
  return {
    accountId,
    inbox: await createImapFolderLabel(executor, accountId, "INBOX", "inbox"),
    archive: await createImapFolderLabel(
      executor,
      accountId,
      "Archive",
      "archive"
    ),
  }
}

/** A two-message unread imap thread living in `folderPath`. */
async function seedImapThread(
  executor: SqlExecutor,
  fixture: ImapFixture,
  folderPath: string
): Promise<string> {
  const folderLabelId = folderPath === "INBOX" ? fixture.inbox : fixture.archive
  const threadId = await createThread(executor, fixture.accountId, {
    subject: "Hello",
  })
  await setThreadFolder(executor, threadId, folderLabelId)
  let uid = 500
  let offset = 0
  for (let index = 0; index < 2; index += 1) {
    await createMessage(executor, {
      threadId,
      accountId: fixture.accountId,
      date: at(offset),
      imapFolder: folderPath,
      imapUid: (uid += 1),
      snippet: `body ${offset}`,
    })
    offset += 60
  }
  await recomputeThreadCaches(executor, threadId)
  return threadId
}

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
})

afterEach(() => {
  executor.close()
})

describe("quick step executor (task 3.1)", () => {
  it("applies a chain in order: mark read, add label, archive", async () => {
    const fixture = await seedGmailAccount(executor)
    const { threadId, refs } = await seedGmailInboxThread(executor, fixture)
    const cleanup = step("Cleanup", [
      { kind: "mark_read", read: true },
      { kind: "add_label", label: "Newsletters" },
      { kind: "archive" },
    ])

    const run = await runQuickStep(executor, cleanup, [threadId])

    // Per-thread per-action summary: every action applied, chain order.
    const only = run.results[0]!
    expect(only.threadId).toBe(threadId)
    expect(only.accountId).toBe(fixture.accountId)
    expect(
      only.outcomes.map((outcome) => [outcome.action.kind, outcome.status])
    ).toEqual([
      ["mark_read", "applied"],
      ["add_label", "applied"],
      ["archive", "applied"],
    ])

    // The local end state carries all three effects.
    const loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.thread).toMatchObject({
      unread_count: 0,
      is_archived: 1,
      is_trashed: 0,
    })
    expect(loaded?.messages.every((message) => message.is_read === 1)).toBe(
      true
    )
    expect(loaded?.labelIds).toEqual([fixture.newsletters])

    // FIFO queue ops prove the chain ORDER (D10: mutate then enqueue,
    // per action, sequentially).
    const ops = await enqueuedOps(executor, fixture.accountId)
    expect(ops.map((op) => op.kind)).toEqual([
      "mark_read",
      "add_labels",
      "archive",
    ])
    expect(ops[1]).toMatchObject({
      accountId: fixture.accountId,
      refs,
      labelIds: ["Newsletters"],
    })
  })

  it("resolves per-account actions against each thread's OWN account", async () => {
    // Two accounts, each with a label literally named "Newsletters" — a
    // quick step is account-agnostic, so ONE add-label action must land
    // on each thread's own account's label row.
    const home = await seedGmailAccount(executor)
    const work = await seedGmailAccount(executor)
    const homeThread = await seedGmailInboxThread(executor, home)
    const workThread = await seedGmailInboxThread(executor, work)
    const labelStep = step("Newsletter", [
      { kind: "add_label", label: "Newsletters" },
      { kind: "mark_read", read: true },
    ])

    const run = await runQuickStep(executor, labelStep, [
      homeThread.threadId,
      workThread.threadId,
    ])

    expect(run.results.map((result) => result.accountId)).toEqual([
      home.accountId,
      work.accountId,
    ])
    const homeLoaded = await getThreadWithMessages(
      executor,
      homeThread.threadId
    )
    const workLoaded = await getThreadWithMessages(
      executor,
      workThread.threadId
    )
    // Each thread carries ITS account's label row id (not the other's).
    expect(homeLoaded?.labelIds).toContain(home.newsletters)
    expect(homeLoaded?.labelIds).not.toContain(work.newsletters)
    expect(workLoaded?.labelIds).toContain(work.newsletters)
    expect(workLoaded?.labelIds).not.toContain(home.newsletters)
    expect(workLoaded?.thread.unread_count).toBe(0)
    // One add_labels op per account, each scoped to its own account id.
    for (const fixture of [home, work]) {
      const ops = await enqueuedOps(executor, fixture.accountId)
      expect(ops).toHaveLength(2)
      expect(ops.every((op) => op.accountId === fixture.accountId)).toBe(true)
    }
  })

  it("applies the chain to every thread in a five-thread selection", async () => {
    const fixture = await seedGmailAccount(executor)
    const seeded = []
    for (let index = 0; index < 5; index += 1) {
      seeded.push(await seedGmailInboxThread(executor, fixture))
    }
    const cleanup = step("Cleanup", [
      { kind: "mark_read", read: true },
      { kind: "archive" },
    ])

    const run = await runQuickStep(
      executor,
      cleanup,
      seeded.map((thread) => thread.threadId)
    )

    // One result per input thread, input order.
    expect(run.results.map((result) => result.threadId)).toEqual(
      seeded.map((thread) => thread.threadId)
    )
    for (const result of run.results) {
      expect(result.outcomes.map((outcome) => outcome.status)).toEqual([
        "applied",
        "applied",
      ])
    }
    for (const thread of seeded) {
      const loaded = await getThreadWithMessages(executor, thread.threadId)
      expect(loaded?.thread).toMatchObject({
        unread_count: 0,
        is_archived: 1,
      })
    }
    const ops = await enqueuedOps(executor, fixture.accountId)
    expect(ops).toHaveLength(10) // mark_read + archive per thread
    expect(ops.filter((op) => op.kind === "archive")).toHaveLength(5)
  })

  it("skips unknown thread ids without aborting the run", async () => {
    const fixture = await seedGmailAccount(executor)
    const { threadId } = await seedGmailInboxThread(executor, fixture)
    const cleanup = step("Cleanup", [
      { kind: "mark_read", read: true },
      { kind: "archive" },
    ])

    const run = await runQuickStep(executor, cleanup, ["thread-nope", threadId])

    const missing = run.results[0]!
    expect(missing.accountId).toBeNull()
    expect(
      missing.outcomes.map(
        (outcome) => [outcome.status, outcome.detail] as const
      )
    ).toEqual([
      ["skipped", "thread not found"],
      ["skipped", "thread not found"],
    ])
    // The real thread still ran, input order preserved.
    expect(run.results[1]!.threadId).toBe(threadId)
    expect(run.results[1]!.outcomes.map((o) => o.status)).toEqual([
      "applied",
      "applied",
    ])
  })

  it("records skipped actions per account and continues the chain", async () => {
    // gmail: move-to-folder is an imap action; an unknown label name has
    // no row on the account — both skip while the chain continues.
    const fixture = await seedGmailAccount(executor)
    const { threadId } = await seedGmailInboxThread(executor, fixture)
    const mixed = step("Mixed", [
      { kind: "move_to_folder", folderPath: "Archive" },
      { kind: "add_label", label: "Missing" },
      { kind: "mark_done" },
      { kind: "archive" },
    ])

    const run = await runQuickStep(executor, mixed, [threadId])

    expect(
      run.results[0]!.outcomes.map(
        (outcome) => [outcome.action.kind, outcome.status] as const
      )
    ).toEqual([
      ["move_to_folder", "skipped"],
      ["add_label", "skipped"],
      ["mark_done", "applied"],
      ["archive", "applied"],
    ])
    const loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.thread.done_at).not.toBeNull()
    expect(loaded?.thread.is_archived).toBe(1)
  })

  it("stops a thread's chain at a failed action but keeps other threads", async () => {
    const fixture = await seedGmailAccount(executor)
    const broken = await seedGmailInboxThread(executor, fixture, {
      withoutProviderIds: true,
    })
    const good = await seedGmailInboxThread(executor, fixture)
    const chain = step("Chain", [{ kind: "archive" }, { kind: "star" }])

    const run = await runQuickStep(executor, chain, [
      broken.threadId,
      good.threadId,
    ])

    // The broken thread (no provider refs) fails the archive; the star
    // after it never runs for THAT thread...
    const brokenResult = run.results[0]!
    expect(brokenResult.outcomes).toHaveLength(1)
    expect(brokenResult.outcomes[0]!.status).toBe("failed")
    expect(brokenResult.outcomes[0]!.detail).toContain("provider identity")
    // ...but the next thread runs its full chain.
    expect(run.results[1]!.outcomes.map((o) => o.status)).toEqual([
      "applied",
      "applied",
    ])
    const goodLoaded = await getThreadWithMessages(executor, good.threadId)
    expect(goodLoaded?.thread.is_starred).toBe(1)
  })

  it("snoozes with a preset resolved at run time (injectable for tests)", async () => {
    const fixture = await seedGmailAccount(executor)
    const { threadId } = await seedGmailInboxThread(executor, fixture)
    const TOMORROW = 1_800_000_000
    const snoozeStep = step("Tonight", [
      { kind: "snooze", presetId: "tomorrow" },
      { kind: "mark_read", read: true },
    ])

    const run = await runQuickStep(executor, snoozeStep, [threadId], {
      resolveSnoozePreset: (presetId) =>
        presetId === "tomorrow" ? TOMORROW : null,
    })

    expect(run.results[0]!.outcomes.map((o) => o.status)).toEqual([
      "applied",
      "applied",
    ])
    const loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.thread.snoozed_until).toBe(TOMORROW)
    expect(loaded?.thread.unread_count).toBe(0)

    // An unavailable preset (e.g. "later today" past 6 PM) skips the
    // snooze but the chain continues.
    const later = step("Later", [
      { kind: "snooze", presetId: "later_today" },
      { kind: "star" },
    ])
    const secondRun: QuickStepRunResult = await runQuickStep(
      executor,
      later,
      [threadId],
      { resolveSnoozePreset: () => null }
    )
    expect(secondRun.results[0]!.outcomes[0]!.status).toBe("skipped")
    expect(secondRun.results[0]!.outcomes[1]!.status).toBe("applied")
  })

  it("moves imap threads to the named folder on their own account", async () => {
    const fixture = await seedImapAccount(executor)
    const threadId = await seedImapThread(executor, fixture, "INBOX")
    const file = step("File", [
      { kind: "move_to_folder", folderPath: "Archive" },
      { kind: "star" },
    ])

    const run = await runQuickStep(executor, file, [threadId])

    expect(run.results[0]!.outcomes.map((o) => o.status)).toEqual([
      "applied",
      "applied",
    ])
    const loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.thread.folder_label_id).toBe(fixture.archive)
    expect(
      loaded?.messages.every((message) => message.imap_folder === "Archive")
    ).toBe(true)
    const ops = await enqueuedOps(executor, fixture.accountId)
    expect(ops[0]).toMatchObject({
      accountId: fixture.accountId,
      kind: "move",
      destinationFolder: "Archive",
    })
    expect(ops.map((op) => op.kind)).toEqual(["move", "star"])
  })

  it("queues a server-side move when the folder path has no local row", async () => {
    // The same degradation thread-actions applies for archive/trash: no
    // local folder row → the local copy is untouched but the `move` op
    // still queues (the provider applies by path at replay).
    const fixture = await seedImapAccount(executor)
    const threadId = await seedImapThread(executor, fixture, "INBOX")
    const file = step("File", [
      { kind: "move_to_folder", folderPath: "Does/Not/Exist" },
      { kind: "star" },
    ])

    const run = await runQuickStep(executor, file, [threadId])

    expect(run.results[0]!.outcomes.map((o) => o.status)).toEqual([
      "applied",
      "applied",
    ])
    const loaded = await getThreadWithMessages(executor, threadId)
    expect(loaded?.thread.folder_label_id).toBe(fixture.inbox)
    const ops = await enqueuedOps(executor, fixture.accountId)
    expect(ops[0]).toMatchObject({
      kind: "move",
      destinationFolder: "Does/Not/Exist",
    })
  })
})
