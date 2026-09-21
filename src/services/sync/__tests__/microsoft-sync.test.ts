import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"

import { createMicrosoftGraphProvider } from "../../email/microsoft-graph-provider"
import { getAccount } from "../../db/accounts"
import { clearMicrosoftTokenCache } from "../../email/microsoft-token-manager"
import { createFetchMock } from "../../email/__tests__/gmail-fixtures"
import type { FetchMock } from "../../email/__tests__/gmail-fixtures"
import {
  INBOX_DELTA_LINK_V1,
  INBOX_DELTA_LINK_V2,
  b64,
  deltaPage,
  graphFolder,
  graphMessage,
  graphRemoved,
  microsoftAccount,
  microsoftEnvelope,
  mockEntraTokenSuccess,
  wellKnownFolders,
} from "../../email/__tests__/microsoft-fixtures"
import { syncMicrosoftAccount } from "../microsoft-sync"

/**
 * The engine over the REAL provider, driven entirely through the injected
 * fetch and recorded Graph JSON fixtures (no live network).
 */

describe("syncMicrosoftAccount (fixture-driven Graph)", () => {
  let executor: TestExecutor
  let mock: FetchMock
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    mock = createFetchMock()
    // The in-memory token cache is module-level — keep tests independent.
    clearMicrosoftTokenCache()
    mockEntraTokenSuccess(mock)

    await executor.execute(
      "INSERT INTO accounts (id, type, email, status, oauth_client_id) VALUES ($1, $2, $3, $4, $5)",
      ["acc-ms", "microsoft", "me@outlook.com", "active", "ms-client-123"]
    )
    accountId = "acc-ms"

    // The folder list + the addressable well-known names.
    mock.on("GET", "/me/mailFolders?$top=100", () => ({
      json: { value: wellKnownFolders() },
    }))
    mock.on("GET", "/me/mailFolders/inbox", () => ({
      json: graphFolder({ id: "AQMAinbox==", displayName: "Inbox" }),
    }))
    mock.on("GET", "/me/mailFolders/archive", () => ({
      json: graphFolder({ id: "AQMAarchive==", displayName: "Archive" }),
    }))
    // Default action routes for the pass bookkeeping.
    mock.on("PATCH", "/me/messages/", () => ({ json: {} }))
  })

  afterEach(() => {
    executor.close()
  })

  function buildProvider() {
    return createMicrosoftGraphProvider(
      microsoftAccount({ id: accountId }),
      { password: "" },
      {
        fetchImpl: mock.fetch,
        delayImpl: () => Promise.resolve(),
        tokenEnvelope: microsoftEnvelope,
      }
    )
  }

  function graphCalls(): { method: string; url: string }[] {
    return mock.calls
      .filter((call) => !call.url.includes("login.microsoftonline.com"))
      .map((call) => ({ method: call.method, url: call.url }))
  }

  async function storedMessages(): Promise<
    { id: string; providerId: string | null; folder: string | null; threadId: string }[]
  > {
    return executor.select(
      "SELECT id, gmail_message_id AS providerId, imap_folder AS folder, thread_id AS threadId FROM messages ORDER BY id ASC"
    )
  }

  async function storedCursor(): Promise<Record<string, string>> {
    const row = await getAccount(executor, accountId)
    if (!row?.gmail_history_id) return {}
    return JSON.parse(row.gmail_history_id) as Record<string, string>
  }

  it("runs the initial per-folder pull, threads, labels, and stores the delta links", async () => {
    mock.on("GET", "me/mailFolders/inbox/messages/delta", () => ({
      json: deltaPage(
        [
          graphMessage({ id: "AAMk1==", subject: "Hello" }),
          graphMessage({ id: "AAMk2==", subject: "Second" }),
        ],
        { delta: INBOX_DELTA_LINK_V1 }
      ),
    }))
    mock.on("GET", "me/mailFolders/archive/messages/delta", () => ({
      json: deltaPage([], { delta: "https://graph.microsoft.com/v1.0/me/mailFolders/archive/messages/delta?$deltatoken=arch1" }),
    }))
    mock.on("GET", "AQMAprojects%3D%3D/messages/delta", () => ({
      json: deltaPage([], {
        delta: "https://graph.microsoft.com/v1.0/me/mailFolders/AQMAprojects%3D%3D/messages/delta?$deltatoken=proj1",
      }),
    }))
    mock.on("GET", "/me/messages/AAMk1%3D%3D?$select=", () => ({
      json: graphMessage({ id: "AAMk1==" }),
    }))
    mock.on("GET", "/me/messages/AAMk2%3D%3D?$select=", () => ({
      json: graphMessage({ id: "AAMk2==", inReplyTo: "<root>", references: "<root>" }),
    }))

    const summary = await syncMicrosoftAccount({
      executor,
      provider: buildProvider(),
      accountId,
    })

    // Both messages stored, keyed by Graph id with the folder path.
    const messages = await storedMessages()
    expect(messages).toHaveLength(2)
    expect(messages.map((m) => m.providerId)).toEqual(["AAMk1==", "AAMk2=="])
    expect(new Set(messages.map((m) => m.folder))).toEqual(new Set(["Inbox"]))

    // The two messages share ONE thread via the References chain.
    expect(new Set(messages.map((m) => m.threadId)).size).toBe(1)

    // Labels rows exist for the folders (system Inbox/Archive + user).
    const labels = await executor.select<{ name: string; type: string }>(
      "SELECT name, type FROM labels WHERE account_id = $1 ORDER BY name ASC",
      [accountId]
    )
    expect(labels.map((row) => row.name)).toEqual(
      expect.arrayContaining(["Inbox", "Archive", "Projects"])
    )

    // Per-folder deltaLinks persisted on the account's cursor column.
    const cursor = await storedCursor()
    expect(cursor.Inbox).toBe(INBOX_DELTA_LINK_V1)

    // A seed pass never announces.
    expect(summary.newMessages).toBe(0)
    expect(summary.foldersSynced).toBe(3)
    expect(summary.errors).toEqual([])
  })

  it("reuses the stored deltaLink on the next pass and applies only the delta", async () => {
    // Pass 1: initial pull with one message.
    mock.on("GET", "me/mailFolders/inbox/messages/delta", (request) => {
      if (request.url.includes("$deltatoken")) {
        return { status: 404, json: {} }
      }
      return {
        json: deltaPage([graphMessage({ id: "AAMk1==" })], {
          delta: INBOX_DELTA_LINK_V1,
        }),
      }
    })
    mock.on("GET", "/me/messages/AAMk1%3D%3D?$select=", () => ({
      json: graphMessage({ id: "AAMk1==" }),
    }))
    mock.on("GET", "me/mailFolders/archive/messages/delta", () => ({
      json: deltaPage([], { delta: "https://graph.microsoft.com/v1.0/me/mailFolders/archive/messages/delta?$deltatoken=arch1" }),
    }))
    mock.on("GET", "AQMAprojects%3D%3D/messages/delta", () => ({
      json: deltaPage([], { delta: "https://graph.microsoft.com/v1.0/me/mailFolders/AQMAprojects%3D%3D/messages/delta?$deltatoken=proj1" }),
    }))
    const first = await syncMicrosoftAccount({
      executor,
      provider: buildProvider(),
      accountId,
    })
    expect(first.newMessages).toBe(0)

    // Pass 2: the stored link replays; one new message arrives.
    mock.on("GET", "$deltatoken=v1", () => ({
      json: deltaPage(
        [graphMessage({ id: "AAMk2==", subject: "New arrival", isRead: true })],
        { delta: INBOX_DELTA_LINK_V2 }
      ),
    }))
    mock.on("GET", "/me/messages/AAMk2%3D%3D?$select=", () => ({
      json: graphMessage({ id: "AAMk2==", isRead: true }),
    }))
    const second = await syncMicrosoftAccount({
      executor,
      provider: buildProvider(),
      accountId,
    })
    // Delta arrivals ARE new mail (only the seed/backfill stays silent).
    expect(second.newMessages).toBe(1)

    // The replay hit the stored link, not the path form.
    const deltaReplays = graphCalls().filter((call) =>
      call.url.includes("$deltatoken=v1")
    )
    expect(deltaReplays.length).toBeGreaterThanOrEqual(1)

    // The cursor advanced to v2.
    expect((await storedCursor()).Inbox).toBe(INBOX_DELTA_LINK_V2)
    expect(await storedMessages()).toHaveLength(2)
  })

  it("re-pulls a folder as a silent backfill when the deltaLink is rejected (410)", async () => {
    mock.on("GET", "me/mailFolders/inbox/messages/delta", (request) => {
      if (request.url.includes("$deltatoken=v1")) {
        return {
          status: 410,
          json: { error: { code: "ErrorSyncStateNotFound", message: "expired" } },
        }
      }
      if (request.url.includes("$deltatoken")) {
        return { status: 404, json: {} }
      }
      return {
        json: deltaPage([graphMessage({ id: "AAMk1==" })], {
          delta: INBOX_DELTA_LINK_V1,
        }),
      }
    })
    mock.on("GET", "/me/messages/AAMk1%3D%3D?$select=", () => ({
      json: graphMessage({ id: "AAMk1==" }),
    }))
    mock.on("GET", "me/mailFolders/archive/messages/delta", () => ({
      json: deltaPage([], { delta: "https://graph.microsoft.com/v1.0/me/mailFolders/archive/messages/delta?$deltatoken=arch1" }),
    }))
    mock.on("GET", "AQMAprojects%3D%3D/messages/delta", () => ({
      json: deltaPage([], { delta: "https://graph.microsoft.com/v1.0/me/mailFolders/AQMAprojects%3D%3D/messages/delta?$deltatoken=proj1" }),
    }))

    const summary = await syncMicrosoftAccount({
      executor,
      provider: buildProvider(),
      accountId,
    })
    expect(summary.errors).toEqual([])
    expect(await storedMessages()).toHaveLength(1)
    expect((await storedCursor()).Inbox).toBe(INBOX_DELTA_LINK_V1)
  })

  it("applies @removed tombstones: local rows and emptied threads are dropped", async () => {
    mock.on("GET", "me/mailFolders/inbox/messages/delta", () => ({
      json: deltaPage(
        [graphMessage({ id: "AAMk1==" }), graphRemoved("AAMk2==")],
        { delta: INBOX_DELTA_LINK_V1 }
      ),
    }))
    mock.on("GET", "/me/messages/AAMk1%3D%3D?$select=", () => ({
      json: graphMessage({ id: "AAMk1==" }),
    }))
    mock.on("GET", "me/mailFolders/archive/messages/delta", () => ({
      json: deltaPage([], { delta: "https://graph.microsoft.com/v1.0/me/mailFolders/archive/messages/delta?$deltatoken=arch1" }),
    }))
    mock.on("GET", "AQMAprojects%3D%3D/messages/delta", () => ({
      json: deltaPage([], { delta: "https://graph.microsoft.com/v1.0/me/mailFolders/AQMAprojects%3D%3D/messages/delta?$deltatoken=proj1" }),
    }))

    // Seed a local row for AAMk2== (synced on an earlier pass) whose
    // thread holds ONLY that message.
    await executor.execute(
      `INSERT INTO threads (id, account_id, subject) VALUES ($1, $2, 'Doomed')`,
      ["th-doomed", accountId]
    )
    await executor.execute(
      `INSERT INTO messages (
         id, thread_id, account_id, gmail_message_id, imap_folder, date, is_read, is_flagged, has_attachments
       ) VALUES ($1, $2, $3, $4, $5, 1700000000, 0, 0, 0)`,
      ["mm-doomed-row", "th-doomed", accountId, "AAMk2==", "Inbox"]
    )

    const summary = await syncMicrosoftAccount({
      executor,
      provider: buildProvider(),
      accountId,
    })
    expect(summary.removedMessages).toBe(1)

    // The tombstoned row and its emptied thread are gone.
    const remaining = await storedMessages()
    expect(remaining.map((m) => m.providerId)).toEqual(["AAMk1=="])
    const doomed = await executor.select<{ id: string }>(
      "SELECT id FROM threads WHERE id = 'th-doomed'"
    )
    expect(doomed).toEqual([])
  })

  it("collects per-folder errors and still syncs the remaining folders", async () => {
    mock.on("GET", "me/mailFolders/inbox/messages/delta", () => ({
      status: 500,
      json: { error: { code: "InternalServerError", message: "boom" } },
    }))
    mock.on("GET", "me/mailFolders/archive/messages/delta", () => ({
      json: deltaPage([graphMessage({ id: "AAMka==" })], {
        delta: "https://graph.microsoft.com/v1.0/me/mailFolders/archive/messages/delta?$deltatoken=arch1",
      }),
    }))
    mock.on("GET", "/me/messages/AAMka%3D%3D?$select=", () => ({
      json: graphMessage({ id: "AAMka==", parentFolderId: "AQMAarchive==" }),
    }))
    mock.on("GET", "AQMAprojects%3D%3D/messages/delta", () => ({
      json: deltaPage([], { delta: "https://graph.microsoft.com/v1.0/me/mailFolders/AQMAprojects%3D%3D/messages/delta?$deltatoken=proj1" }),
    }))

    const summary = await syncMicrosoftAccount({
      executor,
      provider: buildProvider(),
      accountId,
    })
    expect(summary.foldersSynced).toBe(2)
    expect(summary.errors).toHaveLength(1)
    expect(summary.errors[0]).toContain("Inbox")
    expect(summary.errors[0]).toContain("boom")
  })

  it("propagates credential failures (invalid_grant) for the auth-error pause", async () => {
    // Replace the success token route with invalid_grant (latest wins).
    mock.on("POST", "login.microsoftonline.com", () => ({
      status: 400,
      json: { error: "invalid_grant", error_description: "token expired" },
    }))
    // Clear the token manager cache via a fresh provider is not enough —
    // the envelope has no access token so the first getToken refreshes.
    await expect(
      syncMicrosoftAccount({
        executor,
        provider: buildProvider(),
        accountId,
      })
    ).rejects.toThrow(/invalid_grant/)
  })

  it("attachment metadata lands in the attachments table for later $value fetches", async () => {
    mock.on("GET", "me/mailFolders/inbox/messages/delta", () => ({
      json: deltaPage([graphMessage({ id: "AAMkatt==" })], {
        delta: INBOX_DELTA_LINK_V1,
      }),
    }))
    mock.on("GET", "/me/messages/AAMkatt%3D%3D?$select=", () => ({
      json: graphMessage({
        id: "AAMkatt==",
        attachments: [
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            id: "att-x1",
            name: "report.pdf",
            contentType: "application/pdf",
            size: 3,
            contentBytes: b64("PDF"),
          },
        ],
      }),
    }))
    mock.on("GET", "me/mailFolders/archive/messages/delta", () => ({
      json: deltaPage([], { delta: "https://graph.microsoft.com/v1.0/me/mailFolders/archive/messages/delta?$deltatoken=arch1" }),
    }))
    mock.on("GET", "AQMAprojects%3D%3D/messages/delta", () => ({
      json: deltaPage([], { delta: "https://graph.microsoft.com/v1.0/me/mailFolders/AQMAprojects%3D%3D/messages/delta?$deltatoken=proj1" }),
    }))

    await syncMicrosoftAccount({
      executor,
      provider: buildProvider(),
      accountId,
    })
    const attachments = await executor.select<{
      filename: string
      provider_part_id: string | null
    }>(
      `SELECT filename, provider_part_id FROM attachments WHERE account_id = $1`,
      [accountId]
    )
    expect(attachments).toEqual([
      { filename: "report.pdf", provider_part_id: "att-x1" },
    ])
  })
})
