import { ProviderAuthError } from "./types"
import type { FetchImpl } from "./token-manager"

/**
 * Thin typed Gmail REST client over the fetch patched by
 * tauri-plugin-http (design D2: "Gmail REST calls stay in TS over
 * tauri-plugin-http"). Every call is Bearer-authenticated via the
 * injected token source; a 401 triggers exactly one silent refresh and
 * one retry before surfacing ProviderAuthError (task 5.6's seam). Other
 * failures become GmailApiError with the HTTP status and Google reason —
 * request bodies and token values never appear in error messages.
 */

export const GMAIL_API_ROOT = "https://gmail.googleapis.com/gmail/v1/users/me"

export interface GmailColor {
  backgroundColor?: string
  textColor?: string
}

export interface GmailLabel {
  id: string
  name: string
  type?: "system" | "user"
  messageListVisibility?: "show" | "hide"
  labelListVisibility?: "labelShow" | "labelShowIfUnread" | "labelHide"
  color?: GmailColor | null
}

export interface GmailMessagePartBody {
  attachmentId?: string
  size: number
  /** base64url body data (absent for attachments until fetched). */
  data?: string
}

export interface GmailMessagePart {
  partId: string
  mimeType?: string
  filename?: string
  headers?: { name: string; value: string }[]
  body?: GmailMessagePartBody
  parts?: GmailMessagePart[]
}

export interface GmailMessage {
  id: string
  threadId?: string
  labelIds?: string[]
  snippet?: string
  /** int64 decimal string */
  historyId?: string
  /** ms since epoch, decimal string */
  internalDate?: string
  sizeEstimate?: number
  payload?: GmailMessagePart
}

export interface GmailThread {
  id: string
  historyId?: string
  messages?: GmailMessage[]
}

export interface GmailHistoryMessage {
  id: string
  threadId?: string
}

export interface GmailHistoryRecord {
  id?: string
  messages?: GmailHistoryMessage[]
  messagesAdded?: { message: GmailHistoryMessage }[]
  messagesDeleted?: { message: GmailHistoryMessage }[]
  labelsAdded?: { message: GmailHistoryMessage; labelIds: string[] }[]
  labelsRemoved?: { message: GmailHistoryMessage; labelIds: string[] }[]
}

export interface GmailHistoryPage {
  history?: GmailHistoryRecord[]
  nextPageToken?: string
  /** The mailbox's current history record id (int64 decimal string). */
  historyId?: string
}

export interface GmailMessagesPage {
  messages?: { id: string; threadId?: string }[]
  nextPageToken?: string
  resultSizeEstimate?: number
}

export interface GmailProfile {
  emailAddress: string
  /** int64 decimal string — the initial delta-sync cursor. */
  historyId?: string
  messagesTotal?: number
  threadsTotal?: number
}

/** GET .../messages/{id}/attachments/{attachmentId} response. */
export interface GmailAttachment {
  /** The attachment's gmail id (matches the requesting attachmentId). */
  id?: string
  /** base64url content — only present on the attachment endpoint. */
  data?: string
  size: number
}

/** Typed non-auth API failure: HTTP status plus Google's reason code. */
export class GmailApiError extends Error {
  readonly status: number
  readonly reason?: string

  constructor(status: number, message: string, reason?: string) {
    super(message)
    this.name = "GmailApiError"
    this.status = status
    this.reason = reason
  }
}

export interface GmailClientDeps {
  accountId: string
  /** Access-token source (token-manager's createTokenSource output). */
  getToken: (force?: boolean) => Promise<string>
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetchImpl?: FetchImpl
}

export interface GmailClient {
  listLabels(): Promise<GmailLabel[]>
  listHistory(
    startHistoryId: string,
    pageToken?: string
  ): Promise<GmailHistoryPage>
  listMessages(query?: {
    q?: string
    labelIds?: string[]
    maxResults?: number
    pageToken?: string
  }): Promise<GmailMessagesPage>
  getMessage(id: string, format?: "full" | "metadata"): Promise<GmailMessage>
  getThread(id: string): Promise<GmailThread>
  /** raw = base64url RFC 822 message (https://gmail.googleapis.com JSON endpoint). */
  sendMessageRaw(rawBase64Url: string): Promise<GmailMessage>
  /** Insert a raw MIME message into the mailbox (appendMessage semantics). */
  insertMessageRaw(
    rawBase64Url: string,
    labelIds?: string[]
  ): Promise<GmailMessage>
  modifyMessageLabels(
    id: string,
    addLabelIds: string[],
    removeLabelIds: string[]
  ): Promise<GmailMessage>
  trashMessage(id: string): Promise<GmailMessage>
  untrashMessage(id: string): Promise<GmailMessage>
  deleteMessage(id: string): Promise<void>
  getProfile(): Promise<GmailProfile>
  /** Attachment content (base64url `data`) by message + attachment id. */
  getAttachment(
    messageId: string,
    attachmentId: string
  ): Promise<GmailAttachment>
  /** Create a user label (POST labels). Task 10.4 label CRUD. */
  createLabel(input: {
    name: string
    color?: GmailColor
    labelListVisibility?: "labelShow" | "labelShowIfUnread" | "labelHide"
    messageListVisibility?: "show" | "hide"
  }): Promise<GmailLabel>
  /** Patch a label's mutable fields (PATCH labels/{id}). */
  updateLabel(
    id: string,
    patch: { name?: string; color?: GmailColor | null }
  ): Promise<GmailLabel>
  /** Permanently delete a label (DELETE labels/{id}); messages survive. */
  deleteLabel(id: string): Promise<void>
}

export function createGmailClient(deps: GmailClientDeps): GmailClient {
  const fetchImpl = deps.fetchImpl ?? fetch

  async function toApiError(
    method: string,
    path: string,
    response: Response
  ): Promise<GmailApiError> {
    let apiMessage = ""
    let reason: string | undefined
    try {
      const payload = (await response.json()) as {
        error?: {
          message?: string
          errors?: { reason?: string }[]
          status?: string
        }
      } | null
      apiMessage = payload?.error?.message ?? ""
      reason = payload?.error?.errors?.[0]?.reason ?? payload?.error?.status
    } catch {
      // Non-JSON error body — status alone still identifies the failure.
    }
    const detail = apiMessage ? `: ${apiMessage}` : ""
    return new GmailApiError(
      response.status,
      `Gmail ${method} ${path} failed with ${response.status}` +
        `${reason ? ` [${reason}]` : ""}${detail}`,
      reason
    )
  }

  async function request<T>(
    method: string,
    path: string,
    options: { query?: URLSearchParams; json?: unknown } = {}
  ): Promise<T> {
    const query = options.query
    const url = `${GMAIL_API_ROOT}/${path}${query ? `?${query}` : ""}`

    async function send(accessToken: string): Promise<Response> {
      const headers: Record<string, string> = {
        authorization: `Bearer ${accessToken}`,
      }
      if (options.json !== undefined) {
        headers["content-type"] = "application/json"
      }
      return fetchImpl(url, {
        method,
        headers,
        body:
          options.json !== undefined ? JSON.stringify(options.json) : undefined,
      })
    }

    let response = await send(await deps.getToken())
    if (response.status === 401) {
      // One silent refresh, one retry — then the account is broken.
      response = await send(await deps.getToken(true))
      if (response.status === 401) {
        throw new ProviderAuthError(
          deps.accountId,
          "gmail",
          "Gmail rejected the access token after a silent refresh; " +
            "re-authorization is required"
        )
      }
    }
    if (!response.ok) {
      throw await toApiError(method, path, response)
    }
    if (method === "DELETE") return undefined as T
    return (await response.json()) as T
  }

  function queryOf(
    params: Record<string, string | number | undefined>
  ): URLSearchParams {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) query.set(key, String(value))
    }
    return query
  }

  return {
    listLabels(): Promise<GmailLabel[]> {
      return request<{ labels?: GmailLabel[] }>("GET", "labels").then(
        (page) => page.labels ?? []
      )
    },

    listHistory(startHistoryId: string, pageToken?: string) {
      return request<GmailHistoryPage>("GET", "history", {
        query: queryOf({ startHistoryId, pageToken }),
      })
    },

    listMessages(query) {
      const search = queryOf({
        q: query?.q,
        maxResults: query?.maxResults,
        pageToken: query?.pageToken,
      })
      for (const labelId of query?.labelIds ?? []) {
        search.append("labelIds", labelId)
      }
      return request<GmailMessagesPage>("GET", "messages", { query: search })
    },

    getMessage(id: string, format: "full" | "metadata" = "full") {
      return request<GmailMessage>(
        "GET",
        `messages/${encodeURIComponent(id)}`,
        { query: queryOf({ format }) }
      )
    },

    getThread(id: string) {
      return request<GmailThread>("GET", `threads/${encodeURIComponent(id)}`)
    },

    sendMessageRaw(rawBase64Url: string) {
      return request<GmailMessage>("POST", "messages/send", {
        json: { raw: rawBase64Url },
      })
    },

    insertMessageRaw(rawBase64Url: string, labelIds?: string[]) {
      return request<GmailMessage>("POST", "messages/insert", {
        json: {
          raw: rawBase64Url,
          labelIds: labelIds && labelIds.length > 0 ? labelIds : undefined,
        },
      })
    },

    modifyMessageLabels(id, addLabelIds, removeLabelIds) {
      return request<GmailMessage>(
        "POST",
        `messages/${encodeURIComponent(id)}/modify`,
        {
          json: {
            addLabelIds: addLabelIds.length > 0 ? addLabelIds : undefined,
            removeLabelIds:
              removeLabelIds.length > 0 ? removeLabelIds : undefined,
          },
        }
      )
    },

    trashMessage(id: string) {
      return request<GmailMessage>(
        "POST",
        `messages/${encodeURIComponent(id)}/trash`
      )
    },

    untrashMessage(id: string) {
      return request<GmailMessage>(
        "POST",
        `messages/${encodeURIComponent(id)}/untrash`
      )
    },

    async deleteMessage(id: string) {
      await request<void>("DELETE", `messages/${encodeURIComponent(id)}`)
    },

    getProfile() {
      return request<GmailProfile>("GET", "profile")
    },

    getAttachment(messageId: string, attachmentId: string) {
      return request<GmailAttachment>(
        "GET",
        `messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
      )
    },

    createLabel(input) {
      return request<GmailLabel>("POST", "labels", {
        json: {
          name: input.name,
          labelListVisibility: input.labelListVisibility ?? "labelShow",
          messageListVisibility: input.messageListVisibility ?? "show",
          ...(input.color ? { color: input.color } : {}),
        },
      })
    },

    updateLabel(
      id: string,
      patch: { name?: string; color?: GmailColor | null }
    ) {
      const body: Record<string, unknown> = {}
      if (patch.name !== undefined) body.name = patch.name
      if (patch.color !== undefined) body.color = patch.color
      return request<GmailLabel>("PATCH", `labels/${encodeURIComponent(id)}`, {
        json: body,
      })
    },

    async deleteLabel(id: string) {
      await request<void>("DELETE", `labels/${encodeURIComponent(id)}`)
    },
  }
}
