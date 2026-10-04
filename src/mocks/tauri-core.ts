import { imapFolderByPath, IMAP_FOLDERS } from "./fixture-data"
import { installMockHarness } from "./index"

/**
 * Mock @tauri-apps/api/core (mock dev mode only): canned invoke results
 * for the Rust command surface. IMAP/SMTP sync commands resolve healthy,
 * empty results shaped like the wire types in services/email/invoke.ts
 * so the sync indicator stays green; attachment and OAuth commands
 * reject explicitly; unknown commands reject without crashing (warned
 * once per command name).
 */

const warnedCommands = new Set<string>()

function mockFolderStatus(folderPath: string): {
  uidValidity: number
  uidNext: number
  exists: number
  unseen: number
  highestModseq: number
} {
  const folder = imapFolderByPath(folderPath) ?? IMAP_FOLDERS[0]
  return {
    uidValidity: folder.uidValidity,
    uidNext: folder.lastSeenUid + 1,
    exists: folder.lastSeenUid,
    unseen: folder.unseen,
    highestModseq: folder.highestModseq,
  }
}

function warnOnce(command: string, error: Error): void {
  if (warnedCommands.has(command)) return
  warnedCommands.add(command)
  console.warn(`[mock invoke] ${command} rejected: ${error.message}`)
}

/** The in-memory credential-sealing key slot backing the
 * `credentials_key_os_*` stubs (lives for the tab's lifetime — mock mode
 * seeds a fresh :memory: database every load anyway). */
let mockOsKeyStore: string | null = null

/**
 * The subset of `args` values the stubs read, loosely typed — the real
 * wire args are validated Rust-side; the mock only needs folder names.
 */
function readArg(
  args: Record<string, unknown> | undefined,
  key: string
): unknown {
  return args?.[key]
}

/**
 * Live-AI mode (mock dev mode only, opt-in via `?liveAi=1`): `ai_chat`
 * calls pass through to the CONFIGURED OpenAI-compatible endpoint
 * instead of the canned reply, so the whole TS AI stack (gates, tier
 * routing, prompt builders, parsers, cache, usage rows) can be exercised
 * against a real model. The wire behavior mirrors ai/openai_compat.rs
 * exactly — same URL join, Bearer-header-when-keyed, request shape,
 * `choices[0].message.content` parse, usage block, and error kinds — so
 * observations transfer to the Rust transport. Vendor kinds (anthropic,
 * openai, gemini) keep their dedicated Rust modules and are not
 * proxied here: they reject as a config error, same fail-toward-off
 * direction the Rust command uses for a missing base URL.
 */
const LIVE_AI =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).has("liveAi")

interface LiveAiWireMessage {
  role: string
  content: string
}

/**
 * POST one chat-completions request: direct fetch first; when the browser
 * blocks it (a gateway without CORS headers — the Rust transport has no
 * such restriction), retry through the dev-server relay (`/__live-ai-proxy`,
 * vite.config.ts liveAiProxy, mock mode only). Status 0 from the relay
 * means the upstream fetch itself failed there.
 */
async function liveAiPost(
  url: string,
  headers: Record<string, string>,
  bodyJson: string
): Promise<{ status: number; text: string }> {
  let directFailure: unknown
  try {
    const direct = await fetch(url, {
      method: "POST",
      headers,
      body: bodyJson,
      signal: AbortSignal.timeout(120_000),
    })
    return { status: direct.status, text: await direct.text() }
  } catch (error) {
    directFailure = error
  }
  try {
    const relay = await fetch("/__live-ai-proxy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, headers, body: bodyJson }),
      signal: AbortSignal.timeout(120_000),
    })
    const payload = (await relay.json()) as { status: number; text: string }
    return payload
  } catch (relayError) {
    throw {
      kind: "network",
      message: `[mock live-ai] ${directFailure instanceof Error ? directFailure.message : String(directFailure)}; relay: ${relayError instanceof Error ? relayError.message : String(relayError)}`,
    }
  }
}

async function liveAiChat<T>(
  args: Record<string, unknown> | undefined
): Promise<T> {
  const provider = String(readArg(args, "provider") ?? "")
  let baseUrl = String(readArg(args, "baseUrl") ?? "").trim()
  if (provider === "ollama" && baseUrl === "") baseUrl = "http://localhost:11434"
  if (provider !== "custom" && provider !== "openai-compatible" && provider !== "ollama") {
    throw {
      kind: "config",
      message: `[mock live-ai] provider "${provider}" has no browser proxy — use a custom endpoint`,
    }
  }
  if (baseUrl === "") {
    throw { kind: "config", message: "openai-compatible requires a base URL" }
  }

  const apiKey = String(readArg(args, "apiKey") ?? "").trim()
  const system = readArg(args, "system")
  const rawMessages = Array.isArray(readArg(args, "messages"))
    ? (readArg(args, "messages") as LiveAiWireMessage[])
    : []
  const messages: LiveAiWireMessage[] =
    typeof system === "string" && system !== ""
      ? [{ role: "system", content: system }, ...rawMessages]
      : rawMessages
  const body = {
    model: String(readArg(args, "model") ?? ""),
    max_tokens: typeof readArg(args, "maxTokens") === "number"
      ? (readArg(args, "maxTokens") as number)
      : 1024,
    messages,
  }

  let response: { status: number; text: string }
  try {
    response = await liveAiPost(
      `${baseUrl.replace(/\/+$/, "")}/v1/chat/completions`,
      {
        "content-type": "application/json",
        ...(apiKey !== "" ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      JSON.stringify(body)
    )
  } catch (error) {
    throw {
      kind: "network",
      message: `[mock live-ai] ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const text = response.text
  if (response.status === 429) {
    throw {
      kind: "rate_limited",
      message: `[mock live-ai] 429: ${text.slice(0, 200)}`,
      status: 429,
    }
  }
  if (!(response.status >= 200 && response.status < 300)) {
    throw {
      kind: "status",
      message: `[mock live-ai] ${response.status}: ${text.slice(0, 200)}`,
      status: response.status,
    }
  }

  let parsed: {
    choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>
    model?: string
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  }
  try {
    parsed = JSON.parse(text)
  } catch {
    throw { kind: "parse", message: "[mock live-ai] response body is not JSON" }
  }
  const content = parsed.choices?.[0]?.message?.content
  if (typeof content !== "string") {
    // Same user-facing distinction the Rust client draws (openai_compat.rs
    // BUDGET_EXHAUSTED_MESSAGE): a length-capped empty reply means the
    // budget went to reasoning, not a malformed body.
    const budgetExhausted = parsed.choices?.some(
      (choice) => choice.finish_reason === "length"
    )
    throw {
      kind: "parse",
      message: budgetExhausted
        ? "The model spent its entire token budget before producing an answer — its internal reasoning filled max_tokens. Try again, or switch to a model that reasons less."
        : "no choices[0].message.content in the response",
    }
  }
  const usage =
    typeof parsed.usage?.prompt_tokens === "number" &&
    typeof parsed.usage?.completion_tokens === "number"
      ? {
          prompt_tokens: parsed.usage.prompt_tokens,
          completion_tokens: parsed.usage.completion_tokens,
          total_tokens:
            parsed.usage.total_tokens ??
            parsed.usage.prompt_tokens + parsed.usage.completion_tokens,
        }
      : undefined
  const servedModel = parsed.model ?? body.model
  logLiveAi(args, servedModel, usage?.total_tokens ?? null)
  return {
    content,
    model: servedModel,
    ...(usage !== undefined ? { usage } : {}),
  } as T
}

/** One diagnostic line per live call: surface → served model + token
 * count. `kilo-auto/free`-style routing aliases may hop underlying
 * models per request, so the served id is the useful failure signal. */
function logLiveAi(
  args: Record<string, unknown> | undefined,
  servedModel: string,
  totalTokens: number | null
): void {
  console.info(
    `[mock live-ai] ${String(readArg(args, "surface") ?? "?")} → ${servedModel}` +
      (totalTokens !== null ? ` (${totalTokens} tokens)` : "")
  )
}

export async function invoke<T = unknown>(
  command: string,
  args?: Record<string, unknown>
): Promise<T> {
  installMockHarness()

  // Badge / UI-side commands: cosmetic, resolve immediately.
  if (command === "set_unread_badge") return null as T

  // Gravatar avatars (task 2.5, design D12): mock mode never reaches the
  // network — null means "no Gravatar", so the deterministic initials
  // avatar renders everywhere.
  if (command === "gravatar_fetch") return null as T

  // Desktop integration commands (Phase 1): the browser mock has no tray,
  // window state, or OS registrations, so tray availability is honestly
  // false (the settings UI hides tray controls) and the live-value pushes
  // resolve as no-ops.
  if (command === "set_close_action") return null as T
  if (command === "get_close_action") return "quit" as T
  if (command === "tray_available") return false as T
  if (command === "mailto_default_state") {
    return { is_default: false, current_handler: null } as T
  }
  if (command === "mailto_set_default") return null as T
  if (command === "initial_deep_links") return [] as T
  if (command === "autostart_is_enabled") return false as T
  if (command === "autostart_set_enabled") return null as T
  if (command === "close_splashscreen") return null as T
  // Pop-out windows (1.9): the mock browser has no window system — the
  // open affordances are hidden outside the Tauri runtime anyway.
  if (command === "open_thread_popout") return "popout-mock" as T
  if (command === "force_close_popout") return null as T
  // Global shortcut: the mock cannot validate OS accelerator syntax, so
  // anything parseable-looking is accepted; null clears.
  if (command === "set_global_compose_shortcut") {
    const accelerator = readArg(args, "accelerator")
    if (accelerator !== null && typeof accelerator !== "string") {
      throw new Error("accelerator must be a string or null")
    }
    return null as T
  }

  // AI chat (task 4.2, design D1): mock mode has no provider network —
  // every call succeeds with a canned reply so the AI surfaces can be
  // exercised against a configured provider without hitting the real
  // command (the wire shape mirrors ai/mod.rs's ChatResponse). The
  // event-extraction surface gets a shape-valid reply so its review →
  // accept → prefilled-form flow is smokeable end to end (the thread's
  // own messages are not read — the suggestion is fixed demo data).
  // With `?liveAi=1` the call instead passes through to the configured
  // endpoint (see liveAiChat) for real-model testing.
  if (command === "ai_chat") {
    if (LIVE_AI) return liveAiChat<T>(args)
    const system = String(readArg(args, "system") ?? "")
    if (system.includes('"events"')) {
      return {
        content:
          '{"events": [{"title": "Design review", "start": "2026-10-05 14:00", ' +
          '"end": "2026-10-05 15:00", "allDay": false, "location": "Room 4", ' +
          '"notes": "From the mock provider", "messageIndex": 0}]}',
        model: "mock-model",
      } as T
    }
    // Assistant surface (ai-assistant-panel task 5.1): the tool loop is
    // driveable end to end without a stateful mock — inspect the LAST
    // message. No tool result yet → emit one search tool call; a tool
    // result in hand → emit the plain-text answer citing it.
    if (String(readArg(args, "surface") ?? "") === "assistant") {
      const messages = Array.isArray(readArg(args, "messages"))
        ? (readArg(args, "messages") as Array<{ role: string; content: string }>)
        : []
      const last = messages[messages.length - 1]
      if (last && last.content.includes("[TOOL_RESULT")) {
        return {
          content:
            "Here is what I found in your mailbox. The mock assistant is read-only and this reply is canned demo data — check the sources under the conversation.",
          model: "mock-model",
        } as T
      }
      return {
        content: '{"tool": "search", "args": {"query": "is:unread"}}',
        model: "mock-model",
      } as T
    }
    return { content: "Mock AI reply.", model: "mock-model" } as T
  }

  // Credential-sealing key OS store (secrets.rs): browser mock mode has
  // no OS keychain, so the per-install key round-trips through an
  // in-memory slot. Same contract as the Rust commands: store persists
  // base64, load returns it or null for a fresh install.
  if (command === "credentials_key_os_store") {
    mockOsKeyStore = String(readArg(args, "keyB64") ?? "")
    return null as T
  }
  if (command === "credentials_key_os_load") {
    return (mockOsKeyStore ?? null) as T
  }
  if (command === "credentials_key_os_delete") {
    mockOsKeyStore = null
    return null as T
  }
  // Best-effort chmod on the fallback key file — nothing to restrict in
  // the browser; succeed so the caller's warn-once stays quiet.
  if (command === "restrict_credentials_key_permissions") {
    return null as T
  }

  // IMAP commands: healthy empty folder state. The fixture folders'
  // uidvalidity matches the seeded folder_sync_state rows, so the sync
  // engine takes the delta path and finds zero new messages.
  if (command === "imap_test_connection") {
    return {
      host: "imap.fastmail.com",
      port: 993,
      security: "tls",
      capabilities: ["IMAP4REV1", "UIDPLUS", "MOVE", "CONDSTORE"],
      folderCount: IMAP_FOLDERS.length,
    } as T
  }
  if (command === "imap_list_folders") {
    return IMAP_FOLDERS.map((folder) => ({
      name: folder.path,
      delimiter: "/",
      selectable: true,
      role: folder.role,
    })) as T
  }
  if (command === "imap_fetch_messages") {
    return {
      messages: [],
      folderStatus: mockFolderStatus(String(readArg(args, "folder") ?? "")),
    } as T
  }
  if (command === "imap_fetch_flags") return [] as T
  if (command === "imap_fetch_flags_changed") {
    return {
      flags: [],
      folderStatus: mockFolderStatus(String(readArg(args, "folder") ?? "")),
    } as T
  }
  if (
    command === "imap_store_flags" ||
    command === "imap_move_message" ||
    command === "imap_delete_message" ||
    command === "imap_append" ||
    command === "imap_create_folder" ||
    command === "imap_rename_folder" ||
    command === "imap_delete_folder"
  ) {
    return null as T
  }

  // SMTP commands: the local-first send flow files the message into the
  // seeded database; the replayed queue op just needs a success result.
  if (command === "smtp_send_email") {
    return { messageId: `<mock-${crypto.randomUUID()}@mock.local>` } as T
  }
  if (command === "smtp_test_connection") {
    return {
      host: "smtp.fastmail.com",
      port: 465,
      security: "tls",
      authenticated: true,
      server: "mock-smtp.local",
      capabilities: ["PIPELINING", "8BITMIME", "SMTPUTF8"],
    } as T
  }

  // Storage usage (task 1.6): a canned breakdown in the wire shape of
  // src-tauri/src/storage.rs so the settings section renders.
  if (command === "storage_usage") {
    return {
      kinds: [
        { kind: "attachments", bytes: 18 * 1024 * 1024 },
        { kind: "databases", bytes: 64 * 1024 * 1024 },
        { kind: "keys", bytes: 32 },
        { kind: "other", bytes: 4096 },
      ],
      total: 18 * 1024 * 1024 + 64 * 1024 * 1024 + 32 + 4096,
      unreadableEntries: 0,
    } as T
  }
  // Delete-all (task 1.7): a real wipe would end the session — mock mode
  // rejects so the flow's error path stays demonstrable.
  if (command === "delete_all_local_data") {
    const wipeError = new Error(
      "[mock] delete-all-local-data is not available in mock mode"
    )
    warnOnce(command, wipeError)
    throw wipeError
  }

  // Explicit rejections.
  const attachmentError = new Error(
    "[mock] attachments are not available in mock mode"
  )
  if (command === "imap_fetch_attachment") {
    warnOnce(command, attachmentError)
    throw attachmentError
  }
  const oauthError = new Error(
    "[mock] account flows are not available in mock mode"
  )
  if (command === "start_oauth_server" || command === "cancel_oauth_server") {
    warnOnce(command, oauthError)
    throw oauthError
  }

  const unknownError = new Error(`[mock] invoke not stubbed: ${command}`)
  warnOnce(command, unknownError)
  throw unknownError
}

/** Nothing else from @tauri-apps/api/core is imported anywhere in src. */
export function convertFileSrc(filePath: string): string {
  return filePath
}

/**
 * Inert stand-ins for the api/core IPC plumbing classes the plugin JS
 * packages import from @tauri-apps/api/core (which this module aliases
 * in mock mode). They are never exercised — Tauri-only features refuse
 * to run outside the desktop app — they only need to satisfy the import
 * graph.
 */
export class Resource {
  rid: number
  constructor(rid: number) {
    this.rid = rid
  }
  async close(): Promise<void> {}
}

export class Channel<T = unknown> {
  static readonly __CHANNEL_MARKER__ = true
  #onmessage: ((data: T) => void) | null = null
  set onmessage(handler: (data: T) => void) {
    this.#onmessage = handler
  }
  get id(): number {
    return -1
  }
  toJSON(): string {
    return `__CHANNEL__:${this.id}`
  }
  invoke(value: unknown): void {
    this.#onmessage?.(value as T)
  }
}
