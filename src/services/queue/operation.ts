import type { SqlExecutor } from "../db/executor"
import type { PendingOperationRow } from "../db/pending-operations"
import {
  enqueuePendingOperation,
  getPendingOperation,
} from "../db/pending-operations"
import type { MessageRef, SendEmailInput } from "../email/types"

/**
 * The offline operation model (design D10): a discriminated union of every
 * server mutation the app can queue while offline, its JSON serialization
 * into the `pending_operations.payload_json` column, and type-safe enqueue
 * helpers. The replay processor (processor.ts) dispatches each variant to
 * the matching EmailProvider method.
 *
 * Idempotency (D10): flag and label operations are idempotent by nature —
 * applying \Seen twice, re-starring, or re-adding a label reaches the same
 * server state, so replaying after a crash or an ambiguous failure is
 * safe. Archive/trash/move/delete-forever move messages between folders;
 * replaying an already-applied move is a no-op or re-applies the same
 * placement. `send` is the one non-idempotent variant: the provider sends
 * with a caller-supplied Message-ID when present (SendEmailInput.messageId)
 * so a replayed send after a crash is detectable/deduplicateable
 * server-side; the composer sets messageId for offline sends.
 *
 * The label/folder ENTITY ops (task 10.4) are idempotent by classification,
 * not by nature: the LabelAdminService treats the server's
 * already-exists (gmail 409 / imap ALREADYEXISTS) and not-found (gmail 404
 * / imap NONEXISTENT) rejections as success at replay, so a crash between
 * the server call and the queue update converges. FIFO order additionally
 * guarantees a label's create replays before its rename/delete.
 */

export type OperationType =
  | "send"
  | "archive"
  | "trash"
  | "mark_read"
  | "mark_unread"
  | "star"
  | "unstar"
  | "add_labels"
  | "remove_labels"
  | "move"
  | "delete_forever"
  | "not_spam"
  | "create_label"
  | "rename_label"
  | "delete_label"
  | "create_folder"
  | "rename_folder"
  | "delete_folder"

/** Shared discriminant field name for the union. */
interface OperationBase {
  accountId: string
}

export interface SendOperation extends OperationBase {
  kind: "send"
  input: SendEmailInput
}

interface RefsOperation extends OperationBase {
  refs: MessageRef[]
}

export interface ArchiveOperation extends RefsOperation {
  kind: "archive"
}
export interface TrashOperation extends RefsOperation {
  kind: "trash"
}
export interface MarkReadOperation extends RefsOperation {
  kind: "mark_read"
}
export interface MarkUnreadOperation extends RefsOperation {
  kind: "mark_unread"
}
export interface StarOperation extends RefsOperation {
  kind: "star"
}
export interface UnstarOperation extends RefsOperation {
  kind: "unstar"
}
export interface DeleteForeverOperation extends RefsOperation {
  kind: "delete_forever"
}
export interface NotSpamOperation extends RefsOperation {
  kind: "not_spam"
}

export interface AddLabelsOperation extends RefsOperation {
  kind: "add_labels"
  labelIds: string[]
}
export interface RemoveLabelsOperation extends RefsOperation {
  kind: "remove_labels"
  labelIds: string[]
}
export interface MoveOperation extends RefsOperation {
  kind: "move"
  destinationFolder: string
}

// ---- Label/folder entity CRUD (task 10.4, dispatched through the
// LabelAdminService, not the EmailProvider surface) ----

/**
 * The label-entity ops carry the full names the server call needs, NOT
 * just the local row id: local-first means the labels row is already
 * mutated/deleted when the op replays, so `labelId` is informational
 * (correlation/debugging) and the queued names are authoritative.
 */
export interface CreateLabelOperation extends OperationBase {
  kind: "create_label"
  labelId: string
  /** Full label name including "/" hierarchy segments. */
  name: string
  /** Local color token (e.g. "var(--chart-3)") — display-only, never sent. */
  color?: string
}
export interface RenameLabelOperation extends OperationBase {
  kind: "rename_label"
  labelId: string
  /** Name the label had when the rename was queued (server lookup key). */
  previousName: string
  /** New full name. */
  name: string
}
export interface DeleteLabelOperation extends OperationBase {
  kind: "delete_label"
  labelId: string
  /** Name at delete time (the local row is already gone at replay). */
  name: string
}

/** Folder-entity ops for imap accounts (CREATE/RENAME/DELETE MAILBOX). */
export interface CreateFolderOperation extends OperationBase {
  kind: "create_folder"
  /** Full folder path to CREATE. */
  folderName: string
}
export interface RenameFolderOperation extends OperationBase {
  kind: "rename_folder"
  fromFolder: string
  toFolder: string
}
export interface DeleteFolderOperation extends OperationBase {
  kind: "delete_folder"
  /** Full folder path to DELETE (removes its messages server-side). */
  folderName: string
}

export type QueueOperation =
  | SendOperation
  | ArchiveOperation
  | TrashOperation
  | MarkReadOperation
  | MarkUnreadOperation
  | StarOperation
  | UnstarOperation
  | AddLabelsOperation
  | RemoveLabelsOperation
  | MoveOperation
  | DeleteForeverOperation
  | NotSpamOperation
  | CreateLabelOperation
  | RenameLabelOperation
  | DeleteLabelOperation
  | CreateFolderOperation
  | RenameFolderOperation
  | DeleteFolderOperation

/** Thrown when payload_json cannot be mapped back to a known operation. */
export class OperationDeserializeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "OperationDeserializeError"
  }
}

/** Payload-only serialization stored in `payload_json` (accountId lives in
 * its own column and is stripped/reattached around the JSON). Exported for
 * enqueueOperation, which hands the raw payload to the query layer (the
 * single JSON encoding happens there). */
export function operationPayload(op: QueueOperation): unknown {
  switch (op.kind) {
    case "send":
      return { input: op.input }
    case "add_labels":
    case "remove_labels":
      return { refs: op.refs, labelIds: op.labelIds }
    case "move":
      return { refs: op.refs, destinationFolder: op.destinationFolder }
    case "create_label":
      return {
        labelId: op.labelId,
        name: op.name,
        ...(op.color !== undefined ? { color: op.color } : {}),
      }
    case "rename_label":
      return {
        labelId: op.labelId,
        previousName: op.previousName,
        name: op.name,
      }
    case "delete_label":
      return { labelId: op.labelId, name: op.name }
    case "create_folder":
      return { folderName: op.folderName }
    case "rename_folder":
      return { fromFolder: op.fromFolder, toFolder: op.toFolder }
    case "delete_folder":
      return { folderName: op.folderName }
    default:
      return { refs: op.refs }
  }
}

/** QueueOperation → the (op_type, payload_json) pair the DB row stores. */
export function serializeOperation(op: QueueOperation): {
  opType: OperationType
  payloadJson: string
} {
  return {
    opType: op.kind,
    payloadJson: JSON.stringify(operationPayload(op)),
  }
}

/** A `pending_operations` row (or its fields) → the typed operation. */
export function deserializeOperation(
  accountId: string,
  opType: string,
  payloadJson: string
): QueueOperation {
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(payloadJson) as Record<string, unknown>
  } catch (error) {
    throw new OperationDeserializeError(
      `queued operation ${opType} has corrupt payload JSON`,
      { cause: error }
    )
  }
  switch (opType) {
    case "send":
      return { accountId, kind: "send", input: payload.input as SendEmailInput }
    case "archive":
    case "trash":
    case "mark_read":
    case "mark_unread":
    case "star":
    case "unstar":
    case "delete_forever":
    case "not_spam":
      return {
        accountId,
        kind: opType,
        refs: payload.refs as MessageRef[],
      }
    case "add_labels":
    case "remove_labels":
      return {
        accountId,
        kind: opType,
        refs: payload.refs as MessageRef[],
        labelIds: payload.labelIds as string[],
      }
    case "move":
      return {
        accountId,
        kind: "move",
        refs: payload.refs as MessageRef[],
        destinationFolder: payload.destinationFolder as string,
      }
    case "create_label":
      return {
        accountId,
        kind: "create_label",
        labelId: payload.labelId as string,
        name: payload.name as string,
        ...(payload.color !== undefined
          ? { color: payload.color as string }
          : {}),
      }
    case "rename_label":
      return {
        accountId,
        kind: "rename_label",
        labelId: payload.labelId as string,
        previousName: payload.previousName as string,
        name: payload.name as string,
      }
    case "delete_label":
      return {
        accountId,
        kind: "delete_label",
        labelId: payload.labelId as string,
        name: payload.name as string,
      }
    case "create_folder":
      return {
        accountId,
        kind: "create_folder",
        folderName: payload.folderName as string,
      }
    case "rename_folder":
      return {
        accountId,
        kind: "rename_folder",
        fromFolder: payload.fromFolder as string,
        toFolder: payload.toFolder as string,
      }
    case "delete_folder":
      return {
        accountId,
        kind: "delete_folder",
        folderName: payload.folderName as string,
      }
    default:
      throw new OperationDeserializeError(
        `unknown queued operation type "${opType}"`
      )
  }
}

/** Row → typed operation (account_id from the row). */
export function operationFromRow(
  row: Pick<PendingOperationRow, "account_id" | "op_type" | "payload_json">
): QueueOperation {
  return deserializeOperation(row.account_id, row.op_type, row.payload_json)
}

/** Enqueue any operation; the row lands as 'pending' in FIFO seq order.
 * The payload is encoded exactly once, by enqueuePendingOperation. */
export async function enqueueOperation(
  executor: SqlExecutor,
  op: QueueOperation
): Promise<string> {
  return enqueuePendingOperation(executor, {
    accountId: op.accountId,
    opType: op.kind,
    payload: operationPayload(op),
  })
}

// ---- Type-safe per-op enqueue helpers (the call sites' public surface) ----

export function enqueueSend(
  executor: SqlExecutor,
  accountId: string,
  input: SendEmailInput
): Promise<string> {
  return enqueueOperation(executor, { accountId, kind: "send", input })
}

export function enqueueArchive(
  executor: SqlExecutor,
  accountId: string,
  refs: MessageRef[]
): Promise<string> {
  return enqueueOperation(executor, { accountId, kind: "archive", refs })
}

export function enqueueTrash(
  executor: SqlExecutor,
  accountId: string,
  refs: MessageRef[]
): Promise<string> {
  return enqueueOperation(executor, { accountId, kind: "trash", refs })
}

export function enqueueMarkRead(
  executor: SqlExecutor,
  accountId: string,
  refs: MessageRef[]
): Promise<string> {
  return enqueueOperation(executor, { accountId, kind: "mark_read", refs })
}

export function enqueueMarkUnread(
  executor: SqlExecutor,
  accountId: string,
  refs: MessageRef[]
): Promise<string> {
  return enqueueOperation(executor, { accountId, kind: "mark_unread", refs })
}

export function enqueueStar(
  executor: SqlExecutor,
  accountId: string,
  refs: MessageRef[]
): Promise<string> {
  return enqueueOperation(executor, { accountId, kind: "star", refs })
}

export function enqueueUnstar(
  executor: SqlExecutor,
  accountId: string,
  refs: MessageRef[]
): Promise<string> {
  return enqueueOperation(executor, { accountId, kind: "unstar", refs })
}

export function enqueueAddLabels(
  executor: SqlExecutor,
  accountId: string,
  refs: MessageRef[],
  labelIds: string[]
): Promise<string> {
  return enqueueOperation(executor, {
    accountId,
    kind: "add_labels",
    refs,
    labelIds,
  })
}

export function enqueueRemoveLabels(
  executor: SqlExecutor,
  accountId: string,
  refs: MessageRef[],
  labelIds: string[]
): Promise<string> {
  return enqueueOperation(executor, {
    accountId,
    kind: "remove_labels",
    refs,
    labelIds,
  })
}

export function enqueueMove(
  executor: SqlExecutor,
  accountId: string,
  refs: MessageRef[],
  destinationFolder: string
): Promise<string> {
  return enqueueOperation(executor, {
    accountId,
    kind: "move",
    refs,
    destinationFolder,
  })
}

export function enqueueDeleteForever(
  executor: SqlExecutor,
  accountId: string,
  refs: MessageRef[]
): Promise<string> {
  return enqueueOperation(executor, { accountId, kind: "delete_forever", refs })
}

export function enqueueNotSpam(
  executor: SqlExecutor,
  accountId: string,
  refs: MessageRef[]
): Promise<string> {
  return enqueueOperation(executor, { accountId, kind: "not_spam", refs })
}

// ---- Label/folder entity CRUD (task 10.4) ----

export function enqueueCreateLabel(
  executor: SqlExecutor,
  op: Omit<CreateLabelOperation, "kind">
): Promise<string> {
  return enqueueOperation(executor, { ...op, kind: "create_label" })
}

export function enqueueRenameLabel(
  executor: SqlExecutor,
  op: Omit<RenameLabelOperation, "kind">
): Promise<string> {
  return enqueueOperation(executor, { ...op, kind: "rename_label" })
}

export function enqueueDeleteLabel(
  executor: SqlExecutor,
  op: Omit<DeleteLabelOperation, "kind">
): Promise<string> {
  return enqueueOperation(executor, { ...op, kind: "delete_label" })
}

export function enqueueCreateFolder(
  executor: SqlExecutor,
  op: Omit<CreateFolderOperation, "kind">
): Promise<string> {
  return enqueueOperation(executor, { ...op, kind: "create_folder" })
}

export function enqueueRenameFolder(
  executor: SqlExecutor,
  op: Omit<RenameFolderOperation, "kind">
): Promise<string> {
  return enqueueOperation(executor, { ...op, kind: "rename_folder" })
}

export function enqueueDeleteFolder(
  executor: SqlExecutor,
  op: Omit<DeleteFolderOperation, "kind">
): Promise<string> {
  return enqueueOperation(executor, { ...op, kind: "delete_folder" })
}

/** Fetch a queued operation by id and deserialize it. */
export async function getQueuedOperation(
  executor: SqlExecutor,
  id: string
): Promise<QueueOperation | null> {
  const row = await getPendingOperation(executor, id)
  return row ? operationFromRow(row) : null
}
