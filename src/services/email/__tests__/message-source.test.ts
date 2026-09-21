import { beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"

import { createGmailProvider } from "../gmail-provider"
import { createImapSmtpProvider } from "../imap-smtp-provider"
import { getMessageSource, messageSourceRef } from "../message-source"
import type { MessageSourceRow } from "../message-source"
import type { EmailProvider, MessageRef } from "../types"
import {
  createFetchMock,
  gmailAccount,
  gmailEnvelope,
  mockTokenSuccess,
  type FetchMock,
} from "./gmail-fixtures"
import { imapAccount, imapCredentials } from "./fixtures"

vi.mock("@tauri-apps/api/core")

const invokeMock = vi.mocked(invoke)

const RAW_SOURCE = [
  "From: Ada <ada@example.com>",
  "To: user@example.com",
  "Subject: Invoice #42",
  "Date: Sat, 19 Sep 2026 10:00:00 +0000",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Your invoice is attached. — Grüße",
].join("\r\n")

/** Standard base64 (the imap wire payload). */
function toBase64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)))
}

/** base64url (the gmail wire payload). */
function toBase64Url(text: string): string {
  return toBase64(text)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

function sourceRow(
  overrides: Partial<MessageSourceRow> = {}
): MessageSourceRow {
  return {
    gmail_message_id: null,
    imap_folder: "INBOX",
    imap_uid: 42,
    ...overrides,
  }
}

let mock: FetchMock

function gmailProvider(): EmailProvider {
  return createGmailProvider(
    gmailAccount(),
    { password: "" },
    {
      fetchImpl: mock.fetch,
      tokenEnvelope: gmailEnvelope,
    }
  )
}

function imapProvider(): EmailProvider {
  return createImapSmtpProvider(imapAccount(), imapCredentials)
}

beforeEach(() => {
  vi.clearAllMocks()
  mock = createFetchMock()
  mockTokenSuccess(mock, "at-1", 3600)
})

describe("EmailProvider.getMessageSource (task 1.2, design D6)", () => {
  it("gmail: fetches format=raw and decodes the base64url source", async () => {
    mock.on("GET", /\/messages\/msg-9\?/, () => ({
      json: { id: "msg-9", raw: toBase64Url(RAW_SOURCE) },
    }))

    const source = await gmailProvider().getMessageSource({
      folder: "",
      uid: 0,
      providerMessageId: "msg-9",
    })

    expect(source).toBe(RAW_SOURCE)
    // Exactly one request: the source fetch itself (the token route aside).
    const calls = mock.callsTo(/\/messages\/msg-9\?/)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain("format=raw")
  })

  it("gmail: throws a clear error when the response carries no raw body", async () => {
    mock.on("GET", /\/messages\/msg-empty\?/, () => ({
      json: { id: "msg-empty" },
    }))

    await expect(
      gmailProvider().getMessageSource({
        folder: "",
        uid: 0,
        providerMessageId: "msg-empty",
      })
    ).rejects.toThrow(/no raw source/)
  })

  it("imap: fetches the raw source by folder+uid and decodes the base64", async () => {
    invokeMock.mockResolvedValueOnce(toBase64(RAW_SOURCE))

    const source = await imapProvider().getMessageSource({
      folder: "Archive/2026",
      uid: 4242,
    })

    expect(source).toBe(RAW_SOURCE)
    expect(invokeMock).toHaveBeenCalledWith("imap_fetch_source", {
      params: {
        host: "imap.example.com",
        port: 993,
        security: "tls",
        username: "user@example.com",
        password: "secret",
        acceptInvalidCerts: false,
      },
      folder: "Archive/2026",
      uid: 4242,
    })
  })
})

describe("message-source UI seam", () => {
  it("maps a stored row onto the provider's MessageRef", () => {
    expect(
      messageSourceRef(
        sourceRow({
          gmail_message_id: "g-1",
          imap_folder: null,
          imap_uid: null,
        })
      )
    ).toEqual({
      folder: "",
      uid: 0,
      providerMessageId: "g-1",
    } satisfies MessageRef)
    expect(messageSourceRef(sourceRow())).toEqual({
      folder: "INBOX",
      uid: 42,
      providerMessageId: undefined,
    })
  })

  it("routes through the injected fetch exactly once (no other seams)", async () => {
    const fetchSource = vi.fn(async () => RAW_SOURCE)
    const account = gmailAccount()
    const row = sourceRow({
      gmail_message_id: "g-1",
      imap_folder: null,
      imap_uid: null,
    })

    const source = await getMessageSource(account, row, { fetchSource })

    expect(source).toBe(RAW_SOURCE)
    expect(fetchSource).toHaveBeenCalledWith(account, row)
    expect(invokeMock).not.toHaveBeenCalled()
  })
})
