import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"

/**
 * Thread context menu quick-step tests (task 3.2): the "Quick step"
 * submenu renders one entry per step (shortcut hint included) ONLY when
 * the list loaded steps AND provided the run handler, and a click emits
 * onRunQuickStep with the step id and the SAME targetIds every other
 * state-changing item uses (the selection-or-row semantics — the
 * executor runs are covered by the runner suite; here we assert the
 * menu's wiring). Pure display+intents: no executor needed.
 */

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

import { ContextMenuTrigger } from "@/components/ui/context-menu"
import {
  ThreadContextMenu,
  type ThreadMenuHandlers,
} from "../thread-context-menu"
import type { QuickStep } from "@/services/settings/quick-steps"

const STEP_A: QuickStep = {
  id: "step-a",
  name: "Cleanup",
  actions: [
    { kind: "mark_read", read: true },
    { kind: "archive" },
  ],
  order: 0,
}

const STEP_B: QuickStep = {
  id: "step-b",
  name: "Toss",
  actions: [
    { kind: "star" },
    { kind: "trash" },
  ],
  order: 1,
  shortcut: "5",
}

function makeThreadRow(): Parameters<typeof ThreadContextMenu>[0]["thread"] {
  return {
    id: "thread-1",
    account_id: "acc-1",
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

function renderMenu(options: {
  quickSteps?: QuickStep[]
  targetIds?: string[]
  onRunQuickStep?: (stepId: string, targetIds: string[]) => void
}) {
  const handlers: ThreadMenuHandlers = {
    ...noopHandlers,
    ...(options.onRunQuickStep ? { onRunQuickStep: options.onRunQuickStep } : {}),
  }
  return render(
    <ThreadContextMenu
      thread={makeThreadRow()}
      targetIds={options.targetIds ?? ["thread-1"]}
      userLabels={[]}
      quickSteps={options.quickSteps}
      memberLabelIds={[]}
      handlers={handlers}
    >
      <ContextMenuTrigger render={<button data-testid="row-trigger" />}>
        row
      </ContextMenuTrigger>
    </ThreadContextMenu>
  )
}

async function openMenu(): Promise<void> {
  fireEvent.contextMenu(screen.getByTestId("row-trigger"), {
    clientX: 8,
    clientY: 8,
  })
  await waitFor(() =>
    expect(screen.queryByRole("menu", { hidden: true })).not.toBeNull()
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  cleanup()
})

describe("thread context menu quick steps (task 3.2)", () => {
  it("lists the steps in a submenu and runs the clicked one against targetIds", async () => {
    const onRunQuickStep = vi.fn()
    renderMenu({
      quickSteps: [STEP_A, STEP_B],
      targetIds: ["thread-1", "thread-2", "thread-3"],
      onRunQuickStep,
    })
    await openMenu()

    fireEvent.click(screen.getByRole("menuitem", { name: "Quick step" }))

    // One entry per step, manage order; the digit shortcut rides along.
    const cleanup = await screen.findByTestId("quick-step-menu-item-step-a")
    expect(cleanup.textContent).toContain("Cleanup")
    const toss = screen.getByTestId("quick-step-menu-item-step-b")
    expect(toss.textContent).toContain("Toss")
    expect(toss.textContent).toContain("5")

    fireEvent.click(toss)
    expect(onRunQuickStep).toHaveBeenCalledTimes(1)
    expect(onRunQuickStep).toHaveBeenCalledWith("step-b", [
      "thread-1",
      "thread-2",
      "thread-3",
    ])
  })

  it("renders no Quick step entry when steps are missing (or the handler)", async () => {
    // Steps without the handler → no submenu.
    renderMenu({ quickSteps: [STEP_A] })
    await openMenu()
    expect(screen.queryByRole("menuitem", { name: "Quick step" })).toBeNull()
  })

  it("renders no Quick step entry when the handler is missing", async () => {
    renderMenu({})
    await openMenu()
    expect(screen.queryByRole("menuitem", { name: "Quick step" })).toBeNull()
  })
})
