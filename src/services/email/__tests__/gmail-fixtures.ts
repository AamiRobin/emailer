import type { EmailAccount } from "../types"
import type { FetchImpl } from "../token-manager"
import type {
  GmailHistoryPage,
  GmailHistoryRecord,
  GmailLabel,
  GmailMessage,
} from "../gmail-api"

/** Fixture account row matching the accounts-table gmail columns. */
export function gmailAccount(
  overrides: Partial<EmailAccount> = {}
): EmailAccount {
  return {
    id: "acc-g",
    type: "gmail",
    email: "me@gmail.com",
    oauthClientId: "client-123",
    oauthScope: "https://www.googleapis.com/auth/gmail.modify",
    gmailHistoryId: "9000",
    status: "active",
    isActive: true,
    isPinned: false,
    ...overrides,
  }
}

export const gmailEnvelope = { refreshToken: "rt-1" }

// ---------------------------------------------------------------------------
// fetch mock: a tiny method + URL-substring/regex router recording calls
// ---------------------------------------------------------------------------

export interface RecordedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

export interface MockReply {
  status?: number
  json?: unknown
  text?: string
}

export type MockRouteHandler = (request: RecordedRequest) => MockReply

export interface FetchMock {
  fetch: FetchImpl
  /** Every request in call order. */
  calls: RecordedRequest[]
  on(method: string, pattern: string | RegExp, handler: MockRouteHandler): void
  callsTo(pattern: string | RegExp): RecordedRequest[]
}

export function createFetchMock(): FetchMock {
  const calls: RecordedRequest[] = []
  const routes: {
    method: string
    pattern: string | RegExp
    handler: MockRouteHandler
  }[] = []

  function matches(pattern: string | RegExp, url: string): boolean {
    return typeof pattern === "string"
      ? url.includes(pattern)
      : pattern.test(url)
  }

  const fetchMock: FetchImpl = async (input, init) => {
    const url = String(input)
    const method = (init?.method ?? "GET").toUpperCase()
    const headers: Record<string, string> = {}
    const rawHeaders = init?.headers
    if (rawHeaders instanceof Headers) {
      rawHeaders.forEach((value, key) => {
        headers[key] = value
      })
    } else if (rawHeaders) {
      Object.assign(headers, rawHeaders)
    }
    calls.push({
      url,
      method,
      headers,
      body: typeof init?.body === "string" ? init.body : undefined,
    })
    // Latest matching route wins so tests can override earlier replies.
    const route = [...routes]
      .reverse()
      .find(
        (candidate) =>
          candidate.method === method && matches(candidate.pattern, url)
      )
    if (!route) {
      return new Response(
        JSON.stringify({
          error: { code: 404, message: `no mock route for ${method} ${url}` },
        }),
        { status: 404, headers: { "content-type": "application/json" } }
      )
    }
    const reply = route.handler(calls[calls.length - 1])
    return new Response(reply.text ?? JSON.stringify(reply.json ?? {}), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    })
  }

  return {
    fetch: fetchMock,
    calls,
    on(method, pattern, handler) {
      routes.push({ method: method.toUpperCase(), pattern, handler })
    },
    callsTo(pattern) {
      return calls.filter((call) => matches(pattern, call.url))
    },
  }
}

/** Standard Google token-endpoint success reply. */
export function mockTokenSuccess(
  mock: FetchMock,
  token = "at-1",
  expiresIn = 3600
): void {
  mock.on("POST", "https://oauth2.googleapis.com/token", () => ({
    json: {
      access_token: token,
      expires_in: expiresIn,
      token_type: "Bearer",
      scope: "https://www.googleapis.com/auth/gmail.modify",
    },
  }))
}

/** Recorded calls to the Gmail API only (the token endpoint excluded). */
export function apiCalls(mock: FetchMock): RecordedRequest[] {
  return mock.calls.filter(
    (call) => !call.url.startsWith("https://oauth2.googleapis.com")
  )
}

// ---------------------------------------------------------------------------
// Gmail API payload builders
// ---------------------------------------------------------------------------

/** base64url of a UTF-8 string (fixture counterpart of mime-builder). */
export function b64url(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

export function gmailLabel(overrides: Partial<GmailLabel> = {}): GmailLabel {
  return { id: "Label_work", name: "Work", type: "user", ...overrides }
}

export function textPart(
  partId: string,
  text: string,
  mimeType = "text/plain"
): NonNullable<GmailMessage["payload"]> {
  return {
    partId,
    mimeType,
    headers: [],
    body: { size: text.length, data: b64url(text) },
  }
}

export interface SampleMessageOverrides {
  id?: string
  threadId?: string
  labelIds?: string[]
  historyId?: string
  internalDate?: string
  sizeEstimate?: number
  payload?: GmailMessage["payload"]
}

/** A typical message: multipart/mixed(alternative(text, html), pdf). */
export function gmailMessage(
  overrides: SampleMessageOverrides = {}
): GmailMessage {
  const id = overrides.id ?? "1700000000000001"
  const html = "<p>Hello <b>world</b></p>"
  const defaultPayload: NonNullable<GmailMessage["payload"]> = {
    partId: "",
    mimeType: "multipart/mixed",
    headers: [
      { name: "Message-ID", value: `<msg-${id}@sender.example>` },
      { name: "Subject", value: "Hello" },
      { name: "From", value: "Ada Lovelace <ada@example.com>" },
      { name: "To", value: "me@gmail.com" },
      { name: "Date", value: "Tue, 14 Nov 2023 22:13:20 +0000" },
    ],
    parts: [
      {
        partId: "1",
        mimeType: "multipart/alternative",
        parts: [
          textPart("1.1", "Hello world"),
          textPart("1.2", html, "text/html"),
        ],
      },
      {
        partId: "2",
        mimeType: "application/pdf",
        filename: "report.pdf",
        body: { attachmentId: "ANGjsJreport", size: 1024 },
      },
    ],
  }
  return {
    id,
    threadId: `th-${id}`,
    labelIds: ["INBOX", "UNREAD"],
    historyId: "9001",
    internalDate: "1700000000000",
    sizeEstimate: 2048,
    payload: defaultPayload,
    ...overrides,
  }
}

export function historyPage(
  records: GmailHistoryRecord[],
  overrides: Partial<GmailHistoryPage> = {}
): GmailHistoryPage {
  return { history: records, historyId: "9010", ...overrides }
}
