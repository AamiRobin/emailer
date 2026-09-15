import { invoke } from "@tauri-apps/api/core"

import { decryptCredentials } from "../crypto/credentials"
import { toEmailAccount, type AccountRow } from "../db/accounts"
import type { SqlExecutor } from "../db/executor"
import type { LabelRow } from "../db/labels"
import { deleteLabel, getLabel, insertLabel, updateLabel } from "../db/labels"
import { GmailApiError, createGmailClient } from "../email/gmail-api"
import type { GmailClient } from "../email/gmail-api"
import type { ImapParams } from "../email/invoke"
import type {
  AccountType,
  EmailAccount,
  ProviderCredentials,
} from "../email/types"
import { ProviderAuthError } from "../email/types"
import type { GmailTokenEnvelope } from "../email/token-manager"
import { createTokenSource } from "../email/token-manager"
import type {
  CreateFolderOperation,
  CreateLabelOperation,
  DeleteFolderOperation,
  DeleteLabelOperation,
  RenameFolderOperation,
  RenameLabelOperation,
} from "../queue/operation"
import {
  enqueueCreateFolder,
  enqueueCreateLabel,
  enqueueDeleteFolder,
  enqueueDeleteLabel,
  enqueueRenameFolder,
  enqueueRenameLabel,
} from "../queue/operation"
import {
  deleteFolderSyncState,
  getFolderSyncState,
} from "../sync/folder-sync-state"

/**
 * Label CRUD with server sync (task 10.4, mail-organization spec "Create,
 * rename, recolor, and delete labels"). The EmailProvider surface has no
 * label-ENTITY operations (types.ts is frozen), so this module owns the
 * whole flow and dispatches by account type directly:
 *
 * - Local-first: the labels row is mutated immediately (the UI reads only
 *   SQLite), then a server mutation is queued into pending_operations; the
 *   queue processor replays it via the LabelAdminService below (auth
 *   errors pause the account per the existing D10 semantics).
 * - gmail accounts mutate SERVER LABELS (POST/PATCH/DELETE …/labels via
 *   gmail-api); imap accounts mutate MAILBOXES (CREATE/RENAME/DELETE via
 *   the imap_create_folder / imap_rename_folder / imap_delete_folder Rust
 *   commands, invoked with the account's ImapParams — the same binding
 *   pattern the scheduler uses for the CONDSTORE flag hook).
 * - System labels (type "system" / specialUse set) are protected from
 *   rename and delete; the UI hides the menu items and the guards below
 *   throw a typed LabelAdminError regardless.
 *
 * IMAP rename propagation (documented scope): a RENAME MAILBOX preserves
 * UIDs, so locally the folder path is rewritten in place — messages
 * .imap_folder, the labels row (name + imap_folder_name) and its
 * folder_sync_state cursor row (UIDVALIDITY/lastSeenUid/HIGHESTMODSEQ
 * preserved). threads.folder_label_id keeps pointing at the same labels
 * row. Only the renamed folder's own rows are touched: child folders
 * ("Parent/Child" paths) are separate mailboxes the server renames on its
 * own — the next folder sync re-lists and reconciles them (and any
 * delimiter differences).
 *
 * Recolor is intentionally LOCAL-ONLY (no queued op): Gmail's color API
 * accepts only its fixed palette hexes, so the app's token colors
 * ("var(--chart-3)") cannot round-trip, and IMAP folders have no colors.
 * The spec only requires the server→local color IMPORT, which lives in
 * gmail-sync's label pass (see gmail-label-colors.ts).
 */

// ---------------------------------------------------------------------------
// Errors / validation
// ---------------------------------------------------------------------------

export type LabelAdminErrorCode =
  "system-protected" | "not-found" | "conflict" | "invalid-name"

/** Typed failure for the local-first flows; the UI surfaces `message`. */
export class LabelAdminError extends Error {
  readonly code: LabelAdminErrorCode

  constructor(code: LabelAdminErrorCode, message: string) {
    super(message)
    this.name = "LabelAdminError"
    this.code = code
  }
}

/** Hierarchy separator — the label model's display hierarchy (both providers). */
export const LABEL_SEPARATOR = "/"

/**
 * Normalize a user-supplied label/folder name: trimmed, no empty "/"
 * segments, no leading/trailing separator. Returns the cleaned full name.
 */
export function normalizeLabelName(input: string): string {
  const name = input.trim()
  if (!name) {
    throw new LabelAdminError("invalid-name", "Label name must not be empty.")
  }
  if (
    name.startsWith(LABEL_SEPARATOR) ||
    name.endsWith(LABEL_SEPARATOR) ||
    name.includes(`${LABEL_SEPARATOR}${LABEL_SEPARATOR}`)
  ) {
    throw new LabelAdminError(
      "invalid-name",
      "Label name has an empty hierarchy segment."
    )
  }
  if (/[\0\n\r]/.test(name)) {
    throw new LabelAdminError(
      "invalid-name",
      "Label name must not contain line breaks."
    )
  }
  return name
}

/** The full name of a new label: "Parent/Child" when a parent is chosen and
 * the typed name carries no "/" of its own; otherwise the name as typed. */
function resolveFullName(name: string, parent: LabelRow | null): string {
  if (parent && !name.includes(LABEL_SEPARATOR)) {
    return `${parent.name}${LABEL_SEPARATOR}${name}`
  }
  return name
}

/** Deterministic labels-row id for a user-created label — the same
 * `<accountId>:folder-<fullName>` scheme both sync engines use, so the
 * next folder/label sync recognizes (not duplicates) the row. */
function userLabelRowId(accountId: string, fullName: string): string {
  return `${accountId}:folder-${fullName}`
}

async function getAccountLabel(
  executor: SqlExecutor,
  accountId: string,
  labelId: string
): Promise<LabelRow> {
  const row = await getLabel(executor, labelId)
  if (!row || row.account_id !== accountId) {
    throw new LabelAdminError("not-found", "Label not found.")
  }
  return row
}

/** Rename/delete guard: system labels (special-use roles included) are
 * protected — the sidebar hides their menu items, this enforces it. */
function assertNotSystemLabel(row: LabelRow): void {
  if (row.type === "system" || row.special_use !== null) {
    throw new LabelAdminError(
      "system-protected",
      `"${row.name}" is a system label and cannot be renamed or deleted.`
    )
  }
}

/** UNIQUE(account_id, name) pre-check so the UI gets a typed conflict
 * error instead of a raw SQLite constraint failure. */
async function assertNameAvailable(
  executor: SqlExecutor,
  accountId: string,
  name: string,
  exceptLabelId?: string
): Promise<void> {
  const rows = await executor.select<{ id: string }>(
    "SELECT id FROM labels WHERE account_id = $1 AND name = $2",
    [accountId, name]
  )
  const clash = rows.find((row) => row.id !== exceptLabelId)
  if (clash) {
    throw new LabelAdminError(
      "conflict",
      `A label named "${name}" already exists.`
    )
  }
}

/** The account slice the local-first flows need (AccountInfo satisfies it). */
export interface LabelAdminAccountRef {
  id: string
  type: AccountType
}

// ---------------------------------------------------------------------------
// Local-first flows (the call sites' public surface)
// ---------------------------------------------------------------------------

export interface CreateUserLabelInput {
  executor: SqlExecutor
  account: LabelAdminAccountRef
  /** Free-form name; may contain "/" (hierarchy) — see resolveFullName. */
  name: string
  /** Optional parent label; its name prefixes the new label ("Parent/Child"). */
  parentId?: string
  /** Local display color token (e.g. "var(--chart-3)"); display-only. */
  color?: string
}

/** Create a user label: insert the local row now, queue the server create. */
export async function createUserLabel(
  input: CreateUserLabelInput
): Promise<LabelRow> {
  const { executor, account } = input
  const typedName = normalizeLabelName(input.name)
  const parent = input.parentId
    ? await getAccountLabel(executor, account.id, input.parentId)
    : null
  const fullName = resolveFullName(typedName, parent)
  await assertNameAvailable(executor, account.id, fullName)

  const labelId = userLabelRowId(account.id, fullName)
  await insertLabel(executor, {
    id: labelId,
    accountId: account.id,
    name: fullName,
    // gmail_label_id / imap_folder_name mirror the name until the next
    // sync reconciles (the sync engines refresh these rows in place).
    ...(account.type === "gmail" ? { gmailLabelId: fullName } : {}),
    ...(account.type === "imap" ? { imapFolderName: fullName } : {}),
    ...(input.color !== undefined ? { color: input.color } : {}),
    type: "user",
  })

  if (account.type === "gmail") {
    await enqueueCreateLabel(executor, {
      accountId: account.id,
      labelId,
      name: fullName,
      ...(input.color !== undefined ? { color: input.color } : {}),
    })
  } else {
    await enqueueCreateFolder(executor, {
      accountId: account.id,
      folderName: fullName,
    })
  }
  const row = await getLabel(executor, labelId)
  if (!row)
    throw new LabelAdminError("not-found", "Label vanished after insert.")
  return row
}

export interface RenameUserLabelInput {
  executor: SqlExecutor
  account: LabelAdminAccountRef
  labelId: string
  /** New FULL name (the dialog edits the whole path). */
  name: string
}

/**
 * Rename a user label. Rewrites the local row (name plus the provider
 * path column) and, for imap, propagates the folder path across
 * messages.imap_folder and folder_sync_state (see the module comment).
 */
export async function renameUserLabel(
  input: RenameUserLabelInput
): Promise<LabelRow> {
  const { executor, account } = input
  const row = await getAccountLabel(executor, account.id, input.labelId)
  assertNotSystemLabel(row)
  const newName = normalizeLabelName(input.name)
  if (newName !== row.name) {
    await assertNameAvailable(executor, account.id, newName, row.id)
  }

  if (account.type === "imap" && row.imap_folder_name) {
    await propagateImapFolderRename(
      executor,
      account.id,
      row.imap_folder_name,
      newName
    )
  }
  await updateLabel(executor, row.id, { name: newName })
  // Keep the provider path columns consistent with the sync engines'
  // expectations (gmail label rows are matched by name; imap rows are
  // matched by imap_folder_name) — updateLabel has no patch for them.
  if (account.type === "gmail") {
    await executor.execute(
      "UPDATE labels SET gmail_label_id = $1 WHERE id = $2",
      [newName, row.id]
    )
  } else {
    await executor.execute(
      "UPDATE labels SET imap_folder_name = $1 WHERE id = $2",
      [newName, row.id]
    )
  }

  if (account.type === "gmail") {
    await enqueueRenameLabel(executor, {
      accountId: account.id,
      labelId: row.id,
      previousName: row.name,
      name: newName,
    })
  } else {
    await enqueueRenameFolder(executor, {
      accountId: account.id,
      fromFolder: row.imap_folder_name ?? row.name,
      toFolder: newName,
    })
  }
  const updated = await getLabel(executor, row.id)
  if (!updated)
    throw new LabelAdminError("not-found", "Label vanished during rename.")
  return updated
}

/**
 * IMAP folder-path rewrite for one renamed folder: messages move with the
 * mailbox (RENAME preserves UIDs and UIDVALIDITY), and the folder's sync
 * cursor row keeps its counters under the new name. Child folders are NOT
 * rewritten — they are separate mailboxes the server renames on its own;
 * the next folder sync reconciles their rows (see the module comment).
 */
async function propagateImapFolderRename(
  executor: SqlExecutor,
  accountId: string,
  previousName: string,
  newName: string
): Promise<void> {
  await executor.execute(
    "UPDATE messages SET imap_folder = $1 WHERE account_id = $2 AND imap_folder = $3",
    [newName, accountId, previousName]
  )
  const state = await getFolderSyncState(executor, accountId, previousName)
  if (state) {
    // In-place rename keeps UIDVALIDITY / last_seen_uid / HIGHESTMODSEQ —
    // the stored UIDs stay valid after a RENAME.
    await executor.execute(
      `UPDATE folder_sync_state SET folder_name = $1
       WHERE account_id = $2 AND folder_name = $3`,
      [newName, accountId, previousName]
    )
  }
}

export interface RecolorUserLabelInput {
  executor: SqlExecutor
  account: LabelAdminAccountRef
  labelId: string
  /** New display color token, or null to clear back to the default dot. */
  color: string | null
}

/**
 * Recolor a label. Local-only by design (see the module comment): the
 * color column is display state, and no server op is queued.
 */
export async function recolorUserLabel(
  input: RecolorUserLabelInput
): Promise<LabelRow> {
  const { executor, account } = input
  const row = await getAccountLabel(executor, account.id, input.labelId)
  await updateLabel(executor, row.id, { color: input.color })
  const updated = await getLabel(executor, row.id)
  if (!updated)
    throw new LabelAdminError("not-found", "Label vanished during recolor.")
  return updated
}

export interface DeleteUserLabelInput {
  executor: SqlExecutor
  account: LabelAdminAccountRef
  labelId: string
}

/**
 * Delete a user label. thread_labels memberships cascade via FK and
 * threads.folder_label_id references are set NULL by the schema; for imap
 * the folder's messages and sync cursor are also removed (DELETE MAILBOX
 * removes them server-side). Previously queued ops are left alone — FIFO
 * replay order guarantees their creates/renames land before the delete.
 */
export async function deleteUserLabel(
  input: DeleteUserLabelInput
): Promise<void> {
  const { executor, account } = input
  const row = await getAccountLabel(executor, account.id, input.labelId)
  assertNotSystemLabel(row)

  if (account.type === "imap" && row.imap_folder_name) {
    await dropImapFolderLocalState(executor, account.id, row.imap_folder_name)
  }
  // ON DELETE CASCADE (thread_labels) / ON DELETE SET NULL
  // (threads.folder_label_id) per migrations.ts v1.
  await deleteLabel(executor, row.id)

  if (account.type === "gmail") {
    await enqueueDeleteLabel(executor, {
      accountId: account.id,
      labelId: row.id,
      name: row.name,
    })
  } else {
    await enqueueDeleteFolder(executor, {
      accountId: account.id,
      folderName: row.imap_folder_name ?? row.name,
    })
  }
}

/** Server-side the mailbox is gone with its messages — mirror that
 * locally so no ghost rows point at the deleted path. */
async function dropImapFolderLocalState(
  executor: SqlExecutor,
  accountId: string,
  folderName: string
): Promise<void> {
  await executor.execute(
    "DELETE FROM messages WHERE account_id = $1 AND imap_folder = $2",
    [accountId, folderName]
  )
  await executor.execute(
    `DELETE FROM threads WHERE account_id = $1 AND NOT EXISTS (
      SELECT 1 FROM messages WHERE messages.thread_id = threads.id
    )`,
    [accountId]
  )
  await deleteFolderSyncState(executor, accountId, folderName)
}

// ---------------------------------------------------------------------------
// LabelAdminService: the server-side replay surface (queue processor)
// ---------------------------------------------------------------------------

/** The label/folder entity ops from queue/operation.ts. */
export type LabelEntityOperation =
  | CreateLabelOperation
  | RenameLabelOperation
  | DeleteLabelOperation
  | CreateFolderOperation
  | RenameFolderOperation
  | DeleteFolderOperation

/**
 * Server-side label/folder mutations for one account, replayed by the
 * queue processor. Built per replay batch; credentials are decrypted by
 * the factory function, never logged or persisted.
 */
export interface LabelAdminService {
  readonly accountId: string
  readonly accountType: AccountType
  createServerLabel(input: { name: string; color?: string }): Promise<void>
  renameServerLabel(input: {
    previousName: string
    name: string
  }): Promise<void>
  deleteServerLabel(input: { name: string }): Promise<void>
  createServerFolder(folderName: string): Promise<void>
  renameServerFolder(fromFolder: string, toFolder: string): Promise<void>
  deleteServerFolder(folderName: string): Promise<void>
}

export interface LabelAdminServiceDeps {
  /** Injectable for tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
  /** Prebuilt gmail client (tests); skips token handling entirely. */
  gmailClient?: GmailClient
  /** Injectable for tests; defaults to the Tauri invoke (imap commands). */
  invokeImpl?: (
    command: string,
    args: Record<string, unknown>
  ) => Promise<unknown>
}

function imapParamsOf(
  account: EmailAccount,
  credentials: ProviderCredentials
): ImapParams {
  if (!account.imapHost || !account.imapPort || !account.imapSecurity) {
    throw new ProviderAuthError(
      account.id,
      "imap",
      "imap account is missing server configuration"
    )
  }
  return {
    host: account.imapHost,
    port: account.imapPort,
    security: account.imapSecurity,
    username: account.email,
    password: credentials.password,
    acceptInvalidCerts: false,
  }
}

/** Local Tauri invoke for the imap folder commands (kept next to the code
 * that owns their semantics, like flag-sync's raw invoke). */
function imapFolderInvoke<T>(
  command: string,
  args: Record<string, unknown>
): Promise<T> {
  return invoke<T>(command, args)
}

/**
 * Build the LabelAdminService for one account. gmail: a gmail-api client
 * over the token manager (same decryption pattern as the provider
 * factory); imap: the account's ImapParams + the folder commands.
 */
export async function createLabelAdminService(
  account: EmailAccount,
  credentials: ProviderCredentials,
  deps: LabelAdminServiceDeps = {}
): Promise<LabelAdminService> {
  if (account.type === "gmail") {
    const client =
      deps.gmailClient ??
      createGmailClient({
        accountId: account.id,
        getToken: await gmailTokenSource(account, deps.fetchImpl),
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      })
    return {
      accountId: account.id,
      accountType: "gmail",
      async createServerLabel({ name }) {
        // The queued color is a local display token — never sent (Gmail's
        // palette colors cannot be derived from app tokens).
        await client.createLabel({ name })
      },
      async renameServerLabel({ previousName, name }) {
        const id = await resolveServerLabelId(client, previousName)
        await client.updateLabel(id, { name })
      },
      async deleteServerLabel({ name }) {
        const id = await resolveServerLabelId(client, name)
        await client.deleteLabel(id)
      },
      async createServerFolder() {
        throw new Error("create_folder op queued for a gmail account")
      },
      async renameServerFolder() {
        throw new Error("rename_folder op queued for a gmail account")
      },
      async deleteServerFolder() {
        throw new Error("delete_folder op queued for a gmail account")
      },
    }
  }

  const params = imapParamsOf(account, credentials)
  const invoker = deps.invokeImpl ?? imapFolderInvoke
  return {
    accountId: account.id,
    accountType: "imap",
    async createServerLabel() {
      throw new Error("create_label op queued for an imap account")
    },
    async renameServerLabel() {
      throw new Error("rename_label op queued for an imap account")
    },
    async deleteServerLabel() {
      throw new Error("delete_label op queued for an imap account")
    },
    async createServerFolder(folderName: string) {
      await invoker("imap_create_folder", { params, name: folderName })
    },
    async renameServerFolder(fromFolder: string, toFolder: string) {
      await invoker("imap_rename_folder", {
        params,
        from: fromFolder,
        to: toFolder,
      })
    },
    async deleteServerFolder(folderName: string) {
      await invoker("imap_delete_folder", { params, name: folderName })
    },
  }
}

/** Decrypt the account's token envelope and bind a token source. Thrown
 * as ProviderAuthError so the processor's pause semantics apply. */
async function gmailTokenSource(
  account: EmailAccount,
  fetchImpl: typeof fetch | undefined
): Promise<(force?: boolean) => Promise<string>> {
  let envelope: GmailTokenEnvelope | null
  try {
    envelope = await decryptCredentials<GmailTokenEnvelope>(
      account.credentialsJson ?? null
    )
  } catch (error) {
    if (error instanceof ProviderAuthError) throw error
    throw new ProviderAuthError(
      account.id,
      "gmail",
      "stored gmail credentials could not be decrypted"
    )
  }
  if (!envelope?.refreshToken) {
    throw new ProviderAuthError(
      account.id,
      "gmail",
      "account has no stored gmail token; re-authorization is required"
    )
  }
  const tokenSource = createTokenSource(
    { id: account.id, oauthClientId: account.oauthClientId },
    envelope,
    fetchImpl
  )
  return (force) => tokenSource.getToken(force)
}

/**
 * Gmail's label endpoints address labels by server id ("Label_…"), while
 * local rows know the label NAME (the sync's known gmail_label_id gap).
 * Resolve by stored id first, then by exact name, then case-insensitively.
 */
async function resolveServerLabelId(
  client: GmailClient,
  nameOrId: string
): Promise<string> {
  const labels = await client.listLabels()
  const lowered = nameOrId.toLowerCase()
  const match = labels.find(
    (label) =>
      label.id === nameOrId ||
      label.name === nameOrId ||
      label.name.toLowerCase() === lowered ||
      label.id.toLowerCase() === lowered
  )
  if (!match) {
    throw new Error(`gmail label "${nameOrId}" not found on the server`)
  }
  return match.id
}

// ---------------------------------------------------------------------------
// Queued-op replay with idempotent classification
// ---------------------------------------------------------------------------

/** Gmail "duplicate label" / imap "ALREADYEXISTS" — the create (or rename
 * onto an existing name) already happened; replay convergence. */
function isAlreadyExistsError(error: unknown): boolean {
  if (error instanceof GmailApiError && error.status === 409) return true
  const message = error instanceof Error ? error.message : String(error)
  return /ALREADYEXISTS|already exists/i.test(message)
}

/** Gmail 404 / imap "NONEXISTENT" — the label/folder is already gone. */
function isNotFoundError(error: unknown): boolean {
  if (error instanceof GmailApiError && error.status === 404) return true
  const message = error instanceof Error ? error.message : String(error)
  return /NONEXISTENT|does not exist/i.test(message)
}

/**
 * Dispatch one queued label/folder entity op to the account's admin
 * service, treating the server's already-exists and not-found rejections
 * as success (idempotent replay — see operation.ts's idempotency note).
 * Everything else propagates: ProviderAuthError pauses the account,
 * transient errors retry with backoff up to the attempts cap.
 */
export async function executeLabelAdminOperation(
  admin: LabelAdminService,
  op: LabelEntityOperation
): Promise<void> {
  try {
    switch (op.kind) {
      case "create_label":
        await admin.createServerLabel({
          name: op.name,
          ...(op.color !== undefined ? { color: op.color } : {}),
        })
        return
      case "rename_label":
        await admin.renameServerLabel({
          previousName: op.previousName,
          name: op.name,
        })
        return
      case "delete_label":
        await admin.deleteServerLabel({ name: op.name })
        return
      case "create_folder":
        await admin.createServerFolder(op.folderName)
        return
      case "rename_folder":
        await admin.renameServerFolder(op.fromFolder, op.toFolder)
        return
      case "delete_folder":
        await admin.deleteServerFolder(op.folderName)
        return
    }
  } catch (error) {
    if (isAlreadyExistsError(error) || isNotFoundError(error)) return
    throw error
  }
}

/**
 * Production constructor for the queue processor: load the account row,
 * decrypt its credentials, build the service. Auth-shaped failures throw
 * ProviderAuthError so the processor pauses only this account.
 */
export async function buildLabelAdminService(
  executor: SqlExecutor,
  accountId: string,
  deps: LabelAdminServiceDeps = {}
): Promise<LabelAdminService> {
  const rows = await executor.select<AccountRow>(
    "SELECT * FROM accounts WHERE id = $1",
    [accountId]
  )
  const row = rows[0]
  if (!row) {
    throw new Error(`label admin: account ${accountId} no longer exists`)
  }
  if (row.status === "auth-error") {
    throw new ProviderAuthError(
      accountId,
      row.type,
      "account is in auth-error state; queued operations paused"
    )
  }
  let credentials: ProviderCredentials | null
  try {
    credentials = await decryptCredentials<ProviderCredentials>(
      row.credentials_json
    )
  } catch (error) {
    if (error instanceof ProviderAuthError) throw error
    throw new ProviderAuthError(
      accountId,
      row.type,
      "stored credentials could not be decrypted"
    )
  }
  if (!credentials) {
    throw new ProviderAuthError(
      accountId,
      row.type,
      "account has no stored credentials; queued operations paused"
    )
  }
  return createLabelAdminService(toEmailAccount(row), credentials, deps)
}
