import type { SqlExecutor } from "../executor"
import type { AttachmentInput, ContactRef } from "../messages"
import { insertMessage } from "../messages"
import type { LabelType, SpecialUse } from "../labels"
import { insertLabel } from "../labels"
import { insertThread } from "../threads"

/** Fixture helpers — every row is written through the query layer itself,
 * so the suites verify the service functions, not raw SQL. */

let idSequence = 0

export function uid(prefix: string): string {
  idSequence += 1
  return `${prefix}-${idSequence}`
}

/** Base epoch second for fixture timestamps; `at()` offsets from it. */
export const BASE_TIME = 1_700_000_000

export function at(offsetSeconds: number): number {
  return BASE_TIME + offsetSeconds
}

export async function createAccount(
  executor: SqlExecutor,
  type: "gmail" | "imap" = "gmail"
): Promise<string> {
  const id = uid("acc")
  await executor.execute(
    "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
    [id, type, `${id}@example.com`]
  )
  return id
}

export async function createGmailLabel(
  executor: SqlExecutor,
  accountId: string,
  name: string,
  gmailLabelId: string,
  specialUse?: SpecialUse,
  type: LabelType = "system"
): Promise<string> {
  const id = uid("label")
  await insertLabel(executor, {
    id,
    accountId,
    name,
    gmailLabelId,
    specialUse,
    type,
  })
  return id
}

export async function createImapFolderLabel(
  executor: SqlExecutor,
  accountId: string,
  name: string,
  specialUse?: SpecialUse
): Promise<string> {
  const id = uid("label")
  await insertLabel(executor, {
    id,
    accountId,
    name,
    imapFolderName: name,
    specialUse,
    type: specialUse ? "system" : "user",
  })
  return id
}

export async function createThread(
  executor: SqlExecutor,
  accountId: string,
  options?: { subject?: string; gmailThreadId?: string }
): Promise<string> {
  const id = uid("thread")
  await insertThread(executor, {
    id,
    accountId,
    subject: options?.subject,
    gmailThreadId: options?.gmailThreadId,
  })
  return id
}

export interface SeedMessageOptions {
  threadId: string
  accountId: string
  date: number
  subject?: string
  fromName?: string
  fromAddress?: string
  to?: ContactRef[]
  bodyText?: string
  snippet?: string
  isRead?: boolean
  isFlagged?: boolean
  hasAttachments?: boolean
  gmailMessageId?: string
  imapFolder?: string
  imapUid?: number
  attachments?: AttachmentInput[]
}

export async function createMessage(
  executor: SqlExecutor,
  options: SeedMessageOptions
): Promise<string> {
  const id = uid("msg")
  await insertMessage(executor, {
    id,
    threadId: options.threadId,
    accountId: options.accountId,
    date: options.date,
    subject: options.subject,
    fromName: options.fromName,
    fromAddress: options.fromAddress,
    to: options.to,
    bodyText: options.bodyText,
    snippet: options.snippet,
    isRead: options.isRead,
    isFlagged: options.isFlagged,
    hasAttachments: options.hasAttachments,
    gmailMessageId: options.gmailMessageId,
    imapFolder: options.imapFolder,
    imapUid: options.imapUid,
    attachments: options.attachments,
  })
  return id
}
