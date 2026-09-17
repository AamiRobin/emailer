import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

/**
 * Thread context menu tests (task 19.1's entry point). Same
 * executor-injection pattern as block-sender.test.tsx: the executor
 * module is mocked to hand the Export as EML flow the shared seeded
 * node:sqlite executor, while the REAL export service runs against it —
 * only the Tauri plugins (directory dialog, file writes) are fakes.
 */

const executorHolder = vi.hoisted(() => ({
  current: null as unknown,
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

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn(async () => null),
  save: vi.fn(async () => null),
  ask: vi.fn(async () => false),
}))

vi.mock("@tauri-apps/plugin-fs", () => ({
  open: vi.fn(async () => {
    throw new Error("file handles not expected here")
  }),
  remove: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  readFile: vi.fn(async () => new Uint8Array()),
  writeFile: vi.fn(async () => undefined),
}))

vi.mock("@tauri-apps/api/path", () => ({
  join: vi.fn(async (...segments: string[]) => segments.join("/")),
}))

import { toast } from "sonner"
import { open as openFileDialogMock } from "@tauri-apps/plugin-dialog"
import { writeFile as fsWriteFileMock } from "@tauri-apps/plugin-fs"

import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import type { MessageInput } from "@/services/db/messages"
import { insertMessage } from "@/services/db/messages"
import { insertThread } from "@/services/db/threads"
import { ContextMenuTrigger } from "@/components/ui/context-menu"
import {
  ThreadContextMenu,
  type ThreadMenuHandlers,
} from "../thread-context-menu"

let executor: TestExecutor
let accountId: string

function makeThreadRow(): Parameters<typeof ThreadContextMenu>[0]["thread"] {
  return {
    id: "thread-1",
    account_id: accountId,
    subject: "Hello",
    snippet: null,
    first_message_at: 100,
    last_message_at: 100,
    message_count: 1,
    unread_count: 0,
    has_attachments: 0,
    is_starred: 0,
    participants: null,
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
} as unknown as ThreadMenuHandlers

function renderMenu() {
  return render(
    <ThreadContextMenu
      thread={makeThreadRow()}
      targetIds={["thread-1"]}
      userLabels={[]}
      memberLabelIds={[]}
      handlers={noopHandlers}
    >
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

async function seedThreadWithMessages(): Promise<void> {
  await insertThread(executor, { id: "thread-1", accountId })
  const inputs: Array<Partial<MessageInput> & { date: number }> = [
    {
      date: 1_700_000_100,
      subject: "Menu export one",
      fromAddress: "a@b.c",
      bodyText: "one",
    },
    {
      date: 1_700_000_200,
      subject: "Menu export two",
      fromAddress: "a@b.c",
      bodyText: "two",
    },
  ]
  for (const input of inputs) {
    await insertMessage(executor, {
      id: `msg-${Math.random().toString(36).slice(2)}`,
      threadId: "thread-1",
      accountId,
      ...input,
    })
  }
}

beforeEach(async () => {
  executor = createTestExecutor()
  executorHolder.current = executor
  accountId = "acc-menu"
  await executor.execute(
    "INSERT INTO accounts (id, type, email) VALUES ($1, $2, $3)",
    [accountId, "gmail", `${accountId}@example.com`]
  )
})

afterEach(() => {
  cleanup()
  executorHolder.current = null
  executor.close()
  vi.clearAllMocks()
})

describe("thread context menu Export as EML (task 19.1)", () => {
  it("offers Export as EML and writes one .eml per message to the picked directory", async () => {
    await seedThreadWithMessages()
    ;(openFileDialogMock as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      "/picked/dir"
    )

    renderMenu()
    await openMenu()
    fireEvent.click(screen.getByText("Export as EML"))

    await waitFor(() => expect(fsWriteFileMock).toHaveBeenCalledTimes(2))
    // vi.mocked: the real module's writeFile type carries no .mock.
    const writes = vi.mocked(fsWriteFileMock).mock.calls
    const paths = writes.map((call) => call[0])
    expect(paths).toEqual([
      "/picked/dir/Menu export one-2023-11-14.eml",
      "/picked/dir/Menu export two-2023-11-14.eml",
    ])
    const first = new TextDecoder().decode(writes[0][1] as Uint8Array)
    expect(first).toContain("Subject: Menu export one")

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining("Exported 2 messages")
      )
    )
  })

  it("stays silent when the user cancels the directory dialog", async () => {
    await seedThreadWithMessages()

    renderMenu()
    await openMenu()
    fireEvent.click(screen.getByText("Export as EML"))

    await waitFor(() => expect(openFileDialogMock).toHaveBeenCalledTimes(1))
    // Let the promise chain settle.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fsWriteFileMock).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("reports a failed export through the error toast", async () => {
    await seedThreadWithMessages()
    ;(openFileDialogMock as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      "/picked/dir"
    )
    ;(fsWriteFileMock as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("disk full")
    )

    renderMenu()
    await openMenu()
    fireEvent.click(screen.getByText("Export as EML"))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("Export failed")
      )
    )
  })
})
