import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  deleteLabel,
  findLabelByGmailId,
  findLabelByImapFolder,
  findLabelsBySpecialUse,
  getLabel,
  insertLabel,
  listLabelsByAccount,
  updateLabel,
} from "../labels"
import { getThread } from "../threads"
import { createAccount, createGmailLabel, uid } from "./fixtures"
import { createTestExecutor, type TestExecutor } from "./test-executor"

describe("label queries", () => {
  let executor: TestExecutor
  let accountId: string
  let otherAccountId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
    otherAccountId = await createAccount(executor, "gmail")
  })

  afterEach(() => {
    executor.close()
  })

  it("lists labels for one account, ordered by type then name", async () => {
    await createGmailLabel(
      executor,
      accountId,
      "Work",
      "Label_work",
      undefined,
      "user"
    )
    await createGmailLabel(executor, accountId, "INBOX", "INBOX", "inbox")
    await createGmailLabel(
      executor,
      accountId,
      "Zebra",
      "Label_z",
      undefined,
      "user"
    )
    await createGmailLabel(executor, otherAccountId, "Foreign", "Label_foreign")

    const labels = await listLabelsByAccount(executor, accountId)
    expect(labels.map((label) => label.name)).toEqual([
      "INBOX",
      "Work",
      "Zebra",
    ])
    expect(labels.every((label) => label.account_id === accountId)).toBe(true)
  })

  it("finds labels by gmail id, per account", async () => {
    const workId = await createGmailLabel(
      executor,
      accountId,
      "Work",
      "Label_work",
      undefined,
      "user"
    )
    await createGmailLabel(executor, otherAccountId, "Work", "Label_work")

    const found = await findLabelByGmailId(executor, accountId, "Label_work")
    expect(found?.id).toBe(workId)
    expect(await findLabelByGmailId(executor, accountId, "Label_missing")).toBe(
      null
    )
  })

  it("finds labels by imap folder path", async () => {
    const archiveId = uid("label")
    await insertLabel(executor, {
      id: archiveId,
      accountId,
      name: "Archive/2024",
      imapFolderName: "Archive/2024",
      specialUse: "archive",
      type: "system",
    })

    const found = await findLabelByImapFolder(
      executor,
      accountId,
      "Archive/2024"
    )
    expect(found?.id).toBe(archiveId)
    expect(await findLabelByImapFolder(executor, accountId, "Nope")).toBe(null)
  })

  it("finds all labels carrying a special-use role", async () => {
    const inbox1 = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    // servers may expose several folders with the same role
    const secondInbox = uid("label")
    await insertLabel(executor, {
      id: secondInbox,
      accountId,
      name: "Secondary Inbox",
      imapFolderName: "Secondary Inbox",
      specialUse: "inbox",
      type: "system",
    })
    await createGmailLabel(executor, accountId, "TRASH", "TRASH", "trash")
    await createGmailLabel(executor, otherAccountId, "INBOX", "INBOX", "inbox")

    const inboxes = await findLabelsBySpecialUse(executor, accountId, "inbox")
    expect(inboxes.map((label) => label.id).sort()).toEqual(
      [inbox1, secondInbox].sort()
    )
    expect(await findLabelsBySpecialUse(executor, accountId, "drafts")).toEqual(
      []
    )
  })

  it("updates name and color without touching identity", async () => {
    const labelId = await createGmailLabel(
      executor,
      accountId,
      "Work",
      "Label_work",
      undefined,
      "user"
    )
    await updateLabel(executor, labelId, {
      name: "Work stuff",
      color: "#ff8800",
    })

    const label = await getLabel(executor, labelId)
    expect(label).toMatchObject({
      name: "Work stuff",
      color: "#ff8800",
      gmail_label_id: "Label_work",
      type: "user",
    })

    // empty patch is a no-op
    await updateLabel(executor, labelId, {})
    expect((await getLabel(executor, labelId))?.name).toBe("Work stuff")
  })

  it("deleteLabel cascades membership and clears folder references", async () => {
    const labelId = await createGmailLabel(
      executor,
      accountId,
      "INBOX",
      "INBOX",
      "inbox"
    )
    const threadId = uid("thread")
    await insertLabel(executor, {
      id: uid("label"),
      accountId,
      name: "Plain",
      gmailLabelId: "Label_plain",
      type: "user",
    })
    await executor.execute(
      "INSERT INTO threads (id, account_id, folder_label_id) VALUES ($1, $2, $3)",
      [threadId, accountId, labelId]
    )
    await executor.execute(
      "INSERT INTO thread_labels (thread_id, label_id, account_id) VALUES ($1, $2, $3)",
      [threadId, labelId, accountId]
    )

    await deleteLabel(executor, labelId)

    expect(await getLabel(executor, labelId)).toBeNull()
    const thread = await getThread(executor, threadId)
    expect(thread?.folder_label_id).toBeNull()
    const memberships = await executor.select<{ label_id: string }>(
      "SELECT * FROM thread_labels WHERE label_id = $1",
      [labelId]
    )
    expect(memberships).toEqual([])
  })
})
