import { beforeEach, describe, expect, it } from "vitest"

import { createGmailClient, GMAIL_API_ROOT, GmailApiError } from "../gmail-api"
import { ProviderAuthError } from "../types"
import { clearGmailTokenCache } from "../token-manager"
import { createFetchMock, gmailAccount } from "./gmail-fixtures"

const ACCOUNT = gmailAccount()

function clientFor(
  mock: ReturnType<typeof createFetchMock>,
  getToken: (force?: boolean) => Promise<string> = async () => "at-1"
) {
  return createGmailClient({
    accountId: ACCOUNT.id,
    getToken,
    fetchImpl: mock.fetch,
  })
}

beforeEach(() => {
  clearGmailTokenCache()
})

describe("request plumbing", () => {
  it("sends Bearer auth to the users/me endpoint", async () => {
    const mock = createFetchMock()
    mock.on("GET", `${GMAIL_API_ROOT}/profile`, () => ({
      json: { emailAddress: "me@gmail.com", historyId: "9000" },
    }))

    const profile = await clientFor(mock).getProfile()

    expect(profile).toEqual({
      emailAddress: "me@gmail.com",
      historyId: "9000",
    })
    expect(mock.calls[0].method).toBe("GET")
    expect(mock.calls[0].url).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/profile"
    )
    expect(mock.calls[0].headers.authorization).toBe("Bearer at-1")
  })

  it("refreshes once on 401 and retries with the new token", async () => {
    const mock = createFetchMock()
    let profileCalls = 0
    mock.on("GET", `${GMAIL_API_ROOT}/profile`, () => {
      profileCalls += 1
      if (profileCalls === 1) return { status: 401, json: { error: {} } }
      return { json: { emailAddress: "me@gmail.com", historyId: "1" } }
    })
    const getTokenCalls: (boolean | undefined)[] = []
    const client = clientFor(mock, async (force) => {
      getTokenCalls.push(force)
      return force ? "at-fresh" : "at-stale"
    })

    const profile = await client.getProfile()

    expect(profile.emailAddress).toBe("me@gmail.com")
    expect(profileCalls).toBe(2)
    expect(getTokenCalls).toEqual([undefined, true])
    expect(mock.calls[0].headers.authorization).toBe("Bearer at-stale")
    expect(mock.calls[1].headers.authorization).toBe("Bearer at-fresh")
  })

  it("throws ProviderAuthError when the retried request is still 401", async () => {
    const mock = createFetchMock()
    mock.on("GET", `${GMAIL_API_ROOT}/profile`, () => ({
      status: 401,
      json: { error: {} },
    }))

    const error = await clientFor(mock)
      .getProfile()
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ProviderAuthError)
    expect((error as ProviderAuthError).accountId).toBe("acc-g")
    expect(mock.calls).toHaveLength(2)
  })

  it("maps non-OK responses to GmailApiError with status and reason", async () => {
    const mock = createFetchMock()
    mock.on("GET", /\/history\?/, () => ({
      status: 404,
      json: {
        error: {
          code: 404,
          message: "Requested history was not found.",
          errors: [{ reason: "notFound" }],
        },
      },
    }))

    const error = await clientFor(mock)
      .listHistory("4242")
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(GmailApiError)
    expect((error as GmailApiError).status).toBe(404)
    expect((error as GmailApiError).reason).toBe("notFound")
    expect((error as Error).message).toContain("history")
    expect((error as Error).message).not.toContain("Bearer")
  })
})

describe("endpoint shapes", () => {
  it("listHistory passes startHistoryId and pageToken as query params", async () => {
    const mock = createFetchMock()
    mock.on("GET", /\/history/, () => ({
      json: { history: [], historyId: "9010" },
    }))

    await clientFor(mock).listHistory("9000", "page-2")

    expect(mock.calls[0].url).toContain("startHistoryId=9000")
    expect(mock.calls[0].url).toContain("pageToken=page-2")
  })

  it("listMessages repeats labelIds and sets maxResults", async () => {
    const mock = createFetchMock()
    mock.on("GET", /\/messages\?/, () => ({ json: { messages: [] } }))

    await clientFor(mock).listMessages({
      labelIds: ["INBOX", "UNREAD"],
      maxResults: 25,
    })

    const url = mock.calls[0].url
    expect(url).toContain("labelIds=INBOX")
    expect(url).toContain("labelIds=UNREAD")
    expect(url).toContain("maxResults=25")
  })

  it("getMessage defaults to format=full and can request metadata", async () => {
    const mock = createFetchMock()
    mock.on("GET", /\/messages\/42/, () => ({ json: { id: "42" } }))

    const client = clientFor(mock)
    await client.getMessage("42")
    await client.getMessage("42", "metadata")

    expect(mock.calls[0].url).toContain("format=full")
    expect(mock.calls[1].url).toContain("format=metadata")
  })

  it("sendMessageRaw posts the raw body as JSON", async () => {
    const mock = createFetchMock()
    mock.on("POST", /\/messages\/send/, () => ({ json: { id: "99" } }))

    await clientFor(mock).sendMessageRaw("raw-b64url")

    expect(mock.calls[0].method).toBe("POST")
    expect(JSON.parse(mock.calls[0].body ?? "{}")).toEqual({
      raw: "raw-b64url",
    })
  })

  it("modifyMessageLabels omits empty sides", async () => {
    const mock = createFetchMock()
    mock.on("POST", /\/messages\/7\/modify/, () => ({ json: { id: "7" } }))

    await clientFor(mock).modifyMessageLabels("7", [], ["UNREAD"])

    expect(JSON.parse(mock.calls[0].body ?? "{}")).toEqual({
      removeLabelIds: ["UNREAD"],
    })
  })

  it("trash and delete hit the dedicated endpoints", async () => {
    const mock = createFetchMock()
    mock.on("POST", /\/messages\/7\/trash/, () => ({ json: { id: "7" } }))
    mock.on("DELETE", /\/messages\/7/, () => ({ json: {} }))

    const client = clientFor(mock)
    await client.trashMessage("7")
    await client.deleteMessage("7")

    expect(mock.calls[0].url).toContain("/messages/7/trash")
    expect(mock.calls[1].method).toBe("DELETE")
  })

  it("insertMessageRaw posts raw plus labels when given", async () => {
    const mock = createFetchMock()
    mock.on("POST", /\/messages\/insert/, () => ({ json: { id: "5" } }))

    const client = clientFor(mock)
    await client.insertMessageRaw("raw-b64url", ["SENT"])
    await client.insertMessageRaw("raw-b64url")

    expect(JSON.parse(mock.calls[0].body ?? "{}")).toEqual({
      raw: "raw-b64url",
      labelIds: ["SENT"],
    })
    expect(JSON.parse(mock.calls[1].body ?? "{}")).toEqual({
      raw: "raw-b64url",
    })
  })
})
