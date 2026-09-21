import { ProviderAuthError } from "./types"
import type { FetchImpl } from "./token-manager"

/**
 * Thin typed Microsoft Graph REST client over the fetch patched by
 * tauri-plugin-http (design D1/D3: "a frontend provider, REST over the
 * injected fetch"). Every call is Bearer-authenticated via the injected
 * token source; a 401 triggers exactly one silent refresh and one retry
 * before surfacing ProviderAuthError. Other failures become GraphApiError
 * carrying the HTTP status and the Graph error payload's message/code
 * VERBATIM (never the request, never the token).
 *
 * Throttling (design D3): 429 and 503 honor the `Retry-After` header with
 * the queue processor's exponential shape (base 5s, doubled per retry,
 * capped) — Retry-After seconds win when present, else the base delay.
 * Bounded to MAX_THROTTLE_RETRIES waits per request so a sync pass can
 * never pin the scheduler.
 *
 * Delta/pagination links (`@odata.nextLink`, `@odata.deltaLink`) come
 * back as absolute URLs on graph.microsoft.com; validate them with
 * validatedGraphLink() before following — a hostile link must never turn
 * into a bearer-token fetch against another host.
 */

export const GRAPH_API_ROOT = "https://graph.microsoft.com/v1.0"

/** The allowed origin for server-provided pagination/delta links. */
export const GRAPH_LINK_HOST = "graph.microsoft.com"

// ---- Throttle backoff (the queue processor's exponential shape) ----

/** Base wait when a 429/503 carries no usable Retry-After (queue base). */
export const THROTTLE_BASE_MS = 5_000
/** Cap per wait; a sync pass must never stall minutes on one request. */
export const THROTTLE_MAX_WAIT_MS = 60_000
/** Bounded waits per request (first wait + one doubling retry). */
export const MAX_THROTTLE_RETRIES = 2

// ---- Folder-tree walk (recursive childFolders) ----

/** Deepest childFolders level the walk expands (top level = depth 0, so
 * folders up to MAX_FOLDER_DEPTH levels below the mailbox root are listed). */
export const MAX_FOLDER_DEPTH = 10
/** Cap on the total folders listed across the whole tree — a pathological
 * mailbox (or a server loop) can never pin a sync pass. */
export const MAX_FOLDERS = 500

export interface GraphRecipient {
  emailAddress: { name?: string; address: string }
}

export interface GraphMessageBody {
  contentType: "html" | "text"
  content: string
}

export interface GraphFileAttachment {
  "@odata.type"?: string
  id?: string
  name?: string
  contentType?: string
  size?: number
  /** base64 content — present on single-attachment GETs, not list forms. */
  contentBytes?: string
  isInline?: boolean
  contentId?: string
}

export interface GraphMessage {
  id: string
  subject?: string
  body?: GraphMessageBody
  bodyPreview?: string
  /** RFC 5322 Message-ID header value (bracketed). */
  internetMessageId?: string
  /** Combined internet headers — present on the full single-message GET
   * when requested via $select (the delta feed carries none of them). */
  internetMessageHeaders?: { name: string; value: string }[]
  from?: { emailAddress: GraphRecipient["emailAddress"] } | null
  sender?: { emailAddress: GraphRecipient["emailAddress"] } | null
  toRecipients?: GraphRecipient[]
  ccRecipients?: GraphRecipient[]
  bccRecipients?: GraphRecipient[]
  receivedDateTime?: string
  sentDateTime?: string
  isRead?: boolean
  isDraft?: boolean
  hasAttachments?: boolean
  flag?: { flagStatus?: "notFlagged" | "flagged" | "complete" }
  categories?: string[]
  /** Server-side conversation grouping (Emailer's thread anchor). */
  conversationId?: string
  parentFolderId?: string
  attachments?: GraphFileAttachment[]
}

export interface GraphFolder {
  id: string
  displayName?: string
  parentFolderId?: string
  childFolderCount?: number
  totalItemCount?: number
  unreadItemCount?: number
}

export interface GraphPage<T> {
  value?: T[]
  "@odata.nextLink"?: string
  /** Present on the LAST delta page — the opaque cursor to persist. */
  "@odata.deltaLink"?: string
}

/** A delta-feed tombstone: the message was deleted server-side. */
export interface GraphRemovedMessage {
  id: string
  "@removed"?: { reason?: string }
}

export interface GraphAttachment {
  id?: string
  name?: string
  contentType?: string
  size?: number
  contentBytes?: string
  isInline?: boolean
  contentId?: string
}

export interface GraphProfile {
  id?: string
  displayName?: string
  /** The user's SMTP address; falls back to userPrincipalName. */
  mail?: string | null
  userPrincipalName?: string
}

/** Typed non-auth API failure: HTTP status plus Graph's verbatim message. */
export class GraphApiError extends Error {
  readonly status: number
  /** Graph's OData error code (e.g. "ErrorItemNotFound"). */
  readonly code?: string

  constructor(status: number, message: string, code?: string) {
    super(message)
    this.name = "GraphApiError"
    this.status = status
    this.code = code
  }
}

/**
 * Validate a server-provided next/delta link: absolute https on the Graph
 * origin only (the Flectar reference's guard, translated). Returns the
 * normalized URL, or null when the link is unusable (callers treat null
 * as end-of-pages instead of throwing away the already-fetched pages).
 */
export function validatedGraphLink(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (
      parsed.protocol === "https:" &&
      parsed.hostname.toLowerCase() === GRAPH_LINK_HOST &&
      (parsed.pathname === "/v1.0" || parsed.pathname.startsWith("/v1.0/"))
    ) {
      return parsed.toString()
    }
  } catch {
    // A non-URL value is unusable.
  }
  return null
}

/** Retry-After in ms (delta-seconds form, then HTTP-date), or null. */
export function retryAfterMsOf(
  getHeader: (name: string) => string | null
): number | null {
  const header = getHeader("retry-after")
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, THROTTLE_MAX_WAIT_MS)
  }
  const dateMs = Date.parse(header)
  if (!Number.isNaN(dateMs)) {
    return Math.min(Math.max(dateMs - Date.now(), 0), THROTTLE_MAX_WAIT_MS)
  }
  return null
}

export interface GraphClientDeps {
  accountId: string
  /** Access-token source (microsoft-token-manager's token source). */
  getToken: (force?: boolean) => Promise<string>
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetchImpl?: FetchImpl
  /** Injectable wait for the Retry-After backoff (tests pass a recorder). */
  delayImpl?: (ms: number) => Promise<void>
}

export interface GraphClient {
  listFolders(): Promise<GraphFolder[]>
  /** One well-known folder by its addressable name ("inbox",
   * "sentitems", "drafts", "deleteditems", "archive", "junkemail") —
   * display names are locale-dependent, these names are not. */
  getWellKnownFolder(name: string): Promise<GraphFolder>
  /** One page of a folder's message delta. `pathOrLink` is the initial
   * `me/mailFolders/{id}/messages/delta` path, or a previously returned
   * nextLink/deltaLink (pre-validated with validatedGraphLink). */
  messageDeltaPage(pathOrLink: string): Promise<GraphPage<GraphMessage | GraphRemovedMessage>>
  getMessage(id: string): Promise<GraphMessage>
  /** Raw RFC 822 source — GET /me/messages/{id}/$value. */
  getMessageSource(id: string): Promise<string>
  moveMessage(id: string, destinationId: string): Promise<GraphMessage>
  /** PATCH the message's read/flag state (actions, task 3.3). */
  updateMessage(
    id: string,
    patch: { isRead?: boolean; flag?: { flagStatus: string } }
  ): Promise<GraphMessage>
  /** DELETE — moves to Deleted Items, or purges when already there. */
  deleteMessage(id: string): Promise<void>
  /** POST /me/sendMail with saveToSentItems (the sent copy lands in the
   * account's Sent Items folder — the spec's send scenario). */
  sendMail(message: Record<string, unknown>): Promise<void>
  /** Create an empty draft (raw-MIME upload target / appendMessage). */
  createDraft(): Promise<GraphMessage>
  /** Replace a draft with full RFC 822 MIME content (PUT .../$value). */
  setDraftMime(id: string, mime: string): Promise<void>
  /** Send an existing draft (files the sent copy). */
  sendDraft(id: string): Promise<void>
  getAttachment(
    messageId: string,
    attachmentId: string
  ): Promise<GraphAttachment>
  /** Raw attachment bytes — GET …/attachments/{id}/$value resolved as an
   * arraybuffer. Large file attachments (> ≈3 MB) carry no contentBytes
   * and are only reachable through this endpoint. */
  getAttachmentValue(
    messageId: string,
    attachmentId: string
  ): Promise<Uint8Array>
  getProfile(): Promise<GraphProfile>
}

export function createGraphClient(deps: GraphClientDeps): GraphClient {
  const fetchImpl = deps.fetchImpl ?? fetch
  const delay =
    deps.delayImpl ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

  async function toApiError(
    method: string,
    path: string,
    response: Response
  ): Promise<GraphApiError> {
    let apiMessage = ""
    let code: string | undefined
    try {
      const payload = (await response.json()) as {
        error?: { code?: string; message?: string }
      } | null
      apiMessage = payload?.error?.message ?? ""
      code = payload?.error?.code
    } catch {
      // Non-JSON error body — status alone still identifies the failure.
    }
    const detail = apiMessage ? `: ${apiMessage}` : ""
    return new GraphApiError(
      response.status,
      `Graph ${method} ${path} failed with ${response.status}` +
        `${code ? ` [${code}]` : ""}${detail}`,
      code
    )
  }

  async function requestRaw(
    method: string,
    pathOrUrl: string,
    options: {
      json?: unknown
      bodyText?: string
      contentType?: string
    } = {}
  ): Promise<Response> {
    const isAbsolute = pathOrUrl.startsWith("https://")
    const url = isAbsolute
      ? pathOrUrl
      : `${GRAPH_API_ROOT}/${pathOrUrl.replace(/^\//, "")}`

    async function send(accessToken: string): Promise<Response> {
      const headers: Record<string, string> = {
        authorization: `Bearer ${accessToken}`,
      }
      if (options.json !== undefined) {
        headers["content-type"] = "application/json"
      } else if (options.contentType) {
        headers["content-type"] = options.contentType
      }
      return fetchImpl(url, {
        method,
        headers,
        body:
          options.json !== undefined
            ? JSON.stringify(options.json)
            : options.bodyText,
      })
    }

    let response = await send(await deps.getToken())
    if (response.status === 401) {
      // One silent refresh, one retry — then the account is broken.
      response = await send(await deps.getToken(true))
      if (response.status === 401) {
        throw new ProviderAuthError(
          deps.accountId,
          "microsoft",
          "Microsoft Graph rejected the access token after a silent " +
            "refresh; re-authorization is required"
        )
      }
    }
    return response
  }

  async function request(
    method: string,
    pathOrUrl: string,
    options: {
      json?: unknown
      bodyText?: string
      contentType?: string
    } = {}
  ): Promise<Response> {
    let response = await requestRaw(method, pathOrUrl, options)
    // Throttle: honor Retry-After on 429/503 with the queue processor's
    // exponential shape — the header wins when present, otherwise the
    // base delay doubles per retry; bounded waits, capped retries.
    for (let retry = 0; retry < MAX_THROTTLE_RETRIES; retry++) {
      if (response.status !== 429 && response.status !== 503) break
      const waitMs =
        retryAfterMsOf((name) => response.headers.get(name)) ??
        Math.min(THROTTLE_BASE_MS * 2 ** retry, THROTTLE_MAX_WAIT_MS)
      await delay(waitMs)
      response = await requestRaw(method, pathOrUrl, options)
    }
    if (!response.ok) {
      throw await toApiError(method, pathOrUrl, response)
    }
    return response
  }

  async function requestJson<T>(
    method: string,
    pathOrUrl: string,
    options: { json?: unknown } = {}
  ): Promise<T> {
    const response = await request(method, pathOrUrl, options)
    if (method === "DELETE") return undefined as T
    return (await response.json()) as T
  }

  return {
    async listFolders(): Promise<GraphFolder[]> {
      // The mailbox folder TREE: top-level mailFolders first, then every
      // folder's childFolders page (recursively, following nextLink at
      // every level). Graph does not recurse on its own — without the walk,
      // messages in nested folders (Inbox/Work) are invisible forever.
      // Guards: a depth cap, a total-folder cap, and a seen-id set so a
      // hostile parentFolderId cycle cannot loop the walk.
      const folders: GraphFolder[] = []
      const seen = new Set<string>()

      async function fetchAllPages(
        firstUrl: string,
        into: GraphFolder[]
      ): Promise<void> {
        let url: string | null = firstUrl
        while (url) {
          if (folders.length >= MAX_FOLDERS) return
          const page: GraphPage<GraphFolder> = await requestJson<
            GraphPage<GraphFolder>
          >("GET", url)
          for (const folder of page.value ?? []) {
            if (folders.length >= MAX_FOLDERS) break
            into.push(folder)
          }
          url = page["@odata.nextLink"]
            ? validatedGraphLink(page["@odata.nextLink"])
            : null
        }
      }

      const topLevel: GraphFolder[] = []
      await fetchAllPages("me/mailFolders?$top=100", topLevel)
      const queue: { folder: GraphFolder; depth: number }[] = []
      for (const folder of topLevel) {
        if (!folder.id || seen.has(folder.id)) continue
        seen.add(folder.id)
        folders.push(folder)
        queue.push({ folder, depth: 0 })
      }
      while (queue.length > 0 && folders.length < MAX_FOLDERS) {
        const entry = queue.shift()
        if (!entry || entry.depth >= MAX_FOLDER_DEPTH) continue
        // childFolderCount is a default list property; only folders that
        // report children (or omit the field entirely) are expanded.
        const childCount = entry.folder.childFolderCount
        if (typeof childCount === "number" && childCount <= 0) continue
        const children: GraphFolder[] = []
        await fetchAllPages(
          `me/mailFolders/${encodeURIComponent(entry.folder.id)}/childFolders?$top=100`,
          children
        )
        for (const child of children) {
          if (folders.length >= MAX_FOLDERS) break
          if (!child.id || seen.has(child.id)) continue // cycle guard
          seen.add(child.id)
          folders.push(child)
          queue.push({ folder: child, depth: entry.depth + 1 })
        }
      }
      return folders
    },

    async getWellKnownFolder(name: string): Promise<GraphFolder> {
      return requestJson<GraphFolder>(
        "GET",
        `me/mailFolders/${encodeURIComponent(name)}`
      )
    },

    messageDeltaPage(pathOrLink: string) {
      return requestJson<GraphPage<GraphMessage | GraphRemovedMessage>>(
        "GET",
        pathOrLink
      )
    },

    async getMessage(id: string): Promise<GraphMessage> {
      return requestJson<GraphMessage>(
        "GET",
        `me/messages/${encodeURIComponent(id)}?$select=${encodeURIComponent(
          [
            "id",
            "subject",
            "body",
            "bodyPreview",
            "internetMessageId",
            "internetMessageHeaders",
            "from",
            "toRecipients",
            "ccRecipients",
            "bccRecipients",
            "receivedDateTime",
            "isRead",
            "hasAttachments",
            "flag",
            "conversationId",
            "parentFolderId",
          ].join(",")
        )}&$expand=${encodeURIComponent("attachments")}`
      )
    },

    async getMessageSource(id: string): Promise<string> {
      const response = await request(
        "GET",
        `me/messages/${encodeURIComponent(id)}/$value`
      )
      return response.text()
    },

    async moveMessage(id: string, destinationId: string) {
      return requestJson<GraphMessage>(
        "POST",
        `me/messages/${encodeURIComponent(id)}/move`,
        { json: { destinationId } }
      )
    },

    async updateMessage(id, patch) {
      return requestJson<GraphMessage>(
        "PATCH",
        `me/messages/${encodeURIComponent(id)}`,
        { json: patch }
      )
    },

    async deleteMessage(id: string): Promise<void> {
      await request("DELETE", `me/messages/${encodeURIComponent(id)}`)
    },

    async sendMail(message: Record<string, unknown>): Promise<void> {
      await request("POST", "me/sendMail", {
        json: { message, saveToSentItems: true },
      })
    },

    async createDraft(): Promise<GraphMessage> {
      return requestJson<GraphMessage>("POST", "me/messages", { json: {} })
    },

    async setDraftMime(id: string, mime: string): Promise<void> {
      // "Update a draft message with new MIME content" — the raw-value PUT.
      await request("PUT", `me/messages/${encodeURIComponent(id)}/$value`, {
        bodyText: mime,
        contentType: "text/plain; charset=UTF-8",
      })
    },

    async sendDraft(id: string): Promise<void> {
      await request("POST", `me/messages/${encodeURIComponent(id)}/send`, {
        json: {},
      })
    },

    async getAttachment(
      messageId: string,
      attachmentId: string
    ): Promise<GraphAttachment> {
      return requestJson<GraphAttachment>(
        "GET",
        `me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
      )
    },

    async getAttachmentValue(
      messageId: string,
      attachmentId: string
    ): Promise<Uint8Array> {
      const response = await request(
        "GET",
        `me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}/$value`
      )
      return new Uint8Array(await response.arrayBuffer())
    },

    async getProfile(): Promise<GraphProfile> {
      return requestJson<GraphProfile>(
        "GET",
        "me?$select=id,displayName,mail,userPrincipalName"
      )
    },
  }
}
