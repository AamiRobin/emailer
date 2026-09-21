import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

/**
 * Quick-step run-with-confirm tests (task 3.2): the shared runner every
 * run affordance (context menu, palette, digit shortcut) goes through.
 * Real service stack against the seeded node:sqlite database (executor
 * module mocked to the holder, like thread-context-menu.test.tsx) — the
 * confirm-once contract is asserted through REAL state: the thread rows
 * after each run and the persisted destructive-confirmation flag.
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

import { toast } from "sonner"

import { createTestExecutor, type TestExecutor } from "@/services/db/__tests__/test-executor"
import {
  createAccount,
  createGmailLabel,
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import { recomputeThreadCaches, setThreadLabels } from "@/services/db/threads"
import {
  createQuickStep,
  listQuickSteps,
  shouldConfirmDestructive,
} from "@/services/settings/quick-steps"
import type { QuickStepAction } from "@/services/settings/quick-steps"
import {
  runQuickStepWithConfirm,
} from "../run-with-confirm"
import { QuickStepConfirmHost } from "@/components/email/quick-step-confirm-dialog"

let executor: TestExecutor
let accountId: string
let inboxLabelId: string
let trashLabelId: string
// Below Number.MAX_SAFE_INTEGER (the executor suite's own trick) — larger
// ids lose precision and collide on the gmail_message_id unique index.
let gmailIdSequence = 9_000_000_000_000_000

beforeEach(() => {
  executor = createTestExecutor()
  executorHolder.current = executor
})

afterEach(async () => {
  cleanup()
  executorHolder.current = null
  // Let the runner's fire-and-forget post-run refresh (folder counts)
  // drain before the database closes — its queries are queued behind the
  // assertions above.
  await new Promise((resolve) => setTimeout(resolve, 25))
  executor.close()
  vi.clearAllMocks()
})

/** One gmail account with INBOX + a "Newsletters" user label. */
async function seedAccount(): Promise<string> {
  const id = await createAccount(executor, "gmail")
  inboxLabelId = await createGmailLabel(executor, id, "INBOX", "INBOX", "inbox")
  // Trash action on gmail = add the TRASH label, so one must exist.
  trashLabelId = await createGmailLabel(executor, id, "Trash", "TRASH", "trash")
  await createGmailLabel(
    executor,
    id,
    "Newsletters",
    "Newsletters",
    undefined,
    "user"
  )
  return id
}

/** An unread two-message inbox thread. */
async function seedThread(): Promise<string> {
  const threadId = await createThread(executor, accountId, {
    subject: "Hello",
  })
  await setThreadLabels(executor, threadId, [inboxLabelId])
  const ids = [gmailIdSequence + 1, gmailIdSequence + 2].map(String)
  gmailIdSequence += 2
  let offset = 0
  for (const gmailMessageId of ids) {
    await createMessage(executor, {
      threadId,
      accountId,
      date: 1_700_000_000 + offset,
      gmailMessageId,
      snippet: `body ${offset}`,
    })
    offset += 60
  }
  // unread_count lives on the thread row, derived from its messages.
  await recomputeThreadCaches(executor, threadId)
  return threadId
}

async function threadFlags(
  threadId: string
): Promise<{ unread_count: number }> {
  const rows = await executor.select<{ unread_count: number }>(
    "SELECT unread_count FROM threads WHERE id = $1",
    [threadId]
  )
  return rows[0]!
}

/** Whether the thread carries the gmail TRASH label (what the trash
 * action applies locally). */
async function threadTrashed(threadId: string): Promise<boolean> {
  const rows = await executor.select<{ id: string }>(
    "SELECT label_id AS id FROM thread_labels WHERE thread_id = $1 AND label_id = $2",
    [threadId, trashLabelId]
  )
  return rows.length > 0
}

async function createStep(
  name: string,
  actions: QuickStepAction[]
): Promise<string> {
  const result = await createQuickStep(executor, { name, actions })
  if (!result.ok) throw new Error(`seed step failed: ${result.error}`)
  return result.step.id
}

/** Host rendering: the dialog is mounted exactly like the shell mounts it. */
function renderHost(): void {
  render(<QuickStepConfirmHost />)
}

describe("runQuickStepWithConfirm (task 3.2)", () => {
  it("runs a non-destructive step immediately — no dialog, list state changes", async () => {
    accountId = await seedAccount()
    const threadId = await seedThread()
    const stepName = "Cleanup"
    await createStep(stepName, [
      { kind: "mark_read", read: true },
      { kind: "archive" },
    ])
    renderHost()

    const step = (await listQuickSteps(executor)).find(
      (candidate) => candidate.name === stepName
    )!

    const before = await threadFlags(threadId)
    expect(before.unread_count).toBe(2)

    let ran = false
    await act(async () => {
      ran = await runQuickStepWithConfirm(step, [threadId])
    })

    expect(ran).toBe(true)
    const after = await threadFlags(threadId)
    expect(after.unread_count).toBe(0)
    expect(screen.queryByTestId("quick-step-confirm-dialog")).toBeNull()
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining(`"${stepName}" applied to 1 thread`)
    )
  })

  it("the FIRST trash run asks: cancel leaves mail untouched and unconfirmed", async () => {
    accountId = await seedAccount()
    const threadId = await seedThread()
    const stepName = "Toss"
    await createStep(stepName, [
      { kind: "mark_read", read: true },
      { kind: "trash" },
    ])
    renderHost()

    const step = (await listQuickSteps(executor)).find(
      (candidate) => candidate.name === stepName
    )!

    let ran: boolean | undefined
    act(() => {
      void runQuickStepWithConfirm(step, [threadId]).then((value) => {
        ran = value
      })
    })

    // The gate: the dialog names the step and the target count.
    const dialog = await screen.findByTestId("quick-step-confirm-dialog")
    await waitFor(() => {
      expect(dialog.textContent).toContain(stepName)
    })
    expect(dialog.textContent).toContain("1 thread")

    // Cancel: nothing ran, nothing remembered.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(ran).toBe(false))
    expect(await threadTrashed(threadId)).toBe(false)
    expect((await threadFlags(threadId)).unread_count).toBe(2)
    expect(await shouldConfirmDestructive(executor)).toBe(true)
  })

  it("confirming with Don't-ask-again runs the chain AND remembers the answer", async () => {
    accountId = await seedAccount()
    const threadId = await seedThread()
    const stepName = "Toss"
    await createStep(stepName, [
      { kind: "mark_read", read: true },
      { kind: "trash" },
    ])
    renderHost()

    const step = (await listQuickSteps(executor)).find(
      (candidate) => candidate.name === stepName
    )!

    let ran = false
    act(() => {
      void runQuickStepWithConfirm(step, [threadId]).then((value) => {
        ran = value
      })
    })

    await screen.findByTestId("quick-step-confirm-dialog")
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByRole("button", { name: "Run" }))

    await waitFor(() => expect(ran).toBe(true))
    // The whole chain applied, in order.
    const flags = await threadFlags(threadId)
    expect(flags.unread_count).toBe(0)
    expect(await threadTrashed(threadId)).toBe(true)
    // The confirm-once memory is persisted.
    await waitFor(async () => {
      expect(await shouldConfirmDestructive(executor)).toBe(false)
    })
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining(`"${stepName}" applied to 1 thread`)
    )
  })

  it("a LATER destructive run is confirmation-free (one confirmation total)", async () => {
    accountId = await seedAccount()
    const first = await seedThread()
    const second = await seedThread()
    const stepName = "Toss"
    await createStep(stepName, [
      { kind: "mark_read", read: true },
      { kind: "trash" },
    ])
    renderHost()

    const step = (await listQuickSteps(executor)).find(
      (candidate) => candidate.name === stepName
    )!

    // First run: confirm WITH "Don't ask again" — the flag is the
    // memory, and it is only committed through the checkbox.
    let firstRun = false
    act(() => {
      void runQuickStepWithConfirm(step, [first]).then((value) => {
        firstRun = value
      })
    })
    await screen.findByTestId("quick-step-confirm-dialog")
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(screen.getByRole("button", { name: "Run" }))
    await waitFor(() => expect(firstRun).toBe(true))
    await waitFor(async () => {
      expect(await shouldConfirmDestructive(executor)).toBe(false)
    })

    // Second run — a DIFFERENT thread: no dialog, straight through.
    let secondRun = false
    act(() => {
      void runQuickStepWithConfirm(step, [second]).then((value) => {
        secondRun = value
      })
    })
    await waitFor(() => expect(secondRun).toBe(true))
    expect(screen.queryByTestId("quick-step-confirm-dialog")).toBeNull()
    expect(await threadTrashed(second)).toBe(true)
  })

  it("summarizes a multi-thread run and no-ops on an empty target list", async () => {
    accountId = await seedAccount()
    const first = await seedThread()
    const second = await seedThread()
    const stepName = "Cleanup"
    await createStep(stepName, [
      { kind: "mark_read", read: true },
      { kind: "archive" },
    ])
    renderHost()

    const step = (await listQuickSteps(executor)).find(
      (candidate) => candidate.name === stepName
    )!

    // The spec scenario: five threads (three here — same code path) with
    // ONE confirmation-free action over the whole selection.
    const third = await seedThread()
    let ran = false
    await act(async () => {
      ran = await runQuickStepWithConfirm(step, [first, second, third])
    })
    expect(ran).toBe(true)
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining(`"${stepName}" applied to 3 threads`)
    )
    for (const threadId of [first, second, third]) {
      expect((await threadFlags(threadId)).unread_count).toBe(0)
    }

    // Empty targets: nothing runs, nothing toasts.
    vi.mocked(toast.success).mockClear()
    ran = await runQuickStepWithConfirm(step, [])
    expect(ran).toBe(false)
    expect(toast.success).not.toHaveBeenCalled()
  })
})
