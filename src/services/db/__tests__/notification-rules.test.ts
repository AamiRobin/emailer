import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount } from "./fixtures"
import { createTestExecutor, type TestExecutor } from "./test-executor"
import type { NotificationRuleRow } from "../notification-rules"
import {
  addNotificationRule,
  listNotificationRules,
  removeNotificationRule,
  resolveNotificationDecision,
} from "../notification-rules"

function rule(
  overrides: Partial<NotificationRuleRow> & {
    match_type: NotificationRuleRow["match_type"]
    match_value: string
    action: NotificationRuleRow["action"]
  }
): NotificationRuleRow {
  return {
    id: `rule-${overrides.match_value}`,
    account_id: "acc-1",
    created_at: 1,
    ...overrides,
  }
}

describe("notification rule queries", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
  })

  afterEach(() => {
    executor.close()
  })

  it("adds a rule with a generated id and lists it per account", async () => {
    const id = await addNotificationRule(executor, {
      accountId,
      matchType: "sender",
      matchValue: "newsletter@x.com",
      action: "never",
    })

    expect(id).toBeTruthy()
    const rows = await listNotificationRules(executor, accountId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id,
      account_id: accountId,
      match_type: "sender",
      match_value: "newsletter@x.com",
      action: "never",
    })
    expect(typeof rows[0]!.created_at).toBe("number")
  })

  it("scopes rules to their account and orders them deterministically", async () => {
    const otherAccount = await createAccount(executor, "imap")
    await addNotificationRule(executor, {
      accountId,
      matchType: "sender",
      matchValue: "a@x.com",
      action: "never",
    })
    await addNotificationRule(executor, {
      accountId,
      matchType: "label",
      matchValue: "Receipts",
      action: "always",
    })
    await addNotificationRule(executor, {
      accountId: otherAccount,
      matchType: "sender",
      matchValue: "a@x.com",
      action: "never",
    })

    const mine = await listNotificationRules(executor, accountId)
    expect(mine).toHaveLength(2)
    // (created_at, id) order — deterministic even when both rules land in
    // the same unixepoch second (the uuid breaks that tie, so insertion
    // order is NOT guaranteed within one second).
    const expected = [...mine]
      .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1))
      .map((row) => row.id)
    expect(mine.map((row) => row.id)).toEqual(expected)
    expect(await listNotificationRules(executor, otherAccount)).toHaveLength(1)
  })

  it("rejects an exact duplicate (same account, match type and value)", async () => {
    await addNotificationRule(executor, {
      accountId,
      matchType: "sender",
      matchValue: "a@x.com",
      action: "never",
    })

    await expect(
      addNotificationRule(executor, {
        accountId,
        matchType: "sender",
        matchValue: "a@x.com",
        action: "always",
      })
    ).rejects.toThrow()
  })

  it("deletes a rule; deleting an unknown id is a no-op", async () => {
    const id = await addNotificationRule(executor, {
      accountId,
      matchType: "label",
      matchValue: "News",
      action: "never",
    })

    await removeNotificationRule(executor, id)
    expect(await listNotificationRules(executor, accountId)).toHaveLength(0)

    await removeNotificationRule(executor, "missing-id")
    expect(await listNotificationRules(executor, accountId)).toHaveLength(0)
  })
})

describe("resolveNotificationDecision", () => {
  it("notifies when no rule matches (plain account behavior)", () => {
    const rules = [
      rule({
        match_type: "sender",
        match_value: "news@x.com",
        action: "never",
      }),
    ]
    expect(resolveNotificationDecision(rules, "boss@x.com", ["INBOX"])).toBe(
      "notify"
    )
    expect(resolveNotificationDecision([], "news@x.com", null)).toBe("notify")
  })

  it("suppresses on a never-sender match, case-insensitively", () => {
    const rules = [
      rule({
        match_type: "sender",
        match_value: "Newsletter@X.com",
        action: "never",
      }),
    ]
    expect(resolveNotificationDecision(rules, "newsletter@x.com", null)).toBe(
      "suppress"
    )
    expect(resolveNotificationDecision(rules, "NEWSLETTER@x.COM", null)).toBe(
      "suppress"
    )
  })

  it("keeps an always-sender counted — the VIP rule never suppresses", () => {
    const rules = [
      rule({
        match_type: "sender",
        match_value: "boss@x.com",
        action: "always",
      }),
    ]
    expect(resolveNotificationDecision(rules, "boss@x.com", null)).toBe(
      "notify"
    )
    // A never rule for a DIFFERENT sender does not affect the VIP either.
    const mixed = [
      ...rules,
      rule({
        match_type: "sender",
        match_value: "news@x.com",
        action: "never",
      }),
    ]
    expect(resolveNotificationDecision(mixed, "boss@x.com", null)).toBe(
      "notify"
    )
  })

  it("never dominates always when both match", () => {
    const rules = [
      rule({ match_type: "label", match_value: "News", action: "never" }),
      rule({
        match_type: "sender",
        match_value: "boss@x.com",
        action: "always",
      }),
    ]
    expect(resolveNotificationDecision(rules, "boss@x.com", ["News"])).toBe(
      "suppress"
    )
  })

  it("matches labels by exact name or trailing leaf, case-insensitively", () => {
    const rules = [
      rule({ match_type: "label", match_value: "receipts", action: "never" }),
    ]
    expect(resolveNotificationDecision(rules, null, ["Receipts"])).toBe(
      "suppress"
    )
    expect(resolveNotificationDecision(rules, null, ["Finance/Receipts"])).toBe(
      "suppress"
    )
    // "receipts/2024" is NOT a match: the leaf is 2024, not receipts.
    expect(resolveNotificationDecision(rules, null, ["Receipts/2024"])).toBe(
      "notify"
    )
  })

  it("ignores empty or absent sender/label context", () => {
    const rules = [
      rule({ match_type: "sender", match_value: "a@x.com", action: "never" }),
      rule({ match_type: "label", match_value: "News", action: "never" }),
    ]
    expect(resolveNotificationDecision(rules, null, null)).toBe("notify")
    expect(resolveNotificationDecision(rules, null, [])).toBe("notify")
    expect(resolveNotificationDecision(rules, undefined, ["other"])).toBe(
      "notify"
    )
  })
})
