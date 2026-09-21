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
  // command (the wire shape mirrors ai/mod.rs's ChatResponse).
  if (command === "ai_chat") {
    return { content: "Mock AI reply.", model: "mock-model" } as T
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
