import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

import type { SqlExecutor } from "@/services/db/executor"

/**
 * Block-sender UI tests (task 18.2). Same executor-injection pattern as
 * the settings suites: the executor module is mocked to hand the dialog's
 * count fetch the shared seeded node:sqlite executor, while the confirm
 * path runs the REAL blocklist/cleanup services against it (the same
 * wiring the thread list's onBlockSender handler performs). The menu
 * renders directly with the handler under test — the full-list harnesses
 * (thread-multi-select et al.) cover the menu plumbing.
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
  applyBlockToExistingMail,
  blockSender,
  listBlockedSenders,
  type BlockedSenderAction,
} from "@/services/db/blocked-senders"
import { recomputeThreadCaches, setThreadLabels } from "@/services/db/threads"
import type { ThreadRow } from "@/services/db/threads"
import { ContextMenuTrigger } from "@/components/ui/context-menu"
import { BlockSenderDialog } from "../block-sender-dialog"
import {
  ThreadContextMenu,
  type ThreadMenuHandlers,
} from "../thread-context-menu"

let executor: TestExecutor
let accountId: string

function makeThreadRow(overrides?: {
  participants?: string | null
  account_id?: string
}): ThreadRow {
  return {
    id: "thread-1",
    account_id: accountId,
    subject: "Hello",
    snippet: null,
    first_message_at: 100,
    last_message_at: 100,
    message_count: 1,
    unread_count: 1,
    has_attachments: 0,
    is_starred: 0,
    // An EXPLICIT null override must not fall back to the default sender.
    participants:
      overrides && "participants" in overrides
        ? (overrides.participants as string | null)
        : JSON.stringify([{ name: "Spam", email: "spam@x.com" }]),
    gmail_thread_id: null,
    folder_label_id: null,
    is_archived: 0,
    is_trashed: 0,
    is_spam: 0,
    created_at: 100,
  }
}

const noopHandlers = {
  onOpen: vi.fn(),
  onReply: vi.fn(),
  onAction: vi.fn(),
  onToggleLabel: vi.fn(),
  onSnooze: vi.fn(),
  onThreadState: vi.fn(),
  onBlockSender: vi.fn(),
} as unknown as ThreadMenuHandlers & {
  onBlockSender: ReturnType<typeof vi.fn>
}

function renderMenu(
  thread: ThreadRow,
  handlers: ThreadMenuHandlers = noopHandlers
) {
  return render(
    <ThreadContextMenu
      thread={thread}
      targetIds={[thread.id]}
      userLabels={[]}
      memberLabelIds={[]}
      handlers={handlers}
    >
      {/* Same trigger wiring as a thread row (the list renders the row
          div through ContextMenuTrigger's render prop). */}
      <ContextMenuTrigger render={<button data-testid="row-trigger" />}>
        row
      </ContextMenuTrigger>
    </ThreadContextMenu>
  )
}

async function openMenu() {
  fireEvent.contextMenu(screen.getByTestId("row-trigger"), {
    clientX: 8,
    clientY: 8,
  })
  await waitFor(() =>
    expect(screen.queryByRole("menu", { hidden: true })).not.toBeNull()
  )
}

beforeEach(async () => {
  executor = createTestExecutor()
  executorHolder.current = executor
  accountId = await createAccount(executor, "gmail")
})

afterEach(() => {
  cleanup()
  executorHolder.current = null
  executor.close()
  vi.clearAllMocks()
})

describe("BlockSenderDialog", () => {
  it("fetches the existing-conversation count when it opens", async () => {
    for (let i = 0; i < 2; i += 1) {
      const threadId = await createThread(executor, accountId)
      await createMessage(executor, {
        threadId,
        accountId,
        date: 100 + i,
        fromAddress: "spam@x.com",
      })
      await recomputeThreadCaches(executor, threadId)
      const inbox = await executor.select<{ id: string }>(
        "SELECT id FROM labels WHERE account_id = $1 AND special_use = 'inbox'",
        [accountId]
      )
      const inboxId =
        inbox[0]?.id ??
        (await createGmailLabel(executor, accountId, "INBOX", "INBOX", "inbox"))
      await setThreadLabels(executor, threadId, [inboxId])
    }

    const onConfirm = vi.fn()
    render(
      <BlockSenderDialog
        sender="spam@x.com"
        accountId={accountId}
        open
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />
    )

    // The offer is numbered from the pre-block inbox residency.
    expect(
      await screen.findByText(
        "Also move 2 existing conversations from this sender"
      )
    ).toBeTruthy()
    expect(screen.getByLabelText("Confirm block spam@x.com")).toBeTruthy()
  })

  it("confirms with the chosen action and cleanup choice", async () => {
    const onConfirm = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <BlockSenderDialog
        sender="spam@x.com"
        accountId={accountId}
        open
        onOpenChange={onOpenChange}
        onConfirm={onConfirm}
      />
    )

    await screen.findByTestId("block-sender-dialog")
    // Default: Trash, no cleanup.
    fireEvent.click(screen.getByLabelText("Confirm block spam@x.com"))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("trash", false))

    // Re-open behavior is the parent's concern; drive the archive + cleanup path.
    fireEvent.click(screen.getByLabelText("Archived"))
    fireEvent.click(screen.getByRole("checkbox", { name: /Also move/ }))
    fireEvent.click(screen.getByLabelText("Confirm block spam@x.com"))
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith("archive", true))
  })
})

describe("thread context menu block flow", () => {
  it("offers Block sender and executes blocklist write + cleanup through the services", async () => {
    // Two existing inbox conversations from the sender: the cleanup target.
    const threadIds: string[] = []
    for (let i = 0; i < 2; i += 1) {
      const threadId = await createThread(executor, accountId)
      threadIds.push(threadId)
      await createMessage(executor, {
        threadId,
        accountId,
        date: 100 + i,
        fromAddress: "spam@x.com",
        // The queued cleanup ops carry provider refs (message-refs.ts).
        gmailMessageId: `gm-${i}`,
      })
      await recomputeThreadCaches(executor, threadId)
      const inbox = await executor.select<{ id: string }>(
        "SELECT id FROM labels WHERE account_id = $1 AND special_use = 'inbox'",
        [accountId]
      )
      const inboxId =
        inbox[0]?.id ??
        (await createGmailLabel(executor, accountId, "INBOX", "INBOX", "inbox"))
      await setThreadLabels(executor, threadId, [inboxId])
    }

    // The SAME wiring as thread-list's blockSenderFromList.
    const onBlockSender = vi.fn(
      (
        blockAccountId: string,
        sender: string,
        action: BlockedSenderAction,
        applyToExisting: boolean
      ) => {
        void (async () => {
          await blockSender(executor, blockAccountId, { sender, action })
          if (applyToExisting) {
            await applyBlockToExistingMail(
              executor,
              blockAccountId,
              sender,
              action
            )
          }
        })()
      }
    )
    const handlers = { ...noopHandlers, onBlockSender }

    renderMenu(makeThreadRow(), handlers)
    await openMenu()

    fireEvent.click(screen.getByText("Block sender"))
    await screen.findByTestId("block-sender-dialog")
    expect(screen.getByText("Block spam@x.com")).toBeTruthy()

    // Numbered offer from the seeded inbox residency, cleanup checked, archive.
    fireEvent.click(
      await screen.findByRole("checkbox", { name: /Also move 2 existing/ })
    )
    fireEvent.click(screen.getByLabelText("Archived"))
    fireEvent.click(screen.getByLabelText("Confirm block spam@x.com"))

    await waitFor(async () => {
      const rows = await listBlockedSenders(executor, accountId)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ sender: "spam@x.com", action: "archive" })
    })
    // The cleanup filed the sender's existing inbox conversations…
    for (const threadId of threadIds) {
      const rows = await executor.select<{ is_archived: number }>(
        "SELECT is_archived FROM threads WHERE id = $1",
        [threadId]
      )
      expect(rows[0]).toMatchObject({ is_archived: 1 })
    }
    // …and the handler received the thread's owning account.
    expect(onBlockSender).toHaveBeenCalledWith(
      accountId,
      "spam@x.com",
      "archive",
      true
    )
  })

  it("hides the Block sender item for threads without a usable sender", async () => {
    renderMenu(makeThreadRow({ participants: null }))
    await openMenu()
    expect(screen.queryByText("Block sender")).toBeNull()
  })
})
