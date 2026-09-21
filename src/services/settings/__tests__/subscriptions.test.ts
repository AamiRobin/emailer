import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { getSetting, setSetting } from "../../db/settings"
import {
  getSubscription,
  listSubscriptions,
  markSenderResumed,
  markUnsubscribeFailed,
  markUnsubscribed,
  recordSenderSeen,
  removeEntry,
  subscriptionKey,
  subscriptionsSettingKey,
  type SubscriptionEntry,
} from "../subscriptions"

/**
 * Subscription manager storage tests (task 3.6, design D13): the
 * per-account settings row (the delivery-schedules pattern), the state
 * machine — including the spec's resumed flip when mail is recorded for
 * an unsubscribed sender — and the corrupt-row tolerance (invalid stored
 * entries are dropped on read, never thrown).
 */

let executor: TestExecutor
let accountId: string

beforeEach(async () => {
  executor = createTestExecutor()
  accountId = await createAccount(executor, "gmail")
})

afterEach(() => {
  executor.close()
})

const HEADERS = {
  listUnsubscribe: "<https://lists.example.com/u/123>, <mailto:leave@lists.example.com>",
  listUnsubscribePost: "List-Unsubscribe=One-Click",
}

async function storedRaw(): Promise<unknown> {
  return getSetting<unknown>(
    executor,
    subscriptionsSettingKey(accountId),
    null
  )
}

describe("recordSenderSeen", () => {
  it("creates an entry as subscribed under the per-account key", async () => {
    const entry = await recordSenderSeen(executor, accountId, {
      sender: "News@Lists.Example.com",
      lastSeenAt: 1000,
      ...HEADERS,
    })

    expect(entry).toEqual({
      sender: "news@lists.example.com",
      state: "subscribed",
      lastSeenAt: 1000,
      ...HEADERS,
    })
    // One JSON array under the namespaced key, per account.
    expect(Array.isArray(await storedRaw())).toBe(true)

    const list = await listSubscriptions(executor, accountId)
    expect(list).toHaveLength(1)
    expect(list[0]?.sender).toBe("news@lists.example.com")
  })

  it("scopes entries per account", async () => {
    const other = await createAccount(executor, "imap")
    await recordSenderSeen(executor, accountId, { sender: "a@x.com" })
    expect(await listSubscriptions(executor, other)).toEqual([])
    expect(await listSubscriptions(executor, accountId)).toHaveLength(1)
  })

  it("refreshes lastSeenAt monotonically and the last-seen headers", async () => {
    await recordSenderSeen(executor, accountId, {
      sender: "news@x.com",
      lastSeenAt: 5000,
      listUnsubscribe: "<https://old.example.com/u>",
      listUnsubscribePost: "List-Unsubscribe=One-Click",
    })
    // An older backfilled message must not move last-seen backward, but a
    // newer header pair wins.
    const updated = await recordSenderSeen(executor, accountId, {
      sender: "news@x.com",
      lastSeenAt: 3000,
      listUnsubscribe: "<https://new.example.com/u>",
    })

    expect(updated.lastSeenAt).toBe(5000)
    expect(updated.listUnsubscribe).toBe("<https://new.example.com/u>")
    // The -Post value is LAST SEEN too: no new value keeps the old one.
    expect(updated.listUnsubscribePost).toBe("List-Unsubscribe=One-Click")
  })

  it("flips an unsubscribed sender to resumed when mail is recorded again", async () => {
    await recordSenderSeen(executor, accountId, { sender: "news@x.com" })
    await markUnsubscribed(executor, accountId, "news@x.com", { at: 100 })

    const entry = await recordSenderSeen(executor, accountId, {
      sender: "news@x.com",
      lastSeenAt: 200,
    })
    expect(entry.state).toBe("resumed")
    // unsubscribedAt survives the flip (context for the user).
    expect(entry.unsubscribedAt).toBe(100)
  })

  it("rejects an empty sender or a non-finite timestamp", async () => {
    await expect(
      recordSenderSeen(executor, accountId, { sender: "   " })
    ).rejects.toThrow("sender")
    await expect(
      recordSenderSeen(executor, accountId, {
        sender: "a@x.com",
        lastSeenAt: Number.NaN,
      })
    ).rejects.toThrow("lastSeenAt")
    expect(await listSubscriptions(executor, accountId)).toEqual([])
  })
})

describe("markUnsubscribed / markUnsubscribeFailed", () => {
  it("transitions to unsubscribed with unsubscribedAt and clears lastError", async () => {
    await recordSenderSeen(executor, accountId, { sender: "news@x.com" })
    await markUnsubscribeFailed(executor, accountId, "news@x.com", "boom")
    await markUnsubscribed(executor, accountId, "news@x.com", { at: 4321 })

    const entry = await getSubscription(executor, accountId, "NEWS@x.com")
    expect(entry?.state).toBe("unsubscribed")
    expect(entry?.unsubscribedAt).toBe(4321)
    expect(entry?.lastError).toBeUndefined()
  })

  it("annotates a failure without changing state; a missing entry is a no-op", async () => {
    await recordSenderSeen(executor, accountId, { sender: "news@x.com" })
    await markUnsubscribeFailed(
      executor,
      accountId,
      "news@x.com",
      "failed with status 503"
    )
    const entry = await getSubscription(executor, accountId, "news@x.com")
    expect(entry?.state).toBe("subscribed")
    expect(entry?.lastError).toBe("failed with status 503")

    // Best-effort annotation: an unknown sender never throws.
    await expect(
      markUnsubscribeFailed(executor, accountId, "ghost@x.com", "x")
    ).resolves.toBeUndefined()
  })

  it("throws for an untracked sender on the real transition", async () => {
    await expect(
      markUnsubscribed(executor, accountId, "ghost@x.com")
    ).rejects.toThrow("not tracked")
  })
})

describe("markSenderResumed", () => {
  it("flips unsubscribed → resumed and refreshes lastSeenAt", async () => {
    await recordSenderSeen(executor, accountId, {
      sender: "news@x.com",
      lastSeenAt: 100,
    })
    await markUnsubscribed(executor, accountId, "news@x.com", { at: 150 })
    await markSenderResumed(executor, accountId, "news@x.com", { at: 200 })

    const entry = await getSubscription(executor, accountId, "news@x.com")
    expect(entry?.state).toBe("resumed")
    expect(entry?.lastSeenAt).toBe(200)
  })

  it("is idempotent on resumed and leaves still-subscribed entries alone", async () => {
    await recordSenderSeen(executor, accountId, {
      sender: "a@x.com",
      lastSeenAt: 10,
    })
    await recordSenderSeen(executor, accountId, {
      sender: "b@x.com",
      lastSeenAt: 10,
    })
    await markUnsubscribed(executor, accountId, "a@x.com", { at: 20 })
    await markSenderResumed(executor, accountId, "a@x.com", { at: 30 })
    await markSenderResumed(executor, accountId, "a@x.com", { at: 40 })
    await markSenderResumed(executor, accountId, "b@x.com", { at: 40 })

    const a = await getSubscription(executor, accountId, "a@x.com")
    expect(a?.state).toBe("resumed")
    expect(a?.lastSeenAt).toBe(40)
    const b = await getSubscription(executor, accountId, "b@x.com")
    expect(b?.state).toBe("subscribed")
    expect(b?.lastSeenAt).toBe(40)
  })

  it("throws for an untracked sender", async () => {
    await expect(
      markSenderResumed(executor, accountId, "ghost@x.com")
    ).rejects.toThrow("not tracked")
  })
})

describe("removeEntry", () => {
  it("removes the entry; an unknown sender is a no-op", async () => {
    await recordSenderSeen(executor, accountId, { sender: "a@x.com" })
    await recordSenderSeen(executor, accountId, { sender: "b@x.com" })

    await removeEntry(executor, accountId, "ghost@x.com")
    await removeEntry(executor, accountId, "A@X.com")

    const list = await listSubscriptions(executor, accountId)
    expect(list.map((entry) => entry.sender)).toEqual(["b@x.com"])
  })
})

describe("listSubscriptions", () => {
  it("sorts by lastSeenAt desc by default, or alphabetically", async () => {
    await recordSenderSeen(executor, accountId, {
      sender: "old@x.com",
      lastSeenAt: 100,
    })
    await recordSenderSeen(executor, accountId, {
      sender: "new@x.com",
      lastSeenAt: 300,
    })
    await recordSenderSeen(executor, accountId, {
      sender: "mid@x.com",
      lastSeenAt: 200,
    })

    expect(
      (await listSubscriptions(executor, accountId)).map((e) => e.sender)
    ).toEqual(["new@x.com", "mid@x.com", "old@x.com"])
    expect(
      (await listSubscriptions(executor, accountId, "sender")).map(
        (e) => e.sender
      )
    ).toEqual(["mid@x.com", "new@x.com", "old@x.com"])
  })

  it("drops corrupt stored entries on read instead of crashing", async () => {
    const valid = await recordSenderSeen(executor, accountId, {
      sender: "a@x.com",
      lastSeenAt: 1,
    })
    await setSetting(executor, subscriptionsSettingKey(accountId), [
      { junk: true },
      valid,
      { sender: "half@x.com", state: "subscribed" }, // no lastSeenAt
      { sender: "weird@x.com", state: "forgotten", lastSeenAt: 2 },
      "not an object",
    ])
    const list = await listSubscriptions(executor, accountId)
    expect(list.map((entry) => entry.sender)).toEqual(["a@x.com"])
  })
})

describe("subscriptionKey", () => {
  it("lowercases and trims; empty addresses have no key", () => {
    expect(subscriptionKey("  News@X.COM ")).toBe("news@x.com")
    expect(subscriptionKey("   ")).toBeNull()
  })
})

describe("getSubscription", () => {
  it("is case-insensitive and null for unknown or empty senders", async () => {
    await recordSenderSeen(executor, accountId, { sender: "a@x.com" })
    expect(
      (await getSubscription(executor, accountId, "A@X.com")) as
        | SubscriptionEntry
        | null
    ).not.toBeNull()
    expect(await getSubscription(executor, accountId, "ghost@x.com")).toBeNull()
    expect(await getSubscription(executor, accountId, "  ")).toBeNull()
  })
})
