import type { SqlExecutor } from "./executor"

/**
 * RFC 6154 special-use role. Labels without one of these roles are plain
 * user labels (gmail) or ordinary folders (imap).
 */
export type SpecialUse =
  "inbox" | "sent" | "drafts" | "trash" | "spam" | "archive" | "all" | "flagged"

export type LabelType = "system" | "user"

export interface LabelInput {
  id: string
  accountId: string
  /** Full label name, including "/" hierarchy segments (gmail) or the IMAP folder path. */
  name: string
  /** Gmail label id (e.g. "Label_123" / "INBOX"); NULL for imap accounts. */
  gmailLabelId?: string
  /** IMAP folder path (e.g. "INBOX", "Archive/2024"); NULL for gmail accounts. */
  imapFolderName?: string
  specialUse?: SpecialUse
  color?: string
  type: LabelType
}

export interface LabelRow {
  id: string
  account_id: string
  name: string
  gmail_label_id: string | null
  imap_folder_name: string | null
  special_use: SpecialUse | null
  color: string | null
  type: LabelType
  created_at: number
}

export async function insertLabel(
  executor: SqlExecutor,
  input: LabelInput
): Promise<void> {
  await executor.execute(
    `INSERT INTO labels (
      id, account_id, name, gmail_label_id, imap_folder_name,
      special_use, color, type
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      input.id,
      input.accountId,
      input.name,
      input.gmailLabelId ?? null,
      input.imapFolderName ?? null,
      input.specialUse ?? null,
      input.color ?? null,
      input.type,
    ]
  )
}

/** Update mutable label fields; omitted keys are left unchanged. */
export async function updateLabel(
  executor: SqlExecutor,
  labelId: string,
  patch: { name?: string; color?: string | null }
): Promise<void> {
  const sets: string[] = []
  const params: unknown[] = []
  if (patch.name !== undefined) {
    params.push(patch.name)
    sets.push(`name = $${params.length}`)
  }
  if (patch.color !== undefined) {
    params.push(patch.color)
    sets.push(`color = $${params.length}`)
  }
  if (!sets.length) return
  // placeholder numbers ascend by occurrence in the SQL text (see executor.ts)
  params.push(labelId)
  await executor.execute(
    `UPDATE labels SET ${sets.join(", ")} WHERE id = $${params.length}`,
    params
  )
}

/**
 * Delete a label. thread_labels rows cascade via FK; threads.folder_label_id
 * references set NULL; the labels row itself is removed.
 */
export async function deleteLabel(
  executor: SqlExecutor,
  labelId: string
): Promise<void> {
  await executor.execute("DELETE FROM labels WHERE id = $1", [labelId])
}

export async function getLabel(
  executor: SqlExecutor,
  labelId: string
): Promise<LabelRow | null> {
  const rows = await executor.select<LabelRow>(
    "SELECT * FROM labels WHERE id = $1",
    [labelId]
  )
  return rows[0] ?? null
}

export async function listLabelsByAccount(
  executor: SqlExecutor,
  accountId: string
): Promise<LabelRow[]> {
  return executor.select<LabelRow>(
    "SELECT * FROM labels WHERE account_id = $1 ORDER BY type ASC, name ASC",
    [accountId]
  )
}

/** Lookup by provider label id (gmail). Unique per account when set. */
export async function findLabelByGmailId(
  executor: SqlExecutor,
  accountId: string,
  gmailLabelId: string
): Promise<LabelRow | null> {
  const rows = await executor.select<LabelRow>(
    "SELECT * FROM labels WHERE account_id = $1 AND gmail_label_id = $2",
    [accountId, gmailLabelId]
  )
  return rows[0] ?? null
}

/** Lookup by IMAP folder path (imap). Unique per account when set. */
export async function findLabelByImapFolder(
  executor: SqlExecutor,
  accountId: string,
  imapFolderName: string
): Promise<LabelRow | null> {
  const rows = await executor.select<LabelRow>(
    "SELECT * FROM labels WHERE account_id = $1 AND imap_folder_name = $2",
    [accountId, imapFolderName]
  )
  return rows[0] ?? null
}

/**
 * All labels carrying a special-use role for the account. Not necessarily
 * a single row: servers can mark several folders with the same role.
 */
export async function findLabelsBySpecialUse(
  executor: SqlExecutor,
  accountId: string,
  specialUse: SpecialUse
): Promise<LabelRow[]> {
  return executor.select<LabelRow>(
    "SELECT * FROM labels WHERE account_id = $1 AND special_use = $2 ORDER BY name ASC",
    [accountId, specialUse]
  )
}
