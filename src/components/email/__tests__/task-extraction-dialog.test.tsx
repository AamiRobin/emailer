import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

/**
 * Task-extraction review-dialog tests (task 4.8; real-seam integration
 * added in task 5.8). The extraction service and the task-creation seam
 * are BOTH mocked at their module seams: the assertions target the
 * frozen UI contract — suggestions render for review with pre-checked
 * items, only accepted (checked, unhandled) suggestions reach the seam,
 * the defensive "unavailable" result toasts the frozen message and
 * dismisses the item, and provider errors render inline with Retry. One
 * integration test then routes the seam mock through the REAL
 * `createTaskFromSuggestion` against the real test executor to prove the
 * dialog's accept wiring lands a real task row (task 5.8).
 */

const extractTasksMock = vi.hoisted(() => vi.fn())

vi.mock("@/services/ai/task-extraction", () => ({
  extractTasks: extractTasksMock,
}))

const createTaskFromSuggestionMock = vi.hoisted(() => vi.fn())

// The seam module keeps its real exports (spread over importActual) with
// only the create function swapped for the mock — so the integration
// test below can reinstall the REAL implementation per-test while the
// frozen-contract tests keep the mock.
vi.mock("@/services/tasks/create", async () => {
  const actual = await vi.importActual<
    typeof import("@/services/tasks/create")
  >("@/services/tasks/create")
  return {
    ...actual,
    createTaskFromSuggestion: createTaskFromSuggestionMock,
  }
})

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

import { TaskExtractionDialog } from "../task-extraction-dialog"
import type { TaskSuggestion } from "@/services/ai/task-extraction"
import {
  createAccount,
  createMessage,
  createThread,
} from "@/services/db/__tests__/fixtures"
import {
  createTestExecutor,
  type TestExecutor,
} from "@/services/db/__tests__/test-executor"
import { listOpenTasks } from "@/services/tasks/service"

const THREAD_ID = "thread-1"

function suggestion(overrides: Partial<TaskSuggestion>): TaskSuggestion {
  return {
    title: "Untitled task",
    messageId: `msg-${Math.random()}`,
    messageDate: 1_700_000_000,
    messageFrom: "Alice <alice@example.com>",
    ...overrides,
  }
}

function renderDialog() {
  return render(
    <TaskExtractionDialog
      threadId={THREAD_ID}
      open
      onOpenChange={vi.fn()}
    />
  )
}

beforeEach(() => {
  executorHolder.current = { marker: "test-executor" }
  createTaskFromSuggestionMock.mockResolvedValue({
    ok: false,
    reason: "unavailable",
  })
})

afterEach(() => {
  cleanup()
  executorHolder.current = null
  vi.clearAllMocks()
})

const CHECK_FIRST = 'Include "Send the contract"'
const CHECK_SECOND = 'Include "Book the room"'

const twoSuggestions: TaskSuggestion[] = [
  suggestion({
    title: "Send the contract",
    notes: "To legal first",
    dueAt: Date.UTC(2026, 2, 1) / 1000,
    messageId: "msg-1",
  }),
  suggestion({
    title: "Book the room",
    messageId: "msg-2",
    messageFrom: "Bob <bob@example.com>",
  }),
]

describe("TaskExtractionDialog review list", () => {
  it("renders suggestions with pre-checked boxes, due and source lines", async () => {
    extractTasksMock.mockResolvedValue({ suggestions: twoSuggestions })
    renderDialog()

    expect(await screen.findByText("Send the contract")).toBeTruthy()
    expect(screen.getByText("Book the room")).toBeTruthy()
    expect(screen.getByTestId("task-suggestion-due-0").textContent).toContain(
      "Due Mar 1, 2026"
    )
    expect(
      screen.getByTestId("task-suggestion-source-0").textContent
    ).toContain("From Alice <alice@example.com>")
    // Pre-checked review state + the batch accept button counts them.
    expect(
      screen
        .getByRole("checkbox", { name: CHECK_FIRST })
        .getAttribute("aria-checked")
    ).toBe("true")
    expect(
      screen
        .getByRole("checkbox", { name: CHECK_SECOND })
        .getAttribute("aria-checked")
    ).toBe("true")
    expect(screen.getByTestId("task-extraction-accept").textContent).toBe(
      "Add 2 tasks"
    )
  })

  it("shows the busy state, then the parse warning inline when given", async () => {
    let resolveExtraction: (value: unknown) => void = () => {}
    extractTasksMock.mockReturnValue(
      new Promise((resolve) => {
        resolveExtraction = resolve
      })
    )
    renderDialog()

    expect(screen.getByTestId("task-extraction-busy")).toBeTruthy()
    resolveExtraction({
      suggestions: [],
      warning: "The model's reply could not be read.",
    })

    expect(await screen.findByTestId("task-extraction-warning")).toBeTruthy()
    expect(screen.getByTestId("task-extraction-empty")).toBeTruthy()
  })

  it("renders provider errors inline with a working Retry", async () => {
    extractTasksMock.mockRejectedValueOnce(new Error("provider unreachable"))
    renderDialog()

    expect(await screen.findByTestId("task-extraction-error")).toBeTruthy()
    expect(screen.getByTestId("task-extraction-error").textContent).toContain(
      "provider unreachable"
    )

    extractTasksMock.mockResolvedValueOnce({ suggestions: twoSuggestions })
    fireEvent.click(screen.getByTestId("task-extraction-retry"))

    expect(await screen.findByText("Send the contract")).toBeTruthy()
  })
})

describe("TaskExtractionDialog accept path", () => {
  it("sends only checked suggestions to the seam and marks them dismissed", async () => {
    extractTasksMock.mockResolvedValue({ suggestions: twoSuggestions })
    renderDialog()
    await screen.findByText("Send the contract")

    // Reject the second suggestion by unchecking it, then accept the rest.
    fireEvent.click(screen.getByRole("checkbox", { name: CHECK_SECOND }))
    fireEvent.click(screen.getByTestId("task-extraction-accept"))

    await waitFor(() =>
      expect(createTaskFromSuggestionMock).toHaveBeenCalledTimes(1)
    )
    // The frozen seam contract: title, due, source linkage, origin.
    expect(createTaskFromSuggestionMock).toHaveBeenCalledWith(
      executorHolder.current,
      {
        title: "Send the contract",
        notes: "To legal first",
        dueAt: Date.UTC(2026, 2, 1) / 1000,
        sourceMessageId: "msg-1",
        sourceThreadId: THREAD_ID,
        origin: "ai",
      }
    )
    // The unchecked (rejected) suggestion NEVER reached the seam.
    const seededIds = createTaskFromSuggestionMock.mock.calls.map(
      (call) => (call[1] as { sourceMessageId: string }).sourceMessageId
    )
    expect(seededIds).not.toContain("msg-2")

    // Stub's "unavailable": frozen toast + dismissed marking.
    expect(toast.info).toHaveBeenCalledWith(
      "The Tasks module arrives in a later update"
    )
    expect(screen.getByTestId("task-suggestion-state-0").textContent).toBe(
      "Dismissed"
    )
    // The rejected item stays reviewable (its Add button is still there)
    // but, being unchecked, does not count toward the batch button.
    expect(screen.getByTestId("task-suggestion-add-1")).toBeTruthy()
    expect(screen.getByTestId("task-extraction-accept").textContent).toBe(
      "Add 0 tasks"
    )
  })

  it("accepts a single suggestion from its row's Add button", async () => {
    extractTasksMock.mockResolvedValue({ suggestions: twoSuggestions })
    renderDialog()
    await screen.findByText("Send the contract")

    fireEvent.click(screen.getByLabelText('Add "Book the room"'))

    await waitFor(() =>
      expect(createTaskFromSuggestionMock).toHaveBeenCalledTimes(1)
    )
    const seededIds = createTaskFromSuggestionMock.mock.calls.map(
      (call) => (call[1] as { sourceMessageId: string }).sourceMessageId
    )
    expect(seededIds).toEqual(["msg-2"])
  })

  it("toasts once per batch when several unavailable results come back", async () => {
    extractTasksMock.mockResolvedValue({ suggestions: twoSuggestions })
    renderDialog()
    await screen.findByText("Send the contract")

    fireEvent.click(screen.getByTestId("task-extraction-accept"))

    await waitFor(() =>
      expect(createTaskFromSuggestionMock).toHaveBeenCalledTimes(2)
    )
    expect(toast.info).toHaveBeenCalledTimes(1)
    // Both items dismissed, nothing left to accept.
    expect(screen.getByTestId("task-suggestion-state-0").textContent).toBe(
      "Dismissed"
    )
    expect(screen.getByTestId("task-suggestion-state-1").textContent).toBe(
      "Dismissed"
    )
    const acceptButton = screen.getByTestId(
      "task-extraction-accept"
    ) as HTMLButtonElement
    expect(acceptButton.textContent).toBe("Add 0 tasks")
    expect(acceptButton.disabled).toBe(true)
  })

  it("marks seam successes as Added without the unavailable toast", async () => {
    createTaskFromSuggestionMock.mockResolvedValue({ ok: true, taskId: "t-9" })
    extractTasksMock.mockResolvedValue({ suggestions: twoSuggestions })
    renderDialog()
    await screen.findByText("Send the contract")

    fireEvent.click(screen.getByTestId("task-extraction-accept"))

    await waitFor(() =>
      expect(
        screen.getByTestId("task-suggestion-state-0").textContent
      ).toBe("Added")
    )
    expect(toast.info).not.toHaveBeenCalled()
  })
})

describe("TaskExtractionDialog real-seam integration (task 5.8)", () => {
  it("an accepted suggestion lands a real task row through the real createTaskFromSuggestion", async () => {
    const executor: TestExecutor = createTestExecutor()
    executorHolder.current = executor
    try {
      const accountId = await createAccount(executor)
      const threadId = await createThread(executor, accountId, {
        subject: "Contract renewal",
      })
      const messageId = await createMessage(executor, {
        threadId,
        accountId,
        date: 1_700_000_000,
        subject: "Re: Contract renewal",
        fromName: "Alice",
        fromAddress: "alice@example.com",
      })

      // Route the seam through the REAL implementation — only the
      // extraction stays mocked (no AI provider in tests). This proves
      // the dialog's accept wiring end-to-end: dialog → seam → tasks
      // service → real v12 schema.
      const real = await vi.importActual<
        typeof import("@/services/tasks/create")
      >("@/services/tasks/create")
      createTaskFromSuggestionMock.mockImplementation(
        real.createTaskFromSuggestion
      )

      extractTasksMock.mockResolvedValue({
        suggestions: [
          suggestion({
            title: "Send the contract",
            notes: "To legal first",
            dueAt: Date.UTC(2026, 2, 1) / 1000,
            messageId,
          }),
        ],
      })
      render(
        <TaskExtractionDialog
          threadId={threadId}
          open
          onOpenChange={vi.fn()}
        />
      )
      await screen.findByText("Send the contract")

      fireEvent.click(screen.getByTestId("task-extraction-accept"))

      // "Added" is stamped only after the real seam resolved.
      await waitFor(() =>
        expect(
          screen.getByTestId("task-suggestion-state-0").textContent
        ).toBe("Added")
      )
      const tasks = await listOpenTasks(executor)
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toMatchObject({
        title: "Send the contract",
        notes: "To legal first",
        dueAt: Date.UTC(2026, 2, 1) / 1000,
        origin: "ai",
        sourceMessageId: messageId,
        sourceThreadId: threadId,
        sourceAccountId: accountId,
        completedAt: null,
      })
      expect(toast.info).not.toHaveBeenCalled()
    } finally {
      executor.close()
      executorHolder.current = null
    }
  })
})
