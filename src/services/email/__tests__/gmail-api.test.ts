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

  it("listSendAs reads users/me/settings/sendAs (task 16.1)", async () => {
    const mock = createFetchMock()
    mock.on("GET", /\/settings\/sendAs/, () => ({
      json: {
        sendAs: [
          {
            sendAsEmail: "me@gmail.com",
            displayName: "Me",
            isPrimary: true,
            isDefault: true,
          },
          {
            sendAsEmail: "work@example.com",
            displayName: "Work",
            verificationStatus: "accepted",
          },
        ],
      },
    }))

    const sendAs = await clientFor(mock).listSendAs()

    expect(mock.calls[0].url).toBe(`${GMAIL_API_ROOT}/settings/sendAs`)
    expect(mock.calls[0].headers.authorization).toBe("Bearer at-1")
    expect(sendAs).toHaveLength(2)
    expect(sendAs[0]).toMatchObject({
      sendAsEmail: "me@gmail.com",
      isPrimary: true,
    })
    expect(sendAs[1]).toMatchObject({ sendAsEmail: "work@example.com" })
  })

  it("listSendAs maps an empty response to an empty array", async () => {
    const mock = createFetchMock()
    mock.on("GET", /\/settings\/sendAs/, () => ({ json: {} }))

    expect(await clientFor(mock).listSendAs()).toEqual([])
  })

  it("listSendAs follows nextPageToken until the pages are exhausted", async () => {
    const mock = createFetchMock()
    mock.on("GET", /\/settings\/sendAs/, (request) => {
      if (request.url.includes("pageToken=")) {
        return {
          json: {
            sendAs: [{ sendAsEmail: "b@example.com" }],
            // No further token — the loop must stop here.
          },
        }
      }
      return {
        json: {
          sendAs: [{ sendAsEmail: "a@example.com" }],
          nextPageToken: "cursor-2",
        },
      }
    })

    const sendAs = await clientFor(mock).listSendAs()

    expect(sendAs.map((entry) => entry.sendAsEmail)).toEqual([
      "a@example.com",
      "b@example.com",
    ])
    expect(mock.calls).toHaveLength(2)
    // The first request stays the bare endpoint; the follow-up carries the
    // server's token.
    expect(mock.calls[0].url).toBe(`${GMAIL_API_ROOT}/settings/sendAs`)
    expect(mock.calls[1].url).toContain("pageToken=cursor-2")
  })

  // ---- Drafts API (task 17.1, design D9) ----

  it("createDraft posts the draft resource with the raw message", async () => {
    const mock = createFetchMock()
    mock.on("POST", /\/drafts$/, () => ({
      json: { id: "draft-1", message: { id: "msg-1" } },
    }))

    const draft = await clientFor(mock).createDraft("raw-b64url")

    expect(draft.id).toBe("draft-1")
    expect(mock.calls[0].method).toBe("POST")
    expect(mock.calls[0].url).toBe(`${GMAIL_API_ROOT}/drafts`)
    expect(JSON.parse(mock.calls[0].body ?? "{}")).toEqual({
      message: { raw: "raw-b64url" },
    })
  })

  it("updateDraft PUTs the new message to drafts/{id}", async () => {
    const mock = createFetchMock()
    mock.on("PUT", /\/drafts\/draft-9/, () => ({
      json: { id: "draft-9", message: { id: "msg-9" } },
    }))

    await clientFor(mock).updateDraft("draft-9", "raw-v2")

    expect(mock.calls[0].method).toBe("PUT")
    expect(mock.calls[0].url).toBe(`${GMAIL_API_ROOT}/drafts/draft-9`)
    expect(JSON.parse(mock.calls[0].body ?? "{}")).toEqual({
      id: "draft-9",
      message: { raw: "raw-v2" },
    })
  })

  it("deleteDraft hits DELETE drafts/{id} and ignores the empty body", async () => {
    const mock = createFetchMock()
    mock.on("DELETE", /\/drafts\/draft-9/, () => ({ json: {} }))

    await clientFor(mock).deleteDraft("draft-9")

    expect(mock.calls[0].method).toBe("DELETE")
    expect(mock.calls[0].url).toBe(`${GMAIL_API_ROOT}/drafts/draft-9`)
  })

  it("sendDraft posts drafts/send with the draft id", async () => {
    const mock = createFetchMock()
    mock.on("POST", /\/drafts\/send/, () => ({ json: { id: "msg-sent" } }))

    const sent = await clientFor(mock).sendDraft("draft-9")

    expect(sent.id).toBe("msg-sent")
    expect(mock.calls[0].url).toBe(`${GMAIL_API_ROOT}/drafts/send`)
    expect(JSON.parse(mock.calls[0].body ?? "{}")).toEqual({ id: "draft-9" })
  })

  it("getDraft defaults to format=full and can request raw", async () => {
    const mock = createFetchMock()
    mock.on("GET", /\/drafts\/draft-9/, () => ({
      json: { id: "draft-9", message: { id: "msg-9", raw: "raw-b64url" } },
    }))

    const client = clientFor(mock)
    await client.getDraft("draft-9")
    const raw = await client.getDraft("draft-9", "raw")

    expect(mock.calls[0].url).toContain("format=full")
    expect(mock.calls[1].url).toContain("format=raw")
    expect(raw.message?.raw).toBe("raw-b64url")
  })

  it("listDrafts passes maxResults and returns the drafts page", async () => {
    const mock = createFetchMock()
    mock.on("GET", /\/drafts\?/, () => ({
      json: {
        drafts: [{ id: "d-1" }, { id: "d-2" }],
        resultSizeEstimate: 2,
      },
    }))

    const page = await clientFor(mock).listDrafts({ maxResults: 50 })

    expect(mock.calls[0].url).toContain("maxResults=50")
    expect(page.drafts).toHaveLength(2)
    expect(page.drafts?.[0].id).toBe("d-1")
  })
})
