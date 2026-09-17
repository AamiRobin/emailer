import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
import { ThreadNotFoundError } from "../../email-actions/thread-actions"
import { recomputeThreadCaches, setThreadLabels } from "../../db/threads"
import type { RuleAction } from "../actions"
import { createRule, getRule, type RuleRow } from "../db"
import {
  applyRuleNow,
  countMatchingThreads,
  RuleNotConfirmedError,
} from "../apply-now"

/**
 * "Apply now" (task 11.4, design D5): thread-level matching over STORED
 * mail through the search SQL compiler, the literal `confirmed: true`
 * gate in front of the destructive apply, and the {matched, applied}
 * result summary. Runs against the real schema via the node:sqlite test
 * executor; the actions land through the real thread-actions service, so
 * the queue-op assertions read pending_operations.
 *
 * One deliberate seam: applyRuleActions is wrapped in a pass-through spy
 * so the mid-run drift test can simulate a matched thread vanishing
 * between the match query and the apply loop (the window a competing sync
 * would race for) — every other test runs the real compiler end to end.
 */

const actionMocks = vi.hoisted(() => ({
  realApplyRuleActions: null as
    null | (typeof import("../actions"))["applyRuleActions"],
}))

vi.mock("../actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../actions")>()
  actionMocks.realApplyRuleActions = actual.applyRuleActions
  return {
    ...actual,
    applyRuleActions: vi.fn(actual.applyRuleActions),
  }
})

const applyRuleActionsMock = vi.mocked(
  (await import("../actions")).applyRuleActions
)

interface Harness {
  executor: TestExecutor
  accountId: string
  otherAccountId: string
  inboxId: string
  trashId: string
  newslettersId: string
}

describe("apply now (task 11.4)", () => {
  let h: Harness

  beforeEach(async () => {
    const executor = createTestExecutor()
    const accountId = await createAccount(executor, "gmail")
    const otherAccountId = await createAccount(executor, "gmail")
    const inboxId = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const trashId = await createGmailLabel(
      executor,
      accountId,
      "TRASH",
      "TRASH",
      "trash"
    )
    const newslettersId = await createGmailLabel(
      executor,
      accountId,
      "Newsletters",
      "Newsletters",
      undefined,
      "user"
    )
    h = { executor, accountId, otherAccountId, inboxId, trashId, newslettersId }
  })

  afterEach(() => {
    applyRuleActionsMock.mockReset()
    h.executor.close()
  })

  /** A gmail inbox thread with one unread message, caches recomputed like
   * the sync engine leaves them (rules act on this state). */
  async function seedInboxThread(options: {
    subject: string
    fromAddress: string
    date: number
    labelIds?: string[]
    isRead?: boolean
  }): Promise<string> {
    const threadId = await createThread(h.executor, h.accountId, {
      subject: options.subject,
    })
    await setThreadLabels(h.executor, threadId, options.labelIds ?? [h.inboxId])
    await createMessage(h.executor, {
      threadId,
      accountId: h.accountId,
      date: options.date,
      fromAddress: options.fromAddress,
      subject: options.subject,
      snippet: options.subject,
      bodyText: "body",
      isRead: options.isRead,
      gmailMessageId: `gm-${options.date}`,
    })
    await recomputeThreadCaches(h.executor, threadId)
    return threadId
  }

  async function createRuleRow(input: {
    criteriaQuery: string
    actions: RuleAction[]
  }): Promise<RuleRow> {
    const ruleId = await createRule(h.executor, {
      accountId: h.accountId,
      name: "test rule",
      criteriaQuery: input.criteriaQuery,
      actions: input.actions,
    })
    const rule = await getRule(h.executor, ruleId)
    if (!rule) throw new Error("rule row missing after insert")
    return rule
  }

  async function pendingOps(): Promise<{ op_type: string }[]> {
    return h.executor.select(
      `SELECT op_type FROM pending_operations
       WHERE account_id = $1 ORDER BY seq ASC`,
      [h.accountId]
    )
  }

  async function threadRow(threadId: string) {
    const rows = await h.executor.select<{
      is_archived: number
      is_trashed: number
      unread_count: number
    }>(
      "SELECT is_archived, is_trashed, unread_count FROM threads WHERE id = $1",
      [threadId]
    )
    return rows[0]
  }

  describe("countMatchingThreads", () => {
    it("counts the account's matching threads like search would", async () => {
      await seedInboxThread({
        subject: "Digest one",
        fromAddress: "news@x.com",
        date: 100,
      })
      await seedInboxThread({
        subject: "Digest two",
        fromAddress: "news@x.com",
        date: 200,
        labelIds: [h.inboxId, h.newslettersId],
      })
      await seedInboxThread({
        subject: "Personal",
        fromAddress: "friend@x.com",
        date: 300,
      })
      // Matching but trashed → outside the search scope, not counted.
      await seedInboxThread({
        subject: "Digest trashed",
        fromAddress: "news@x.com",
        date: 400,
        labelIds: [h.trashId],
      })
      // Matching but on another account → not this rule's account.
      const otherThread = await createThread(h.executor, h.otherAccountId, {
        subject: "Other account digest",
      })
      await createMessage(h.executor, {
        threadId: otherThread,
        accountId: h.otherAccountId,
        date: 500,
        fromAddress: "news@x.com",
        subject: "Other account digest",
      })

      const criteria = JSON.stringify({ query: "from:news@x.com" })
      expect(
        await countMatchingThreads(h.executor, h.accountId, criteria)
      ).toBe(2)

      // Operator variety rides the same query-builder: label leaf matching,
      // flag operators over the thread caches, AND-composition.
      expect(
        await countMatchingThreads(
          h.executor,
          h.accountId,
          JSON.stringify({ query: "label:newsletters" })
        )
      ).toBe(1)
      expect(
        await countMatchingThreads(
          h.executor,
          h.accountId,
          JSON.stringify({ query: "is:unread" })
        )
      ).toBe(3)
      expect(
        await countMatchingThreads(
          h.executor,
          h.accountId,
          JSON.stringify({ query: "is:unread label:newsletters" })
        )
      ).toBe(1)
    })

    it("counts 0 for criteria that parse to nothing", async () => {
      await seedInboxThread({
        subject: "Digest",
        fromAddress: "news@x.com",
        date: 100,
      })
      expect(
        await countMatchingThreads(
          h.executor,
          h.accountId,
          JSON.stringify({ query: "" })
        )
      ).toBe(0)
      expect(
        await countMatchingThreads(h.executor, h.accountId, "not json")
      ).toBe(0)
    })
  })

  describe("applyRuleNow", () => {
    it("refuses without confirmed:true and changes nothing", async () => {
      const threadId = await seedInboxThread({
        subject: "Digest",
        fromAddress: "news@x.com",
        date: 100,
      })
      const rule = await createRuleRow({
        criteriaQuery: "from:news@x.com",
        actions: [{ type: "archive" }],
      })

      await expect(
        applyRuleNow(h.executor, h.accountId, rule, { confirmed: false })
      ).rejects.toBeInstanceOf(RuleNotConfirmedError)

      // The refusal is total: no local effect, no queued ops.
      expect(await threadRow(threadId)).toMatchObject({
        is_archived: 0,
        unread_count: 1,
      })
      expect(await pendingOps()).toEqual([])
    })

    it("applies the actions to exactly the matched threads and reports counts", async () => {
      const matchedA = await seedInboxThread({
        subject: "Digest one",
        fromAddress: "news@x.com",
        date: 100,
      })
      const matchedB = await seedInboxThread({
        subject: "Digest two",
        fromAddress: "news@x.com",
        date: 200,
      })
      const untouched = await seedInboxThread({
        subject: "Personal",
        fromAddress: "friend@x.com",
        date: 300,
      })
      const rule = await createRuleRow({
        criteriaQuery: "from:news@x.com",
        actions: [{ type: "archive" }, { type: "mark_read" }],
      })

      const result = await applyRuleNow(h.executor, h.accountId, rule, {
        confirmed: true,
      })

      expect(result).toEqual({ matched: 2, applied: 2 })
      for (const threadId of [matchedA, matchedB]) {
        expect(await threadRow(threadId)).toMatchObject({
          is_archived: 1,
          unread_count: 0,
        })
      }
      // The non-matching thread is untouched in state and queue.
      expect(await threadRow(untouched)).toMatchObject({
        is_archived: 0,
        unread_count: 1,
      })
      expect((await pendingOps()).map((op) => op.op_type)).toEqual([
        "archive",
        "mark_read",
        "archive",
        "mark_read",
      ])
    })

    it("re-counts at apply time: a thread deleted after the dialog's count is simply not matched", async () => {
      const kept = await seedInboxThread({
        subject: "Digest one",
        fromAddress: "news@x.com",
        date: 100,
      })
      const deleted = await seedInboxThread({
        subject: "Digest two",
        fromAddress: "news@x.com",
        date: 200,
      })
      const rule = await createRuleRow({
        criteriaQuery: "from:news@x.com",
        actions: [{ type: "archive" }],
      })

      // The dialog's count (state before the drift)…
      expect(
        await countMatchingThreads(h.executor, h.accountId, rule.criteria_json)
      ).toBe(2)
      // …then a competing sync removes the thread…
      await h.executor.execute("DELETE FROM threads WHERE id = $1", [deleted])
      // …and the apply reports the apply-time truth, not the stale count.
      const result = await applyRuleNow(h.executor, h.accountId, rule, {
        confirmed: true,
      })

      expect(result).toEqual({ matched: 1, applied: 1 })
      expect(await threadRow(kept)).toMatchObject({ is_archived: 1 })
      expect((await pendingOps()).map((op) => op.op_type)).toEqual(["archive"])
    })

    it("a matched thread that fails mid-run is skipped without aborting the rest", async () => {
      const healthy = await seedInboxThread({
        subject: "Digest one",
        fromAddress: "news@x.com",
        date: 100,
      })
      const doomed = await seedInboxThread({
        subject: "Digest two",
        fromAddress: "news@x.com",
        date: 200,
      })
      const rule = await createRuleRow({
        criteriaQuery: "from:news@x.com",
        actions: [{ type: "archive" }],
      })

      // Simulate the doomed thread vanishing between the match query and
      // the loop reaching it: the real apply would throw the same
      // ThreadNotFoundError a deleted row produces.
      const realApply = actionMocks.realApplyRuleActions!
      applyRuleActionsMock.mockImplementation(
        async (executor, accountId, threadId, actions) => {
          if (threadId === doomed) throw new ThreadNotFoundError(threadId)
          return realApply(executor, accountId, threadId, actions)
        }
      )

      const result = await applyRuleNow(h.executor, h.accountId, rule, {
        confirmed: true,
      })

      // matched still counts what matched; applied only what succeeded.
      expect(result).toEqual({ matched: 2, applied: 1 })
      expect(await threadRow(healthy)).toMatchObject({ is_archived: 1 })
      expect(await threadRow(doomed)).toMatchObject({ is_archived: 0 })
      expect((await pendingOps()).map((op) => op.op_type)).toEqual(["archive"])
    })
  })
})
