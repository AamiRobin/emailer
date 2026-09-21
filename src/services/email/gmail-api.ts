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
  /** Full RFC 822 message (base64url) — present only when fetched with format=raw. */
  raw?: string
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

/**
 * The Drafts API resource (task 17.1, design D9). `message.raw` (base64url
 * RFC 822) is present on create/update responses and on drafts.get with
 * format=raw; listDrafts returns the light `{id, message:{id, threadId}}`
 * shape unless format is requested.
 */
export interface GmailDraft {
  id: string
  message?: GmailMessage
}

export interface GmailDraftsPage {
  drafts?: GmailDraft[]
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

/**
 * GET .../settings/sendAs entry (task 16.1, design D10 — alias listing
 * rides the full mail.google.com scope). `isPrimary` marks the account's
 * own address; `isDefault` marks the one alias Gmail preselects as From.
 */
export interface GmailSendAs {
  /** The alias address — the primary entry carries the account email. */
  sendAsEmail: string
  displayName?: string | null
  replyToAddress?: string | null
  signature?: string | null
  isDefault?: boolean
  isPrimary?: boolean
  /** "accepted" | "pending" — unverified aliases must not send. */
  verificationStatus?: "accepted" | "pending"
  treatAsAlias?: string | null
}

/**
 * GET .../settings/sendAs list response (ListSendAsResponse). The
 * documented shape is a plain collection with NO nextPageToken (unlike
 * messages/drafts/history), so listSendAs normally issues a single
 * request; the client still follows a token when one appears so a
 * paginating server can never hand the reconcile sweep a truncated list.
 */
export interface GmailSendAsPage {
  sendAs?: GmailSendAs[]
  nextPageToken?: string
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
  getMessage(
    id: string,
    format?: "full" | "metadata" | "raw"
  ): Promise<GmailMessage>
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
  /** List the account's send-as addresses (GET settings/sendAs, task 16.1).
   * The response includes the primary entry (isPrimary) — callers filter.
   * Follows nextPageToken until exhausted (a no-op on the documented
   * single-page shape). */
  listSendAs(): Promise<GmailSendAs[]>
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
  /** Create a server draft (POST drafts; raw = base64url RFC 822). Task 17.1. */
  createDraft(rawBase64Url: string): Promise<GmailDraft>
  /** Overwrite a server draft's message (PUT drafts/{id}). Task 17.1. */
  updateDraft(id: string, rawBase64Url: string): Promise<GmailDraft>
  /** Permanently delete a server draft (DELETE drafts/{id}). Task 17.1. */
  deleteDraft(id: string): Promise<void>
  /**
   * Send an existing server draft (POST drafts/send with its id). Task
   * 17.1 implements the client surface per design D9; the app's send flow
   * sends via messages.send and deletes the draft afterwards, so this
   * method is currently unwired (kept for completeness/future use).
   */
  sendDraft(id: string): Promise<GmailMessage>
  /** One server draft; format=raw carries `message.raw` (base64url). */
  getDraft(
    id: string,
    format?: "full" | "metadata" | "raw"
  ): Promise<GmailDraft>
  /** List server drafts (newest first server-side); page cap via maxResults. */
  listDrafts(query?: {
    maxResults?: number
    pageToken?: string
  }): Promise<GmailDraftsPage>
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

    getMessage(id: string, format: "full" | "metadata" | "raw" = "full") {
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

    async listSendAs() {
      // Follow nextPageToken until exhausted: the alias reconcile sweep
      // deletes every stored gmail row missing from this list, so a
      // truncated read would delete real aliases (they would then be
      // re-inserted on the next sync). When the response carries no token
      // — the documented shape today, ListSendAsResponse being a plain
      // non-paginated collection — this stays a single request with the
      // same bare URL as before.
      const sendAs: GmailSendAs[] = []
      let pageToken: string | undefined
      do {
        const page = await request<GmailSendAsPage>(
          "GET",
          "settings/sendAs",
          pageToken ? { query: queryOf({ pageToken }) } : {}
        )
        sendAs.push(...(page.sendAs ?? []))
        pageToken = page.nextPageToken
      } while (pageToken)
      return sendAs
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

    createDraft(rawBase64Url: string) {
      return request<GmailDraft>("POST", "drafts", {
        json: { message: { raw: rawBase64Url } },
      })
    },

    updateDraft(id: string, rawBase64Url: string) {
      return request<GmailDraft>("PUT", `drafts/${encodeURIComponent(id)}`, {
        json: { id, message: { raw: rawBase64Url } },
      })
    },

    async deleteDraft(id: string) {
      await request<void>("DELETE", `drafts/${encodeURIComponent(id)}`)
    },

    sendDraft(id: string) {
      return request<GmailMessage>("POST", "drafts/send", { json: { id } })
    },

    getDraft(id: string, format: "full" | "metadata" | "raw" = "full") {
      return request<GmailDraft>("GET", `drafts/${encodeURIComponent(id)}`, {
        query: queryOf({ format }),
      })
    },

    listDrafts(query?: { maxResults?: number; pageToken?: string }) {
      return request<GmailDraftsPage>("GET", "drafts", {
        query: queryOf({
          maxResults: query?.maxResults,
          pageToken: query?.pageToken,
        }),
      })
    },
  }
}
