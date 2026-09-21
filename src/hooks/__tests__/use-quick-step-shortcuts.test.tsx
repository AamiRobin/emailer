import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"

/**
 * Quick-step digit shortcut hook tests (task 3.2). The steps come from
 * the REAL 3.1 service against a seeded node:sqlite database (executor
 * module mocked to the holder); the shared runner is spied so tests
 * assert the hook's WIRING — matching step, current targets, and the
 * gating contract (no modifiers, not while typing, not over modals,
 * thread-list context only). Store state is seeded directly, exactly as
 * the list stores would hold it.
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

const runWithConfirmMock = vi.hoisted(() => vi.fn(async () => true))

vi.mock("@/services/quick-steps/run-with-confirm", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/services/quick-steps/run-with-confirm")
    >()
  return {
    ...actual,
    runQuickStepWithConfirm: runWithConfirmMock,
  }
})

import { createTestExecutor, type TestExecutor } from "@/services/db/__tests__/test-executor"
import { createQuickStep, listQuickSteps } from "@/services/settings/quick-steps"
import type { ThreadRow } from "@/services/db/threads"
import { useThreadListStore } from "@/stores/thread-list-store"
import { DEFAULT_VIEW, useUiStore } from "@/stores/ui-store"
import { usePaletteStore } from "@/stores/palette-store"
import { useQuickStepShortcuts } from "../use-quick-step-shortcuts"

let executor: TestExecutor

function threadRow(id: string): ThreadRow {
  return {
    id,
    account_id: "acc1",
    subject: `Subject ${id}`,
    snippet: null,
    first_message_at: 1_700_000_000,
    last_message_at: 1_700_000_000,
    message_count: 1,
    unread_count: 1,
    has_attachments: 0,
    is_starred: 0,
    participants: null,
    gmail_thread_id: null,
    folder_label_id: null,
    is_archived: 0,
    is_trashed: 0,
    is_spam: 0,
    created_at: 1_700_000_000,
  }
}

function Host({ children }: { children?: ReactNode }): ReactNode {
  useQuickStepShortcuts()
  return <div>{children}</div>
}

function renderHost(children?: ReactNode): void {
  render(<Host>{children}</Host>)
}

async function seedStep(
  name: string,
  shortcut: string
): Promise<string> {
  const result = await createQuickStep(executor, {
    name,
    actions: [
      { kind: "mark_read", read: true },
      { kind: "archive" },
    ],
    shortcut,
  })
  if (!result.ok) throw new Error(`seed failed: ${result.error}`)
  return result.step.id
}

function resetStores(): void {
  useUiStore.setState({
    view: DEFAULT_VIEW,
    composerOpen: false,
    activeThread: null,
  })
  usePaletteStore.setState({ open: false })
  useThreadListStore.setState({
    threads: [],
    selectedIds: new Set<string>(),
  })
}

beforeEach(() => {
  executor = createTestExecutor()
  executorHolder.current = executor
  resetStores()
})

afterEach(() => {
  cleanup()
  executorHolder.current = null
  executor.close()
  runWithConfirmMock.mockClear()
  resetStores()
})

describe("quick step digit shortcuts (task 3.2)", () => {
  it("runs the step bound to the pressed digit against the current selection", async () => {
    const id = await seedStep("Cleanup", "2")
    useThreadListStore.setState({
      threads: [threadRow("t1"), threadRow("t2")],
      selectedIds: new Set(["t2"]),
    })

    renderHost()
    fireEvent.keyDown(window, { key: "2" })

    await waitFor(() => expect(runWithConfirmMock).toHaveBeenCalledTimes(1))
    const step = (await listQuickSteps(executor)).find(
      (candidate) => candidate.id === id
    )!
    expect(runWithConfirmMock).toHaveBeenCalledWith(step, ["t2"])
  })

  it("falls back to the active thread when nothing is selected", async () => {
    await seedStep("Cleanup", "7")
    useThreadListStore.setState({ threads: [threadRow("t1")] })
    useUiStore.setState({ activeThread: "t1" })

    renderHost()
    fireEvent.keyDown(window, { key: "7" })

    await waitFor(() => expect(runWithConfirmMock).toHaveBeenCalledTimes(1))
    const call = runWithConfirmMock.mock.calls[0] as unknown[] | undefined
    expect(call?.[1]).toEqual(["t1"])
  })

  it("does nothing for a digit with no step, and never fires while typing", async () => {
    await seedStep("Cleanup", "2")

    renderHost(<input data-testid="field" aria-label="field" />)

    // Unbound digit.
    fireEvent.keyDown(window, { key: "3" })
    // Bound digit, but typed into a field (the event bubbles to window
    // with the input as its target).
    const field = screen.getByTestId("field")
    field.focus()
    fireEvent.keyDown(field, { key: "2" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(runWithConfirmMock).not.toHaveBeenCalled()
  })

  it("stands down for modifiers, modals, the palette/composer, and non-list views", async () => {
    await seedStep("Cleanup", "4")
    renderHost()

    // Modifier held — Cmd+4 stays with the platform.
    fireEvent.keyDown(window, { key: "4", metaKey: true })
    // A rendered dialog owns the keyboard.
    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    document.body.appendChild(dialog)
    fireEvent.keyDown(window, { key: "4" })
    dialog.remove()
    // Palette open.
    usePaletteStore.setState({ open: true })
    fireEvent.keyDown(window, { key: "4" })
    usePaletteStore.setState({ open: false })
    // Composer open.
    useUiStore.setState({ composerOpen: true })
    fireEvent.keyDown(window, { key: "4" })
    useUiStore.setState({ composerOpen: false })
    // Settings view: no thread-list context.
    useUiStore.setState({ view: { kind: "settings" } })
    fireEvent.keyDown(window, { key: "4" })
    useUiStore.setState({ view: DEFAULT_VIEW })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(runWithConfirmMock).not.toHaveBeenCalled()
  })

  it("picks up edits made AFTER mount (fresh read per keydown)", async () => {
    useUiStore.setState({ activeThread: "t1" })
    renderHost()
    fireEvent.keyDown(window, { key: "9" })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(runWithConfirmMock).not.toHaveBeenCalled()

    // The user saves a step bound to 9 in settings — no remount happens,
    // yet the next keypress uses the new definition (and current targets).
    await seedStep("Later", "9")
    fireEvent.keyDown(window, { key: "9" })
    await waitFor(() => expect(runWithConfirmMock).toHaveBeenCalledTimes(1))
    const step = (await listQuickSteps(executor)).find(
      (candidate) => candidate.shortcut === "9"
    )!
    expect(runWithConfirmMock).toHaveBeenCalledWith(step, ["t1"])
  })
})
