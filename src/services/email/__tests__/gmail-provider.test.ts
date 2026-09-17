import { beforeEach, describe, expect, it } from "vitest"

import {
  createGmailProvider,
  flagsForLabelIds,
  gmailLabelToEmailLabel,
  gmailLabelToFolder,
  labelChangesForFlags,
  mapGmailMessage,
  mapHistoryDelta,
  parseUidSet,
  registerGmailProvider,
} from "../gmail-provider"
import type { GmailHistoryRecord, GmailLabel } from "../gmail-api"
import { GmailApiError } from "../gmail-api"
import { getProvider } from "../provider-factory"
import type { SendEmailInput } from "../types"
import { encryptCredentials } from "../../crypto/credentials"
import { setDefaultKeyStore } from "../../crypto/key-management"
import { createInMemoryKeyStore } from "../../crypto/__tests__/in-memory-key-store"
import { clearGmailTokenCache } from "../token-manager"
import {
  createFetchMock,
  gmailAccount,
  gmailEnvelope,
  gmailLabel,
  gmailMessage,
  historyPage,
  mockTokenSuccess,
  textPart,
  type FetchMock,
} from "./gmail-fixtures"
import { apiCalls } from "./gmail-fixtures"

beforeEach(() => {
  // The token cache is module-global and keyed by account id.
  clearGmailTokenCache()
})

let mock: FetchMock

/** Fresh mock with the token route pre-registered for each test. */
function freshMock(): FetchMock {
  mock = createFetchMock()
  mockTokenSuccess(mock, "at-1", 3600)
  return mock
}

function provider(fetchMock: FetchMock = mock, envelope = gmailEnvelope) {
  return createGmailProvider(
    gmailAccount(),
    { password: "" },
    {
      fetchImpl: fetchMock.fetch,
      tokenEnvelope: envelope,
    }
  )
}

/** Route a mock to serve the standard label list. */
function mockLabels(fetchMock: FetchMock, labels: GmailLabel[]): void {
  fetchMock.on("GET", /\/labels$/, () => ({ json: { labels } }))
}

const inboxLabel = gmailLabel({ id: "INBOX", name: "INBOX", type: "system" })
const sentLabel = gmailLabel({ id: "SENT", name: "SENT", type: "system" })
const draftLabel = gmailLabel({ id: "DRAFT", name: "DRAFT", type: "system" })
const spamLabel = gmailLabel({ id: "SPAM", name: "SPAM", type: "system" })
const trashLabel = gmailLabel({ id: "TRASH", name: "TRASH", type: "system" })
const categoryLabel = gmailLabel({
  id: "CATEGORY_PERSONAL",
  name: "CATEGORY_PERSONAL",
  type: "system",
})
const workLabel = gmailLabel({
  id: "Label_work",
  name: "Work",
  type: "user",
  color: { backgroundColor: "#fb4c2f", textColor: "#ffffff" },
})

// ---------------------------------------------------------------------------
// Pure mapping helpers
// ---------------------------------------------------------------------------

describe("label mapping", () => {
  it("maps system labels to canonical folders", () => {
    const folder = gmailLabelToFolder(inboxLabel)
    expect(folder).toEqual({
      id: "INBOX",
      name: "Inbox",
      path: "INBOX",
      type: "system",
      specialUse: "inbox",
      delimiter: "/",
    })
    expect(gmailLabelToFolder(draftLabel)?.name).toBe("Drafts")
    expect(gmailLabelToFolder(spamLabel)?.specialUse).toBe("spam")
  })

  it("maps user labels to folder-<path> rows and skips non-folder system labels", () => {
    expect(gmailLabelToFolder(workLabel)).toMatchObject({
      id: "folder-Work",
      name: "Work",
      path: "Work",
      type: "user",
      specialUse: null,
    })
    expect(gmailLabelToFolder(categoryLabel)).toBeNull()
    expect(
      gmailLabelToFolder(
        gmailLabel({ id: "UNREAD", name: "UNREAD", type: "system" })
      )
    ).toBeNull()
    expect(
      gmailLabelToFolder(
        gmailLabel({ id: "STARRED", name: "STARRED", type: "system" })
      )
    ).toBeNull()
    expect(
      gmailLabelToFolder(
        gmailLabel({ id: "IMPORTANT", name: "IMPORTANT", type: "system" })
      )
    ).toBeNull()
  })

  it("carries server colors through as encoded background/text", () => {
    const label = gmailLabelToEmailLabel(workLabel, "acc-g")
    expect(label).toMatchObject({
      id: "folder-Work",
      accountId: "acc-g",
      name: "Work",
      gmailLabelId: "Label_work",
      type: "user",
    })
    expect(JSON.parse(label?.color ?? "{}")).toEqual({
      background: "#fb4c2f",
      text: "#ffffff",
    })
    expect(gmailLabelToEmailLabel(inboxLabel, "acc-g")?.specialUse).toBe(
      "inbox"
    )
    expect(gmailLabelToEmailLabel(categoryLabel, "acc-g")).toBeNull()
  })
})

describe("flag mapping", () => {
  it("derives imap-style flags from gmail labelIds (read = UNREAD absence)", () => {
    expect(flagsForLabelIds(["INBOX"])).toEqual(["\\Seen"])
    expect(flagsForLabelIds(["INBOX", "UNREAD", "STARRED", "DRAFT"])).toEqual([
      "\\Flagged",
      "\\Draft",
    ])
  })

  it("maps flag stores to modify payloads (\\Seen inverts)", () => {
    expect(labelChangesForFlags(["\\Seen"], true)).toEqual({
      addLabelIds: [],
      removeLabelIds: ["UNREAD"],
    })
    expect(labelChangesForFlags(["\\Seen"], false)).toEqual({
      addLabelIds: ["UNREAD"],
      removeLabelIds: [],
    })
    expect(labelChangesForFlags(["\\Flagged"], true)).toEqual({
      addLabelIds: ["STARRED"],
      removeLabelIds: [],
    })
    // Unknown keywords pass through as literal gmail label ids.
    expect(labelChangesForFlags(["$Label1"], true)).toEqual({
      addLabelIds: ["$Label1"],
      removeLabelIds: [],
    })
  })

  it("expands uid sets with ranges bounded and open ranges degrading", () => {
    expect(parseUidSet("5,3,5")).toEqual([3, 5])
    expect(parseUidSet("1:3")).toEqual([1, 2, 3])
    expect(parseUidSet("104:*")).toEqual([104])
    expect(() => parseUidSet("1:9999999")).toThrowError(/expands/)
  })
})

describe("message mapping", () => {
  it("walks nested payload parts into bodies and attachments", () => {
    const message = mapGmailMessage(gmailMessage())

    expect(message.uid).toBe(1700000000000001)
    expect(message.gmailId).toBe("1700000000000001")
    expect(message.gmailThreadId).toBe("th-1700000000000001")
    expect(message.labelIds).toEqual(["INBOX", "UNREAD"])
    expect(message.flags).toEqual([]) // unread, not starred, not draft
    expect(message.messageId).toBe("<msg-1700000000000001@sender.example>")
    expect(message.subject).toBe("Hello")
    expect(message.from).toEqual([
      { name: "Ada Lovelace", email: "ada@example.com" },
    ])
    expect(message.date).toBe(1700000000) // Date header (internalDate fallback)
    expect(message.textBody).toBe("Hello world")
    expect(message.htmlBody).toBe("<p>Hello <b>world</b></p>")
    expect(message.size).toBe(2048)
    expect(message.attachments).toEqual([
      {
        partId: "2",
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 1024,
        contentId: undefined,
        isInline: false,
      },
    ])
  })

  it("captures the List-Unsubscribe header pair verbatim (task 18.3)", () => {
    const message = mapGmailMessage(
      gmailMessage({
        payload: {
          partId: "",
          mimeType: "multipart/mixed",
          headers: [
            { name: "Subject", value: "Digest" },
            {
              name: "List-Unsubscribe",
              value:
                "<https://lists.example.com/u/1>, <mailto:leave@lists.example.com>",
            },
            {
              name: "List-Unsubscribe-Post",
              value: "List-Unsubscribe=One-Click",
            },
          ],
          parts: [textPart("1", "body")],
        },
      })
    )
    expect(message.listUnsubscribe).toBe(
      "<https://lists.example.com/u/1>, <mailto:leave@lists.example.com>"
    )
    expect(message.listUnsubscribePost).toBe("List-Unsubscribe=One-Click")

    // Absent headers stay undefined (the sync stores a NULL headers JSON).
    const bare = mapGmailMessage(gmailMessage())
    expect(bare.listUnsubscribe).toBeUndefined()
    expect(bare.listUnsubscribePost).toBeUndefined()
  })

  it("maps inline attachments with content ids and header dates", () => {
    const message = mapGmailMessage(
      gmailMessage({
        payload: {
          partId: "",
          mimeType: "multipart/related",
          headers: [
            { name: "Date", value: "invalid date" },
            { name: "From", value: "bare@example.com" },
            { name: "Cc", value: "a@x.com, B C <b@x.com>" },
          ],
          parts: [
            textPart("1", "body"),
            {
              partId: "2",
              mimeType: "image/png",
              filename: "logo.png",
              headers: [{ name: "Content-Id", value: "<cid-1>" }],
              body: { attachmentId: "att-1", size: 12 },
            },
          ],
        },
        internalDate: "1700000000123",
      })
    )
    expect(message.attachments).toEqual([
      {
        partId: "2",
        filename: "logo.png",
        mimeType: "image/png",
        size: 12,
        contentId: "cid-1",
        isInline: true,
      },
    ])
    expect(message.date).toBe(1700000000) // internalDate fallback
    expect(message.from).toEqual([{ email: "bare@example.com" }])
    expect(message.cc).toEqual([
      { email: "a@x.com" },
      { name: "B C", email: "b@x.com" },
    ])
  })

  it("handles label-less messages", () => {
    const message = mapGmailMessage(gmailMessage({ labelIds: undefined }))
    expect(message.flags).toEqual(["\\Seen"])
    expect(message.labelIds).toEqual([])
  })

  it("keeps opaque non-numeric message ids verbatim (uid degrades to 0)", () => {
    // Real Gmail ids look like this; Number() would never throw again.
    const message = mapGmailMessage(gmailMessage({ id: "17bec548b2c4e7ca" }))
    expect(message.uid).toBe(0)
    expect(message.gmailId).toBe("17bec548b2c4e7ca")
    expect(message.gmailThreadId).toBe("th-17bec548b2c4e7ca")
  })
})

describe("history delta mapping", () => {
  it("nets adds and deletes in order and collects label flips", () => {
    const delta = mapHistoryDelta([
      {
        messagesAdded: [{ message: { id: "1" } }, { message: { id: "2" } }],
      },
      { messagesDeleted: [{ message: { id: "1" } }] },
      {
        labelsAdded: [{ message: { id: "2" }, labelIds: ["STARRED"] }],
        labelsRemoved: [{ message: { id: "3" }, labelIds: ["UNREAD"] }],
      },
      { messagesAdded: [{ message: { id: "1" } }] }, // delete-then-re-add
    ] satisfies GmailHistoryRecord[])

    expect(delta.addedIds.sort()).toEqual(["1", "2"])
    expect(delta.deletedIds).toEqual([])
    expect(delta.labelChanges).toEqual([
      { messageId: "2", addedLabelIds: ["STARRED"], removedLabelIds: [] },
      { messageId: "3", addedLabelIds: [], removedLabelIds: ["UNREAD"] },
    ])
  })
})

// ---------------------------------------------------------------------------
// Provider against the API client (mocked fetch)
// ---------------------------------------------------------------------------

describe("listFolders", () => {
  it("lists folder-ish labels only, with system roles resolved", async () => {
    freshMock()
    mockLabels(mock, [
      inboxLabel,
      sentLabel,
      trashLabel,
      categoryLabel,
      workLabel,
    ])

    const folders = await provider().listFolders()

    expect(folders.map((folder) => folder.id)).toEqual([
      "INBOX",
      "SENT",
      "TRASH",
      "folder-Work",
    ])
    expect(folders[0]).toMatchObject({ name: "Inbox", specialUse: "inbox" })
    expect(folders[3]).toMatchObject({
      name: "Work",
      path: "Work",
      delimiter: "/",
    })
  })
})

describe("deltaSync", () => {
  function mockProfile(fetchMock: FetchMock, historyId = "9500"): void {
    fetchMock.on("GET", /\/profile$/, () => ({
      json: { emailAddress: "me@gmail.com", historyId },
    }))
  }

  it("requests a full sync when the cursor is null, seeding it from the profile", async () => {
    freshMock()
    mockProfile(mock)

    const result = await provider().deltaSync(null)

    expect(result).toEqual({
      messages: [],
      nextCursor: "9500",
      needsFullSync: true,
    })
    expect(apiCalls(mock)[0].url).toContain("/profile")
  })

  it("maps history adds into full messages and advances the cursor", async () => {
    freshMock()
    mockProfile(mock)
    mock.on("GET", /\/history\?/, () => ({
      json: historyPage(
        [
          {
            messagesAdded: [
              { message: { id: "1700000000000001", threadId: "th-1" } },
            ],
          },
          {
            labelsRemoved: [
              { message: { id: "1700000000000001" }, labelIds: ["UNREAD"] },
            ],
          },
        ],
        { historyId: "9042" }
      ),
    }))
    mock.on("GET", /\/messages\/1700000000000001\?/, () => ({
      json: gmailMessage(),
    }))

    const result = await provider().deltaSync("9000")

    expect(result.needsFullSync).toBe(false)
    expect(result.nextCursor).toBe("9042")
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0].gmailId).toBe("1700000000000001")
    // Exactly one getMessage for the added id.
    expect(mock.callsTo(/\/messages\/1700000000000001\?/)).toHaveLength(1)
  })

  it("fetches each added message once, skipping deleted-in-window ones", async () => {
    freshMock()
    mock.on("GET", /\/history\?/, () => ({
      json: historyPage([
        {
          messagesAdded: [
            { message: { id: "1001" } },
            { message: { id: "1002" } },
            { message: { id: "1003" } },
          ],
        },
        { messagesDeleted: [{ message: { id: "1002" } }] },
      ]),
    }))
    mock.on("GET", /\/messages\/1001\?/, () => ({
      json: gmailMessage({ id: "1001" }),
    }))
    mock.on("GET", /\/messages\/1003\?/, () => ({
      json: gmailMessage({ id: "1003" }),
    }))

    const result = await provider().deltaSync("9000")

    expect(result.messages.map((message) => message.gmailId)).toEqual([
      "1001",
      "1003",
    ])
    expect(mock.callsTo(/\/messages\/100[123]\?/)).toHaveLength(2)
  })

  it("paginates history pages before finalizing the cursor", async () => {
    freshMock()
    mock.on("GET", /\/history\?/, (request) => {
      const pageToken = new URL(request.url).searchParams.get("pageToken")
      if (!pageToken) {
        return {
          json: historyPage(
            [{ messagesAdded: [{ message: { id: "2001" } }] }],
            {
              nextPageToken: "p2",
              historyId: "9090",
            }
          ),
        }
      }
      return {
        json: historyPage([{ messagesAdded: [{ message: { id: "2002" } }] }], {
          historyId: "9100",
        }),
      }
    })
    mock.on("GET", /\/messages\/200[12]\?/, (request) => {
      const id = new URL(request.url).pathname.split("/").at(-1)?.split("?")[0]
      return { json: gmailMessage({ id }) }
    })

    const result = await provider().deltaSync("9000")

    expect(result.nextCursor).toBe("9100")
    expect(result.messages).toHaveLength(2)
  })

  it("falls back to a full sync with a fresh cursor on expired history (404)", async () => {
    freshMock()
    mock.on("GET", /\/history\?/, () => ({
      status: 404,
      json: {
        error: {
          code: 404,
          message: "History not found",
          errors: [{ reason: "notFound" }],
        },
      },
    }))
    mock.on("GET", /\/profile$/, () => ({
      json: { emailAddress: "me@gmail.com", historyId: "9800" },
    }))

    const result = await provider().deltaSync("9000")

    expect(result.needsFullSync).toBe(true)
    expect(result.nextCursor).toBe("9800")
    expect(result.messages).toEqual([])
  })

  it("propagates non-404 history failures", async () => {
    freshMock()
    mock.on("GET", /\/history\?/, () => ({
      status: 500,
      json: { error: { code: 500, message: "Backend error" } },
    }))

    const error = await provider()
      .deltaSync("9000")
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(GmailApiError)
    expect((error as GmailApiError).status).toBe(500)
  })
})

describe("fetchMessages / fetchFlags", () => {
  it("fetches full messages for an explicit uid set", async () => {
    freshMock()
    mock.on("GET", /\/messages\/1001\?/, () => ({
      json: gmailMessage({ id: "1001" }),
    }))
    mock.on("GET", /\/messages\/1002\?/, () => ({
      json: gmailMessage({ id: "1002" }),
    }))

    const result = await provider().fetchMessages("INBOX", {
      uidSet: "1001,1002",
    })

    expect(result.messages.map((message) => message.uid)).toEqual([1001, 1002])
    expect(result.folderStatus).toEqual({
      uidValidity: 1,
      uidNext: 0,
      exists: 0,
      unseen: 0,
    })
  })

  it("fetches the last n messages via messages.list", async () => {
    freshMock()
    mock.on("GET", /\/messages\?/, () => ({
      json: {
        messages: [{ id: "3001" }, { id: "3002" }],
        resultSizeEstimate: 4321,
      },
    }))
    mock.on("GET", /\/messages\/300[12]\?/, (request) => {
      const id = new URL(request.url).pathname.split("/").at(-1)
      return { json: gmailMessage({ id }) }
    })

    const result = await provider().fetchMessages("INBOX", { last: 2 })

    expect(result.messages).toHaveLength(2)
    expect(result.folderStatus.exists).toBe(4321)
    expect(apiCalls(mock)[0].url).toContain("maxResults=2")
  })

  it("fetches flags-only via metadata format", async () => {
    freshMock()
    mock.on("GET", /\/messages\/4001\?/, () => ({
      json: { id: "4001", labelIds: ["INBOX", "STARRED"] },
    }))

    const flags = await provider().fetchFlags("INBOX", { uidSet: "4001" })

    expect(flags).toEqual([{ uid: 4001, flags: ["\\Seen", "\\Flagged"] }])
    expect(apiCalls(mock)[0].url).toContain("format=metadata")
  })
})

describe("flag and label operations", () => {
  function mockModify(fetchMock: FetchMock): void {
    fetchMock.on("POST", /\/modify$/, () => ({ json: { id: "x" } }))
  }

  it("markRead toggles the UNREAD label", async () => {
    freshMock()
    mockModify(mock)
    const refs = [{ folder: "INBOX", uid: 555 }]

    await provider().markRead(refs, true)
    expect(JSON.parse(apiCalls(mock)[0].body ?? "{}")).toEqual({
      removeLabelIds: ["UNREAD"],
    })

    await provider().markRead(refs, false)
    expect(JSON.parse(apiCalls(mock)[1].body ?? "{}")).toEqual({
      addLabelIds: ["UNREAD"],
    })
    expect(apiCalls(mock)[0].url).toContain("/messages/555/modify")
  })

  it("markStarred toggles the STARRED label", async () => {
    freshMock()
    mockModify(mock)

    await provider().markStarred([{ folder: "INBOX", uid: 556 }], true)
    expect(JSON.parse(apiCalls(mock)[0].body ?? "{}")).toEqual({
      addLabelIds: ["STARRED"],
    })

    await provider().markStarred([{ folder: "INBOX", uid: 556 }], false)
    expect(JSON.parse(apiCalls(mock)[1].body ?? "{}")).toEqual({
      removeLabelIds: ["STARRED"],
    })
  })

  it("storeFlags maps through labelChangesForFlags", async () => {
    freshMock()
    mockModify(mock)

    await provider().storeFlags("INBOX", "1:2", ["\\Seen"], true)

    expect(mock.callsTo(/\/modify$/)).toHaveLength(2)
    expect(JSON.parse(apiCalls(mock)[0].body ?? "{}")).toEqual({
      removeLabelIds: ["UNREAD"],
    })
  })

  it("addLabels / removeLabels pass label ids straight through", async () => {
    freshMock()
    mockModify(mock)
    const refs = [{ folder: "INBOX", uid: 557 }]

    await provider().addLabels(refs, ["Label_x"])
    expect(JSON.parse(apiCalls(mock)[0].body ?? "{}")).toEqual({
      addLabelIds: ["Label_x"],
    })

    await provider().removeLabels(refs, ["Label_x"])
    expect(JSON.parse(apiCalls(mock)[1].body ?? "{}")).toEqual({
      removeLabelIds: ["Label_x"],
    })
  })

  it("archive removes INBOX", async () => {
    freshMock()
    mockModify(mock)

    await provider().archive([{ folder: "INBOX", uid: 558 }])

    expect(JSON.parse(apiCalls(mock)[0].body ?? "{}")).toEqual({
      removeLabelIds: ["INBOX"],
    })
  })

  it("trash uses the canonical trash endpoint", async () => {
    freshMock()
    mock.on("POST", /\/messages\/559\/trash$/, () => ({ json: { id: "559" } }))

    await provider().trash([{ folder: "INBOX", uid: 559 }])

    expect(apiCalls(mock)[0].url).toContain("/messages/559/trash")
  })

  it("moveToFolder resolves the destination label and clears other placements", async () => {
    freshMock()
    mockLabels(mock, [inboxLabel, trashLabel, spamLabel, workLabel])
    mockModify(mock)

    await provider().moveToFolder(
      [{ folder: "INBOX", uid: 560 }],
      "folder-Work"
    )

    expect(JSON.parse(apiCalls(mock).at(-1)?.body ?? "{}")).toEqual({
      addLabelIds: ["Label_work"],
      removeLabelIds: ["INBOX", "TRASH", "SPAM"],
    })
  })

  it("moveToFolder keeps the destination placement label", async () => {
    freshMock()
    mockLabels(mock, [inboxLabel, trashLabel, spamLabel])
    mockModify(mock)

    await provider().moveToFolder([{ folder: "Work", uid: 561 }], "INBOX")

    expect(JSON.parse(apiCalls(mock).at(-1)?.body ?? "{}")).toEqual({
      addLabelIds: ["INBOX"],
      removeLabelIds: ["TRASH", "SPAM"],
    })
  })

  it("deleteForever calls messages.delete", async () => {
    freshMock()
    mock.on("DELETE", /\/messages\/562$/, () => ({ json: {} }))

    await provider().deleteForever([{ folder: "TRASH", uid: 562 }])

    expect(apiCalls(mock)[0].method).toBe("DELETE")
    expect(apiCalls(mock)[0].url).toContain("/messages/562")
  })

  it("addresses mutations by the exact providerMessageId, not uid", async () => {
    freshMock()
    mockModify(mock)
    mock.on("POST", /\/messages\/17bec548b2c4e7ca\/trash$/, () => ({
      json: { id: "17bec548b2c4e7ca" },
    }))
    mock.on("DELETE", /\/messages\/17bec548b2c4e7ca$/, () => ({ json: {} }))
    const opaqueId = "17bec548b2c4e7ca"
    const refs = [{ folder: "INBOX", uid: 0, providerMessageId: opaqueId }]

    await provider().markRead(refs, true)
    await provider().trash(refs)
    await provider().deleteForever(refs)

    const calls = apiCalls(mock)
    expect(calls[0].url).toContain(`/messages/${opaqueId}/modify`)
    expect(calls[1].url).toContain(`/messages/${opaqueId}/trash`)
    expect(calls[2].url).toContain(`/messages/${opaqueId}`)
    expect(calls[2].method).toBe("DELETE")
    // uid 0 must never leak into a URL.
    for (const call of calls) expect(call.url).not.toContain("/messages/0")
  })

  it("falls back to String(uid) for legacy refs without providerMessageId", async () => {
    freshMock()
    mockModify(mock)

    await provider().markRead([{ folder: "INBOX", uid: 555 }], true)

    expect(apiCalls(mock)[0].url).toContain("/messages/555/modify")
  })
})

describe("send", () => {
  const sendInput: SendEmailInput = {
    from: { name: "Me User", email: "me@gmail.com" },
    to: [{ name: "Ada", email: "ada@example.com" }],
    cc: [{ email: "cc@example.com" }],
    subject: "Hello",
    textBody: "plain",
    htmlBody: "<p>rich</p>",
    inReplyTo: "<msg-0@example.com>",
    references: "<msg-0@example.com>",
    messageId: "<my-msg-id@gmail.com>",
  }

  it("builds MIME, base64url-encodes it and returns the Message-ID", async () => {
    freshMock()
    mock.on("POST", /\/messages\/send$/, () => ({
      json: { id: "777", threadId: "th-777" },
    }))

    const result = await provider().sendMessage(sendInput)

    expect(result.messageId).toBe("<my-msg-id@gmail.com>")
    expect(apiCalls(mock).at(-1)?.url).toContain("/messages/send")
    const body = JSON.parse(apiCalls(mock).at(-1)?.body ?? "{}") as {
      raw: string
    }
    // Decode the base64url raw back to the RFC 822 text.
    const base64 = body.raw.replace(/-/g, "+").replace(/_/g, "/")
    const raw = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4))
    expect(raw).toContain("From: Me User <me@gmail.com>\r\n")
    expect(raw).toContain("To: Ada <ada@example.com>\r\n")
    expect(raw).toContain("Cc: cc@example.com\r\n")
    expect(raw).toContain("Subject: Hello\r\n")
    expect(raw).toContain("In-Reply-To: <msg-0@example.com>\r\n")
    expect(raw).toContain("Message-ID: <my-msg-id@gmail.com>\r\n")
    expect(raw).toContain("Content-Type: multipart/alternative")
    // The HTML part survives base64 encoding — decode the part bodies.
    const bodies = [
      ...raw.matchAll(
        /Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/g
      ),
    ].map(([, base64]) => atob(base64.replace(/\r\n/g, "")))
    expect(bodies.some((body) => body.includes("rich"))).toBe(true)
    expect(bodies.some((body) => body.includes("plain"))).toBe(true)
  })

  it("generates a Message-ID when the input omits one", async () => {
    freshMock()
    mock.on("POST", /\/messages\/send$/, () => ({ json: { id: "778" } }))

    const result = await provider().sendMessage({
      ...sendInput,
      messageId: undefined,
    })

    expect(result.messageId).toMatch(/^<\d+\.[0-9a-f]+@gmail\.com>$/)
  })
})

describe("appendMessage", () => {
  it("inserts raw MIME, resolving the folder to a label", async () => {
    freshMock()
    mockLabels(mock, [sentLabel, draftLabel])
    mock.on("POST", /\/messages\/insert$/, () => ({ json: { id: "9" } }))

    const raw = new TextEncoder().encode("MIME raw bytes")
    await provider().appendMessage("SENT", raw, [])

    const body = JSON.parse(apiCalls(mock).at(-1)?.body ?? "{}")
    expect(Object.keys(body)).toContain("raw")
    expect(body.labelIds).toEqual(["SENT"])
  })

  it("maps the \\Draft flag to the DRAFT label", async () => {
    freshMock()
    mockLabels(mock, [draftLabel])
    mock.on("POST", /\/messages\/insert$/, () => ({ json: { id: "9" } }))

    await provider().appendMessage(
      "Drafts",
      new TextEncoder().encode("draft"),
      ["\\Draft"]
    )

    const body = JSON.parse(apiCalls(mock).at(-1)?.body ?? "{}")
    expect(body.labelIds).toEqual(["DRAFT"])
  })
})

describe("testConnection", () => {
  it("round-trips getProfile", async () => {
    freshMock()
    mock.on("GET", /\/profile$/, () => ({
      json: { emailAddress: "me@gmail.com", historyId: "9000" },
    }))

    const result = await provider().testConnection()

    expect(result).toEqual({
      success: true,
      message: "Connected to Gmail as me@gmail.com",
    })
  })

  it("flags auth failures for the account auth-error task", async () => {
    freshMock()
    mock.on("GET", /\/profile$/, () => ({ status: 401, json: {} }))
    mock.on("POST", "https://oauth2.googleapis.com/token", () => ({
      status: 400,
      json: { error: "invalid_grant" },
    }))

    const result = await provider().testConnection()

    expect(result.success).toBe(false)
    expect(result.authError).toBe(true)
    expect(result.message).not.toContain("rt-1")
  })

  it("reports plain failures without the auth flag", async () => {
    freshMock()
    mock.on("GET", /\/profile$/, () => ({
      status: 500,
      json: { error: { code: 500, message: "Backend error" } },
    }))

    const result = await provider().testConnection()

    expect(result.success).toBe(false)
    expect(result.authError).toBe(false)
    expect(result.message).toContain("500")
  })
})

describe("credentials and registration", () => {
  it("decrypts the credentials_json envelope on first token use", async () => {
    setDefaultKeyStore(createInMemoryKeyStore())
    try {
      const envelopeJson = await encryptCredentials({ refreshToken: "rt-1" })
      const fetchMock = freshMock()
      mockProfileRoute(fetchMock)

      const account = gmailAccount({ credentialsJson: envelopeJson })
      const providerInstance = createGmailProvider(
        account,
        { password: "" },
        { fetchImpl: fetchMock.fetch }
      )
      const result = await providerInstance.testConnection()

      expect(result.success).toBe(true)
      expect(apiCalls(fetchMock)[0].headers.authorization).toBe("Bearer at-1")
    } finally {
      setDefaultKeyStore(null)
    }
  })

  it("rejects accounts without a client id up front", () => {
    freshMock()
    expect(() =>
      createGmailProvider(
        gmailAccount({ oauthClientId: undefined }),
        { password: "" },
        { fetchImpl: mock.fetch, tokenEnvelope: gmailEnvelope }
      )
    ).toThrowError(/oauth_client_id/)
  })

  it("registers itself in the provider factory", async () => {
    registerGmailProvider()
    freshMock()
    mock.on("GET", /\/profile$/, () => ({
      json: { emailAddress: "me@gmail.com", historyId: "1" },
    }))

    const instance = getProvider(gmailAccount(), { password: "" })
    expect(instance.type).toBe("gmail")
    expect(instance.accountId).toBe("acc-g")
    // The factory-built instance authenticates through the same envelope
    // path (no injected envelope → nothing stored → auth error).
    const result = await instance.testConnection()
    expect(result.success).toBe(false)
    expect(result.authError).toBe(true)
  })
})

function mockProfileRoute(fetchMock: FetchMock): void {
  fetchMock.on("GET", /\/profile$/, () => ({
    json: { emailAddress: "me@gmail.com", historyId: "9000" },
  }))
}
