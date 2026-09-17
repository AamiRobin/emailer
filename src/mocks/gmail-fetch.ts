import { ALL_GMAIL_LABELS, GMAIL_HISTORY_ID } from "./fixture-data"

/**
 * Mock Gmail REST + OAuth token endpoints (mock dev mode only). The gmail
 * sync engine talks to Gmail over fetch (tauri-plugin-http in the real
 * app; plain window.fetch in a browser), so invoke stubs cannot cover it:
 * this patch answers Google endpoints with minimal, healthy responses —
 * an empty history delta, the seeded label list, and token refreshes —
 * so the background sync stays green without network access. Anything
 * else goes to the real fetch.
 */

const GMAIL_API_ROOT = "https://gmail.googleapis.com/gmail/v1/users/me"
const GMAIL_UPLOAD_ROOT =
  "https://gmail.googleapis.com/upload/gmail/v1/users/me"
const GMAIL_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"

let installed = false
let originalFetch: typeof fetch | null = null

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function googleError(status: number, message: string): Response {
  return jsonResponse(
    {
      error: {
        code: status,
        message,
        errors: [{ reason: "mock" }],
        status: "NOT_FOUND",
      },
    },
    status
  )
}

/** Deterministic-looking opaque id (not a real Gmail id, just plausible). */
function mockId(): string {
  const hex = "0123456789abcdef"
  let id = "m"
  for (let i = 0; i < 15; i++) {
    id += hex[Math.floor(Math.random() * hex.length)]
  }
  return id
}

/** Deterministic placeholder bytes for one mocked attachment: readable
 * repeating ASCII so Save/Open have real content in mock mode without
 * shipping fixture payloads. Gmail wire format is base64url. */
function mockAttachmentData(messageId: string, partId: string): string {
  const bytes = new TextEncoder().encode(
    `mock attachment content — ${messageId}/${partId}\n`.repeat(8)
  )
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

async function mockGoogleResponse(
  url: string,
  method: string
): Promise<Response> {
  const path = url.split("?")[0]

  if (url.startsWith(GMAIL_TOKEN_ENDPOINT)) {
    return jsonResponse({
      access_token: "mock-access-token",
      expires_in: 3600,
      token_type: "Bearer",
      scope: "https://mail.google.com/",
    })
  }

  if (path === `${GMAIL_API_ROOT}/labels` && method === "GET") {
    return jsonResponse({
      labels: ALL_GMAIL_LABELS.map((label) => ({
        id: label.id,
        name: label.id,
        type: label.specialUse ? "system" : "user",
      })),
    })
  }

  if (path === `${GMAIL_API_ROOT}/profile`) {
    return jsonResponse({
      historyId: String(GMAIL_HISTORY_ID),
      messagesTotal: 214,
      threadsTotal: 118,
    })
  }

  if (path === `${GMAIL_API_ROOT}/history`) {
    // Empty delta at a cursor just past the seeded one: zero new mail,
    // healthy pass.
    return jsonResponse({
      history: [],
      historyId: String(GMAIL_HISTORY_ID + 7),
    })
  }

  if (path.startsWith(GMAIL_UPLOAD_ROOT) && method === "POST") {
    // messages.insert (sent-mail filing / drafts append).
    return jsonResponse({
      id: mockId(),
      threadId: mockId(),
      labelIds: ["SENT"],
    })
  }

  if (path === `${GMAIL_API_ROOT}/messages` && method === "POST") {
    return jsonResponse({ id: mockId(), threadId: mockId(), labelIds: [] })
  }

  if (path === `${GMAIL_API_ROOT}/messages/send` && method === "POST") {
    return jsonResponse({
      id: mockId(),
      threadId: mockId(),
      labelIds: ["SENT"],
    })
  }

  if (path.startsWith(`${GMAIL_API_ROOT}/messages/`) && method === "POST") {
    // .../messages/<id>/modify (flag/label queue replays).
    const id = path.slice(`${GMAIL_API_ROOT}/messages/`.length)
    return jsonResponse({ id, threadId: mockId(), labelIds: [] })
  }

  if (path === `${GMAIL_API_ROOT}/messages` && method === "GET") {
    return jsonResponse({ messages: [], resultSizeEstimate: 0 })
  }

  const ATTACHMENTS_PREFIX = `${GMAIL_API_ROOT}/messages/`
  if (
    path.startsWith(ATTACHMENTS_PREFIX) &&
    path.includes("/attachments/") &&
    method === "GET"
  ) {
    // Attachment content (messages/<id>/attachments/<part>): the seeded
    // rows carry no bytes, so the UI's Save/Open would otherwise surface
    // the generic 404 as "Could not save this file." — serve placeholder
    // content instead.
    const [, tail] = path.slice(ATTACHMENTS_PREFIX.length).split("/")
    const [messageId, partId] = tail.split("/attachments/")
    return jsonResponse({
      data: mockAttachmentData(messageId, partId),
      size: 256,
    })
  }

  if (path.startsWith(`${GMAIL_API_ROOT}/messages/`)) {
    // Full message bodies are seeded locally; the server copy 404s and
    // every caller skips 404s by design.
    return googleError(
      404,
      "[mock] message bodies are not available in mock mode"
    )
  }

  return googleError(
    404,
    `[mock] Gmail endpoint not stubbed: ${method} ${path}`
  )
}

/** Patch globalThis.fetch once; later calls are no-ops. */
export function installGmailFetchStub(): void {
  if (installed) return
  installed = true
  originalFetch = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url
    if (
      url.startsWith(GMAIL_API_ROOT) ||
      url.startsWith(GMAIL_UPLOAD_ROOT) ||
      url.startsWith(GMAIL_TOKEN_ENDPOINT)
    ) {
      return mockGoogleResponse(url, init?.method ?? "GET")
    }
    return originalFetch !== null
      ? originalFetch(input, init)
      : Promise.reject(new Error("[mock] no fetch"))
  }) as typeof fetch
}
