import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { getLabel } from "../../db/labels"
import { getFolderSyncState } from "../../sync/folder-sync-state"
import { GmailApiError } from "../../email/gmail-api"
import type { GmailClient } from "../../email/gmail-api"
import { ProviderAuthError } from "../../email/types"
import {
  createUserLabel,
  deleteUserLabel,
  executeLabelAdminOperation,
  createLabelAdminService,
  buildLabelAdminService,
  LabelAdminError,
  normalizeLabelName,
  recolorUserLabel,
  renameUserLabel,
  type LabelAdminService,
} from "../label-admin"

/**
 * Task 10.4 label CRUD: local-first flows against the real v1 schema
 * (node:sqlite) plus the queued server ops; the server-side service is
 * exercised through an injected gmail client / mocked invoke.
 */

let executor: TestExecutor
let gmailAccountId: string
let imapAccountId: string

beforeEach(async () => {
  executor = createTestExecutor()
  gmailAccountId = await createAccount(executor, "gmail")
  imapAccountId = await createAccount(executor, "imap")
})

afterEach(() => {
  executor.close()
})

async function queuedOps(): Promise<
  { op_type: string; payload_json: string }[]
> {
  return executor.select<{ op_type: string; payload_json: string }>(
    "SELECT op_type, payload_json FROM pending_operations ORDER BY seq ASC"
  )
}

async function seedSystemLabel(accountId: string): Promise<string> {
  await executor.execute(
    `INSERT INTO labels (id, account_id, name, gmail_label_id, special_use, type)
     VALUES ($1, $2, 'INBOX', 'INBOX', 'inbox', 'system')`,
    [`label-inbox-${accountId}`, accountId]
  )
  return `label-inbox-${accountId}`
}

// ---------------------------------------------------------------------------
// Local-first flows
// ---------------------------------------------------------------------------

describe("createUserLabel", () => {
  it("inserts the local row and queues a create_label op for gmail", async () => {
    const row = await createUserLabel({
      executor,
      account: { id: gmailAccountId, type: "gmail" },
      name: "Work",
      color: "var(--chart-3)",
    })

    expect(row.name).toBe("Work")
    expect(row.type).toBe("user")
    expect(row.gmail_label_id).toBe("Work")
    expect(row.color).toBe("var(--chart-3)")
    const ops = await queuedOps()
    expect(ops).toHaveLength(1)
    expect(ops[0].op_type).toBe("create_label")
    expect(JSON.parse(ops[0].payload_json)).toMatchObject({
      labelId: row.id,
      name: "Work",
      color: "var(--chart-3)",
    })
  })

  it("queues a create_folder op for imap and stores the folder path", async () => {
    const row = await createUserLabel({
      executor,
      account: { id: imapAccountId, type: "imap" },
      name: "Receipts",
    })

    expect(row.imap_folder_name).toBe("Receipts")
    const ops = await queuedOps()
    expect(ops).toHaveLength(1)
    expect(ops[0].op_type).toBe("create_folder")
    expect(JSON.parse(ops[0].payload_json)).toEqual({
      folderName: "Receipts",
    })
  })

  it("nests under a parent label as Parent/Child", async () => {
    const parent = await createUserLabel({
      executor,
      account: { id: gmailAccountId, type: "gmail" },
      name: "Work",
    })
    const child = await createUserLabel({
      executor,
      account: { id: gmailAccountId, type: "gmail" },
      name: "Invoices",
      parentId: parent.id,
    })

    expect(child.name).toBe("Work/Invoices")
  })

  it("uses a slash-typed name as the full name verbatim", async () => {
    const row = await createUserLabel({
      executor,
      account: { id: gmailAccountId, type: "gmail" },
      name: " Work/ Invoices ",
    })
    expect(row.name).toBe("Work/ Invoices")
  })

  it("rejects duplicate names with a typed conflict error", async () => {
    await createUserLabel({
      executor,
      account: { id: gmailAccountId, type: "gmail" },
      name: "Work",
    })
    await expect(
      createUserLabel({
        executor,
        account: { id: gmailAccountId, type: "gmail" },
        name: "Work",
      })
    ).rejects.toMatchObject({
      code: "conflict",
      name: "LabelAdminError",
    })
  })

  it("rejects malformed names", async () => {
    await expect(
      createUserLabel({
        executor,
        account: { id: gmailAccountId, type: "gmail" },
        name: "Work//Invoices",
      })
    ).rejects.toBeInstanceOf(LabelAdminError)
    expect(normalizeLabelName("  Projects ")).toBe("Projects")
  })
})

describe("renameUserLabel", () => {
  it("renames the gmail row (name + gmail_label_id) and queues rename_label", async () => {
    const row = await createUserLabel({
      executor,
      account: { id: gmailAccountId, type: "gmail" },
      name: "Work",
    })

    const renamed = await renameUserLabel({
      executor,
      account: { id: gmailAccountId, type: "gmail" },
      labelId: row.id,
      name: "Personal",
    })

    expect(renamed.name).toBe("Personal")
    expect(renamed.gmail_label_id).toBe("Personal")
    const ops = await queuedOps()
    expect(ops).toHaveLength(2) // create + rename
    expect(ops[1].op_type).toBe("rename_label")
    expect(JSON.parse(ops[1].payload_json)).toMatchObject({
      labelId: row.id,
      previousName: "Work",
      name: "Personal",
    })
  })

  it("propagates an imap folder rename across messages, labels and sync state", async () => {
    const row = await createUserLabel({
      executor,
      account: { id: imapAccountId, type: "imap" },
      name: "Archive/2024",
    })
    // Local folder state for the folder: a message, a thread pointed at
    // the label and a sync cursor with real counters.
    await executor.execute(
      `INSERT INTO threads (id, account_id, folder_label_id) VALUES ($1, $2, $3)`,
      ["th-1", imapAccountId, row.id]
    )
    await executor.execute(
      `INSERT INTO messages (id, thread_id, account_id, imap_folder, imap_uid, date)
       VALUES ('msg-1', 'th-1', $1, 'Archive/2024', 7, 0)`,
      [imapAccountId]
    )
    await executor.execute(
      `INSERT INTO folder_sync_state (id, account_id, folder_name, uidvalidity, last_seen_uid, highest_modseq)
       VALUES ('fss-1', $1, 'Archive/2024', 42, 7, 99)`,
      [imapAccountId]
    )

    const renamed = await renameUserLabel({
      executor,
      account: { id: imapAccountId, type: "imap" },
      labelId: row.id,
      name: "Archive/2025",
    })

    expect(renamed.name).toBe("Archive/2025")
    expect(renamed.imap_folder_name).toBe("Archive/2025")
    // Messages moved with the mailbox (RENAME preserves UIDs).
    const folders = await executor.select<{ imap_folder: string }>(
      "SELECT imap_folder FROM messages WHERE id = 'msg-1'"
    )
    expect(folders[0].imap_folder).toBe("Archive/2025")
    // The cursor row keeps its counters under the new name.
    const state = await getFolderSyncState(
      executor,
      imapAccountId,
      "Archive/2025"
    )
    expect(state).not.toBeNull()
    expect(state?.uidvalidity).toBe(42)
    expect(state?.last_seen_uid).toBe(7)
    expect(state?.highest_modseq).toBe(99)
    expect(
      await getFolderSyncState(executor, imapAccountId, "Archive/2024")
    ).toBeNull()
    // threads.folder_label_id still points at the same labels row.
    const thread = await executor.select<{ folder_label_id: string | null }>(
      "SELECT folder_label_id FROM threads WHERE id = 'th-1'"
    )
    expect(thread[0].folder_label_id).toBe(row.id)

    const ops = await queuedOps()
    expect(ops[1].op_type).toBe("rename_folder")
    expect(JSON.parse(ops[1].payload_json)).toEqual({
      fromFolder: "Archive/2024",
      toFolder: "Archive/2025",
    })
  })

  it("refuses to rename a system label", async () => {
    const systemId = await seedSystemLabel(gmailAccountId)
    await expect(
      renameUserLabel({
        executor,
        account: { id: gmailAccountId, type: "gmail" },
        labelId: systemId,
        name: "Not Inbox",
      })
    ).rejects.toMatchObject({ code: "system-protected" })
    expect(await queuedOps()).toHaveLength(0)
    const row = await getLabel(executor, systemId)
    expect(row?.name).toBe("INBOX")
  })
})

describe("recolorUserLabel", () => {
  it("changes the color locally without queueing any server op", async () => {
    const row = await createUserLabel({
      executor,
      account: { id: gmailAccountId, type: "gmail" },
      name: "Work",
    })

    const recolored = await recolorUserLabel({
      executor,
      account: { id: gmailAccountId, type: "gmail" },
      labelId: row.id,
      color: "var(--chart-1)",
    })
    expect(recolored.color).toBe("var(--chart-1)")

    const cleared = await recolorUserLabel({
      executor,
      account: { id: gmailAccountId, type: "gmail" },
      labelId: row.id,
      color: null,
    })
    expect(cleared.color).toBeNull()
    // Only the create op from seeding — recolor queues nothing (display
    // color is local; server colors are imported, not pushed).
    expect(await queuedOps()).toHaveLength(1)
  })
})

describe("deleteUserLabel", () => {
  it("cascades thread_labels, nulls folder_label_id and queues delete_label", async () => {
    const row = await createUserLabel({
      executor,
      account: { id: gmailAccountId, type: "gmail" },
      name: "Work",
    })
    await executor.execute(
      "INSERT INTO threads (id, account_id, folder_label_id) VALUES ($1, $2, $3)",
      ["th-1", gmailAccountId, row.id]
    )
    await executor.execute(
      `INSERT INTO thread_labels (thread_id, label_id, account_id)
       VALUES ('th-1', $1, $2)`,
      [row.id, gmailAccountId]
    )

    await deleteUserLabel({
      executor,
      account: { id: gmailAccountId, type: "gmail" },
      labelId: row.id,
    })

    expect(await getLabel(executor, row.id)).toBeNull()
    const memberships = await executor.select<{ label_id: string }>(
      "SELECT label_id FROM thread_labels"
    )
    expect(memberships).toHaveLength(0)
    const thread = await executor.select<{ folder_label_id: string | null }>(
      "SELECT folder_label_id FROM threads WHERE id = 'th-1'"
    )
    expect(thread[0].folder_label_id).toBeNull()
    const ops = await queuedOps()
    expect(ops).toHaveLength(2)
    expect(ops[1].op_type).toBe("delete_label")
    expect(JSON.parse(ops[1].payload_json)).toMatchObject({
      labelId: row.id,
      name: "Work",
    })
  })

  it("drops the imap folder's messages and sync cursor, then queues delete_folder", async () => {
    const row = await createUserLabel({
      executor,
      account: { id: imapAccountId, type: "imap" },
      name: "Archive/2024",
    })
    await executor.execute(
      "INSERT INTO threads (id, account_id, folder_label_id) VALUES ('th-1', $1, $2)",
      [imapAccountId, row.id]
    )
    await executor.execute(
      `INSERT INTO messages (id, thread_id, account_id, imap_folder, imap_uid, date)
       VALUES ('msg-1', 'th-1', $1, 'Archive/2024', 7, 0)`,
      [imapAccountId]
    )
    await executor.execute(
      `INSERT INTO folder_sync_state (id, account_id, folder_name, uidvalidity, last_seen_uid)
       VALUES ('fss-1', $1, 'Archive/2024', 42, 7)`,
      [imapAccountId]
    )

    await deleteUserLabel({
      executor,
      account: { id: imapAccountId, type: "imap" },
      labelId: row.id,
    })

    expect(await getLabel(executor, row.id)).toBeNull()
    // The mailbox is gone server-side — mirror that locally.
    expect(
      await executor.select("SELECT id FROM messages WHERE id = 'msg-1'")
    ).toHaveLength(0)
    // Threads emptied by the message drop are cleaned up too.
    expect(
      await executor.select("SELECT id FROM threads WHERE id = 'th-1'")
    ).toHaveLength(0)
    expect(
      await getFolderSyncState(executor, imapAccountId, "Archive/2024")
    ).toBeNull()
    const ops = await queuedOps()
    expect(ops[1].op_type).toBe("delete_folder")
    expect(JSON.parse(ops[1].payload_json)).toEqual({
      folderName: "Archive/2024",
    })
  })

  it("refuses to delete a system label", async () => {
    const systemId = await seedSystemLabel(imapAccountId)
    await expect(
      deleteUserLabel({
        executor,
        account: { id: imapAccountId, type: "imap" },
        labelId: systemId,
      })
    ).rejects.toMatchObject({ code: "system-protected" })
    expect(await getLabel(executor, systemId)).not.toBeNull()
    expect(await queuedOps()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// LabelAdminService (server-side replay surface)
// ---------------------------------------------------------------------------

/** Full EmailAccount fixture (createLabelAdminService takes the DTO). */
function emailAccount(
  id: string,
  type: "gmail" | "imap",
  imap?: { host: string; port: number }
) {
  return {
    id,
    type,
    email: `${id}@example.com`,
    ...(imap
      ? {
          imapHost: imap.host,
          imapPort: imap.port,
          imapSecurity: "tls" as const,
        }
      : {}),
    status: "active" as const,
    isActive: true,
    isPinned: false,
  }
}

function fakeGmailClient(): GmailClient {
  return {
    listLabels: vi.fn(async () => [
      { id: "Label_1", name: "Work" },
      { id: "Label_2", name: "Personal" },
    ]),
    listHistory: vi.fn(async () => ({}) as never),
    listMessages: vi.fn(async () => ({}) as never),
    getMessage: vi.fn(async () => ({}) as never),
    getThread: vi.fn(async () => ({}) as never),
    sendMessageRaw: vi.fn(async () => ({}) as never),
    insertMessageRaw: vi.fn(async () => ({}) as never),
    modifyMessageLabels: vi.fn(async () => ({}) as never),
    trashMessage: vi.fn(async () => ({}) as never),
    untrashMessage: vi.fn(async () => ({}) as never),
    deleteMessage: vi.fn(async () => {}),
    getProfile: vi.fn(async () => ({ emailAddress: "x@y.z" })),
    getAttachment: vi.fn(async () => ({}) as never),
    createLabel: vi.fn(async (input: { name: string }) => ({
      id: "Label_new",
      name: input.name,
    })),
    updateLabel: vi.fn(async (id: string) => ({ id, name: "" })),
    deleteLabel: vi.fn(async () => {}),
  }
}

describe("createLabelAdminService (gmail)", () => {
  it("creates, renames (resolving the server id by name) and deletes labels", async () => {
    const client = fakeGmailClient()
    const admin = await createLabelAdminService(
      emailAccount(gmailAccountId, "gmail"),
      { password: "" },
      { gmailClient: client }
    )

    await admin.createServerLabel({ name: "Projects" })
    expect(client.createLabel).toHaveBeenCalledWith({ name: "Projects" })

    await admin.renameServerLabel({ previousName: "Work", name: "Personal 2" })
    expect(client.updateLabel).toHaveBeenCalledWith("Label_1", {
      name: "Personal 2",
    })

    await admin.deleteServerLabel({ name: "Personal" })
    expect(client.deleteLabel).toHaveBeenCalledWith("Label_2")
  })

  it("refuses folder ops and throws when a label is unknown to the server", async () => {
    const client = fakeGmailClient()
    const admin = await createLabelAdminService(
      emailAccount(gmailAccountId, "gmail"),
      { password: "" },
      { gmailClient: client }
    )
    await expect(admin.createServerFolder("X")).rejects.toThrow(
      /create_folder op queued for a gmail account/
    )
    await expect(admin.deleteServerLabel({ name: "Ghost" })).rejects.toThrow(
      /not found on the server/
    )
  })
})

describe("createLabelAdminService (imap)", () => {
  const imapConfig = { host: "imap.example.com", port: 993 }

  it("invokes the imap folder commands with the account's ImapParams", async () => {
    const invokeMock = vi.fn(
      async (command: string, args: Record<string, unknown>) => {
        void command
        void args
        return undefined
      }
    )
    const admin = await createLabelAdminService(
      emailAccount(imapAccountId, "imap", imapConfig),
      { password: "app-secret" },
      { invokeImpl: invokeMock }
    )
    await admin.createServerFolder("Receipts")
    await admin.renameServerFolder("Receipts", "Receipts/2026")
    await admin.deleteServerFolder("Receipts/2026")

    expect(invokeMock).toHaveBeenCalledTimes(3)
    const [createCommand, renameCommand, deleteCommand] = invokeMock.mock.calls
    expect(createCommand[0]).toBe("imap_create_folder")
    expect(createCommand[1]).toMatchObject({
      name: "Receipts",
      params: {
        host: "imap.example.com",
        port: 993,
        security: "tls",
        username: `${imapAccountId}@example.com`,
      },
    })
    expect(renameCommand[0]).toBe("imap_rename_folder")
    expect(renameCommand[1]).toMatchObject({
      from: "Receipts",
      to: "Receipts/2026",
    })
    expect(deleteCommand[0]).toBe("imap_delete_folder")
    expect(deleteCommand[1]).toMatchObject({ name: "Receipts/2026" })
    // The password travels only inside the connection params.
    expect(createCommand[1].params).toMatchObject({ password: "app-secret" })
  })

  it("throws a typed auth error when the account has no server config", async () => {
    await expect(
      createLabelAdminService(emailAccount(imapAccountId, "imap"), {
        password: "app-secret",
      })
    ).rejects.toBeInstanceOf(ProviderAuthError)
  })

  it("refuses label ops", async () => {
    const admin = await createLabelAdminService(
      emailAccount(imapAccountId, "imap", imapConfig),
      { password: "app-secret" }
    )
    await expect(admin.createServerLabel({ name: "X" })).rejects.toThrow(
      /create_label op queued for an imap account/
    )
  })
})

describe("buildLabelAdminService", () => {
  it("throws ProviderAuthError for accounts in auth-error state", async () => {
    await executor.execute(
      "UPDATE accounts SET status = 'auth-error' WHERE id = $1",
      [gmailAccountId]
    )
    await expect(
      buildLabelAdminService(executor, gmailAccountId)
    ).rejects.toBeInstanceOf(ProviderAuthError)
  })

  it("throws ProviderAuthError when there are no stored credentials", async () => {
    await expect(
      buildLabelAdminService(executor, gmailAccountId)
    ).rejects.toBeInstanceOf(ProviderAuthError)
  })
})

// ---------------------------------------------------------------------------
// Queued-op replay classification
// ---------------------------------------------------------------------------

describe("executeLabelAdminOperation", () => {
  function fakeAdmin(): LabelAdminService {
    return {
      accountId: "acc",
      accountType: "gmail",
      createServerLabel: vi.fn(async () => {}),
      renameServerLabel: vi.fn(async () => {}),
      deleteServerLabel: vi.fn(async () => {}),
      createServerFolder: vi.fn(async () => {}),
      renameServerFolder: vi.fn(async () => {}),
      deleteServerFolder: vi.fn(async () => {}),
    }
  }

  it("treats gmail 409 already-exists as applied", async () => {
    const admin = fakeAdmin()
    admin.createServerLabel = vi.fn(async () => {
      throw new GmailApiError(409, "duplicate", "duplicate")
    })
    await expect(
      executeLabelAdminOperation(admin, {
        accountId: "acc",
        kind: "create_label",
        labelId: "l1",
        name: "Work",
      })
    ).resolves.toBeUndefined()
  })

  it("treats imap ALREADYEXISTS as applied", async () => {
    const admin = fakeAdmin()
    admin.createServerFolder = vi.fn(async () => {
      throw new Error(
        "CREATE failed: NO [ALREADYEXISTS] Mailbox already exists"
      )
    })
    await expect(
      executeLabelAdminOperation(admin, {
        accountId: "acc",
        kind: "create_folder",
        folderName: "Work",
      })
    ).resolves.toBeUndefined()
  })

  it("treats not-found deletes as applied (gmail 404 / imap NONEXISTENT)", async () => {
    const admin = fakeAdmin()
    admin.deleteServerLabel = vi.fn(async () => {
      throw new GmailApiError(404, "gone", "notFound")
    })
    admin.deleteServerFolder = vi.fn(async () => {
      throw new Error("DELETE failed: NO NONEXISTENT Mailbox does not exist")
    })
    await expect(
      executeLabelAdminOperation(admin, {
        accountId: "acc",
        kind: "delete_label",
        labelId: "l1",
        name: "Work",
      })
    ).resolves.toBeUndefined()
    await expect(
      executeLabelAdminOperation(admin, {
        accountId: "acc",
        kind: "delete_folder",
        folderName: "Work",
      })
    ).resolves.toBeUndefined()
  })

  it("propagates genuine failures for the retry path", async () => {
    const admin = fakeAdmin()
    admin.createServerLabel = vi.fn(async () => {
      throw new GmailApiError(500, "backend error", "backendError")
    })
    await expect(
      executeLabelAdminOperation(admin, {
        accountId: "acc",
        kind: "create_label",
        labelId: "l1",
        name: "Work",
      })
    ).rejects.toBeInstanceOf(GmailApiError)
  })
})
