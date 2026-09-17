import { StrictMode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"

import type { SqlExecutor } from "@/services/db/executor"
import { createMessage, createThread } from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { allowSender } from "@/services/db/image-allowlist"
import { listBlockedSenders } from "@/services/db/blocked-senders"
import type { ContactRef } from "@/services/db/messages"
import { updateMessage } from "@/services/db/messages"
import { recomputeThreadCaches } from "@/services/db/threads"
import { setSignature } from "@/services/composer/signatures"
import {
  setAccountStoreExecutor,
  useAccountStore,
} from "@/stores/account-store"
import { setFolderCountsStoreExecutor } from "@/stores/folder-counts-store"
import {
  setThreadListStoreExecutor,
  useThreadListStore,
} from "@/stores/thread-list-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { useComposerStore } from "@/stores/composer-store"
import { toast } from "sonner"
import { ThreadView } from "../thread-view"

const toastMock = vi.mocked(toast)

/**
 * Thread-view render tests (tasks 7.1/7.3/7.4/7.5-UI). Data flows through
 * the REAL query modules against a seeded node:sqlite database: the
 * executor module is mocked to hand back the test executor (getExecutor()
 * would otherwise throw outside Tauri — same seam the stores' overrides
 * cover for the stores). The thread-action and attachment-content
 * services are mocked at their module seams; their behavior is covered by
 * their own suites.
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
  placeholders: (count: number, firstIndex = 1): string =>
    Array.from({ length: count }, (_, index) => `$${index + firstIndex}`).join(
      ", "
    ),
}))

const threadActions = vi.hoisted(() => ({
  archiveThread:
    vi.fn<
      (executor: unknown, accountId: string, threadId: string) => Promise<void>
    >(),
  trashThread:
    vi.fn<
      (executor: unknown, accountId: string, threadId: string) => Promise<void>
    >(),
  setThreadStarred:
    vi.fn<
      (
        executor: unknown,
        accountId: string,
        threadId: string,
        starred: boolean
      ) => Promise<void>
    >(),
  setThreadRead:
    vi.fn<
      (
        executor: unknown,
        accountId: string,
        threadId: string,
        read: boolean
      ) => Promise<void>
    >(),
  // snooze.ts reuses this error (index.ts star-exports both modules) and
  // loads through the mock whenever ThreadView is imported.
  ThreadNotFoundError: class ThreadNotFoundError extends Error {},
}))

vi.mock("@/services/email-actions/thread-actions", () => threadActions)

// thread-states (task 3.3) is a separate module seam (mute/pin/done are
// local-only SQL, but the toolbar tests assert calls, not columns).
const threadStates = vi.hoisted(() => ({
  muteThread: vi.fn<(executor: unknown, threadId: string) => Promise<void>>(),
  unmuteThread: vi.fn<(executor: unknown, threadId: string) => Promise<void>>(),
  pinThread: vi.fn<(executor: unknown, threadId: string) => Promise<void>>(),
  unpinThread: vi.fn<(executor: unknown, threadId: string) => Promise<void>>(),
  markThreadDone:
    vi.fn<(executor: unknown, threadId: string) => Promise<void>>(),
  unmarkThreadDone:
    vi.fn<(executor: unknown, threadId: string) => Promise<void>>(),
}))

vi.mock("@/services/email-actions/thread-states", () => threadStates)

// The shared state flow toasts on success (same boundary as
// snooze.test.tsx); mocked so tests assert it directly.
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

const attachmentsService = vi.hoisted(() => ({
  ensureAttachmentCached: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  getAttachmentContent: vi.fn<(...args: unknown[]) => Promise<Uint8Array>>(),
  saveAttachmentAs: vi.fn<(...args: unknown[]) => Promise<string | null>>(),
  openAttachment: vi.fn<(...args: unknown[]) => Promise<string>>(),
}))

vi.mock("@/services/attachments", () => attachmentsService)

let executor: TestExecutor
let accountId: string

const HOUR = 3600

function setSelection(threadId: string | null): void {
  useUiStore.setState({ activeThread: threadId })
}

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
    accounts: [
      {
        id: "acc-1",
        type: "gmail",
        email: "acc-1@example.com",
        displayName: null,
        status: "active",
        unreadCount: 0,
      },
    ],
    activeAccountId: null,
    loaded: true,
  })
  useThreadListStore.setState({
    accountId: null,
    view: null,
    threads: [],
    labelsByThreadId: {},
    loading: false,
    loaded: false,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetStores()
  executor = createTestExecutor()
  executorHolder.current = executor
  setThreadListStoreExecutor(executor)
  setAccountStoreExecutor(executor)
  setFolderCountsStoreExecutor(executor)
  threadActions.archiveThread.mockResolvedValue()
  threadActions.trashThread.mockResolvedValue()
  threadActions.setThreadStarred.mockResolvedValue()
  threadActions.setThreadRead.mockResolvedValue()
  threadStates.muteThread.mockResolvedValue()
  threadStates.unmuteThread.mockResolvedValue()
  threadStates.pinThread.mockResolvedValue()
  threadStates.unpinThread.mockResolvedValue()
  threadStates.markThreadDone.mockResolvedValue()
  threadStates.unmarkThreadDone.mockResolvedValue()
  attachmentsService.getAttachmentContent.mockResolvedValue(
    new Uint8Array([9, 9])
  )
  attachmentsService.saveAttachmentAs.mockResolvedValue("/tmp/report.pdf")
  attachmentsService.openAttachment.mockResolvedValue("attachment_cache/x.bin")
})

afterEach(async () => {
  // Let in-flight promise chains (mark-read refreshes, allowlist writes)
  // settle against the live executor before it is closed.
  await new Promise((resolve) => setTimeout(resolve, 0))
  cleanup()
  setThreadListStoreExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  executorHolder.current = null
  executor.close()
})

/** A read (older) + unread (newer) message pair in one thread. */
async function seedMixedThread(options?: {
  to?: ContactRef[]
  cc?: ContactRef[]
}): Promise<{ threadId: string; readId: string; unreadId: string }> {
  accountId = "acc-1"
  await executor.execute(
    "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
    [accountId, "gmail", "me@example.com"]
  )
  const threadId = await createThread(executor, accountId, {
    subject: "Quarterly report",
  })
  const readId = await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_000_000,
    subject: "Quarterly report",
    snippet: "earlier read message preview",
    fromName: "Ada Lovelace",
    fromAddress: "ada@example.com",
    isRead: true,
  })
  const unreadId = await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_000_000 + HOUR,
    subject: "Re: Quarterly report",
    snippet: "newest unread message preview",
    fromName: "Grace Hopper",
    fromAddress: "grace@example.com",
    isRead: false,
  })
  if (options?.to || options?.cc) {
    await updateMessage(executor, unreadId, {
      ...(options.to ? { to: options.to } : {}),
      ...(options.cc ? { cc: options.cc } : {}),
    })
  }
  return { threadId, readId, unreadId }
}

async function openThread(threadId: string): Promise<void> {
  setSelection(threadId)
  await screen.findByTestId("thread-subject")
}

describe("ThreadView states", () => {
  it("shows the empty state without a selection", () => {
    render(<ThreadView />)
    expect(screen.getByTestId("thread-empty")).not.toBeNull()
    expect(screen.getByText("No message selected")).not.toBeNull()
  })

  it("shows the not-found state for an unknown thread id", async () => {
    accountId = "acc-1"
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      [accountId, "gmail", "me@example.com"]
    )
    useAccountStore.setState({ activeAccountId: accountId })
    render(<ThreadView />)
    setSelection("no-such-thread")
    await screen.findByTestId("thread-not-found")
  })
})

describe("task 7.1: ordered collapsible messages", () => {
  it("renders read messages collapsed and unread expanded + emphasized", async () => {
    const { threadId } = await seedMixedThread({
      to: [{ name: "Bob Sample", email: "bob@example.com" }],
      cc: [{ name: "Carol CC", email: "carol@example.com" }],
    })
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    // Newest unread message: expanded with the unread dot.
    const expanded = screen.getByTestId("message-expanded")
    expect(within(expanded).getByText("Grace Hopper")).not.toBeNull()
    expect(within(expanded).getByTestId("unread-dot")).not.toBeNull()
    // Read message: one-line summary only, body not rendered.
    const collapsed = screen.getByTestId("message-collapsed")
    expect(within(collapsed).getByText("Ada Lovelace")).not.toBeNull()
    expect(
      within(collapsed).getByText("earlier read message preview")
    ).not.toBeNull()
    expect(screen.queryByText("earlier read message body")).toBeNull()
  })

  it("shows To/Cc recipients and the sender address in the expanded header", async () => {
    const { threadId } = await seedMixedThread({
      to: [{ name: "Bob Sample", email: "bob@example.com" }],
      cc: [{ name: "Carol CC", email: "carol@example.com" }],
    })
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    const expanded = screen.getByTestId("message-expanded")
    expect(within(expanded).getByText("<grace@example.com>")).not.toBeNull()
    const toLine = within(expanded).getByTestId("recipients-to")
    expect(within(toLine).getByText("Bob Sample")).not.toBeNull()
    const ccLine = within(expanded).getByTestId("recipients-cc")
    expect(within(ccLine).getByText("Carol CC")).not.toBeNull()
  })

  it("derives initials and a deterministic chart-token avatar class", async () => {
    const { threadId } = await seedMixedThread()
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    const expanded = screen.getByTestId("message-expanded")
    expect(within(expanded).getByText("GH")).not.toBeNull()
    const fallback = expanded.querySelector('[data-slot="avatar-fallback"]')
    expect(fallback).not.toBeNull()
    expect(fallback?.className).toMatch(/bg-chart-\d/)
  })

  it("expands a collapsed message on click and collapses it back", async () => {
    const { threadId } = await seedMixedThread()
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    // Only the read message is collapsed at first.
    expect(screen.getAllByTestId("message-collapsed")).toHaveLength(1)

    // Expand via the summary row: the read message's body appears.
    fireEvent.click(screen.getByTestId("expand-message"))
    await waitFor(() =>
      expect(screen.queryByTestId("message-collapsed")).toBeNull()
    )
    const expandedRows = screen.getAllByTestId("message-expanded")
    expect(expandedRows).toHaveLength(2)
    const adaRow = expandedRows.find((row) =>
      row.textContent?.includes("Ada Lovelace")
    )
    expect(adaRow).toBeDefined()
    expect(
      adaRow?.querySelector('[data-slot="avatar-fallback"]')?.className
    ).toMatch(/bg-chart-\d/)

    // Collapse back via the chevron toggle.
    if (!adaRow) throw new Error("expanded row disappeared")
    fireEvent.click(
      adaRow.querySelector('[data-testid="collapse-message"]') as Element
    )
    await waitFor(() =>
      expect(screen.getAllByTestId("message-collapsed")).toHaveLength(1)
    )
  })
})

describe("mark-read-on-open", () => {
  it("marks an unread thread read exactly once per open and refreshes", async () => {
    const { threadId } = await seedMixedThread()
    render(
      <StrictMode>
        <ThreadView />
      </StrictMode>
    )
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    await waitFor(() =>
      expect(threadActions.setThreadRead).toHaveBeenCalledTimes(1)
    )
    expect(threadActions.setThreadRead).toHaveBeenCalledWith(
      executor,
      accountId,
      threadId,
      true
    )

    // Re-render / subscription churn does not re-trigger the mark.
    setSelection(null)
    setSelection(threadId)
    await new Promise((resolve) => setTimeout(resolve, 0))
    // New open (thread re-selected) still resolves through the guard for
    // the SAME open; a genuinely new open resets with fresh component
    // state, so total stays 1 for this mount.
    expect(threadActions.setThreadRead).toHaveBeenCalledTimes(1)
  })

  it("does not mark an already-read thread", async () => {
    accountId = "acc-1"
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      [accountId, "gmail", "me@example.com"]
    )
    const threadId = await createThread(executor, accountId, {
      subject: "All read",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_000_000,
      fromName: "Ada Lovelace",
      fromAddress: "ada@example.com",
      isRead: true,
    })
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(threadActions.setThreadRead).not.toHaveBeenCalled()
  })
})

describe("task 7.3: remote-image blocking", () => {
  async function seedRemoteImageThread(): Promise<string> {
    accountId = "acc-1"
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      [accountId, "gmail", "me@example.com"]
    )
    const threadId = await createThread(executor, accountId, {
      subject: "Newsletter",
    })
    const messageId = await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_000_000,
      fromName: "News Daily",
      fromAddress: "news@example.com",
      isRead: false,
    })
    await updateMessage(executor, messageId, {
      bodyHtml:
        '<p>Hello <img src="https://track.example.com/pixel.png" alt="pixel"></p>',
    })
    return threadId
  }

  function frameSrcdoc(): string {
    const frame = document.querySelector("iframe")
    if (!frame) throw new Error("no email frame rendered")
    return frame.getAttribute("srcdoc") ?? ""
  }

  it("blocks remote images by default and shows the banner", async () => {
    const threadId = await seedRemoteImageThread()
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    const banner = await screen.findByTestId("images-banner")
    expect(within(banner).getByText("Images are hidden")).not.toBeNull()
    expect(within(banner).getByTestId("show-images")).not.toBeNull()
    expect(within(banner).getByTestId("allow-sender-images")).not.toBeNull()
    // Blocked: placeholder src, original URL kept only as data attribute.
    const srcdoc = frameSrcdoc()
    expect(srcdoc).toContain("data-original-src")
    expect(srcdoc).toContain("data:image/gif;base64,")
  })

  it("Show images re-renders this message unblocked", async () => {
    const threadId = await seedRemoteImageThread()
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    fireEvent.click(await screen.findByTestId("show-images"))
    await waitFor(() => {
      const srcdoc = frameSrcdoc()
      expect(srcdoc).toContain('src="https://track.example.com/pixel.png"')
      return expect(srcdoc).not.toContain("data-original-src")
    })
    expect(screen.queryByTestId("images-banner")).toBeNull()
  })

  it("Always allow persists to image_allowlist and future opens unblock", async () => {
    const threadId = await seedRemoteImageThread()
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    fireEvent.click(await screen.findByTestId("allow-sender-images"))
    await waitFor(() =>
      expect(screen.queryByTestId("images-banner")).toBeNull()
    )
    // The choice persisted.
    await waitFor(async () => {
      const rows = await executor.select(
        "SELECT sender_email FROM image_allowlist WHERE account_id = $1",
        [accountId]
      )
      expect(rows).toEqual([{ sender_email: "news@example.com" }])
    })

    // Future open of the thread (fresh selection): no banner, images load.
    setSelection(null)
    await screen.findByTestId("thread-empty")
    setSelection(threadId)
    await screen.findByTestId("thread-subject")
    await waitFor(() => {
      const srcdoc = frameSrcdoc()
      expect(srcdoc).toContain('src="https://track.example.com/pixel.png"')
    })
    expect(screen.queryByTestId("images-banner")).toBeNull()
  })

  it("renders an allowlisted sender unblocked without prompting", async () => {
    const threadId = await seedRemoteImageThread()
    await allowSender(executor, accountId, "news@example.com")
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    await screen.findByTestId("thread-subject")
    await waitFor(() => {
      expect(frameSrcdoc()).toContain(
        'src="https://track.example.com/pixel.png"'
      )
    })
    expect(screen.queryByTestId("images-banner")).toBeNull()
  })

  it("renders a text-only message as linkified preformatted text", async () => {
    accountId = "acc-1"
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      [accountId, "gmail", "me@example.com"]
    )
    const threadId = await createThread(executor, accountId, {
      subject: "Plain note",
    })
    const messageId = await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_000_000,
      fromName: "Ada Lovelace",
      fromAddress: "ada@example.com",
      isRead: false,
      bodyText: "line one\nline two https://example.com/docs",
    })
    void messageId
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    await screen.findByTestId("thread-subject")
    const srcdoc = await waitFor(() => {
      const doc = frameSrcdoc()
      expect(doc).toContain("data-emailer-plaintext")
      expect(doc).toContain("line one\nline two")
      return doc
    })
    // 7.4: generated anchors open externally, never in-app.
    expect(srcdoc).toMatch(
      /<a href="https:\/\/example.com\/docs" target="_blank" rel="noopener noreferrer">/
    )
  })
})

describe("task 7.4: link handling", () => {
  it("sanitized html anchors carry target=_blank rel=noopener noreferrer", async () => {
    accountId = "acc-1"
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      [accountId, "gmail", "me@example.com"]
    )
    const threadId = await createThread(executor, accountId, {
      subject: "With links",
    })
    const messageId = await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_000_000,
      fromName: "Ada Lovelace",
      fromAddress: "ada@example.com",
      isRead: false,
    })
    await updateMessage(executor, messageId, {
      bodyHtml: '<p>See <a href="https://example.com/x">the docs</a></p>',
    })
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    const srcdoc = await waitFor(() => {
      const doc = frameSrcdocForTest()
      expect(doc).toContain("https://example.com/x")
      return doc
    })
    expect(srcdoc).toMatch(
      /<a href="https:\/\/example.com\/x" target="_blank" rel="noopener noreferrer">/
    )
    // The frame sandbox lets sanitized target=_blank links out to the OS
    // browser (opener plugin routes http(s) — task 7.4).
    const frame = document.querySelector("iframe")
    expect(frame?.getAttribute("sandbox")).toContain("allow-popups")
  })

  function frameSrcdocForTest(): string {
    const frame = document.querySelector("iframe")
    if (!frame) throw new Error("no email frame rendered")
    return frame.getAttribute("srcdoc") ?? ""
  }
})

describe("task 7.5 UI: attachment list", () => {
  async function seedAttachmentThread(): Promise<{
    threadId: string
    messageId: string
  }> {
    accountId = "acc-1"
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      [accountId, "gmail", "me@example.com"]
    )
    const threadId = await createThread(executor, accountId, {
      subject: "With attachment",
    })
    const messageId = await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_000_000,
      fromName: "Ada Lovelace",
      fromAddress: "ada@example.com",
      isRead: false,
      hasAttachments: true,
      attachments: [
        {
          id: "att-1",
          filename: "report.pdf",
          mimeType: "application/pdf",
          size: 2048,
        },
      ],
    })
    return { threadId, messageId }
  }

  it("renders filename, human size and wires save/open", async () => {
    const { threadId, messageId } = await seedAttachmentThread()
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    const item = await screen.findByTestId("attachment-item")
    expect(within(item).getByText("report.pdf")).not.toBeNull()
    expect(within(item).getByText("2.0 KB")).not.toBeNull()

    // Open: content service receives (executor, account, message, attachment).
    fireEvent.click(within(item).getByTestId("attachment-open"))
    await waitFor(() =>
      expect(attachmentsService.openAttachment).toHaveBeenCalledTimes(1)
    )
    const openArgs = attachmentsService.openAttachment.mock.calls[0]
    expect(openArgs[0]).toBe(executor)
    expect(openArgs[1]).toMatchObject({ id: accountId, type: "gmail" })
    expect(openArgs[2]).toMatchObject({ id: messageId })
    expect(openArgs[3]).toMatchObject({ id: "att-1", filename: "report.pdf" })

    // Save: content is fetched first, then handed to the save dialog.
    fireEvent.click(within(item).getByTestId("attachment-save"))
    await waitFor(() =>
      expect(attachmentsService.saveAttachmentAs).toHaveBeenCalledTimes(1)
    )
    expect(attachmentsService.getAttachmentContent).toHaveBeenCalledTimes(1)
    const saveArgs = attachmentsService.saveAttachmentAs.mock.calls[0]
    expect(saveArgs[0]).toMatchObject({ id: "att-1" })
    expect(saveArgs[1]).toBeInstanceOf(Uint8Array)
  })
})

describe("toolbar actions (task 7 wiring)", () => {
  async function seedSimpleThread(): Promise<string> {
    accountId = "acc-1"
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      [accountId, "gmail", "me@example.com"]
    )
    const threadId = await createThread(executor, accountId, {
      subject: "Actionable",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_000_000,
      fromName: "Ada Lovelace",
      fromAddress: "ada@example.com",
      isRead: true,
    })
    return threadId
  }

  it("archive, trash, star and mark-unread call the thread actions", async () => {
    const threadId = await seedSimpleThread()
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    fireEvent.click(screen.getByTestId("toolbar-archive"))
    await waitFor(() =>
      expect(threadActions.archiveThread).toHaveBeenCalledTimes(1)
    )
    expect(threadActions.archiveThread).toHaveBeenCalledWith(
      executor,
      accountId,
      threadId
    )

    fireEvent.click(screen.getByTestId("toolbar-trash"))
    await waitFor(() =>
      expect(threadActions.trashThread).toHaveBeenCalledTimes(1)
    )
    expect(threadActions.trashThread).toHaveBeenCalledWith(
      executor,
      accountId,
      threadId
    )

    fireEvent.click(screen.getByTestId("toolbar-star"))
    await waitFor(() =>
      expect(threadActions.setThreadStarred).toHaveBeenCalledTimes(1)
    )
    expect(threadActions.setThreadStarred).toHaveBeenCalledWith(
      executor,
      accountId,
      threadId,
      true
    )

    // Thread is read → the toggle offers "mark as unread".
    const unreadButton = await screen.findByTitle("Mark as unread")
    fireEvent.click(unreadButton)
    await waitFor(() =>
      expect(threadActions.setThreadRead).toHaveBeenCalledTimes(1)
    )
    expect(threadActions.setThreadRead).toHaveBeenCalledWith(
      executor,
      accountId,
      threadId,
      false
    )
  })

  it("actions on a thread from another account target the owning account (task 9.2)", async () => {
    // Unified-inbox scenario: the active account stays acc-1 while the
    // open thread belongs to acc-2. The loaded thread's own account_id is
    // authoritative — before the fix the pane refused the mismatch
    // ("Message not found") and the toolbar would have acted as acc-1,
    // which the account-scoped services refuse.
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      ["acc-2", "gmail", "acc-2@example.com"]
    )
    const threadId = await createThread(executor, "acc-2", {
      subject: "Cross-account thread",
    })
    await createMessage(executor, {
      threadId,
      accountId: "acc-2",
      date: 1_700_000_000,
      fromName: "Ada Lovelace",
      fromAddress: "ada@example.com",
      isRead: false,
    })
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: "acc-1" })
    await openThread(threadId)

    // The foreign thread renders instead of the mismatch not-found state.
    expect(screen.getByTestId("thread-subject").textContent).toContain(
      "Cross-account thread"
    )
    // Mark-read-on-open runs as the owning account too.
    await waitFor(() =>
      expect(threadActions.setThreadRead).toHaveBeenCalledWith(
        executor,
        "acc-2",
        threadId,
        true
      )
    )
    // And the toolbar archive.
    fireEvent.click(screen.getByTestId("toolbar-archive"))
    await waitFor(() =>
      expect(threadActions.archiveThread).toHaveBeenCalledTimes(1)
    )
    expect(threadActions.archiveThread).toHaveBeenCalledWith(
      executor,
      "acc-2",
      threadId
    )
  })

  it("toolbar buttons are disabled while an action is in flight", async () => {
    const threadId = await seedSimpleThread()
    // A never-settling archive keeps the mutation pending (once only).
    threadActions.archiveThread.mockReturnValueOnce(new Promise<void>(() => {}))
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    fireEvent.click(screen.getByTestId("toolbar-archive"))
    await waitFor(() =>
      expect(
        (screen.getByTestId("toolbar-trash") as HTMLButtonElement).disabled
      ).toBe(true)
    )
    expect(
      (screen.getByTestId("toolbar-archive") as HTMLButtonElement).disabled
    ).toBe(true)
    expect(
      (screen.getByTestId("toolbar-reply") as HTMLButtonElement).disabled
    ).toBe(true)
    // The task 3.3 state buttons share the same in-flight guard.
    expect(
      (screen.getByTestId("toolbar-mute") as HTMLButtonElement).disabled
    ).toBe(true)
    expect(
      (screen.getByTestId("toolbar-pin") as HTMLButtonElement).disabled
    ).toBe(true)
    expect(
      (screen.getByTestId("toolbar-done") as HTMLButtonElement).disabled
    ).toBe(true)
  })
})

describe("thread-state toolbar buttons (task 3.3)", () => {
  async function seedStateThread(): Promise<string> {
    accountId = "acc-1"
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      [accountId, "gmail", "me@example.com"]
    )
    const threadId = await createThread(executor, accountId, {
      subject: "Stateful",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_000_000,
      fromName: "Ada Lovelace",
      fromAddress: "ada@example.com",
      isRead: true,
    })
    return threadId
  }

  /** Wait for the shared flow's pendingAction guard to release (the
   * buttons re-enable only after the post-action refreshes settle), so a
   * follow-up click is not swallowed. */
  async function awaitIdle(testId: string): Promise<void> {
    await waitFor(() =>
      expect((screen.getByTestId(testId) as HTMLButtonElement).disabled).toBe(
        false
      )
    )
  }

  it("mute, pin and done call the local-state services for the open thread", async () => {
    const threadId = await seedStateThread()
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    fireEvent.click(screen.getByTestId("toolbar-mute"))
    await waitFor(() =>
      expect(threadStates.muteThread).toHaveBeenCalledTimes(1)
    )
    expect(threadStates.muteThread).toHaveBeenCalledWith(executor, threadId)
    expect(toastMock.success).toHaveBeenCalledWith("Muted")
    // Success flips the button to its inverse.
    expect(screen.getByTitle("Unmute thread")).not.toBeNull()
    await awaitIdle("toolbar-mute")

    fireEvent.click(screen.getByTestId("toolbar-pin"))
    await waitFor(() => expect(threadStates.pinThread).toHaveBeenCalledTimes(1))
    expect(threadStates.pinThread).toHaveBeenCalledWith(executor, threadId)
    await awaitIdle("toolbar-pin")

    fireEvent.click(screen.getByTestId("toolbar-done"))
    await waitFor(() =>
      expect(threadStates.markThreadDone).toHaveBeenCalledTimes(1)
    )
    expect(threadStates.markThreadDone).toHaveBeenCalledWith(executor, threadId)
  })

  it("buttons reflect the stored state and their clicks clear it", async () => {
    const threadId = await seedStateThread()
    const now = Math.floor(Date.now() / 1000)
    await executor.execute(
      "UPDATE threads SET muted_at = $1, pinned_at = $2, done_at = $3 WHERE id = $4",
      [now, now, now, threadId]
    )
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    // Titles flip on the loaded thread's state columns.
    expect(screen.getByTitle("Unmute thread")).not.toBeNull()
    expect(screen.getByTitle("Unpin thread")).not.toBeNull()
    expect(screen.getByTitle("Mark not done")).not.toBeNull()

    fireEvent.click(screen.getByTestId("toolbar-mute"))
    await waitFor(() =>
      expect(threadStates.unmuteThread).toHaveBeenCalledWith(executor, threadId)
    )
    await awaitIdle("toolbar-mute")
    fireEvent.click(screen.getByTestId("toolbar-pin"))
    await waitFor(() =>
      expect(threadStates.unpinThread).toHaveBeenCalledWith(executor, threadId)
    )
    await awaitIdle("toolbar-pin")
    fireEvent.click(screen.getByTestId("toolbar-done"))
    await waitFor(() =>
      expect(threadStates.unmarkThreadDone).toHaveBeenCalledWith(
        executor,
        threadId
      )
    )
  })
})

describe("thread notes editor (task 15.1)", () => {
  async function seedNoteThread(): Promise<string> {
    accountId = "acc-1"
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      [accountId, "gmail", "me@example.com"]
    )
    const threadId = await createThread(executor, accountId, {
      subject: "Noteworthy",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_000_000,
      fromName: "Ada Lovelace",
      fromAddress: "ada@example.com",
      isRead: true,
    })
    return threadId
  }

  async function storedNote(threadId: string): Promise<string | null> {
    const rows = await executor.select<{ note: string | null }>(
      "SELECT note FROM threads WHERE id = $1",
      [threadId]
    )
    return rows[0]?.note ?? null
  }

  it("toggle reveals the editor; blur persists the note in the store", async () => {
    const threadId = await seedNoteThread()
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    // No note → the editor is closed; the toolbar opens it.
    expect(screen.queryByTestId("thread-notes")).toBeNull()
    fireEvent.click(screen.getByTestId("toolbar-note"))

    const input = await screen.findByTestId("thread-note-input")
    fireEvent.change(input, { target: { value: "  Approved by legal  " } })
    fireEvent.blur(input)

    // Persisted through the REAL setThreadNote (trimmed) into threads.note.
    await waitFor(() =>
      expect(storedNote(threadId)).resolves.toBe("Approved by legal")
    )
    // The subtle auto-save affordance shows after the write.
    expect(screen.getByTestId("thread-note-saved")).not.toBeNull()
  })

  it("a stored note opens expanded and survives re-open; emptying removes it", async () => {
    const threadId = await seedNoteThread()
    await executor.execute("UPDATE threads SET note = $1 WHERE id = $2", [
      "Call back Thursday",
      threadId,
    ])
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    // The note is visible WITHOUT toggling (spec: shown in the reading
    // pane thereafter).
    const input = await screen.findByTestId("thread-note-input")
    expect((input as HTMLTextAreaElement).value).toBe("Call back Thursday")

    // Emptying the note removes it (service normalizes to NULL).
    fireEvent.change(input, { target: { value: "" } })
    fireEvent.blur(input)
    await waitFor(() => expect(storedNote(threadId)).resolves.toBeNull())
  })

  it("closing the editor flushes a pending edit (debounce has not fired)", async () => {
    const threadId = await seedNoteThread()
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    fireEvent.click(screen.getByTestId("toolbar-note"))
    const input = await screen.findByTestId("thread-note-input")
    fireEvent.change(input, { target: { value: "Typed and closed fast" } })
    // No blur, no debounce wait — the toggle closes (unmounts) the editor,
    // and the flush must land the keystrokes.
    fireEvent.click(screen.getByTestId("toolbar-note"))

    await waitFor(() =>
      expect(storedNote(threadId)).resolves.toBe("Typed and closed fast")
    )
    expect(screen.queryByTestId("thread-notes")).toBeNull()
  })
})

describe("toolbar Add to Todos (task 15.2)", () => {
  async function seedTodoThread(): Promise<string> {
    accountId = "acc-1"
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      [accountId, "gmail", "me@example.com"]
    )
    const threadId = await createThread(executor, accountId, {
      subject: "Needs a reply",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_000_000,
      fromName: "Ada Lovelace",
      fromAddress: "ada@example.com",
      isRead: true,
    })
    return threadId
  }

  it("adds the thread through the shared todos flow and reflects membership", async () => {
    const threadId = await seedTodoThread()
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    const button = screen.getByTestId("toolbar-add-todo")
    expect(button.getAttribute("title")).toBe("Add to Todos")
    fireEvent.click(button)

    // The real flow wrote the todos row and toasted (the sidebar section
    // reloads through the same notify seam its own test asserts).
    await waitFor(() =>
      expect(toastMock.success).toHaveBeenCalledWith("Added to Todos")
    )
    const rows = await executor.select<{ thread_id: string }>(
      "SELECT thread_id FROM todos WHERE completed_at IS NULL"
    )
    expect(rows).toEqual([{ thread_id: threadId }])
    // The button flips to its membership state.
    await waitFor(() =>
      expect(screen.getByTestId("toolbar-add-todo").getAttribute("title")).toBe(
        "In Todos — click to move to the bottom"
      )
    )
  })

  it("a thread already on the list renders the membership state on open", async () => {
    const threadId = await seedTodoThread()
    await executor.execute(
      "INSERT INTO todos (id, account_id, thread_id, position) VALUES ($1, $2, $3, 1)",
      ["todo-seed", accountId, threadId]
    )
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    await waitFor(() =>
      expect(screen.getByTestId("toolbar-add-todo").getAttribute("title")).toBe(
        "In Todos — click to move to the bottom"
      )
    )
  })
})

describe("task 7.6: inline reply affordance", () => {
  /** A read message + a newer unread one addressed to To/Cc participants. */
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
      snippet: "newest unread message preview",
      fromName: "Grace Hopper",
      fromAddress: "grace@example.com",
      isRead: false,
    })
    // SeedMessageOptions carries no cc — address the newest message here.
    await updateMessage(executor, lastMessageId, {
      to: [{ name: "Bob Sample", email: "bob@example.com" }],
      cc: [{ name: "Carol CC", email: "carol@example.com" }],
    })
    return { threadId, lastMessageId }
  }

  async function openReplyThread(): Promise<{
    threadId: string
    lastMessageId: string
  }> {
    const { threadId, lastMessageId } = await seedReplyThread()
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)
    return { threadId, lastMessageId }
  }

  it("renders collapsed, expands to resolved recipients + Re: subject, cancels back", async () => {
    await openReplyThread()

    const opener = screen.getByTestId("inline-reply-open")
    expect(screen.queryByTestId("inline-reply-expanded")).toBeNull()
    fireEvent.click(opener)

    const expanded = screen.getByTestId("inline-reply-expanded")
    // Reply-all is the recipient superset: sender + original To on the To
    // line, original Cc on the Cc line (self excluded).
    const toLine = within(expanded).getByTestId("inline-reply-to")
    expect(within(toLine).getByText(/grace@example\.com/)).not.toBeNull()
    expect(within(toLine).getByText(/bob@example\.com/)).not.toBeNull()
    const ccLine = within(expanded).getByTestId("inline-reply-cc")
    expect(within(ccLine).getByText(/carol@example\.com/)).not.toBeNull()
    expect(
      within(expanded).getByTestId("inline-reply-subject").textContent
    ).toContain("Re: Quarterly report")
    expect(within(expanded).getByText("Opens the full editor")).not.toBeNull()
    expect(within(expanded).getByTestId("inline-reply-send")).not.toBeNull()
    expect(
      within(expanded).getByTestId("inline-reply-reply-all")
    ).not.toBeNull()

    // Cancel collapses back without touching the composer.
    fireEvent.click(within(expanded).getByTestId("inline-reply-cancel"))
    expect(screen.queryByTestId("inline-reply-expanded")).toBeNull()
    expect(screen.getByTestId("inline-reply-open")).not.toBeNull()
    expect(useComposerStore.getState().open).toBe(false)
    expect(useUiStore.getState().composerOpen).toBe(false)
  })

  it("Reply prefills the composer store and flips the composer-open flag", async () => {
    const { threadId, lastMessageId } = await openReplyThread()

    fireEvent.click(screen.getByTestId("inline-reply-open"))
    fireEvent.click(screen.getByTestId("inline-reply-send"))

    // End-to-end prefill path (thread view → composer store): the shell is
    // deliberately NOT mounted — the store contract is what's under test.
    await waitFor(() => expect(useComposerStore.getState().open).toBe(true))
    const composer = useComposerStore.getState()
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

    // The app-level bridge flag for the shell overlay, and the reading
    // view stays mounted behind it.
    expect(useUiStore.getState().composerOpen).toBe(true)
    expect(screen.getByTestId("thread-subject")).not.toBeNull()
  })

  it("Reply all includes the original To and Cc participants", async () => {
    await openReplyThread()

    fireEvent.click(screen.getByTestId("inline-reply-open"))
    fireEvent.click(screen.getByTestId("inline-reply-reply-all"))

    await waitFor(() => expect(useComposerStore.getState().open).toBe(true))
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

  it("toolbar reply uses the same prefill path (reply, not reply-all)", async () => {
    await openReplyThread()

    fireEvent.click(screen.getByTestId("toolbar-reply"))

    await waitFor(() => expect(useComposerStore.getState().open).toBe(true))
    const composer = useComposerStore.getState()
    expect(composer.mode).toMatchObject({ kind: "reply", replyAll: false })
    expect(composer.to.map((recipient) => recipient.email)).toEqual([
      "grace@example.com",
    ])
    expect(composer.subject).toBe("Re: Quarterly report")
    expect(useUiStore.getState().composerOpen).toBe(true)
  })

  it("fetches the account signature and places it above the quoted history", async () => {
    await openReplyThread()
    await setSignature(executor, accountId, "<p>Best, Me</p>")

    fireEvent.click(screen.getByTestId("inline-reply-open"))
    fireEvent.click(screen.getByTestId("inline-reply-send"))

    await waitFor(() => expect(useComposerStore.getState().open).toBe(true))
    const html = useComposerStore.getState().html
    const signatureIndex = html.indexOf("Best, Me")
    const quoteIndex = html.indexOf("<blockquote")
    expect(signatureIndex).toBeGreaterThan(-1)
    expect(quoteIndex).toBeGreaterThan(-1)
    // [signature] above [quoted history] per the placement rule.
    expect(signatureIndex).toBeLessThan(quoteIndex)
  })
})

describe("reading-pane block sender (task 18.2)", () => {
  /** A thread whose sender is blockable: the participants cache (the
   * SAME source the context menu's block item reads) is populated like
   * ingestion does. */
  async function seedBlockableThread(): Promise<string> {
    accountId = "acc-1"
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      [accountId, "gmail", "me@example.com"]
    )
    const threadId = await createThread(executor, accountId, {
      subject: "Suspicious offer",
    })
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_000_000,
      fromName: "Spammy Co",
      fromAddress: "spam@x.com",
      isRead: true,
    })
    await recomputeThreadCaches(executor, threadId)
    return threadId
  }

  it("opens the shared dialog and confirming writes the blocked_senders row", async () => {
    const threadId = await seedBlockableThread()
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    fireEvent.click(screen.getByTestId("toolbar-block-sender"))

    const dialog = await screen.findByTestId("block-sender-dialog")
    expect(within(dialog).getByText("Block spam@x.com")).not.toBeNull()

    // Defaults (Trash, no cleanup) — the confirm runs the shared block
    // flow against the REAL blocklist service (the same wiring the
    // thread list's onBlockSender performs).
    fireEvent.click(screen.getByLabelText("Confirm block spam@x.com"))

    await waitFor(async () => {
      const rows = await listBlockedSenders(executor, accountId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ sender: "spam@x.com", action: "trash" })
    })
    expect(toastMock.success).toHaveBeenCalledWith("Blocked spam@x.com")
    // The dialog closed on confirm.
    expect(screen.queryByTestId("block-sender-dialog")).toBeNull()
  })

  it("hides the block affordance without a usable cached sender", async () => {
    accountId = "acc-1"
    await executor.execute(
      "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
      [accountId, "gmail", "me@example.com"]
    )
    const threadId = await createThread(executor, accountId)
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_000_000,
      fromName: "Ada Lovelace",
      fromAddress: "ada@example.com",
      isRead: true,
    })
    // No recomputeThreadCaches — the participants cache stays empty, the
    // same condition under which the context menu omits the item.
    render(<ThreadView />)
    useAccountStore.setState({ activeAccountId: accountId })
    await openThread(threadId)

    expect(screen.queryByTestId("toolbar-block-sender")).toBeNull()
    expect(screen.queryByTestId("block-sender-dialog")).toBeNull()
  })
})
