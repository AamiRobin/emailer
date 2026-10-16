import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  deleteMessage,
  getMessage,
  insertMessage,
  listMessagesByThread,
  markMessagesFlagged,
  markMessagesRead,
  upsertMessageByProviderId,
  updateMessage,
} from "../messages"
import { at, createAccount, createMessage, createThread } from "./fixtures"
import { createTestExecutor, type TestExecutor } from "./test-executor"

describe("message queries", () => {
  let executor: TestExecutor
  let accountId: string
  let threadId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
    threadId = await createThread(executor, accountId)
  })

  afterEach(() => {
    executor.close()
  })

  it("round-trips recipients and attachments through insert/getMessage", async () => {
    const messageId = "msg-full"
    await insertMessage(executor, {
      id: messageId,
      threadId,
      accountId,
      gmailMessageId: "gm-1",
      date: at(0),
      subject: "Hello",
      fromName: "Ada Lovelace",
      fromAddress: "ada@example.com",
      to: [
        { name: "Ann", email: "ann@example.com" },
        { email: "bob@example.com" },
      ],
      cc: [{ name: "Carol", email: "carol@example.com" }],
      bcc: [],
      bodyText: "Plain text body",
      snippet: "Plain text body",
      hasAttachments: true,
      attachments: [
        {
          id: "att-1",
          filename: "report.pdf",
          mimeType: "application/pdf",
          size: 4096,
          providerPartId: "part-1",
        },
        {
          id: "att-2",
          filename: "logo.png",
          mimeType: "image/png",
          contentId: "cid-logo",
          isInline: true,
        },
      ],
    })

    const message = await getMessage(executor, messageId)
    expect(message).not.toBeNull()
    expect(message).toMatchObject({
      id: messageId,
      thread_id: threadId,
      subject: "Hello",
      from_address: "ada@example.com",
      is_read: 0,
    })
    expect(message?.to).toEqual([
      { name: "Ann", email: "ann@example.com" },
      { email: "bob@example.com" },
    ])
    expect(message?.cc).toEqual([{ name: "Carol", email: "carol@example.com" }])
    // empty bcc serializes to NULL and parses back to []
    expect(message?.bcc_json).toBeNull()
    expect(message?.bcc).toEqual([])
    expect(message?.attachments).toHaveLength(2)
    expect(message?.attachments[0]).toMatchObject({
      id: "att-1",
      filename: "report.pdf",
      mime_type: "application/pdf",
      size: 4096,
      is_inline: 0,
      provider_part_id: "part-1",
    })
    expect(message?.attachments[1]).toMatchObject({
      content_id: "cid-logo",
      is_inline: 1,
    })

    expect(await getMessage(executor, "missing")).toBeNull()
  })

  it("updateMessage patches only provided fields; null clears", async () => {
    const messageId = await createMessage(executor, {
      threadId,
      accountId,
      date: at(0),
      subject: "Original subject",
      bodyText: "Original body",
      snippet: "Original body",
      to: [{ email: "old@example.com" }],
    })

    await updateMessage(executor, messageId, {
      bodyText: "Updated body with new facts",
      snippet: "Updated body",
      isRead: true,
    })

    const afterFlags = await getMessage(executor, messageId)
    expect(afterFlags).toMatchObject({
      subject: "Original subject",
      body_text: "Updated body with new facts",
      snippet: "Updated body",
      is_read: 1,
      is_flagged: 0,
    })

    await updateMessage(executor, messageId, { snippet: null })
    expect((await getMessage(executor, messageId))?.snippet).toBeNull()

    // no-op patch must not throw or touch the row
    await updateMessage(executor, messageId, {})
    expect((await getMessage(executor, messageId))?.subject).toBe(
      "Original subject"
    )
  })

  it("listMessagesByThread returns messages chronologically", async () => {
    await createMessage(executor, {
      threadId,
      accountId,
      date: at(200),
      snippet: "third",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: at(0),
      snippet: "first",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: at(100),
      snippet: "second",
    })

    const messages = await listMessagesByThread(executor, threadId)
    expect(messages.map((message) => message.date)).toEqual([
      at(0),
      at(100),
      at(200),
    ])
    expect(messages.map((message) => message.snippet)).toEqual([
      "first",
      "second",
      "third",
    ])
  })

  it("bulk read/flag updates report affected rows", async () => {
    const m1 = await createMessage(executor, {
      threadId,
      accountId,
      date: at(0),
    })
    const m2 = await createMessage(executor, {
      threadId,
      accountId,
      date: at(100),
    })
    const m3 = await createMessage(executor, {
      threadId,
      accountId,
      date: at(200),
    })

    expect(await markMessagesRead(executor, [m1, m2])).toEqual({
      rowsAffected: 2,
    })
    expect((await getMessage(executor, m1))?.is_read).toBe(1)
    expect((await getMessage(executor, m2))?.is_read).toBe(1)
    expect((await getMessage(executor, m3))?.is_read).toBe(0)

    expect(await markMessagesRead(executor, [])).toEqual({ rowsAffected: 0 })

    expect(await markMessagesFlagged(executor, [m1])).toEqual({
      rowsAffected: 1,
    })
    expect((await getMessage(executor, m1))?.is_flagged).toBe(1)

    // unmarking works too
    await markMessagesRead(executor, [m1], false)
    expect((await getMessage(executor, m1))?.is_read).toBe(0)
  })

  it("deleteMessage removes the row and cascades attachments", async () => {
    const messageId = "msg-doomed"
    await insertMessage(executor, {
      id: messageId,
      threadId,
      accountId,
      date: at(0),
      hasAttachments: true,
      attachments: [{ id: "att-doomed", filename: "x.bin", size: 1 }],
    })

    await deleteMessage(executor, messageId)
    expect(await getMessage(executor, messageId)).toBeNull()
    const remaining = await executor.select<{ count: number }>(
      "SELECT COUNT(*) AS count FROM attachments WHERE message_id = $1",
      [messageId]
    )
    expect(remaining[0]?.count).toBe(0)
  })
})

describe("upsertMessageByProviderId", () => {
  let executor: TestExecutor
  let gmailAccount: string
  let imapAccount: string

  beforeEach(async () => {
    executor = createTestExecutor()
    gmailAccount = await createAccount(executor, "gmail")
    imapAccount = await createAccount(executor, "imap")
  })

  afterEach(() => {
    executor.close()
  })

  it("gmail: second sync with the same message id updates in place", async () => {
    const threadId = await createThread(executor, gmailAccount)
    const first = await upsertMessageByProviderId(executor, {
      id: "local-1",
      threadId,
      accountId: gmailAccount,
      gmailMessageId: "gm-77",
      date: at(0),
      subject: "First sync",
      bodyText: "First body",
      snippet: "First body",
    })
    expect(first).toEqual({ id: "local-1", created: true })

    const second = await upsertMessageByProviderId(executor, {
      id: "local-2",
      threadId,
      accountId: gmailAccount,
      gmailMessageId: "gm-77",
      date: at(50),
      subject: "Second sync",
      bodyText: "Second body",
      snippet: "Second body",
      isRead: true,
    })

    expect(second).toEqual({ id: "local-1", created: false })
    const rows = await executor.select<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE account_id = $1",
      [gmailAccount]
    )
    expect(rows[0]?.count).toBe(1)

    const message = await getMessage(executor, "local-1")
    expect(message).toMatchObject({
      thread_id: threadId,
      subject: "Second sync",
      body_text: "Second body",
      is_read: 1,
    })
  })

  it("imap: keyed by folder + uid, distinct uid inserts", async () => {
    const threadId = await createThread(executor, imapAccount)
    const first = await upsertMessageByProviderId(executor, {
      id: "imap-1",
      threadId,
      accountId: imapAccount,
      imapFolder: "INBOX",
      imapUid: 42,
      date: at(0),
      subject: "Uid 42",
    })
    expect(first.created).toBe(true)

    const sameKey = await upsertMessageByProviderId(executor, {
      id: "imap-2",
      threadId,
      accountId: imapAccount,
      imapFolder: "INBOX",
      imapUid: 42,
      date: at(10),
      subject: "Uid 42 refreshed",
    })
    expect(sameKey).toEqual({ id: "imap-1", created: false })

    const otherUid = await upsertMessageByProviderId(executor, {
      id: "imap-3",
      threadId,
      accountId: imapAccount,
      imapFolder: "INBOX",
      imapUid: 43,
      date: at(20),
      subject: "Uid 43",
    })
    expect(otherUid.created).toBe(true)

    const rows = await executor.select<{ count: number }>(
      "SELECT COUNT(*) AS count FROM messages WHERE account_id = $1",
      [imapAccount]
    )
    expect(rows[0]?.count).toBe(2)
  })

  it("messages without a provider key always insert", async () => {
    const threadId = await createThread(executor, imapAccount)
    const first = await upsertMessageByProviderId(executor, {
      id: "plain-1",
      threadId,
      accountId: imapAccount,
      date: at(0),
      subject: "No key",
    })
    const second = await upsertMessageByProviderId(executor, {
      id: "plain-2",
      threadId,
      accountId: imapAccount,
      date: at(0),
      subject: "No key",
    })
    expect(first.created).toBe(true)
    expect(second.created).toBe(true)
  })
})

/**
 * The folded FTS stamp (parity-round-3 task 2.1, design D8): the write
 * path fills `messages.folded` — the diacritic-folded copy migration v20's
 * rebuilt messages_fts indexes — on every insert and on every update that
 * touches an FTS-covered column, with the same composer the bootstrap
 * backfill runs (search/fts.ts composeFoldedText).
 */
describe("folded FTS stamp (task 2.1, design D8)", () => {
  let executor: TestExecutor
  let accountId: string
  let threadId: string

  beforeEach(async () => {
    executor = createTestExecutor()
    accountId = await createAccount(executor, "gmail")
    threadId = await createThread(executor, accountId)
  })

  afterEach(() => {
    executor.close()
  })

  /** The messages.folded value, plus proof the FTS index itself carries
   * the folded column (column-filtered MATCH — the inverted index only
   * has the column if the trigger wrote it). */
  async function foldedOf(
    messageId: string
  ): Promise<{ column: string | null; indexed: number }> {
    const column = await executor.select<{ folded: string | null }>(
      "SELECT folded FROM messages WHERE id = $1",
      [messageId]
    )
    const indexed = await executor.select<{ count: number }>(
      `SELECT COUNT(*) AS count FROM messages_fts
       WHERE messages_fts MATCH $1 AND rowid = (
         SELECT rowid FROM messages WHERE id = $2
       )`,
      ['folded: "be don dep"', messageId]
    )
    return {
      column: column[0]?.folded ?? null,
      indexed: indexed[0]?.count ?? 0,
    }
  }

  it("insert stamps both raw and folded columns through the trigger", async () => {
    await insertMessage(executor, {
      id: "msg-folded",
      threadId,
      accountId,
      date: at(0),
      subject: "Bé Dọn Dẹp",
      fromName: "Hoà Bình",
      fromAddress: "hoa@vn.example",
      to: [{ name: "José", email: "jose@vn.example" }],
      bodyText: "Lịch họp tuần sau đã đổi.",
      snippet: "Lịch họp tuần sau đã đổi.",
    })

    // foldText strips combining marks only; đ (d-with-stroke) has no
    // decomposition and survives — the normalizer transliterates nothing.
    // Newline-joined per field so no trigram straddles two fields.
    const { column, indexed } = await foldedOf("msg-folded")
    expect(column).toBe(
      "Be Don Dep\nHoa Binh\nhoa@vn.example\n" +
        '[{"name":"Jose","email":"jose@vn.example"}]\n' +
        "Lich hop tuan sau đa đoi.\nLich hop tuan sau đa đoi."
    )
    // the messages_fts_ai trigger carried the folded value into the index
    expect(indexed).toBe(1)
  })

  it("insert with no searchable text folds to the empty string", async () => {
    await insertMessage(executor, {
      id: "msg-bare",
      threadId,
      accountId,
      date: at(0),
    })
    const rows = await executor.select<{ folded: string | null }>(
      "SELECT folded FROM messages WHERE id = $1",
      ["msg-bare"]
    )
    expect(rows[0]?.folded).toBe("")
  })

  it("update touching an FTS-covered column re-stamps folded over the merged row", async () => {
    await createMessage(executor, {
      threadId,
      accountId,
      date: at(0),
      subject: "Bé Dọn Dẹp",
      bodyText: "Old body",
      snippet: "Old body",
    })
    const rows = await executor.select<{ id: string }>(
      "SELECT id FROM messages WHERE thread_id = $1",
      [threadId]
    )
    const messageId = rows[0]!.id

    // only body_text + snippet change — subject must still be folded in
    await updateMessage(executor, messageId, {
      bodyText: "New Be Don Dep body",
      snippet: "New body",
    })

    const { column, indexed } = await foldedOf(messageId)
    expect(column).toBe("Be Don Dep\nNew Be Don Dep body\nNew body")
    // the messages_fts_au trigger rewrote the index row with the new fold
    expect(indexed).toBe(1)
  })

  it("update of a non-FTS field leaves folded untouched", async () => {
    await createMessage(executor, {
      threadId,
      accountId,
      date: at(0),
      subject: "Bé Dọn Dẹp",
      bodyText: "Body",
      snippet: "Body",
    })
    const rows = await executor.select<{ id: string }>(
      "SELECT id FROM messages WHERE thread_id = $1",
      [threadId]
    )
    const messageId = rows[0]!.id

    await updateMessage(executor, messageId, { isRead: true })
    const { column } = await foldedOf(messageId)
    expect(column).toBe("Be Don Dep\nBody\nBody")
  })

  it("upsertMessageByProviderId re-stamps folded on the update path", async () => {
    await upsertMessageByProviderId(executor, {
      id: "up-1",
      threadId,
      accountId,
      gmailMessageId: "gm-folded",
      date: at(0),
      subject: "Bé Dọn Dẹp",
      bodyText: "First body",
      snippet: "First body",
    })

    await upsertMessageByProviderId(executor, {
      id: "up-ignored",
      threadId,
      accountId,
      gmailMessageId: "gm-folded",
      date: at(1),
      subject: "Bé Dọn Dẹp",
      bodyText: "Second Be Don Dep body",
      snippet: "Second body",
    })

    const { column, indexed } = await foldedOf("up-1")
    expect(column).toBe("Be Don Dep\nSecond Be Don Dep body\nSecond body")
    expect(indexed).toBe(1)
  })
})
