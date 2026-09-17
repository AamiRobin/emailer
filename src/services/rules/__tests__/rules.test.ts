import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
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
import type { MessageInput } from "../../db/messages"
import {
  getSenderStat,
  listSenderStats,
  setUserSenderClass,
} from "../../db/sender-stats"
import { recomputeThreadCaches, setThreadLabels } from "../../db/threads"
import { MissingSpecialFolderError } from "../../email-actions/thread-actions"
import { applyRuleActions, parseActionsJson } from "../actions"
import {
  createRule,
  deleteRule,
  listEnabledRules,
  listRules,
  updateRule,
} from "../db"
import {
  ingestionEventFromInput,
  recordSenderStats,
  runIngestionRules,
  type IngestionEvent,
} from "../ingestion"

/**
 * Rules plumbing (task 11, design D5): CRUD + deterministic ordering
 * (db.ts), the action compiler applying through the thread-actions service
 * with the queue ops landing in pending_operations (actions.ts), and the
 * ingestion hook running enabled rules per new message (ingestion.ts).
 * Runs against the real schema via the node:sqlite test executor.
 */

interface TestHarness {
  executor: TestExecutor
  accountId: string
}

describe("rules db", () => {
  let harness: TestHarness

  beforeEach(async () => {
    const executor = createTestExecutor()
    const accountId = await createAccount(executor, "gmail")
    harness = { executor, accountId }
  })

  afterEach(() => {
    harness.executor.close()
  })

  it("stores criteria as the {query} wrapper and actions as the JSON array", async () => {
    await createRule(harness.executor, {
      accountId: harness.accountId,
      name: "File newsletters",
      criteriaQuery: "from:news@x.com",
      actions: [{ type: "archive" }],
    })

    const [row] = await listRules(harness.executor, harness.accountId)
    expect(row?.name).toBe("File newsletters")
    expect(JSON.parse(row?.criteria_json ?? "")).toEqual({
      query: "from:news@x.com",
    })
    expect(JSON.parse(row?.actions_json ?? "")).toEqual([{ type: "archive" }])
    expect(row?.enabled).toBe(1)
  })

  it("lists rules by position, then creation order; enabled filter; update/delete", async () => {
    const late = await createRule(harness.executor, {
      accountId: harness.accountId,
      name: "late",
      criteriaQuery: "from:a@x.com",
      actions: [{ type: "archive" }],
      position: 5,
    })
    const first = await createRule(harness.executor, {
      accountId: harness.accountId,
      name: "first",
      criteriaQuery: "from:b@x.com",
      actions: [{ type: "star" }],
      position: 1,
    })
    const second = await createRule(harness.executor, {
      accountId: harness.accountId,
      name: "second",
      criteriaQuery: "from:c@x.com",
      actions: [{ type: "trash" }],
      position: 2,
    })
    const appended = await createRule(harness.executor, {
      accountId: harness.accountId,
      name: "appended",
      criteriaQuery: "from:d@x.com",
      actions: [{ type: "mark_read" }],
    })

    const all = await listRules(harness.executor, harness.accountId)
    expect(all.map((row) => row.name)).toEqual([
      "first",
      "second",
      "late",
      "appended",
    ])
    // appended got MAX(position) + 1
    expect(all[3]?.position).toBe(6)

    await updateRule(harness.executor, late, { enabled: false })
    const enabled = await listEnabledRules(harness.executor, harness.accountId)
    expect(enabled.map((row) => row.id)).toEqual([first, second, appended])
    expect(enabled).toHaveLength(3)

    await updateRule(harness.executor, first, {
      name: "renamed",
      criteriaQuery: "subject:hello",
      actions: [{ type: "add_labels", labels: ["News"] }],
      position: 9,
    })
    const renamedRow = (
      await listRules(harness.executor, harness.accountId)
    ).find((row) => row.id === first)
    expect(renamedRow).toMatchObject({
      name: "renamed",
      position: 9,
    })
    expect(JSON.parse(renamedRow?.criteria_json ?? "")).toEqual({
      query: "subject:hello",
    })
    expect(JSON.parse(renamedRow?.actions_json ?? "")).toEqual([
      { type: "add_labels", labels: ["News"] },
    ])

    await deleteRule(harness.executor, second)
    expect(await listRules(harness.executor, harness.accountId)).toHaveLength(3)
  })
})

describe("rule actions", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
  })

  afterEach(() => {
    executor.close()
  })

  async function pendingOps(): Promise<
    { op_type: string; payload_json: string }[]
  > {
    return executor.select(
      `SELECT op_type, payload_json FROM pending_operations
       WHERE account_id = $1 ORDER BY seq ASC`,
      [accountId]
    )
  }

  async function threadRow(threadId: string) {
    const rows = await executor.select<{
      is_archived: number
      is_trashed: number
      is_spam: number
      is_starred: number
      unread_count: number
    }>(
      "SELECT is_archived, is_trashed, is_spam, is_starred, unread_count FROM threads WHERE id = $1",
      [threadId]
    )
    return rows[0]
  }

  async function messageRow(messageId: string) {
    const rows = await executor.select<{
      is_read: number
      is_flagged: number
      imap_folder: string | null
    }>("SELECT is_read, is_flagged, imap_folder FROM messages WHERE id = $1", [
      messageId,
    ])
    return rows[0]
  }

  async function threadLabelIds(threadId: string): Promise<string[]> {
    const rows = await executor.select<{ label_id: string }>(
      "SELECT label_id FROM thread_labels WHERE thread_id = $1",
      [threadId]
    )
    return rows.map((row) => row.label_id)
  }

  /** A gmail thread in the Inbox (plus the local Trash role) with one
   * unread message; caches recomputed like the sync engine leaves them. */
  async function seedGmailThread() {
    const inboxId = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    await createGmailLabel(executor, accountId, "TRASH", "TRASH", "trash")
    const threadId = await createThread(executor, accountId, {
      subject: "Digest",
    })
    await setThreadLabels(executor, threadId, [inboxId])
    const messageId = await createMessage(executor, {
      threadId,
      accountId,
      date: 1000,
      fromAddress: "news@x.com",
      subject: "Digest",
      bodyText: "body",
      isRead: false,
      gmailMessageId: "gm-1",
    })
    await recomputeThreadCaches(executor, threadId)
    return { inboxId, threadId, messageId }
  }

  it("archive removes the inbox role locally and queues the archive op", async () => {
    const { threadId, messageId } = await seedGmailThread()

    const applied = await applyRuleActions(executor, accountId, threadId, [
      { type: "archive" },
    ])

    expect(applied).toEqual(["archive"])
    expect(await threadRow(threadId)).toMatchObject({
      is_archived: 1,
      unread_count: 1, // archive never touches read state
    })
    const ops = await pendingOps()
    expect(ops.map((op) => op.op_type)).toEqual(["archive"])
    const payload = JSON.parse(ops[0]?.payload_json ?? "{}") as {
      refs?: { providerMessageId?: string }[]
    }
    expect(payload.refs?.[0]?.providerMessageId).toBe("gm-1")
    expect(await messageRow(messageId)).toMatchObject({ is_read: 0 })
  })

  it("add_labels resolves label names (any case) and queues the provider ids", async () => {
    const { threadId } = await seedGmailThread()
    const newsId = await createGmailLabel(
      executor,
      accountId,
      "Newsletters",
      "Newsletters",
      undefined,
      "user"
    )

    const applied = await applyRuleActions(executor, accountId, threadId, [
      { type: "add_labels", labels: ["newsletters", "missing-label"] },
    ])

    expect(applied).toEqual(["add_labels"])
    expect(await threadLabelIds(threadId)).toEqual(
      expect.arrayContaining([newsId])
    )
    const ops = await pendingOps()
    expect(ops.map((op) => op.op_type)).toEqual(["add_labels"])
    expect(JSON.parse(ops[0]?.payload_json ?? "{}")).toMatchObject({
      labelIds: ["Newsletters"],
    })
  })

  it("add_labels with only unknown names applies nothing and queues nothing", async () => {
    const { threadId } = await seedGmailThread()

    const applied = await applyRuleActions(executor, accountId, threadId, [
      { type: "add_labels", labels: ["ghost"] },
    ])

    expect(applied).toEqual([])
    expect(await pendingOps()).toEqual([])
  })

  it("remove_labels drops the membership and queues the removal by provider id", async () => {
    const { threadId } = await seedGmailThread()
    const newsId = await createGmailLabel(
      executor,
      accountId,
      "Newsletters",
      "Newsletters",
      undefined,
      "user"
    )
    await setThreadLabels(executor, threadId, [newsId])

    const applied = await applyRuleActions(executor, accountId, threadId, [
      { type: "remove_labels", labels: ["newsletters", "missing-label"] },
    ])

    expect(applied).toEqual(["remove_labels"])
    expect(await threadLabelIds(threadId)).toEqual([])
    const ops = await pendingOps()
    expect(ops.map((op) => op.op_type)).toEqual(["remove_labels"])
    expect(JSON.parse(ops[0]?.payload_json ?? "{}")).toMatchObject({
      labelIds: ["Newsletters"],
    })
  })

  it("remove_labels with only unknown names applies nothing and queues nothing", async () => {
    const { threadId } = await seedGmailThread()

    const applied = await applyRuleActions(executor, accountId, threadId, [
      { type: "remove_labels", labels: ["ghost"] },
    ])

    expect(applied).toEqual([])
    expect(await pendingOps()).toEqual([])
  })

  it("mark_read flips the messages and the unread cache, queuing mark_read", async () => {
    const { threadId } = await seedGmailThread()

    const applied = await applyRuleActions(executor, accountId, threadId, [
      { type: "mark_read" },
    ])

    expect(applied).toEqual(["mark_read"])
    expect(await threadRow(threadId)).toMatchObject({ unread_count: 0 })
    expect(await pendingOps().then((ops) => ops.map((o) => o.op_type))).toEqual(
      ["mark_read"]
    )
  })

  it("star flags the messages and the thread cache, queuing star", async () => {
    const { threadId, messageId } = await seedGmailThread()

    const applied = await applyRuleActions(executor, accountId, threadId, [
      { type: "star" },
    ])

    expect(applied).toEqual(["star"])
    expect(await threadRow(threadId)).toMatchObject({ is_starred: 1 })
    expect(await messageRow(messageId)).toMatchObject({ is_flagged: 1 })
    expect(await pendingOps().then((ops) => ops.map((o) => o.op_type))).toEqual(
      ["star"]
    )
  })

  it("trash sets the trash cache and queues the trash op", async () => {
    const { threadId } = await seedGmailThread()

    const applied = await applyRuleActions(executor, accountId, threadId, [
      { type: "trash" },
    ])

    expect(applied).toEqual(["trash"])
    expect(await threadRow(threadId)).toMatchObject({ is_trashed: 1 })
    expect(await pendingOps().then((ops) => ops.map((o) => o.op_type))).toEqual(
      ["trash"]
    )
  })

  it("mark_as_spam sets the spam cache and queues the SPAM label op", async () => {
    await createGmailLabel(executor, accountId, "SPAM", "SPAM", "spam")
    const { threadId } = await seedGmailThread()

    const applied = await applyRuleActions(executor, accountId, threadId, [
      { type: "mark_as_spam" },
    ])

    // The same placement the toolbar's spam action takes: the SPAM label
    // row added locally, the provider-facing add_labels op queued.
    expect(applied).toEqual(["mark_as_spam"])
    expect(await threadRow(threadId)).toMatchObject({ is_spam: 1 })
    const ops = await pendingOps()
    expect(ops.map((op) => op.op_type)).toEqual(["add_labels"])
    expect(JSON.parse(ops[0]?.payload_json ?? "{}")).toMatchObject({
      labelIds: ["SPAM"],
    })
  })

  it("move on a gmail account is skipped (folders are an imap concept)", async () => {
    const { threadId } = await seedGmailThread()

    const applied = await applyRuleActions(executor, accountId, threadId, [
      { type: "move", folder: "Newsletters" },
    ])

    expect(applied).toEqual([])
    expect(await pendingOps()).toEqual([])
  })
})

describe("rule actions: imap move", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "imap")
  })

  afterEach(() => {
    executor.close()
  })

  async function pendingOps(): Promise<
    { op_type: string; payload_json: string }[]
  > {
    return executor.select(
      `SELECT op_type, payload_json FROM pending_operations
       WHERE account_id = $1 ORDER BY seq ASC`,
      [accountId]
    )
  }

  async function seedImapThread(): Promise<string> {
    const threadId = await createThread(executor, accountId, {
      subject: "Digest",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1000,
      fromAddress: "news@x.com",
      subject: "Digest",
      imapFolder: "INBOX",
      imapUid: 7,
    })
    return threadId
  }

  it("move rewrites the local folder, repoints the thread and queues the op", async () => {
    const folderId = await createImapFolderLabel(
      executor,
      accountId,
      "Newsletters"
    )
    const threadId = await seedImapThread()

    const applied = await applyRuleActions(executor, accountId, threadId, [
      { type: "move", folder: "Newsletters" },
    ])

    expect(applied).toEqual(["move"])
    const rows = await executor.select<{
      imap_folder: string | null
    }>("SELECT imap_folder FROM messages WHERE thread_id = $1", [threadId])
    expect(rows[0]?.imap_folder).toBe("Newsletters")
    const threads = await executor.select<{ folder_label_id: string | null }>(
      "SELECT folder_label_id FROM threads WHERE id = $1",
      [threadId]
    )
    expect(threads[0]?.folder_label_id).toBe(folderId)
    // The op addresses the SERVER-side location the message came from.
    const ops = await pendingOps()
    expect(ops.map((op) => op.op_type)).toEqual(["move"])
    expect(JSON.parse(ops[0]?.payload_json ?? "{}")).toMatchObject({
      destinationFolder: "Newsletters",
      refs: [{ folder: "INBOX", uid: 7 }],
    })
  })

  it("move to an unknown local folder still queues the server-side op", async () => {
    const threadId = await seedImapThread()

    const applied = await applyRuleActions(executor, accountId, threadId, [
      { type: "move", folder: "Remote/Only" },
    ])

    expect(applied).toEqual(["move"])
    const rows = await executor.select<{ imap_folder: string | null }>(
      "SELECT imap_folder FROM messages WHERE thread_id = $1",
      [threadId]
    )
    expect(rows[0]?.imap_folder).toBe("INBOX") // local state untouched
    expect(await pendingOps().then((ops) => ops.map((o) => o.op_type))).toEqual(
      ["move"]
    )
  })

  it("mark_as_spam moves the messages to the junk folder and queues the move op", async () => {
    await createImapFolderLabel(executor, accountId, "Junk", "spam")
    const threadId = await seedImapThread()

    const applied = await applyRuleActions(executor, accountId, threadId, [
      { type: "mark_as_spam" },
    ])

    expect(applied).toEqual(["mark_as_spam"])
    const rows = await executor.select<{ imap_folder: string | null }>(
      "SELECT imap_folder FROM messages WHERE thread_id = $1",
      [threadId]
    )
    expect(rows[0]?.imap_folder).toBe("Junk")
    const ops = await pendingOps()
    expect(ops.map((op) => op.op_type)).toEqual(["move"])
    expect(JSON.parse(ops[0]?.payload_json ?? "{}")).toMatchObject({
      destinationFolder: "Junk",
      refs: [{ folder: "INBOX", uid: 7 }],
    })
  })

  it("mark_as_spam without a spam-role folder throws (the hook isolates it)", async () => {
    const threadId = await seedImapThread()

    await expect(
      applyRuleActions(executor, accountId, threadId, [
        { type: "mark_as_spam" },
      ])
    ).rejects.toThrow(MissingSpecialFolderError)
    expect(await pendingOps()).toEqual([])
  })
})

describe("action JSON tolerance", () => {
  it("parses the known vocabulary and skips junk entries", () => {
    expect(
      parseActionsJson(
        JSON.stringify([
          { type: "archive" },
          { type: "nope" },
          { type: "add_labels", labels: ["A"] },
          { type: "add_labels", labels: "not-an-array" },
          { type: "move", folder: "X" },
          { type: "move" },
          { type: "star" },
          { type: "mark_as_spam" },
          "garbage",
        ])
      )
    ).toEqual([
      { type: "archive" },
      { type: "add_labels", labels: ["A"] },
      { type: "move", folder: "X" },
      { type: "star" },
      { type: "mark_as_spam" },
    ])
    expect(parseActionsJson("not json")).toEqual([])
    expect(parseActionsJson('{"type":"archive"}')).toEqual([])
  })
})

describe("ingestion hook", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
  })

  afterEach(() => {
    executor.close()
  })

  function buildEvent(
    overrides: Partial<IngestionEvent> & { messageRowId: string }
  ): IngestionEvent {
    return {
      threadId: "thread-1",
      fromAddress: "news@x.com",
      fromName: null,
      toJson: null,
      ccJson: null,
      bccJson: null,
      subject: "Digest",
      date: 1000,
      snippet: "weekly digest",
      labelNames: ["INBOX"],
      isRead: false,
      isStarred: false,
      hasAttachments: false,
      threadHasUserMessage: false,
      isMailingList: false,
      sizeEstimate: null,
      ...overrides,
    }
  }

  async function seedLabelledThread() {
    const inboxId = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const newsId = await createGmailLabel(
      executor,
      accountId,
      "Newsletters",
      "Newsletters",
      undefined,
      "user"
    )
    const threadId = await createThread(executor, accountId, {
      subject: "Digest",
    })
    await setThreadLabels(executor, threadId, [inboxId])
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1000,
      fromAddress: "news@x.com",
      subject: "Digest",
      gmailMessageId: "gm-1",
    })
    return { inboxId, newsId, threadId }
  }

  it("applies ALL matching rules in position order (label then archive)", async () => {
    const { newsId, threadId } = await seedLabelledThread()
    await createRule(executor, {
      accountId,
      name: "label it",
      criteriaQuery: "from:news@x.com",
      actions: [{ type: "add_labels", labels: ["Newsletters"] }],
      position: 0,
    })
    await createRule(executor, {
      accountId,
      name: "archive it",
      criteriaQuery: "from:news@x.com",
      actions: [{ type: "archive" }],
      position: 1,
    })

    const outcomes = await runIngestionRules(executor, accountId, [
      buildEvent({ messageRowId: "m1", threadId }),
    ])

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({
      messageRowId: "m1",
      threadId,
      suppressesNotification: true, // archive rules the mail away
    })
    expect(outcomes[0]?.appliedActions).toEqual(["add_labels", "archive"])
    const membership = await executor.select<{ label_id: string }>(
      "SELECT label_id FROM thread_labels WHERE thread_id = $1",
      [threadId]
    )
    expect(membership.map((row) => row.label_id)).toEqual([newsId]) // inbox gone, label stuck
    const threads = await executor.select<{ is_archived: number }>(
      "SELECT is_archived FROM threads WHERE id = $1",
      [threadId]
    )
    expect(threads[0]?.is_archived).toBe(1)
  })

  it("position decides the order, and the final state reflects every rule", async () => {
    const { threadId } = await seedLabelledThread()
    await createRule(executor, {
      accountId,
      name: "archive first",
      criteriaQuery: "from:news@x.com",
      actions: [{ type: "archive" }],
      position: 0,
    })
    await createRule(executor, {
      accountId,
      name: "label second",
      criteriaQuery: "from:news@x.com",
      actions: [{ type: "add_labels", labels: ["Newsletters"] }],
      position: 9,
    })

    const outcomes = await runIngestionRules(executor, accountId, [
      buildEvent({ messageRowId: "m1", threadId }),
    ])

    expect(outcomes[0]?.appliedActions).toEqual(["archive", "add_labels"])
    // The later labeling rebuilds the caches from [Newsletters]: still out
    // of the inbox, now carrying the label.
    const threads = await executor.select<{ is_archived: number }>(
      "SELECT is_archived FROM threads WHERE id = $1",
      [threadId]
    )
    expect(threads[0]?.is_archived).toBe(1)
    expect(
      await executor
        .select<{ name: string }>(
          `SELECT l.name FROM thread_labels tl JOIN labels l ON l.id = tl.label_id
           WHERE tl.thread_id = $1`,
          [threadId]
        )
        .then((rows) => rows.map((row) => row.name))
    ).toEqual(["Newsletters"])
  })

  it("skips disabled rules and non-matching events; additive actions keep mail notifying", async () => {
    const { threadId } = await seedLabelledThread()
    await createRule(executor, {
      accountId,
      name: "disabled",
      criteriaQuery: "from:news@x.com",
      actions: [{ type: "archive" }],
      enabled: false,
    })
    await createRule(executor, {
      accountId,
      name: "star matching",
      criteriaQuery: "from:news@x.com",
      actions: [{ type: "star" }],
      position: 1,
    })

    const outcomes = await runIngestionRules(executor, accountId, [
      buildEvent({ messageRowId: "m1", threadId }),
      buildEvent({
        messageRowId: "m2",
        threadId,
        fromAddress: "other@x.com",
      }),
    ])

    // Outcomes come back in event order; only the matching event acted.
    expect(outcomes.map((outcome) => outcome.messageRowId)).toEqual([
      "m1",
      "m2",
    ])
    expect(outcomes[0]?.appliedActions).toEqual(["star"])
    expect(outcomes[0]?.suppressesNotification).toBe(false) // additive
    expect(outcomes[1]?.appliedActions).toEqual([])
    expect(outcomes[1]?.suppressesNotification).toBe(false)
  })

  it("criteria see the message AS IT ARRIVED (a mark_read rule does not hide is:unread)", async () => {
    const { threadId } = await seedLabelledThread()
    await createRule(executor, {
      accountId,
      name: "read it",
      criteriaQuery: "from:news@x.com",
      actions: [{ type: "mark_read" }],
      position: 0,
    })
    await createRule(executor, {
      accountId,
      name: "unread matcher",
      criteriaQuery: "is:unread",
      actions: [{ type: "star" }],
      position: 1,
    })

    const outcomes = await runIngestionRules(executor, accountId, [
      buildEvent({ messageRowId: "m1", threadId }), // arrived unread
    ])

    expect(outcomes[0]?.appliedActions).toEqual(["mark_read", "star"])
    expect(outcomes[0]?.suppressesNotification).toBe(true) // mark_read wins
  })

  it("a mark_as_spam rule files the thread into spam and rules the mail away", async () => {
    await createGmailLabel(executor, accountId, "SPAM", "SPAM", "spam")
    const { threadId } = await seedLabelledThread()
    await createRule(executor, {
      accountId,
      name: "spam it",
      criteriaQuery: "from:winner@lottery.example",
      actions: [{ type: "mark_as_spam" }],
    })

    const outcomes = await runIngestionRules(executor, accountId, [
      buildEvent({
        messageRowId: "m1",
        threadId,
        fromAddress: "winner@lottery.example",
      }),
    ])

    expect(outcomes[0]).toMatchObject({
      appliedActions: ["mark_as_spam"],
      suppressesNotification: true, // ruled-away mail never notifies
    })
    const threads = await executor.select<{ is_spam: number }>(
      "SELECT is_spam FROM threads WHERE id = $1",
      [threadId]
    )
    expect(threads[0]?.is_spam).toBe(1)
  })

  it("isolates a failing rule per event and still runs the rules after it", async () => {
    // Thread A's message has no gmail provider id: every thread-action's
    // ref building throws MissingProviderRefError for it. Thread B is
    // healthy. The failure on A must stay contained; the same rules must
    // still apply to B (and rule 2 must run after rule 1 failed on A).
    const inboxA = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const threadA = await createThread(executor, accountId, { subject: "Odd" })
    await setThreadLabels(executor, threadA, [inboxA])
    await createMessage(executor, {
      threadId: threadA,
      accountId,
      date: 1000,
      fromAddress: "news@x.com",
      subject: "Odd",
      // no gmailMessageId on purpose
    })

    const newsId = await createGmailLabel(
      executor,
      accountId,
      "Newsletters",
      "Newsletters",
      undefined,
      "user"
    )
    const threadB = await createThread(executor, accountId, { subject: "Fine" })
    await setThreadLabels(executor, threadB, [inboxA])
    await createMessage(executor, {
      threadId: threadB,
      accountId,
      date: 2000,
      fromAddress: "news@x.com",
      subject: "Fine",
      gmailMessageId: "gm-2",
    })

    await createRule(executor, {
      accountId,
      name: "explodes on A",
      criteriaQuery: "from:news@x.com",
      actions: [{ type: "archive" }],
      position: 0,
    })
    await createRule(executor, {
      accountId,
      name: "still runs",
      criteriaQuery: "from:news@x.com",
      actions: [{ type: "add_labels", labels: ["Newsletters"] }],
      position: 1,
    })

    const outcomes = await runIngestionRules(executor, accountId, [
      buildEvent({ messageRowId: "m1", threadId: threadA }),
      buildEvent({ messageRowId: "m2", threadId: threadB }),
    ])

    expect(outcomes[0]?.appliedActions).toEqual([]) // contained
    expect(outcomes[0]?.suppressesNotification).toBe(false)
    expect(outcomes[1]?.appliedActions).toEqual(["archive", "add_labels"])
    expect(outcomes[1]?.suppressesNotification).toBe(true)
    expect(
      await executor
        .select<{ label_id: string }>(
          "SELECT label_id FROM thread_labels WHERE thread_id = $1",
          [threadB]
        )
        .then((rows) => rows.map((row) => row.label_id))
    ).toEqual([newsId])
  })

  it("projects a MessageInput onto the event shape", () => {
    const input: MessageInput = {
      id: "m-row",
      threadId: "t-row",
      accountId,
      date: 5,
      fromAddress: "a@x.com",
      fromName: "A",
      to: [{ email: "me@x.com" }],
      subject: "Hi",
      snippet: "body",
      isRead: true,
      isFlagged: true,
      hasAttachments: true,
      sizeEstimate: 4096,
    }
    expect(ingestionEventFromInput(input, ["INBOX"])).toEqual({
      messageRowId: "m-row",
      threadId: "t-row",
      fromAddress: "a@x.com",
      fromName: "A",
      toJson: JSON.stringify([{ email: "me@x.com" }]),
      ccJson: null,
      bccJson: null,
      subject: "Hi",
      date: 5,
      snippet: "body",
      labelNames: ["INBOX"],
      isRead: true,
      isStarred: true,
      hasAttachments: true,
      sizeEstimate: 4096,
      threadHasUserMessage: false,
      isMailingList: false,
    })
  })
})

/**
 * The sender-stats consumer (task 13.1, design D7): every event with a
 * From address accumulates its sender's row — reply = Re: subject OR the
 * engine-stamped thread-participation flag, direct-to-me = the account's
 * own address among to/cc, list = the engine-stamped provider signal.
 */
describe("sender stats consumer", () => {
  let executor: TestExecutor
  let accountId: string
  const me = "me@example.com"

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
  })

  afterEach(() => {
    executor.close()
  })

  function buildEvent(
    overrides: Partial<IngestionEvent> & { messageRowId: string }
  ): IngestionEvent {
    return {
      threadId: "thread-1",
      fromAddress: "news@x.com",
      fromName: null,
      toJson: null,
      ccJson: null,
      bccJson: null,
      subject: "Digest",
      date: 1000,
      snippet: null,
      labelNames: ["INBOX"],
      isRead: false,
      isStarred: false,
      hasAttachments: false,
      threadHasUserMessage: false,
      isMailingList: false,
      sizeEstimate: null,
      ...overrides,
    }
  }

  it("accumulates reply/direct/list flags into the sender's row", async () => {
    await recordSenderStats(executor, accountId, me, [
      buildEvent({
        messageRowId: "m1",
        fromAddress: "Alice@X.com",
        subject: "Re: planning",
        toJson: JSON.stringify([{ email: me }]),
        date: 2000,
      }),
    ])

    expect(
      await getSenderStat(executor, accountId, "alice@x.com")
    ).toMatchObject({
      sender: "alice@x.com", // lowercased key
      reply_count: 1, // Re: subject
      direct_to_me_count: 1, // to: me
      last_message_at: 2000,
      is_mailing_list: 0,
    })
  })

  it("counts thread participation as a reply even without a Re: subject", async () => {
    await recordSenderStats(executor, accountId, me, [
      buildEvent({
        messageRowId: "m1",
        fromAddress: "peer@x.com",
        subject: "Follow-up",
        threadHasUserMessage: true, // stamped engine-side
      }),
    ])
    expect(
      await getSenderStat(executor, accountId, "peer@x.com")
    ).toMatchObject({ reply_count: 1, direct_to_me_count: 0 })
  })

  it("recognizes the account address in cc and across cases", async () => {
    await recordSenderStats(executor, accountId, me, [
      buildEvent({
        messageRowId: "m1",
        fromAddress: "a@x.com",
        ccJson: JSON.stringify([{ name: "Me", email: "ME@example.com" }]),
      }),
      buildEvent({
        messageRowId: "m2",
        fromAddress: "b@x.com",
        ccJson: JSON.stringify([{ email: "someone-else@x.com" }]),
        toJson: JSON.stringify([{ email: "other@x.com" }]),
      }),
    ])
    expect(await getSenderStat(executor, accountId, "a@x.com")).toMatchObject({
      direct_to_me_count: 1,
    })
    expect(await getSenderStat(executor, accountId, "b@x.com")).toMatchObject({
      direct_to_me_count: 0,
    })
  })

  it("OR-accumulates the list marker and stacks counts across passes", async () => {
    await recordSenderStats(executor, accountId, me, [
      buildEvent({
        messageRowId: "m1",
        fromAddress: "news@x.com",
        isMailingList: true,
        date: 100,
      }),
    ])
    await recordSenderStats(executor, accountId, me, [
      buildEvent({
        messageRowId: "m2",
        fromAddress: "news@x.com",
        subject: "Re: Digest",
        date: 200,
      }),
    ])

    expect(
      await getSenderStat(executor, accountId, "news@x.com")
    ).toMatchObject({
      reply_count: 1,
      is_mailing_list: 1, // stuck from the first pass
      last_message_at: 200,
    })
  })

  it("skips events without a From address and never touches overrides", async () => {
    await setUserSenderClass(executor, accountId, "news@x.com", "important")
    await recordSenderStats(executor, accountId, me, [
      buildEvent({ messageRowId: "m1", fromAddress: null }),
      buildEvent({ messageRowId: "m2" }),
    ])

    const row = await getSenderStat(executor, accountId, "news@x.com")
    expect(row).toMatchObject({
      user_class: "important",
      reply_count: 0, // the from-less event contributed nothing
    })
    expect(await listSenderStats(executor, null)).toHaveLength(1)
  })
})
