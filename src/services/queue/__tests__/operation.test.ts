import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  listPendingOperations,
  markOperationProcessing,
  type PendingOperationRow,
} from "../../db/pending-operations"
import type { MessageRef } from "../../email/types"
import { createAccount } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import {
  enqueueAddLabels,
  enqueueArchive,
  enqueueCreateFolder,
  enqueueCreateLabel,
  enqueueDeleteForever,
  enqueueDeleteLabel,
  enqueueDraftDelete,
  enqueueDraftUpsert,
  enqueueMarkRead,
  enqueueMarkUnread,
  enqueueMove,
  enqueueNotSpam,
  enqueueRemoveLabels,
  enqueueRenameLabel,
  enqueueSend,
  enqueueStar,
  enqueueTrash,
  enqueueUnstar,
  getQueuedOperation,
  deserializeOperation,
  operationFromRow,
  OperationDeserializeError,
  serializeOperation,
} from "../operation"
import type { QueueOperation } from "../operation"

describe("queue operation model", () => {
  const refs: MessageRef[] = [
    { folder: "INBOX", uid: 11 },
    { folder: "Archive/2026", uid: 3 },
  ]

  const sampleOperations: QueueOperation[] = [
    {
      accountId: "acc-1",
      kind: "send",
      input: {
        from: { email: "me@example.com" },
        to: [{ email: "you@example.com" }],
        subject: "Hello",
        textBody: "Hi",
        messageId: "<queued-1@example.com>",
      },
    },
    { accountId: "acc-1", kind: "archive", refs },
    { accountId: "acc-1", kind: "trash", refs },
    { accountId: "acc-1", kind: "mark_read", refs },
    { accountId: "acc-1", kind: "mark_unread", refs },
    { accountId: "acc-1", kind: "star", refs },
    { accountId: "acc-1", kind: "unstar", refs },
    { accountId: "acc-1", kind: "add_labels", refs, labelIds: ["L1", "L2"] },
    { accountId: "acc-1", kind: "remove_labels", refs, labelIds: ["L3"] },
    { accountId: "acc-1", kind: "move", refs, destinationFolder: "Work" },
    { accountId: "acc-1", kind: "delete_forever", refs },
    { accountId: "acc-1", kind: "not_spam", refs },
    // Label/folder entity ops (task 10.4)
    {
      accountId: "acc-1",
      kind: "create_label",
      labelId: `${"acc-1"}:folder-Work`,
      name: "Work",
      color: "var(--chart-3)",
    },
    {
      accountId: "acc-1",
      kind: "rename_label",
      labelId: "acc-1:folder-Work",
      previousName: "Work",
      name: "Personal",
    },
    {
      accountId: "acc-1",
      kind: "delete_label",
      labelId: "acc-1:folder-Work",
      name: "Work",
    },
    {
      accountId: "acc-1",
      kind: "create_folder",
      folderName: "Receipts",
    },
    {
      accountId: "acc-1",
      kind: "rename_folder",
      fromFolder: "Receipts",
      toFolder: "Receipts/2026",
    },
    {
      accountId: "acc-1",
      kind: "delete_folder",
      folderName: "Receipts/2026",
    },
    // Draft mirroring (task 17.x, design D9)
    {
      accountId: "acc-1",
      kind: "draft_upsert",
      draftId: "draft-row-1",
      mime: "From: me@example.com\r\nSubject: Hi\r\n\r\nbody",
    },
    {
      accountId: "acc-1",
      kind: "draft_delete",
      ref: { provider: "gmail", draftId: "draft-9" },
    },
    {
      accountId: "acc-1",
      kind: "draft_delete",
      ref: { provider: "imap", folder: "Drafts", uid: 44 },
    },
    // One-click unsubscribe (task 18.3, design D13)
    {
      accountId: "acc-1",
      kind: "unsubscribe_post",
      url: "https://lists.example.com/u/123?token=abc",
    },
  ]

  it("round-trips every operation through serialize/deserialize", () => {
    for (const op of sampleOperations) {
      const { opType, payloadJson } = serializeOperation(op)
      expect(opType).toBe(op.kind)
      expect(deserializeOperation(op.accountId, opType, payloadJson)).toEqual(
        op
      )
    }
  })

  it("round-trips a queued send's base64 attachments through payload_json (task 8.5)", () => {
    const op: QueueOperation = {
      accountId: "acc-1",
      kind: "send",
      input: {
        from: { email: "me@example.com" },
        to: [{ email: "you@example.com" }],
        subject: "Files attached",
        htmlBody: "<p>Hi</p>",
        messageId: "<queued-3@example.com>",
        attachments: [
          {
            filename: "a.txt",
            mimeType: "text/plain",
            contentBase64: "aGk=",
          },
          { filename: "b.bin", contentBase64: "AAEC" },
        ],
      },
    }
    const { payloadJson } = serializeOperation(op)
    // The field is ordinary JSON — contentBase64 rides payload_json as-is.
    expect(JSON.parse(payloadJson)).toEqual({
      input: op.input,
    })
    expect(deserializeOperation("acc-1", "send", payloadJson)).toEqual(op)
  })

  it("serializes the typed payload only — accountId rides in its column", () => {
    const { payloadJson } = serializeOperation({
      accountId: "acc-1",
      kind: "move",
      refs,
      destinationFolder: "Work",
    })
    expect(JSON.parse(payloadJson)).toEqual({
      refs,
      destinationFolder: "Work",
    })
  })

  it("rejects corrupt payloads and unknown op types", () => {
    expect(() => deserializeOperation("acc-1", "archive", "{not json")).toThrow(
      OperationDeserializeError
    )
    expect(() => deserializeOperation("acc-1", "teleport", "{}")).toThrow(
      OperationDeserializeError
    )
  })

  it("maps a pending_operations row to the typed operation", () => {
    const op = operationFromRow({
      account_id: "acc-2",
      op_type: "add_labels",
      payload_json: JSON.stringify({ refs, labelIds: ["L1"] }),
    })
    expect(op).toEqual({
      accountId: "acc-2",
      kind: "add_labels",
      refs,
      labelIds: ["L1"],
    })
  })
})

describe("typed enqueue helpers", () => {
  let executor: TestExecutor
  let accountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
  })

  afterEach(() => {
    executor.close()
  })

  it("writes one pending row per helper, preserving FIFO order", async () => {
    const ref: MessageRef[] = [{ folder: "INBOX", uid: 42 }]
    await enqueueSend(executor, accountId, {
      from: { email: "me@example.com" },
      to: [{ email: "you@example.com" }],
      subject: "Queued send",
      messageId: "<queued-2@example.com>",
    })
    await enqueueArchive(executor, accountId, ref)
    await enqueueTrash(executor, accountId, ref)
    await enqueueMarkRead(executor, accountId, ref)
    await enqueueMarkUnread(executor, accountId, ref)
    await enqueueStar(executor, accountId, ref)
    await enqueueUnstar(executor, accountId, ref)
    await enqueueAddLabels(executor, accountId, ref, ["Label_1"])
    await enqueueRemoveLabels(executor, accountId, ref, ["Label_1"])
    await enqueueMove(executor, accountId, ref, "Work")
    await enqueueDeleteForever(executor, accountId, ref)
    await enqueueNotSpam(executor, accountId, ref)

    const rows = await listPendingOperations(executor, accountId)
    expect(rows.map((row) => row.op_type)).toEqual([
      "send",
      "archive",
      "trash",
      "mark_read",
      "mark_unread",
      "star",
      "unstar",
      "add_labels",
      "remove_labels",
      "move",
      "delete_forever",
      "not_spam",
    ])

    const send = await getQueuedOperation(executor, rows[0].id)
    expect(send).toMatchObject({ kind: "send", accountId })
    const move = await getQueuedOperation(executor, rows[9].id)
    expect(move).toEqual({
      accountId,
      kind: "move",
      refs: ref,
      destinationFolder: "Work",
    })
  })

  it("queues label-entity ops with their names (no refs) for the admin replay", async () => {
    await enqueueCreateLabel(executor, {
      accountId,
      labelId: `${accountId}:folder-Work`,
      name: "Work",
    })
    await enqueueRenameLabel(executor, {
      accountId,
      labelId: `${accountId}:folder-Work`,
      previousName: "Work",
      name: "Personal",
    })
    await enqueueDeleteLabel(executor, {
      accountId,
      labelId: `${accountId}:folder-Work`,
      name: "Work",
    })
    await enqueueCreateFolder(executor, {
      accountId,
      folderName: "Receipts",
    })

    const rows = await listPendingOperations(executor, accountId)
    expect(rows.map((row) => row.op_type)).toEqual([
      "create_label",
      "rename_label",
      "delete_label",
      "create_folder",
    ])

    // The payload is name-based: the local row is already gone/mutated at
    // replay time, so names are authoritative.
    expect(JSON.parse(rows[0].payload_json)).toEqual({
      labelId: `${accountId}:folder-Work`,
      name: "Work",
    })
    const rename = await getQueuedOperation(executor, rows[1].id)
    expect(rename).toEqual({
      accountId,
      kind: "rename_label",
      labelId: `${accountId}:folder-Work`,
      previousName: "Work",
      name: "Personal",
    })
    const createFolder = await getQueuedOperation(executor, rows[3].id)
    expect(createFolder).toEqual({
      accountId,
      kind: "create_folder",
      folderName: "Receipts",
    })
  })

  it("queues draft-mirror ops with their payload (task 17.x)", async () => {
    await enqueueDraftUpsert(executor, {
      accountId,
      draftId: "draft-row-1",
      mime: "From: me@example.com\r\n\r\nbody",
    })
    await enqueueDraftDelete(executor, {
      accountId,
      ref: { provider: "imap", folder: "Drafts", uid: 44 },
    })

    const rows = await listPendingOperations(executor, accountId)
    expect(rows.map((row) => row.op_type)).toEqual([
      "draft_upsert",
      "draft_delete",
    ])
    // The MIME rides payload_json verbatim (frozen at enqueue time).
    expect(JSON.parse(rows[0].payload_json)).toEqual({
      draftId: "draft-row-1",
      mime: "From: me@example.com\r\n\r\nbody",
    })
    expect(await getQueuedOperation(executor, rows[0].id)).toEqual({
      accountId,
      kind: "draft_upsert",
      draftId: "draft-row-1",
      mime: "From: me@example.com\r\n\r\nbody",
    })
    expect(await getQueuedOperation(executor, rows[1].id)).toEqual({
      accountId,
      kind: "draft_delete",
      ref: { provider: "imap", folder: "Drafts", uid: 44 },
    })
  })

  it("coalesces superseded pending draft_upserts to the last one per draft", async () => {
    // A long offline session: three debounced autosaves of one draft…
    await enqueueDraftUpsert(executor, {
      accountId,
      draftId: "draft-1",
      mime: "v1",
    })
    await enqueueDraftUpsert(executor, {
      accountId,
      draftId: "draft-1",
      mime: "v2",
    })
    const lastId = await enqueueDraftUpsert(executor, {
      accountId,
      draftId: "draft-1",
      mime: "v3",
    })
    // …plus traffic that must survive: another draft of the same account,
    // and the SAME draftId under ANOTHER account.
    await enqueueDraftUpsert(executor, {
      accountId,
      draftId: "draft-2",
      mime: "other draft",
    })
    const otherAccountId = await createAccount(executor, "gmail")
    await enqueueDraftUpsert(executor, {
      accountId: otherAccountId,
      draftId: "draft-1",
      mime: "other account",
    })

    const upserts = (await listPendingOperations(executor)).filter(
      (row) => row.op_type === "draft_upsert"
    )
    // One pending op per (account, draft): the last payload, in FIFO seq
    // order; the other draft's and the other account's ops are untouched.
    expect(
      upserts.map((row) => ({
        id: row.id,
        accountId: row.account_id,
        payload: JSON.parse(row.payload_json),
      }))
    ).toEqual([
      {
        id: lastId,
        accountId,
        payload: { draftId: "draft-1", mime: "v3" },
      },
      {
        id: expect.any(String),
        accountId,
        payload: { draftId: "draft-2", mime: "other draft" },
      },
      {
        id: expect.any(String),
        accountId: otherAccountId,
        payload: { draftId: "draft-1", mime: "other account" },
      },
    ])
  })

  it("coalescing never touches processing or done draft_upsert rows", async () => {
    const firstId = await enqueueDraftUpsert(executor, {
      accountId,
      draftId: "draft-1",
      mime: "v1",
    })
    // The first mirror op was picked up (or applied) — it is no longer
    // pending, so the next autosave's coalescing must leave it alone.
    await markOperationProcessing(executor, firstId)
    await enqueueDraftUpsert(executor, {
      accountId,
      draftId: "draft-1",
      mime: "v2",
    })

    const rows = await executor.select<
      Pick<PendingOperationRow, "op_type" | "status" | "payload_json">
    >(
      "SELECT op_type, status, payload_json FROM pending_operations WHERE account_id = $1 ORDER BY seq",
      [accountId]
    )
    expect(
      rows.map((row) => [row.op_type, row.status, JSON.parse(row.payload_json)])
    ).toEqual([
      ["draft_upsert", "processing", { draftId: "draft-1", mime: "v1" }],
      ["draft_upsert", "pending", { draftId: "draft-1", mime: "v2" }],
    ])
  })
})
