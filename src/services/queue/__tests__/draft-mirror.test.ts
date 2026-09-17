import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createAccount,
  createImapFolderLabel,
} from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { encryptCredentials } from "../../crypto/credentials"
import { createInMemoryKeyStore } from "../../crypto/__tests__/in-memory-key-store"
import { setDefaultKeyStore } from "../../crypto/key-management"
import {
  draftMessageId,
  getDraft,
  listDrafts,
  saveDraft,
  setDraftServerRef,
  type DraftInput,
} from "../../composer/drafts"
import { sendComposerDraft } from "../../composer/send"
import {
  createFetchMock,
  type FetchMock,
} from "../../email/__tests__/gmail-fixtures"
import type { EmailProvider, FetchMessagesResult } from "../../email/types"
import { base64ToBytes, buildMimeMessage } from "../../email/mime-builder"
import { setImapDraftsFolderPreference } from "../../settings/preferences"
import { useOnlineStore } from "../../../stores/online-store"
import { useDraftAutosave } from "../../composer/use-draft-autosave"
import { processQueue, type ProcessQueueOptions } from "../processor"
import { enqueueDraftDelete, enqueueDraftUpsert } from "../operation"

/**
 * Task 17.x (design D9): the queue's draft_upsert/draft_delete replayed
 * through the REAL draft-mirror execution path with only the transports
 * mocked — gmail REST via createFetchMock, imap via a fake invoke. The
 * first test is the REQUIRED create→edit→send mock-API verification of
 * task 17.1, driven by the real autosave hook.
 */

function decodeRaw(b64url: string): string {
  const base64 = b64url.replace(/-/g, "+").replace(/_/g, "/")
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4)
  return new TextDecoder().decode(base64ToBytes(padded))
}

function draftInput(subject: string): DraftInput {
  return {
    to: [{ email: "alice@example.com" }],
    cc: [],
    bcc: [],
    subject,
    bodyHtml: "<p>Hi</p>",
  }
}

/** Fixture MIME for a draft (what enqueueDraftMirrorUpsert builds). */
function mimeFor(draftId: string, subject: string): string {
  return buildMimeMessage({
    from: { email: "me@example.com" },
    to: [{ email: "alice@example.com" }],
    subject,
    htmlBody: "<p>Hi</p>",
    messageId: draftMessageId(draftId),
  }).mime
}

// ---- Fake provider (send op only — draft mirrors bypass the provider) ----

function createFakeProvider(accountId: string): EmailProvider & {
  calls: string[]
} {
  const calls: string[] = []
  return {
    accountId,
    type: "gmail",
    calls,
    listFolders: vi.fn(async () => []),
    deltaSync: vi.fn(async () => {
      throw new Error("unused")
    }),
    fetchMessages: vi.fn(async (): Promise<FetchMessagesResult> => {
      throw new Error("unused")
    }),
    fetchFlags: vi.fn(async () => []),
    storeFlags: vi.fn(async () => {}),
    markRead: vi.fn(async () => {}),
    markStarred: vi.fn(async () => {}),
    addLabels: vi.fn(async () => {}),
    removeLabels: vi.fn(async () => {}),
    archive: vi.fn(async () => {}),
    trash: vi.fn(async () => {}),
    moveToFolder: vi.fn(async () => {}),
    deleteForever: vi.fn(async () => {}),
    sendMessage: vi.fn(async (input: { subject: string }) => {
      calls.push(`send:${input.subject}`)
      return { messageId: "generated" }
    }),
    appendMessage: vi.fn(async () => {}),
    testConnection: vi.fn(async () => ({ success: true, message: "ok" })),
  }
}

// ---- IMAP invoke fixture (the Rust command layer, faked) ----

interface RecordedInvoke {
  command: string
  args: Record<string, unknown>
}

interface ImapFixtureOptions {
  /** Appended-copy uids served per imap_fetch_messages call, in order. */
  fetchedUids: number[]
  /** Message-ID header echoed on fetched messages (our mirror's). */
  messageId?: string
  /** When set, imap_delete_message rejects with this error text. */
  deleteError?: string
}

function imapInvokeFixture(options: ImapFixtureOptions) {
  const calls: RecordedInvoke[] = []
  let fetchCount = 0
  const invokeImpl = async (
    command: string,
    args: Record<string, unknown>
  ): Promise<unknown> => {
    calls.push({ command, args })
    if (command === "imap_fetch_messages") {
      const uid =
        options.fetchedUids[
          Math.min(fetchCount, options.fetchedUids.length - 1)
        ]
      fetchCount += 1
      return {
        messages: [
          {
            uid,
            flags: [],
            messageId: options.messageId ?? null,
            inReplyTo: null,
            references: null,
            subject: "Hi",
            from: [],
            to: [],
            cc: [],
            bcc: [],
            date: 0,
            textBody: "Hi",
            htmlBody: null,
            size: 10,
            attachments: [],
          },
        ],
        folderStatus: {
          uidValidity: 1,
          uidNext: uid + 1,
          exists: 1,
          unseen: 0,
        },
      }
    }
    if (command === "imap_delete_message" && options.deleteError) {
      throw new Error(options.deleteError)
    }
    return undefined
  }
  return { calls, invokeImpl }
}

describe("queue draft mirroring (design D9, task 17.x)", () => {
  let executor: TestExecutor
  let gmailAccountId: string
  let imapAccountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    setDefaultKeyStore(createInMemoryKeyStore())
    gmailAccountId = await createAccount(executor, "gmail")
    imapAccountId = await createAccount(executor, "imap")

    // Gmail: OAuth envelope with a still-valid access token (no token
    // endpoint round-trip) plus the client id the client builders require.
    const gmailEnvelope = await encryptCredentials({
      refreshToken: "rt-1",
      accessToken: "at-1",
      accessTokenExpiresAt: Date.now() + 3_600_000,
    })
    await executor.execute(
      "UPDATE accounts SET credentials_json = $1, oauth_client_id = $2 WHERE id = $3",
      [gmailEnvelope, "client-123", gmailAccountId]
    )
    // IMAP: password envelope + connection config.
    const imapEnvelope = await encryptCredentials({ password: "app-secret" })
    await executor.execute(
      `UPDATE accounts SET credentials_json = $1,
         imap_host = $2, imap_port = $3, imap_security = $4
       WHERE id = $5`,
      [imapEnvelope, "imap.example.com", 993, "tls", imapAccountId]
    )
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    useOnlineStore.getState().setOnline(true)
    setDefaultKeyStore(null)
    executor.close()
  })

  function options(extra?: Partial<ProcessQueueOptions>): ProcessQueueOptions {
    return {
      executor,
      backoffBaseMs: 0,
      getProviderForTest: (id) => createFakeProvider(id),
      ...extra,
    }
  }

  /** Advance the autosave clock (polls + debounce + async writes). */
  async function advanceAutosave(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms)
    })
  }

  // ------------------------------------------------------------------
  // Gmail mock-API replay (task 17.1)
  // ------------------------------------------------------------------

  describe("gmail Drafts API replay", () => {
    it("runs create → update → send → server-draft delete against the mocked API", async () => {
      const mock: FetchMock = createFetchMock()
      let createdCount = 0
      mock.on("POST", /\/drafts$/, () => {
        createdCount += 1
        return { json: { id: `draft-${createdCount}` } }
      })
      mock.on("PUT", /\/drafts\/draft-1$/, () => ({ json: { id: "draft-1" } }))
      mock.on("DELETE", /\/drafts\/draft-1$/, () => ({}))

      // 1. CREATE: the real autosave hook saves and enqueues the mirror
      //    upsert; the processor runs against the mocked gmail fetch.
      vi.useFakeTimers()
      let currentInput = draftInput("seed")
      renderHook(() =>
        useDraftAutosave({
          accountId: gmailAccountId,
          draftKey: "composer-1",
          getDraftInput: () => currentInput,
          executor,
        })
      )
      await advanceAutosave(1_000) // first poll primes the baseline

      currentInput = draftInput("v1")
      // Poll observes the change (≤1s), then the 3s debounce fires the write.
      await advanceAutosave(4_100)

      await processQueue(
        options({ draftMirrorForTest: { fetchImpl: mock.fetch } })
      )

      expect(createdCount).toBe(1)
      const createCall = mock.calls.find(
        (call) => call.method === "POST" && /\/drafts$/.test(call.url)
      )
      expect(createCall).toBeDefined()
      const createdMime = decodeRaw(
        (JSON.parse(createCall!.body ?? "{}") as { message: { raw: string } })
          .message.raw
      )
      expect(createdMime).toContain("Subject: v1")
      const saved = (await listDrafts(executor, gmailAccountId))[0]
      expect(createdMime).toContain(`Message-ID: ${draftMessageId(saved.id)}`)
      // The create-returned draft id is stored as the row's mirror ref.
      expect(saved.serverDraftRef).toEqual({
        provider: "gmail",
        draftId: "draft-1",
      })

      // 2. EDIT: second autosave → updateDraft through the stored ref.
      currentInput = draftInput("v2")
      await advanceAutosave(4_100)

      await processQueue(
        options({ draftMirrorForTest: { fetchImpl: mock.fetch } })
      )

      const updateCall = mock.calls.find((call) => call.method === "PUT")
      expect(updateCall).toBeDefined()
      expect(updateCall!.url).toBe(
        "https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft-1"
      )
      expect(
        decodeRaw(
          (JSON.parse(updateCall!.body ?? "{}") as { message: { raw: string } })
            .message.raw
        )
      ).toContain("Subject: v2")
      // Still exactly one server draft — the update replaced the create.
      expect(createdCount).toBe(1)

      // 3. SEND: the send flow deletes the draft (its ref rides along);
      //    FIFO replay transmits the send first, then the draft delete.
      const provider = createFakeProvider(gmailAccountId)
      const send = await sendComposerDraft({
        executor,
        accountId: gmailAccountId,
        payload: {
          to: [{ email: "alice@example.com" }],
          cc: [],
          bcc: [],
          subject: "v2",
          htmlBody: "<p>Hi</p>",
          textBody: "Hi",
        },
        draftId: saved.id,
      })
      expect(send.status).toBe("queued")

      await processQueue({
        executor,
        backoffBaseMs: 0,
        getProviderForTest: () => provider,
        draftMirrorForTest: { fetchImpl: mock.fetch },
      })

      expect(provider.calls).toEqual(["send:v2"])
      // The REQUIRED call sequence: create → update → delete.
      expect(mock.calls.map((call) => call.method)).toEqual([
        "POST",
        "PUT",
        "DELETE",
      ])
      expect(mock.calls[2].url).toBe(
        "https://gmail.googleapis.com/gmail/v1/users/me/drafts/draft-1"
      )
      // The local row went with the send.
      expect(await getDraft(executor, saved.id)).toBeNull()
    })

    it("recreates the mirror (fresh ref) when the stored draft id is gone server-side", async () => {
      const mock = createFetchMock()
      mock.on("PUT", /\/drafts\/stale/, () => ({
        status: 404,
        json: { error: { code: 404, message: "gone" } },
      }))
      mock.on("POST", /\/drafts$/, () => ({ json: { id: "draft-fresh" } }))

      const saved = await saveDraft(executor, {
        accountId: gmailAccountId,
        draftKey: "composer-1",
        draft: draftInput("v1"),
      })
      await setDraftServerRef(executor, saved.id, {
        provider: "gmail",
        draftId: "stale",
      })
      await enqueueDraftUpsert(executor, {
        accountId: gmailAccountId,
        draftId: saved.id,
        mime: mimeFor(saved.id, "v1"),
      })

      await processQueue(
        options({ draftMirrorForTest: { fetchImpl: mock.fetch } })
      )

      expect(mock.calls.map((call) => call.method)).toEqual(["PUT", "POST"])
      expect((await getDraft(executor, saved.id))?.serverDraftRef).toEqual({
        provider: "gmail",
        draftId: "draft-fresh",
      })
    })

    it("treats a 404 draft_delete as applied (already gone)", async () => {
      const mock = createFetchMock()
      mock.on("DELETE", /\/drafts\/gone/, () => ({
        status: 404,
        json: { error: { code: 404, message: "gone" } },
      }))

      await enqueueDraftDelete(executor, {
        accountId: gmailAccountId,
        ref: { provider: "gmail", draftId: "gone" },
      })
      const result = await processQueue(
        options({ draftMirrorForTest: { fetchImpl: mock.fetch } })
      )

      expect(result.succeeded).toBe(1)
      expect(mock.calls[0].method).toBe("DELETE")
    })

    it("skips the upsert when the draft row was discarded before replay", async () => {
      const mock = createFetchMock()

      await enqueueDraftUpsert(executor, {
        accountId: gmailAccountId,
        draftId: "vanishing-row",
        mime: mimeFor("vanishing-row", "v1"),
      })

      const result = await processQueue(
        options({ draftMirrorForTest: { fetchImpl: mock.fetch } })
      )

      expect(result.succeeded).toBe(1)
      expect(mock.calls).toEqual([])
    })
  })

  // ------------------------------------------------------------------
  // IMAP APPEND replay (task 17.2)
  // ------------------------------------------------------------------

  describe("imap APPEND replay", () => {
    it("appends to the mapped drafts-role folder, locates the uid, and stores the ref", async () => {
      await createImapFolderLabel(
        executor,
        imapAccountId,
        "Archive/Drafts",
        "drafts"
      )
      const saved = await saveDraft(executor, {
        accountId: imapAccountId,
        draftKey: "composer-1",
        draft: draftInput("v1"),
      })
      const fixture = imapInvokeFixture({
        fetchedUids: [44],
        messageId: draftMessageId(saved.id),
      })
      await enqueueDraftUpsert(executor, {
        accountId: imapAccountId,
        draftId: saved.id,
        mime: mimeFor(saved.id, "v1"),
      })

      const result = await processQueue(
        options({ draftMirrorForTest: { invokeImpl: fixture.invokeImpl } })
      )

      expect(result.succeeded).toBe(1)
      const append = fixture.calls.find(
        (call) => call.command === "imap_append"
      )
      expect(append).toBeDefined()
      expect(append!.args.folder).toBe("Archive/Drafts")
      expect(append!.args.flags).toEqual(["\\Draft"])
      expect(
        new TextDecoder().decode(
          new Uint8Array(append!.args.message as number[])
        )
      ).toContain("Subject: v1")
      // The appended copy's uid (matched by the stable Message-ID over the
      // folder's newest messages) is the stored ref.
      expect((await getDraft(executor, saved.id))?.serverDraftRef).toEqual({
        provider: "imap",
        folder: "Archive/Drafts",
        uid: 44,
      })
    })

    it("falls back to a folder literally named Drafts when no drafts-role folder exists", async () => {
      const saved = await saveDraft(executor, {
        accountId: imapAccountId,
        draftKey: "composer-1",
        draft: draftInput("v1"),
      })
      const fixture = imapInvokeFixture({
        fetchedUids: [7],
        messageId: draftMessageId(saved.id),
      })
      await enqueueDraftUpsert(executor, {
        accountId: imapAccountId,
        draftId: saved.id,
        mime: mimeFor(saved.id, "v1"),
      })

      await processQueue(
        options({ draftMirrorForTest: { invokeImpl: fixture.invokeImpl } })
      )

      expect(
        fixture.calls.find((call) => call.command === "imap_append")?.args
          .folder
      ).toBe("Drafts")
      expect((await getDraft(executor, saved.id))?.serverDraftRef).toEqual({
        provider: "imap",
        folder: "Drafts",
        uid: 7,
      })
    })

    it("prefers the per-account settings override over the mapped folder", async () => {
      await createImapFolderLabel(
        executor,
        imapAccountId,
        "Archive/Drafts",
        "drafts"
      )
      await setImapDraftsFolderPreference(executor, imapAccountId, "My/Drafts")
      const saved = await saveDraft(executor, {
        accountId: imapAccountId,
        draftKey: "composer-1",
        draft: draftInput("v1"),
      })
      const fixture = imapInvokeFixture({
        fetchedUids: [9],
        messageId: draftMessageId(saved.id),
      })
      await enqueueDraftUpsert(executor, {
        accountId: imapAccountId,
        draftId: saved.id,
        mime: mimeFor(saved.id, "v1"),
      })

      await processQueue(
        options({ draftMirrorForTest: { invokeImpl: fixture.invokeImpl } })
      )

      expect(
        fixture.calls.find((call) => call.command === "imap_append")?.args
          .folder
      ).toBe("My/Drafts")
    })

    it("round-trips a re-append: the superseded copy is expunged and the ref advances", async () => {
      const saved = await saveDraft(executor, {
        accountId: imapAccountId,
        draftKey: "composer-1",
        draft: draftInput("v1"),
      })
      const fixture = imapInvokeFixture({
        fetchedUids: [44, 45],
        messageId: draftMessageId(saved.id),
      })

      // First autosave: append → uid 44.
      await enqueueDraftUpsert(executor, {
        accountId: imapAccountId,
        draftId: saved.id,
        mime: mimeFor(saved.id, "v1"),
      })
      await processQueue(
        options({ draftMirrorForTest: { invokeImpl: fixture.invokeImpl } })
      )
      // Second autosave (edited): append → uid 45, then uid 44 is removed.
      await enqueueDraftUpsert(executor, {
        accountId: imapAccountId,
        draftId: saved.id,
        mime: mimeFor(saved.id, "v2"),
      })
      await processQueue(
        options({ draftMirrorForTest: { invokeImpl: fixture.invokeImpl } })
      )

      const deletes = fixture.calls.filter(
        (call) => call.command === "imap_delete_message"
      )
      expect(deletes).toHaveLength(1)
      expect(deletes[0].args.folder).toBe("Drafts")
      expect(deletes[0].args.uidSet).toBe("44")
      expect((await getDraft(executor, saved.id))?.serverDraftRef).toEqual({
        provider: "imap",
        folder: "Drafts",
        uid: 45,
      })
    })

    it("draft_delete removes the server copy by folder + uid; already-gone counts as applied", async () => {
      const fixture = imapInvokeFixture({
        fetchedUids: [],
        deleteError: " mailbox does not exist",
      })
      await enqueueDraftDelete(executor, {
        accountId: imapAccountId,
        ref: { provider: "imap", folder: "Drafts", uid: 44 },
      })

      const result = await processQueue(
        options({ draftMirrorForTest: { invokeImpl: fixture.invokeImpl } })
      )

      expect(result.succeeded).toBe(1)
      expect(fixture.calls[0].command).toBe("imap_delete_message")
      expect(fixture.calls[0].args.uidSet).toBe("44")
    })
  })
})
