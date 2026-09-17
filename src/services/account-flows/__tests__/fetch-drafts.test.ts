import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { createAccount } from "../../db/__tests__/fixtures"
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
} from "../../composer/drafts"
import {
  createFetchMock,
  type FetchMock,
} from "../../email/__tests__/gmail-fixtures"
import { base64ToBytes, buildMimeMessage } from "../../email/mime-builder"
import { setImapDraftsFolderPreference } from "../../settings/preferences"
import {
  fetchDraftsOnConnect,
  ownMirrorDraftId,
  serverDraftKey,
} from "../fetch-drafts"

/**
 * Task 17.3 (design D9): drafts authored elsewhere are pulled into
 * local_drafts on account connect, so they appear in the existing Drafts
 * view (which lists local_drafts rows). Dedupe by Message-ID key, own
 * mirrors skipped with ref healing, imap served from the resolved drafts
 * folder through a fake invoke.
 */

function b64url(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function mimeDraft(input: {
  messageId: string
  to: string
  subject: string
  html: string
}): string {
  return buildMimeMessage({
    from: { email: "someone@else.example" },
    to: [{ email: input.to }],
    subject: input.subject,
    htmlBody: input.html,
    messageId: input.messageId,
  }).mime
}

/** Gmail fetch mock: a drafts list page plus per-draft raw payloads. */
function gmailFetchFixture(drafts: { id: string; mime: string }[]): FetchMock {
  const mock = createFetchMock()
  mock.on("GET", /\/drafts\?/, () => ({
    json: {
      drafts: drafts.map((draft) => ({ id: draft.id })),
      resultSizeEstimate: drafts.length,
    },
  }))
  for (const draft of drafts) {
    mock.on("GET", new RegExp(`/drafts/${draft.id}\\?format=raw`), () => ({
      json: {
        id: draft.id,
        message: { id: `m-${draft.id}`, raw: b64url(draft.mime) },
      },
    }))
  }
  return mock
}

/** IMAP invoke fake serving the resolved drafts folder's messages. */
function imapFetchFixture(
  messages: {
    uid: number
    messageId?: string
    subject?: string
    htmlBody?: string
  }[]
) {
  const calls: { command: string; args: Record<string, unknown> }[] = []
  const invokeImpl = async (
    command: string,
    args: Record<string, unknown>
  ): Promise<unknown> => {
    calls.push({ command, args })
    if (command === "imap_fetch_messages") {
      return {
        messages: messages.map((message) => ({
          uid: message.uid,
          flags: [],
          messageId: message.messageId ?? null,
          inReplyTo: null,
          references: null,
          subject: message.subject ?? null,
          from: [{ name: "Else", email: "someone@else.example" }],
          to: [{ name: null, email: "me@example.com" }],
          cc: [],
          bcc: [],
          date: 1_700_000_000,
          textBody: null,
          htmlBody: message.htmlBody ?? null,
          size: 64,
          attachments: [],
        })),
        folderStatus: {
          uidValidity: 1,
          uidNext: 100,
          exists: messages.length,
          unseen: 0,
        },
      }
    }
    return undefined
  }
  return { calls, invokeImpl }
}

describe("fetchDraftsOnConnect (task 17.3)", () => {
  let executor: TestExecutor
  let gmailAccountId: string
  let imapAccountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    setDefaultKeyStore(createInMemoryKeyStore())
    gmailAccountId = await createAccount(executor, "gmail")
    imapAccountId = await createAccount(executor, "imap")

    const gmailEnvelope = await encryptCredentials({
      refreshToken: "rt-1",
      accessToken: "at-1",
      accessTokenExpiresAt: Date.now() + 3_600_000,
    })
    await executor.execute(
      "UPDATE accounts SET credentials_json = $1, oauth_client_id = $2 WHERE id = $3",
      [gmailEnvelope, "client-123", gmailAccountId]
    )
    const imapEnvelope = await encryptCredentials({ password: "app-secret" })
    await executor.execute(
      `UPDATE accounts SET credentials_json = $1,
         imap_host = $2, imap_port = $3, imap_security = $4
       WHERE id = $5`,
      [imapEnvelope, "imap.example.com", 993, "tls", imapAccountId]
    )
  })

  afterEach(() => {
    setDefaultKeyStore(null)
    executor.close()
  })

  it("gmail: fetched drafts land in local_drafts and appear in the Drafts view", async () => {
    const mock = gmailFetchFixture([
      {
        id: "d-1",
        mime: mimeDraft({
          messageId: "<remote-1@web.example>",
          to: "bob@example.com",
          subject: "From the web mailer",
          html: "<p>Started on my phone</p>",
        }),
      },
    ])

    const summary = await fetchDraftsOnConnect(executor, gmailAccountId, {
      fetchImpl: mock.fetch,
    })

    expect(summary).toEqual({ fetched: 1, created: 1, updated: 0, skipped: 0 })
    // THE Drafts view: thread-list-store's drafts pseudo-view lists
    // listDrafts rows — the fetched draft is one of them now.
    const drafts = await listDrafts(executor, gmailAccountId)
    expect(drafts).toHaveLength(1)
    expect(drafts[0]).toMatchObject({
      draftKey: "server:remote-1@web.example",
      subject: "From the web mailer",
      bodyHtml: "<p>Started on my phone</p>",
      serverDraftRef: { provider: "gmail", draftId: "d-1" },
    })
    expect(drafts[0].to).toEqual([{ email: "bob@example.com" }])

    // A RE-connect dedupes by the Message-ID key: update, not duplicate.
    const second = await fetchDraftsOnConnect(executor, gmailAccountId, {
      fetchImpl: mock.fetch,
    })
    expect(second).toEqual({ fetched: 1, created: 0, updated: 1, skipped: 0 })
    expect(await listDrafts(executor, gmailAccountId)).toHaveLength(1)
  })

  it("gmail: our own mirrored drafts keep local content and get their ref healed", async () => {
    const saved = await saveDraft(executor, {
      accountId: gmailAccountId,
      draftKey: "composer-1",
      draft: {
        to: [{ email: "alice@example.com" }],
        cc: [],
        bcc: [],
        subject: "Local title wins",
        bodyHtml: "<p>local</p>",
      },
    })
    // The mirror exists server-side but the row's ref was lost (e.g. an
    // orphaned offline upsert that landed after a discard-recreate).
    const mock = gmailFetchFixture([
      {
        id: "d-mine",
        mime: mimeDraft({
          messageId: draftMessageId(saved.id),
          to: "alice@example.com",
          subject: "SERVER EDIT MUST NOT WIN",
          html: "<p>server</p>",
        }),
      },
    ])

    const summary = await fetchDraftsOnConnect(executor, gmailAccountId, {
      fetchImpl: mock.fetch,
    })

    expect(summary).toEqual({ fetched: 1, created: 0, updated: 1, skipped: 0 })
    const draft = await getDraft(executor, saved.id)
    expect(draft?.subject).toBe("Local title wins") // local is source of truth
    expect(draft?.serverDraftRef).toEqual({
      provider: "gmail",
      draftId: "d-mine",
    })
    expect(await listDrafts(executor, gmailAccountId)).toHaveLength(1)
  })

  it("gmail: a healthy own mirror is fully skipped", async () => {
    const saved = await saveDraft(executor, {
      accountId: gmailAccountId,
      draftKey: "composer-1",
      draft: {
        to: [],
        cc: [],
        bcc: [],
        subject: "Mine",
        bodyHtml: "",
      },
    })
    await setDraftServerRef(executor, saved.id, {
      provider: "gmail",
      draftId: "d-mine",
    })
    const mock = gmailFetchFixture([
      {
        id: "d-mine",
        mime: mimeDraft({
          messageId: draftMessageId(saved.id),
          to: "x@example.com",
          subject: "Mine",
          html: "",
        }),
      },
    ])

    const summary = await fetchDraftsOnConnect(executor, gmailAccountId, {
      fetchImpl: mock.fetch,
    })
    expect(summary).toEqual({ fetched: 1, created: 0, updated: 0, skipped: 1 })
  })

  it("imap: fetches the resolved drafts folder into local_drafts", async () => {
    await setImapDraftsFolderPreference(executor, imapAccountId, "My/Drafts")
    const fixture = imapFetchFixture([
      {
        uid: 41,
        messageId: "<imap-draft-1@host.example>",
        subject: "Imap draft",
        htmlBody: "<p>from imap</p>",
      },
      { uid: 42 }, // no Message-ID: ref-identity fallback key
    ])

    const summary = await fetchDraftsOnConnect(executor, imapAccountId, {
      invokeImpl: fixture.invokeImpl,
    })

    expect(summary).toEqual({ fetched: 2, created: 2, updated: 0, skipped: 0 })
    expect(fixture.calls[0]).toMatchObject({
      command: "imap_fetch_messages",
    })
    expect(fixture.calls[0].args.folder).toBe("My/Drafts")
    expect(fixture.calls[0].args.last).toBe(50)

    const drafts = await listDrafts(executor, imapAccountId)
    expect(drafts.map((draft) => draft.draftKey).sort()).toEqual([
      "server:imap-draft-1@host.example",
      "server:imap:My/Drafts:42",
    ])
    const withHeader = drafts.find((draft) =>
      draft.draftKey?.includes("imap-draft-1")
    )
    expect(withHeader).toMatchObject({
      subject: "Imap draft",
      bodyHtml: "<p>from imap</p>",
      serverDraftRef: { provider: "imap", folder: "My/Drafts", uid: 41 },
    })
  })
})

describe("fetch-drafts key helpers", () => {
  it("derives keys from the Message-ID or the ref identity", () => {
    expect(
      serverDraftKey({
        messageIdHeader: "<Remote-1@Web.Example>",
        ref: { provider: "gmail", draftId: "d-1" },
      })
    ).toBe("server:Remote-1@Web.Example")
    expect(
      serverDraftKey({
        ref: { provider: "gmail", draftId: "d-2" },
      })
    ).toBe("server:gmail:d-2")
    expect(
      serverDraftKey({
        ref: { provider: "imap", folder: "Drafts", uid: 7 },
      })
    ).toBe("server:imap:Drafts:7")
  })

  it("recognizes only this app's draft Message-IDs as own mirrors", () => {
    expect(
      ownMirrorDraftId(
        "<draft-01234567-89ab-cdef-0123-456789abcdef@emailer.local>"
      )
    ).toBe("01234567-89ab-cdef-0123-456789abcdef")
    expect(
      ownMirrorDraftId(
        "<other-01234567-89ab-cdef-0123-456789abcdef@emailer.local>"
      )
    ).toBeNull()
    expect(ownMirrorDraftId("<draft-not-a-uuid@emailer.local>")).toBeNull()
    expect(ownMirrorDraftId(undefined)).toBeNull()
  })

  it("keeps base64url round-tripping (fixture sanity)", () => {
    expect(b64url("hi")).toBe("aGk")
    expect(new TextDecoder().decode(base64ToBytes("aGk="))).toBe("hi")
  })
})
