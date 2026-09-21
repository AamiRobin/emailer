import { beforeEach, describe, expect, it } from "vitest"

import {
  MAX_THROTTLE_RETRIES,
  THROTTLE_BASE_MS,
  createGraphClient,
  validatedGraphLink,
} from "../graph-api"
import type { GraphClientDeps, GraphFolder } from "../graph-api"
import { ProviderAuthError } from "../types"
import type { MessageRef } from "../types"
import {
  createMicrosoftGraphProvider,
  patchesForFlags,
  flagsForGraphMessage,
  graphFolderToFolder,
  graphMessageFromSendInput,
  mapDeltaPageEntries,
  mapGraphMessage,
  parseGraphDeltaCursor,
  recipientToAddress,
  graphDateToSeconds,
  registerMicrosoftGraphProvider,
} from "../microsoft-graph-provider"
import type { MicrosoftGraphProviderDeps } from "../microsoft-graph-provider"
import { getProvider } from "../provider-factory"
import {
  INBOX_DELTA_LINK_V1,
  INBOX_DELTA_LINK_V2,
  INBOX_DELTA_NEXT,
  b64,
  deltaPage,
  graphFolder,
  graphMessage,
  graphProfile,
  graphRemoved,
  graphCalls,
  microsoftAccount,
  microsoftEnvelope,
  mockEntraTokenSuccess,
  wellKnownFolders,
} from "./microsoft-fixtures"
import { createFetchMock } from "./gmail-fixtures"
import type { FetchMock } from "./gmail-fixtures"

const GRAPH_ROOT = "https://graph.microsoft.com/v1.0"

function ref(id: string): MessageRef {
  return { folder: "Inbox", uid: 0, providerMessageId: `${id}==` }
}

function delayRecorder(): {
  waits: number[]
  delayImpl: (ms: number) => Promise<void>
} {
  const waits: number[] = []
  return {
    waits,
    delayImpl: (ms: number) => {
      waits.push(ms)
      return Promise.resolve()
    },
  }
}

function mockToken(mock: FetchMock): void {
  mockEntraTokenSuccess(mock)
}

/** The folder list plus the addressable well-known names (the rest 404). */
function mockWellKnownFolders(
  mock: FetchMock,
  folders = wellKnownFolders()
): void {
  mock.on("GET", "/me/mailFolders?$top=100", () => ({
    json: { value: folders },
  }))
  mock.on("GET", "/me/mailFolders/inbox", () => ({
    json: graphFolder({ id: "AQMAinbox==", displayName: "Inbox" }),
  }))
  mock.on("GET", "/me/mailFolders/archive", () => ({
    json: graphFolder({ id: "AQMAarchive==", displayName: "Archive" }),
  }))
}

/** Stub one full-message GET (the $select shape graph-api sends). */
function onGraphMessageRoute(mock: FetchMock, id: string): void {
  mock.on("GET", `/me/messages/${encodeURIComponent(id)}?$select=`, () => ({
    json: graphMessage({ id }),
  }))
}

// ---------------------------------------------------------------------------
// Graph client plumbing
// ---------------------------------------------------------------------------

describe("Graph URL/link validation", () => {
  it("accepts absolute v1.0 links on the Graph origin", () => {
    expect(validatedGraphLink(INBOX_DELTA_NEXT)).toBe(INBOX_DELTA_NEXT)
    expect(
      validatedGraphLink("https://graph.microsoft.com/v1.0/me/messages?$top=1")
    ).toBeTruthy()
  })

  it("rejects links off the trusted origin, scheme or API version", () => {
    expect(validatedGraphLink("https://example.test/v1.0/me/events")).toBeNull()
    expect(
      validatedGraphLink("http://graph.microsoft.com/v1.0/me/messages")
    ).toBeNull()
    expect(
      validatedGraphLink(
        "https://attacker.graph.microsoft.com.example.com/v1.0/me"
      )
    ).toBeNull()
    expect(
      validatedGraphLink("https://graph.microsoft.com/beta/me/messages")
    ).toBeNull()
    expect(validatedGraphLink("not a url")).toBeNull()
  })
})

describe("Graph client over the injected fetch", () => {
  function buildClient(mock: FetchMock, waits: number[] = []) {
    const deps: GraphClientDeps = {
      accountId: "acc-m",
      getToken: async (force) => (force ? "ms-at-forced" : "ms-at-1"),
      fetchImpl: mock.fetch,
      delayImpl: (ms) => {
        waits.push(ms)
        return Promise.resolve()
      },
    }
    return createGraphClient(deps)
  }

  it("sends the bearer token and follows validated nextLink pages", async () => {
    const mock = createFetchMock()
    mock.on("GET", "/me/mailFolders?$top=100", () => ({
      json: {
        value: [graphFolder({ id: "f1", displayName: "Inbox" })],
        "@odata.nextLink": `${GRAPH_ROOT}/me/mailFolders?$top=100&$skiptoken=2`,
      },
    }))
    mock.on("GET", "$skiptoken=2", () => ({
      json: { value: [graphFolder({ id: "f2", displayName: "Work" })] },
    }))
    const folders = await buildClient(mock).listFolders()
    expect(folders.map((folder) => folder.id)).toEqual(["f1", "f2"])
    for (const call of mock.calls) {
      expect(call.headers.authorization).toBe("Bearer ms-at-1")
    }
  })

  it("walks childFolders recursively, follows nextLink at every level and survives a parent cycle", async () => {
    const mock = createFetchMock()
    const folder = (
      id: string,
      displayName: string,
      parentFolderId: string,
      childFolderCount = 0
    ): GraphFolder => ({
      id,
      displayName,
      parentFolderId,
      childFolderCount,
    })
    // Top level: Inbox reports children; Leaf is a childless sibling.
    mock.on("GET", "/me/mailFolders?$top=100", () => ({
      json: {
        value: [
          folder("inbox", "Inbox", "root", 1),
          folder("leaf", "Leaf", "root"),
        ],
      },
    }))
    // Inbox's children arrive paginated (nextLink at the child level).
    mock.on("GET", "me/mailFolders/inbox/childFolders?$top=100", () => ({
      json: {
        value: [folder("f2024", "2024", "inbox", 1)],
        "@odata.nextLink": `${GRAPH_ROOT}/me/mailFolders/inbox/childFolders?$top=100&$skiptoken=p2`,
      },
    }))
    mock.on("GET", "$skiptoken=p2", () => ({
      json: { value: [folder("fclients", "Clients", "inbox")] },
    }))
    // A hostile server loop: 2024's child list returns 2024 itself.
    mock.on("GET", "me/mailFolders/f2024/childFolders?$top=100", () => ({
      json: { value: [folder("f2024", "2024", "inbox")] },
    }))
    const folders = await buildClient(mock).listFolders()
    // Nested folders are listed exactly once, in walk order.
    expect(folders.map((entry) => entry.id)).toEqual([
      "inbox",
      "leaf",
      "f2024",
      "fclients",
    ])
    expect(folders.filter((entry) => entry.id === "f2024")).toHaveLength(1)
  })

  it("stops following an off-origin nextLink instead of throwing", async () => {
    const mock = createFetchMock()
    mock.on("GET", "/me/mailFolders?$top=100", () => ({
      json: {
        value: [graphFolder({ id: "f1" })],
        "@odata.nextLink": "https://evil.example/v1.0/me/mailFolders",
      },
    }))
    const folders = await buildClient(mock).listFolders()
    expect(folders).toHaveLength(1)
  })

  it("retries a 401 once with a forced refresh, then raises ProviderAuthError", async () => {
    const mock = createFetchMock()
    let token = "stale"
    const deps: GraphClientDeps = {
      accountId: "acc-m",
      getToken: async (force) => {
        if (force) token = "refreshed"
        return token
      },
      fetchImpl: mock.fetch,
    }
    mock.on("GET", "/me?$select=", () => ({
      status: 401,
      json: { error: { code: "InvalidAuthenticationToken", message: "x" } },
    }))
    await expect(createGraphClient(deps).getProfile()).rejects.toBeInstanceOf(
      ProviderAuthError
    )
    expect(token).toBe("refreshed")
  })

  it("surfaces the Graph error VERBATIM and never the token", async () => {
    const mock = createFetchMock()
    mock.on("GET", "/me?$select=", () => ({
      status: 403,
      json: {
        error: {
          code: "ErrorAccessDenied",
          message: "Access is denied. Check credentials and try again.",
        },
      },
    }))
    const error = await buildClient(mock)
      .getProfile()
      .catch((thrown: unknown) => thrown)
    const message = (error as Error).message
    expect(message).toContain("403")
    expect(message).toContain("ErrorAccessDenied")
    expect(message).toContain("Access is denied. Check credentials and try again.")
    expect(message).not.toContain("ms-at-1")
  })

  it("honors Retry-After on 429 with a bounded wait and retries", async () => {
    const mock = createFetchMock()
    const waits: number[] = []
    let calls = 0
    mock.on("GET", "/me?$select=", () => {
      calls += 1
      if (calls === 1) {
        return {
          status: 429,
          json: { error: { code: "TooManyRequests", message: "slow down" } },
          headers: { "retry-after": "2" },
        }
      }
      return { json: graphProfile() }
    })
    const profile = await buildClient(mock, waits).getProfile()
    expect(profile.mail).toBe("me@outlook.com")
    expect(waits).toEqual([2000])
    expect(calls).toBe(2)
  })

  it("doubles the base delay on 503 without Retry-After and exhausts bounded retries", async () => {
    const mock = createFetchMock()
    const waits: number[] = []
    let calls = 0
    mock.on("GET", "/me?$select=", () => {
      calls += 1
      return { status: 503, json: { error: { message: "unavailable" } } }
    })
    await expect(buildClient(mock, waits).getProfile()).rejects.toBeInstanceOf(
      Error
    )
    expect(calls).toBe(1 + MAX_THROTTLE_RETRIES)
    expect(waits).toEqual([THROTTLE_BASE_MS, THROTTLE_BASE_MS * 2])
  })

  it("getMessageSource reads the raw $value endpoint as text", async () => {
    const mock = createFetchMock()
    mock.on("GET", "/me/messages/AAMkmsg1%3D%3D/$value", () => ({
      text: "MIME-Version: 1.0\r\nSubject: raw\r\n",
    }))
    const source = await buildClient(mock).getMessageSource("AAMkmsg1==")
    expect(source).toContain("Subject: raw")
  })
})

// ---------------------------------------------------------------------------
// Pure mapping helpers
// ---------------------------------------------------------------------------

describe("pure Graph mapping helpers", () => {
  it("maps a full message: flags, headers, recipients, attachments, body", () => {
    const mapped = mapGraphMessage(
      graphMessage({
        id: "AAMkm1==",
        isRead: true,
        flagStatus: "flagged",
        inReplyTo: "<parent@example.com>",
        references: "<root@example.com> <parent@example.com>",
        listUnsubscribe: "<https://lists.example/unsub>",
        htmlContent: "<p>Hi</p>",
        receivedDateTime: "2023-11-14T22:13:20Z",
      })
    )
    expect(mapped.graphId).toBe("AAMkm1==")
    expect(mapped.uid).toBe(0)
    expect(mapped.flags).toEqual(["\\Seen", "\\Flagged"])
    expect(mapped.messageId).toContain("@sender.example")
    expect(mapped.inReplyTo).toBe("<parent@example.com>")
    expect(mapped.references).toBe("<root@example.com> <parent@example.com>")
    expect(mapped.listUnsubscribe).toBe("<https://lists.example/unsub>")
    expect(mapped.listUnsubscribePost).toBe("List-Unsubscribe=One-Click")
    expect(mapped.htmlBody).toBe("<p>Hi</p>")
    expect(mapped.from[0]).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
    })
    expect(mapped.date).toBe(
      Math.floor(Date.parse("2023-11-14T22:13:20Z") / 1000)
    )
    expect(mapped.attachments).toHaveLength(1)
    expect(mapped.attachments[0]?.partId).toContain("att-")
    expect(mapped.graphThreadId).toBeTruthy()
  })

  it("maps a text body and leaves the html slot unset", () => {
    const mapped = mapGraphMessage(
      graphMessage({ textContent: "plain body", htmlContent: undefined })
    )
    expect(mapped.textBody).toBe("plain body")
    expect(mapped.htmlBody).toBeUndefined()
  })

  it("flags mapping is the isRead/flag projection", () => {
    expect(flagsForGraphMessage({ isRead: true })).toEqual(["\\Seen"])
    expect(flagsForGraphMessage({ flag: { flagStatus: "flagged" } })).toEqual([
      "\\Flagged",
    ])
    expect(flagsForGraphMessage({})).toEqual([])
  })

  it("flag stores map to message patches; Graph-less keywords are ignored", () => {
    expect(patchesForFlags(["\\Seen", "\\Flagged", "$Label1"], true)).toEqual([
      { isRead: true },
      { flag: { flagStatus: "flagged" } },
    ])
    expect(patchesForFlags(["\\Seen"], false)).toEqual([{ isRead: false }])
  })

  it("delta page entries split tombstones from added/changed ids", () => {
    const { addedOrChangedIds, removedIds } = mapDeltaPageEntries([
      graphMessage({ id: "keep1" }),
      graphRemoved("gone1"),
      { id: "gone2", "@removed": { reason: "purged" } },
    ])
    expect(addedOrChangedIds).toEqual(["keep1"])
    expect(removedIds).toEqual(["gone1", "gone2"])
  })

  it("cursor maps round-trip and a corrupt cursor parses as empty", () => {
    expect(parseGraphDeltaCursor(null)).toEqual({})
    expect(parseGraphDeltaCursor("")).toEqual({})
    expect(parseGraphDeltaCursor("not json")).toEqual({})
    expect(parseGraphDeltaCursor('["array"]')).toEqual({})
    expect(
      parseGraphDeltaCursor(JSON.stringify({ Inbox: INBOX_DELTA_LINK_V1 }))
    ).toEqual({ Inbox: INBOX_DELTA_LINK_V1 })
  })

  it("folders map to the label model: roles for well-known, user rows otherwise", () => {
    expect(graphFolderToFolder("inbox", "Inbox")).toMatchObject({
      id: "INBOX",
      name: "Inbox",
      type: "system",
      specialUse: "inbox",
      delimiter: "/",
    })
    expect(graphFolderToFolder(null, "Work/Projects")).toMatchObject({
      id: "folder-Work/Projects",
      name: "Projects",
      type: "user",
      specialUse: null,
    })
  })

  it("dates, recipients and send input map to the Graph shapes", () => {
    expect(graphDateToSeconds("2023-11-14T22:13:20Z")).toBeTypeOf("number")
    expect(graphDateToSeconds("nonsense")).toBe(0)
    expect(graphDateToSeconds(undefined)).toBe(0)
    expect(recipientToAddress({ name: "A", address: "a@x.com" })).toEqual({
      name: "A",
      email: "a@x.com",
    })
    expect(recipientToAddress({ address: "a@x.com" })).toEqual({
      email: "a@x.com",
    })
    expect(recipientToAddress(undefined)).toBeNull()
    const message = graphMessageFromSendInput({
      from: { email: "me@outlook.com" },
      to: [{ email: "you@example.com" }],
      cc: [{ name: "C", email: "c@example.com" }],
      subject: "S",
      htmlBody: "<p>b</p>",
      attachments: [
        {
          filename: "f.bin",
          mimeType: "application/octet-stream",
          contentBase64: b64("x"),
        },
      ],
    })
    expect(message.subject).toBe("S")
    expect(message.body).toEqual({ contentType: "html", content: "<p>b</p>" })
    expect(message.attachments).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// The provider, end to end over the mock
// ---------------------------------------------------------------------------

describe("MicrosoftGraphProvider over the fetch mock", () => {
  let mock: FetchMock

  function buildProvider(
    overrides: Partial<MicrosoftGraphProviderDeps> = {}
  ): ReturnType<typeof createMicrosoftGraphProvider> {
    const { delayImpl } = delayRecorder()
    return createMicrosoftGraphProvider(
      microsoftAccount(),
      { password: "" },
      {
        fetchImpl: mock.fetch,
        delayImpl,
        tokenEnvelope: microsoftEnvelope,
        ...overrides,
      }
    )
  }

  beforeEach(() => {
    mock = createFetchMock()
    mockToken(mock)
    // Default action routes (later, more specific registrations win —
    // the router picks the latest match).
    mock.on("PATCH", "/me/messages/", () => ({ json: { id: "patched" } }))
    mock.on("POST", "/move", () => ({ json: { id: "MV9staged" } }))
    mock.on("DELETE", "/me/messages/", () => ({ status: 200, json: {} }))
  })

  it("lists folders with special-use roles and display-name-chain paths", async () => {
    mockWellKnownFolders(mock)
    const folders = await buildProvider().listFolders()
    const inbox = folders.find((folder) => folder.specialUse === "inbox")
    expect(inbox?.path).toBe("Inbox")
    const projects = folders.find((folder) => folder.path === "Projects")
    expect(projects?.type).toBe("user")
    for (const call of graphCalls(mock)) {
      expect(call.headers.authorization).toBe("Bearer ms-at-1")
    }
  })

  it("lists nested subfolders with full display-name-chain paths (two-level tree)", async () => {
    const inbox: GraphFolder = {
      id: "AQMAinbox==",
      displayName: "Inbox",
      parentFolderId: "AQMAroot==",
      childFolderCount: 1,
      totalItemCount: 2,
      unreadItemCount: 1,
    }
    const work: GraphFolder = {
      id: "AQMAwork==",
      displayName: "Work",
      parentFolderId: "AQMAinbox==",
      childFolderCount: 0,
      totalItemCount: 1,
      unreadItemCount: 0,
    }
    mock.on("GET", "/me/mailFolders?$top=100", () => ({
      json: { value: [inbox] },
    }))
    mock.on(
      "GET",
      `/me/mailFolders/${encodeURIComponent("AQMAinbox==")}/childFolders?$top=100`,
      () => ({ json: { value: [work] } })
    )
    mock.on("GET", "/me/mailFolders/inbox", () => ({ json: inbox }))

    const folders = await buildProvider().listFolders()
    expect(folders.map((folder) => folder.path)).toEqual(["Inbox", "Inbox/Work"])
    // The nested folder maps as a user folder whose id carries the full
    // path — messages filed there are reachable by the same resolution
    // the move actions use.
    const nested = folders.find((folder) => folder.path === "Inbox/Work")
    expect(nested).toMatchObject({
      id: "folder-Inbox/Work",
      name: "Work",
      type: "user",
      specialUse: null,
      delimiter: "/",
    })
  })

  it("runs the folder's initial delta pull across pages and returns the deltaLink", async () => {
    mockWellKnownFolders(mock)
    mock.on("GET", "AQMAinbox%3D%3D/messages/delta", (request) => {
      if (request.url.includes("$deltatoken")) {
        return { status: 404, json: {} }
      }
      return {
        json: deltaPage([graphMessage({ id: "AAMkfull1==" })], {
          next: INBOX_DELTA_NEXT,
        }),
      }
    })
    mock.on("GET", "$skiptoken=page2", () => ({
      json: deltaPage([graphMessage({ id: "AAMkfull2==" })], {
        delta: INBOX_DELTA_LINK_V1,
      }),
    }))
    onGraphMessageRoute(mock, "AAMkfull1==")
    onGraphMessageRoute(mock, "AAMkfull2==")

    const result = await buildProvider().syncFolderDelta("AQMAinbox==", null)

    expect(result.needsFullSync).toBe(false)
    expect(result.messages.map((message) => message.graphId)).toEqual([
      "AAMkfull1==",
      "AAMkfull2==",
    ])
    expect(result.nextDeltaLink).toBe(INBOX_DELTA_LINK_V1)
    // Every added id was fetched in FULL (headers/attachments round-trip).
    const fullGets = graphCalls(mock).filter(
      (call) => call.method === "GET" && call.url.includes("?$select=")
    )
    expect(fullGets).toHaveLength(2)
  })

  it("resumes from a stored continuation link after the page cap instead of throwing", async () => {
    mockWellKnownFolders(mock)
    // Every page points at the next — the initial pull can never converge
    // within MAX_DELTA_PAGES (200 iterations of empty pages are cheap).
    mock.on("GET", "AQMAinbox%3D%3D/messages/delta", () => ({
      json: deltaPage([], { next: INBOX_DELTA_NEXT }),
    }))
    mock.on("GET", "$skiptoken=page2", () => ({
      json: deltaPage([], { next: INBOX_DELTA_NEXT }),
    }))

    const first = await buildProvider().syncFolderDelta("AQMAinbox==", null)
    // NOT a throw: what was accumulated stands, and the last nextLink is
    // returned as the continuation cursor for the next pass.
    expect(first.needsFullSync).toBe(false)
    expect(first.nextDeltaLink).toBe(INBOX_DELTA_NEXT)
    // The initial pull requested an explicit page size (Graph's default
    // page is small enough to exhaust the cap before converging).
    const deltaCalls = graphCalls(mock).filter((call) =>
      call.url.includes("messages/delta")
    )
    expect(deltaCalls[0]?.url).toContain("$top=50")

    // Second pass replays the stored continuation link and converges.
    mock.on("GET", "$skiptoken=page2", () => ({
      json: deltaPage([graphMessage({ id: "AAMkres==" })], {
        delta: INBOX_DELTA_LINK_V1,
      }),
    }))
    onGraphMessageRoute(mock, "AAMkres==")
    const second = await buildProvider().syncFolderDelta(
      "AQMAinbox==",
      first.nextDeltaLink
    )
    expect(second.needsFullSync).toBe(false)
    expect(second.messages.map((message) => message.graphId)).toEqual([
      "AAMkres==",
    ])
    expect(second.nextDeltaLink).toBe(INBOX_DELTA_LINK_V1)
  })

  it("replays the stored deltaLink on the reuse round and advances the cursor", async () => {    mockWellKnownFolders(mock)
    mock.on("GET", "$deltatoken=v1", () => ({
      json: deltaPage([graphMessage({ id: "AAMknew1==" })], {
        delta: INBOX_DELTA_LINK_V2,
      }),
    }))
    onGraphMessageRoute(mock, "AAMknew1==")

    const result = await buildProvider().syncFolderDelta(
      "AQMAinbox==",
      INBOX_DELTA_LINK_V1
    )
    expect(result.nextDeltaLink).toBe(INBOX_DELTA_LINK_V2)
    // The replay hit the stored LINK (absolute), never the path form.
    const deltaCalls = graphCalls(mock).filter((call) =>
      call.url.includes("messages/delta")
    )
    expect(deltaCalls).toHaveLength(1)
    expect(deltaCalls[0]?.url).toBe(INBOX_DELTA_LINK_V1)
  })

  it("marks a rejected deltaLink (410 Gone) as needsFullSync", async () => {
    mockWellKnownFolders(mock)
    mock.on("GET", "$deltatoken=v1", () => ({
      status: 410,
      json: {
        error: { code: "ErrorSyncStateNotFound", message: "sync token expired" },
      },
    }))
    const result = await buildProvider().syncFolderDelta(
      "AQMAinbox==",
      INBOX_DELTA_LINK_V1
    )
    expect(result.needsFullSync).toBe(true)
    expect(result.messages).toEqual([])
  })

  it("marks a deltaLink rejected as 400 as needsFullSync too", async () => {
    mockWellKnownFolders(mock)
    mock.on("GET", "$deltatoken=v1", () => ({
      status: 400,
      json: { error: { message: "bad token" } },
    }))
    const result = await buildProvider().syncFolderDelta(
      "AQMAinbox==",
      INBOX_DELTA_LINK_V1
    )
    expect(result.needsFullSync).toBe(true)
  })

  it("marks an off-origin stored deltaLink as needsFullSync without calling it", async () => {
    mockWellKnownFolders(mock)
    const result = await buildProvider().syncFolderDelta(
      "AQMAinbox==",
      "https://evil.example/v1.0/steal"
    )
    expect(result.needsFullSync).toBe(true)
    expect(
      graphCalls(mock).some((call) => call.url.includes("evil.example"))
    ).toBe(false)
  })

  it("deltaSync(null) demands a full sync; a cursor map aggregates folders", async () => {
    mockWellKnownFolders(mock)
    mock.on("GET", "AQMAinbox%3D%3D/messages/delta", () => ({
      json: deltaPage([], { delta: INBOX_DELTA_LINK_V1 }),
    }))
    const provider = buildProvider()
    expect(await provider.deltaSync(null)).toEqual({
      messages: [],
      nextCursor: "",
      needsFullSync: true,
    })

    mock.on("GET", "$deltatoken=v1", () => ({
      json: deltaPage([], { delta: INBOX_DELTA_LINK_V2 }),
    }))
    const delta = await provider.deltaSync(
      JSON.stringify({ Inbox: INBOX_DELTA_LINK_V1 })
    )
    expect(delta.needsFullSync).toBe(false)
    expect(delta.messages).toEqual([])
    expect(JSON.parse(delta.nextCursor)).toEqual({ Inbox: INBOX_DELTA_LINK_V2 })
  })

  it("markRead PATCHes isRead; markStarred PATCHes the flag status", async () => {
    const provider = buildProvider()
    await provider.markRead([ref("m1")], true)
    await provider.markRead([ref("m1")], false)
    await provider.markStarred([ref("m1")], true)
    const patches = graphCalls(mock)
      .filter((call) => call.method === "PATCH")
      .map((call) => JSON.parse(call.body ?? "{}"))
    expect(patches).toEqual([
      { isRead: true },
      { isRead: false },
      { flag: { flagStatus: "flagged" } },
    ])
  })

  it("storeFlags maps \\Seen/\\Flagged per message and ignores keywords", async () => {
    const provider = buildProvider()
    await provider.storeFlags("Inbox", "m1==,m2==", ["\\Seen"], true)
    await provider.storeFlags("Inbox", "m1==", ["$Label1"], true)
    const patches = graphCalls(mock)
      .filter((call) => call.method === "PATCH")
      .map((call) => JSON.parse(call.body ?? "{}"))
    expect(patches).toEqual([{ isRead: true }, { isRead: true }])
  })

  it("archive moves to Archive with a Deleted Items fallback on 404", async () => {
    const provider = buildProvider()
    await provider.archive([ref("m1")])
    expect(moves(mock)).toEqual([{ destinationId: "archive" }])

    mock.on("POST", "/me/messages/m2%3D%3D/move", (request) => {
      const body = JSON.parse(request.body ?? "{}") as { destinationId: string }
      if (body.destinationId === "archive") {
        return {
          status: 404,
          json: { error: { code: "ErrorItemNotFound", message: "no archive" } },
        }
      }
      return { json: { id: "m2==" } }
    })
    await provider.archive([ref("m2")])
    expect(moves(mock)).toContainEqual({ destinationId: "deleteditems" })
  })

  it("trash moves to Deleted Items; deleteForever purges after staging", async () => {
    const provider = buildProvider()
    await provider.trash([ref("m1")])
    expect(moves(mock)).toEqual([{ destinationId: "deleteditems" }])

    await provider.deleteForever([ref("m2")])
    const deletes = graphCalls(mock).filter((call) => call.method === "DELETE")
    expect(deletes).toHaveLength(1)
    // trash (1 staging move) + deleteForever (its own staging move).
    expect(moves(mock)).toHaveLength(2)
  })

  it("moveToFolder resolves a folder path to the Graph folder id", async () => {
    mockWellKnownFolders(mock)
    await buildProvider().moveToFolder([ref("m1")], "Projects")
    expect(moves(mock)).toEqual([{ destinationId: "AQMAprojects==" }])
  })

  it("addLabels/removeLabels are local-only no-ops (Graph has no labels)", async () => {
    const provider = buildProvider()
    await provider.addLabels([ref("m1")], ["Important"])
    await provider.removeLabels([ref("m1")], ["Important"])
    expect(graphCalls(mock)).toHaveLength(0)
  })

  it("sends via the raw-MIME draft path (createDraft → PUT $value → send)", async () => {
    mock.on("POST", "/v1.0/me/messages", () => ({ json: { id: "AAMkdraft==" } }))
    mock.on("PUT", "/me/messages/AAMkdraft%3D%3D/$value", () => ({ json: {} }))
    mock.on("POST", "/me/messages/AAMkdraft%3D%3D/send", () => ({ json: {} }))

    const result = await buildProvider().sendMessage({
      from: { email: "me@outlook.com" },
      to: [{ email: "you@example.com" }],
      subject: "Hello Graph",
      textBody: "body",
      messageId: "<mine@example.com>",
    })
    expect(result.messageId).toBe("<mine@example.com>")

    const put = graphCalls(mock).find((call) => call.method === "PUT")
    expect(put?.url).toContain("/$value")
    expect(put?.body).toContain("Subject: Hello Graph")
    expect(put?.body).toContain("<mine@example.com>")
    // Provider sends never ride the structured sendMail endpoint.
    expect(graphCalls(mock).some((call) => call.url.includes("sendMail"))).toBe(
      false
    )
  })

  it("sends PGP/MIME verbatim through the same draft path", async () => {
    mock.on("POST", "/v1.0/me/messages", () => ({ json: { id: "AAMkdraft==" } }))
    mock.on("PUT", "/me/messages/AAMkdraft%3D%3D/$value", () => ({ json: {} }))
    mock.on("POST", "/me/messages/AAMkdraft%3D%3D/send", () => ({ json: {} }))
    await buildProvider().sendMessage({
      from: { email: "me@outlook.com" },
      to: [{ email: "you@example.com" }],
      subject: "pgp",
      pgpMime:
        "-----BEGIN PGP MESSAGE-----\r\nabc\r\n-----END PGP MESSAGE-----",
    })
    const put = graphCalls(mock).find((call) => call.method === "PUT")
    expect(put?.body).toContain("BEGIN PGP MESSAGE")
  })

  it("appendMessage drafts the MIME and files it into the folder", async () => {
    mockWellKnownFolders(mock)
    mock.on("POST", "/v1.0/me/messages", () => ({
      json: { id: "AAMkdraft2==" },
    }))
    mock.on("PUT", "/me/messages/AAMkdraft2%3D%3D/$value", () => ({ json: {} }))
    const raw = new TextEncoder().encode("Subject: filed\r\n\r\nbody\r\n")
    await buildProvider().appendMessage("Projects", raw, ["\\Seen"])
    const put = graphCalls(mock).find((call) => call.method === "PUT")
    expect(put?.body).toContain("Subject: filed")
    expect(moves(mock)).toEqual([{ destinationId: "AQMAprojects==" }])
  })

  it("getMessageSource returns the raw source string", async () => {
    mock.on("GET", `/me/messages/${encodeURIComponent("m1==")}/$value`, () => ({
      text: "From: a@b\r\nSubject: s\r\n\r\nbody",
    }))
    const source = await buildProvider().getMessageSource(ref("m1"))
    expect(source).toContain("Subject: s")
  })

  it("testConnection reports the profile, the verbatim Graph error, and auth errors", async () => {
    mock.on("GET", "/me?$select=", () => ({ json: graphProfile() }))
    expect(await buildProvider().testConnection()).toEqual({
      success: true,
      message: "Connected to Microsoft 365 as me@outlook.com",
    })

    mock.on("GET", "/me?$select=", () => ({
      status: 401,
      json: {
        error: { code: "InvalidAuthenticationToken", message: "Expired" },
      },
    }))
    const rejected = await buildProvider().testConnection()
    expect(rejected.success).toBe(false)
    expect(rejected.authError).toBe(true)
    expect(rejected.message).toContain("re-authorization is required")
    // The token never leaks into the message.
    expect(rejected.message).not.toContain("ms-at-1")

    mock.on("GET", "/me?$select=", () => ({
      status: 403,
      json: {
        error: {
          code: "ErrorAccessDenied",
          message: "Access is denied. Check credentials and try again.",
        },
      },
    }))
    const graphError = await buildProvider().testConnection()
    expect(graphError.success).toBe(false)
    expect(graphError.authError).toBe(false)
    expect(graphError.message).toContain("ErrorAccessDenied")
    expect(graphError.message).toContain(
      "Access is denied. Check credentials and try again."
    )
  })

  it("fetchMessages returns the recent window fully mapped", async () => {
    mockWellKnownFolders(mock)
    // "Inbox" resolves to its well-known name (addressable in URLs).
    mock.on(
      "GET",
      "me/mailFolders/inbox/messages?$top=10&$orderBy=receivedDateTime",
      () => ({ json: deltaPage([graphMessage({ id: "AAMkw1==" })]) })
    )
    onGraphMessageRoute(mock, "AAMkw1==")
    const page = await buildProvider().fetchMessages("Inbox", { last: 10 })
    expect(page.folderStatus.uidValidity).toBe(1)
    expect(page.messages[0]?.graphId).toBe("AAMkw1==")
  })

  it("registerMicrosoftGraphProvider exposes the provider through the factory", () => {
    registerMicrosoftGraphProvider()
    const provider = getProvider(microsoftAccount(), { password: "" })
    expect(provider.type).toBe("microsoft")
    expect(provider.accountId).toBe("acc-m")
  })

  function moves(afterMock: FetchMock): { destinationId: string }[] {
    return graphCalls(afterMock)
      .filter((call) => call.url.includes("/move"))
      .map((call) => JSON.parse(call.body ?? "{}"))
  }
})
