import { describe, expect, it } from "vitest"

import { listAccountAttachments } from "../attachment-search"
import { createTestExecutor, type TestExecutor } from "./test-executor"
import { at, createAccount, createMessage, createThread } from "./fixtures"

/**
 * Account-wide attachment listing (task 3.7, design D14): the browser's
 * query — a plain join of the existing attachments projection with
 * messages for the display/jump/fetch columns. Verified against the real
 * schema on the node:sqlite test executor (fixtures seed through the
 * query layer itself).
 */

let executor: TestExecutor

async function seedTwoAccounts(): Promise<{ accountA: string; accountB: string }> {
  const accountA = await createAccount(executor, "gmail")
  const accountB = await createAccount(executor, "imap")

  const threadReport = await createThread(executor, accountA, {
    subject: "Quarterly report",
  })
  await createMessage(executor, {
    threadId: threadReport,
    accountId: accountA,
    date: at(100),
    subject: "Quarterly report",
    fromName: "Boss",
    fromAddress: "boss@x.com",
    gmailMessageId: "gmail-msg-1",
    hasAttachments: true,
    attachments: [
      {
        id: `${threadReport}-report`,
        filename: "report.pdf",
        mimeType: "application/pdf",
        size: 2048,
        providerPartId: "0",
      },
      {
        id: `${threadReport}-chart`,
        filename: "chart.png",
        mimeType: "image/png",
        size: 4096,
        providerPartId: "1",
      },
    ],
  })

  const threadBackup = await createThread(executor, accountA, {
    subject: "Backup",
  })
  await createMessage(executor, {
    threadId: threadBackup,
    accountId: accountA,
    date: at(50),
    subject: "Backup",
    fromName: undefined,
    fromAddress: "dev@x.com",
    imapFolder: "INBOX",
    imapUid: 42,
    hasAttachments: true,
    attachments: [
      {
        id: `${threadBackup}-archive`,
        filename: "backup.zip",
        mimeType: "application/zip",
        size: 102400,
        providerPartId: "0",
      },
      // An inline cid: part is part of the index too — the browser lists
      // everything and lets the type filters narrow.
      {
        id: `${threadBackup}-logo`,
        filename: "logo.png",
        mimeType: "image/png",
        size: 512,
        contentId: "logo@x.com",
        isInline: true,
        providerPartId: "1",
      },
    ],
  })

  const threadOther = await createThread(executor, accountB, {
    subject: "Other account",
  })
  await createMessage(executor, {
    threadId: threadOther,
    accountId: accountB,
    date: at(200),
    fromAddress: "other@x.com",
    hasAttachments: true,
    attachments: [
      {
        id: `${threadOther}-secret`,
        filename: "secret.pdf",
        mimeType: "application/pdf",
        size: 1,
        providerPartId: "0",
      },
    ],
  })

  return { accountA, accountB }
}

describe("listAccountAttachments (task 3.7, D14)", () => {
  it("joins the attachment index with messages: sender, date, subject, thread and provider location", async () => {
    executor = createTestExecutor()
    try {
      const { accountA } = await seedTwoAccounts()
      const rows = await listAccountAttachments(executor, accountA)

      expect(rows).toHaveLength(4)
      const report = rows.find((row) => row.filename === "report.pdf")
      expect(report).not.toBeNull()
      expect(report?.message_subject).toBe("Quarterly report")
      expect(report?.from_name).toBe("Boss")
      expect(report?.from_address).toBe("boss@x.com")
      expect(report?.message_date).toBe(at(100))
      // thread_id drives the browser's jump-to-source…
      expect(typeof report?.thread_id).toBe("string")
      // …and the provider location feeds the existing lazy content path.
      expect(report?.gmail_message_id).toBe("gmail-msg-1")

      const archive = rows.find((row) => row.filename === "backup.zip")
      expect(archive?.imap_folder).toBe("INBOX")
      expect(archive?.imap_uid).toBe(42)
      expect(archive?.from_name).toBeNull()

      // Attachment-row metadata passes through unchanged.
      expect(report?.mime_type).toBe("application/pdf")
      expect(report?.size).toBe(2048)
      const logo = rows.find((row) => row.filename === "logo.png")
      expect(logo?.is_inline).toBe(1)
      expect(logo?.content_id).toBe("logo@x.com")
    } finally {
      executor.close()
    }
  })

  it("sorts newest message first and scopes strictly to the requested account", async () => {
    executor = createTestExecutor()
    try {
      const { accountA, accountB } = await seedTwoAccounts()

      const rows = await listAccountAttachments(executor, accountA)
      expect(rows.map((row) => row.filename)).toEqual([
        "report.pdf",
        "chart.png",
        "backup.zip",
        "logo.png",
      ])

      // The other account's attachment never leaks in…
      const other = await listAccountAttachments(executor, accountB)
      expect(other.map((row) => row.filename)).toEqual(["secret.pdf"])

      // …and an account without mail lists nothing.
      const empty = await createAccount(executor, "gmail")
      expect(await listAccountAttachments(executor, empty)).toEqual([])
    } finally {
      executor.close()
    }
  })
})
