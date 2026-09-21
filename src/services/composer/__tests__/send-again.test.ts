import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { createAccount, createImapFolderLabel, createMessage, createThread, uid } from "../../db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "../../db/__tests__/test-executor"
import { insertLabel } from "../../db/labels"
import { setThreadFolder, setThreadLabels } from "../../db/threads"
import {
  getComposerPayload,
  useComposerStore,
} from "@/stores/composer-store"
import { useUiStore } from "@/stores/ui-store"
import { sendComposerDraft } from "../send"
import {
  isThreadInSentFolder,
  openSendAgainForMessage,
  SEND_AGAIN_ATTACHMENT_NOTICE,
} from "../send-again"

// The sent chime is a seam (same substitution as send.test.ts).
vi.mock("../../notifications/sounds", () => ({ playSentSound: vi.fn() }))

/**
 * Send again (batch C3): the reading-pane action reopens a sent message
 * as a brand-new draft — original recipients, the subject VERBATIM (no
 * Re:/Fwd: handling), the original sent body, From = the account that
 * sent it, and a `{ kind: "new" }` mode so the next send produces a
 * completely independent message (fresh thread, no In-Reply-To/
 * References). Attachments re-attach only when their bytes are actually
 * recoverable; any unrestorable file is never silently dropped — the
 * composer opens with the dismissible notice line instead.
 */

let executor: TestExecutor

beforeEach(() => {
  executor = createTestExecutor()
})

afterEach(async () => {
  useComposerStore.getState().cancelUndoSend()
  useComposerStore.getState().reset()
  useUiStore.setState({ composerOpen: false })
  executor.close()
})

/** Gmail system labels incl. the sent-role label, so sent-filing works. */
async function seedGmailSentLabel(accountId: string): Promise<string> {
  const sentLabelId = uid("label")
  await insertLabel(executor, {
    id: sentLabelId,
    accountId,
    name: "SENT",
    gmailLabelId: "SENT",
    specialUse: "sent",
    type: "system",
  })
  return sentLabelId
}

/** A sent message like fileIntoSent writes it: from = the account, real
 * recipients, subject and body stored, filed under the sent label. */
async function seedSentMessage(options?: {
  subject?: string
  withAttachmentRow?: boolean
}): Promise<{ messageId: string; threadId: string; accountId: string }> {
  const accountId = await createAccount(executor, "gmail")
  const sentLabelId = await seedGmailSentLabel(accountId)
  const threadId = await createThread(executor, accountId, {
    subject: options?.subject ?? "Quarterly report",
  })
  const messageId = await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_000_000,
    subject: options?.subject ?? "Quarterly report",
    fromName: "Me",
    fromAddress: `${accountId}@example.com`,
    to: [
      { name: "Alice", email: "alice@example.com" },
      { email: "bob@example.com" },
    ],
    cc: [{ name: "Carol", email: "carol@example.com" }],
    bodyText: "Quarterly report",
    isRead: true,
  })
  await executor.execute("UPDATE messages SET body_html = $1 WHERE id = $2", [
    "<p>Hi there — the report is attached.</p>",
    messageId,
  ])
  await setThreadLabels(executor, threadId, [sentLabelId])
  if (options?.withAttachmentRow) {
    await executor.execute(
      `INSERT INTO attachments (
         id, message_id, account_id, filename, mime_type, size, content_id,
         is_inline, provider_part_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        uid("att"),
        messageId,
        accountId,
        "report.pdf",
        "application/pdf",
        4,
        null,
        0,
        "part-1",
      ]
    )
  }
  return { messageId, threadId, accountId }
}

describe("isThreadInSentFolder", () => {
  it("recognizes a gmail thread by its sent-label membership", async () => {
    const { threadId, accountId } = await seedSentMessage()
    expect(await isThreadInSentFolder(executor, accountId, threadId)).toBe(
      true
    )
  })

  it("reads false for a thread outside the sent folder", async () => {
    const accountId = await createAccount(executor, "gmail")
    await seedGmailSentLabel(accountId)
    const otherId = uid("label")
    await insertLabel(executor, {
      id: otherId,
      accountId,
      name: "INBOX",
      gmailLabelId: "INBOX",
      specialUse: "inbox",
      type: "system",
    })
    const threadId = await createThread(executor, accountId)
    await setThreadLabels(executor, threadId, [otherId])
    expect(await isThreadInSentFolder(executor, accountId, threadId)).toBe(
      false
    )
  })

  it("recognizes an imap thread by its folder assignment", async () => {
    const accountId = await createAccount(executor, "imap")
    const sent = await createImapFolderLabel(executor, accountId, "Sent", "sent")
    const threadId = await createThread(executor, accountId)
    await setThreadFolder(executor, threadId, sent)
    expect(await isThreadInSentFolder(executor, accountId, threadId)).toBe(
      true
    )
  })

  it("reads false when the account has no sent-role label at all", async () => {
    const accountId = await createAccount(executor, "gmail")
    const threadId = await createThread(executor, accountId)
    expect(await isThreadInSentFolder(executor, accountId, threadId)).toBe(
      false
    )
  })
})

describe("openSendAgainForMessage", () => {
  it("prefills a NEW-message draft with the original recipients, verbatim subject and sent body", async () => {
    const { messageId, accountId } = await seedSentMessage({
      subject: "Re: Kickoff — final agenda",
    })

    const opened = await openSendAgainForMessage(messageId, { executor })

    expect(opened).toBe(true)
    const state = useComposerStore.getState()
    expect(state.open).toBe(true)
    // A completely independent new message: no reply context.
    expect(state.mode).toEqual({ kind: "new" })
    // From = the account that sent it.
    expect(state.activeAccountId).toBe(accountId)
    expect(state.to).toEqual([
      { name: "Alice", email: "alice@example.com" },
      { email: "bob@example.com" },
    ])
    expect(state.cc).toEqual([{ name: "Carol", email: "carol@example.com" }])
    expect(state.bcc).toEqual([])
    // The subject exactly as sent — an existing Re: prefix is preserved.
    expect(state.subject).toBe("Re: Kickoff — final agenda")
    expect(state.html).toBe("<p>Hi there — the report is attached.</p>")
    expect(useUiStore.getState().composerOpen).toBe(true)
  })

  it("restores attachments whose bytes are recoverable from the store", async () => {
    const { messageId } = await seedSentMessage({ withAttachmentRow: true })
    const bytes = new Uint8Array([1, 2, 3, 4])
    await executor.execute(
      "UPDATE attachments SET local_path = $1, cached_at = $2, cache_size = $3",
      ["cached/report.pdf", 1_700_000_100, bytes.byteLength]
    )

    await openSendAgainForMessage(messageId, {
      executor,
      attachmentDeps: {
        fs: {
          ensureCacheDir: async () => {},
          writeFile: async () => {},
          readFile: async (path: string) => {
            expect(path).toBe("cached/report.pdf")
            return bytes
          },
          removeFile: async () => {},
        },
        hash: async (key: string) => `hash-${key.length}`,
      },
    })

    const state = useComposerStore.getState()
    expect(state.attachments).toHaveLength(1)
    expect(state.attachments[0]).toMatchObject({
      name: "report.pdf",
      mimeType: "application/pdf",
      size: 4,
    })
    // The notice stays off — nothing silently differs.
    expect(state.attachmentNotice).toBeNull()
    // The bytes ride the payload on send.
    const payload = getComposerPayload()
    expect(payload.attachments).toHaveLength(1)
    expect(payload.attachments?.[0].filename).toBe("report.pdf")
  })

  it("attaches nothing and shows the dismissible notice when bytes are unrecoverable", async () => {
    const { messageId } = await seedSentMessage({ withAttachmentRow: true })

    await openSendAgainForMessage(messageId, {
      executor,
      attachmentDeps: {
        fs: {
          ensureCacheDir: async () => {},
          writeFile: async () => {},
          readFile: async () => {
            throw new Error("not cached")
          },
          removeFile: async () => {},
        },
        fetchAttachment: async () => {
          throw new Error("offline")
        },
        hash: async (key: string) => `hash-${key.length}`,
      },
    })

    const state = useComposerStore.getState()
    expect(state.attachments).toHaveLength(0)
    expect(state.attachmentNotice).toBe(SEND_AGAIN_ATTACHMENT_NOTICE)
    expect(getComposerPayload().attachments).toBeUndefined()
  })

  it("skips inline body parts and opens silently when only those exist", async () => {
    const { messageId, accountId } = await seedSentMessage()
    await executor.execute(
      `INSERT INTO attachments (
         id, message_id, account_id, filename, mime_type, size, content_id,
         is_inline, provider_part_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [uid("att"), messageId, accountId, "logo.png", "image/png", 9, "<logo-cid>", 1, "part-2"]
    )

    await openSendAgainForMessage(messageId, { executor })

    const state = useComposerStore.getState()
    expect(state.attachments).toHaveLength(0)
    expect(state.attachmentNotice).toBeNull()
  })

  it("dismisses the notice; a later openNew starts clean", async () => {
    const { messageId, accountId } = await seedSentMessage({
      withAttachmentRow: true,
    })
    await openSendAgainForMessage(messageId, {
      executor,
      attachmentDeps: {
        fs: {
          ensureCacheDir: async () => {},
          writeFile: async () => {},
          readFile: async () => {
            throw new Error("not cached")
          },
          removeFile: async () => {},
        },
        fetchAttachment: async () => {
          throw new Error("offline")
        },
        hash: async (key: string) => `hash-${key.length}`,
      },
    })
    expect(useComposerStore.getState().attachmentNotice).not.toBeNull()

    useComposerStore.getState().openNew(accountId)
    expect(useComposerStore.getState().attachmentNotice).toBeNull()
  })

  it("leaves the composer untouched for an unknown message", async () => {
    const opened = await openSendAgainForMessage("no-such-message", {
      executor,
    })
    expect(opened).toBe(false)
    expect(useComposerStore.getState().open).toBe(false)
    expect(useUiStore.getState().composerOpen).toBe(false)
  })

  it("sending the prefilled draft produces a fresh thread with no reply headers", async () => {
    const { messageId, threadId } = await seedSentMessage({
      subject: "Re: Kickoff — final agenda",
    })
    // The original row carries reply headers from its own history; the
    // RESEND must not inherit them.
    await executor.execute(
      "UPDATE messages SET in_reply_to = $1, references_header = $2 WHERE id = $3",
      ["<orig@example.com>", "<root@example.com> <orig@example.com>", messageId]
    )

    await openSendAgainForMessage(messageId, { executor })
    const state = useComposerStore.getState()
    const result = await sendComposerDraft({
      executor,
      accountId: state.activeAccountId as string,
      payload: getComposerPayload(),
      mode: state.mode,
      draftKey: state.draftKey ?? undefined,
    })

    if (result.status !== "queued") throw new Error(result.error)
    expect(result.threadId).not.toBe(threadId)
    const rows = await executor.select<{
      in_reply_to: string | null
      references_header: string | null
      subject: string | null
      thread_id: string
    }>("SELECT in_reply_to, references_header, subject, thread_id FROM messages WHERE thread_id = $1", [
      result.threadId,
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].in_reply_to).toBeNull()
    expect(rows[0].references_header).toBeNull()
    // The subject carried over verbatim.
    expect(rows[0].subject).toBe("Re: Kickoff — final agenda")
  })
})
