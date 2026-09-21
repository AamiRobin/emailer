import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import type { SqlExecutor } from "@/services/db/executor"
import {
  createAccount,
  createGmailLabel,
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import {
  getThread,
  recomputeThreadCaches,
  setThreadLabels,
} from "@/services/db/threads"
import type { ThreadRow } from "@/services/db/threads"
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
import { toast } from "sonner"
import { ThreadView } from "../thread-view"
import { ContextMenuTrigger } from "@/components/ui/context-menu"
import {
  ThreadContextMenu,
  type ThreadMenuHandlers,
} from "../thread-context-menu"

const toastMock = vi.mocked(toast)

/**
 * Task-from-email conversion tests (task 5.7, tasks spec "Task from
 * email"). The conversion entries (reading-pane toolbar button + thread
 * context menu item) run against the REAL tasks service over a seeded
 * node:sqlite database — the executor module is mocked to hand back the
 * test executor, the same seam the thread-view / thread-context-menu
 * suites use. The thread-action services are mocked at their seams (the
 * reading pane's mark-read-on-open runs there, so the cached unread
 * column stays as seeded).
 *
 * The spec assertion under everything: converting creates the linked
 * task and the source thread's INBOX STATE IS UNTOUCHED — unread cache,
 * folder membership, flags, local states all compared before/after.
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
  archiveThread: vi.fn<(...args: unknown[]) => Promise<void>>(),
  trashThread: vi.fn<(...args: unknown[]) => Promise<void>>(),
  setThreadStarred: vi.fn<(...args: unknown[]) => Promise<void>>(),
  setThreadRead: vi.fn<(...args: unknown[]) => Promise<void>>(),
  ThreadNotFoundError: class ThreadNotFoundError extends Error {},
}))

vi.mock("@/services/email-actions/thread-actions", () => threadActions)

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

let executor: TestExecutor
let accountId: string

/** A snippet long enough to prove the notes cap (TASK_NOTES_CAP = 200). */
const LONG_SNIPPET = "Latest status: ".padEnd(260, "x")

/** The thread state the conversion must never touch. */
interface ThreadSnapshot {
  subject: string | null
  unread_count: number
  is_starred: number
  is_archived: number
  is_trashed: number
  is_spam: number
  snoozed_until: number | null
  muted_at: number | null
  pinned_at: number | null
  done_at: number | null
  folder_label_id: string | null
}

async function snapshotThread(
  threadId: string
): Promise<ThreadSnapshot | undefined> {
  const rows = await executor.select<ThreadSnapshot>(
    `SELECT subject, unread_count, is_starred, is_archived, is_trashed,
            is_spam, snoozed_until, muted_at, pinned_at, done_at,
            folder_label_id
     FROM threads WHERE id = $1`,
    [threadId]
  )
  return rows[0]
}

async function threadLabels(threadId: string): Promise<string[]> {
  const rows = await executor.select<{ label_id: string }>(
    "SELECT label_id FROM thread_labels WHERE thread_id = $1 ORDER BY label_id",
    [threadId]
  )
  return rows.map((row) => row.label_id)
}

async function messageReadState(
  threadId: string
): Promise<Array<{ id: string; is_read: number }>> {
  return executor.select(
    "SELECT id, is_read FROM messages WHERE thread_id = $1 ORDER BY id",
    [threadId]
  )
}

/**
 * An inbox thread with a read + a newer UNREAD message (the unread cache
 * populated like ingestion does) — the newest message is the conversion's
 * source_message_id and snippet donor.
 */
async function seedInboxThread(): Promise<{
  threadId: string
  newestMessageId: string
}> {
  accountId = await createAccount(executor, "gmail")
  const inbox = await createGmailLabel(
    executor,
    accountId,
    "INBOX",
    "INBOX",
    "inbox"
  )
  const threadId = await createThread(executor, accountId, {
    subject: "Quarterly report",
  })
  await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_000_000,
    subject: "Quarterly report",
    snippet: "earlier read message preview",
    isRead: true,
  })
  const newestMessageId = await createMessage(executor, {
    threadId,
    accountId,
    date: 1_700_000_000 + 3600,
    subject: "Re: Quarterly report",
    snippet: LONG_SNIPPET,
    isRead: false,
  })
  await recomputeThreadCaches(executor, threadId)
  await setThreadLabels(executor, threadId, [inbox])
  return { threadId, newestMessageId }
}

function resetStores(): void {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    sidebarCollapsed: false,
    composerOpen: false,
    activeThread: null,
    readingPane: "right",
  })
  useAccountStore.setState({
    accounts: [],
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
  threadActions.setThreadRead.mockResolvedValue()
  threadActions.archiveThread.mockResolvedValue()
  threadActions.trashThread.mockResolvedValue()
  threadActions.setThreadStarred.mockResolvedValue()
})

afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  cleanup()
  setThreadListStoreExecutor(null)
  setAccountStoreExecutor(null)
  setFolderCountsStoreExecutor(null)
  executorHolder.current = null
  executor.close()
  resetStores()
})

/** The conversion's durable effects, asserted the same way everywhere. */
async function expectTaskRow(options: {
  threadId: string
  title: string
  newestMessageId: string
  notes: string
}): Promise<void> {
  const rows = await executor.select<{
    title: string
    notes: string | null
    origin: string
    source_thread_id: string | null
    source_message_id: string | null
    source_account_id: string | null
    completed_at: number | null
  }>("SELECT title, notes, origin, source_thread_id, source_message_id, source_account_id, completed_at FROM tasks")
  expect(rows).toHaveLength(1)
  const row = rows[0]
  expect(row.title).toBe(options.title)
  expect(row.origin).toBe("email")
  expect(row.source_thread_id).toBe(options.threadId)
  expect(row.source_message_id).toBe(options.newestMessageId)
  expect(row.source_account_id).toBe(accountId)
  expect(row.completed_at).toBeNull()
  expect(row.notes).toBe(options.notes)
}

async function expectThreadUntouched(
  threadId: string,
  before: ThreadSnapshot | undefined,
  labelsBefore: string[],
  messagesBefore: Array<{ id: string; is_read: number }>
): Promise<void> {
  expect(await snapshotThread(threadId)).toEqual(before)
  expect(await threadLabels(threadId)).toEqual(labelsBefore)
  expect(await messageReadState(threadId)).toEqual(messagesBefore)
}

describe("reading-pane Create task (task 5.7)", () => {
  it("opens the prefilled dialog, creates the linked task and leaves the thread untouched", async () => {
    const { threadId, newestMessageId } = await seedInboxThread()
    const before = await snapshotThread(threadId)
    const labelsBefore = await threadLabels(threadId)
    const messagesBefore = await messageReadState(threadId)
    useAccountStore.setState({ activeAccountId: accountId })

    render(<ThreadView />)
    useUiStore.setState({ activeThread: threadId })
    await screen.findByTestId("thread-subject")

    fireEvent.click(screen.getByTestId("toolbar-create-task"))

    await screen.findByTestId("create-task-dialog")
    // The prefill: thread subject as the title, the NEWEST message's
    // snippet (capped) as the notes.
    const titleInput = (await screen.findByTestId(
      "create-task-title"
    )) as HTMLInputElement
    expect(titleInput.value).toBe("Quarterly report")
    const notesInput = (await screen.findByTestId(
      "create-task-notes"
    )) as HTMLTextAreaElement
    expect(notesInput.value).toBe(LONG_SNIPPET.slice(0, 200))
    expect(notesInput.value.length).toBe(200)

    // The spec's "confirms the prefilled title" — an edit is allowed.
    fireEvent.change(titleInput, {
      target: { value: "File the quarterly report" },
    })
    // An emptied title disables the confirm (the service rejects those).
    fireEvent.change(titleInput, { target: { value: "  " } })
    expect(
      (screen.getByTestId("create-task-confirm") as HTMLButtonElement)
        .disabled
    ).toBe(true)
    fireEvent.change(titleInput, {
      target: { value: "File the quarterly report" },
    })
    fireEvent.click(screen.getByTestId("create-task-confirm"))

    await waitFor(() =>
      expect(screen.queryByTestId("create-task-dialog")).toBeNull()
    )
    await expectTaskRow({
      threadId,
      title: "File the quarterly report",
      newestMessageId,
      notes: LONG_SNIPPET.slice(0, 200),
    })
    // Spec: "the message stays in the inbox untouched".
    await expectThreadUntouched(
      threadId,
      before,
      labelsBefore,
      messagesBefore
    )
    // The toast carries the completion confirmation.
    expect(toastMock.success).toHaveBeenCalledWith(
      "Task created",
      expect.objectContaining({ action: expect.anything() })
    )
  })

  it("cancel creates nothing", async () => {
    const { threadId } = await seedInboxThread()
    useAccountStore.setState({ activeAccountId: accountId })
    render(<ThreadView />)
    useUiStore.setState({ activeThread: threadId })
    await screen.findByTestId("thread-subject")

    fireEvent.click(screen.getByTestId("toolbar-create-task"))
    await screen.findByTestId("create-task-dialog")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    await waitFor(() =>
      expect(screen.queryByTestId("create-task-dialog")).toBeNull()
    )
    expect(await executor.select("SELECT id FROM tasks")).toHaveLength(0)
  })
})

describe("context-menu Create task (task 5.7)", () => {
  const handlers: ThreadMenuHandlers = {
    onOpen: vi.fn(),
    onReply: vi.fn(),
    onAction: vi.fn(),
    onToggleLabel: vi.fn(),
    onSnooze: vi.fn(),
    onThreadState: vi.fn(),
    onBlockSender: vi.fn(),
  }

  function renderMenu(thread: ThreadRow) {
    return render(
      <ThreadContextMenu
        thread={thread}
        targetIds={[thread.id]}
        userLabels={[]}
        memberLabelIds={[]}
        handlers={handlers}
      >
        <ContextMenuTrigger render={<button data-testid="row-trigger" />}>
          row
        </ContextMenuTrigger>
      </ThreadContextMenu>
    )
  }

  it("creates the linked task from the menu and leaves the thread untouched", async () => {
    const { threadId, newestMessageId } = await seedInboxThread()
    const thread = await getThread(executor, threadId)
    if (!thread) throw new Error("seed failed")
    const before = await snapshotThread(threadId)
    const labelsBefore = await threadLabels(threadId)
    const messagesBefore = await messageReadState(threadId)

    renderMenu(thread)
    fireEvent.contextMenu(screen.getByTestId("row-trigger"), {
      clientX: 8,
      clientY: 8,
    })
    await waitFor(() =>
      expect(screen.queryByRole("menu", { hidden: true })).not.toBeNull()
    )

    fireEvent.click(screen.getByTestId("menu-create-task"))

    const titleInput = (await screen.findByTestId(
      "create-task-title"
    )) as HTMLInputElement
    expect(titleInput.value).toBe("Quarterly report")
    fireEvent.click(screen.getByTestId("create-task-confirm"))

    await waitFor(() =>
      expect(screen.queryByTestId("create-task-dialog")).toBeNull()
    )
    await expectTaskRow({
      threadId,
      title: "Quarterly report",
      newestMessageId,
      notes: LONG_SNIPPET.slice(0, 200),
    })
    await expectThreadUntouched(
      threadId,
      before,
      labelsBefore,
      messagesBefore
    )
  })
})
