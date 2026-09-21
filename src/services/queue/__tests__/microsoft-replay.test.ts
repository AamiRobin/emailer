import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createTestExecutor, type TestExecutor } from "../../db/__tests__/test-executor"
import { createMicrosoftGraphProvider } from "../../email/microsoft-graph-provider"
import { clearMicrosoftTokenCache } from "../../email/microsoft-token-manager"
import { createFetchMock } from "../../email/__tests__/gmail-fixtures"
import {
  graphCalls,
  microsoftAccount,
  microsoftEnvelope,
  mockEntraTokenSuccess,
} from "../../email/__tests__/microsoft-fixtures"
import { useOnlineStore } from "../../../stores/online-store"
import { shutdownQueueSystem } from "../index"
import { processQueue, type ProcessQueueOptions } from "../processor"
import {
  enqueueArchive,
  enqueueMarkRead,
  enqueueSend,
  enqueueTrash,
} from "../operation"
import { listPendingOperations } from "../../db/pending-operations"

/**
 * Offline action replay (parity-round-2, the mail-sync spec's "Offline
 * action replay" scenario) against a REAL MicrosoftGraphProvider over the
 * recorded-fetch mock: actions enqueued while "offline" replay as the
 * documented Graph calls (isRead PATCH, move, draft+PUT+send) once the
 * queue drains.
 */

const inboxRef = [{ folder: "Inbox", uid: 0, providerMessageId: "AAMkq1==" }]

describe("offline queue replay through Microsoft Graph", () => {
  let executor: TestExecutor

  beforeEach(async () => {
    executor = createTestExecutor()
    clearMicrosoftTokenCache()
    await executor.execute(
      "INSERT INTO accounts (id, type, email, status, oauth_client_id) VALUES ($1, $2, $3, $4, $5)",
      ["acc-ms", "microsoft", "me@outlook.com", "active", "ms-client-123"]
    )
    useOnlineStore.getState().setOnline(true)
  })

  afterEach(() => {
    shutdownQueueSystem()
    useOnlineStore.getState().setOnline(true)
    executor.close()
  })

  function options(mock: ReturnType<typeof createFetchMock>): ProcessQueueOptions {
    const provider = createMicrosoftGraphProvider(
      microsoftAccount({ id: "acc-ms" }),
      { password: "" },
      {
        fetchImpl: mock.fetch,
        delayImpl: () => Promise.resolve(),
        tokenEnvelope: microsoftEnvelope,
      }
    )
    return {
      executor,
      backoffBaseMs: 0,
      getProviderForTest: () => provider,
    }
  }

  it("replays read/archive/trash/send as Graph calls and drains the queue", async () => {
    const mock = createFetchMock()
    mockEntraTokenSuccess(mock)
    mock.on("PATCH", "/me/messages/", () => ({ json: {} }))
    mock.on("POST", "/move", () => ({ json: { id: "MV1" } }))
    mock.on("POST", "/v1.0/me/messages", () => ({ json: { id: "AAMkd==" } }))
    mock.on("PUT", "/me/messages/AAMkd%3D%3D/$value", () => ({ json: {} }))
    mock.on("POST", "/send", () => ({ json: {} }))

    // "Offline": the actions land in the queue only.
    useOnlineStore.getState().setOnline(false)
    await enqueueMarkRead(executor, "acc-ms", inboxRef)
    await enqueueArchive(executor, "acc-ms", inboxRef)
    await enqueueTrash(executor, "acc-ms", inboxRef)
    await enqueueSend(executor, "acc-ms", {
      from: { email: "me@outlook.com" },
      to: [{ email: "you@example.com" }],
      subject: "Queued on Graph",
      messageId: "<queued@example.com>",
    })
    expect(await listPendingOperations(executor, "acc-ms")).toHaveLength(4)

    // Reconnect: the queue drains through the provider's Graph surface.
    useOnlineStore.getState().setOnline(true)
    const result = await processQueue(options(mock))
    expect(result.succeeded).toBe(4)
    expect(result.failed).toBe(0)
    expect(await listPendingOperations(executor, "acc-ms")).toHaveLength(0)

    const calls = graphCalls(mock)
    // mark_read → isRead PATCH.
    const patch = calls.find((call) => call.method === "PATCH")
    expect(patch?.url).toContain("/me/messages/AAMkq1%3D%3D")
    expect(JSON.parse(patch?.body ?? "{}")).toEqual({ isRead: true })
    // archive → move to the archive well-known folder.
    const moves = calls
      .filter((call) => call.url.includes("/move"))
      .map((call) => JSON.parse(call.body ?? "{}"))
    expect(moves).toContainEqual({ destinationId: "archive" })
    expect(moves).toContainEqual({ destinationId: "deleteditems" })
    // send → draft + PUT $value + send, with the Message-ID preserved.
    const put = calls.find((call) => call.method === "PUT")
    expect(put?.url).toContain("/$value")
    expect(put?.body).toContain("<queued@example.com>")
    expect(calls.some((call) => call.url.endsWith("/send"))).toBe(true)
  })

  it("retries a transient Graph failure and pauses the account on auth errors", async () => {
    const mock = createFetchMock()
    mockEntraTokenSuccess(mock)
    // Every PATCH throttles hard — the op requeues with backoff.
    mock.on("PATCH", "/me/messages/", () => ({
      status: 503,
      json: { error: { code: "MailboxOccupied", message: "busy" } },
    }))
    await enqueueMarkRead(executor, "acc-ms", inboxRef)

    const throttled = await processQueue(options(mock))
    expect(throttled.requeued).toBe(1)
    expect(await listPendingOperations(executor, "acc-ms")).toHaveLength(1)

    // An auth-shaped failure pauses the account instead of consuming the
    // retry budget: the op stays queued for the re-auth flow to resume.
    mock.on("PATCH", "/me/messages/", () => ({
      status: 401,
      json: { error: { code: "Unauthorized", message: "401" } },
    }))
    clearMicrosoftTokenCache()
    const paused = await processQueue(options(mock))
    expect(paused.pausedAccounts).toEqual(["acc-ms"])
    expect(await listPendingOperations(executor, "acc-ms")).toHaveLength(1)
  })
})
