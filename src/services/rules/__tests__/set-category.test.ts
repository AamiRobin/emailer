import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createAccount, createMessage, createThread } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { createRule } from "../db"
import { applyRuleActions, parseActionsJson } from "../actions"
import { runIngestionRules, type IngestionEvent } from "../ingestion"

/**
 * The set_category rule action (task 3.4, design D4): a user rule can name
 * one of the five inbox categories. The delivery-time executor IGNORES it
 * (categorization is a separate ingestion-hook consumer, not a delivery
 * action — it never lands in appliedActions and never suppresses the
 * announcement); the hook itself stamps the first matching rule's category
 * onto the event for the categorization pass (rules/ingestion.ts →
 * categorization/ingestion.ts). Parser tolerance mirrors the other action
 * types.
 */

let executor: TestExecutor
let accountId: string
let warn: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  executor = createTestExecutor()
  accountId = await createAccount(executor, "gmail")
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  executor.close()
})

function buildEvent(
  overrides: Partial<IngestionEvent> & { messageRowId: string; threadId: string }
): IngestionEvent {
  return {
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
    headers: {},
    sizeEstimate: null,
    ...overrides,
  }
}

describe("set_category parsing", () => {
  it("parses a valid category and skips unknown/missing ones", () => {
    expect(
      parseActionsJson(
        JSON.stringify([
          { type: "set_category", category: "promotions" },
          { type: "set_category", category: "inbox" }, // not a category
          { type: "set_category" }, // no category
          { type: "archive" },
        ])
      )
    ).toEqual([
      { type: "set_category", category: "promotions" },
      { type: "archive" },
    ])
    expect(warn).toHaveBeenCalled()
  })
})

describe("set_category at delivery time", () => {
  it("is ignored by the executor: no applied actions, no queue ops", async () => {
    const threadId = await createThread(executor, accountId, {
      subject: "Digest",
    })

    const applied = await applyRuleActions(executor, accountId, threadId, [
      { type: "set_category", category: "promotions" },
    ])

    expect(applied).toEqual([])
    const ops = await executor.select(
      "SELECT op_type FROM pending_operations WHERE account_id = $1",
      [accountId]
    )
    expect(ops).toEqual([])
    // The thread row was not touched either — categorization owns that.
    const rows = await executor.select<{ category: string | null }>(
      "SELECT category FROM threads WHERE id = $1",
      [threadId]
    )
    expect(rows[0]?.category ?? null).toBeNull()
  })
})

describe("set_category ingestion stamping", () => {
  it("stamps the first matching rule's category on the event", async () => {
    const threadId = await createThread(executor, accountId, { subject: "D" })
    await createRule(executor, {
      accountId,
      name: "categorize",
      criteriaQuery: "from:news@x.com",
      actions: [{ type: "set_category", category: "promotions" }],
      position: 0,
    })
    await createRule(executor, {
      accountId,
      name: "later rule loses",
      criteriaQuery: "from:news@x.com",
      actions: [{ type: "set_category", category: "social" }],
      position: 1,
    })

    const event = buildEvent({ messageRowId: "m1", threadId })
    const outcomes = await runIngestionRules(executor, accountId, [event])

    expect(event.ruleCategory).toBe("promotions")
    // Not a delivery action: nothing applied, mail still announces.
    expect(outcomes[0]?.appliedActions).toEqual([])
    expect(outcomes[0]?.suppressesNotification).toBe(false)
  })

  it("does not stamp when the rule does not match or is disabled", async () => {
    const threadId = await createThread(executor, accountId, { subject: "D" })
    await createRule(executor, {
      accountId,
      name: "disabled",
      criteriaQuery: "from:news@x.com",
      actions: [{ type: "set_category", category: "promotions" }],
      enabled: false,
    })
    await createRule(executor, {
      accountId,
      name: "other sender",
      criteriaQuery: "from:other@x.com",
      actions: [{ type: "set_category", category: "social" }],
    })

    const event = buildEvent({ messageRowId: "m1", threadId })
    await runIngestionRules(executor, accountId, [event])

    expect(event.ruleCategory).toBeUndefined()
  })

  it("stamps before applying so a failing delivery action keeps the category", async () => {
    // The message has no gmail provider id: thread-actions' ref building
    // throws MissingProviderRefError for the archive — the hook isolates
    // it per rule, and the category stamp must survive that failure.
    const threadId = await createThread(executor, accountId, { subject: "D" })
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1000,
      fromAddress: "news@x.com",
      subject: "Digest",
      // no gmailMessageId on purpose
    })
    await createRule(executor, {
      accountId,
      name: "archive then categorize",
      criteriaQuery: "from:news@x.com",
      actions: [
        { type: "archive" },
        { type: "set_category", category: "newsletters" },
      ],
    })

    const event = buildEvent({ messageRowId: "m1", threadId })
    const outcomes = await runIngestionRules(executor, accountId, [event])

    expect(event.ruleCategory).toBe("newsletters")
    expect(outcomes[0]?.appliedActions).toEqual([]) // archive failed, isolated
  })

  it("does not touch the pre-existing stamp of an event that carried one", async () => {
    // Defensive shape: an event that already carries a stamp (not produced
    // by this codebase's engines) is left alone.
    const threadId = await createThread(executor, accountId, { subject: "D" })
    await createRule(executor, {
      accountId,
      name: "categorize",
      criteriaQuery: "from:news@x.com",
      actions: [{ type: "set_category", category: "promotions" }],
    })

    const event = buildEvent({
      messageRowId: "m1",
      threadId,
      ruleCategory: "updates",
    })
    await runIngestionRules(executor, accountId, [event])

    expect(event.ruleCategory).toBe("updates")
  })
})
