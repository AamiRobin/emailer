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
