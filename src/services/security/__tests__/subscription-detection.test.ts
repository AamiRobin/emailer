import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import {
  getSubscription,
  listSubscriptions,
  markUnsubscribed,
  recordSenderSeen,
} from "../../settings/subscriptions"
import {
  recordSubscriptionActivity,
  type SubscriptionActivityInput,
} from "../subscription-detection"

/**
 * Subscription detection tests (task 3.6, design D13): the ingestion side
 * of the subscription manager. Only mail carrying an unsubscribe header is
 * recorded (the spec's "detected as newsletters") — through the REAL
 * recordSenderSeen transition, so an unsubscribed sender's new mail flips
 * its entry to "resumed" — and one failing message never breaks the pass.
 */

let executor: TestExecutor
let accountId: string

beforeEach(async () => {
  executor = createTestExecutor()
  accountId = await createAccount(executor, "imap")
})

afterEach(() => {
  executor.close()
})

function event(
  overrides: Partial<SubscriptionActivityInput> & { messageRowId: string }
): SubscriptionActivityInput {
  return {
    fromAddress: "news@lists.example.com",
    date: 1000,
    headers: {},
    ...overrides,
  }
}

const LIST_UNSUBSCRIBE =
  "<https://lists.example.com/u/123>, <mailto:leave@lists.example.com>"
const LIST_UNSUBSCRIBE_POST = "List-Unsubscribe=One-Click"

describe("recordSubscriptionActivity", () => {
  it("records senders of mail carrying the unsubscribe headers", async () => {
    await recordSubscriptionActivity(executor, accountId, [
      event({
        messageRowId: "m-1",
        headers: {
          "list-unsubscribe": LIST_UNSUBSCRIBE,
          "list-unsubscribe-post": LIST_UNSUBSCRIBE_POST,
        },
      }),
    ])

    const entry = await getSubscription(
      executor,
      accountId,
      "news@lists.example.com"
    )
    expect(entry).toMatchObject({
      sender: "news@lists.example.com",
      state: "subscribed",
      lastSeenAt: 1000,
      listUnsubscribe: LIST_UNSUBSCRIBE,
      listUnsubscribePost: LIST_UNSUBSCRIBE_POST,
    })
  })

  it("records on either header alone (List-Unsubscribe or -Post)", async () => {
    await recordSubscriptionActivity(executor, accountId, [
      event({
        messageRowId: "m-1",
        fromAddress: "a@lists.example.com",
        headers: { "list-unsubscribe": "<https://lists.example.com/u/a>" },
      }),
      event({
        messageRowId: "m-2",
        fromAddress: "b@lists.example.com",
        headers: { "list-unsubscribe-post": LIST_UNSUBSCRIBE_POST },
      }),
    ])

    const entries = await listSubscriptions(executor, accountId, "sender")
    expect(entries.map((entry) => entry.sender)).toEqual([
      "a@lists.example.com",
      "b@lists.example.com",
    ])
  })

  it("skips mail without headers, header-carrying mail without a sender, and empty header values", async () => {
    await recordSubscriptionActivity(executor, accountId, [
      // Plain correspondence: not a detected newsletter.
      event({ messageRowId: "m-1", fromAddress: "friend@x.com", headers: {} }),
      // Headers but no sender address to key an entry with.
      event({
        messageRowId: "m-2",
        fromAddress: null,
        headers: { "list-unsubscribe": LIST_UNSUBSCRIBE },
      }),
      event({
        messageRowId: "m-3",
        fromAddress: "   ",
        headers: { "list-unsubscribe-post": LIST_UNSUBSCRIBE_POST },
      }),
      // An empty header value carries no target — treated as absent.
      event({
        messageRowId: "m-4",
        fromAddress: "ghost@x.com",
        headers: { "list-unsubscribe": "   " },
      }),
    ])

    expect(await listSubscriptions(executor, accountId)).toEqual([])
  })

  it("flips an unsubscribed sender to resumed through the real transition", async () => {
    await recordSenderSeen(executor, accountId, {
      sender: "news@lists.example.com",
      lastSeenAt: 100,
      listUnsubscribe: "<https://old.example.com/u>",
    })
    await markUnsubscribed(executor, accountId, "news@lists.example.com", {
      at: 150,
    })

    await recordSubscriptionActivity(executor, accountId, [
      event({
        messageRowId: "m-1",
        date: 5000,
        headers: {
          "list-unsubscribe": LIST_UNSUBSCRIBE,
          "list-unsubscribe-post": LIST_UNSUBSCRIBE_POST,
        },
      }),
    ])

    const entry = await getSubscription(
      executor,
      accountId,
      "news@lists.example.com"
    )
    // The spec's sender-resumed scenario: the unsubscribe did not hold.
    expect(entry?.state).toBe("resumed")
    expect(entry?.lastSeenAt).toBe(5000)
    // The context survives, and the last-seen header pair is refreshed.
    expect(entry?.unsubscribedAt).toBe(150)
    expect(entry?.listUnsubscribe).toBe(LIST_UNSUBSCRIBE)
  })

  it("isolates one failing message and records the rest of the batch", async () => {
    await expect(
      recordSubscriptionActivity(executor, accountId, [
        // A corrupt arrival timestamp makes recordSenderSeen throw (its
        // write-time validation) — warned about, never propagated.
        event({
          messageRowId: "m-bad",
          fromAddress: "broken@lists.example.com",
          date: Number.NaN,
          headers: { "list-unsubscribe": LIST_UNSUBSCRIBE },
        }),
        event({
          messageRowId: "m-good",
          fromAddress: "healthy@lists.example.com",
          date: 2000,
          headers: { "list-unsubscribe": LIST_UNSUBSCRIBE },
        }),
      ])
    ).resolves.toBeUndefined()

    expect(
      await getSubscription(executor, accountId, "broken@lists.example.com")
    ).toBeNull()
    const healthy = await getSubscription(
      executor,
      accountId,
      "healthy@lists.example.com"
    )
    expect(healthy?.state).toBe("subscribed")
    expect(healthy?.lastSeenAt).toBe(2000)
  })
})
