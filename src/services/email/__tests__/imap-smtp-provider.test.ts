import { beforeEach, describe, expect, it, vi } from "vitest"
import { invoke } from "@tauri-apps/api/core"

import { ProviderAuthError } from "../types"
import {
  createImapSmtpProvider,
  isAuthErrorMessage,
} from "../imap-smtp-provider"
import type { ImapFetchResult, ImapFolder } from "../invoke"
import { imapAccount, imapCredentials } from "./fixtures"

vi.mock("@tauri-apps/api/core")

const invokeMock = vi.mocked(invoke)

const expectedImapParams = {
  host: "imap.example.com",
  port: 993,
  security: "tls",
  username: "user@example.com",
  password: "secret",
  acceptInvalidCerts: false,
}

const expectedSmtpParams = {
  host: "smtp.example.com",
  port: 465,
  security: "tls",
  username: "user@example.com",
  password: "secret",
  acceptInvalidCerts: false,
}

function folder(overrides: Partial<ImapFolder>): ImapFolder {
  return {
    name: "INBOX",
    delimiter: "/",
    selectable: true,
    role: null,
    ...overrides,
  }
}

function fullImapMessage() {
  return {
    uid: 42,
    flags: ["\\Seen", "$Label1"],
    messageId: "<m-1@example.com>",
    inReplyTo: null,
    references: "<m-0@example.com>",
    subject: "Hello",
    from: [
      { name: "Ada", email: "ada@example.com" },
      { name: null, email: null },
    ],
    to: [{ name: null, email: "user@example.com" }],
    cc: [{ name: "Bob", email: "bob@example.com" }],
    bcc: [],
    date: 1_700_000_000,
    textBody: "hi",
    htmlBody: null,
    size: 1024,
    attachments: [
      {
        partId: "1",
        filename: "a.pdf",
        mimeType: "application/pdf",
        size: 10,
        contentId: null,
        isInline: false,
      },
      {
        partId: "2",
        filename: "logo.png",
        mimeType: "image/png",
        size: 20,
        contentId: "cid-1",
        isInline: true,
      },
    ],
  }
}

function fetchResult(): ImapFetchResult {
  return {
    messages: [fullImapMessage()],
    folderStatus: { uidValidity: 7, uidNext: 43, exists: 42, unseen: 1 },
  }
}

/** Route mocked invoke responses by command name. */
function mockCommands(handlers: Record<string, unknown>) {
  invokeMock.mockImplementation(((command: string) => {
    if (command in handlers) return Promise.resolve(handlers[command])
    return Promise.reject(new Error(`unexpected command: ${command}`))
  }) as typeof invoke)
}

const provider = () => createImapSmtpProvider(imapAccount(), imapCredentials)

beforeEach(() => {
  invokeMock.mockReset()
})

describe("folder listing", () => {
  it("invokes imap_list_folders with camelCase params and filters containers", async () => {
    mockCommands({
      imap_list_folders: [
        folder({ name: "[Gmail]", selectable: false }),
        folder({ name: "INBOX", role: "inbox" }),
        folder({ name: "Work/ACME" }),
      ],
    })
    const folders = await provider().listFolders()

    expect(invokeMock).toHaveBeenCalledWith("imap_list_folders", {
      params: expectedImapParams,
    })
    expect(folders.map((f) => f.path)).toEqual(["INBOX", "Work/ACME"])
    expect(folders[0]).toMatchObject({
      id: "INBOX",
      name: "Inbox",
      type: "system",
      specialUse: "inbox",
    })
  })
})

describe("message fetching and mapping", () => {
  it("invokes imap_fetch_messages with uidSet and maps to NormalizedMessage", async () => {
    mockCommands({ imap_fetch_messages: fetchResult() })
    const result = await provider().fetchMessages("INBOX", { uidSet: "1:100" })

    expect(invokeMock).toHaveBeenCalledWith("imap_fetch_messages", {
      params: expectedImapParams,
      folder: "INBOX",
      uidSet: "1:100",
      last: undefined,
    })
    expect(result.folderStatus).toEqual({
      uidValidity: 7,
      uidNext: 43,
      exists: 42,
      unseen: 1,
    })
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toEqual({
      uid: 42,
      flags: ["\\Seen", "$Label1"],
      messageId: "<m-1@example.com>",
      inReplyTo: undefined, // Rust null → undefined
      references: "<m-0@example.com>",
      subject: "Hello",
      from: [
        { name: "Ada", email: "ada@example.com" },
        { name: undefined, email: undefined },
      ],
      to: [{ name: undefined, email: "user@example.com" }],
      cc: [{ name: "Bob", email: "bob@example.com" }],
      bcc: [],
      date: 1_700_000_000,
      textBody: "hi",
      htmlBody: undefined,
      size: 1024,
      attachments: [
        {
          partId: "1",
          filename: "a.pdf",
          mimeType: "application/pdf",
          size: 10,
          contentId: undefined,
          isInline: false,
        },
        {
          partId: "2",
          filename: "logo.png",
          mimeType: "image/png",
          size: 20,
          contentId: "cid-1",
          isInline: true,
        },
      ],
      folder: "INBOX",
    })
  })

  it("supports last=n with an empty uidSet (Rust resolves the range)", async () => {
    mockCommands({ imap_fetch_messages: fetchResult() })
    await provider().fetchMessages("INBOX", { last: 25 })

    expect(invokeMock).toHaveBeenCalledWith("imap_fetch_messages", {
      params: expectedImapParams,
      folder: "INBOX",
      uidSet: "",
      last: 25,
    })
  })

  it("requires a selector", async () => {
    await expect(provider().fetchMessages("INBOX", {})).rejects.toThrowError(
      /requires uidSet or last/
    )
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("invokes imap_fetch_flags for flags-only reconciliation", async () => {
    mockCommands({
      imap_fetch_flags: [{ uid: 1, flags: ["\\Seen"] }],
    })
    const flags = await provider().fetchFlags("INBOX", { last: 10 })

    expect(invokeMock).toHaveBeenCalledWith("imap_fetch_flags", {
      params: expectedImapParams,
      folder: "INBOX",
      uidSet: "",
      last: 10,
    })
    expect(flags).toEqual([{ uid: 1, flags: ["\\Seen"] }])
  })
})

describe("flags and organization operations", () => {
  it("storeFlags passes through to imap_store_flags", async () => {
    mockCommands({ imap_store_flags: undefined })
    await provider().storeFlags("INBOX", "1,5,9", ["\\Seen"], false)

    expect(invokeMock).toHaveBeenCalledWith("imap_store_flags", {
      params: expectedImapParams,
      folder: "INBOX",
      uidSet: "1,5,9",
      flags: ["\\Seen"],
      add: false,
    })
  })

  it("markRead groups refs by folder and sets \\Seen", async () => {
    mockCommands({ imap_store_flags: undefined })
    await provider().markRead(
      [
        { folder: "INBOX", uid: 1 },
        { folder: "INBOX", uid: 2 },
        { folder: "Archive", uid: 5 },
      ],
      true
    )

    expect(invokeMock).toHaveBeenCalledTimes(2)
    expect(invokeMock).toHaveBeenCalledWith("imap_store_flags", {
      params: expectedImapParams,
      folder: "INBOX",
      uidSet: "1,2",
      flags: ["\\Seen"],
      add: true,
    })
    expect(invokeMock).toHaveBeenCalledWith("imap_store_flags", {
      params: expectedImapParams,
      folder: "Archive",
      uidSet: "5",
      flags: ["\\Seen"],
      add: true,
    })
  })

  it("markStarred clears \\Flagged when unstarring", async () => {
    mockCommands({ imap_store_flags: undefined })
    await provider().markStarred([{ folder: "INBOX", uid: 3 }], false)

    expect(invokeMock).toHaveBeenCalledWith("imap_store_flags", {
      params: expectedImapParams,
      folder: "INBOX",
      uidSet: "3",
      flags: ["\\Flagged"],
      add: false,
    })
  })

  it("archive resolves the \\Archive folder and moves messages into it", async () => {
    mockCommands({
      imap_list_folders: [
        folder({ name: "INBOX", role: "inbox" }),
        folder({ name: "Archive", role: "archive" }),
        folder({ name: "Deleted", role: "trash" }),
      ],
      imap_move_message: undefined,
    })
    await provider().archive([
      { folder: "INBOX", uid: 1 },
      { folder: "Archive", uid: 9 }, // already there — skipped
    ])

    expect(invokeMock).toHaveBeenCalledTimes(2) // list + one move
    expect(invokeMock).toHaveBeenCalledWith("imap_move_message", {
      params: expectedImapParams,
      folder: "INBOX",
      uidSet: "1",
      destination: "Archive",
    })
  })

  it("trash resolves the \\Trash folder and moves messages into it", async () => {
    mockCommands({
      imap_list_folders: [folder({ name: "Deleted", role: "trash" })],
      imap_move_message: undefined,
    })
    await provider().trash([{ folder: "INBOX", uid: 2 }])

    expect(invokeMock).toHaveBeenCalledWith("imap_move_message", {
      params: expectedImapParams,
      folder: "INBOX",
      uidSet: "2",
      destination: "Deleted",
    })
  })

  it("archive fails clearly when the server has no archive folder", async () => {
    mockCommands({
      imap_list_folders: [folder({ name: "INBOX", role: "inbox" })],
    })
    await expect(
      provider().archive([{ folder: "INBOX", uid: 1 }])
    ).rejects.toThrowError(/no "archive" folder/)
  })

  it("moveToFolder skips no-op same-folder moves", async () => {
    mockCommands({ imap_move_message: undefined })
    await provider().moveToFolder(
      [
        { folder: "INBOX", uid: 1 },
        { folder: "INBOX", uid: 4 },
      ],
      "INBOX"
    )
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("deleteForever expunges per folder group", async () => {
    mockCommands({ imap_delete_message: undefined })
    await provider().deleteForever([{ folder: "Trash", uid: 8 }])

    expect(invokeMock).toHaveBeenCalledWith("imap_delete_message", {
      params: expectedImapParams,
      folder: "Trash",
      uidSet: "8",
    })
  })

  it("appendMessage uploads raw MIME bytes as a number array", async () => {
    mockCommands({ imap_append: undefined })
    const raw = new Uint8Array([1, 2, 3])
    await provider().appendMessage("Sent", raw, ["\\Seen"])

    expect(invokeMock).toHaveBeenCalledWith("imap_append", {
      params: expectedImapParams,
      folder: "Sent",
      message: [1, 2, 3],
      flags: ["\\Seen"],
    })
  })

  it("addLabels/removeLabels are documented no-ops on IMAP", async () => {
    await provider().addLabels([{ folder: "INBOX", uid: 1 }], ["L1"])
    await provider().removeLabels([{ folder: "INBOX", uid: 1 }], ["L1"])
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("deltaSync is reserved for task 4.3", async () => {
    await expect(provider().deltaSync(null)).rejects.toThrowError(
      /not implemented for IMAP accounts yet \(task 4\.3\)/
    )
    expect(invokeMock).not.toHaveBeenCalled()
  })
})

describe("sending", () => {
  it("invokes smtp_send_email with a camelCase wire email", async () => {
    mockCommands({ smtp_send_email: { messageId: "<gen@example.com>" } })
    const result = await provider().sendMessage({
      from: { name: "User", email: "user@example.com" },
      to: [{ email: "ada@example.com" }],
      subject: "Hi",
      htmlBody: "<p>Hi</p>",
      inReplyTo: "<m-0@example.com>",
    })

    expect(invokeMock).toHaveBeenCalledWith("smtp_send_email", {
      params: expectedSmtpParams,
      email: {
        from: { name: "User", email: "user@example.com" },
        to: [{ name: null, email: "ada@example.com" }],
        cc: [],
        bcc: [],
        subject: "Hi",
        htmlBody: "<p>Hi</p>",
        textBody: null,
        inReplyTo: "<m-0@example.com>",
        references: null,
        messageId: null,
      },
    })
    expect(result).toEqual({ messageId: "<gen@example.com>" })
  })

  it("rejects sending when the account has no SMTP host", async () => {
    const provider = createImapSmtpProvider(
      imapAccount({ smtpHost: undefined }),
      imapCredentials
    )
    await expect(
      provider.sendMessage({
        from: { email: "user@example.com" },
        to: [],
        subject: "Hi",
      })
    ).rejects.toThrowError(/no SMTP host configured/)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it("forwards attachments to the wire when present (task 8.5)", async () => {
    mockCommands({ smtp_send_email: { messageId: "<gen@example.com>" } })
    await provider().sendMessage({
      from: { email: "user@example.com" },
      to: [{ email: "ada@example.com" }],
      subject: "Files",
      htmlBody: "<p>Hi</p>",
      attachments: [
        {
          filename: "a.txt",
          mimeType: "text/plain",
          contentBase64: "aGk=",
        },
        { filename: "b.bin", contentBase64: "AAEC" },
      ],
    })

    expect(invokeMock).toHaveBeenCalledWith(
      "smtp_send_email",
      expect.objectContaining({
        email: expect.objectContaining({
          attachments: [
            {
              filename: "a.txt",
              mimeType: "text/plain",
              contentBase64: "aGk=",
            },
            { filename: "b.bin", mimeType: null, contentBase64: "AAEC" },
          ],
        }),
      })
    )
  })
})

describe("connection testing", () => {
  it("reports success when IMAP and SMTP authenticate", async () => {
    mockCommands({
      imap_test_connection: {
        host: "imap.example.com",
        port: 993,
        security: "tls",
        capabilities: ["IMAP4rev1"],
        folderCount: 12,
      },
      smtp_test_connection: {
        host: "smtp.example.com",
        port: 465,
        security: "tls",
        authenticated: true,
        server: "smtpd",
        capabilities: [],
      },
    })
    const result = await provider().testConnection()

    expect(invokeMock).toHaveBeenCalledWith("imap_test_connection", {
      params: expectedImapParams,
    })
    expect(invokeMock).toHaveBeenCalledWith("smtp_test_connection", {
      params: expectedSmtpParams,
    })
    expect(result.success).toBe(true)
    expect(result.authError).toBeUndefined()
  })

  it("flags auth failures via the authError marker", async () => {
    invokeMock.mockImplementation(() =>
      Promise.reject(
        new Error("IMAP login failed for user user@example.com: denied")
      )
    )
    const result = await provider().testConnection()
    expect(result.success).toBe(false)
    expect(result.authError).toBe(true)
    expect(result.message).toMatch(/login failed/)
  })

  it("does not flag network failures as auth errors", async () => {
    invokeMock.mockImplementation(() =>
      Promise.reject(new Error("Connection timed out"))
    )
    const result = await provider().testConnection()
    expect(result.success).toBe(false)
    expect(result.authError).toBe(false)
  })
})

describe("auth error mapping", () => {
  it("maps login failures to ProviderAuthError with account identity", async () => {
    invokeMock.mockImplementation(() =>
      Promise.reject(
        new Error(
          "IMAP login failed for user user@example.com: [AUTHENTICATIONFAILED] Access denied"
        )
      )
    )
    const error = await provider()
      .fetchMessages("INBOX", { last: 1 })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ProviderAuthError)
    const authError = error as ProviderAuthError
    expect(authError.accountId).toBe("acc-1")
    expect(authError.accountType).toBe("imap")
    expect(authError.message).toMatch(/AUTHENTICATIONFAILED/)
  })

  it("maps SMTP authentication failures too", async () => {
    invokeMock.mockImplementation(() =>
      Promise.reject(
        new Error("SMTP authentication failed for user user@example.com: 535")
      )
    )
    await expect(
      provider().sendMessage({
        from: { email: "user@example.com" },
        to: [],
        subject: "Hi",
      })
    ).rejects.toBeInstanceOf(ProviderAuthError)
  })

  it("leaves non-auth errors untouched", async () => {
    const original = new Error("UID FETCH INBOX failed: Connection reset")
    invokeMock.mockImplementation(() => Promise.reject(original))
    const error = await provider()
      .fetchMessages("INBOX", { last: 1 })
      .catch((caught: unknown) => caught)

    expect(error).not.toBeInstanceOf(ProviderAuthError)
    expect(error).toBe(original)
  })
})

describe("isAuthErrorMessage matcher", () => {
  it.each([
    ["IMAP login failed for user bob@x: [AUTHENTICATIONFAILED] nope", true],
    ["SMTP authentication failed for user bob@x: 535", true],
    ["Invalid credentials", true],
    ["Unauthorized", true],
    ["auth failed: bad password", true],
    ["UID FETCH INBOX uids=1:* failed: Connection reset by peer", false],
    ["imap.example.com: connection timed out", false],
    ["", false],
  ])("%s → %s", (message, expected) => {
    expect(isAuthErrorMessage(message)).toBe(expected)
  })
})

describe("credential pass-through", () => {
  it("forwards acceptInvalidCerts and security to both param sets", async () => {
    const p = createImapSmtpProvider(
      imapAccount({
        imapSecurity: "starttls",
        smtpPort: 587,
        smtpSecurity: "starttls",
      }),
      { password: "pw", acceptInvalidCerts: true }
    )
    mockCommands({ imap_list_folders: [] })
    await p.listFolders()

    expect(invokeMock).toHaveBeenCalledWith("imap_list_folders", {
      params: {
        host: "imap.example.com",
        port: 993,
        security: "starttls",
        username: "user@example.com",
        password: "pw",
        acceptInvalidCerts: true,
      },
    })
  })
})
