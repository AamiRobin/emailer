import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { SqlExecutor } from "@/services/db/executor"
import { createMessage, createThread } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { saveDraft } from "@/services/composer/drafts"
import {
  syncDraftAttachmentBytes,
} from "@/services/composer/draft-attachments"
import { setSignature } from "@/services/composer/signatures"
import { setAttachmentBytes, getAttachmentBytes, clearAttachmentBytes } from "@/components/composer/attachment-bytes"
import { updateMessage } from "@/services/db/messages"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import { useComposerStore } from "@/stores/composer-store"
import { setFolderCountsStoreExecutor } from "@/stores/folder-counts-store"
import {
  setThreadListStoreExecutor,
  useThreadListStore,
} from "@/stores/thread-list-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import {
  getActiveComposerDraftKey,
  openReplyForThread,
  resumeDraft,
} from "../reply-opener"

/**
 * Shared reply-opener tests (tasks 7.6/8.4/8.6): the ONE prefill path
 * behind the reading pane's Reply button, the list's context menu and
 * the keyboard `r` (openReplyForThread) plus the Drafts-folder resume
 * path (openDraftForResume/resumeDraft). Data flows through the REAL
 * query modules against a seeded node:sqlite database — the executor
 * module is mocked to hand back the test executor (getExecutor() would
 * otherwise throw outside Tauri), exactly like thread-view.test.tsx.
 */

const executorHolder = vi.hoisted(() => ({
  current: null as SqlExecutor | null,
}))

vi.mock("@/services/db/executor", () => ({
  getExecutor: () => {
    const executor = executorHolder.current
    if (!executor) throw new Error("test executor not set")
    return executor
  },
}))

let executor: TestExecutor
let accountId: string

const HOUR = 3600

function resetStores(): void {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    readingPane: "right",
  })
  useComposerStore.getState().reset()
  useAccountStore.setState({
    accounts: [],
    activeAccountId: null,
    loaded: false,
  })
  useThreadListStore.setState({
    accountId: null,
    view: null,
    threads: [],
    drafts: [],
    labelsByThreadId: {},
    loading: false,
    loaded: false,
  })
}

beforeEach(() => {
  resetStores()
  executor = createTestExecutor()
  executorHolder.current = executor
  setThreadListStoreExecutor(executor)
  setAccountStoreExecutor(executor)
  setFolderCountsStoreExecutor(executor)
})

afterEach(async () => {
  // Let in-flight promise chains settle against the live executor.
  await new Promise((resolve) => setTimeout(resolve, 0))
  clearAttachmentBytes()
  setThreadListStoreExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  executorHolder.current = null
  executor.close()
})

/** One account + a thread whose newest message carries To/Cc participants. */
async function seedReplyThread(): Promise<{
  threadId: string
  lastMessageId: string
}> {
  accountId = "acc-1"
  await executor.execute(
    "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
    [accountId, "gmail", "me@example.com"]
  )
  const threadId = await createThread(executor, accountId, {
    subject: "Quarterly report",
  })
  await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_000_000,
    subject: "Quarterly report",
    fromName: "Ada Lovelace",
    fromAddress: "ada@example.com",
    isRead: true,
  })
  const lastMessageId = await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_000_000 + HOUR,
    subject: "Re: Quarterly report",
    fromName: "Grace Hopper",
    fromAddress: "grace@example.com",
    isRead: false,
  })
  await updateMessage(executor, lastMessageId, {
    to: [{ name: "Bob Sample", email: "bob@example.com" }],
    cc: [{ name: "Carol CC", email: "carol@example.com" }],
  })
  return { threadId, lastMessageId }
}

describe("openReplyForThread", () => {
  it("prefills the composer store as a reply to the latest message", async () => {
    const { threadId, lastMessageId } = await seedReplyThread()
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })

    const opened = await openReplyForThread({ threadId, replyAll: false })

    expect(opened).toBe(true)
    const composer = useComposerStore.getState()
    expect(composer.open).toBe(true)
    expect(composer.mode).toMatchObject({
      kind: "reply",
      replyAll: false,
      sourceMessageId: lastMessageId,
      sourceThreadId: threadId,
    })
    expect(composer.activeAccountId).toBe(accountId)
    // Plain reply targets the sender only.
    expect(composer.to).toEqual([
      { name: "Grace Hopper", email: "grace@example.com" },
    ])
    expect(composer.cc).toEqual([])
    expect(composer.subject).toBe("Re: Quarterly report")
    expect(composer.html).toContain("<blockquote")
    // The app-level bridge flag for the shell overlay.
    expect(useUiStore.getState().composerOpen).toBe(true)
    // A reply is not a resumed draft.
    expect(getActiveComposerDraftKey()).toBeNull()
  })

  it("replyAll includes the original To and Cc participants", async () => {
    const { threadId } = await seedReplyThread()
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })

    await openReplyForThread({ threadId, replyAll: true })

    const composer = useComposerStore.getState()
    expect(composer.mode).toMatchObject({ kind: "reply", replyAll: true })
    expect(composer.to.map((recipient) => recipient.email).sort()).toEqual([
      "bob@example.com",
      "grace@example.com",
    ])
    expect(composer.cc.map((recipient) => recipient.email)).toEqual([
      "carol@example.com",
    ])
  })

  it("fetches the signature and places it above the quoted history", async () => {
    const { threadId } = await seedReplyThread()
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    await setSignature(executor, accountId, "<p>Best, Me</p>")

    await openReplyForThread({ threadId, replyAll: false })

    const html = useComposerStore.getState().html
    const signatureIndex = html.indexOf("Best, Me")
    const quoteIndex = html.indexOf("<blockquote")
    expect(signatureIndex).toBeGreaterThan(-1)
    expect(quoteIndex).toBeGreaterThan(-1)
    expect(signatureIndex).toBeLessThan(quoteIndex)
  })

  it("is a no-op without an active account", async () => {
    const { threadId } = await seedReplyThread()

    const opened = await openReplyForThread({ threadId, replyAll: false })

    expect(opened).toBe(false)
    expect(useComposerStore.getState().open).toBe(false)
    expect(useUiStore.getState().composerOpen).toBe(false)
  })

  it("is a no-op for an unknown thread", async () => {
    useAccountStore.setState({ activeAccountId: "acc-1", loaded: true })

    const opened = await openReplyForThread({
      threadId: "no-such-thread",
      replyAll: false,
    })

    expect(opened).toBe(false)
    expect(useComposerStore.getState().open).toBe(false)
  })
})

describe("draft resume (openDraftForResume / resumeDraft)", () => {
  it("resumes a reply draft back into reply mode with the draft's fields", async () => {
    const { threadId } = await seedReplyThread()
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    const { id } = await saveDraft(executor, {
      accountId,
      draftKey: "draft-key-1",
      draft: {
        to: [{ name: "Grace Hopper", email: "grace@example.com" }],
        cc: [{ email: "carol@example.com" }],
        bcc: [{ email: "blind@example.com" }],
        subject: "Re: Quarterly report",
        bodyHtml: "<p>Half-written answer</p>",
        inReplyTo: "<original@example.com>",
        threadId,
      },
    })

    const resumed = await resumeDraft(executor, id)

    expect(resumed).toBe(true)
    const composer = useComposerStore.getState()
    expect(composer.open).toBe(true)
    expect(composer.mode).toMatchObject({
      kind: "reply",
      replyAll: false,
      inReplyTo: "<original@example.com>",
      sourceThreadId: threadId,
    })
    expect(composer.activeAccountId).toBe(accountId)
    expect(composer.to).toEqual([
      { name: "Grace Hopper", email: "grace@example.com" },
    ])
    expect(composer.cc).toEqual([{ email: "carol@example.com" }])
    expect(composer.bcc).toEqual([{ email: "blind@example.com" }])
    expect(composer.subject).toBe("Re: Quarterly report")
    expect(composer.html).toBe("<p>Half-written answer</p>")
    expect(useUiStore.getState().composerOpen).toBe(true)
    // The draftKey join: autosave must keep updating the SAME row (see
    // reply-opener's join note — module variable until composer-store
    // adopts the draftKey field).
    expect(getActiveComposerDraftKey()).toBe("draft-key-1")
    // Resume keeps the row — deletion happens on send/discard only.
    const rows = await executor.select<{ id: string }>(
      "SELECT id FROM local_drafts WHERE id = $1",
      [id]
    )
    expect(rows).toHaveLength(1)
  })

  it("resumes a plain (non-reply) draft as a new message", async () => {
    accountId = "acc-1"
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      [accountId, "gmail", "me@example.com"]
    )
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    const saved = await saveDraft(executor, {
      accountId,
      draft: {
        to: [{ email: "someone@example.com" }],
        cc: [],
        bcc: [],
        subject: "Fresh note",
        bodyHtml: "<p>Hello</p>",
      },
    })

    const resumed = await resumeDraft(executor, saved.id)

    expect(resumed).toBe(true)
    const composer = useComposerStore.getState()
    expect(composer.mode).toEqual({ kind: "new" })
    expect(composer.subject).toBe("Fresh note")
    expect(composer.html).toBe("<p>Hello</p>")
  })

  it("openDraftForResume records the draftKey; a later reply resets it", async () => {
    const { threadId } = await seedReplyThread()
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    const saved = await saveDraft(executor, {
      accountId,
      draftKey: "draft-key-2",
      draft: {
        to: [],
        cc: [],
        bcc: [],
        subject: "s",
        bodyHtml: "<p>b</p>",
        threadId,
      },
    })

    await resumeDraft(executor, saved.id)
    expect(getActiveComposerDraftKey()).toBe("draft-key-2")

    await openReplyForThread({ threadId, replyAll: false })
    expect(getActiveComposerDraftKey()).toBeNull()
  })

  it("resolves false for a missing draft without touching the composer", async () => {
    const resumed = await resumeDraft(executor, "no-such-draft")

    expect(resumed).toBe(false)
    expect(useComposerStore.getState().open).toBe(false)
    expect(useUiStore.getState().composerOpen).toBe(false)
  })

  it("resumes persisted attachment bytes into the session registry", async () => {
    accountId = "acc-1"
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      [accountId, "gmail", "me@example.com"]
    )
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    setAttachmentBytes("att-1", new Uint8Array([9, 8]))
    await syncDraftAttachmentBytes(executor, accountId, "draft-key-bytes", [
      {
        id: "att-1",
        name: "notes.txt",
        size: 2,
        mimeType: "text/plain",
      },
    ])
    const saved = await saveDraft(executor, {
      accountId,
      draftKey: "draft-key-bytes",
      draft: {
        to: [],
        cc: [],
        bcc: [],
        subject: "bytes",
        bodyHtml: "",
        attachments: [{ filename: "notes.txt", size: 2 }],
      },
    })
    // Session loss: the registry must be repopulated from the store.
    clearAttachmentBytes()

    const resumed = await resumeDraft(executor, saved.id)

    expect(resumed).toBe(true)
    const composer = useComposerStore.getState()
    expect(composer.attachments).toEqual([
      { id: "att-1", name: "notes.txt", size: 2, mimeType: "text/plain" },
    ])
    expect(getAttachmentBytes("att-1")).toEqual(new Uint8Array([9, 8]))
  })

  it("drops a corrupt stored attachment with a warning and resumes the draft", async () => {
    accountId = "acc-1"
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      [accountId, "gmail", "me@example.com"]
    )
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    await syncDraftAttachmentBytes(executor, accountId, "draft-key-corrupt", [
      { id: "att-bad", name: "bad.bin", size: 2 },
    ])
    const saved = await saveDraft(executor, {
      accountId,
      draftKey: "draft-key-corrupt",
      draft: {
        to: [],
        cc: [],
        bcc: [],
        subject: "keep the text",
        bodyHtml: "<p>text</p>",
        attachments: [{ filename: "bad.bin", size: 2 }],
      },
    })
    await executor.execute(
      "UPDATE draft_attachments SET content_base64 = '!!!' WHERE id = 'att-bad'"
    )

    const resumed = await resumeDraft(executor, saved.id)

    expect(resumed).toBe(true)
    const composer = useComposerStore.getState()
    // The attachment is gone; the draft itself is fully intact.
    expect(composer.attachments).toEqual([])
    expect(composer.subject).toBe("keep the text")
    expect(composer.html).toBe("<p>text</p>")
  })
})

describe("signature selection defaults (batch C1, fix 3)", () => {
  it("a reply prefill selects the account's embedded signature", async () => {
    const { threadId } = await seedReplyThread()
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    await setSignature(executor, accountId, "<p>Best, Me</p>")

    await openReplyForThread({ threadId, replyAll: false })

    const composer = useComposerStore.getState()
    expect(composer.html).toContain("Best, Me")
    expect(composer.signatureSelection).toBe(accountId)
  })

  it("a reply without an account signature selects No signature", async () => {
    const { threadId } = await seedReplyThread()
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })

    await openReplyForThread({ threadId, replyAll: false })

    expect(useComposerStore.getState().signatureSelection).toBeNull()
  })

  it("resume reflects the stored managed block in the selection", async () => {
    const { threadId } = await seedReplyThread()
    useAccountStore.setState({ activeAccountId: accountId, loaded: true })
    const withBlock = await saveDraft(executor, {
      accountId,
      draftKey: "draft-key-sig-1",
      draft: {
        to: [],
        cc: [],
        bcc: [],
        subject: "signed",
        bodyHtml:
          '<p>text</p><div class="emailer-signature"><p>Best, Me</p></div>',
        threadId,
      },
    })
    const withoutBlock = await saveDraft(executor, {
      accountId,
      draftKey: "draft-key-sig-2",
      draft: {
        to: [],
        cc: [],
        bcc: [],
        subject: "unsigned",
        bodyHtml: "<p>text</p>",
        threadId,
      },
    })

    await resumeDraft(executor, withBlock.id)
    expect(useComposerStore.getState().signatureSelection).toBe(accountId)

    await resumeDraft(executor, withoutBlock.id)
    expect(useComposerStore.getState().signatureSelection).toBeNull()
  })
})
