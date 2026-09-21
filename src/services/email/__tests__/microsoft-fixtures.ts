import type { EmailAccount } from "../types"
import type {
  GraphFolder,
  GraphMessage,
  GraphPage,
  GraphProfile,
} from "../graph-api"
import type { FetchMock, MockReply } from "./gmail-fixtures"

/**
 * Recorded-shaped Microsoft Graph JSON fixtures (parity-round-2 tasks
 * 3.1–3.4): folder list, message/delta pages, messages, attachments and
 * profile payloads the suites replay through the injected-fetch mock
 * (the gmail-fixtures router). No live network.
 */

/** Fixture account row matching the accounts-table microsoft columns. */
export function microsoftAccount(
  overrides: Partial<EmailAccount> = {}
): EmailAccount {
  return {
    id: "acc-m",
    type: "microsoft",
    email: "me@outlook.com",
    oauthClientId: "ms-client-123",
    oauthScope: "Mail.ReadWrite Mail.Send User.Read offline_access",
    status: "active",
    isActive: true,
    isPinned: false,
    ...overrides,
  }
}

export const microsoftEnvelope = { refreshToken: "ms-rt-1" }

// ---------------------------------------------------------------------------
// Graph payload builders
// ---------------------------------------------------------------------------

let folderSeq = 0

export function graphFolder(
  overrides: Partial<GraphFolder> & { id?: string; displayName?: string } = {}
): GraphFolder {
  folderSeq += 1
  return {
    id: overrides.id ?? `AQMAfolder${folderSeq}==`,
    displayName: overrides.displayName ?? `Folder ${folderSeq}`,
    parentFolderId: "AQMAroot==",
    childFolderCount: 0,
    totalItemCount: 1,
    unreadItemCount: 0,
    ...overrides,
  }
}

/** The well-known folder set (inbox/sent/drafts/trash/junk/archive ids). */
export function wellKnownFolders(): GraphFolder[] {
  return [
    {
      id: "AQMAinbox==",
      displayName: "Inbox",
      parentFolderId: "AQMAroot==",
      childFolderCount: 0,
      totalItemCount: 2,
      unreadItemCount: 1,
    },
    {
      id: "AQMAarchive==",
      displayName: "Archive",
      parentFolderId: "AQMAroot==",
      childFolderCount: 0,
      totalItemCount: 0,
      unreadItemCount: 0,
    },
    {
      id: "AQMAprojects==",
      displayName: "Projects",
      parentFolderId: "AQMAroot==",
      childFolderCount: 0,
      totalItemCount: 1,
      unreadItemCount: 0,
    },
  ]
}

export interface SampleGraphMessageOverrides {
  id?: string
  subject?: string
  conversationId?: string
  parentFolderId?: string
  receivedDateTime?: string
  isRead?: boolean
  flagStatus?: "flagged" | "notFlagged"
  fromAddress?: string
  fromName?: string
  toAddress?: string
  textContent?: string
  htmlContent?: string
  messageIdHeader?: string
  inReplyTo?: string
  references?: string
  listUnsubscribe?: string
  hasAttachments?: boolean
  attachments?: GraphMessage["attachments"]
}

/** A typical full message: html body, header set, one pdf attachment. */
export function graphMessage(
  overrides: SampleGraphMessageOverrides = {}
): GraphMessage {
  const id = overrides.id ?? "AAMkmsg1=="
  const html =
    overrides.htmlContent ??
    (overrides.textContent === undefined ? "<p>Hello <b>world</b></p>" : undefined)
  const text = overrides.textContent
  return {
    id,
    subject: overrides.subject ?? "Hello",
    body: html
      ? { contentType: "html", content: html }
      : { contentType: "text", content: text ?? "" },
    bodyPreview: "Hello world",
    internetMessageId:
      overrides.messageIdHeader ?? `<msg-${id.replace(/[^a-z0-9]/gi, "")}@sender.example>`,
    internetMessageHeaders: [
      ...(overrides.inReplyTo
        ? [{ name: "In-Reply-To", value: overrides.inReplyTo }]
        : []),
      ...(overrides.references
        ? [{ name: "References", value: overrides.references }]
        : []),
      ...(overrides.listUnsubscribe
        ? [{ name: "List-Unsubscribe", value: overrides.listUnsubscribe }]
        : []),
      ...(overrides.listUnsubscribe
        ? [
            {
              name: "List-Unsubscribe-Post",
              value: "List-Unsubscribe=One-Click",
            },
          ]
        : []),
    ],
    from: {
      emailAddress: {
        name: overrides.fromName ?? "Ada Lovelace",
        address: overrides.fromAddress ?? "ada@example.com",
      },
    },
    toRecipients: [
      {
        emailAddress: {
          address: overrides.toAddress ?? "me@outlook.com",
        },
      },
    ],
    receivedDateTime: overrides.receivedDateTime ?? "2023-11-14T22:13:20Z",
    isRead: overrides.isRead ?? false,
    flag: { flagStatus: overrides.flagStatus ?? "notFlagged" },
    hasAttachments: overrides.hasAttachments ?? true,
    conversationId: overrides.conversationId ?? `conv-${id.slice(0, 8)}`,
    parentFolderId: overrides.parentFolderId ?? "AQMAinbox==",
    attachments: overrides.attachments ?? [
      {
        "@odata.type": "#microsoft.graph.fileAttachment",
        id: `att-${id.slice(0, 6)}-pdf`,
        name: "report.pdf",
        contentType: "application/pdf",
        size: 1024,
        isInline: false,
      },
    ],
  } as GraphMessage & { authResultsHeaders?: { name: string; value: string }[] }
}

/** A delta-feed tombstone (@removed). */
export function graphRemoved(id: string): { id: string; "@removed": { reason: string } } {
  return { id, "@removed": { reason: "deleted" } }
}

export function deltaPage(
  value: (GraphMessage | { id: string; "@removed": { reason: string } })[],
  links: { next?: string; delta?: string } = {}
): GraphPage<GraphMessage | { id: string; "@removed": { reason: string } }> {
  return {
    value,
    ...(links.next ? { "@odata.nextLink": links.next } : {}),
    ...(links.delta
      ? { "@odata.deltaLink": links.delta }
      : {}),
  }
}

/** Standard deltaLink values the fixtures reuse ("deltaLink reuse round"). */
export const INBOX_DELTA_LINK_V1 =
  "https://graph.microsoft.com/v1.0/me/mailFolders/AQMAinbox==/messages/delta?$deltatoken=v1"
export const INBOX_DELTA_LINK_V2 =
  "https://graph.microsoft.com/v1.0/me/mailFolders/AQMAinbox==/messages/delta?$deltatoken=v2"

export const INBOX_DELTA_NEXT =
  "https://graph.microsoft.com/v1.0/me/mailFolders/AQMAinbox==/messages/delta?$skiptoken=page2"

export function graphProfile(
  overrides: Partial<GraphProfile> = {}
): GraphProfile {
  return {
    id: "profile-1",
    displayName: "Mira Example",
    mail: "me@outlook.com",
    userPrincipalName: "me@outlook.com",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// fetch mock: reuse the gmail router shape with the Entra token endpoint
// ---------------------------------------------------------------------------

export type { FetchMock, MockReply }

export const ENTRA_TOKEN_URL =
  "https://login.microsoftonline.com/common/oauth2/v2.0/token"

/** Recorded calls to the Graph API only (the token endpoint excluded). */
export function graphCalls(mock: FetchMock): ReturnType<FetchMock["callsTo"]> {
  return mock.calls.filter(
    (call) => !call.url.startsWith("https://login.microsoftonline.com")
  )
}

/** Standard Entra token-endpoint success reply (with rotation). */
export function mockEntraTokenSuccess(
  mock: FetchMock,
  token = "ms-at-1",
  options: { refreshToken?: string; expiresIn?: number } = {}
): void {
  mock.on("POST", ENTRA_TOKEN_URL, () => ({
    status: 200,
    json: {
      access_token: token,
      token_type: "Bearer",
      expires_in: options.expiresIn ?? 3600,
      scope: "Mail.ReadWrite Mail.Send User.Read",
      ...(options.refreshToken ? { refresh_token: options.refreshToken } : {}),
    },
  }))
}

/** Standard Entra token-endpoint error reply. */
export function mockEntraTokenError(
  mock: FetchMock,
  error: string,
  status = 400
): void {
  mock.on("POST", ENTRA_TOKEN_URL, () => ({
    status,
    json: { error, error_description: `${error}: details withheld` },
  }))
}

/** Stub one full-message GET (id encoded in the path). */
export function onGraphMessage(
  mock: FetchMock,
  message: GraphMessage
): void {
  mock.on("GET", `/me/messages/${encodeURIComponent(message.id)}?`, () => ({
    json: message,
  }))
}

/** base64 of a UTF-8 string (fixture counterpart of the cache decode). */
export function b64(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text)))
}
