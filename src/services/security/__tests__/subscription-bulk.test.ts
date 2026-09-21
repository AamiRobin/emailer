import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import {
  bulkUnsubscribe,
  oneClickTargetOf,
  unsubscribeStoredSender,
  type BulkUnsubscribeDeps,
} from "../subscription-bulk"
import {
  getSubscription,
  listSubscriptions,
  markUnsubscribed,
  recordSenderSeen,
  type SubscriptionEntry,
} from "../../settings/subscriptions"
import type { UnsubscribePostFn } from "../unsubscribe"

/**
 * Bulk unsubscribe tests (task 3.6, design D13): the stored-header replay
 * through the SAME one-click mechanics as the message-level affordance
 * (security/unsubscribe.ts), the per-sender results contract (one
 * sender's failure never fails the batch), the offline queueing and the
 * failure annotation. Real schema (node:sqlite executor); only the POST
 * transport and connectivity are faked (the unsubscribe suite's seams).
 */

function responseOf(ok: boolean, status: number): Response {
  return { ok, status } as Response
}

/** A POST seam: a single canned response repeats for every call; an
 * array plays once per call, in order (a bulk run is sized to its input,
 * so the sequence covers exactly the calls the test expects). */
function postSeam(
  responses: Response | Response[] = responseOf(true, 200)
): UnsubscribePostFn {
  const post = vi.fn<UnsubscribePostFn>()
  if (Array.isArray(responses)) {
    for (const response of responses) {
      post.mockResolvedValueOnce(response)
    }
  } else {
    post.mockResolvedValue(responses)
  }
  return post
}

function deps(
  post: UnsubscribePostFn,
  online = true
): BulkUnsubscribeDeps {
  return { post, isOnline: () => online }
}

let executor: TestExecutor
let accountId: string

beforeEach(async () => {
  executor = createTestExecutor()
  accountId = await createAccount(executor, "gmail")
})

afterEach(() => {
  executor.close()
})

async function seedOneClickSender(
  sender: string,
  url: string
): Promise<SubscriptionEntry> {
  return recordSenderSeen(executor, accountId, {
    sender,
    lastSeenAt: 1000,
    listUnsubscribe: `<${url}>`,
    listUnsubscribePost: "List-Unsubscribe=One-Click",
  })
}

describe("oneClickTargetOf", () => {
  it("replays the stored header pair into the one-click URL", async () => {
    const entry = await seedOneClickSender(
      "news@x.com",
      "https://lists.example.com/u/123"
    )
    expect(oneClickTargetOf(entry)).toBe("https://lists.example.com/u/123")
  })

  it("is null without the -Post advertisement (not one-clickable) or no headers", async () => {
    const mailtoOnly = await recordSenderSeen(executor, accountId, {
      sender: "paper@x.com",
      listUnsubscribe: "<mailto:leave@x.com>",
    })
    expect(oneClickTargetOf(mailtoOnly)).toBeNull()
    const bare = await recordSenderSeen(executor, accountId, {
      sender: "bare@x.com",
    })
    expect(oneClickTargetOf(bare)).toBeNull()
  })
})

describe("unsubscribeStoredSender", () => {
  it("POSTs the stored one-click URL and marks the entry unsubscribed", async () => {
    await seedOneClickSender("news@x.com", "https://lists.example.com/u/123")
    const post = postSeam()

    const outcome = await unsubscribeStoredSender(
      executor,
      accountId,
      "News@X.com",
      deps(post)
    )

    expect(outcome).toEqual({ queued: false })
    expect(post).toHaveBeenCalledTimes(1)
    expect(vi.mocked(post).mock.calls[0][0]).toBe(
      "https://lists.example.com/u/123"
    )
    const entry = await getSubscription(executor, accountId, "news@x.com")
    expect(entry?.state).toBe("unsubscribed")
    expect(entry?.lastError).toBeUndefined()
  })

  it("queues the replay op when offline (spec: unsubscribing queues)", async () => {
    await seedOneClickSender("news@x.com", "https://lists.example.com/u")
    const post = postSeam()

    const outcome = await unsubscribeStoredSender(
      executor,
      accountId,
      "news@x.com",
      deps(post, false)
    )

    expect(outcome).toEqual({ queued: true })
    expect(post).not.toHaveBeenCalled()
    const rows = await executor.select<{ op_type: string; payload_json: string }>(
      "SELECT * FROM pending_operations"
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.op_type).toBe("unsubscribe_post")
    expect(JSON.parse(rows[0]?.payload_json ?? "{}")).toEqual({
      url: "https://lists.example.com/u",
    })
    // A queued request IS a successful unsubscribe (the queue owns the
    // replay) — the entry transitions.
    const entry = await getSubscription(executor, accountId, "news@x.com")
    expect(entry?.state).toBe("unsubscribed")
  })

  it("throws for a failed POST and annotates the entry without a transition", async () => {
    await seedOneClickSender("news@x.com", "https://lists.example.com/u")
    const post = postSeam(responseOf(false, 500))

    await expect(
      unsubscribeStoredSender(executor, accountId, "news@x.com", deps(post))
    ).rejects.toThrow("status 500")

    const entry = await getSubscription(executor, accountId, "news@x.com")
    expect(entry?.state).toBe("subscribed")
    expect(entry?.lastError).toContain("500")
  })

  it("throws for a mailto-only sender with the composer hint", async () => {
    await recordSenderSeen(executor, accountId, {
      sender: "paper@x.com",
      listUnsubscribe: "<mailto:leave@x.com>",
    })
    const post = postSeam()
    await expect(
      unsubscribeStoredSender(executor, accountId, "paper@x.com", deps(post))
    ).rejects.toThrow("email unsubscribe")
    expect(post).not.toHaveBeenCalled()
  })

  it("throws for an untracked sender", async () => {
    await expect(
      unsubscribeStoredSender(executor, accountId, "ghost@x.com", deps(postSeam()))
    ).rejects.toThrow("no subscription entry")
  })
})

describe("bulkUnsubscribe (per-sender results)", () => {
  it("unsubscribes each selected sender and reports per-sender success", async () => {
    await seedOneClickSender("a@x.com", "https://a.example.com/u")
    await seedOneClickSender("b@x.com", "https://b.example.com/u")
    await seedOneClickSender("c@x.com", "https://c.example.com/u")
    const post = postSeam()

    const results = await bulkUnsubscribe(
      executor,
      accountId,
      ["a@x.com", "b@x.com", "c@x.com"],
      deps(post)
    )

    // The spec's bulk scenario: three still-subscribed senders, each
    // unsubscribed, per-sender results reported.
    expect(results).toEqual([
      { sender: "a@x.com", ok: true },
      { sender: "b@x.com", ok: true },
      { sender: "c@x.com", ok: true },
    ])
    expect(post).toHaveBeenCalledTimes(3)
    const states = (await listSubscriptions(executor, accountId)).map(
      (entry) => entry.state
    )
    expect(states).toEqual(["unsubscribed", "unsubscribed", "unsubscribed"])
  })

  it("never fails the batch on one sender: failures are per-sender results", async () => {
    await seedOneClickSender("ok@x.com", "https://ok.example.com/u")
    await seedOneClickSender("bad@x.com", "https://bad.example.com/u")
    await recordSenderSeen(executor, accountId, {
      sender: "paper@x.com",
      listUnsubscribe: "<mailto:leave@paper.example.com>",
    })
    // The second POST fails; the others must still go through.
    const post = postSeam([responseOf(true, 200), responseOf(false, 503)])

    const results = await bulkUnsubscribe(
      executor,
      accountId,
      ["ok@x.com", "bad@x.com", "paper@x.com"],
      deps(post)
    )

    expect(results).toEqual([
      { sender: "ok@x.com", ok: true },
      { sender: "bad@x.com", ok: false, error: expect.stringContaining("503") },
      {
        sender: "paper@x.com",
        ok: false,
        error: expect.stringContaining("email unsubscribe"),
      },
    ])
    const bad = await getSubscription(executor, accountId, "bad@x.com")
    expect(bad?.state).toBe("subscribed")
    expect(bad?.lastError).toContain("503")
  })

  it("reports queued senders and deduplicates its input", async () => {
    await seedOneClickSender("a@x.com", "https://a.example.com/u")
    const post = postSeam()

    const results = await bulkUnsubscribe(
      executor,
      accountId,
      ["A@X.com", "a@x.com"],
      deps(post, false)
    )

    expect(results).toEqual([{ sender: "a@x.com", ok: true, queued: true }])
    expect(post).not.toHaveBeenCalled()
  })

  it("an already-unsubscribed selected sender re-runs and stays unsubscribed", async () => {
    const entry = await seedOneClickSender("a@x.com", "https://a.example.com/u")
    await markUnsubscribed(executor, accountId, entry.sender, { at: 2000 })
    const post = postSeam()

    const results = await bulkUnsubscribe(executor, accountId, ["a@x.com"], {
      post,
      isOnline: () => true,
    })

    expect(results).toEqual([{ sender: "a@x.com", ok: true }])
    const after = await getSubscription(executor, accountId, "a@x.com")
    expect(after?.state).toBe("unsubscribed")
    expect(after?.unsubscribedAt).not.toBe(2000)
  })
})
