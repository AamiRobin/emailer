import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { listPendingOperations } from "../../db/pending-operations"
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
})
