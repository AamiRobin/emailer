import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { createAccount } from "../../db/__tests__/fixtures"
import {
  createAutoArchiveRule,
  canUnsubscribe,
  hasAutoArchiveRule,
  LIST_UNSUBSCRIBE_HEADER,
  LIST_UNSUBSCRIBE_POST_HEADER,
  ONE_CLICK_BODY,
  parseListUnsubscribe,
  parseStoredHeaders,
  performUnsubscribe,
  postOneClickUnsubscribe,
  unsubscribeTargetsFromHeaders,
  UnsubscribeError,
  type UnsubscribePostFn,
} from "../unsubscribe"
import { listRules } from "../../rules/db"
import { useOnlineStore } from "../../../stores/online-store"

/**
 * Unsubscribe core (task 18.3, design D13): the pure RFC 2369/8058 header
 * parser (angle-bracket fixtures, mailto entries, garbage tolerance, the
 * one-click gate = -Post header AND an https URL), the exact RFC 8058 POST
 * shape (method, form-encoded body, content-type, 2xx/non-2xx outcomes),
 * the offline queueing (an unsubscribe_post row that replays through the
 * queue) and the auto-archive offer (an ordinary rules row via the rules
 * service, deduplicated). Queue/rules paths run against the REAL schema
 * (node:sqlite executor); only the POST transport and the clock/connectivity
 * are faked.
 */

function responseOf(ok: boolean, status: number): Response {
  return { ok, status } as Response
}

/** A POST seam capturing its calls, resolving per the canned outcomes. */
function postSeam(responses: Response | Response[] = responseOf(true, 200)) {
  const post = vi.fn<UnsubscribePostFn>()
  for (const response of Array.isArray(responses) ? responses : [responses]) {
    post.mockResolvedValueOnce(response)
  }
  return post
}

describe("parseListUnsubscribe (fixtures)", () => {
  it("parses the canonical mixed angle-bracket header in order", () => {
    const targets = parseListUnsubscribe(
      "<https://lists.example.com/u/123>, <mailto:leave@lists.example.com>"
    )
    expect(targets.oneClickUrls).toEqual([]) // no -Post header → not one-click
    expect(targets.mailtos).toEqual([{ address: "leave@lists.example.com" }])
  })

  it("gates one-click on the -Post header and keeps only https URLs", () => {
    const targets = parseListUnsubscribe(
      "<http://insecure.example.com/u>, <https://lists.example.com/u/123>, <mailto:leave@lists.example.com>",
      "List-Unsubscribe=One-Click"
    )
    expect(targets.oneClickUrls).toEqual(["https://lists.example.com/u/123"])
    expect(targets.mailtos).toEqual([{ address: "leave@lists.example.com" }])
  })

  it("parses a mailto entry with its own subject", () => {
    const targets = parseListUnsubscribe(
      "<mailto:leave@example.com?subject=unsubscribe%20please>"
    )
    expect(targets.mailtos).toEqual([
      { address: "leave@example.com", subject: "unsubscribe please" },
    ])
  })

  it("parses an only-mailto header", () => {
    const targets = parseListUnsubscribe("<mailto:leave@example.com>")
    expect(targets.oneClickUrls).toEqual([])
    expect(targets.mailtos).toEqual([{ address: "leave@example.com" }])
    expect(canUnsubscribe(targets)).toBe(true)
  })

  it("parses an only-https one-click header", () => {
    const targets = parseListUnsubscribe(
      "<https://lists.example.com/unsubscribe?token=abc>",
      "List-Unsubscribe=One-Click"
    )
    expect(targets.oneClickUrls).toEqual([
      "https://lists.example.com/unsubscribe?token=abc",
    ])
    expect(targets.mailtos).toEqual([])
  })

  it("tolerates missing angle brackets and whitespace sloppiness", () => {
    const targets = parseListUnsubscribe(
      "https://lists.example.com/u , mailto:leave@example.com",
      "List-Unsubscribe=One-Click"
    )
    expect(targets.oneClickUrls).toEqual(["https://lists.example.com/u"])
    expect(targets.mailtos).toEqual([{ address: "leave@example.com" }])
  })

  it("treats a -Post header without an https URL as no one-click", () => {
    const targets = parseListUnsubscribe(
      "<mailto:leave@example.com>",
      "List-Unsubscribe=One-Click"
    )
    expect(targets.oneClickUrls).toEqual([])
    expect(canUnsubscribe(targets)).toBe(true) // the mailto still works
  })

  it("does not treat an https URL as one-click without the -Post header", () => {
    const targets = parseListUnsubscribe("<https://lists.example.com/u>")
    expect(targets.oneClickUrls).toEqual([])
  })

  it("recognizes the -Post advertisement case-insensitively with padding", () => {
    const targets = parseListUnsubscribe(
      "<https://lists.example.com/u>",
      "  list-unsubscribe = ONE-CLICK  "
    )
    expect(targets.oneClickUrls).toEqual(["https://lists.example.com/u"])
  })

  it("ignores an unrelated -Post value", () => {
    const targets = parseListUnsubscribe(
      "<https://lists.example.com/u>",
      "List-Unsubscribe=Later"
    )
    expect(targets.oneClickUrls).toEqual([])
  })

  it("yields nothing actionable from garbage", () => {
    for (const value of [null, undefined, "", "<>", "<ftp://x>", "nonsense"]) {
      const targets = parseListUnsubscribe(value)
      expect(targets.oneClickUrls).toEqual([])
      expect(targets.mailtos).toEqual([])
      expect(canUnsubscribe(targets)).toBe(false)
    }
  })

  it("drops malformed mailto entries without an address", () => {
    const targets = parseListUnsubscribe("<mailto:?subject=hi>")
    expect(targets.mailtos).toEqual([])
  })
})

describe("stored headers parsing", () => {
  it("reads the two captured headers from the messages.headers JSON", () => {
    const headers = parseStoredHeaders(
      JSON.stringify({
        [LIST_UNSUBSCRIBE_HEADER]: "<https://a.example.com/u>",
        [LIST_UNSUBSCRIBE_POST_HEADER]: "List-Unsubscribe=One-Click",
      })
    )
    const targets = parseListUnsubscribe(
      headers[LIST_UNSUBSCRIBE_HEADER],
      headers[LIST_UNSUBSCRIBE_POST_HEADER]
    )
    expect(targets.oneClickUrls).toEqual(["https://a.example.com/u"])
  })

  it("unsubscribeTargetsFromHeaders is the one-call row entry point", () => {
    const targets = unsubscribeTargetsFromHeaders(
      JSON.stringify({ "list-unsubscribe": "<mailto:leave@x.com>" })
    )
    expect(targets.mailtos).toEqual([{ address: "leave@x.com" }])
  })

  it("corrupt or missing headers JSON parses as empty (never throws)", () => {
    expect(parseStoredHeaders(null)).toEqual({})
    expect(parseStoredHeaders(undefined)).toEqual({})
    expect(parseStoredHeaders("not json")).toEqual({})
    expect(parseStoredHeaders("[1,2]")).toEqual({})
    expect(unsubscribeTargetsFromHeaders("not json")).toEqual({
      oneClickUrls: [],
      mailtos: [],
    })
  })
})

describe("one-click POST (RFC 8058)", () => {
  it("posts the exact form-encoded body to the target", async () => {
    const post = postSeam()
    await postOneClickUnsubscribe("https://lists.example.com/u/123", post)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][0]).toBe("https://lists.example.com/u/123")
    expect(post.mock.calls[0][1]).toEqual({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: ONE_CLICK_BODY,
    })
    expect(ONE_CLICK_BODY).toBe("List-Unsubscribe=One-Click")
  })

  it("resolves on a 2xx", async () => {
    await expect(
      postOneClickUnsubscribe("https://a/u", postSeam(responseOf(true, 204)))
    ).resolves.toBeUndefined()
  })

  it("throws UnsubscribeError with the status on failure", async () => {
    const failure = postOneClickUnsubscribe(
      "https://a/u",
      postSeam(responseOf(false, 503))
    )
    await expect(failure).rejects.toBeInstanceOf(UnsubscribeError)
    await failure.catch((error: UnsubscribeError) => {
      expect(error.status).toBe(503)
      expect(error.message).toContain("503")
    })
  })
})

describe("performUnsubscribe (live + offline queue)", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
  })

  afterEach(() => {
    executor.close()
    useOnlineStore.getState().setOnline(true)
  })

  it("posts live when online", async () => {
    const post = postSeam()
    const outcome = await performUnsubscribe(
      executor,
      accountId,
      "https://a/u",
      { post, isOnline: () => true }
    )
    expect(outcome).toEqual({ kind: "posted" })
    expect(post).toHaveBeenCalledTimes(1)
    const rows = await executor.select<{ op_type: string }>(
      "SELECT op_type FROM pending_operations"
    )
    expect(rows).toEqual([])
  })

  it("queues an unsubscribe_post op when offline (spec: replay)", async () => {
    const post = postSeam()
    const outcome = await performUnsubscribe(
      executor,
      accountId,
      "https://a/u",
      { post, isOnline: () => false }
    )
    expect(outcome).toEqual({ kind: "queued" })
    expect(post).not.toHaveBeenCalled()
    const rows = await executor.select<{
      op_type: string
      payload_json: string
      account_id: string
    }>("SELECT * FROM pending_operations")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.op_type).toBe("unsubscribe_post")
    expect(rows[0]?.account_id).toBe(accountId)
    expect(JSON.parse(rows[0]?.payload_json ?? "{}")).toEqual({
      url: "https://a/u",
    })
  })

  it("follows the real online store when no seam overrides it", async () => {
    useOnlineStore.getState().setOnline(false)
    const outcome = await performUnsubscribe(
      executor,
      accountId,
      "https://a/u",
      { post: postSeam() }
    )
    expect(outcome).toEqual({ kind: "queued" })
  })

  it("throws through a failed live POST (the caller toasts it)", async () => {
    const outcome = performUnsubscribe(executor, accountId, "https://a/u", {
      post: postSeam(responseOf(false, 500)),
      isOnline: () => true,
    })
    await expect(outcome).rejects.toBeInstanceOf(UnsubscribeError)
  })
})

describe("auto-archive offer (an ordinary rule via the rules service)", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
  })

  afterEach(() => {
    executor.close()
  })

  it("creates a from:sender → archive rule", async () => {
    const ruleId = await createAutoArchiveRule(
      executor,
      accountId,
      "News@Lists.Example.com"
    )
    const rules = await listRules(executor, accountId)
    expect(rules).toHaveLength(1)
    expect(rules[0]?.id).toBe(ruleId)
    expect(rules[0]?.name).toBe("Auto-archive mail from news@lists.example.com")
    expect(rules[0]?.criteria_json).toBe(
      JSON.stringify({ query: "from:news@lists.example.com" })
    )
    expect(JSON.parse(rules[0]?.actions_json ?? "[]")).toEqual([
      { type: "archive" },
    ])
    expect(rules[0]?.enabled).toBe(1)
  })

  it("hasAutoArchiveRule detects the created rule (case-exact criteria)", async () => {
    expect(
      await hasAutoArchiveRule(executor, accountId, "news@lists.example.com")
    ).toBe(false)
    await createAutoArchiveRule(executor, accountId, "news@lists.example.com")
    expect(
      await hasAutoArchiveRule(executor, accountId, "news@lists.example.com")
    ).toBe(true)
    // A different sender's rule does not match.
    expect(await hasAutoArchiveRule(executor, accountId, "other@x.com")).toBe(
      false
    )
  })
})
