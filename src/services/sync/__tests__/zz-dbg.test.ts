import { describe, it } from "vitest"
import {
  createTestExecutor,
} from "../../db/__tests__/test-executor"
import { createMicrosoftGraphProvider } from "../../email/microsoft-graph-provider"
import { createFetchMock } from "../../email/__tests__/gmail-fixtures"
import {
  INBOX_DELTA_LINK_V1,
  deltaPage,
  graphFolder,
  graphMessage,
  microsoftAccount,
  microsoftEnvelope,
  mockEntraTokenSuccess,
  wellKnownFolders,
} from "../../email/__tests__/microsoft-fixtures"
import { syncMicrosoftAccount } from "../microsoft-sync"

describe("dbg", () => {
  it("engine one pass", async () => {
    const executor = createTestExecutor()
    await executor.execute(
      "INSERT INTO accounts (id, type, email, status, oauth_client_id) VALUES ($1, $2, $3, $4, $5)",
      ["acc-ms", "microsoft", "me@outlook.com", "active", "ms-client-123"]
    )
    const mock = createFetchMock()
    mockEntraTokenSuccess(mock)
    mock.on("GET", "/me/mailFolders?$top=100", () => ({ json: { value: wellKnownFolders() } }))
    mock.on("GET", "/me/mailFolders/inbox", () => ({ json: graphFolder({ id: "AQMAinbox==", displayName: "Inbox" }) }))
    mock.on("GET", "/me/mailFolders/archive", () => ({ json: graphFolder({ id: "AQMAarchive==", displayName: "Archive" }) }))
    mock.on("GET", "AQMAinbox%3D%3D/messages/delta", () => ({
      json: deltaPage([graphMessage({ id: "AAMk1==" })], { delta: INBOX_DELTA_LINK_V1 }),
    }))
    mock.on("GET", "/me/messages/AAMk1%3D%3D?$select=", () => ({
      json: graphMessage({ id: "AAMk1==" }),
    }))
    mock.on("GET", "AQMAarchive%3D%3D/messages/delta", () => ({
      json: deltaPage([], { delta: "https://graph.microsoft.com/v1.0/archive/dl" }),
    }))
    mock.on("GET", "AQMAprojects%3D%3D/messages/delta", () => ({
      json: deltaPage([], { delta: "https://graph.microsoft.com/v1.0/projects/dl" }),
    }))
    const provider = createMicrosoftGraphProvider(microsoftAccount({ id: "acc-ms" }), { password: "" }, {
      fetchImpl: mock.fetch,
      delayImpl: () => Promise.resolve(),
      tokenEnvelope: microsoftEnvelope,
    })
    const summary = await syncMicrosoftAccount({ executor, provider, accountId: "acc-ms" })
    console.log("SUMMARY", JSON.stringify(summary))
    const msgs = await executor.select("SELECT id, gmail_message_id FROM messages")
    console.log("MSGS", JSON.stringify(msgs))
    executor.close()
  })
})
